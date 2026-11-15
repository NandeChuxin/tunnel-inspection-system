/**
 * explain.js — 模块一「可解释AI教学展示」编排（零第三方依赖）
 *
 * 在 W0 推理管线（infer.js/vision.js/fusion.js）之上增量实现教学闭环：
 *   1. explainDetect(body)：一次请求完成
 *        · 4 步传统 CV 链路中间图：clahe / gaussian / canny / otsu（按步骤ID返回）
 *        · 热力图：Eigen-CAM / Grad-CAM（自动回退，见 heatmap.js）
 *        · 统一检测结果（复用 infer.mapDetection，与 /api/detect/image 口径一致）
 *        · 保存“会话态”（原始位图 + 每步浮点缓冲），供后续局部调参与导出
 *   2. updatePipeline(body)：左栏调参 → 按依赖只重算受影响步骤后缀，前序步骤
 *        PNG 字节不变（可验证“调参后只重跑受影响步骤，不做全链路重复推理”）
 *   3. exportLecture(taskId)：一键合成讲解图（原图+热力+检测框+类别/等级标注）
 *
 * 会话态内存上限 3 条（LRU 淘汰），单条 ≤640 边长位图 + 各阶段浮点缓冲。
 * 关键函数输入输出以中文注释标注。
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const vision = require('./vision');
const fusion = require('./fusion');
const infer = require('./infer');
const heatmap = require('./heatmap');
const composite = require('./composite');

const MAX_ANALYZE_WIDTH = 640; // 与 infer.js 分析宽度口径一致
const MAX_SESSIONS = 3;        // 会话态上限
const HTTP_STATUS = { BAD: 400, NOT_FOUND: 404, CONFLICT: 409 };

/** 简单 HTTP 错误（路由层统一转 JSON） */
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

function genTaskId() {
  return 'EXPL' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/* ---------------- 会话态存储 ---------------- */
const sessions = new Map(); // taskId -> 会话对象
let recent = null;          // 最近一次会话 taskId（供 PUT 省略 taskId 时使用）

function remember(s) {
  if (sessions.size >= MAX_SESSIONS) {
    // 淘汰最旧（非 recent）
    const oldest = [...sessions.keys()].find((k) => k !== s.taskId) || sessions.keys().next().value;
    if (oldest && oldest !== s.taskId) sessions.delete(oldest);
  }
  sessions.set(s.taskId, s);
  recent = s.taskId;
}

function getSession(taskId) {
  const id = taskId || recent;
  if (!id) return null;
  return sessions.get(id) || null;
}

/* ---------------- 位图辅助 ---------------- */
function toGray8(f, n) {
  const out = Buffer.alloc(n);
  for (let i = 0; i < n; i++) out[i] = Math.max(0, Math.min(255, Math.round(f[i])));
  return out;
}
function b64PngGray(w, h, u8) { return 'data:image/png;base64,' + vision.encodePngGray(w, h, u8).toString('base64'); }
function b64PngRGB(w, h, rgb) { return 'data:image/png;base64,' + vision.encodePngRGB(w, h, rgb).toString('base64'); }

/* ---------------- 步骤与依赖（左栏 CV 链路） ----------------
 * 步骤顺序与依赖：clahe(raw) → gaussian(clahe) → canny(gauss) ；otsu(raw) 独立
 * 参数 → 首受影响步骤：
 *   claheClipLimit / claheTileGridSize → clahe
 *   gaussianKernelSize                  → gaussian
 *   cannyThreshold                      → canny
 *   otsuEnabled                         → otsu
 */
const STEP_ORDER = ['clahe', 'gaussian', 'canny', 'otsu'];
const STEP_NAMES = {
  clahe: '① CLAHE 自适应增强',
  gaussian: '② 高斯滤波去噪',
  canny: '③ Canny/Sobel 边缘检测',
  otsu: '④ Otsu 自适应分割',
};
function firstAffectedStep(changedKeys) {
  if (!changedKeys || !changedKeys.length) return null;
  let rank = 99;
  for (const k of changedKeys) {
    if (k === 'claheClipLimit' || k === 'claheTileGridSize') rank = Math.min(rank, 0);
    else if (k === 'gaussianKernelSize') rank = Math.min(rank, 1);
    else if (k === 'cannyThreshold') rank = Math.min(rank, 2);
    else if (k === 'otsuEnabled') rank = Math.min(rank, 3);
  }
  return rank === 99 ? null : STEP_ORDER[rank];
}

/** 把会话的每步 PNG 编码为 JSON 回传对象（含缓存命中标记 cached） */
function stepPayload(s, recomputed = []) {
  const out = {};
  for (const k of STEP_ORDER) {
    const buf = s.stepPng[k];
    out[k] = buf ? {
      name: STEP_NAMES[k],
      width: s.W, height: s.H,
      dataUrl: 'data:image/png;base64,' + buf.toString('base64'),
      cached: !recomputed.includes(k), // true=本次未重算（沿用缓存，证明局部重算）
    } : { name: STEP_NAMES[k], dataUrl: null };
  }
  return out;
}

/** 编码会话内所有步骤 PNG（首次全量） */
function encodeAllSteps(s, rgba8, W, H) {
  const png = {
    original: vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba8)),
    clahe: vision.encodePngGray(W, H, toGray8(s.clahe, W * H)),
    gaussian: vision.encodePngGray(W, H, toGray8(s.gauss, W * H)),
    canny: vision.encodePngGray(W, H, s.canny),
    otsu: vision.encodePngGray(W, H, s.otsu),
  };
  s.stepPng = png;
  return png;
}

