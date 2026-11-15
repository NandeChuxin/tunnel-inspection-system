/**
 * model.js — 隧道病害判别的可训练轻量模型（softmax 多分类，纯 JS 零依赖）
 *
 * 设计：对 vision.analyzeImage 产出的 ROI 特征做标准化 → 线性打分 → softmax，
 *       以「背景 + 5 类病害」6 分类训练（数据驱动训练轮，替代手工规则权重；
 *       注入方式见 fusion.setClassifier，未注入时运行态仍走规则引擎）。
 *
 * 训练（trainModel）：全批量梯度下降 + 动量 + L2 正则 + 类别均衡权重，
 *                    全部 O(样本数×维度) 级别，普通笔记本 CPU 秒级收敛。
 * 推断（createPredictor）：predict(roi, ctx) → { type, confidence, probs }，
 *                    confidence = 最大病害类概率（背景不产出候选，由融合层阈值把关）。
 *
 * 模型落盘 backend/data/model_params.json（权重+标准化参数+类别表+阈值+训练指标元数据）。
 */
const fs = require('fs');

/** 特征名与维度（训练/推断共用同一套向量化，顺序不可变） */
const FEATURE_NAMES = [
  // —— 原有 15 维（顺序不变，保证旧 15 维权重可按前缀兼容加载）——
  'edgeDensity', 'darkRatio', 'brightRatio', 'textureVar', 'hueShift',
  'logElongation', 'linearity', 'fillRatio', 'logLengthPx', 'logWidthPx',
  'aspect', 'oriVertical', 'oriHorizontal', 'bboxArea', 'gapmm',
  // —— v2 新增 8 维（算法优化方案 P1-1：光照不变 ×3 / 裂缝专属 ×2 / 孔洞 ×1 / 多尺度 ×2）——
  'localContrast',        // std(ROI灰度)/std(全图灰度)：裁剪增益不变的局部相对反差
  'gradMeanRatio',        // mean(ROI梯度)/mean(全图梯度)：归一化边缘强度，跨曝光可比
  'textureEntropy',       // 梯度方向直方图(8bin)熵/3：渗漏平滑、剥落杂乱、裂缝方向集中
  'widthCv',              // 骨架法向宽度序列变异系数：裂缝缝宽恒定(小)、剥落/渗漏边界剧烈(大)
  'skeletonCoverage',     // 骨架像素/前景像素：线状结构高、面状结构低
  'holeRatio',            // 背景孔洞/bbox面积：蜂窝麻面剥落高、致密裂缝≈0
  'scaleConsistency',     // 粗/细尺度形态判定一致度：真实病害稳定、噪声不一致
  'multiScaleElongation', // max(细,粗)尺度细长比：缓解细裂缝在粗尺度被平均掉的低估
];
const BACKGROUND = '背景';

/** ROI 特征缺省（与 fusion.FEATURE_DEFAULTS 语义一致，防缺字段） */
const num = (v, d) => (typeof v === 'number' && isFinite(v) ? v : d);

/**
 * ROI 特征 → 数值向量（训练与运行态共用；任何字段缺失取中性缺省）
 * @param {object} roi ROI 特征对象（vision 网格聚类产出契约）
 * @param {{gapmm?:number}} ctx 上下文（断面差等传感器量）
 * @returns {number[]} 定长特征向量（顺序=FEATURE_NAMES）
 */
function vectorize(roi, ctx) {
  const r = roi || {};
  const c = ctx || {};
  const elong = Math.max(1, num(r.elongation, 1));
  const lenPx = Math.max(0, num(r.lengthPx, 0));
  const widPx = Math.max(0, num(r.widthPx, 0));
  const ori = r.orientation === 'vertical' ? [1, 0] : r.orientation === 'horizontal' ? [0, 1] : [0, 0];
  const gap = num(c.gapmm, 0);
  return [
    num(r.edgeDensity, 0.5),
    num(r.darkRatio, 0.5),
    num(r.brightRatio, 0),
    num(r.textureVar, 0.5),
    num(r.hueShift, 0),
    Math.log(1 + elong),
    num(r.linearity, 0.5),
    num(r.fillRatio, 0.5),
    Math.log(1 + lenPx),
    Math.log(1 + widPx),
    Math.min(20, lenPx / (widPx + 1)),
    ori[0], ori[1],
    num(r.bbox ? r.bbox[2] * r.bbox[3] : 0, 0), // bboxArea（归一化框面积）
    Math.min(1, gap / 15),
    // —— v2 新增 8 维（vision.analyzeImage 产出；缺字段取中性缺省，兼容 CNN enrichRois 前的裸框）——
    num(r.localContrast, 0.5),
    num(r.gradMeanRatio, 0.5),
    num(r.textureEntropy, 0.5),
    num(r.widthCv, 0.5),
    num(r.skeletonCoverage, 0.5),
    num(r.holeRatio, 0),
    num(r.scaleConsistency, 0.5),
    Math.log(1 + Math.max(1, num(r.multiScaleElongation, elong))),
  ];
}

