/**
 * train/train.js — 训练编排：构建样本 → 训练类型/等级模型 → 阈值标定 → 规则基线对比 → 落盘
 *
 * 产物：
 *   backend/data/model_params.json   运行态模型（softmax 权重+标准化参数+标定阈值+等级子模型+指标元数据）
 *   backend/data/train/metrics.json  本轮训练完整指标（供报告引用）
 *
 * 评测口径（val 集，按图切分防泄漏）：
 *   - 类型准确率/宏F1（6 分类：背景+5 病害）
 *   - 病害二分类 P/R/F1（阈值扫描标定；规则基线同样获得阈值调优机会，对比公平）
 *   - 等级准确率（病害样本，训练子模型 vs 多数类基线）
 *
 * CLI：node backend/train/train.js [--dir data/train] [--epochs 4000]
 */
const fs = require('fs');
const path = require('path');
const model = require('../model');
const fusion = require('../fusion');
const { buildSamples, CLASSES } = require('./build-samples');

const PARAMS_FILE = path.join(__dirname, '..', 'data', 'model_params.json');
const TYPES = CLASSES.slice(1); // 5 病害类

/** 混淆矩阵工具：6 分类 acc/macro-F1 + 病害二分类 P/R/F1 */
function evaluate(predictFn, samples) {
  const K = CLASSES.length;
  const cm = Array.from({ length: K }, () => new Array(K).fill(0));
  let tp = 0, fp = 0, fn = 0, typeOk = 0;
  for (const s of samples) {
    const pred = predictFn(s.roi, s.x);
    cm[s.y][pred.yIdx]++;
    if (pred.yIdx === s.y) typeOk++;
    const pDef = pred.yIdx !== 0, gDef = s.y !== 0;
    if (pDef && gDef) tp++;
    else if (pDef && !gDef) fp++;
    else if (!pDef && gDef) fn++;
  }
  const acc = typeOk / Math.max(1, samples.length);
  const f1s = [];
  for (let k = 1; k < K; k++) { // macro-F1 只统计病害类（背景单独用二分类口径）
    const tpk = cm[k][k], fpk = cm.reduce((a, r, i) => a + (i !== k ? r[k] : 0), 0);
    const fnk = cm[k].reduce((a, v, j) => a + (j !== k ? v : 0), 0);
    const p = tpk / Math.max(1e-9, tpk + fpk), r = tpk / Math.max(1e-9, tpk + fnk);
    f1s.push(2 * p * r / Math.max(1e-9, p + r));
  }
  const macroF1 = f1s.reduce((a, b) => a + b, 0) / f1s.length;
  const precision = tp / Math.max(1e-9, tp + fp);
  const recall = tp / Math.max(1e-9, tp + fn);
  return { acc, macroF1, defect: { precision, recall, f1: 2 * precision * recall / Math.max(1e-9, precision + recall) }, confusion: cm };
}