/* ---------------- 输入图像解码（与 infer.detectImage 一致） ---------------- */
function decodeInput(dataUrl) {
  if (typeof dataUrl !== 'string' || !dataUrl.length) throw httpErr(HTTP_STATUS.BAD, '请上传图像（PNG dataUrl）');
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  if (!b64) throw httpErr(HTTP_STATUS.BAD, '图像 dataUrl 内容为空');
  let pngBuf;
  try { pngBuf = Buffer.from(b64, 'base64'); } catch (e) { throw httpErr(HTTP_STATUS.BAD, '图像 Base64 解码失败'); }
  let dec;
  try {
    dec = vision.decodePng(pngBuf);
  } catch (e) {
    throw httpErr(HTTP_STATUS.BAD, '图像解码失败：' + e.message + '（支持 8bit 非隔行 PNG，JPEG 请先在浏览器转 PNG）');
  }
  const down = vision.downscaleRGBA(dec.rgba, dec.width, dec.height, MAX_ANALYZE_WIDTH);
  return { rgba: down.data, W: down.width, H: down.height };
}

/* ---------------- 1) explainDetect：全量推理 + 可视化 ---------------- */
/**
 * 教学检测主入口（输入输出见文件头）
 * @param {object} body { image:{dataUrl}, params?, heatmapMethod?, tunnel? }
 */
function explainDetect(body) {
  const t0 = performance.now();
  if (!body || typeof body !== 'object') throw httpErr(HTTP_STATUS.BAD, '请求体需为 JSON 对象');
  const params = infer.normalizeParams(body && body.params);
  const method = ['auto', 'eigen', 'gradcam'].includes(body && body.heatmapMethod) ? body.heatmapMethod : 'auto';

  // ---- 图像分析（含 4 特征通道 + 各阶段缓冲） ----
  const { rgba, W, H } = decodeInput((body.image && (body.image.dataUrl || body.image.base64)) || '');
  const an = vision.analyzeImage(rgba, W, H, params);
  const rois = an.rois;
  const sensors = (body && body.sensors) || an.sensors;
  const frame = {
    tunnel: (body && body.tunnel) || '默认隧道',
    mileage: (body && body.mileage) || 0,
    source: 'AI教学检测',
    sensors,
    timestamp: new Date().toISOString(),
    image: { widthPx: W, frameUrl: null, rois },
  };

  // ---- 融合推理 + 可选 NMS（复用 W0 语义） ----
  const fusionRes = fusion.analyze(frame, { threshold: params.confidenceThreshold });
  let fDets = fusionRes.detections;
  if (params.iouThreshold !== null && params.iouThreshold !== undefined && fDets.length > 1) {
    fDets = infer.nms(fDets, params.iouThreshold);
  }
  const detections = fDets.map((d) => infer.mapDetection(d, W, H));

  // ---- 热力图（目标类 = 最高置信度检测；auto 失败自动回退 Eigen） ----
  const top = detections.length ? detections.reduce((a, b) => (b.confidence > a.confidence ? b : a)) : null;
  const heat = heatmap.buildHeatmap({
    chan: an.maps.channels, cw: an.maps.cw, ch: an.maps.ch, W, H, rgba,
    method, defectType: top ? top.class_name : null,
    weights: heatmap.channelWeightsOf(top ? top.class_name : null),
    bboxes: detections.map((d) => d.bbox),
    // 当前检测 ONNX 只暴露最终检测头，不暴露 backbone 特征与类别梯度。
    modelGradAvailable: false,
  });

  // ---- 组装会话态 ----
  const taskId = genTaskId();
  const session = {
    taskId, createdAt: new Date().toISOString(),
    W, H, rgba, tunnel: frame.tunnel, mileage: frame.mileage,
    params, heatmapMethod: method,
    raw: an.maps.grayRaw, clahe: an.maps.clahe, gauss: an.maps.enhanced, grad: an.maps.grad,
    canny: an.maps.cannyMask, otsu: an.maps.darkMask,
    darkThresh: an.maps.darkThresh, brightThresh: an.maps.brightThresh, rawMean: an.maps.rawMean,
    cw: an.maps.cw, ch: an.maps.ch,
    channels: an.maps.channels,       // 网格特征通道（Eigen/Grad-CAM 输入 A_k）
    detections,
    heat: { method, mode: heat.mode, targetClass: heat.targetClass,
            fallbackReason: heat.fallbackReason, alpha: heat.alpha, overlap: heat.overlap },
  };
  // 归一化热力网格（重算/导出用）
  {
    const hGrid = heat.mode === 'gradcam'
      ? heatmap.gradCAM(an.maps.channels, an.maps.cw, an.maps.ch, null, top ? top.class_name : null)
      : heatmap.eigenCAM(an.maps.channels, an.maps.cw, an.maps.ch);
    session.heat.grid = heatmap.normalize01(hGrid).v;
  }
  encodeAllSteps(session, rgba, W, H);
  session.overlayRgba = heat.overlay.data;   // 叠加后 RGBA（导出合成用）
  session.heatRGB = heat.rgb.data;           // JET 伪彩 RGB（单独展示用）
  remember(session);

  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  const chainage = detections.length && detections[0].position ? detections[0].position.chainage : '--';
  return {
    taskId,
    createdAt: session.createdAt,
    engine: { name: 'fusion-knowledge-v2', note: '模块一教学链路：传统CV分步可视化 + CAM 判定依据热力图' },
    params,
    heatmap: {
      requestMethod: method,
      method: heat.mode,                          // 实际生效（gradcam | eigen）
      targetClass: heat.targetClass, level_text: top ? top.level_text : null,
      alpha: heat.alpha,
      fallbackReason: heat.fallbackReason,
      overlap: heat.overlap,                       // 热力/检测框吻合度统计
      color: { width: W, height: H, dataUrl: b64PngRGB(W, H, heat.rgb.data) },
      overlay: { width: W, height: H, alpha: heat.alpha, dataUrl: b64PngRGB(W, H, vision.rgbFromRgba(heat.overlay.data)) },
    },
    original: { width: W, height: H, dataUrl: b64PngRGB(W, H, vision.rgbFromRgba(rgba)) },
    steps: stepPayload(session),
    summary: {
      detectionCount: detections.length,
      byClass: detections.reduce((m, d) => ((m[d.class_name] = (m[d.class_name] || 0) + 1), m), {}),
    },
    detections,
    meta: { tunnel: frame.tunnel, chainage, heatmapMethod: method, alpha: heat.alpha, widthPx: W, heightPx: H },
    elapsedMs,
  };
}

