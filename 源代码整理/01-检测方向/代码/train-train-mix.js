/**
 * train/train-mix.js — 合成 + 真实混合训练（真实数据轮）
 *
 * 动机：合成集（480 张程序化图）分布单一，真实隧道影像（33 张人工标注）存在噪声、
 * 色偏、失焦、管线遮挡等域差异。混合训练并对真实域 3 倍上采样（仅训练侧，验证侧
 * 按图独立切分不重复），可显著提升真实场景查准率而不牺牲合成域性能。
 *
 * 流程：buildSamples(合成) + buildSamples(真实) → 合并（真实 train×3）→ train.main
 *      → 用新模型对真实 val 做 ROI 级专项评测（对照规则引擎）
 *
 * 用法：node backend/train/train-mix.js [--epochs 4000] [--realWeight 3]
 */
const path = require('path');
const model = require('../model');
const fusion = require('../fusion');
const { buildSamples, CLASSES } = require('./build-samples');
const train = require('./train');

const REAL_DIR = path.join(__dirname, '..', 'data', 'train-real');

function main(opts = {}) {
  const epochs = Number(opts.epochs) || 4000;
  const realWeight = Number(opts.realWeight) || 3;
  const augment = opts.augment != null ? Number(opts.augment) : 3; // P1-2：真实域图像级增广（0=关闭）
  // P0-2 A/B：normMode 透传 vision.analyzeImage（'legacy' 默认 | 'percentile'）
  const normMode = opts.normMode || process.env.TUNNEL_NORM_MODE || 'legacy';
  const visionParams = normMode === 'percentile' ? { normMode: 'percentile' } : {};

  console.log(`① 构建合成域样本…（normMode=${normMode}）`);
  const synth = buildSamples({ dir: path.join(__dirname, '..', 'data', 'train'), visionParams });
  console.log(`   合成：train ${synth.train.length} / val ${synth.val.length}`);
  console.log(`② 构建真实域样本…（增广 ×${augment}）`);
  const real = buildSamples({ dir: REAL_DIR, visionParams, augment });
  console.log(`   真实：train ${real.train.length} / val ${real.val.length}（含增广变体 ${real.stats.augImages || 0} 张）`);

  // 真实域训练侧 ×realWeight 上采样（验证侧不动，防泄漏）
  const realTrainUp = [];
  for (let i = 0; i < realWeight; i++) realTrainUp.push(...real.train);

  const data = {
    classes: synth.classes,
    featureNames: synth.featureNames,
    train: synth.train.concat(realTrainUp),
    val: synth.val.concat(real.val),
    stats: {
      ...synth.stats,
      images: synth.stats.images + real.stats.images,
      rois: synth.stats.rois + real.stats.rois,
      matched: synth.stats.matched + real.stats.matched,
      unmatchedGt: synth.stats.unmatchedGt + real.stats.unmatchedGt,
      negRois: synth.stats.negRois + real.stats.negRois,
      byType: { ...synth.stats.byType },
      realByType: { ...real.stats.byType },
      realWeight,
    },
  };
  console.log(`③ 合并：train ${data.train.length} / val ${data.val.length}（真实域 ×${realWeight} 上采样）`);

  const metrics = train.main({ data, epochs, hardNeg: opts.hardNeg !== false && opts.hardNeg !== 'false' && opts.hardNeg !== 0 });

  // ---- 真实域 val 专项评测（新模型 vs 规则引擎，ROI 级，仅真实图样本） ----
  const mp = model.loadFromFile(train.PARAMS_FILE);
  const predictor = model.createPredictor(mp);
  const pc = (v) => (v * 100).toFixed(1) + '%';
  const learnedEval = train.evaluate((roi) => {
    const p = predictor.predict(roi, { gapmm: 0 });
    let yIdx = 0, bv = -1;
    CLASSES.forEach((c, i) => {
      let v = p.probs ? p.probs[c] : 0;
      if (i > 0 && v < mp.threshold) v = 0;
      if (v > bv) { bv = v; yIdx = i; }
    });
    return { yIdx };
  }, real.val);
  const zeroEv = Object.fromEntries(fusion.DEFECT_TYPES.map((t) => [t, 0]));
  const ruleEval = train.evaluate((roi) => {
    const c = fusion.classifyROI({ ...roi, _gapmm: 0 }, zeroEv);
    const yIdx = c.type && c.score >= fusion.DETECT_THRESHOLD ? CLASSES.indexOf(c.type) : 0;
    return { yIdx };
  }, real.val);
  // ---- 真实域专项评测结果也登记实验台账（科研对比用） ----
  try {
    const research = require('../research');
    research.addExperiment({
      kind: 'train-mix',
      label: `混合训练 · 真实域专项（真实 val ${real.val.length} ROI，×${realWeight} 上采样）`,
      params: { epochs, realWeight, threshold: mp.threshold },
      metrics: {
        realTypeAcc: learnedEval.acc, realMacroF1: learnedEval.macroF1,
        realDefectF1: learnedEval.defect.f1, realPrecision: learnedEval.defect.precision,
        realRecall: learnedEval.defect.recall,
        rulesBaselineF1: ruleEval.defect.f1,
        overallDefectF1: metrics.learned.defect.f1, overallTypeAcc: metrics.learned.acc,
      },
      artifacts: { model: 'data/model_params.json', metrics: 'data/train/metrics.json' },
    });
  } catch (e) { console.log('[实验台账] 登记失败（不影响训练）: ' + e.message); }

  console.log('\n════════ 真实域验证集专项（ROI 级，仅真实图） ════════');
  console.log(`真实 val ROI：${real.val.length}`);
  console.log(`              规则引擎(默认t)   混合训练模型(t=${mp.threshold})`);
  console.log(`类型准确率    ${pc(ruleEval.acc).padEnd(15)} ${pc(learnedEval.acc)}`);
  console.log(`病害宏F1      ${pc(ruleEval.macroF1).padEnd(15)} ${pc(learnedEval.macroF1)}`);
  console.log(`病害二分类F1  ${pc(ruleEval.defect.f1).padEnd(15)} ${pc(learnedEval.defect.f1)}`);
  console.log(`  ├ 查准率 P  ${pc(ruleEval.defect.precision).padEnd(15)} ${pc(learnedEval.defect.precision)}`);
  console.log(`  └ 查全率 R  ${pc(ruleEval.defect.recall).padEnd(15)} ${pc(learnedEval.defect.recall)}`);
  return { realValRois: real.val.length, realEval: { learned: learnedEval, rules: ruleEval }, metrics };
}

module.exports = { main };
if (require.main === module) {
  const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
  main({
    epochs: Number(arg('epochs', 4000)),
    realWeight: Number(arg('realWeight', 3)),
    augment: Number(arg('augment', 3)),
    normMode: arg('normMode', undefined),
    hardNeg: arg('hardNeg', true), // 'false' 关闭难例回灌（暗斑类背景被过度压制时可对照）
  });
}
