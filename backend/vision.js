/**
 * vision.js — 纯 JS 参数化图像预处理管线（零第三方依赖）
 *
 * 背景：系统弱光预处理流水线（计划书 §3.5）原实现于前端 Canvas（frontend/app.js：
 * CLAHE → 高斯滤波 → Sobel/Canny 梯度 → Otsu 分割 + 网格 ROI 提取）。
 * 教学科研平台要求后端也能独立接收图像并回传各级中间产物，故本模块用纯 JS
 * （Uint8/Float32 + node:zlib）将其 1:1 移植并参数化，默认值与前端常量完全一致：
 *
 *   参数                    默认值     语义（默认值 = 前端当前使用值）
 *   claheClipLimit          2.0        CLAHE 对比度限幅
 *   claheTileGridSize       8          CLAHE 分块网格 8×8
 *   gaussianKernelSize      5         高斯核尺寸（奇数，5≈前端 [1,4,6,4,1]/16, σ≈1）
 *   cannyThreshold          70         梯度边缘阈值（前端 Sobel 阈值 GRAD_TH=70）
 *   otsuEnabled             true       Otsu 自动分割开关（关闭时退回 均值×0.7）
 *
 * 本模块输入/输出（关键函数）：
 *   decodePng(buf)      -> {width,height,rgba}         PNG(BMP8 非隔行)解码
 *   encodePngGray(w,h,u8)-> Buffer                      灰度 PNG 编码
 *   encodePngRGB(w,h,u8) -> Buffer                      RGB PNG 编码
 *   downscaleRGBA(rgba,w,h,maxDim)->{data,width,height} 等比缩小
 *   toGray(rgba,w,h)    -> Float32Array                 灰度化(0.299/0.587/0.114)
 *   otsuThreshold(v,len)-> number                        Otsu 自动阈值
 *   claheEnhance(gray,w,h,clip,tile)->Float32Array       CLAHE 增强
 *   gaussianBlur(gray,w,h,k)->Float32Array              可分离高斯（二项式核）
 *   sobelGradient(gray,w,h)->Float32Array               Sobel 梯度幅值
 *   analyzeImage(rgba,w,h,params)->{rois,sensors,maps}   完整图像分析（含中间产物）
 *
 * 参考算法实现与 frontend/app.js 中 clahe/gaussian5/otsu/detectRois 一一对应。
 */
const zlib = require('zlib');

/* ---------------- 与前端一致的默认参数与常量 ---------------- */
const DEFAULTS = Object.freeze({
  claheClipLimit: 2.0,
  claheTileGridSize: 8,
  gaussianKernelSize: 5,
  cannyThreshold: 70,
  otsuEnabled: true,
  normMode: 'legacy',    // P0-2：'legacy'=常数放大截断（默认，行为不变）；'percentile'=P95 分位数自适应
  multiScale: false,     // P0-1：true=粗(12,3)+细(6,2)双尺度并联候选（默认关，收益验证后翻转）
});
const CELL = 12;          // 分析网格尺寸 px（与前端一致；多尺度模式下为粗尺度）
const FINE_CELL = 6;      // 多尺度：细分析网格 px（P0-1，仅 multiScale=true 时启用）
const BRIGHT_FACT = 1.25; // 高亮判系数（白华析出，与前端一致）
const ACT_EDGE = 0.22;    // 候选激活：边缘密度阈值
const ACT_DARK = 0.5;     // 候选激活：暗色占比阈值
const ACT_BRIGHT = 0.35;  // 候选激活：高亮占比阈值
const MIN_CLUSTER = 3;    // 连通域最小单元数（噪声滤除；多尺度细尺度用 2）
const MIN_SCORE = 0.42;   // ROI 最低判别得分

/* ---------------- 小工具 ---------------- */
const clamp01 = (x) => Math.max(0, Math.min(1, x));

/** 数组 P95 分位数（P0-2 分位数自适应归一化用；下限 1e-6 防除零） */
function p95(arr) {
  const s = Float32Array.from(arr).sort();
  const k = Math.min(s.length - 1, Math.floor(s.length * 0.95));
  return s[k] > 1e-6 ? s[k] : 1e-6;
}

/**
 * Sobel 梯度（x/y 分量版）：与 sobelGradient 同一差分公式，额外保留方向分量，
 * 供 textureEntropy（梯度方向直方图熵）与骨架法向探测使用。
 */
function sobelGradXY(gray, W, H) {
  const N = W * H;
  const gx = new Float32Array(N), gy = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      gx[i] = -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1] + gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
      gy[i] = -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1] + gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
    }
  }
  return { gx, gy };
}

/**
 * Zhang-Suen 细化（P1-1 组二：widthCv/skeletonCoverage 需要轻量骨架，不引入依赖）。
 * 输入 bin: Uint8Array（前景=1），原地迭代至无像素可删或达迭代上限（防大框超时）。
 */
function zhangSuenThin(bin, w, h, maxIter = 80) {
  let changed = true, it = 0;
  while (changed && it < maxIter) {
    changed = false; it++;
    for (const step of [0, 1]) {
      const del = [];
      for (let y = 1; y < h - 1; y++) {
        for (let x = 1; x < w - 1; x++) {
          const i = y * w + x;
          if (!bin[i]) continue;
          const P = [bin[i - w], bin[i - w + 1], bin[i + 1], bin[i + w + 1],
                     bin[i + w], bin[i + w - 1], bin[i - 1], bin[i - w - 1]];
          const B = P[0] + P[1] + P[2] + P[3] + P[4] + P[5] + P[6] + P[7];
          let A = 0;
          for (let k = 0; k < 8; k++) if (P[k] === 0 && P[(k + 1) % 8] === 1) A++;
          const c1 = step === 0 ? (P[0] * P[2] * P[4]) : (P[0] * P[2] * P[6]);
          const c2 = step === 0 ? (P[2] * P[4] * P[6]) : (P[0] * P[4] * P[6]);
          if (B >= 2 && B <= 6 && A === 1 && c1 === 0 && c2 === 0) del.push(i);
        }
      }
      if (del.length) { changed = true; for (const i of del) bin[i] = 0; }
    }
  }
  return bin;
}

