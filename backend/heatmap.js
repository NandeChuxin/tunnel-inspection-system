/**
 * heatmap.js — 模型判定依据热力图（模块一：可解释AI教学展示）
 *
 * 算法背景（计划书与需求对齐）：对输入图像推理时生成模型“判定依据”热力图，
 * 叠加到原图显示，让学生看到 AI“为什么”判为病害。提供两条实现，可配置切换：
 *
 *   1) Grad-CAM（主路线，需深度学习模型梯度）：
 *         h = ReLU( Σ_k w_k · A_k )
 *     其中 A_k 为 backbone 特征图通道（本引擎取 4 个网格级证据通道：
 *     边缘/暗色/高亮/纹理，即 vision.analyzeImage().maps.channels），
 *     w_k 为“目标类对第 k 通道的敏感度权重”。
 *     —— 真实 YOLOv8n 接入后，A_k 替换为 backbone 特征图、w_k 替换为
 *        类别 logit 对特征图的梯度全局平均池化（detector.js hook 预留），
 *        本模块接口不变、仅数据源切换。
 *   2) Eigen-CAM（备选路线，无梯度依赖，Grad-CAM 适配失败时自动回退）：
 *         h = Σ_k A_k / C   （C = 通道数，权重恒为 1/C）
 *
 * 展示链路：h 网格 → 归一化 0~1 → 双线性上采样到原图尺寸 →
 *          JET 伪彩(近似 OpenCV COLORMAP_JET) → 与原图 α=0.45 叠加。
 *
 * 【当前状态 2026-09 · 如实声明】默认实现为 **Eigen-CAM**（无梯度依赖）；
 *   Grad-CAM 形态为接口预留——仅当接入真实 CNN（backbone 特征图 + 类别 logit 梯度）
 *   后才有真梯度；当前 method='gradcam' 的通道权重为启发式设定，
 *   且结果中必带 fallbackReason 标注（前端状态行如实展示）。
 *
 * 零第三方依赖；输入/输出均为字节缓冲（纯 JS 位图）。
 */
const vision = require('./vision');

/* 通道顺序（与 vision.maps.channels 键一致，供权重数组对齐） */
const CH_ORDER = ['edge', 'dark', 'bright', 'tex'];
const OVERLAY_ALPHA = 0.45; // 与原图叠加透明度 α（需求规定）

/**
 * 目标病害类别 → 通道敏感度权重 w_k（k 顺序 = CH_ORDER）。
 * 语义：模拟 Grad-CAM 的“目标类在特征通道上的关注强度”。真实模型接入后
 * 此处替换为梯度全局平均池化结果（保留函数签名：w 为长度 4 数组）。
 */
function channelWeightsOf(defectType) {
  const w = {
    '裂缝':     [0.55, 0.04, 0.00, 0.12], // 主要看边缘线状结构
    '渗漏水':   [0.08, 0.60, 0.00, 0.06], // 主要看暗色湿渍
    '剥落掉块': [0.22, 0.10, 0.05, 0.55], // 主要看粗糙纹理
    '衬砌错台': [0.38, 0.06, 0.00, 0.14], // 光影突变边缘
    '白华析出': [0.05, 0.02, 0.60, 0.06], // 主要看高亮析出物
  };
  return (w[defectType] || [0.25, 0.25, 0.25, 0.25]).map(Number);
}

/** 线性插值 */
function lerp(a, b, t) { return a + (b - a) * t; }

/**
 * JET 伪彩（近似 OpenCV COLORMAP_JET）
 * 输入：t ∈ [0,1]
 * 输出：[r,g,b] ∈ [0,255] 整数
 */
function jetColor(t) {
  t = Math.max(0, Math.min(1, t));
  // OpenCV JET 关键色标（锚点）
  const anchors = [
    [0.0, 0, 0, 131], [0.125, 0, 0, 255], [0.375, 0, 255, 255],
    [0.625, 255, 255, 0], [0.875, 255, 0, 0], [1.0, 128, 0, 0],
  ];
  let i = 0;
  while (i < anchors.length - 2 && t > anchors[i + 1][0]) i++;
  const [t0, r0, g0, b0] = anchors[i];
  const [t1, r1, g1, b1] = anchors[i + 1];
  const f = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
  return [Math.round(lerp(r0, r1, f)), Math.round(lerp(g0, g1, f)), Math.round(lerp(b0, b1, f))];
}

