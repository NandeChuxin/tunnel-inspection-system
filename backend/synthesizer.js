/**
 * synthesizer.js — 模块二：病害样本合成器（虚实结合实训台 · 数据增强，零第三方依赖）
 *
 * 合规声明：本模块产生的合成样本仅用于【实训演示与数据增强】，DB 记录 source='synthetic'、
 * 文件独立存放于 data/synthetic/ 目录、响应带 marker 标注，严禁与科研实测数据混用。
 *
 * 合成流程（每条样本）：
 *   1) 背景：程序化生成带起伏/施工缝/气孔的衬砌纹理，或从用户上传背景随机裁块
 *   2) 缺陷素材：优先「从已有标注数据按 YOLO 框裁剪（bbox + 边缘羽化）」；
 *      未提供标注素材时使用内置演示缺陷（同样按框裁剪语义生成）
 *   3) 扰动管线：随机 1~3 处粘贴（互不重叠）→ 每处缩放 + 透视微变换(±5°)
 *      → 亮度(±20%) / 对比度(±20%) / 伽马(0.8~1.2) → 模糊(核3/5) → 边缘羽化
 *   4) 全图高斯噪声(σ=0.02) 后编码 JPEG 落盘 data/synthetic/sample_序号_类型_等级.jpg
 *   5) 逐张写 synthetic_sample 表（source_bg/source_defect/params/output_path）
 *      并写 image 索引表（source='synthetic'）
 *
 * 对外函数：
 *   synthesize(body)                      批量合成：{count?, defects?, background?, outSize?}
 *   listLibrary({page,size,keyword?})     分页浏览合成样本库（元数据，不含图像字节）
 *   SYN_DIR, SYN_NOTE
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const vision = require('./vision');
const jpeg = require('./jpeg');
const db = require('./db');

const SYN_DIR = path.join(__dirname, 'data', 'synthetic');
const SYN_NOTE = '合成样本：仅用于实训演示与数据增强，不得与科研实测数据混用';
const BG_W = 512, BG_H = 384;                 // 合成画布尺寸
const TYPE_ORDER = ['裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出'];
const DEFECT_KINDS = TYPE_ORDER;              // 内置演示缺陷类别

/* ---------------- 随机工具 ---------------- */
function rnd(a = 1, b = null) { if (b === null) return Math.random() * a; return a + Math.random() * (b - a); }
function rint(a, b) { return Math.round(rnd(a, b)); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }
function clamp(v, a, b) { return Math.max(a, Math.min(b, v)); }
function gauss() { // Box-Muller
  let u = 0, v = 0;
  while (u === 0) u = Math.random();
  while (v === 0) v = Math.random();
  return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v);
}

/* ---------------- 图像小工具（RGBA 缓冲 8bit，alpha 独立 Uint8Array） ---------------- */
function blankRGBA(w, h, v = 0) { const b = Buffer.alloc(w * h * 4); if (v) for (let i = 0; i < w * h; i++) { b[i * 4] = v; b[i * 4 + 1] = v; b[i * 4 + 2] = v; b[i * 4 + 3] = 255; } return b; }

/**
 * 裁剪 RGBA 一块区域（含 alpha 通道）
 * @param {Buffer} rgba 源
 * @param {number} W,H 源尺寸
 * @param {number} x,y,w,h 裁剪区（自动越界收缩）
 * @returns {{rgba:Buffer,alpha:Uint8Array,w:number,h:number,ox:number,oy:number}}
 */
function cropRgba(rgba, W, H, x, y, w, h) {
  const x0 = Math.max(0, Math.round(x)), y0 = Math.max(0, Math.round(y));
  const x1 = Math.min(W, Math.round(x + w)), y1 = Math.min(H, Math.round(y + h));
  const cw = Math.max(1, x1 - x0), ch = Math.max(1, y1 - y0);
  const out = Buffer.alloc(cw * ch * 4);
  const alpha = new Uint8Array(cw * ch);
  for (let j = 0; j < ch; j++) {
    for (let i = 0; i < cw; i++) {
      const so = ((y0 + j) * W + x0 + i) * 4, doo = (j * cw + i) * 4;
      out[doo] = rgba[so]; out[doo + 1] = rgba[so + 1]; out[doo + 2] = rgba[so + 2];
      const a = rgba[so + 3]; out[doo + 3] = a; alpha[j * cw + i] = a;
    }
  }
  return { rgba: out, alpha, w: cw, h: ch };
}