/**
 * 灰度化：RGB -> 灰度（与前端 0.299/0.587/0.114 一致，输出 Float32Array 保精度）
 * 输入：rgba Uint8ClampedArray 长度 W*H*4
 * 输出：Float32Array 长度 W*H
 */
function toGray(rgba, W, H) {
  const N = W * H;
  const out = new Float32Array(N);
  for (let i = 0; i < N; i++) {
    out[i] = 0.299 * rgba[i * 4] + 0.587 * rgba[i * 4 + 1] + 0.114 * rgba[i * 4 + 2];
  }
  return out;
}

/**
 * Otsu 自动阈值（处理任意一维灰度数组，与前端 otsu() 一致）
 * 输入：灰度数组（Float32/Uint8）与长度
 * 输出：阈值 0~255
 */
function otsuThreshold(gray, len) {
  const hist = new Float32Array(256);
  for (let i = 0; i < len; i++) hist[gray[i] | 0]++;
  const total = len;
  let sum = 0;
  for (let i = 0; i < 256; i++) sum += i * hist[i];
  let sumB = 0, wB = 0, maxVar = 0, th = 128;
  for (let i = 0; i < 256; i++) {
    wB += hist[i];
    if (!wB) continue;
    const wF = total - wB;
    if (!wF) break;
    sumB += i * hist[i];
    const mB = sumB / wB, mF = (sum - sumB) / wF;
    const between = wB * wF * (mB - mF) * (mB - mF);
    if (between > maxVar) { maxVar = between; th = i; }
  }
  return th;
}

/**
 * CLAHE 限制对比度自适应直方图均衡（与前端 clahe() 同算法，参数化 clip/tile）
 * 输入：gray Float32Array、宽高、clipLimit(默认2.0)、tileGridSize(默认8)
 * 输出：增强后 Float32Array（0~255 量纲）
 */
function claheEnhance(gray, W, H, clipLimit = DEFAULTS.claheClipLimit, tileGridSize = DEFAULTS.claheTileGridSize) {
  const tw = Math.ceil(W / tileGridSize), th = Math.ceil(H / tileGridSize);
  const clip = clipLimit * (tw * th) / 256;
  const maps = [];
  for (let ty = 0; ty < tileGridSize; ty++) {
    for (let tx = 0; tx < tileGridSize; tx++) {
      const hist = new Float32Array(256);
      let cnt = 0;
      for (let y = ty * th; y < Math.min((ty + 1) * th, H); y++)
        for (let x = tx * tw; x < Math.min((tx + 1) * tw, W); x++) { hist[gray[y * W + x] | 0]++; cnt++; }
      let excess = 0;
      for (let i = 0; i < 256; i++) if (hist[i] > clip) { excess += hist[i] - clip; hist[i] = clip; }
      const bonus = excess / 256;
      const map = new Float32Array(256);
      let acc = 0;
      for (let i = 0; i < 256; i++) { acc += hist[i] + bonus; map[i] = acc / cnt * 255; }
      maps.push(map);
    }
  }
  const clampi = (v, a, b) => Math.max(a, Math.min(b, v));
  const out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    const fy = y / th - 0.5, ty0 = Math.floor(fy), wy = clampi(fy - ty0, 0, 1);
    const ty0c = clampi(ty0, 0, tileGridSize - 1), ty1c = clampi(ty0 + 1, 0, tileGridSize - 1);
    for (let x = 0; x < W; x++) {
      const fx = x / tw - 0.5, tx0 = Math.floor(fx), wx = clampi(fx - tx0, 0, 1);
      const tx0c = clampi(tx0, 0, tileGridSize - 1), tx1c = clampi(tx0 + 1, 0, tileGridSize - 1);
      const v = gray[y * W + x] | 0;
      const v00 = maps[ty0c * tileGridSize + tx0c][v], v01 = maps[ty0c * tileGridSize + tx1c][v];
      const v10 = maps[ty1c * tileGridSize + tx0c][v], v11 = maps[ty1c * tileGridSize + tx1c][v];
      out[y * W + x] = (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy;
    }
  }
  return out;
}

/** 生成 n 阶二项式行（做高斯核，n=kernelSize；n=5 得 [1,4,6,4,1]，σ≈1） */
function binomialRow(n) {
  let row = [1];
  for (let k = 1; k < n; k++) {
    const next = new Array(k + 1).fill(0);
    for (let i = 0; i < row.length; i++) { next[i] += row[i]; next[i + 1] += row[i]; }
    row = next;
  }
  const sum = row.reduce((a, b) => a + b, 0);
  return row.map((v) => v / sum);
}

/**
 * 可分离高斯滤波（与前端 gaussian5 同边界策略 clamp，核尺寸参数化，仅支持奇数 3/5/7/9）
 * 输入：gray Float32Array、宽高、kernelSize(默认5)
 * 输出：滤波后 Float32Array
 */
function gaussianBlur(gray, W, H, kernelSize = DEFAULTS.gaussianKernelSize) {
  const n = Math.max(3, Math.min(9, kernelSize | 1)); // 归一到奇数 [3,9]
  const k = binomialRow(n);
  const r = (n - 1) >> 1;
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += gray[y * W + Math.max(0, Math.min(W - 1, x + i))] * k[i + r];
      tmp[y * W + x] = acc;
    }
  }
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      let acc = 0;
      for (let i = -r; i <= r; i++) acc += tmp[Math.max(0, Math.min(H - 1, y + i)) * W + x] * k[i + r];
      out[y * W + x] = acc;
    }
  }
  return out;
}