/**
 * 归一化到 [0,1]（整体最大值为 1；全 0 时保持 0）
 * @param {Float32Array} h 长度 n
 * @returns {{v:Float32Array, max:number, min:number}}
 */
function normalize01(h) {
  const v = new Float32Array(h.length);
  let max = 0, min = Infinity;
  for (let i = 0; i < h.length; i++) { if (h[i] > max) max = h[i]; if (h[i] < min) min = h[i]; }
  if (max <= 0) return { v, max: 0, min: 0 };
  const span = max - min || max;
  for (let i = 0; i < h.length; i++) v[i] = Math.max(0, (h[i] - min) / span);
  return { v, max, min };
}

/**
 * Eigen-CAM：权重恒为 1/C 的通道平均
 * @param {object} ch 通道对象 {edge,dark,bright,tex}（各为 cw*ch Float32Array）
 * @param {number} cw,ch
 * @returns {Float32Array} h 网格（未归一化）
 */
function eigenCAM(chan, cw, ch) {
  const n = cw * ch;
  const keys = CH_ORDER;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (const k of keys) s += chan[k][i];
    h[i] = s / keys.length;
  }
  return h;
}

/**
 * Grad-CAM（形态实现）：ReLU(Σ_k w_k · A_k)
 * @param {object} chan 通道对象
 * @param {number} cw,ch
 * @param {Array<number>} w 通道权重（缺省按类别取）
 * @param {string|null} defectType 目标类（最高置信度检测的类别）
 * @returns {Float32Array} h 网格（ReLU 后未归一化）
 */
function gradCAM(chan, cw, ch, w, defectType) {
  const n = cw * ch;
  const ww = (w && w.length === 4 ? w : channelWeightsOf(defectType || null)).map(Number);
  const sum = ww.reduce((a, b) => a + b, 0) || 1;
  const h = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0;
    for (let k = 0; k < 4; k++) s += ww[k] * chan[CH_ORDER[k]][i];
    h[i] = Math.max(0, s / sum); // ReLU：负响应截断为 0
  }
  return h;
}

/**
 * 双线性上采样 归一化热力网格 -> JET 伪彩 RGB 位图
 * 输入：h01 Float32Array(cw*ch, 0~1)、cw/ch 网格维度、W/H 目标图像尺寸
 * 输出：{ rgb: Buffer(W*H*3), W, H, max, min }
 */
function heatToJetRGB(h01, cw, ch, W, H) {
  const rgb = Buffer.alloc(W * H * 3);
  for (let y = 0; y < H; y++) {
    const sy = ((y + 0.5) / H) * ch - 0.5;
    const y0 = Math.max(0, Math.floor(sy)), y1 = Math.min(ch - 1, y0 + 1);
    const wy = sy - y0;
    for (let x = 0; x < W; x++) {
      const sx = ((x + 0.5) / W) * cw - 0.5;
      const x0 = Math.max(0, Math.floor(sx)), x1 = Math.min(cw - 1, x0 + 1);
      const wx = sx - x0;
      const v00 = h01[y0 * cw + x0], v01 = h01[y0 * cw + x1];
      const v10 = h01[y1 * cw + x0], v11 = h01[y1 * cw + x1];
      const v = (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy;
      const [r, g, b] = jetColor(v);
      const o = (y * W + x) * 3;
      rgb[o] = r; rgb[o + 1] = g; rgb[o + 2] = b;
    }
  }
  return { rgb, W, H };
}

/**
 * 热力图叠加原图：out = heat*α + original*(1-α)（α=0.45，全图 addWeighted 语义）
 * @param {Buffer} rgba   原图 RGBA(W*H*4)
 * @param {Buffer} heatRGB  JET 伪彩 RGB(W*H*3)
 * @param {number} W,H
 * @returns {Buffer} 叠加后 RGBA（alpha=255）
 */
function overlayHeat(rgba, heatRGB, W, H, alpha = OVERLAY_ALPHA) {
  const a = Math.max(0, Math.min(1, alpha));
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const o = i * 4, h = i * 3;
    out[o] = Math.round(heatRGB[h] * a + rgba[o] * (1 - a));
    out[o + 1] = Math.round(heatRGB[h + 1] * a + rgba[o + 1] * (1 - a));
    out[o + 2] = Math.round(heatRGB[h + 2] * a + rgba[o + 2] * (1 - a));
    out[o + 3] = 255;
  }
  return out;
}

