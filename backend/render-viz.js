/**
 * render-viz.js — 科研可视化渲染器（混淆矩阵热力图 + 指标对比图，纯 JS 零依赖）
 *
 * 产物（docs/）：
 *   混淆矩阵.png    learned 与 rulesBaseline 两张 6×6 混淆矩阵热力图 + 病害 P/R/F1 对比条
 *   消融实验.png    特征组消融对比条形图（读 data/train/ablation.json，存在才渲染）
 *
 * 渲染：vision 编码 PNG + raster-text 栅格文字（字形位图来自 glyphs.js）。
 * CLI：node backend/render-viz.js
 */
const fs = require('fs');
const path = require('path');
const vision = require('./vision');
const text = require('./raster-text');

const DOCS = path.join(__dirname, '..', 'docs');
const PARAMS = path.join(__dirname, 'data', 'model_params.json');

/** 混淆矩阵热力色：0→白(247)，max→深蓝(28,74,156) */
function heat(v, max) {
  if (v <= 0) return [247, 248, 250];
  const t = Math.sqrt(Math.min(1, v / Math.max(1, max)));
  const mix = (a, b) => Math.round(a + (b - a) * t);
  return [mix(247, 28), mix(248, 74), mix(250, 156)];
}

/** 在 RGBA 画布上画矩形 */
function rect(img, W, x, y, w, h, color) {
  for (let yy = Math.max(0, y | 0); yy < Math.min(img.height, (y + h) | 0); yy++) {
    for (let xx = Math.max(0, x | 0); xx < Math.min(img.width, (x + w) | 0); xx++) {
      const o = (yy * img.width + xx) * 4;
      img.data[o] = color[0]; img.data[o + 1] = color[1]; img.data[o + 2] = color[2]; img.data[o + 3] = 255;
    }
  }
}

/** 画布对象 → RGB PNG Buffer */
function toPng(img) {
  const rgb = Buffer.alloc(img.width * img.height * 3);
  for (let i = 0; i < img.width * img.height; i++) {
    rgb[i * 3] = img.data[i * 4]; rgb[i * 3 + 1] = img.data[i * 4 + 1]; rgb[i * 3 + 2] = img.data[i * 4 + 2];
  }
  return vision.encodePngRGB(img.width, img.height, rgb);
}

const INK = [40, 44, 52], MUTED = [120, 126, 136], BLUE = [40, 90, 180], ORANGE = [214, 108, 38];

/**
 * 画一张 6×6 混淆矩阵（含 真实/预测 轴标签与格内计数）
 * @param {object} img 画布 {data,width,height}
 * @param {number[][]} cm 混淆矩阵
 * @param {string[]} classes 类别名
 * @param {number} ox,oy 左上原点
 * @param {number} cell 单元边长
 * @param {string} title 矩阵标题
 * @param {object} m 指标 {acc,macroF1,defect}
 */
function drawMatrix(img, cm, classes, ox, oy, cell, title, m) {
  const max = Math.max(1, ...cm.flat());
  text.draw(img.data, img.width, img.height, ox, oy - 26, title, 20, INK);
  // 列标题（预测）
  text.draw(img.data, img.width, img.height, ox, oy - 46, '预测列', 13, MUTED);
  classes.forEach((c, j) => {
    const label = c.length > 2 ? c.slice(0, 2) : c; // 列头取前两字防溢出
    text.draw(img.data, img.width, img.height, ox + j * cell + 6, oy + classes.length * cell + 6, label, 13, MUTED);
  });
  // 行标题（真实）+ 单元格
  classes.forEach((c, i) => {
    text.draw(img.data, img.width, img.height, ox - 8 - c.length * 13, oy + i * cell + (cell - 13) / 2, c, 13, MUTED);
    for (let j = 0; j < classes.length; j++) {
      const v = cm[i][j];
      rect(img, img.width, ox + j * cell, oy + i * cell, cell - 2, cell - 2, heat(v, max));
      if (v > 0) {
        const dark = v / max < 0.55;
        const s = String(v);
        const tw = s.length * 8;
        text.draw(img.data, img.width, img.height, ox + j * cell + (cell - 2 - tw) / 2, oy + i * cell + (cell - 2 - 14) / 2, s, 14, dark ? INK : [255, 255, 255]);
      }
    }
  });
  const pc = (v) => (v * 100).toFixed(1) + '%';
  text.draw(img.data, img.width, img.height, ox, oy + classes.length * cell + 28,
    `acc ${pc(m.acc)}  宏F1 ${pc(m.macroF1)}  病害F1 ${pc(m.defect.f1)}`, 15, BLUE);
}

/**
 * 画横向对比条（一组 label + 双色条）
 * @param {object} img 画布
 * @param {number} x,y 左上
 * @param {number} w 条最大宽
 * @param {Array<{label:string,a:number,b:number}>} items a=规则 b=训练（0~1）
 */
function drawCompareBars(img, x, y, w, items) {
  const rowH = 26;
  items.forEach((it, i) => {
    const yy = y + i * rowH;
    text.draw(img.data, img.width, img.height, x, yy + 4, it.label, 13, INK);
    const bw = w - 130;
    rect(img, img.width, x + 90, yy, bw * it.a, 14, ORANGE);
    rect(img, img.width, x + 90, yy + 16, bw * it.b, 14, BLUE);
    text.draw(img.data, img.width, img.height, x + 96 + bw, yy + 1, (it.a * 100).toFixed(1) + '%', 11, ORANGE);
    text.draw(img.data, img.width, img.height, x + 96 + bw, yy + 15, (it.b * 100).toFixed(1) + '%', 11, BLUE);
  });
}