/* ---------------- 2) updatePipeline：局部重算 ---------------- */
/**
 * 调整 CV 链路参数（左栏滑杆），只重算受影响步骤后缀。
 * @param {object} body { taskId?, params?: {…}, heatmapMethod? }
 */
function updatePipeline(body) {
  const t0 = performance.now();
  const s = getSession(body && body.taskId);
  if (!s) throw httpErr(HTTP_STATUS.CONFLICT, '当前无可调参会话：请先在「AI教学」上传图片完成一次检测');
  const patch = (body && body.params) || {};
  const changedKeys = [];
  for (const k of ['claheClipLimit', 'claheTileGridSize', 'gaussianKernelSize', 'cannyThreshold', 'otsuEnabled']) {
    if (patch[k] !== undefined) changedKeys.push(k);
  }
  const newParams = infer.normalizeParams({ ...s.params, ...patch });
  const stage = firstAffectedStep(changedKeys);
  const recomputed = [];
  const { W, H } = s;

  // 依赖链：clahe → gaussian → canny
  if (stage === 'clahe') {
    s.clahe = vision.claheEnhance(s.raw, W, H, newParams.claheClipLimit, newParams.claheTileGridSize);
    recomputed.push('clahe');
  }
  if (stage === 'clahe' || stage === 'gaussian') {
    s.gauss = vision.gaussianBlur(s.clahe, W, H, newParams.gaussianKernelSize);
    recomputed.push('gaussian');
  }
  if (stage === 'clahe' || stage === 'gaussian' || stage === 'canny') {
    s.grad = vision.sobelGradient(s.gauss, W, H);
    s.canny = vision.thresholdMask8(s.grad, W, H, newParams.cannyThreshold, false);
    recomputed.push('canny');
  }
  // otsu 独立分支（仅 otsuEnabled 变化才重算；它不依赖前 3 步）
  if (stage === 'otsu') {
    const otsuT = newParams.otsuEnabled ? vision.otsuThreshold(s.raw, W * H) : s.rawMean * 0.7;
    s.darkThresh = Math.min(otsuT, s.rawMean * 0.7);
    s.otsu = vision.thresholdMask8(s.raw, W, H, s.darkThresh);
    recomputed.push('otsu');
  }

  // 刷新受影响步骤的 PNG 缓存（未受影响步骤字节不变）
  const png = s.stepPng || {};
  for (const k of recomputed) {
    if (k === 'clahe') png.clahe = vision.encodePngGray(W, H, toGray8(s.clahe, W * H));
    else if (k === 'gaussian') png.gaussian = vision.encodePngGray(W, H, toGray8(s.gauss, W * H));
    else if (k === 'canny') png.canny = vision.encodePngGray(W, H, s.canny);
    else if (k === 'otsu') png.otsu = vision.encodePngGray(W, H, s.otsu);
  }
  s.stepPng = png;
  s.params = newParams;

  // 可选：仅切换热力图方式 → 复用已存通道与检测，重算热力（不做整链重推理）
  let heatChanged = false;
  let heatOut = null;
  if (body && body.heatmapMethod && ['auto', 'eigen', 'gradcam'].includes(body.heatmapMethod)) {
    const m = body.heatmapMethod;
    if (m !== s.heat.method) {
      const top = s.detections.length ? s.detections.reduce((a, b) => (b.confidence > a.confidence ? b : a)) : null;
      const heat = heatmap.buildHeatmap({
        chan: s.channels, cw: s.cw, ch: s.ch, W, H, rgba: s.rgba,
        method: m, defectType: top ? top.class_name : null,
        weights: heatmap.channelWeightsOf(top ? top.class_name : null),
        bboxes: s.detections.map((d) => d.bbox),
        modelGradAvailable: false,
      });
      s.heat = {
        method: heat.method, mode: heat.mode, targetClass: heat.targetClass,
        fallbackReason: heat.fallbackReason, alpha: heat.alpha, overlap: heat.overlap,
      };
      s.heat.grid = heatmap.normalize01(heat.mode === 'gradcam'
        ? heatmap.gradCAM(s.channels, s.cw, s.ch, null, top ? top.class_name : null)
        : heatmap.eigenCAM(s.channels, s.cw, s.ch)).v;
      s.heatmapMethod = m;
      s.overlayRgba = heat.overlay.data;
      s.heatRGB = heat.rgb.data;
      heatChanged = true;
      heatOut = {
        requestMethod: m, method: s.heat.mode, targetClass: s.heat.targetClass,
        alpha: s.heat.alpha, fallbackReason: s.heat.fallbackReason, overlap: s.heat.overlap,
        color: { width: W, height: H, dataUrl: b64PngRGB(W, H, s.heatRGB) },
        overlay: { width: W, height: H, alpha: s.heat.alpha, dataUrl: b64PngRGB(W, H, vision.rgbFromRgba(s.overlayRgba)) },
      };
    }
  }

  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  return {
    taskId: s.taskId,
    params: newParams,
    changedKeys,
    firstAffectedStep: stage,
    recomputedSteps: recomputed,
    heatmapChanged: heatChanged,
    heatmap: heatOut,
    steps: stepPayload(s, recomputed),
    elapsedMs,
  };
}