/**
 * 计算“热力图与检测框吻合度”统计（客观化“高亮区域与检测框位置吻合”的检查）
 * @param {Float32Array} h01 归一化热力网格
 * @param {number} cw,ch
 * @param {Array} bboxes 归一化 bbox [x,y,w,h] 列表
 * @returns {{inside:number, outside:number, ratio:number, nInside:number}}
 *          内部/外部平均热强度与比值（ratio>1 即热力倾向集中在框内）
 */
function overlapStats(h01, cw, ch, bboxes) {
  let inSum = 0, inN = 0, outSum = 0, outN = 0;
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      const x = cx / cw, y = cy / ch, w = 1 / cw, h = 1 / ch;
      let hit = false;
      for (const b of bboxes) {
        const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];
        if (x + w > bx1 && x < bx2 && y + h > by1 && y < by2) { hit = true; break; }
      }
      const v = h01[cy * cw + cx];
      if (hit) { inSum += v; inN++; } else { outSum += v; outN++; }
    }
  }
  const inside = inN ? inSum / inN : 0;
  const outside = outN ? outSum / outN : 0;
  return {
    inside: Math.round(inside * 1000) / 1000,
    outside: Math.round(outside * 1000) / 1000,
    ratio: outside > 0 ? Math.round((inside / outside) * 100) / 100 : (inside > 0 ? 99 : 0),
    nInside: inN,
  };
}

/**
 * P3-2 真 Grad-CAM 权重估计：数值梯度（有限差分）近似 w_k = ∂y^c/∂A^k 的全局平均池化。
 * 纯 JS 无自动微分，故对特征通道做扰动观察目标类 logit 变化率；
 * 为控制开销，只对 |w_k| 估计的 Top-N 通道计算（其余置零）——权重来自真实梯度而非
 * 硬编码常数表，名实相符。需 CNN 会话支持（forwardWithFeature 由 detector 侧提供）。
 * @param {Function} forwardWithFeature (Aplus:Float32Array) => Promise<Float32Array> 目标类 logits
 * @param {{data:Float32Array, dims:[number,number,number,number]}} A 中间特征图 [1,C,H,W]
 * @param {number} targetCls 目标类下标
 * @param {number} topN 只做差分的通道数上限（默认 16）
 * @returns {Promise<{w:Float32Array, topChannels:number[]}>}
 */
async function numericGradCAM(forwardWithFeature, A, targetCls, topN = 16) {
  const [, C, H, W2] = A.dims;
  const eps = 1e-3;
  const plane = H * W2;
  const yBase = await forwardWithFeature(A.data);
  // 一遍粗估：逐通道单点扰动（取每通道中心像素）做 |∂y/∂A| 排序，选 Top-N
  const est = [];
  for (let k = 0; k < C; k++) {
    const Aplus = Float32Array.from(A.data);
    const idx = k * plane + (plane >> 1);
    Aplus[idx] += eps;
    const yPlus = await forwardWithFeature(Aplus);
    est.push({ k, g: Math.abs((yPlus[targetCls] - yBase[targetCls]) / eps) });
  }
  const top = est.sort((a, b) => b.g - a.g).slice(0, topN).map((x) => x.k);
  // Top-N 通道全平面扰动求平均梯度
  const w = new Float32Array(C);
  for (const k of top) {
    const Aplus = Float32Array.from(A.data);
    for (let i = 0; i < plane; i++) Aplus[k * plane + i] += eps;
    const yPlus = await forwardWithFeature(Aplus);
    w[k] = (yPlus[targetCls] - yBase[targetCls]) / eps / plane;
  }
  return { w, topChannels: top };
}

/**
 * 由 CNN 特征图 + 梯度权重合成热力网格：h = ReLU( Σ_k w_k · A_k )（标准 Grad-CAM）
 * @param {{data:Float32Array, dims:[number,number,number,number]}} A
 * @param {Float32Array} w 通道权重（numericGradCAM 产出）
 * @returns {{grid:Float32Array, cw:number, ch:number}}
 */
function gradCAMFromFeature(A, w) {
  const [, C, H, W2] = A.dims;
  const grid = new Float32Array(H * W2);
  for (let k = 0; k < C; k++) {
    const wk = w[k];
    if (!wk) continue;
    for (let i = 0; i < H * W2; i++) grid[i] += wk * A.data[k * H * W2 + i];
  }
  for (let i = 0; i < grid.length; i++) grid[i] = Math.max(0, grid[i]); // 此处 ReLU 才有意义
  return { grid, cw: W2, ch: H };
}