/**
 * Sobel 梯度幅值（对应计划书 Canny 边缘检测环节；与前端一致）
 * 输入：gray Float32Array（建议为 CLAHE+高斯后图像）、宽高
 * 输出：梯度幅值 Float32Array（未阈值化，供后续 cannyThreshold 判定）
 */
function sobelGradient(gray, W, H) {
  const N = W * H;
  const grad = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1] + gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
      const gy = -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1] + gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }
  return grad;
}

/** 由 Float32 灰度生成 8bit 二值掩码（v < th -> 255 前景黑？约定：前景置 0，背景 255 便于直观显示） */
function thresholdMask8(gray, W, H, th, belowIsForeground = true) {
  const out = new Uint8Array(W * H);
  const N = W * H;
  for (let i = 0; i < N; i++) {
    const isFg = belowIsForeground ? gray[i] < th : gray[i] >= th;
    out[i] = isFg ? 0 : 255;
  }
  return out;
}

/**
 * 图像主分析入口：解码后的 RGBA 位图 -> 预处理中间产物 + ROI 候选 + 传感器估计
 * 输入：
 *   rgba   Uint8ClampedArray/Uint8Array RGBA 像素（W*H*4）
 *   W,H    图像宽高
 *   params 预处理参数（子集即可）：{claheClipLimit, claheTileGridSize, gaussianKernelSize,
 *          cannyThreshold, otsuEnabled}
 * 输出：
 *   {
 *     rois:   与 fusion/前端契约一致的候选区数组（bbox 归一化等）
 *     sensors:由图像全局统计模拟的传感器读数（缺省上报时使用）
 *     maps:   中间产物 { grayRaw(原图灰度), enhanced(CLAHE+高斯), grad, cannyMask,
 *              darkMask(Otsu), brightMask, activation(cw*ch 特征激活), W,H, darkThresh, rawMean }
 *   }
 */
function analyzeImage(rgba, W, H, params) {
  const p = { ...DEFAULTS, ...(params || {}) };
  const N = W * H;
  const raw = toGray(rgba, W, H);          // 原始灰度：保留明暗语义（暗渍/白华判别用原图）
  let sum = 0;
  for (let i = 0; i < N; i++) sum += raw[i];
  const rawMean = sum / N;

  // ④ Otsu 暗色分割阈值（基于原图）；otsuEnabled=false 时退化为 均值×0.7
  const otsuT = p.otsuEnabled ? otsuThreshold(raw, N) : rawMean * 0.7;
  const darkThresh = Math.min(otsuT, rawMean * 0.7);
  const brightThresh = rawMean * BRIGHT_FACT;

  // ① CLAHE 增强 → ② 高斯滤波（仅服务边缘/纹理，避免均衡化破坏明暗语义——前端同款解耦设计）
  const claheOut = claheEnhance(raw, W, H, p.claheClipLimit, p.claheTileGridSize); // 纯 CLAHE 中间产物
  const enhanced = gaussianBlur(claheOut, W, H, p.gaussianKernelSize);
  // ③ Sobel 梯度（XY 分量一次求得：幅值服务边缘/激活，方向服务 textureEntropy 与骨架法向）
  const { gx, gy } = sobelGradXY(enhanced, W, H);
  const grad = new Float32Array(N);
  let gAll = 0;
  for (let i = 0; i < N; i++) { grad[i] = Math.sqrt(gx[i] * gx[i] + gy[i] * gy[i]); gAll += grad[i]; }
  // 全局统计（P1-1 组一：光照不变维度的分母）
  let vAll = 0;
  for (let i = 0; i < N; i++) vAll += (raw[i] - rawMean) * (raw[i] - rawMean);
  const gctx = {
    rawMean, globalStd: Math.sqrt(vAll / N), globalGradMean: gAll / N,
    darkThresh, brightThresh, gth: p.cannyThreshold, normMode: p.normMode,
  };

  // ---- 网格候选提取：粗尺度（默认路径，行为与原实现一致）----
  const coarse = gridPass(raw, enhanced, grad, gx, gy, W, H, p, CELL, MIN_CLUSTER, gctx);
  let rois;
  if (p.multiScale) {
    // P0-1：细尺度并联（6px 网格、最小 2 格）→ 跨尺度去重融合（细裂缝保底）
    const fine = gridPass(raw, enhanced, grad, gx, gy, W, H, p, FINE_CELL, 2, gctx);
    rois = fuseScales(coarse.rois, fine.rois, W, H);
  } else {
    rois = coarse.rois.map((r) => ({
      ...r,
      scaleConsistency: 0.5,               // 未启用多尺度：中性值
      multiScaleElongation: r.elongation,  // 退化为单尺度细长比
    }));
  }

  // 传感器估计（镜像前端 sensorsFromCanvas：湿度↔暗色占比、温度↔亮度）
  const sensors = estimateSensors(raw, N);
  return {
    rois,
    sensors,
    maps: {
      grayRaw: raw, clahe: claheOut, enhanced, grad, W, H,
      cannyMask: thresholdMask8(grad, W, H, p.cannyThreshold, false), // 前景(边缘)置 0，白底黑边直观
      darkMask: thresholdMask8(raw, W, H, darkThresh),   // 暗色前景
      activation: coarse.cellAct, cw: coarse.cw, ch: coarse.ch,
      // 模块一：网格级特征通道图 A_k（k=边缘/暗色/高亮/纹理），供
      // Grad-CAM/Eigen-CAM 热力图按通道加权组合（channels.edge 等各为 cw*ch 的 0~1 归一数组）
      channels: { edge: coarse.cellEdge, dark: coarse.cellDark, bright: coarse.cellBright, tex: coarse.cellTex },
      darkThresh, brightThresh, rawMean,
    },
  };
}