/* ---------------- 3) exportLecture：对比讲解图 ---------------- */
/**
 * 合成对比讲解图（原图+热力+检测框+类别/等级标注）
 * @param {string} taskId
 * @returns {{png:Buffer, W:number, H:number, detectionsRendered:number}}
 */
function exportLecture(taskId) {
  const s = getSession(taskId);
  if (!s) throw httpErr(HTTP_STATUS.NOT_FOUND, '会话不存在或已被淘汰（内存上限 3 条，请重新上传检测）');
  const chainage = s.detections.length && s.detections[0].position ? s.detections[0].position.chainage : '--';
  const dets4export = s.detections.map((d) => ({
    bbox: d.bbox, type: d.class_name, level_text: d.level_text, confidence: d.confidence,
  }));
  const img = composite.buildLectureImage({
    W: s.W, H: s.H,
    overlayRgba: s.overlayRgba,
    tunnel: s.tunnel, chainage,
    detections: dets4export,
    modeLabel: s.heat.mode === 'gradcam' ? 'Grad-CAM' : 'Eigen-CAM',
    alpha: s.heat.alpha,
    engineLabel: '融合知识引擎',
  });
  return { png: img.png, W: img.W, H: img.H, detectionsRendered: img.detectionsRendered, taskId: s.taskId };
}

/** 查询当前管线参数（前端初始化滑杆用） */
function pipelineState() {
  const s = getSession(null);
  return {
    taskId: s ? s.taskId : null,
    hasSession: !!s,
    params: s ? { ...s.params } : null,
    defaults: { ...infer.PARAM_DEFAULTS },
    heatmapMethod: s ? s.heatmapMethod : 'auto',
  };
}

module.exports = { explainDetect, updatePipeline, exportLecture, pipelineState, getSession, MAX_SESSIONS };