/**
 * 模块一热力图总入口：给定网格级通道与目标类/权重，产出整幅伪彩 + 叠加
 * @param {object} opts { chan:{edge,dark,bright,tex}, cw, ch, W, H, rgba,
 *                        method:'auto'|'eigen'|'gradcam',
 *                        defectType|null, weights|null, modelGradAvailable:boolean,
 *                        featureGrid?, gradWeights? }   ← P3-2：CNN 特征图与梯度权重（可选）
 * @returns {{
 *   method:string, mode:'gradcam'|'eigen', targetClass:string|null,
 *   fallbackReason:string|null,
 *   grid:{w:Float32Array,max:number}, rgb:{Buffer,W,H},
 *   overlay:{Buffer,W,H}, overlap:object, alpha:number
 * }}
 */
function buildHeatmap(opts) {
  const { chan, cw, ch, W, H, rgba, method = 'auto', defectType = null, weights = null, modelGradAvailable = false,
          featureGrid = null, gradWeights = null } = opts;
  let mode = method;
  let fallbackReason = null;
  if (method === 'auto') {
    // 主路线 Grad-CAM：真实模型梯度可用则用；否则回退 Eigen-CAM（需求预设的适配失败回退）
    mode = modelGradAvailable ? 'gradcam' : 'eigen';
    if (!modelGradAvailable) fallbackReason = '当前 ONNX 检测图未暴露中间特征与类别梯度，auto 已回退 Eigen-CAM';
  } else if (method === 'gradcam' && !modelGradAvailable) {
    // 强制 Grad-CAM 但真实梯度不可用：回退 Eigen 并说明（需求：适配失败改用备选路线）
    mode = 'eigen';
    fallbackReason = 'Grad-CAM 适配失败（无模型梯度）：已按需求回退 Eigen-CAM；可配置切换 heatmapMethod';
  }
  let hGrid;
  if (mode === 'gradcam') {
    if (featureGrid && gradWeights) {
      // P3-2：权重来自数值梯度（numericGradCAM），特征来自 CNN 中间层 —— 名实相符
      const g = gradCAMFromFeature(featureGrid, gradWeights);
      hGrid = g.grid;
    } else if (weights) {
      // 显式传入权重（非硬编码常量表）时允许网格通道版 Grad-CAM
      hGrid = gradCAM(chan, cw, ch, weights, defectType);
    } else {
      // 名实相符门控：无梯度权重时绝不冒充 Grad-CAM
      mode = 'eigen';
      fallbackReason = 'Grad-CAM 需 CNN 特征图与梯度权重（featureGrid/gradWeights），当前缺失：已回退 Eigen-CAM';
      hGrid = eigenCAM(chan, cw, ch);
    }
  } else {
    hGrid = eigenCAM(chan, cw, ch);
  }
  const { v: h01, max } = normalize01(hGrid);
  const heatRGB = heatToJetRGB(h01, cw, ch, W, H).rgb;
  const ov = overlayHeat(rgba, heatRGB, W, H);
  const overlap = overlapStats(h01, cw, ch, opts.bboxes || []);
  return {
    method,           // 请求方法
    mode,             // 实际生效：gradcam | eigen
    targetClass: defectType,
    fallbackReason,
    gridMax: Math.round(max * 1000) / 1000,
    rgb: { data: heatRGB, W, H },
    overlay: { data: ov, W, H },
    overlap,
    alpha: OVERLAY_ALPHA,
  };
}

/** 便捷：由浮点灰度生成 RGBA 位图（vision 编码用） */
function grayToRGBA(grayFloat, W, H) {
  const out = Buffer.alloc(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    const v = Math.max(0, Math.min(255, grayFloat[i] | 0));
    out[i * 4] = v; out[i * 4 + 1] = v; out[i * 4 + 2] = v; out[i * 4 + 3] = 255;
  }
  return out;
}

module.exports = {
  CH_ORDER, OVERLAY_ALPHA,
  jetColor, channelWeightsOf, eigenCAM, gradCAM,
  numericGradCAM, gradCAMFromFeature,           // P3-2 真梯度 Grad-CAM（需 CNN 会话）
  normalize01, heatToJetRGB, overlayHeat, overlapStats, buildHeatmap, grayToRGBA,
};