/** 双线性缩放 RGBA（保持 alpha） */
function resizeRgba(rgba, alpha, w, h, nw, nh) {
  if (nw <= 0 || nh <= 0) return null;
  const out = Buffer.alloc(nw * nh * 4);
  const na = new Uint8Array(nw * nh);
  const sx = w / nw, sy = h / nh;
  for (let y = 0; y < nh; y++) {
    const fy = (y + 0.5) * sy - 0.5, y0 = Math.max(0, Math.min(h - 2, Math.floor(fy)));
    const wy = fy - y0;
    for (let x = 0; x < nw; x++) {
      const fx = (x + 0.5) * sx - 0.5, x0 = Math.max(0, Math.min(w - 2, Math.floor(fx)));
      const wx = fx - x0;
      const o00 = (y0 * w + x0) * 4, o01 = o00 + 4, o10 = o00 + w * 4, o11 = o10 + 4;
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[o00 + c] * (1 - wx) + rgba[o01 + c] * wx) * (1 - wy)
          + (rgba[o10 + c] * (1 - wx) + rgba[o11 + c] * wx) * wy;
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      const a00 = alpha[y0 * w + x0], a01 = alpha[y0 * w + Math.min(w - 1, x0 + 1)];
      const a10 = alpha[Math.min(h - 1, y0 + 1) * w + x0], a11 = alpha[Math.min(h - 1, y0 + 1) * w + Math.min(w - 1, x0 + 1)];
      na[y * nw + x] = Math.round((a00 * (1 - wx) + a01 * wx) * (1 - wy) + (a10 * (1 - wx) + a11 * wx) * wy);
    }
  }
  return { rgba: out, alpha: na, w: nw, h: nh };
}

/** 仿射透视微变换：绕中心旋转 angle(度) + 轻微水平错切 shear；逆映射双线性 */
function warpAffine(rgba, alpha, w, h, angleDeg, shear) {
  if (Math.abs(angleDeg) < 0.3 && Math.abs(shear) < 0.004) return { rgba, alpha, w, h };
  const th = (angleDeg * Math.PI) / 180;
  const cosT = Math.cos(th), sinT = Math.sin(th);
  const nw = Math.ceil(Math.abs(w * cosT) + Math.abs(h * sinT)) + 1;
  const nh = Math.ceil(Math.abs(w * sinT) + Math.abs(h * cosT)) + 1;
  const cx = w / 2, cy = h / 2, ncx = nw / 2, ncy = nh / 2;
  const out = Buffer.alloc(nw * nh * 4);
  const na = new Uint8Array(nw * nh);
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      // 逆映射到源（先减目标中心 → 反错切 → 反旋转 → 加源中心）
      let dx = x - ncx, dy = y - ncy;
      dx = dx - shear * dy;            // 反错切（水平）
      const px = cosT * dx + sinT * dy + cx;
      const py = -sinT * dx + cosT * dy + cy;
      if (px < 0 || py < 0 || px >= w - 1 || py >= h - 1) continue;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const wx = px - x0, wy = py - y0;
      const o = (y * nw + x) * 4;
      const o00 = (y0 * w + x0) * 4, o01 = o00 + 4, o10 = o00 + w * 4, o11 = o10 + 4;
      for (let c = 0; c < 4; c++) {
        const v = (rgba[o00 + c] * (1 - wx) + rgba[o01 + c] * wx) * (1 - wy)
          + (rgba[o10 + c] * (1 - wx) + rgba[o11 + c] * wx) * wy;
        out[o + c] = Math.max(0, Math.min(255, Math.round(v)));
      }
      const a = (alpha[y0 * w + x0] * (1 - wx) + alpha[y0 * w + x0 + 1] * wx) * (1 - wy)
        + (alpha[(y0 + 1) * w + x0] * (1 - wx) + alpha[(y0 + 1) * w + x0 + 1] * wx) * wy;
      na[y * nw + x] = Math.round(a);
    }
  }
  return { rgba: out, alpha: na, w: nw, h: nh };
}

/** 灰度(单通道) 3×3 box 模糊（用于 alpha 羽化柔边） */
function blurAlpha(alpha, w, h) {
  const out = new Uint8Array(w * h);
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      let s = 0, n = 0;
      for (let j = -1; j <= 1; j++) for (let i = -1; i <= 1; i++) {
        const yy = y + j, xx = x + i;
        if (yy < 0 || xx < 0 || yy >= h || xx >= w) continue;
        s += alpha[yy * w + xx]; n++;
      }
      out[y * w + x] = Math.round(s / n);
    }
  }
  return out;
}