/** 混淆矩阵对比主图 */
function renderConfusion() {
  const p = JSON.parse(fs.readFileSync(PARAMS, 'utf-8'));
  const mt = p.meta && p.meta.metrics;
  if (!mt || !mt.learned || !mt.learned.confusion) { console.log('✗ model_params.json 缺少混淆矩阵指标，请先 node backend/train/train.js'); return; }
  const classes = p.classes;
  const W = 1080, H = 660;
  const img = { width: W, height: H, data: new Uint8Array(W * H * 4).fill(255) };

  text.draw(img.data, W, H, 36, 22, '检测模型混淆矩阵对比（验证集 ROI · 6 分类含背景）', 24, INK);
  const val = `${mt.valRois || ''} 个验证 ROI`.trim();
  text.draw(img.data, W, H, 36, 56, `${val} · 阈值经验证集扫描标定 · 生成于 ${new Date().toLocaleDateString('zh-CN')}`, 13, MUTED);

  const cell = 52, oy = 132;
  drawMatrix(img, mt.learned.confusion, classes, 96, oy, cell, `训练模型（t=${mt.learned.threshold}）`, mt.learned);
  drawMatrix(img, mt.rulesBaseline.confusion, classes, 640, oy, cell, `规则引擎（t=${mt.rulesBaseline.defaultThreshold}）`, mt.rulesBaseline);

  // 图例：颜色 = 计数强度（放右上角空白区，避免压住标题）
  for (let i = 0; i < 60; i++) rect(img, W, 780 + i * 4, 34, 4, 10, heat(i, 59));
  text.draw(img.data, W, H, 786, 48, '计数 0 至 max', 12, MUTED);

  // 病害二分类 P/R/F1 对比条
  text.draw(img.data, W, H, 36, 508, '病害二分类（橙=规则引擎，蓝=训练模型）', 15, INK);
  drawCompareBars(img, 36, 536, 1000, [
    { label: '查准率 P', a: mt.rulesBaseline.defect.precision, b: mt.learned.defect.precision },
    { label: '查全率 R', a: mt.rulesBaseline.defect.recall, b: mt.learned.defect.recall },
    { label: 'F1', a: mt.rulesBaseline.defect.f1, b: mt.learned.defect.f1 },
  ]);

  fs.mkdirSync(DOCS, { recursive: true });
  const file = path.join(DOCS, '混淆矩阵.png');
  fs.writeFileSync(file, toPng(img));
  console.log('✓ ' + file);
}

/** 消融实验条形图（ablation.json 存在才渲染） */
function renderAblation() {
  const file0 = path.join(__dirname, 'data', 'train', 'ablation.json');
  if (!fs.existsSync(file0)) { console.log('· 未找到 ablation.json，跳过消融图（先跑 node backend/train/ablation.js）'); return; }
  const ab = JSON.parse(fs.readFileSync(file0, 'utf-8'));
  const rows = ab.rows;
  const W = 940, H = 130 + rows.length * 64;
  const img = { width: W, height: H, data: new Uint8Array(W * H * 4).fill(255) };

  text.draw(img.data, W, H, 32, 20, '特征组消融实验（病害二分类 P/R/F1，验证集）', 22, INK);
  text.draw(img.data, W, H, 32, 50, `每次去除一组特征后重新训练（${ab.epochs} 轮），阈值独立标定 · ΔF1 = 全量基线 − 去组后`, 12, MUTED);

  const base = rows[0];
  rows.forEach((r, i) => {
    const y = 84 + i * 64;
    const bw = W - 420;
    text.draw(img.data, W, H, 32, y + 4, r.label, 14, INK);
    // P/R/F1 三条细条
    const parts = [['P', r.defect.precision, [214, 108, 38]], ['R', r.defect.recall, [90, 160, 90]], ['F1', r.defect.f1, [40, 90, 180]]];
    parts.forEach(([name, v, color], k) => {
      const yy = y + k * 15;
      rect(img, W, 250, yy, (bw - 120) * v, 10, color);
      text.draw(img.data, W, H, 224, yy - 1, name, 11, MUTED);
      text.draw(img.data, W, H, 250 + (bw - 120) * v, yy - 1, (v * 100).toFixed(1) + '%', 11, INK);
    });
    if (r.key !== 'full') {
      const d = ((base.defect.f1 - r.defect.f1) * 100).toFixed(1);
      text.draw(img.data, W, H, W - 120, y + 14, `ΔF1 ${d.startsWith('-') ? '' : '+'}${Number(d) === 0 ? '0.0' : d}pp`, 13, Number(d) > 0 ? [180, 40, 40] : MUTED);
    } else {
      text.draw(img.data, W, H, W - 120, y + 14, '基线', 13, BLUE);
    }
  });

  const file = path.join(DOCS, '消融实验.png');
  fs.writeFileSync(file, toPng(img));
  console.log('✓ ' + file);
}

/** CLI */
if (require.main === module) {
  renderConfusion();
  renderAblation();
}

module.exports = { renderConfusion, renderAblation };