/**
 * 单尺度网格候选提取（P0-1 重构：粗/细两尺度共用同一实现）
 * 与原 analyzeImage 内联实现逐行同构：网格统计 → 激活 → 8 邻域连通域 → PCA 形态
 * → 特征归一化（legacy 常数 / percentile P95）→ 光照不变/裂缝专属/孔洞/多尺度新维度
 * @returns {{rois:Array, cellEdge:Float32Array, cellDark, cellBright, cellTex, cellAct, cw, ch}}
 */
function gridPass(raw, enhanced, grad, gx, gy, W, H, p, cell, minCluster, gctx) {
  const cw = Math.max(1, Math.floor(W / cell)), ch = Math.max(1, Math.floor(H / cell));
  const cellEdge = new Float32Array(cw * ch), cellDark = new Float32Array(cw * ch);
  const cellTex = new Float32Array(cw * ch), cellBright = new Float32Array(cw * ch);
  const cellAct = new Float32Array(cw * ch); // 特征激活强度（供特征图中间产物）
  const gth = gctx.gth;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let e = 0, d = 0, b = 0, g = 0, n = 0;
      for (let y = cy * cell; y < Math.min((cy + 1) * cell, H); y++) {
        for (let x = cx * cell; x < Math.min((cx + 1) * cell, W); x++) {
          const i = y * W + x;
          if (grad[i] > gth) e++;   // 边缘密度：基于 CLAHE 增强图梯度（阈值参数化）
          if (raw[i] < gctx.darkThresh) d++;     // 暗色湿渍：基于原图 Otsu 阈值
          if (raw[i] > gctx.brightThresh) b++;   // 高亮白华：基于原图相对阈值
          g += grad[i]; n++;
        }
      }
      const k = cy * cw + cx;
      cellEdge[k] = e / n; cellDark[k] = d / n;
      cellBright[k] = b / n; cellTex[k] = g / n / 255;
      cellAct[k] = Math.max(cellEdge[k], cellDark[k], cellBright[k], cellTex[k]);
    }
  }
  // P0-2 分位数自适应归一化：以全图网格分布的 P95 为尺度基准（对离群格稳健）
  const P95 = gctx.normMode === 'percentile'
    ? { edge: p95(cellEdge), dark: p95(cellDark), bright: p95(cellBright), tex: p95(cellTex) }
    : null;

  // ---- 候选激活 + 8 邻域连通域聚类（镜像前端 detectRois）----
  const active = new Uint8Array(cw * ch);
  for (let k = 0; k < cw * ch; k++) {
    if (cellEdge[k] > ACT_EDGE || cellDark[k] > ACT_DARK || cellBright[k] > ACT_BRIGHT) active[k] = 1;
  }
  const seen = new Uint8Array(cw * ch);
  const rois = [];
  for (let k0 = 0; k0 < cw * ch; k0++) {
    if (!active[k0] || seen[k0]) continue;
    const q = [k0]; seen[k0] = 1;
    const cells = [];
    while (q.length) {
      const k = q.pop();
      cells.push(k);
      const cx = k % cw, cy = (k / cw) | 0;
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [1, -1], [-1, 1], [-1, -1]]) {
        const nx = cx + dx, ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= cw || ny >= ch) continue;
        const nk = ny * cw + nx;
        if (active[nk] && !seen[nk]) { seen[nk] = 1; q.push(nk); }
      }
    }
    if (cells.length < minCluster) continue; // 噪声滤除

    // 聚类统计 + PCA 形态分析（细长比/直线性/走向/填充率）
    let eSum = 0, dSum = 0, bSum = 0, tSum = 0, mx = 0, my = 0;
    for (const k of cells) {
      eSum += cellEdge[k]; dSum += cellDark[k]; bSum += cellBright[k]; tSum += cellTex[k];
      mx += (k % cw) + 0.5; my += ((k / cw) | 0) + 0.5;
    }
    const n = cells.length;
    mx /= n; my /= n;
    let xx = 0, yy = 0, xy = 0;
    let minX = cw, maxX = -1, minY = ch, maxY = -1;
    for (const k of cells) {
      const cx = (k % cw) + 0.5 - mx, cy = ((k / cw) | 0) + 0.5 - my;
      xx += cx * cx; yy += cy * cy; xy += cx * cy;
      minX = Math.min(minX, k % cw); maxX = Math.max(maxX, k % cw);
      minY = Math.min(minY, (k / cw) | 0); maxY = Math.max(maxY, (k / cw) | 0);
    }
    xx /= n; yy /= n; xy /= n;
    const tr = xx + yy, det = xx * yy - xy * xy;
    const disc = Math.max(0, tr * tr / 4 - det);
    const l1 = tr / 2 + Math.sqrt(disc), l2 = Math.max(tr / 2 - Math.sqrt(disc), 1e-4);
    const elongation = Math.min(20, Math.sqrt(l1 / l2));   // 细长比
    const linearity = Math.min(1, l1 / (l1 + l2));         // 直线性（各向异性）
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);
    const axisV = Math.abs(Math.sin(theta)) >= Math.abs(Math.cos(theta));
    const orientation = linearity >= 0.7 ? (axisV ? 'vertical' : 'horizontal') : 'diagonal';
    const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
    const fillRatio = n / (bboxW * bboxH);

    const bx = minX * cell, by = minY * cell;
    const bw = Math.min(W - bx, bboxW * cell), bh = Math.min(H - by, bboxH * cell);
    // P0-2：legacy=常数放大截断（原实现）；percentile=除以全图 P95（尺度无关相对量）
    let edgeDensity, darkRatio, brightRatio, textureVar;
    if (P95) {
      edgeDensity = clamp01((eSum / n) / P95.edge);
      darkRatio = clamp01((dSum / n) / P95.dark);
      brightRatio = clamp01((bSum / n) / P95.bright);
      textureVar = clamp01((tSum / n) / P95.tex);
    } else {
      edgeDensity = Math.min(1, (eSum / n) * 1.6);
      darkRatio = Math.min(1, (dSum / n) * 1.3);
      brightRatio = Math.min(1, (bSum / n) * 1.4);
      textureVar = Math.min(1, (tSum / n) * 1.6);
    }
    const score = Math.max(edgeDensity, darkRatio, brightRatio, textureVar);
    if (score < MIN_SCORE) continue;

    // 区域平均亮度相对全图 -> 色度偏移代理（暗→负，亮→正）
    let bSum2 = 0, bn = 0;
    for (let y = by; y < by + bh; y += 2) for (let x = bx; x < bx + bw; x += 2) { bSum2 += raw[y * W + x]; bn++; }
    const hueShift = Math.max(-0.6, Math.min(0.6, (bSum2 / bn - gctx.rawMean) / gctx.rawMean));

    // 环向角度：图幅中心为断面圆心，上=拱顶 0°，顺时针
    const ccx = bx + bw / 2 - W / 2, ccy = by + bh / 2 - H / 2;
    const angle = ((Math.atan2(ccx, -ccy) * 180 / Math.PI) + 360) % 360;

    // P1-1 新增诊断维度（光照不变 / 裂缝专属 / 孔洞；多尺度两项由 fuseScales 回填）
    const dims = computeRoiDims(raw, grad, gx, gy, W, H, gctx, bx, by, bw, bh);

    rois.push({
      bbox: [+(bx / W).toFixed(3), +(by / H).toFixed(3), +(bw / W).toFixed(3), +(bh / H).toFixed(3)],
      angle: Math.round(angle),
      edgeDensity: +edgeDensity.toFixed(2),
      darkRatio: +darkRatio.toFixed(2),
      brightRatio: +brightRatio.toFixed(2),
      textureVar: +textureVar.toFixed(2),
      hueShift: +hueShift.toFixed(2),
      lengthPx: Math.round(Math.max(bw, bh)),
      widthPx: Math.round(Math.min(bw, bh)),
      elongation: +elongation.toFixed(2),
      fillRatio: +fillRatio.toFixed(2),
      linearity: +linearity.toFixed(2),
      orientation,
      // —— v2 特征集（P1-1）——
      localContrast: dims.localContrast,
      gradMeanRatio: dims.gradMeanRatio,
      textureEntropy: dims.textureEntropy,
      widthCv: dims.widthCv,
      skeletonCoverage: dims.skeletonCoverage,
      holeRatio: dims.holeRatio,
      scaleConsistency: 0.5,            // 多尺度开启时由 fuseScales 回填
      multiScaleElongation: +elongation.toFixed(2),
      fromFine: cell < CELL,            // 细尺度候选标记（fusion 门控放宽 + 置信度补偿）
    });
  }
  return { rois, cellEdge, cellDark, cellBright, cellTex, cellAct, cw, ch };
}