/** 对 patch RGB 做亮度/对比度/伽马 + 高斯噪声 + 模糊（灰度噪声近似） */
function photoPerturb(patch) {
  const { rgba, alpha, w, h } = patch;
  const bri = rnd(-0.2, 0.2) * 255;            // 亮度 ±20% ×255
  const con = rnd(0.8, 1.2);                   // 对比 ±20%
  const gam = 1 / rnd(0.8, 1.2);               // 伽马 0.8~1.2（逆）
  const blurK = pick([0, 0, 3, 5]);            // 模糊核 3/5（50% 不加）
  const gs = blurK > 1 ? rint(3, 5) : 0;
  const mid = 128 + bri;
  const rgb = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) {
      let v = rgba[o + c];
      v = (v - 128) * con + mid;                // 亮度+对比
      v = clamp(v, 0, 255);
      v = 255 * Math.pow(v / 255, gam);         // 伽马
      rgb[i * 3 + c] = clamp(v, 0, 255);
    }
  }
  if (gs) {
    // 轻量高斯模糊：先分离 1D 高斯行/列（核3或5）
    const kernel = gs === 3 ? [1, 2, 1] : [1, 4, 6, 4, 1];
    const ks = kernel.length, r = (ks / 2) | 0, div = kernel.reduce((a, b) => a + b, 0);
    const tmp = Buffer.alloc(w * h * 3);
    for (let c = 0; c < 3; c++) {
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = 0; k < ks; k++) {
          const xx = clamp(x + k - r, 0, w - 1);
          s += rgb[(y * w + xx) * 3 + c] * kernel[k];
        }
        tmp[(y * w + x) * 3 + c] = s / div;
      }
      for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
        let s = 0;
        for (let k = 0; k < ks; k++) {
          const yy = clamp(y + k - r, 0, h - 1);
          s += tmp[(yy * w + x) * 3 + c] * kernel[k];
        }
        rgb[(y * w + x) * 3 + c] = clamp(Math.round(s / div), 0, 255);
      }
    }
  }
  return { rgb, alpha, w, h }; // 扰动后的 patch（RGB + alpha）
}

/* ---------------- 背景 ---------------- */
/**
 * 程序化生成衬砌纹理背景
 * 输入：RNG 派生的扰动种子（函数内自取随机）；输出 RGBA（alpha=255）
 */
function makeBackground(useRgba = null, useW = BG_W, useH = BG_H) {
  if (useRgba) {
    // 用户上传背景：等比缩放至画布并随机裁块
    const s = Math.max(useW / useRgba.W, useH / useRgba.H);
    const tw = Math.min(useW, Math.round(useRgba.W * s)), th = Math.min(useH, Math.round(useRgba.H * s));
    let img = vision.downscaleRGBA(useRgba.rgba, useRgba.W, useRgba.H, Math.max(tw, th));
    if (img.width < useW || img.height < useH) img = { width: img.width, height: img.height, data: img.data };
    const ox = rint(0, Math.max(0, img.width - useW));
    const oy = rint(0, Math.max(0, img.height - useH));
    return cropRgba(img.data, img.width, img.height, ox, oy, useW, useH);
  }
  const W = useW, H = useH;
  const rgba = blankRGBA(W, H, 128);
  // 大尺度混凝土明暗：线性照明渐变 + 若干柔和明暗斑（避免周期条纹）
  const base = rnd(116, 150);
  const gx = rnd(-26, 26), gy = rnd(-14, 14);            // 横/纵渐变幅度
  const blobs = [];
  const nBlob = rint(9, 16);
  for (let i = 0; i < nBlob; i++) {
    blobs.push({ cx: rnd(0, W), cy: rnd(0, H), r: rnd(50, 190), dv: rnd(-16, 16) });
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let v = base + gx * (x / W - 0.5) * 2 + gy * (y / H - 0.5) * 2;
      for (const b of blobs) {
        const d2 = ((x - b.cx) ** 2 + (y - b.cy) ** 2) / (b.r * b.r);
        if (d2 < 4) v += b.dv * Math.exp(-d2 * 1.1);
      }
      v += gauss() * 3.6;
      const g = clamp(v, 0, 255);
      const o = (y * W + x) * 4;
      rgba[o] = g; rgba[o + 1] = g; rgba[o + 2] = g; rgba[o + 3] = 255;
    }
  }
  // 施工缝：至多 1 条细暗线（更自然）
  const seams = rint(0, 1);
  for (let s = 0; s < seams; s++) {
    const horiz = Math.random() < 0.5;
    const p = rint(W * 0.2, W * 0.8);
    for (let i = 0; i < (horiz ? W : H); i++) {
      for (const [k, dv] of [[0, -12], [-1, -5], [1, -5]]) {
        const xx = horiz ? i : p + k, yy = horiz ? p + k : i;
        if (xx < 0 || yy < 0 || xx >= W || yy >= H) continue;
        const o = (yy * W + xx) * 4;
        rgba[o] = clamp(rgba[o] + dv, 0, 255); rgba[o + 1] = clamp(rgba[o + 1] + dv, 0, 255); rgba[o + 2] = clamp(rgba[o + 2] + dv, 0, 255);
      }
    }
  }
  // 稀疏骨料颗粒
  for (let i = 0; i < W * H * 0.015; i++) {
    const x = (Math.random() * W) | 0, y = (Math.random() * H) | 0;
    const v = gauss() * 8;
    for (let c = 0; c < 3; c++) {
      const o = (y * W + x) * 4 + c;
      rgba[o] = clamp(rgba[o] + v, 0, 255);
    }
  }
  return { rgba, alpha: new Uint8Array(W * H).fill(255), w: W, h: H };
}

