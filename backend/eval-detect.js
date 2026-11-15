/**
 * eval-detect.js — 端到端检测精度 A/B 评测（规则引擎 vs 训练模型）
 *
 * 方法：生成独立评测集（独立 seed，与训练集同分布不重叠）→ 逐张 infer.detectImage
 * （同一候选提取/预处理，仅切换判别器：rules=内置知识规则 / learned=训练 softmax 模型）
 * → 预测框与 GT 按 IoU≥0.3 且类别一致匹配 → 输出 P/R/F1、等级准确率、平均 IoU 对照表。
 *
 * 用法：node backend/eval-detect.js [--count 120] [--seed 999] [--iou 0.3]
 * 产物：控制台对照表 + backend/data/train/eval-metrics.json
 */
const fs = require('fs');
const path = require('path');
const infer = require('./infer');
const fusion = require('./fusion');
const model = require('./model');
const { generate } = require('./train/gen-dataset');

/** 归一化框 IoU */
function iou(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = a[2] * a[3] + b[2] * b[3] - inter;
  return ua <= 0 ? 0 : inter / ua;
}

/**
 * 单模式端到端评测
 * @param {Array} items 评测集 manifest 条目
 * @param {string} imgDir 图像目录
 * @param {Function|null} classifier 注入分类器（null=规则引擎）
 * @param {number} iouTh 匹配阈值
 */
async function runMode(items, imgDir, classifier, iouTh) {
  fusion.setClassifier(classifier);
  let tp = 0, fp = 0, fn = 0, lvOk = 0, lvOk1 = 0, lvN = 0, iouSum = 0, n = 0;
  for (const it of items) {
    const b64 = fs.readFileSync(path.join(imgDir, it.file)).toString('base64');
    const dr = await infer.detectImage({ image: { dataUrl: 'data:image/png;base64,' + b64 }, tunnel: '评测', mileage: 0 });
    const gts = (it.defects || []).map((d) => {
      const x0 = Math.max(0, d.bbox[0]), y0 = Math.max(0, d.bbox[1]);
      const x1 = Math.min(it.W, d.bbox[0] + d.bbox[2]), y1 = Math.min(it.H, d.bbox[1] + d.bbox[3]);
      return { cls: d.class_name, level: d.level, bbox: [x0 / it.W, y0 / it.H, (x1 - x0) / it.W, (y1 - y0) / it.H], used: false };
    }).filter((g) => g.bbox[2] > 0.004 && g.bbox[3] > 0.004);
    // 贪婪匹配：按置信度降序
    const preds = [...dr.detections].sort((a, b) => b.confidence - a.confidence);
    for (const p of preds) {
      let best = -1, bi = 0;
      gts.forEach((g, gi) => {
        if (g.used || g.cls !== p.class_name) return;
        const v = iou(p.bbox, g.bbox);
        if (v > bi) { bi = v; best = gi; }
      });
      if (best >= 0 && bi >= iouTh) {
        tp++; iouSum += bi; n++;
        const g = gts[best]; g.used = true;
        lvN++;
        if (p.level === g.level) lvOk++;
        if (Math.abs(p.level - g.level) <= 1) lvOk1++;
      } else fp++;
    }
    fn += gts.filter((g) => !g.used).length;
  }
  const P = tp / Math.max(1e-9, tp + fp), R = tp / Math.max(1e-9, tp + fn);
  return {
    precision: P, recall: R, f1: 2 * P * R / Math.max(1e-9, P + R),
    tp, fp, fn, meanIoU: n ? iouSum / n : 0,
    levelAcc: lvOk / Math.max(1, lvN), levelAccPlusMinus1: lvOk1 / Math.max(1, lvN), matchedN: lvN,
  };
}

/** CLI */
if (require.main === module) {
  (async () => {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  const count = Number(arg('count', 120));
  const seed = Number(arg('seed', 999));
  const iouTh = Number(arg('iou', 0.3));
  const outDir = path.join(__dirname, 'data', 'train', 'eval');
  console.log(`生成评测集：${count} 张（seed=${seed}，与训练集同分布独立采样）…`);
  const manifest = generate({ count, seed, negRatio: 0.15, outDir });
  const items = manifest.items;

  // 训练模型分类器（若已训练）
  const mp = model.loadFromFile(path.join(__dirname, 'data', 'model_params.json'));
  const learned = mp ? model.createPredictor(mp).classify : null;

  console.log('端到端推理评测中（rules → learned）…');
  const rules = await runMode(items, path.join(outDir, 'images'), null, iouTh);
  const learnedRes = learned ? await runMode(items, path.join(outDir, 'images'), learned, iouTh) : null;
  fusion.setClassifier(null); // 恢复默认（库级）规则引擎

  const pc = (v) => (v * 100).toFixed(1) + '%';
  console.log(`\n════════ 端到端检测精度对照（IoU≥${iouTh} 且类别一致，${count} 张评测图） ════════`);
  console.log(`指标               规则引擎        训练模型`);
  const row = (name, a, b) => console.log(`${name.padEnd(16)} ${a.padEnd(13)} ${b}`);
  if (learnedRes) {
    row('查准率 P', pc(rules.precision), pc(learnedRes.precision));
    row('查全率 R', pc(rules.recall), pc(learnedRes.recall));
    row('F1', pc(rules.f1), pc(learnedRes.f1));
    row('平均框 IoU', rules.meanIoU.toFixed(3), String(learnedRes.meanIoU.toFixed(3)));
    row('等级准确率(严格)', pc(rules.levelAcc), pc(learnedRes.levelAcc));
    row('等级准确率(±1)', pc(rules.levelAccPlusMinus1), pc(learnedRes.levelAccPlusMinus1));
  } else {
    console.log('（未找到训练模型，仅输出规则引擎基线）', JSON.stringify(rules));
  }
  const out = { evaluatedAt: new Date().toISOString(), count, seed, iouTh, rules, learned: learnedRes };
  fs.writeFileSync(path.join(__dirname, 'data', 'train', 'eval-metrics.json'), JSON.stringify(out, null, 1));
  console.log(`\n✓ 指标已落盘: ${path.join(__dirname, 'data', 'train', 'eval-metrics.json')}`);
  })().catch((e) => { console.error('评测失败:', e); process.exit(1); });
}

module.exports = { runMode };