/**
 * P1-1 新维度计算（单个 ROI bbox 内，光照不变组 + 裂缝专属组 + 孔洞率）
 * @returns {{localContrast, gradMeanRatio, textureEntropy, widthCv, skeletonCoverage, holeRatio}}
 */
function computeRoiDims(raw, grad, gx, gy, W, H, gctx, bx, by, bw, bh) {
  const area = bw * bh;
  // —— 组一：光照不变维度 ——
  let s = 0, s2 = 0, gS = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const i = y * W + x;
      s += raw[i]; s2 += raw[i] * raw[i]; gS += grad[i];
    }
  }
  const mean = s / area;
  const roiStd = Math.sqrt(Math.max(0, s2 / area - mean * mean));
  const localContrast = clamp01(roiStd / Math.max(1e-6, gctx.globalStd));
  const gradMeanRatio = clamp01((gS / area) / Math.max(1e-6, gctx.globalGradMean));
  // 梯度方向直方图熵（8 bin，方向取模去符号；log2(8)=3 归一）
  const hist = new Float32Array(8);
  let hc = 0;
  for (let y = by; y < by + bh; y++) {
    for (let x = bx; x < bx + bw; x++) {
      const i = y * W + x;
      if (grad[i] > gctx.gth) {
        const ang = (Math.atan2(gy[i], gx[i]) + Math.PI) % Math.PI;
        hist[Math.min(7, (ang / Math.PI * 8) | 0)]++; hc++;
      }
    }
  }
  let H8 = 0;
  if (hc >= 8) {
    for (let b = 0; b < 8; b++) { const pb = hist[b] / hc; if (pb > 0) H8 -= pb * Math.log2(pb); }
  }
  const textureEntropy = hc >= 8 ? clamp01(H8 / 3) : 0.5; // 边缘像素过少 → 中性

  // —— 二值前景：bbox 内 Otsu，极性按环带反差择优（同 mask.js 口径）——
  const gray = (x, y) => raw[(by + y) * W + (bx + x)];
  const otsu = otsuThreshold(Array.from({ length: area }, (_, i) => gray(i % bw, (i / bw) | 0)), area);
  let ring = 0, ringN = 0;
  for (let y = 0; y < bh; y++) {
    for (let x = 0; x < bw; x++) {
      if (x < 2 || y < 2 || x >= bw - 2 || y >= bh - 2) { ring += gray(x, y); ringN++; }
    }
  }
  const ringMean = ringN ? ring / ringN : 128;
  let dMean = 0, dN = 0, brMean = 0, brN = 0;
  for (let i = 0; i < area; i++) {
    const v = gray(i % bw, (i / bw) | 0);
    if (v < otsu) { dMean += v; dN++; } else if (v > otsu) { brMean += v; brN++; }
  }
  const below = dN > 0 && (!brN || Math.abs(dMean / dN - ringMean) >= Math.abs(brMean / brN - ringMean));
  let fgN = 0;
  const fg = new Uint8Array(area);
  for (let i = 0; i < area; i++) {
    const v = gray(i % bw, (i / bw) | 0);
    const isFg = below ? v < otsu : v > otsu;
    if (isFg) { fg[i] = 1; fgN++; }
  }
  // 中性缺省（前景过少或 bbox 过大时跳过骨架，防超时）
  let widthCv = 0.5, skeletonCoverage = 0.5, holeRatio = 0;
  if (fgN >= 20 && area <= 80000) {
    // —— 组二：裂缝专属维度（Zhang-Suen 骨架 + 法向宽度序列）——
    const bin = Uint8Array.from(fg);
    zhangSuenThin(bin, bw, bh);
    const sk = [];
    for (let i = 0; i < area; i++) if (bin[i]) sk.push(i);
    skeletonCoverage = clamp01(sk.length / Math.max(1, fgN));
    if (sk.length >= 4) {
      const widths = [];
      for (const i of sk) {
        const sx = i % bw, sy = (i / bw) | 0;
        const gi = (by + sy) * W + (bx + sx);
        const gl = Math.max(1e-6, Math.sqrt(gx[gi] * gx[gi] + gy[gi] * gy[gi]));
        const nx = gx[gi] / gl, ny = gy[gi] / gl; // 梯度方向即法向
        let len = 1;
        for (const sgn of [1, -1]) {
          for (let t = 1; t < 32; t++) {
            const px = Math.round(sx + sgn * t * nx), py = Math.round(sy + sgn * t * ny);
            if (px < 0 || py < 0 || px >= bw || py >= bh || !fg[py * bw + px]) break;
            len++;
          }
        }
        widths.push(len);
      }
      const wm = widths.reduce((a, b) => a + b, 0) / widths.length;
      const wv = Math.sqrt(widths.reduce((a, b) => a + (b - wm) ** 2, 0) / widths.length);
      widthCv = clamp01(wv / Math.max(1e-6, wm));
    }
    // —— 组三：孔洞率（背景孔洞面积 / bbox 面积；边界连通背景洪泛后剩余即孔洞）——
    const lab = new Uint8Array(area); // 0=未访问, 1=前景, 2=边界连通背景
    for (let i = 0; i < area; i++) lab[i] = fg[i] ? 1 : 0;
    const stack = [];
    for (let x = 0; x < bw; x++) { stack.push(x, (bh - 1) * bw + x); }
    for (let y = 0; y < bh; y++) { stack.push(y * bw, y * bw + bw - 1); }
    while (stack.length) {
      const i = stack.pop();
      if (i < 0 || i >= area || lab[i] !== 0) continue;
      lab[i] = 2;
      const x = i % bw, y = (i / bw) | 0;
      if (x > 0) stack.push(i - 1);
      if (x < bw - 1) stack.push(i + 1);
      if (y > 0) stack.push(i - bw);
      if (y < bh - 1) stack.push(i + bw);
    }
    let holes = 0;
    for (let i = 0; i < area; i++) if (lab[i] === 0) holes++;
    holeRatio = clamp01(holes / area);
  }
  const r3 = (v) => +v.toFixed(3);
  return { localContrast: r3(localContrast), gradMeanRatio: r3(gradMeanRatio), textureEntropy: r3(textureEntropy), widthCv: r3(widthCv), skeletonCoverage: r3(skeletonCoverage), holeRatio: r3(holeRatio) };
}