/* ---------------- 内置演示缺陷（程序化像素绘制，供演示/无标注素材时使用） ---------------- */
/**
 * 各类型缺陷绘制。返回 {rgba,alpha,w,h,class_name,level,bboxW,bboxH}
 * level(1~4) 控制尺度/浓度/形态强度。
 */
function makeDemoDefect(kind, level = 2) {
  const W = rint(120, 260), H = rint(110, 230);
  const rgba = blankRGBA(W, H, 128);
  const alpha = new Uint8Array(W * H);
  const put = (x, y, a, g, r = null) => {
    x = Math.round(x); y = Math.round(y);
    if (x < 0 || y < 0 || x >= W || y >= H) return;
    const o = (y * W + x) * 4;
    const a0 = alpha[y * W + x];
    const na = Math.min(255, a0 + a);
    alpha[y * W + x] = na;
    const t = na / 255;
    for (let c = 0; c < 3; c++) {
      const val = r !== null ? r[c] : g;
      rgba[o + c] = Math.round(rgba[o + c] * (1 - t) + val * t);
    }
  };
  const dark = () => rnd(14, 52);
  switch (kind) {
    case '裂缝': {
      // 贯穿式主缝（竖/横随机）+ 2~4 条分支；宽度沿程渐变，中心不透明
      const vertical = Math.random() < 0.6;
      const span = vertical ? H + 12 : W + 12;
      const mainW = [3.2, 5, 8, 13][level - 1] * rnd(0.85, 1.25);   // 半宽（px）
      const x0 = vertical ? rnd(W * 0.3, W * 0.7) : -6;
      const y0 = vertical ? -6 : rnd(H * 0.3, H * 0.7);
      const swayA = rnd(6, 22), swayF = rnd(1.2, 2.6), phase = rnd(0, 6.28);
      const dtheta = rnd(-0.22, 0.22);
      const path = [];                       // 沿程采样点 {x,y,w}
      const steps = rint(60, 110);
      for (let s = 0; s <= steps; s++) {
        const t = s / steps;
        const along = t * span - 6;
        const sway = Math.sin(t * Math.PI * swayF + phase) * swayA * (0.4 + 0.6 * t);
        const px = vertical ? x0 + sway + dtheta * along : along;
        const py = vertical ? along : y0 + sway + dtheta * along;
        const w = mainW * (0.55 + 0.45 * Math.sin(t * Math.PI + 0.4)) * rnd(0.75, 1.2);
        path.push({ x: px, y: py, w: Math.max(0.7, w) });
      }
      const stroke = (pts, wMul, aCore) => {
        for (const p of pts) {
          const wi = Math.max(0.6, p.w * wMul);
          const r = Math.ceil(wi);
          for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
            const d = Math.hypot(dx, dy);
            if (d > wi) continue;
            const a = aCore * (1 - (d / wi) * 0.65);
            put(p.x + dx + gauss() * 0.5, p.y + dy + gauss() * 0.5, a, clamp(dark() + d * 6, 8, 90));
          }
        }
      };
      stroke(path, 1, 250);
      // 分支
      const nBr = rint(2, 4);
      for (let b = 0; b < nBr; b++) {
        const st = path[rint(Math.round(steps * 0.15), Math.round(steps * 0.85))];
        const dir = rnd(-Math.PI * 0.75, Math.PI * 0.75) + (vertical ? Math.PI / 2 : 0);
        const bl = span * rnd(0.14, 0.34);
        const br = [];
        for (let s = 0; s <= 26; s++) {
          const t = s / 26;
          br.push({ x: st.x + Math.cos(dir) * bl * t + gauss() * 1.6, y: st.y + Math.sin(dir) * bl * t + gauss() * 1.6, w: st.w * (1 - t * 0.7) });
        }
        stroke(br, 0.45, 200);
      }
      break;
    }
    case '渗漏水': {
      const cx = W / 2 + gauss() * W * 0.08, cy = H / 2 + gauss() * H * 0.06;
      const rx = W * rnd(0.28, 0.4), ry = H * rnd(0.3, 0.44);
      const wet = rnd(40, 82);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d = Math.pow((x - cx) / rx, 2) + Math.pow((y - cy) / ry, 2);
        if (d > 1.35) continue;
        // 底部偏湿更暗（重力渗流感）
        const fall = clamp((y - cy) / ry, -1, 1);
        const e = 1 - d;                       // 中心→边缘衰减
        const a = Math.max(0, Math.min(1, e * 1.15)) * 235;
        const g = clamp(wet + fall * rnd(8, 22) + gauss() * 4, 10, 120);
        put(x, y, a * rnd(0.75, 1.0), g);
      }
      // 渗流痕迹（竖向细流）
      const trailX = cx + rnd(-rx * 0.4, rx * 0.4);
      for (let y = Math.round(cy); y < H; y++) {
        const x = trailX + gauss() * 2.6;
        put(x, y, rnd(60, 150), wet + 6);
        put(x + 1, y, rnd(30, 90), wet + 10);
      }
      break;
    }
    case '剥落掉块': {
      // 不规则凹坑（多边形近似）：内部深浅起伏，边缘 8px 羽化 + 碎边亮点
      const nV = rint(7, 12);
      const cx = W / 2, cy = H / 2;
      const rr = Math.min(W, H) * rnd(0.28, 0.4);
      const pts = [];
      for (let i = 0; i < nV; i++) {
        const a = (i / nV) * Math.PI * 2;
        const rad = rr * rnd(0.72, 1.15);
        pts.push([cx + Math.cos(a) * rad, cy + Math.sin(a) * rad]);
      }
      const inPoly = (px, py) => {
        let inside = false;
        for (let i = 0, j = nV - 1; i < nV; j = i++) {
          const xi = pts[i][0], yi = pts[i][1], xj = pts[j][0], yj = pts[j][1];
          if ((yi > py) !== (yj > py) && px < ((xj - xi) * (py - yi)) / (yj - yi) + xi) inside = !inside;
        }
        return inside;
      };
      const dep = rnd(26, 58);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        if (!inPoly(x, y)) continue;
        let edge = 1e9;
        for (let i = 0; i < nV; i++) {
          const j = (i + 1) % nV;
          const d = Math.abs((pts[j][1] - pts[i][1]) * x - (pts[j][0] - pts[i][0]) * y + pts[j][0] * pts[i][1] - pts[j][1] * pts[i][0])
            / Math.hypot(pts[j][0] - pts[i][0], pts[j][1] - pts[i][1]);
          edge = Math.min(edge, d);
        }
        const feather = clamp(edge / 9, 0, 1);                    // 边缘 9px 羽化
        const ring = edge < 4 ? rnd(24, 46) : 0;                  // 碎边微亮
        const g = clamp(dep + gauss() * 5 + (Math.random() < 0.06 ? rnd(30, 70) : 0) + ring, 10, 110);
        put(x, y, 248 * feather, g);
      }
      // 坑底骨料亮点
      for (let k = 0; k < nV * 5; k++) {
        const a = Math.random() * Math.PI * 2;
        const rad = rr * Math.sqrt(Math.random()) * 0.72;
        put(cx + Math.cos(a) * rad, cy + Math.sin(a) * rad, rnd(90, 180), rnd(88, 150));
      }
      break;
    }
    case '衬砌错台': {
      // 水平错动带：上/下两区错位 + 错台暗缝 + 混凝土破损纹理
      const ly = H * rnd(0.38, 0.62);
      const off = Math.min(W, H) * rnd(0.05, 0.13) * (level / 2);
      const bright = rnd(16, 40);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const above = y < ly;
        const shift = above ? 0 : off;
        const g = clamp(128 + (above ? -bright : bright) + gauss() * 3.4, 60, 205);
        put(clamp(x + gauss() * 1.1 - shift, 0, W - 1), y, 235, g);
      }
      // 错台缝（暗水平带）
      for (let x = 0; x < W; x++) {
        for (let k = 0; k < 5; k++) put(x, ly + k - 2, [255, 200, 90][k < 2 ? 1 : 0] || 200, dark());
      }
      break;
    }
    case '白华析出': {
      const cx = W / 2 + gauss() * W * 0.05, cy = H / 2 + gauss() * H * 0.05;
      const rx = W * rnd(0.22, 0.34), ry = H * rnd(0.24, 0.36);
      for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
        const d = Math.pow((x - cx) / rx, 2) + Math.pow((y - cy) / ry, 2);
        if (d > 1.15) continue;
        const e = 1 - d;
        const a = e * 210;
        const g = clamp(212 + e * 26 + gauss() * 4.4, 170, 252);
        put(x, y, a * rnd(0.8, 1.05), g);
      }
      // 流挂形态
      for (let y = Math.round(cy); y < H; y += rint(1, 3)) {
        for (let k = 0; k < 3; k++) {
          const x = cx + gauss() * rx * 0.5;
          put(x, y, rnd(60, 150), rnd(208, 244));
        }
      }
      break;
    }
    default: break;
  }
  return { rgba, alpha, w: W, h: H, class_name: kind, level: Math.max(1, Math.min(4, level)) };
}

