/**
 * train/export-yolo.js — 导出标准 YOLO 目标检测数据集（科研核查第 2 项补齐 · 纯 JS 零依赖）
 *
 * 产出目录结构（Ultralytics 直接可用）：
 *   yolo_dataset/
 *     images/train/*.png  images/val/*.png      8:2 按图切分
 *     labels/train/*.txt  labels/val/*.txt      每图一文件：class_id cx cy w h（归一化 0~1）
 *     classes.txt                               5 类病害名（class_id 0~4）
 *     dataset.yaml                              Ultralytics 数据集配置
 *     labels_manifest.json                      像素级标注 manifest（本工程自有格式备份）
 *
 * 说明：数据由 gen-dataset 程序化合成（带 alpha 紧致 bbox 标注），负样本只有图无 txt 同名文件
 *       （YOLO 约定：无标注图 = 纯背景负样本）。
 *
 * CLI：node backend/train/export-yolo.js [--count 240] [--seed 42] [--out backend/data/yolo_dataset]
 */
const fs = require('fs');
const path = require('path');
const vision = require('../vision');
const { generate, OUT_W, OUT_H } = require('./gen-dataset');
const synth = require('../synthesizer');

const TYPES = synth.TYPE_ORDER; // class_id 0~4 与之一一对应

/**
 * 导出 YOLO 数据集
 * @param {{count?:number, seed?:number, negRatio?:number, out?:string}} opts
 * @returns {{out:string, train:number, val:number, instances:number}}
 */
function main(opts = {}) {
  const count = Number(opts.count) || 240;
  const seed = Number(opts.seed) || 42;
  const out = opts.out || path.join(__dirname, '..', 'data', 'yolo_dataset');
  const t0 = Date.now();

  // ① 生成数据（PNG + 像素级标注 manifest）
  const manifest = generate({ count, seed, outDir: out });

  // ② 组织 YOLO 目录：images/{train,val} + labels/{train,val}
  for (const d of ['images/train', 'images/val', 'labels/train', 'labels/val']) {
    fs.rmSync(path.join(out, d), { recursive: true, force: true });
    fs.mkdirSync(path.join(out, d), { recursive: true });
  }
  let nTrain = 0, nVal = 0, instances = 0;
  manifest.items.forEach((item, i) => {
    const split = i % 10 < 8 ? 'train' : 'val'; // 8:2 按图切分（同图不跨集，防泄漏）
    // 图片从 images/ 移动到 images/<split>/
    const src = path.join(out, 'images', item.file);
    const dst = path.join(out, 'images', split, item.file);
    fs.renameSync(src, dst);
    if (split === 'train') nTrain++; else nVal++;

    // 标注：像素 bbox → 归一化 class_id cx cy w h
    if (!item.negative && item.defects.length) {
      const lines = item.defects.map((d) => {
        const ci = TYPES.indexOf(d.class_name);
        const cx = (d.bbox[0] + d.bbox[2] / 2) / item.W;
        const cy = (d.bbox[1] + d.bbox[3] / 2) / item.H;
        const w = d.bbox[2] / item.W, h = d.bbox[3] / item.H;
        const f = (v) => Math.max(0, Math.min(1, v)).toFixed(6);
        instances++;
        return `${ci} ${f(cx)} ${f(cy)} ${f(w)} ${f(h)}`;
      });
      const txt = item.file.replace(/\.png$/i, '.txt');
      fs.writeFileSync(path.join(out, 'labels', split, txt), lines.join('\n') + '\n');
    }
  });

  // ③ classes.txt 与 dataset.yaml
  fs.writeFileSync(path.join(out, 'classes.txt'), TYPES.join('\n') + '\n');
  const yaml = [
    `# 隧道衬砌病害 YOLO 数据集（由 backend/train/export-yolo.js 生成，程序化合成，class_id 对应 classes.txt）`,
    `path: ${out.replace(/\\/g, '/')}`,
    'train: images/train',
    'val: images/val',
    `names:`,
    ...TYPES.map((t, i) => `  ${i}: ${t}`),
  ].join('\n') + '\n';
  fs.writeFileSync(path.join(out, 'dataset.yaml'), yaml);
  fs.writeFileSync(path.join(out, 'labels_manifest.json'), JSON.stringify(manifest, null, 1));

  console.log(`✓ YOLO 数据集已导出: ${out}`);
  console.log(`  图 ${nTrain + nVal} 张（train ${nTrain} / val ${nVal}）· 缺陷实例 ${instances} 个 · ${TYPES.length} 类：${TYPES.join('、')}`);
  console.log(`  训练：yolo detect train data=${path.join(out, 'dataset.yaml').replace(/\\/g, '/')} model=yolov8n.pt imgsz=640 epochs=100`);
  console.log(`  导出 ONNX：yolo export model=best.pt format=onnx → 设 TUNNEL_YOLO_MODEL 接入 detector.js`);
  console.log(`  耗时 ${Date.now() - t0}ms`);
  return { out, train: nTrain, val: nVal, instances };
}

/** CLI */
if (require.main === module) {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  main({
    count: Number(arg('count', 240)),
    seed: Number(arg('seed', 42)),
    out: arg('out', undefined),
  });
}

module.exports = { main };
