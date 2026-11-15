/**
 * composite.js — 对比讲解图合成（模块一，供教师制作课堂讲义）
 *
 * 一图包含：原图（叠加 α=0.45 热力）+ 检测框 + 病害类别与等级标注 +
 *           顶部信息栏（标题/隧道/桩号/检出数/热力图方式）。
 *
 * 零第三方依赖：RGBA 位图直接操作；中文标注用 raster-text（字形位图）。
 *
 * 输入 buildLectureImage(opts)：
 *   {
 *     W,H, overlayRgba,                    // 叠加热力后的原图 RGBA(W*H*4)
 *     tunnel, chainage,                    // 隧道名与桩号（页眉）
 *     detections: [{ bbox:[x,y,w,h]归一化, type, level_text, confidence }],
 *     modeLabel: 'Grad-CAM'|'Eigen-CAM',   // 热力图实际方式
 *     alpha: 0.45,                         // 叠加透明度（页眉说明用）
 *     engineLabel: '融合知识引擎',          // 页眉说明
 *   }
 * 输出：{ png: Buffer(PNG), W, H, detectionsRendered }
 */
const vision = require('./vision');
const raster = require('./raster-text');

/** 病害类别展示色（与前端 TYPE_COLORS 保持一致并补全 5 类） */
const TYPE_COLORS = {
  '裂缝': [245, 211, 39],
  '渗漏水': [47, 155, 255],
  '剥落掉块': [255, 93, 108],
  '衬砌错台': [176, 108, 255],
  '白华析出': [127, 208, 255],
};

/** 病害类别文字在彩色标签上的颜色（按亮度取深/浅） */
function onColor([r, g, b]) {
  return (0.299 * r + 0.587 * g + 0.114 * b) > 150 ? [13, 21, 34] : [255, 255, 255];
}

/** 实心矩形（带 alpha） */
function fillRect(dest, W, H, x, y, w, h, color, alpha = 1) {
  const r = color[0], g = color[1], b = color[2];
  const a = Math.max(0, Math.min(1, alpha));
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
  for (let yy = y0; yy < y1; yy++) {
    for (let xx = x0; xx < x1; xx++) {
      const o = (yy * W + xx) * 4;
      dest[o] = Math.round(r * a + dest[o] * (1 - a));
      dest[o + 1] = Math.round(g * a + dest[o + 1] * (1 - a));
      dest[o + 2] = Math.round(b * a + dest[o + 2] * (1 - a));
      dest[o + 3] = 255;
    }
  }
}

/** 空心矩形框（描边，不填内部） */
function strokeRect(dest, W, H, x, y, w, h, color, lw) {
  const l = Math.max(1, Math.round(lw));
  fillRect(dest, W, H, x, y, w, l, color);          // 上边
  fillRect(dest, W, H, x, y + h - l, w, l, color);  // 下边
  fillRect(dest, W, H, x, y, l, h, color);          // 左边
  fillRect(dest, W, H, x + w - l, y, l, h, color);  // 右边
}

/**
 * 单行文本绘制在指定矩形条内（自动缩字号适配宽度）
 * @returns {{width,height}}
 */
function drawTextIn(dest, W, H, x, y, maxW, str, fontPx, color, bg = null, padX = 6) {
  let f = fontPx;
  while (f > 8 && raster.measure(str, f).width + padX * 2 > maxW) f -= 1;
  const m = raster.measure(str, f);
  if (bg) fillRect(dest, W, H, x, y, m.width + padX * 2, m.height + 6, bg, 0.72);
  raster.draw(dest, W, H, x + padX, y + 3, str, f, color);
  return m;
}

/**
 * 主入口：合成对比讲解图
 */
function buildLectureImage(opts) {
  const { W, H } = opts;
  const overlay = opts.overlayRgba;
  const detections = opts.detections || [];
  // 工作底图：复制叠加热力后的原图
  const dest = Buffer.from(overlay);

  const fs = Math.max(10, Math.min(17, Math.round(W / 42))); // 页眉基础字号随图幅缩放
  const ts = Math.max(12, Math.min(20, Math.round(W / 30))); // 主标题字号
  const chain = opts.chainage || '--';
  const n = detections.length;

  // ---------- ① 顶部信息栏 ----------
  const title = '隧途明鉴·可解释AI教学·对比讲解图';
  const sub = `隧道 ${opts.tunnel || '--'} · 桩号 ${chain} · 检出 ${n} 处病害 · ${opts.engineLabel || '融合知识引擎'} · 热力图 ${opts.modeLabel || ''} (α=${opts.alpha})`;
  const tM = raster.measure(title, ts);
  const sM = raster.measure(sub, fs);
  const hdrH = Math.round(tM.height + sM.height + 14);
  // 顶部半透明条（不影响病害区域阅读）
  fillRect(dest, W, H, 0, 0, W, hdrH, [6, 12, 20], 0.62);
  raster.draw(dest, W, H, 12, 7, title, ts, [255, 255, 255]);
  let subFont = fs;
  while (subFont > 9 && raster.measure(sub, subFont).width > W - 24) subFont -= 1;
  raster.draw(dest, W, H, 12, 7 + tM.height + 4, sub, subFont, [222, 236, 248]);

  // ---------- ② 检测框 + 类别/等级标注 ----------
  const lw = Math.max(2, Math.min(6, Math.round(Math.min(W, H) / 150)));
  const labelFont = Math.max(11, Math.min(16, Math.round(W / 46)));
  let rendered = 0;
  for (let i = 0; i < detections.length; i++) {
    const d = detections[i];
    if (!d || !Array.isArray(d.bbox) || d.bbox.length < 4) continue;
    const [bx, by, bw, bh] = d.bbox;
    const X = bx * W, Y = by * H, BW = Math.max(2, bw * W), BH = Math.max(2, bh * H);
    const c = TYPE_COLORS[d.type] || [255, 255, 255];
    strokeRect(dest, W, H, X, Y, BW, BH, c, lw);
    // 标签条：`序号 类别 等级 置信度%`
    const pct = Math.round((d.confidence || 0) * 100);
    const label = `${i + 1} ${d.type} ${d.level_text || ''} ${pct}%`;
    const m = raster.measure(label, labelFont);
    const chipW = m.width + 10, chipH = m.height + 6;
    let cy = Y - chipH - 3;
    if (cy < hdrH + 2) cy = Math.max(hdrH + 2, Y + 3); // 框顶贴页眉时转框内
    if (cy + chipH > H) cy = H - chipH - 2;
    const cxx = Math.min(Math.max(2, X), Math.max(2, W - chipW - 2));
    fillRect(dest, W, H, cxx, cy, chipW, chipH, c, 0.96);
    raster.draw(dest, W, H, cxx + 5, cy + 3, label, labelFont, onColor(c));
    rendered++;
  }

  // ---------- ③ 编码 ----------
  const png = vision.encodePngRGB(W, H, vision.rgbFromRgba(dest));
  return { png, W, H, detectionsRendered: rendered, headerHeight: hdrH };
}

module.exports = { buildLectureImage, TYPE_COLORS, onColor };