/* ---------------- 组合：贴入画布 ---------------- */
/**
 * 计算 alpha>40 的紧致包围盒（相对 patch 坐标）；无前景返回 null。
 * 用途：placed 记录缺陷实际可见范围（而非整块素材矩形），供标注/回放更精确。
 */
function tightBox(alpha, w, h) {
  let minX = w, minY = h, maxX = -1, maxY = -1;
  for (let y = 0; y < h; y++) {
    for (let x = 0; x < w; x++) {
      if (alpha[y * w + x] > 40) {
        if (x < minX) minX = x; if (x > maxX) maxX = x;
        if (y < minY) minY = y; if (y > maxY) maxY = y;
      }
    }
  }
  return maxX < 0 ? null : { x: minX, y: minY, w: maxX - minX + 1, h: maxY - minY + 1 };
}

/** 将 patch(RGB+alpha) 画到 bg RGBA（alpha 合成），记录放置框 */
function pastePatch(bg, bW, bH, px, py, patch) {
  const { rgb, alpha, w, h } = patch;
  for (let y = 0; y < h; y++) {
    const yy = py + y;
    if (yy < 0 || yy >= bH) continue;
    for (let x = 0; x < w; x++) {
      const xx = px + x;
      if (xx < 0 || xx >= bW) continue;
      const a = alpha[y * w + x];
      if (a <= 2) continue;
      const t = a / 255;
      const o = (yy * bW + xx) * 4;
      bg.rgba[o] = Math.round(rgb[(y * w + x) * 3] * t + bg.rgba[o] * (1 - t));
      bg.rgba[o + 1] = Math.round(rgb[(y * w + x) * 3 + 1] * t + bg.rgba[o + 1] * (1 - t));
      bg.rgba[o + 2] = Math.round(rgb[(y * w + x) * 3 + 2] * t + bg.rgba[o + 2] * (1 - t));
    }
  }
}

