/**
 * 将 D:/Dataset 的 330 张真实 YOLO 数据集导入系统 SQLite，并让 JSON 病害档案
 * 按类别关联真实图片。幂等：重复执行会先移除本数据集的旧导入行再重建。
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const ROOT = path.join(__dirname, '..');
const SRC = process.env.TUNNEL_REAL_DATASET || 'D:/Dataset';
const OUT = path.join(ROOT, 'backend', 'data', 'real-dataset');
const DB_FILE = path.join(ROOT, 'backend', 'data', 'tunnel.db');
const DEFECT_FILE = path.join(ROOT, 'backend', 'data', 'defects.json');
const CLASS_NAMES = ['剥落掉块', '裂缝', '渗漏水'];
const CLASS_IDS = { '裂缝': 1, '渗漏水': 2, '剥落掉块': 3 };

function levelFor(w, h) {
  const area = w * h;
  if (area >= 0.35) return 3;
  if (area >= 0.08) return 2;
  return 1;
}

function main() {
  if (!fs.existsSync(path.join(SRC, 'data.yaml'))) throw new Error('数据集不存在: ' + SRC);
  fs.mkdirSync(OUT, { recursive: true });
  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys=ON; PRAGMA busy_timeout=5000; BEGIN IMMEDIATE;');
  const pools = Object.fromEntries(CLASS_NAMES.map((n) => [n, []]));
  let imageCount = 0, detectionCount = 0, removedImages = 0;
  try {
    // 清理旧的合成图库与此前从同一 D:/Dataset 分批导入的重复项；其他业务记录保留。
    const old = db.prepare(`SELECT im.image_id FROM image im LEFT JOIN tunnel t ON t.tunnel_id=im.tunnel_id
      WHERE im.source='synthetic' OR t.name IN ('真实数据集','真实数据集(第二批)','D盘真实数据集')`).all();
    for (const row of old) db.prepare('DELETE FROM detection WHERE image_id=?').run(row.image_id);
    for (const row of old) db.prepare('DELETE FROM image WHERE image_id=?').run(row.image_id);
    removedImages = old.length;

    let tunnel = db.prepare('SELECT tunnel_id FROM tunnel WHERE name=?').get('D盘真实数据集');
    let tunnelId;
    if (tunnel) tunnelId = Number(tunnel.tunnel_id);
    else tunnelId = Number(db.prepare(`INSERT INTO tunnel(name,type,location,length_m,owner)
      VALUES ('D盘真实数据集','真实隧道影像数据集','D:/Dataset',0,'用户数据集')`).run().lastInsertRowid);

    const addImage = db.prepare(`INSERT INTO image
      (tunnel_id,capture_time,position_m,image_path,source,annotate_mode,annotator,annotate_at,annotate_meta)
      VALUES (?,?,?,?, 'real','manual','dataset-yolo',?,?)`);
    const addDet = db.prepare(`INSERT INTO detection
      (image_id,class_id,class_name,confidence,bbox,area_px,width_mm,level,review_status,
       annotate_mode,annotate_meta,created_at,reviewer)
      VALUES (?,?,?,?,?,NULL,NULL,?,'已审核','manual',?,?, 'dataset-yolo')`);

    for (const split of ['train', 'val', 'test']) {
      const imgDir = path.join(SRC, 'images', split);
      const labelDir = path.join(SRC, 'labels', split);
      const outDir = path.join(OUT, split);
      fs.mkdirSync(outDir, { recursive: true });
      const files = fs.readdirSync(imgDir).filter((f) => /\.(jpe?g|png|bmp|webp)$/i.test(f)).sort();
      for (const file of files) {
        const srcFile = path.join(imgDir, file);
        const dstFile = path.join(outDir, file);
        fs.copyFileSync(srcFile, dstFile);
        const rel = path.relative(path.join(ROOT, 'backend'), dstFile).replace(/\\/g, '/');
        let labelFile = path.join(labelDir, path.parse(file).name + '.txt');
        // D:/Dataset 当前缺 labels/test；项目训练工作区保留了这 33 份原始标签镜像。
        if (!fs.existsSync(labelFile)) labelFile = path.join(ROOT, 'yolo-workspace', 'dataset', 'labels', split,
          path.parse(file).name + '.txt');
        if (!fs.existsSync(labelFile)) throw new Error('缺少 YOLO 标签: ' + file);
        const lines = fs.readFileSync(labelFile, 'utf8').split(/\r?\n/).map((s) => s.trim()).filter(Boolean);
        const meta = JSON.stringify({ dataset: 'D:/Dataset', split, original: srcFile, labels: lines.length });
        const imageId = Number(addImage.run(tunnelId, new Date().toISOString(), null, rel,
          new Date().toISOString(), meta).lastInsertRowid);
        imageCount++;
        const seenTypes = new Set();
        for (const line of lines) {
          const [cls0, cx, cy, w, h] = line.split(/\s+/).map(Number);
          const name = CLASS_NAMES[cls0];
          if (!name || ![cx, cy, w, h].every(Number.isFinite)) continue;
          const bbox = [Math.max(0, cx - w / 2), Math.max(0, cy - h / 2), w, h]
            .map((v) => Math.round(v * 1e6) / 1e6);
          addDet.run(imageId, CLASS_IDS[name], name, 1, JSON.stringify(bbox), levelFor(w, h),
            JSON.stringify({ source: 'D:/Dataset YOLO真值', split, yoloClass: cls0 }), new Date().toISOString());
          detectionCount++;
          seenTypes.add(name);
        }
        for (const type of seenTypes) pools[type].push(imageId);
      }
    }
    db.exec('COMMIT');
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally { db.close(); }

  // 病害档案原有业务记录继续保留，但图片统一换成相同类别的真实数据集图片。
  const defects = JSON.parse(fs.readFileSync(DEFECT_FILE, 'utf8'));
  const cursors = {};
  let linked = 0;
  for (const d of defects) {
    const p = pools[d.type] || [];
    if (!p.length) {
      // 数据集没有错台/白华真图：清除旧生成图引用，显示无图占位，绝不拿错误类别冒充。
      d.imageRef = null;
      d.imageOrigin = 'D:/Dataset 无该类别真实标注图';
      continue;
    }
    const i = cursors[d.type] || 0;
    d.imageRef = p[i % p.length];
    d.imageOrigin = 'D:/Dataset YOLO真实图片';
    cursors[d.type] = i + 1;
    linked++;
  }
  fs.writeFileSync(DEFECT_FILE, JSON.stringify(defects, null, 2), 'utf8');
  const result = { source: SRC, removedOldImages: removedImages, images: imageCount,
    detections: detectionCount, linkedDefectArchives: linked,
    imagePools: Object.fromEntries(Object.entries(pools).map(([k, v]) => [k, v.length])) };
  fs.writeFileSync(path.join(OUT, 'import-result.json'), JSON.stringify(result, null, 2), 'utf8');
  console.log(JSON.stringify(result, null, 2));
}

main();
