/**
 * tools/batch-infer.js — 科研批量推理管线：图像目录 → 检测结果 → YOLO / COCO / CSV 导出
 *
 * 走与运行态完全一致的推理链路（infer.detectImage，含训练模型注入），
 * 产出归一化 bbox 检测结果，供评测脚本、论文数据集、外部工具使用。
 * 完成后自动登记实验台账（research.addExperiment）。
 *
 * 用法：
 *   node tools/batch-infer.js [--dir backend/data/train-real/images] [--limit 20]
 *                             [--format yolo,coco,csv] [--out backend/data/research-out]
 */
const fs = require('fs');
const path = require('path');
const infer = require('../backend/infer');
const model = require('../backend/model');
const fusion = require('../backend/fusion');
const research = require('../backend/research');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const DIR = path.resolve(arg('dir', path.join(__dirname, '..', 'backend', 'data', 'train-real', 'images')));
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'backend', 'data', 'research-out')));
const LIMIT = Number(arg('limit', 20));
const FORMATS = (arg('format', 'yolo,coco,csv')).split(',');
const CLASSES = ['裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出'];

function main() {
  if (!fs.existsSync(DIR)) { console.error('目录不存在：' + DIR); process.exit(1); }
  // 注入与 server.js 相同的训练模型
  const mp = model.loadFromFile(path.join(__dirname, '..', 'backend', 'data', 'model_params.json'));
  if (mp && mp.enabled) fusion.setClassifier(model.createPredictor(mp).classify);

  const imgs = fs.readdirSync(DIR).filter((f) => /\.(png|jpe?g)$/i.test(f)).slice(0, LIMIT);
  console.log(`批量推理：${imgs.length} 张（目录 ${path.basename(DIR)}）→ 格式 ${FORMATS.join('/')}`);
  const t0 = Date.now();
  const results = [];   // { file, W, H, dets:[{cls, conf, bbox[px]}] }
  let done = 0;
  for (const f of imgs) {
    const b64 = fs.readFileSync(path.join(DIR, f)).toString('base64');
    const res = infer.detectImage({ image: { dataUrl: 'data:image/png;base64,' + b64 }, archive: false });
    const dets = (res.detections || []).map((d) => ({
      cls: d.class_name, conf: d.confidence, bbox: d.bbox,   // bbox 已是归一化 [x,y,w,h]
      level: d.levelNo || d.level || null,
    }));
    // 输入图像实际尺寸（infer 里有 input 尺寸，归一化 bbox 与之对应）
    const W = (res.input && res.input.widthPx) || 640, H = (res.input && res.input.heightPx) || 640;
    results.push({ file: f, W, H, dets });
    process.stdout.write(`\r${++done}/${imgs.length}`);
  }
  const elapsed = Date.now() - t0;
  console.log(`\n推理完成：检出 ${results.reduce((a, r) => a + r.dets.length, 0)} 处 · 耗时 ${(elapsed / 1000).toFixed(1)}s`);

  fs.mkdirSync(OUT, { recursive: true });
  // ---- YOLO：每图一个 txt（class_id cx cy w h conf 归一化） ----
  if (FORMATS.includes('yolo')) {
    const ydir = path.join(OUT, 'yolo-labels'); fs.mkdirSync(ydir, { recursive: true });
    for (const r of results) {
      const lines = r.dets.map((d) => {
        const ci = CLASSES.indexOf(d.cls);
        return `${ci} ${d.bbox.map((v) => v.toFixed(6)).join(' ')} ${d.conf.toFixed(4)}`;
      });
      fs.writeFileSync(path.join(ydir, r.file.replace(/\.(png|jpe?g)$/i, '') + '.txt'), lines.join('\n'));
    }
    console.log('✓ YOLO →', ydir);
  }
  // ---- COCO json ----
  if (FORMATS.includes('coco')) {
    const coco = { info: { description: '隧途明鉴 batch inference', date_created: new Date().toISOString() },
      images: [], annotations: [], categories: CLASSES.map((n, i) => ({ id: i + 1, name: n })) };
    let aid = 1;
    results.forEach((r, i) => {
      const iid = i + 1;
      coco.images.push({ id: iid, file_name: r.file, width: r.W, height: r.H });
      r.dets.forEach((d) => {
        const [x, y, w, h] = d.bbox;
        coco.annotations.push({ id: aid++, image_id: iid, category_id: CLASSES.indexOf(d.cls) + 1,
          bbox: [+(x * r.W).toFixed(1), +(y * r.H).toFixed(1), +(w * r.W).toFixed(1), +(h * r.H).toFixed(1)],
          score: +d.conf.toFixed(4), area: +(w * r.W * h * r.H).toFixed(1), iscrowd: 0 });
      });
    });
    fs.writeFileSync(path.join(OUT, 'coco-results.json'), JSON.stringify(coco, null, 1));
    console.log('✓ COCO →', path.join(OUT, 'coco-results.json'));
  }
  // ---- CSV 汇总 ----
  if (FORMATS.includes('csv')) {
    const rows = ['file,class,conf,x,y,w,h,level'];
    for (const r of results) for (const d of r.dets) {
      rows.push([r.file, d.cls, d.conf.toFixed(4), ...d.bbox.map((v) => v.toFixed(4)), d.level || ''].join(','));
    }
    fs.writeFileSync(path.join(OUT, 'results.csv'), rows.join('\n'));
    console.log('✓ CSV →', path.join(OUT, 'results.csv'));
  }
  // ---- 实验台账登记 ----
  const exp = research.addExperiment({
    kind: 'batch-infer',
    label: `批量推理 · ${path.basename(DIR)} · ${imgs.length} 张`,
    params: { format: FORMATS.join('/'), modelEnabled: !!(mp && mp.enabled), threshold: mp ? mp.threshold : null },
    metrics: { images: imgs.length, detections: results.reduce((a, r) => a + r.dets.length, 0), elapsedSec: +(elapsed / 1000).toFixed(1) },
    artifacts: { output: path.relative(process.cwd(), OUT) },
  });
  console.log('✓ 实验台账登记', exp.exp_id);
}

main();