/* ---------------- 合成编排 ---------------- */
/**
 * 从素材池随机取 1~3 个缺陷 patch，执行完整扰动管线后贴入背景
 * 输入 canvases: 背景 {rgba,w,h}; defectsPatches: [{rgba,alpha,w,h,class_name,level}]
 */
function composeOne(bg, defectPatches) {
  const bW = bg.w, bH = bg.h;
  const placed = [];                       // [{x,y,w,h,class_name,level}]
  const nPick = rint(1, Math.min(3, defectPatches.length));
  const picked = [...defectPatches].sort(() => Math.random() - 0.5).slice(0, nPick);
  for (const src of picked) {
    // 1) 缩放（等级越高体积越大）
    const lvlF = 0.8 + (src.level || 2) * 0.14;
    const scale = rnd(0.8, 1.3) * lvlF;
    let pw = Math.round(src.w * scale), ph = Math.round(src.h * scale);
    pw = Math.min(pw, Math.round(bW * 0.55)); ph = Math.min(ph, Math.round(bH * 0.6));
    let cur = resizeRgba(src.rgba, src.alpha, src.w, src.h, Math.max(8, pw), Math.max(8, ph));
    if (!cur) continue;
    // 2) 透视微变换：±5° + 微错切
    cur = warpAffine(cur.rgba, cur.alpha, cur.w, cur.h, rnd(-5, 5), rnd(-0.035, 0.035));
    // 3) 光度扰动（亮度/对比/伽马/模糊）→ RGB patch
    const pert = photoPerturb({ rgba: cur.rgba, alpha: cur.alpha, w: cur.w, h: cur.h });
    // 4) 羽化柔边（单次 box 模糊，保留裂缝锐度）
    const alpha = blurAlpha(pert.alpha, pert.w, pert.h);
    // 5) 找不重叠放置位（最多 60 次尝试）
    let px = 0, py = 0, ok = false;
    for (let t = 0; t < 60 && !ok; t++) {
      px = rint(Math.round(-pert.w * 0.08), bW - Math.round(pert.w * 0.72));
      py = rint(Math.round(-pert.h * 0.08), bH - Math.round(pert.h * 0.72));
      ok = true;
      const ix = clamp(px, 0, bW), iy = clamp(py, 0, bH);
      const ix2 = clamp(px + pert.w, 0, bW), iy2 = clamp(py + pert.h, 0, bH);
      for (const p of placed) {
        const ox = Math.max(0, Math.min(ix2, p.x + p.w) - Math.max(ix, p.x));
        const oy = Math.max(0, Math.min(iy2, p.y + p.h) - Math.max(iy, p.y));
        const area = Math.max(1, ix2 - ix) * Math.max(1, iy2 - iy);
        if (ox * oy > area * 0.22) { ok = false; break; }
      }
    }
    const finalPatch = { rgb: pert.rgb, alpha, w: pert.w, h: pert.h };
    pastePatch(bg, bW, bH, px, py, finalPatch);
    // 记录缺陷实际可见范围的紧致框（alpha>40），越界部分自然收缩
    const tb = tightBox(alpha, pert.w, pert.h) || { x: 0, y: 0, w: pert.w, h: pert.h };
    placed.push({
      x: px + tb.x, y: py + tb.y, w: tb.w, h: tb.h,
      class_name: src.class_name, level: src.level,
    });
  }
  // 全图高斯噪声 σ=0.02（≈5/255）+ 轻微整体伽马
  const gs = 0.02 * 255;
  for (let i = 0; i < bW * bH; i++) {
    const o = i * 4;
    for (let c = 0; c < 3; c++) bg.rgba[o + c] = clamp(bg.rgba[o + c] + gauss() * gs, 0, 255);
    bg.rgba[o + 3] = 255;
  }
  return { placed };
}

