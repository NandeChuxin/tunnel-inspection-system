/**
 * train/eval-real.js — 真实样本集端到端评测（33 张人工标注图）
 *
 * 匹配口径与 build-samples 的真实域规则一致：IoU≥iouTh 或 交集/GT面积≥iouTh
 * （真实 GT 为区域级大框，紧致预测框落在其中也应算命中），且类别一致才算 TP。
 * 用法：node backend/train/eval-real.js [--iou 0.3] [--params <model_params 路径>]
 * 产物：backend/data/train-real/eval-real.json
 */
const fs = require('fs');
const path = require('path');
const infer = require('../infer');
const fusion = require('../fusion');
const model = require('../model');

const REAL_DIR = path.join(__dirname, '..', 'data', 'train-real');

/** 匹配得分：IoU 与 GT 覆盖度取大 */
function matchScore(p, g) {
  const ix = Math.max(0, Math.min(p[0] + p[2], g[0] + g[2]) - Math.max(p[0], g[0]));
  const iy = Math.max(0, Math.min(p[1] + p[3], g[1] + g[3]) - Math.max(p[1], g[1]));
  const inter = ix * iy;
  const ua = p[2] * p[3] + g[2] * g[3] - inter;
  const iou = ua <= 0 ? 0 : inter / ua;
  const cover = inter / Math.max(1e-9, g[2] * g[3]);
  return Math.max(iou, cover);
}

/**
 * 单模式端到端评测（聚合 + 分类别）
 * @param {Array} items labels.json 条目
 * @param {string} imgDir 图像目录
 * @param {Function|null} classifier 注入分类器（null=规则引擎）
 * @param {number} iouTh 匹配阈值
 */
async function runMode(items, imgDir, classifier, iouTh) {
  fusion.setClassifier(classifier);
  let tp = 0, fp = 0, fn = 0, iouSum = 0, n = 0;
  const perClass = {};
  const pc = (c) => (perClass[c] = perClass[c] || { tp: 0, fp: 0, fn: 0 });
  for (const it of items) {
    const b64 = fs.readFileSync(path.join(imgDir, it.file)).toString('base64');
    const dr = await infer.detectImage({ image: { dataUrl: 'data:image/png;base64,' + b64 }, tunnel: '评测', mileage: 0 });
    const gts = (it.defects || []).map((d) => {
      const x0 = Math.max(0, d.bbox[0]), y0 = Math.max(0, d.bbox[1]);
      const x1 = Math.min(it.W, d.bbox[0] + d.bbox[2]), y1 = Math.min(it.H, d.bbox[1] + d.bbox[3]);
      return { cls: d.class_name, bbox: [x0 / it.W, y0 / it.H, (x1 - x0) / it.W, (y1 - y0) / it.H], used: false };
    }).filter((g) => g.bbox[2] > 0.004 && g.bbox[3] > 0.004);
    const preds = [...dr.detections].sort((a, b) => b.confidence - a.confidence);
    for (const p of preds) {
      let best = -1, bs = 0;
      gts.forEach((g, gi) => {
        if (g.used || g.cls !== p.class_name) return;
        const v = matchScore(p.bbox, g.bbox);
        if (v > bs) { bs = v; best = gi; }
      });
      if (best >= 0 && bs >= iouTh) { gts[best].used = true; tp++; n++; iouSum += bs; pc(p.class_name).tp++; }
      else { fp++; pc(p.class_name).fp++; }
    }
    gts.forEach((g) => { if (!g.used) { fn++; pc(g.cls).fn++; } });
  }
  const P = tp / Math.max(1e-9, tp + fp), R = tp / Math.max(1e-9, tp + fn);
  for (const c of Object.keys(perClass)) {
    const s = perClass[c];
    s.P = s.tp / Math.max(1e-9, s.tp + s.fp);
    s.R = s.tp / Math.max(1e-9, s.tp + s.fn);
    s.f1 = 2 * s.P * s.R / Math.max(1e-9, s.P + s.R);
  }
  return { precision: P, recall: R, f1: 2 * P * R / Math.max(1e-9, P + R), tp, fp, fn, meanIoU: n ? iouSum / n : 0, perClass };
}

async function main(opts = {}) {
  const iouTh = opts.iouTh || 0.3;
  const manifest = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'labels.json'), 'utf-8'));
  const items = manifest.items;
  const imgDir = path.join(REAL_DIR, 'images');

  const mp = opts.params || model.loadFromFile(opts.paramsPath || path.join(__dirname, '..', 'data', 'model_params.json'));
  const learned = mp ? model.createPredictor(mp).classify : null;

  const rules = await runMode(items, imgDir, null, iouTh);
  const learnedRes = learned ? await runMode(items, imgDir, learned, iouTh) : null;
  fusion.setClassifier(null);

  const res = { evaluatedAt: new Date().toISOString(), images: items.length, iouTh, rules, learned: learnedRes };
  if (opts.out !== null) fs.writeFileSync(opts.out || path.join(REAL_DIR, 'eval-real.json'), JSON.stringify(res, null, 1));
  return res;
}

module.exports = { main };
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  main({ iouTh: Number(arg('iou', 0.3)) }).then((r) => {
  const pc = (v) => (v * 100).toFixed(1) + '%';
  console.log(`\n════════ 真实样本端到端评测（${r.images} 张 · IoU/覆盖≥${r.iouTh}） ════════`);
  console.log(`指标         规则引擎      训练模型`);
  const row = (n, a, b) => console.log(`${n.padEnd(12)} ${a.padEnd(11)} ${b}`);
  row('查准率 P', pc(r.rules.precision), r.learned ? pc(r.learned.precision) : '-');
  row('查全率 R', pc(r.rules.recall), r.learned ? pc(r.learned.recall) : '-');
  row('F1', pc(r.rules.f1), r.learned ? pc(r.learned.f1) : '-');
  row('平均 IoU', r.rules.meanIoU.toFixed(3), r.learned ? r.learned.meanIoU.toFixed(3) : '-');
  for (const [tag, d] of [['规则', r.rules.perClass], ['模型', r.learned && r.learned.perClass]]) {
    if (!d) continue;
    console.log(`\n[${tag}] 分类别：` + Object.entries(d).map(([c, v]) =>
      `${c}(P ${pc(v.P)} / R ${pc(v.R)} / F1 ${pc(v.f1)}, tp${v.tp} fp${v.fp} fn${v.fn})`).join('  '));
  }
  }).catch((e) => { console.error('评测失败:', e.message); process.exit(1); });
}