/** 归一化框并集（P0-1 跨尺度融合） */
function unionBox(a, b) {
  const x0 = Math.min(a[0], b[0]), y0 = Math.min(a[1], b[1]);
  const x1 = Math.max(a[0] + a[2], b[0] + b[2]), y1 = Math.max(a[1] + a[3], b[1] + b[3]);
  return [x0, y0, x1 - x0, y1 - y0];
}

/** 跨尺度特征加权平均字段（细尺度权重 0.6，定位更准） */
const MERGE_FIELDS = ['edgeDensity', 'darkRatio', 'brightRatio', 'textureVar', 'hueShift',
  'elongation', 'fillRatio', 'linearity', 'localContrast', 'gradMeanRatio',
  'textureEntropy', 'widthCv', 'skeletonCoverage', 'holeRatio'];

/**
 * P0-1 跨尺度去重融合：细尺度候选与粗尺度中心距 < 2 细格 → 视为同一目标，
 * 取并集框 + 特征加权平均；未匹配的细尺度候选保留（fromFine，fusion 端门控放宽 + 置信度补偿）。
 */
function fuseScales(coarse, fine, W, H) {
  const out = coarse.map((r) => ({ ...r }));
  const near = (2 * FINE_CELL) / Math.max(W, H);
  for (const f of fine) {
    const fcx = f.bbox[0] + f.bbox[2] / 2, fcy = f.bbox[1] + f.bbox[3] / 2;
    let hit = null, hd = Infinity;
    for (const c of out) {
      const dx = c.bbox[0] + c.bbox[2] / 2 - fcx, dy = c.bbox[1] + c.bbox[3] / 2 - fcy;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < near && d < hd) { hd = d; hit = c; }
    }
    if (hit) {
      hit.bbox = unionBox(hit.bbox, f.bbox).map((v) => +v.toFixed(3));
      for (const k of MERGE_FIELDS) {
        if (typeof hit[k] === 'number' && typeof f[k] === 'number') hit[k] = +(hit[k] * 0.4 + f[k] * 0.6).toFixed(3);
      }
      hit.lengthPx = Math.round(Math.max(hit.bbox[2] * W, hit.bbox[3] * H));
      hit.widthPx = Math.round(Math.min(hit.bbox[2] * W, hit.bbox[3] * H));
      hit.multiScaleElongation = +Math.max(hit.elongation, f.elongation).toFixed(2);
      const oriAgree = hit.orientation === f.orientation ? 1
        : (hit.orientation === 'diagonal' || f.orientation === 'diagonal' ? 0.5 : 0);
      hit.scaleConsistency = +(0.5 + 0.5 * oriAgree).toFixed(2);
      hit.multiScaleHit = true;
    } else {
      out.push({ ...f, fromFine: true, scaleConsistency: 0, multiScaleElongation: f.elongation });
    }
  }
  return out;
}