/**
 * 批量合成主入口
 * @param {object} body
 *   { count=20, outWidth=512, outHeight=384,
 *     defects?:[{image:{dataUrl},bbox:[x,y,w,h],class_name,level}], // 已有标注素材（YOLO框裁剪）
 *     background?:{dataUrl} }
 * @returns {object} 批量结果与逐样本元数据（含合规标注 marker）
 */
function synthesize(body = {}) {
  const t0 = performance.now();
  const count = Math.max(1, Math.min(60, Math.round(Number(body.count) || 20)));
  const outW = Math.max(64, Math.min(1280, Math.round(Number(body.outWidth) || BG_W)));
  const outH = Math.max(64, Math.min(960, Math.round(Number(body.outHeight) || BG_H)));

  fs.mkdirSync(SYN_DIR, { recursive: true });

  // ---- 缺陷素材池 ----
  const pool = [];
  if (Array.isArray(body.defects) && body.defects.length) {
    for (const d of body.defects) {
      if (!d) continue;
      // level 支持 0/空 = 每张随机 1~4 级（前端“随机 1~4”选项）
      const lv = (d.level === 0 || d.level === '0' || d.level === null || d.level === undefined)
        ? rint(1, 4) : Math.max(1, Math.min(4, Math.round(Number(d.level) || 2)));
      if (d.image && d.image.dataUrl && Array.isArray(d.bbox) && d.bbox.length === 4) {
        // 已有标注素材：按 YOLO 框裁剪 → 边缘羽化
        const img = d.image.dataUrl;
        const b64 = img.includes(',') ? img.split(',')[1] : img;
        const dec = vision.decodePng(Buffer.from(b64, 'base64'));
        const cls = TYPE_ORDER.includes(d.class_name) ? d.class_name : '裂缝';
        const cropped = cropRgba(dec.rgba, dec.width, dec.height, d.bbox[0], d.bbox[1], d.bbox[2], d.bbox[3]);
        pool.push({ ...cropped, class_name: cls, level: lv });
      } else if (d.class_name && TYPE_ORDER.includes(d.class_name)) {
        // 指定类型的内置演示素材
        const demo = makeDemoDefect(d.class_name, lv);
        pool.push({ rgba: demo.rgba, alpha: demo.alpha, w: demo.w, h: demo.h, class_name: demo.class_name, level: lv });
      }
    }
  } else {
    // 内置演示素材（同样按框裁剪语义使用；合规标注见 SYN_NOTE）
    const kinds = [...TYPE_ORDER];
    for (let i = 0; i < 10; i++) {
      const kind = kinds[(Math.random() * kinds.length) | 0];
      const lv = rint(1, 4);
      const demo = makeDemoDefect(kind, lv);
      pool.push({ rgba: demo.rgba, alpha: demo.alpha, w: demo.w, h: demo.h, class_name: kind, level: lv });
    }
  }
  if (!pool.length) throw new Error('缺陷素材池为空');

  // ---- 背景准备（用户上传时解码一次，供全批复用裁块）----
  let bgSrc = null;
  if (body.background && body.background.dataUrl) {
    const b64 = body.background.dataUrl.includes(',') ? body.background.dataUrl.split(',')[1] : body.background.dataUrl;
    const dec = vision.decodePng(Buffer.from(b64, 'base64'));
    bgSrc = { rgba: dec.rgba, W: dec.width, H: dec.height };
  }

  // ---- 逐张合成 ----
  const seq0 = nextSeq();
  const out = [];
  for (let i = 0; i < count; i++) {
    const bg = makeBackground(bgSrc, outW, outH);
    const { placed } = composeOne(bg, pool);
    const main = [...placed].sort((a, b) => (b.w * b.h) - (a.w * a.h))[0] || placed[0] || { class_name: '裂缝', level: 2 };
    const seq = String(seq0 + i).padStart(4, '0');
    const fname = `sample_${seq}_${main.class_name}_${main.level}.jpg`;
    const fpath = path.join(SYN_DIR, fname);
    const rgbBuf = vision.rgbFromRgba(bg.rgba);
    fs.writeFileSync(fpath, jpeg.encodeJpeg(outW, outH, rgbBuf, 90));
    // 合成参数快照（逐缺陷扰动参数在此不回放级细分，保留批级与放置框）
    const params = {
      canvas: `${outW}x${outH}`,
      defects: placed.map((p) => ({ class_name: p.class_name, level: p.level, bbox: [p.x, p.y, p.w, p.h] })),
      bgSource: bgSrc ? 'user-upload' : 'procedural',
      marker: SYN_NOTE,
      ts: new Date().toISOString(),
    };
    const sampleId = db.insert('synthetic_sample', {
      source_bg: bgSrc ? 'user-upload' : 'procedural-bg(seed-random)',
      source_defect: placed.map((p) => `${p.class_name}(${p.level}级)`).join(';') || '-',
      params: JSON.stringify(params),
      output_path: fpath,
    });
    db.insert('image', {
      source: 'synthetic', capture_time: new Date().toISOString(),
      image_path: path.relative(path.join(__dirname, 'data'), fpath),
    });
    out.push({
      sample_id: sampleId, file: `synthetic/${fname}`, name: fname,
      class_name: main.class_name, level: main.level, width: outW, height: outH,
      defectCount: placed.length, marker: SYN_NOTE,
      params: params,
    });
  }
  return {
    batch: { count, dir: 'data/synthetic', marker: SYN_NOTE, elapsedMs: Math.round(performance.now() - t0) },
    generated: out,
  };
}