/** 训练入口 */
function main(opts = {}) {
  const dir = opts.dir || path.join(__dirname, '..', 'data', 'train');
  const epochs = Number(opts.epochs) || 4000;
  const t0 = Date.now();

  // ---- ① 样本构建 ----
  // opts.data 允许外部（如 train-mix.js）注入预构建样本集（合成+真实混合）
  const data = opts.data || buildSamples({ dir });
  const { train, val } = data;
  const D = data.featureNames.length, K = data.classes.length;
  console.log(`① 样本：train ${train.length} / val ${val.length}（${D} 维特征 × ${K} 类）`);

  // ---- ② 标准化 + 类型模型训练 ----
  const scaler = model.fitScaler(train.map((s) => s.x), D);
  let trainX = train.map((s) => ({ x: model.scaleVec(s.x, scaler.mean, scaler.std), y: s.y }));
  console.log(`② 训练类型模型（softmax · ${epochs} 轮全批量 GD + 动量）…`);
  let { W, b } = model.trainModel(trainX, D, K, { epochs, onEpoch: opts.onEpoch });

  // ---- ②b P2-2 难例回灌（算法优化方案 §4.5）：首轮训练后，收集训练侧高置信度背景
  //      误报（y=0 但病害类概率>0.5 的衬砌正常纹理难例），按 3 倍权重回灌二轮重训。
  //      仅用训练侧样本，验证侧不动，无泄漏。默认开启，opts.hardNeg=false 可关闭。
  let hardNegCount = 0;
  if (opts.hardNeg !== false) {
    const zOf = (x) => {
      const z = new Array(K);
      for (let k = 0; k < K; k++) {
        let acc = b[k];
        const off = k * D;
        for (let d = 0; d < D; d++) acc += W[off + d] * x[d];
        z[k] = acc;
      }
      return z;
    };
    const hard = [];
    for (const s of trainX) {
      if (s.y !== 0) continue;
      const p = model.softmax(zOf(s.x), K);
      let bestDefect = 0;
      for (let k = 1; k < K; k++) bestDefect = Math.max(bestDefect, p[k]);
      if (bestDefect > 0.5) hard.push(s);
    }
    hardNegCount = hard.length;
    if (hard.length) {
      const hardUp = [];
      for (let i = 0; i < 3; i++) hardUp.push(...hard);
      trainX = trainX.concat(hardUp);
      ({ W, b } = model.trainModel(trainX, D, K, { epochs: Math.round(epochs / 2) }));
      console.log(`②b 难例回灌：${hard.length} 个高置信度背景误报 ×3 权重回灌，二轮重训完成`);
    }
  }

  // ---- ③ 等级子模型（病害样本：主特征 + 类型 one-hot） ----
  const lvClasses = [1, 2, 3, 4];
  const lvD = D + 5;
  const lvFeat = (s, typeIdx) => s.x.concat(CLASSES.map((_, i) => (i === typeIdx ? 1 : 0)));
  const fgTrain = train.filter((s) => s.y !== 0);
  const lvScaler = model.fitScaler(fgTrain.map((s) => s.x), D); // 主特征标准化复用口径
  const lvTrain = fgTrain.map((s) => {
    const base = model.scaleVec(s.x, lvScaler.mean, lvScaler.std);
    return { x: base.concat(CLASSES.map((_, i) => (i === s.y - 1 ? 1 : 0))), y: lvClasses.indexOf(s.level) };
  }).filter((s) => s.y >= 0);
  const levelW = model.trainModel(lvTrain, lvD, 4, { epochs: Math.round(epochs / 2) });
  const levelModel = {
    classes: lvClasses,
    // 特征 = 主特征（标准化，前 D 维）+ 类型 one-hot（后 5 维，原样不标准化）
    featureNames: data.featureNames.concat(TYPES.map((t) => 'onehot_' + t)),
    mean: lvScaler.mean, std: lvScaler.std, W: levelW.W, b: levelW.b,
  };

  // ---- ④ 阈值标定（val 扫描；规则基线同样获得调优机会） ----
  const predictor = model.createPredictor({
    format: 'tunnel-defect-softmax', version: 1, classes: data.classes, featureNames: data.featureNames,
    mean: scaler.mean, std: scaler.std, W, b, threshold: 0,
  });
  // 学习模型预测：病害类概率需过阈值 t，否则压为背景（背景兜底取剩余最大概率）
  function argmaxProbs(probs, t) {
    let best = 0, bv = -1;
    data.classes.forEach((c, i) => {
      let v = probs[c];
      if (i > 0 && v < t) v = 0;
      if (v > bv) { bv = v; best = i; }
    });
    return best;
  }
  const evalLearned = (t) => evaluate((roi) => {
    const r = predictor.predict(roi, { gapmm: 0 });
    return { yIdx: argmaxProbs(r.probs, t) };
  }, val);

  function argmaxRule(scored, t) {
    // scored: {type,score}（规则引擎）；score<t → 背景
    if (!scored.type || scored.score < t) return 0;
    return CLASSES.indexOf(scored.type);
  }
  const ruleCand = (roi) => {
    const f = { ...roi, _gapmm: 0 };
    const zeroEv = Object.fromEntries(fusion.DEFECT_TYPES.map((t) => [t, 0]));
    const c = fusion.classifyROI(f, zeroEv);
    return { type: c.type, score: c.score };
  };

  let bestT = 0.5, bestF1 = -1, bestEval = null;
  for (let t = 0.05; t <= 0.95; t += 0.01) {
    const e = evalLearned(t);
    const key = e.defect.f1 * 2 + e.acc; // 主指标=病害F1，次指标=类型acc
    if (key > bestF1) { bestF1 = key; bestT = Math.round(t * 100) / 100; bestEval = e; }
  }
  let rBestT = fusion.DETECT_THRESHOLD, rBestF1 = -1, rBestEval = null;
  for (let t = 0.05; t <= 0.95; t += 0.01) {
    const e = evaluate((roi) => ({ yIdx: argmaxRule(ruleCand(roi), t) }), val);
    const key = e.defect.f1 * 2 + e.acc;
    if (key > rBestF1) { rBestF1 = key; rBestT = Math.round(t * 100) / 100; rBestEval = e; }
  }
  const rDefaultEval = evaluate((roi) => ({ yIdx: argmaxRule(ruleCand(roi), fusion.DETECT_THRESHOLD) }), val);

  // ---- ⑤ 等级准确率（病害 val 样本） ----
  const fgVal = val.filter((s) => s.y !== 0 && lvClasses.indexOf(s.level) >= 0);
  const lvPredict = (s) => {
    const base = model.scaleVec(s.x, lvScaler.mean, lvScaler.std);
    const lx = base.concat(CLASSES.map((_, i) => (i === s.y - 1 ? 1 : 0)));
    let best = 0, bv = -1;
    for (let k = 0; k < 4; k++) {
      let acc = levelW.b[k];
      for (let d = 0; d < lvD; d++) acc += levelW.W[k * lvD + d] * lx[d];
      if (acc > bv) { bv = acc; best = k; }
    }
    return lvClasses[best];
  };
  const lvOk = fgVal.filter((s) => lvPredict(s) === s.level).length;
  const lvOk1 = fgVal.filter((s) => Math.abs(lvPredict(s) - s.level) <= 1).length;
  const lvMaj = (() => {
    const cnt = {};
    for (const s of fgTrain) cnt[s.level] = (cnt[s.level] || 0) + 1;
    const maj = Object.entries(cnt).sort((a, b) => b[1] - a[1])[0][0];
    return { level: Number(maj), acc: fgVal.filter((s) => String(s.level) === maj).length / Math.max(1, fgVal.length) };
  })();

  // ---- ⑥ 落盘 ----
  const metrics = {
    evaluatedAt: new Date().toISOString(),
    valRois: val.length, trainRois: train.length,
    learned: { threshold: bestT, ...bestEval, levelAcc: lvOk / Math.max(1, fgVal.length), levelAccPlusMinus1: lvOk1 / Math.max(1, fgVal.length), levelVal: fgVal.length },
    rulesBaseline: {
      defaultThreshold: fusion.DETECT_THRESHOLD, ...rDefaultEval,
      tunedThreshold: rBestT, tuned: rBestEval,
    },
    levelMajorityBaseline: lvMaj,
    proposalRecall: data.stats.matched / Math.max(1, data.stats.matched + data.stats.unmatchedGt),
    // P0-3：候选召回是 ROI 级指标的绝对上限，升级为一等指标并拆解上限构成
    proposalStats: {
      gtTotal: data.stats.matched + data.stats.unmatchedGt,
      gtCovered: data.stats.matched,
      gtMissed: data.stats.unmatchedGt,
      roisTotal: data.stats.rois,
      negRois: data.stats.negRois,
      matchNote: '匹配判据：合成域 IoU≥0.3；真实域 max(IoU, 交集/GT面积)≥0.3（区域级大框口径）',
    },
    hardNegMining: { enabled: opts.hardNeg !== false, count: hardNegCount }, // P2-2
    sampleStats: data.stats,
  };
  const params = {
    format: 'tunnel-defect-softmax', version: 1,
    classes: data.classes, featureNames: data.featureNames,
    mean: scaler.mean, std: scaler.std, W, b, threshold: bestT,
    // 等级指标必须以本次写出的 metrics.json / eval-metrics.json 为准，不在源码硬编码历史百分比；
    // held-out ROI 与端到端独立图是两个评测集，报告时必须分别标注样本量，禁止混写。
    // 均未达到可替代规范分级 gradeDefect 的工程水准。主因：缺陷真实尺寸与等级相关性弱、
    // 等级阈值本质是规范条款而非可统计学习的规律。指标留存 metrics.json 供后续改进。
    enabled: true,
    meta: { trainedAt: new Date().toISOString(), epochs, elapsedMs: Date.now() - t0, metrics, levelModelTrained: true },
  };
  model.saveToFile(PARAMS_FILE, params);
  fs.writeFileSync(path.join(dir, 'metrics.json'), JSON.stringify(metrics, null, 1));

  // ---- ⑥b 科研实验台账登记（可复现：数据集指纹 + 超参 + 核心指标） ----
  try {
    const research = require('../research');
    research.addFromTrainMetrics(metrics, {
      kind: 'train', label: '训练轮 · 验证集 ROI 级评测',
      params: { epochs, dir: path.basename(dir) },
    });
  } catch (e) { console.log('[实验台账] 登记失败（不影响训练）: ' + e.message); }

  // ---- ⑦ 报告 ----
  const pc = (v) => (v * 100).toFixed(1) + '%';
  console.log('\n════════ 验证集对比（ROI 级，6 分类含背景） ════════');
  console.log(`指标                 规则引擎(默认t=${fusion.DETECT_THRESHOLD})  规则引擎(调优t=${rBestT})  训练模型(t=${bestT})`);
  console.log(`类型准确率           ${pc(rDefaultEval.acc).padEnd(18)} ${pc(rBestEval.acc).padEnd(16)} ${pc(bestEval.acc)}`);
  console.log(`病害宏F1             ${pc(rDefaultEval.macroF1).padEnd(18)} ${pc(rBestEval.macroF1).padEnd(16)} ${pc(bestEval.macroF1)}`);
  console.log(`病害二分类F1         ${pc(rDefaultEval.defect.f1).padEnd(18)} ${pc(rBestEval.defect.f1).padEnd(16)} ${pc(bestEval.defect.f1)}`);
  console.log(`  ├ 查准率 P          ${pc(rDefaultEval.defect.precision).padEnd(18)} ${pc(rBestEval.defect.precision).padEnd(16)} ${pc(bestEval.defect.precision)}`);
  console.log(`  └ 查全率 R          ${pc(rDefaultEval.defect.recall).padEnd(18)} ${pc(rBestEval.defect.recall).padEnd(16)} ${pc(bestEval.defect.recall)}`);
  console.log(`等级准确率(严格/±1)  ${(lvMaj.acc * 100).toFixed(1) + '%（多数类基线）'}    训练等级子模型 ${(metrics.learned.levelAcc * 100).toFixed(1) + '% / ' + (metrics.learned.levelAccPlusMinus1 * 100).toFixed(1) + '%'}`);
  console.log(`候选召回（GT 被特征聚类覆盖）: ${(metrics.proposalRecall * 100).toFixed(1)}%`);
  console.log(`\n✓ 模型已落盘: ${PARAMS_FILE}（threshold=${bestT}，enabled=true）`);
  console.log(`✓ 指标已落盘: ${path.join(dir, 'metrics.json')} · 总耗时 ${Date.now() - t0}ms`);
  return metrics;
}

/** CLI */
if (require.main === module) {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  main({ dir: arg('dir', undefined), epochs: Number(arg('epochs', 4000)) });
}

module.exports = { main, PARAMS_FILE, evaluate };
