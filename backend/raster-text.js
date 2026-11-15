/**
 * raster-text.js — 零依赖中文/ASCII 文本光栅化（模块一：讲解图合成用）
 *
 * 原理：tools/gen-glyphs.py 把标注可能用到的字符渲染为固定行高（glyphs.CELL_H）
 * 的灰度位图（zlib+base64 打包进 glyphs.js）。运行时按目标字号 fontPx 做双线性
 * 下采样（生成字号较大，10~22px 显示时质量好），以 cell 为步进对齐基线。
 *
 * 对外函数：
 *   measure(str, fontPx)                     -> { width, height }
 *   draw(destRGBA, destW, destH, x, y, str, fontPx, color, opacity)
 *                                              -> { width, height }  原地绘制
 *   fallbackChar()                            -> 缺字占位字符
 */
const zlib = require('zlib');
const glyphs = require('./glyphs');

const CELL_H = glyphs.CELL_H;        // 生成时字格高（px，全字符统一）
const FONT_SIZE = glyphs.FONT_SIZE || 42; // 生成时 em 字号（缩放基准）
const CACHE = new Map();             // char -> Uint8Array(w*CELL_H) 原始灰度

/** 解出单字灰度位图（惰性 + 缓存） */
function rawOf(ch) {
  if (CACHE.has(ch)) return CACHE.get(ch);
  let out = null;
  const g = glyphs.GLYPHS[ch];
  if (g) {
    try {
      const buf = zlib.inflateSync(Buffer.from(g.d, 'base64'));
      if (buf.length === g.w * CELL_H) {
        out = new Uint8Array(buf.buffer, buf.byteOffset, buf.length);
      }
    } catch (e) { out = null; }
  }
  if (!out) {
    // 缺字：回退到占位符（若池中有 □ 用其字形，否则 16×16 空心方块）
    const fallback = glyphs.GLYPHS['□'];
    if (fallback) {
      try {
        const buf = zlib.inflateSync(Buffer.from(fallback.d, 'base64'));
        out = new Uint8Array(buf.buffer, buf.byteOffset, fallback.w * CELL_H);
      } catch (e) { out = null; }
    }
    if (!out) out = new Uint8Array(16 * CELL_H); // 空位
  }
  CACHE.set(ch, out);
  return out;
}

/** 单字符在目标字号下的格宽 */
function cellW(ch, s) {
  const g = glyphs.GLYPHS[ch] || glyphs.GLYPHS['□'] || { w: 16 };
  return Math.max(1, Math.round(g.w * s));
}

/**
 * 文本测量
 * @param {string} str
 * @param {number} fontPx 目标字号（像素高）
 * @returns {{width:number, height:number}}
 */
function measure(str, fontPx) {
  const s = fontPx / FONT_SIZE;
  let w = 0;
  for (const ch of String(str || '')) w += cellW(ch, s) + Math.max(0, Math.round(fontPx * 0.05));
  return { width: Math.max(0, w - Math.max(0, Math.round(fontPx * 0.05))), height: Math.round(fontPx * CELL_H / FONT_SIZE) };
}

const clamp01 = (v) => Math.max(0, Math.min(1, v));

/**
 * 文本绘制（纯 JS 位图双线性采样 + alpha 混合）
 * @param {Buffer|Uint8Array} dest 目标 RGBA 缓冲（就地修改）
 * @param {number} destW,destH 目标图像尺寸
 * @param {number} x,y 文本左上角
 * @param {string} str
 * @param {number} fontPx 目标字号
 * @param {[number,number,number]} color RGB 0~255
 * @param {number} [opacity=1] 整体不透明度
 * @returns {{width:number,height:number}}
 */
function draw(dest, destW, destH, x, y, str, fontPx, color, opacity = 1) {
  const s = fontPx / FONT_SIZE;
  const hCell = Math.max(1, Math.round(CELL_H * s));
  const r = color[0], g = color[1], b = color[2];
  const op = clamp01(opacity);
  let cx = Math.round(x);
  const y0 = Math.round(y);
  for (const ch of String(str || '')) {
    if (ch === '\n') { cx = Math.round(x); continue; }
    const src = rawOf(ch);
    const wc = glyphs.GLYPHS[ch] ? glyphs.GLYPHS[ch].w : (glyphs.GLYPHS['□'] ? glyphs.GLYPHS['□'].w : 16);
    const wCell = cellW(ch, s);
    for (let ty = 0; ty < hCell; ty++) {
      const sy = (ty + 0.5) / s - 0.5;
      const yA = Math.max(0, Math.min(CELL_H - 1, Math.floor(sy)));
      const yB = Math.max(0, Math.min(CELL_H - 1, yA + 1));
      const wy = Math.max(0, Math.min(1, sy - yA));
      for (let tx = 0; tx < wCell; tx++) {
        const sx = (tx + 0.5) / s - 0.5;
        const xA = Math.max(0, Math.min(wc - 1, Math.floor(sx)));
        const xB = Math.max(0, Math.min(wc - 1, xA + 1));
        const wx = Math.max(0, Math.min(1, sx - xA));
        const m00 = src[yA * wc + xA], m01 = src[yA * wc + xB];
        const m10 = src[yB * wc + xA], m11 = src[yB * wc + xB];
        const m = (m00 * (1 - wx) + m01 * wx) * (1 - wy) + (m10 * (1 - wx) + m11 * wx) * wy;
        const a = (m / 255) * op;
        if (a <= 0.02) continue;
        const dx = cx + tx, dy = y0 + ty;
        if (dx < 0 || dy < 0 || dx >= destW || dy >= destH) continue;
        const o = (dy * destW + dx) * 4;
        dest[o] = Math.round(r * a + dest[o] * (1 - a));
        dest[o + 1] = Math.round(g * a + dest[o + 1] * (1 - a));
        dest[o + 2] = Math.round(b * a + dest[o + 2] * (1 - a));
        dest[o + 3] = Math.round(255 * a + dest[o + 3] * (1 - a));
      }
    }
    cx += wCell + Math.max(0, Math.round(fontPx * 0.05));
  }
  return measure(str, fontPx);
}

module.exports = { CELL_H, measure, draw, rawOf };