/**
 * CNN 候选特征补齐（P3 双通道：detector 给出 bbox/类别先验，本函数在框内复用
 * 现有 analyzeImage 管线补齐形态学特征，使 CNN 候选与网格候选共用同一 fusion 契约）
 * @param {Uint8Array|Buffer} rgba 全图 RGBA
 * @param {Array} roisIn detector.detect 输出（bbox 归一化 + clsHint/clsScore）
 * @param {object} params 预处理参数（与 detectImage 相同）
 * @returns {Array} 特征补齐后的 ROI 数组（契约与网格候选一致）
 */
function enrichRois(rgba, W, H, roisIn, params) {
  const p = { ...DEFAULTS, ...(params || {}) };
  return roisIn.map((roi) => {
    try {
      const x0 = Math.max(0, Math.floor(roi.bbox[0] * W)), y0 = Math.max(0, Math.floor(roi.bbox[1] * H));
      const x1 = Math.min(W, Math.ceil((roi.bbox[0] + roi.bbox[2]) * W)), y1 = Math.min(H, Math.ceil((roi.bbox[1] + roi.bbox[3]) * H));
      const cw = x1 - x0, chh = y1 - y0;
      if (cw < 16 || chh < 16) return roi;
      const crop = new Uint8Array(cw * chh * 4);
      for (let y = 0; y < chh; y++) {
        for (let x = 0; x < cw; x++) {
          const si = ((y0 + y) * W + (x0 + x)) * 4, di = (y * cw + x) * 4;
          crop[di] = rgba[si]; crop[di + 1] = rgba[si + 1]; crop[di + 2] = rgba[si + 2]; crop[di + 3] = rgba[si + 3];
        }
      }
      const feats = analyzeImage(crop, cw, chh, { ...p, multiScale: false });
      if (!feats.rois.length) return roi;
      // 取激活最强的簇作为该框特征来源
      const best = feats.rois.reduce((a, b) => {
        const sa = Math.max(a.edgeDensity, a.darkRatio, a.brightRatio, a.textureVar);
        const sb = Math.max(b.edgeDensity, b.darkRatio, b.brightRatio, b.textureVar);
        return sb > sa ? b : a;
      });
      // 环向角度按全局图幅中心重算（crop 内算出的角度基准是 crop 中心）
      const gcx = x0 + cw / 2 - W / 2, gcy = y0 + chh / 2 - H / 2;
      const angle = ((Math.atan2(gcx, -gcy) * 180 / Math.PI) + 360) % 360;
      return {
        ...roi,
        ...best,
        bbox: roi.bbox,           // CNN 框为定位权威，不被 crop 内聚类框覆盖
        angle: Math.round(angle),
        clsHint: roi.clsHint, clsScore: roi.clsScore,
      };
    } catch (e) {
      return roi; // 单框特征补齐失败不影响整体（fusion 端有缺省值兜底）
    }
  });
}

/**
 * 传感器估计：由画面全局统计映射湿度/温度/振动/断面差（缺省传感器上报时后端推算）
 * 输入：gray Float32Array、像素数 N
 * 输出：{humidity,temperature,vibration,gapmm}
 */
function estimateSensors(gray, N) {
  const step = 7; // 抽样子采样（与前端一致）
  const m = Math.ceil(N / step);
  const grays = new Float32Array(m);
  let sum = 0;
  for (let i = 0, k = 0; i < N; i += step, k++) { grays[k] = gray[i]; sum += gray[i]; }
  const mean = sum / m;
  const otsuT = Math.min(otsuThreshold(grays, m), mean * 0.8);
  let dark = 0;
  for (let k = 0; k < m; k++) if (grays[k] < otsuT) dark++;
  const darkRatio = dark / m;
  return {
    humidity: Math.round((52 + darkRatio * 45) * 10) / 10,
    temperature: Math.round((20 - darkRatio * 9) * 10) / 10,
    vibration: Math.round((0.05 + Math.random() * 0.3) * 100) / 100,
    gapmm: Math.round((0.2 + Math.random() * 2.3) * 10) / 10,
  };
}

/* ================= PNG 编解码（零依赖，8bit，非隔行） ================= */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(buf) {
  let c = 0xffffffff;
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(body), 0);
  return Buffer.concat([len, body, crc]);
}

/**
 * PNG 编码（支持 1 通道灰度 colorType0 / 3 通道 RGB colorType2）
 * 输入：w,h,channels(1|3),pixels(Uint8Array/Array,长度 w*h*channels)
 * 输出：PNG Buffer
 */