/** softmax（数值稳定） */
function softmax(logits, K) {
  let m = -Infinity;
  for (let k = 0; k < K; k++) m = Math.max(m, logits[k]);
  const ex = new Array(K);
  let s = 0;
  for (let k = 0; k < K; k++) { ex[k] = Math.exp(logits[k] - m); s += ex[k]; }
  for (let k = 0; k < K; k++) ex[k] /= s;
  return ex;
}

/**
 * 训练 softmax 多分类（全批量梯度下降 + 动量 + L2 + 类别均衡权重）
 * @param {Array<{x:number[], y:number}>} samples 已向量化样本（y=类别下标）
 * @param {number} D 特征维度
 * @param {number} K 类别数
 * @param {object} opts {epochs=4000, lr=0.6, l2=1e-4, momentum=0.9, seed=7}
 * @returns {{W:number[], b:number[]}} 参数（W 长度 K*D，行主序）
 */
function trainModel(samples, D, K, opts = {}) {
  const epochs = opts.epochs || 4000;
  const lr = opts.lr || 0.6;
  const l2 = opts.l2 == null ? 1e-4 : opts.l2;
  const mom = opts.momentum == null ? 0.9 : opts.momentum;
  const N = samples.length;
  if (!N) throw new Error('训练样本为空');

  // 类别均衡权重：w_c = N/(K·N_c)（上限 5，防极端类炸梯度）
  const cnt = new Array(K).fill(0);
  for (const s of samples) cnt[s.y]++;
  const w = cnt.map((n) => Math.min(5, n > 0 ? N / (K * n) : 1));

  // 参数初始化（零初始化对 softmax 足够）
  const W = new Array(K * D).fill(0);
  const b = new Array(K).fill(0);
  const vW = new Array(K * D).fill(0);
  const vb = new Array(K).fill(0);

  // 标准化已在样本构造时完成（train 侧传 standardized x）
  for (let ep = 0; ep < epochs; ep++) {
    const gW = new Array(K * D).fill(0);
    const gb = new Array(K).fill(0);
    let loss = 0;
    for (const s of samples) {
      const { x, y } = s;
      const z = new Array(K);
      for (let k = 0; k < K; k++) {
        let acc = b[k];
        const off = k * D;
        for (let d = 0; d < D; d++) acc += W[off + d] * x[d];
        z[k] = acc;
      }
      const p = softmax(z, K);
      loss += -Math.log(Math.max(1e-12, p[y])) * w[y];
      for (let k = 0; k < K; k++) {
        const g = (p[k] - (k === y ? 1 : 0)) * w[y];
        const off = k * D;
        gb[k] += g;
        for (let d = 0; d < D; d++) gW[off + d] += g * x[d];
      }
    }
    const sc = lr / N;
    for (let i = 0; i < K * D; i++) {
      vW[i] = mom * vW[i] - sc * (gW[i] + l2 * W[i]);
      W[i] += vW[i];
    }
    for (let k = 0; k < K; k++) {
      vb[k] = mom * vb[k] - sc * gb[k];
      b[k] += vb[k];
    }
    if (opts.onEpoch && ep % 500 === 0) opts.onEpoch(ep, loss / N);
  }
  return { W, b };
}

/** 计算标准化统计量（均值/标准差，std 下限 1e-6） */
function fitScaler(xs, D) {
  const mean = new Array(D).fill(0), std = new Array(D).fill(0);
  for (const x of xs) for (let d = 0; d < D; d++) mean[d] += x[d];
  for (let d = 0; d < D; d++) mean[d] /= Math.max(1, xs.length);
  for (const x of xs) for (let d = 0; d < D; d++) std[d] += (x[d] - mean[d]) ** 2;
  for (let d = 0; d < D; d++) std[d] = Math.max(1e-6, Math.sqrt(std[d] / Math.max(1, xs.length)));
  return { mean, std };
}

