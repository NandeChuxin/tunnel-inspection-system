/**
 * tools/import-real-batch2.js — 第二批 50 张实拍样本直接入库（SQLite + image/detection）
 *
 * 与 import-real-to-db.js 不同：不再走推理链路（避免训练样本污染模型评测），
 * 直接读 labels-batch2.json 的 YOLO 真值作为 detection 行入库。
 * 这样 50 张图既是真实样本（#/api/samples/image/{id} 可见），又带「真实病害标注」。
 *
 * 行为：
 *   - 已有同名 image_path → 跳过（幂等）
 *   - 既有 image 行无 tunnel_id → 关联「真实数据集(第二批)」隧道
 *   - detection 写入：class_name=YOLO 真值，confidence=1.0（人工真值），level=YOLO 估算
 *     annotate_mode='manual'（人工标注） + reviewer='teacher'，使其在台账/统计/复核可见
 *
 * 前置：服务可启可停；操作期间 SQLite 文件独占。
 * 用法：node tools/import-real-batch2.js [--db backend/data/tunnel.db]
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DB_FILE = path.resolve(arg('db', path.join(__dirname, '..', 'backend', 'data', 'tunnel.db')));
const REAL_DIR = path.join(__dirname, '..', 'backend', 'data', 'train-real');
const LABELS = path.join(REAL_DIR, 'labels-batch2.json');
const MANIFEST = path.join(REAL_DIR, 'manifest-batch2.json');

const CLS_ID = { '裂缝': 1, '渗漏水': 2, '剥落掉块': 3, '衬砌错台': 4, '白华析出': 5 };

function main() {
  const labels = JSON.parse(fs.readFileSync(LABELS, 'utf-8'));
  const manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf-8'));
  console.log(`待入库 ${labels.length} 张（manifest ${manifest.count}）`);

  const db = new DatabaseSync(DB_FILE);
  db.exec('PRAGMA foreign_keys = ON');
  db.exec('BEGIN');
  try {
    // 1) 隧道 find-or-create
    let tunnelId = db.prepare('SELECT tunnel_id FROM tunnel WHERE name=?').get('真实数据集(第二批)')?.tunnel_id;
    if (!tunnelId) {
      const r = db.prepare(`INSERT INTO tunnel (name, type, location, length_m, owner)
                            VALUES (?, ?, ?, ?, ?)`).run('真实数据集(第二批)', '公路隧道', 'D:/Dataset/train 划分', 1000, '巡检班');
      tunnelId = Number(r.lastInsertRowid);
      console.log('新建隧道#' + tunnelId);
    } else {
      console.log('复用隧道#' + tunnelId);
    }

    // 2) 逐图：find-or-create image 行 + find-or-create detection 行
    let newImg = 0, skipImg = 0, newDet = 0, skipDet = 0;
    for (const row of labels) {
      const relPath = path.join('train-real', 'images', row.file).replace(/\\/g, '/');
      let imageId = db.prepare('SELECT image_id FROM image WHERE image_path=?').get(relPath)?.image_id;
      if (!imageId) {
        const r = db.prepare(`INSERT INTO image
          (tunnel_id, capture_time, position_m, image_path, source, annotator)
          VALUES (?, ?, ?, ?, 'real', 'teacher')`).run(
          tunnelId, new Date().toISOString(), null, relPath);
        imageId = Number(r.lastInsertRowid);
        newImg++;
      } else {
        skipImg++;
      }
      // 标注时间固定为同一秒 = 同一批（让 sync-real-to-ledger 不串）
      for (const d of row.defects) {
        const classId = CLS_ID[d.class_name] || 0;
        const [bx, by, bw, bh] = d.bbox;
        const W = row.W, H = row.H;
        // 归一化 [x,y,w,h]（portal/前端统一用归一化）
        const norm = [round(bx / W), round(by / H), round(bw / W), round(bh / H)];
        const area = Math.round(bw * bh);
        // 幂等：相同 (image_id, class_id, bbox) 不重复插
        const exist = db.prepare(`SELECT detection_id FROM detection
          WHERE image_id=? AND class_id=? AND bbox=?`).get(imageId, classId, JSON.stringify(norm));
        if (exist) { skipDet++; continue; }
        db.prepare(`INSERT INTO detection
          (image_id, class_id, class_name, confidence, bbox, area_px, width_mm, level,
           review_status, reviewer, annotate_mode, annotate_meta, created_at)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, '已审核', 'teacher', 'manual', ?, ?)`).run(
          imageId, classId, d.class_name, 1.0, JSON.stringify(norm), area, null, d.level,
          JSON.stringify({ source: 'YOLO真值', yolo_cls: d.yolo_cls, batch: 2 }),
          new Date().toISOString());
        newDet++;
      }
    }
    db.exec('COMMIT');
    console.log(`\n入库完成：image 新增 ${newImg}/跳过 ${skipImg} · detection 新增 ${newDet}/跳过 ${skipDet}`);
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    db.close();
  }
}

function round(x) { return Math.round(x * 1000) / 1000; }

main();