function encodePng(w, h, channels, pixels) {
  const colorType = channels === 1 ? 0 : 2;
  const bpp = channels; // 每像素字节数
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; ihdr[9] = colorType; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;
  // 每行前置滤波类型 0（None），简单且标准
  const stride = w * bpp + 1;
  const raw = Buffer.alloc(stride * h);
  for (let y = 0; y < h; y++) {
    raw[y * stride] = 0;
    Buffer.from(pixels.buffer, pixels.byteOffset + y * w * bpp, w * bpp).copy(raw, y * stride + 1);
  }
  const idat = zlib.deflateSync(raw, { level: 6 });
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', idat),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/** 灰度 PNG 编码（便捷封装） */
function encodePngGray(w, h, gray8) { return encodePng(w, h, 1, gray8); }
/** RGB PNG 编码（便捷封装：pixels 为 w*h*3 的 RGB 字节流） */
function encodePngRGB(w, h, rgb8) { return encodePng(w, h, 3, rgb8); }

/**
 * RGBA -> RGB 字节流（编码前转换）
 * @param {Buffer|Uint8Array} rgba 长度 w*h*4
 * @returns {Buffer} 长度 w*h*3
 */
function rgbFromRgba(rgba) {
  const n = rgba.length >> 2;
  const out = Buffer.alloc(n * 3);
  for (let i = 0; i < n; i++) {
    out[i * 3] = rgba[i * 4];
    out[i * 3 + 1] = rgba[i * 4 + 1];
    out[i * 3 + 2] = rgba[i * 4 + 2];
  }
  return out;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * PNG 解码（支持 8bit、非隔行、colorType 0/2/4/6）
 * 输入：PNG Buffer
 * 输出：{ width, height, rgba } rgba 为 RGBA 展开（W*H*4，alpha 缺省=255）
 */
function decodePng(buf) {
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (!buf.slice(0, 8).equals(sig)) throw new Error('PNG 解码失败：非 PNG 文件');
  let pos = 8;
  let width = 0, height = 0, colorType = 0, bitDepth = 8, interlace = 0;
  const idatParts = [];
  while (pos + 8 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.toString('ascii', pos + 4, pos + 8);
    const data = buf.slice(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0); height = data.readUInt32BE(4);
      bitDepth = data[8]; colorType = data[9]; interlace = data[12];
      if (bitDepth !== 8) throw new Error('PNG 解码失败：当前仅支持 8bit 位深，实际 ' + bitDepth);
      if (interlace !== 0) throw new Error('PNG 解码失败：暂不支持隔行(Adam7)PNG');
      if (![0, 2, 4, 6].includes(colorType)) throw new Error('PNG 解码失败：不支持的 colorType ' + colorType);
    } else if (type === 'IDAT') {
      idatParts.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }
  if (!width || !height) throw new Error('PNG 解码失败：缺少 IHDR');
  const comp = zlib.inflateSync(Buffer.concat(idatParts));
  const channels = colorType === 0 ? 1 : colorType === 2 ? 3 : colorType === 4 ? 2 : 4;
  const stride = width * channels;
  const out = Buffer.alloc(height * stride);
  for (let y = 0; y < height; y++) {
    const f = comp[y * (stride + 1)]; // 滤波类型
    const rowStart = y * stride;
    const prevStart = rowStart - stride;
    for (let i = 0; i < stride; i++) {
      const raw = comp[y * (stride + 1) + 1 + i];
      const a = i >= channels ? out[rowStart + i - channels] : 0;
      const b = y > 0 ? out[prevStart + i] : 0;
      const c = (y > 0 && i >= channels) ? out[prevStart + i - channels] : 0;
      let v = raw;
      if (f === 1) v = raw + a;          // Sub
      else if (f === 2) v = raw + b;     // Up
      else if (f === 3) v = raw + ((a + b) >> 1); // Average
      else if (f === 4) v = raw + paeth(a, b, c); // Paeth
      else if (f !== 0) throw new Error('PNG 解码失败：未知滤波类型 ' + f);
      out[rowStart + i] = v & 0xff;
    }
  }
  // 展开为 RGBA
  const rgba = Buffer.alloc(width * height * 4);
  for (let i = 0; i < width * height; i++) {
    const o = i * 4, s = i * channels;
    if (channels === 1) { rgba[o] = rgba[o + 1] = rgba[o + 2] = out[s]; rgba[o + 3] = 255; }
    else if (channels === 2) { rgba[o] = rgba[o + 1] = rgba[o + 2] = out[s]; rgba[o + 3] = out[s + 1]; }
    else if (channels === 3) { rgba[o] = out[s]; rgba[o + 1] = out[s + 1]; rgba[o + 2] = out[s + 2]; rgba[o + 3] = 255; }
    else { rgba[o] = out[s]; rgba[o + 1] = out[s + 1]; rgba[o + 2] = out[s + 2]; rgba[o + 3] = out[s + 3]; }
  }
  return { width, height, rgba };
}

/**
 * 双线性等比缩小（超过 maxDim 时执行，加速推理）
 * 输入：rgba、宽高、最大边
 * 输出：{ data, width, height }；未超限时原样返回
 */
function downscaleRGBA(rgba, W, H, maxDim = 640) {
  if (W <= maxDim && H <= maxDim) return { data: rgba, width: W, height: H };
  const scale = Math.min(1, maxDim / Math.max(W, H));
  const nw = Math.max(1, Math.round(W * scale)), nh = Math.max(1, Math.round(H * scale));
  const out = Buffer.alloc(nw * nh * 4);
  for (let y = 0; y < nh; y++) {
    const sy = (y + 0.5) / nh * H - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(H - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < nw; x++) {
      const sx = (x + 0.5) / nw * W - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(W - 1, x0 + 1);
      const wx = sx - x0;
      const o = (y * nw + x) * 4;
      for (let c = 0; c < 4; c++) {
        const v00 = rgba[(y0 * W + x0) * 4 + c], v01 = rgba[(y0 * W + x1) * 4 + c];
        const v10 = rgba[(y1 * W + x0) * 4 + c], v11 = rgba[(y1 * W + x1) * 4 + c];
        const top = v00 * (1 - wx) + v01 * wx;
        const bot = v10 * (1 - wx) + v11 * wx;
        out[o + c] = top * (1 - wy) + bot * wy;
      }
    }
  }
  return { data: out, width: nw, height: nh };
}

module.exports = {
  DEFAULTS, CELL, FINE_CELL, BRIGHT_FACT,
  decodePng, encodePng, encodePngGray, encodePngRGB, rgbFromRgba,
  downscaleRGBA, toGray, otsuThreshold, claheEnhance, gaussianBlur,
  sobelGradient, sobelGradXY, thresholdMask8, analyzeImage, estimateSensors,
  enrichRois, zhangSuenThin, p95, fuseScales,
};