/** 样本序号游标（读目录现有最大序号） */
function nextSeq() {
  if (!fs.existsSync(SYN_DIR)) return 1;
  let max = 0;
  for (const f of fs.readdirSync(SYN_DIR)) {
    const m = /^sample_(\d+)_/.exec(f);
    if (m) max = Math.max(max, Number(m[1]));
  }
  return max + 1;
}

/**
 * 分页浏览合成样本库（元数据；前端用 /synthetic/xx.jpg 直接加载图像）
 * @param {object} q {page=1,size=12}
 * @returns {object} {total,page,size,pages,items}
 */
function listLibrary(q = {}) {
  const page = Math.max(1, Math.round(Number(q.page) || 1));
  const size = Math.max(1, Math.min(60, Math.round(Number(q.size) || 12)));
  const rows = db.all('SELECT * FROM synthetic_sample ORDER BY sample_id DESC LIMIT ? OFFSET ?', size, (page - 1) * size);
  const total = Number(db.get('SELECT COUNT(*) n FROM synthetic_sample').n);
  const items = rows.map((r) => {
    const base = path.basename(r.output_path || '');
    const params = (() => { try { return JSON.parse(r.params || '{}'); } catch (e) { return {}; } })();
    const cls = /_([^_]+)_(\d+)\.jpg$/.exec(base);
    return {
      sample_id: r.sample_id, name: base,
      file: 'synthetic/' + base,
      class_name: cls ? cls[1] : (params.defects || [])[0]?.class_name || '?',
      level: cls ? Number(cls[2]) : (params.defects || [])[0]?.level || null,
      defectCount: (params.defects || []).length,
      source_bg: r.source_bg, source_defect: r.source_defect,
      marker: SYN_NOTE, createdAt: params.ts || '',
    };
  });
  return { total, page, size, pages: Math.ceil(total / size), items };
}

module.exports = { synthesize, listLibrary, SYN_DIR, SYN_NOTE, makeDemoDefect, makeBackground, composeOne, TYPE_ORDER };
