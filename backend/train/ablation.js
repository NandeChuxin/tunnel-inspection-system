/**
 * train/ablation.js — 逐特征组消融实验（科研核查第 5 项补齐 · 纯 JS 零依赖）
 *
 * 方法：对训练模型做「留一组」特征消融——每次去掉一组特征后重新训练并在同一验证集评估，
 *       与全量基线对比，量化各组特征对病害识别的贡献。
 *       阈值对每个配置独立在验证集扫描标定（与主训练同口径，保证公平）。
 *
 * 特征组（model.FEATURE_NAMES 15 维划分）：
 *   边缘纹理(2)：edgeDensity, textureVar
 *   色彩亮度(3)：darkRatio, brightRatio, hueShift
 *   形状几何(9)：logElongation, linearity, fillRatio, logLengthPx, logWidthPx,
 *                aspect, oriVertical, oriHorizontal, bboxArea
 *   传感器(1)：  gapmm
 *
 * 产物：backend/data/train/ablation.json + 控制台对比表
 * CLI：node backend/train/ablation.js [--dir data/train] [--epochs 4000]
 */
const fs = require('fs');
const path = require('path');
const model = require('../model');
const { evaluate } = require('./train');
const { buildSamples, CLASSES } = require('./build-samples');

/** 消融配置：drop=去掉的特征名（其余保留）；P1-1 扩展为 9 组（23 维特征集） */
const GROUPS = [
  { key: 'full', label: '全量特征（23维，基线）', drop: [] },
  { key: 'no_texture', label: '去边缘纹理（-2维）', drop: ['edgeDensity', 'textureVar'] },
  { key: 'no_color', label: '去色彩亮度（-3维）', drop: ['darkRatio', 'brightRatio', 'hueShift'] },
  { key: 'no_shape', label: '去形状几何（-9维）', drop: ['logElongation', 'linearity', 'fillRatio', 'logLengthPx', 'logWidthPx', 'aspect', 'oriVertical', 'oriHorizontal', 'bboxArea'] },
  { key: 'no_sensor', label: '去传感器 gapmm（-1维）', drop: ['gapmm'] },
  // —— P1-1 v2 新增消融组 ——
  { key: 'no_illum', label: '去光照不变组（-3维）', drop: ['localContrast', 'gradMeanRatio', 'textureEntropy'] },
  { key: 'no_crack', label: '去裂缝专属组（-2维）', drop: ['widthCv', 'skeletonCoverage'] },
  { key: 'no_hole', label: '去孔洞率（-1维）', drop: ['holeRatio'] },
  { key: 'no_multi', label: '去多尺度组（-2维）', drop: ['scaleConsistency', 'multiScaleElongation'] },
];

/**
 * 运行消融实验
 * @param {{dir?:string, epochs?:number}} opts
 * @returns {object} ablation 结果 JSON
 */
function main(opts = {}) {
  const dir = opts.dir || path.join(__dirname, '..', 'data', 'train');
  const epochs = Number(opts.epochs) || 4000;
  const t0 = Date.now();
  const data = buildSamples({ dir });
  const { train, val } = data;
  const D = data.featureNames.length;
  console.log(`样本：train ${train.length} / val ${val.length}（全量 ${D} 维）· ${GROUPS.length} 组消融配置\n`);

  const K = CLASSES.length;
  const rows = [];
  for (const g of GROUPS) {
    const keep = data.featureNames.map((n, i) => (g.drop.includes(n) ? -1 : i)).filter((i) => i >= 0);
    const d = keep.length;
    const sub = (x) => keep.map((i) => x[i]);
    const trX = train.map((s) => ({ x: sub(s.x), y: s.y }));

    // 标准化（仅用训练集统计）
    const scaler = model.fitScaler(trX.map((s) => s.x), d);
    const sx = trX.map((s) => ({ x: model.scaleVec(s.x, scaler.mean, scaler.std), y: s.y }));
    const { W, b } = model.trainModel(sx, d, K, { epochs });

    // 阈值标定（验证集扫描，与主训练同口径）
    const probsOf = (xv) => {
      const x = model.scaleVec(xv, scaler.mean, scaler.std);
      const z = new Array(K);
      for (let k = 0; k < K; k++) {
        let acc = b[k];
        for (let dd = 0; dd < d; dd++) acc += W[k * d + dd] * x[dd];
        z[k] = acc;
      }
      return model.softmax(z, K);
    };
    const argmax = (probs, t) => {
      let best = 0, bv = -1;
      CLASSES.forEach((c, i) => {
        let v = probs[i];
        if (i > 0 && v < t) v = 0; // 病害类需过阈值，否则压为背景
        if (v > bv) { bv = v; best = i; }
      });
      return best;
    };
    const valX = val.map((s) => ({ roi: s.roi, x: sub(s.x), y: s.y }));
    const evalAt = (t) => evaluate((roi, xv) => ({ yIdx: argmax(probsOf(xv), t) }), valX);
    let bestT = 0.5, bestKey = -1, bestE = null;
    for (let t = 0.05; t <= 0.95; t += 0.01) {
      const e = evalAt(t);
      const key = e.defect.f1 * 2 + e.acc;
      if (key > bestKey) { bestKey = key; bestT = Math.round(t * 100) / 100; bestE = e; }
    }
    const row = {
      key: g.key, label: g.label, dims: d, threshold: bestT,
      acc: bestE.acc, macroF1: bestE.macroF1,
      defect: bestE.defect,
      confusion: bestE.confusion,
    };
    rows.push(row);
    const pc = (v) => (v * 100).toFixed(1) + '%';
    console.log(`${g.label.padEnd(22)} D=${String(d).padStart(2)} t=${bestT}  病害F1=${pc(row.defect.f1).padEnd(6)} P=${pc(row.defect.precision).padEnd(6)} R=${pc(row.defect.recall).padEnd(6)} acc=${pc(row.acc)} macroF1=${pc(row.macroF1)}`);
  }

  const out = { evaluatedAt: new Date().toISOString(), epochs, valRois: val.length, trainRois: train.length, featureGroups: GROUPS, rows };
  const file = path.join(dir, 'ablation.json');
  fs.writeFileSync(file, JSON.stringify(out, null, 1));

  // 贡献解读：F1 降幅 = 基线 - 去组后
  const base = rows[0];
  console.log('\n══ 特征组贡献（病害F1 降幅 = 全量基线 − 去组后） ══');
  for (const r of rows.slice(1)) {
    const drop = (base.defect.f1 - r.defect.f1) * 100;
    console.log(`  ${r.label.padEnd(20)} ΔF1 = ${(drop >= 0 ? '-' : '+') + Math.abs(drop).toFixed(1)}pp`);
  }
  console.log(`\n✓ 消融结果已落盘: ${file} · 耗时 ${Date.now() - t0}ms`);
  return out;
}

/** CLI */
if (require.main === module) {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  main({ dir: arg('dir', undefined), epochs: Number(arg('epochs', 4000)) });
}

module.exports = { main, GROUPS };