/** 应用标准化（返回新向量） */
function scaleVec(x, mean, std) { return x.map((v, d) => (v - mean[d]) / std[d]); }

/**
 * 由参数构造推断器
 * @param {object} params loadFromFile/训练产物（classes/featureNames/mean/std/W/b/threshold）
 * @returns {{predict:Function}} predict(roi, ctx) → { type, confidence, probs }
 */
function createPredictor(params) {
  const { classes, mean, std, W, b, threshold } = params;
  const K = classes.length;
  const D = params.featureNames.length;
  // 维度兼容守卫（算法优化方案 §风险表）：vectorize 现产出 23 维。
  //   D > x.length → 维度不兼容，拒绝加载（调用方回退规则引擎）；
  //   D < x.length → 旧 15 维权重按前缀兼容（新增维度在向量尾部，前 15 维语义不变）。
  if (D > FEATURE_NAMES.length) {
    throw new Error(`模型特征维度 ${D} 超过当前向量化维度 ${FEATURE_NAMES.length}：拒绝加载，请回退规则引擎`);
  }
  // 等级子模型（可选）：特征 = 主特征向量 + 类型 one-hot；classes=[1,2,3,4]
  const lm = params.levelModel || null;
  const lmK = lm ? lm.classes.length : 0;
  const lmD = lm ? lm.featureNames.length : 0;
  /**
   * 推断一个 ROI
   * @param {object} roi ROI 特征
   * @param {{gapmm?:number}} ctx
   * @returns {{type:string, confidence:number, probs:object}} type='背景' 表示无候选
   */
  function predict(roi, ctx) {
    // D < 23（旧 15 维权重）时按前缀截取向量：新增维度在尾部，前 15 维语义不变
    const x = scaleVec(vectorize(roi, ctx).slice(0, D), mean, std);
    const z = new Array(K);
    for (let k = 0; k < K; k++) {
      let acc = b[k];
      const off = k * D;
      for (let d = 0; d < D; d++) acc += W[off + d] * x[d];
      z[k] = acc;
    }
    const p = softmax(z, K);
    const probs = {};
    let best = 0;
    for (let k = 0; k < K; k++) { probs[classes[k]] = p[k]; if (p[k] > p[best]) best = k; }
    const out = { type: classes[best], confidence: p[best], probs };
    // 等级子模型：仅对病害类预测（x + 类型 one-hot）
    if (lm && classes[best] !== BACKGROUND) {
      const lx = x.concat(classes.map((c, i) => (i === best ? 1 : 0)).slice(0, 5));
      const lz = new Array(lmK);
      for (let k = 0; k < lmK; k++) {
        let acc = lm.b[k];
        const off = k * lmD;
        for (let d = 0; d < lmD; d++) acc += lm.W[off + d] * lx[d];
        lz[k] = acc;
      }
      const lp = softmax(lz, lmK);
      let lb = 0;
      for (let k = 0; k < lmK; k++) if (lp[k] > lp[lb]) lb = k;
      out.level = lm.classes[lb];
      out.levelProbs = lp;
    }
    return out;
  }
  return {
    predict,
    /** 融合注入契约：背景或置信度低于阈值 → 无候选；附带等级子模型输出 level（若有） */
    classify(roi, ctx) {
      const r = predict(roi, ctx);
      if (r.type === BACKGROUND) return { type: null, confidence: 0, probs: r.probs };
      if (threshold && r.confidence < threshold) return { type: r.type, confidence: 0, probs: r.probs, level: r.level };
      return { type: r.type, confidence: r.confidence, probs: r.probs, level: r.level };
    },
  };
}

/** 模型参数落盘（含元数据），成功返回写入路径 */
function saveToFile(file, params) {
  fs.mkdirSync(require('path').dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(params, null, 1));
  return file;
}

/** 读取模型参数文件（不存在/损坏返回 null） */
function loadFromFile(file) {
  try {
    const o = JSON.parse(fs.readFileSync(file, 'utf-8'));
    if (!o || o.format !== 'tunnel-defect-softmax' || !Array.isArray(o.classes)) return null;
    return o;
  } catch (e) { return null; }
}

module.exports = {
  FEATURE_NAMES, BACKGROUND, vectorize, trainModel, fitScaler, scaleVec,
  createPredictor, saveToFile, loadFromFile, softmax,
};
