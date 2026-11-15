/**
 * infer.js — W0 参数化推理管线：统一 DetectResult 组装（零第三方依赖）
 *
 * 职责（把「图像/ROI → 预处理 → 融合识别 → 中间产物」编排为一次可缓存任务）：
 *   1. 参数归一化：置信度阈值 / IoU阈值(NMS) / CLAHE(clipLimit,tileGridSize) /
 *      高斯核 / Canny阈值 / Otsu开关 —— 全部带默认值，默认值 = 当前系统使用值
 *      （置信度 0.55、IoU 缺省关闭(原系统无NMS)、CLAHE 2.0/8×8、5×5 高斯、
 *       Canny/Sobel 阈值 70、Otsu 开启），保证用原参数调用行为与改造前一致。
 *   2. 图像管线：vision.analyzeImage 产出 原始帧/CLAHE/Canny/Otsu/特征激活图
 *      中间产物；热力图本轮为占位接口（下一轮接入深度学习模型实现）。
 *   3. 融合推理：fusion.analyze（参数化置信度阈值）→ 可选 IoU-NMS 去重。
 *   4. 统一 DetectResult：{ 检测框列表(class/conf/bbox/area/width_mm/level),
 *       中间产物引用(Base64+ref), 总耗时 }，写入内存缓存（TTL 30min, key=任务ID）。
 *
 * 主要输入（detectImage(body)）：
 *   body = {
 *     tunnel?, mileage?, source?, sensors?,
 *     image?: { dataUrl?: 'data:image/png;base64,...' },   // 上传 PNG 位图
 *     rois?:  [...],                                        // 可选：直接给候选（前端语义）
 *     widthPx?: number, heightPx?: number,                  // rois 模式下的图像基准尺寸
 *     params?: { confidenceThreshold?, iouThreshold?, claheClipLimit?,
 *                claheTileGridSize?, gaussianKernelSize?, cannyThreshold?, otsuEnabled? }
 *   }
 * 主要输出：DetectResult JSON（见文件尾注释中的结构说明）
 */
const { performance } = require('perf_hooks');
const crypto = require('crypto');
const fusion = require('./fusion');
const vision = require('./vision');
const maskSeg = require('./mask');
const cache = require('./intermediate-cache');

/* ---------------- 类目编号（detection.class_id 字典，顺序=DEFECT_TYPES） ---------------- */
const CLASS_ID = Object.fromEntries(fusion.DEFECT_TYPES.map((t, i) => [t, i + 1]));

/* 引擎内分析宽度上限（对齐 640 输入口径，保证推理+可视化 ≤1.5s） */
const MAX_ANALYZE_WIDTH = 640;

/* ---------------- 参数归一化 ---------------- */
const PARAM_DEFAULTS = Object.freeze({
  confidenceThreshold: fusion.DETECT_THRESHOLD, // 0.55：类型置信度阈值（原系统融合门控）
  iouThreshold: null,                           // IoU阈值：null=关闭NMS（原系统无NMS，行为不变）
  claheClipLimit: 2.0,                          // CLAHE 对比度限幅（前端默认）
  claheTileGridSize: 8,                         // CLAHE 分块网格（前端默认 8×8）
  gaussianKernelSize: 5,                        // 高斯核尺寸（前端默认 5×5）
  cannyThreshold: 70,                           // Canny/Sobel 梯度阈值（前端 GRAD_TH=70）
  otsuEnabled: true,                            // Otsu 分割开关（前端默认开启）
  normMode: 'legacy',                           // P0-2 特征归一化：legacy（默认）/ percentile（A/B 验证）
  multiScale: false,                            // P0-1 多尺度候选：默认关（收益验证后翻转）
});
const clampi = (x, a, b) => Math.max(a, Math.min(b, x));

/**
 * 参数归一化（输入任意子集 -> 输出含全字段的规范化参数）
 * @param {object} p 请求参数（可缺省）
 * @returns {object} 归一化后的全量参数
 */
function normalizeParams(p) {
  p = p || {};
  const out = { ...PARAM_DEFAULTS };
  if (p.confidenceThreshold !== undefined) {
    const v = Number(p.confidenceThreshold);
    if (Number.isFinite(v)) out.confidenceThreshold = Math.round(clampi(v, 0.01, 1) * 1000) / 1000;
  }
  if (p.iouThreshold !== undefined && p.iouThreshold !== null) {
    const v = Number(p.iouThreshold);
    out.iouThreshold = Number.isFinite(v) ? Math.round(clampi(v, 0.05, 0.99) * 1000) / 1000 : null;
  }
  if (p.claheClipLimit !== undefined) {
    const v = Number(p.claheClipLimit);
    if (Number.isFinite(v)) out.claheClipLimit = Math.round(clampi(v, 0.1, 8) * 100) / 100;
  }
  if (p.claheTileGridSize !== undefined) {
    const v = Number(p.claheTileGridSize);
    if (Number.isFinite(v)) out.claheTileGridSize = Math.round(clampi(v, 2, 16));
  }
  if (p.gaussianKernelSize !== undefined) {
    const v = Number(p.gaussianKernelSize);
    if (Number.isFinite(v)) out.gaussianKernelSize = Math.round(clampi(v, 3, 9)) | 1; // 归一到奇数
  }
  if (p.cannyThreshold !== undefined) {
    const v = Number(p.cannyThreshold);
    if (Number.isFinite(v)) out.cannyThreshold = Math.round(clampi(v, 1, 255));
  }
  if (p.otsuEnabled !== undefined) out.otsuEnabled = p.otsuEnabled === true || p.otsuEnabled === 'true' || p.otsuEnabled === 1 || p.otsuEnabled === '1';
  if (p.normMode === 'percentile' || p.normMode === 'legacy') out.normMode = p.normMode; // P0-2 双轨
  if (p.multiScale !== undefined) out.multiScale = p.multiScale === true || p.multiScale === 'true' || p.multiScale === 1; // P0-1
  return out;
}

/* ---------------- 图像辅助 ---------------- */
function base64PngGray(w, h, u8) { return 'data:image/png;base64,' + vision.encodePngGray(w, h, u8).toString('base64'); }

/**
 * 由特征激活网格生成整幅特征图灰度 PNG（黑底，越亮=该处知识模型特征响应越强）
 * @param {Float32Array} act   cw*ch 激活强度（0~1 量级）
 * @param {number} cw,ch       网格维度
 * @param {number} W,H         目标图像尺寸
 * @returns {Buffer} PNG
 */
function buildActivationPng(act, cw, ch, W, H) {
  let max = 0.01;
  for (let i = 0; i < cw * ch; i++) max = Math.max(max, act[i]);
  const out = Buffer.alloc(W * H);
  for (let y = 0; y < H; y++) {
    const cy = Math.min(ch - 1, (y / H * ch) | 0);
    for (let x = 0; x < W; x++) {
      const cx = Math.min(cw - 1, (x / W * cw) | 0);
      out[y * W + x] = Math.round((act[cy * cw + cx] / max) * 255);
    }
  }
  return vision.encodePngGray(W, H, out);
}

/** 生成任务 ID（时间戳+随机，本地唯一） */
function genTaskId() {
  return 'TASK' + Date.now().toString(36).toUpperCase() + crypto.randomBytes(3).toString('hex').toUpperCase();
}

/** 构造带 HTTP 状态码的错误（统一由路由层转 4xx/5xx JSON） */
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* ---------------- IoU-NMS（可选） ---------------- */
/** 两归一化框 IoU（bbox=[x,y,w,h]） */
function iouOf(a, b) {
  const ax1 = a[0], ay1 = a[1], ax2 = a[0] + a[2], ay2 = a[1] + a[3];
  const bx1 = b[0], by1 = b[1], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix1 = Math.max(ax1, bx1), iy1 = Math.max(ay1, by1);
  const ix2 = Math.min(ax2, bx2), iy2 = Math.min(ay2, by2);
  const iw = Math.max(0, ix2 - ix1), ih = Math.max(0, iy2 - iy1);
  const inter = iw * ih;
  const ua = (ax2 - ax1) * (ay2 - ay1) + (bx2 - bx1) * (by2 - by1) - inter;
  return ua <= 0 ? 0 : inter / ua;
}

/**
 * 贪婪 NMS：按置信度降序保留，抑制与其 IoU 超过阈值的其他框
 * @param {Array} dets 检测对象（含 bbox 字段数组 与 confidence）
 * @param {number} iouTh
 * @returns {Array} 保留的检测
 */
function nms(dets, iouTh) {
  const boxOf = (d) => (d.position && d.position.bbox) || d.bbox; // 兼容原始/统一结构
  const order = dets
    .map((d, i) => ({ i, c: d.confidence }))
    .sort((a, b) => b.c - a.c)
    .map((x) => x.i);
  const keep = [];
  const dropped = new Set();
  for (const i of order) {
    if (dropped.has(i)) continue;
    keep.push(i);
    for (const j of order) {
      if (dropped.has(j) || j === i) continue;
      if (iouOf(boxOf(dets[i]), boxOf(dets[j])) > iouTh) dropped.add(j);
    }
  }
  return keep.map((i) => dets[i]);
}

/* ---------------- 中间产物组装 ---------------- */
/**
 * 由图像分析结果构造中间产物条目数组（Base64 内联 + ref 引用）
 * @param {object} an        vision.analyzeImage 输出（无图像时为 null）
 * @param {Buffer} rgba8     缩放后原始 RGBA 位图像素（无图像时为 null）
 * @returns {Array<{key,name,dataUrl,ref,note?}>}
 */
function buildIntermediates(an, rgba8) {
  const items = [];
  if (an && rgba8) {
    const { W, H } = an.maps;
    // ① 原始帧（缩放后 RGB 原图）
    items.push({ key: 'original', name: '原始帧', dataUrl: 'data:image/png;base64,' + vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba8)).toString('base64') });
    // ② CLAHE 结果图（clipLimit/tileGridSize 参数化）
    const clahe8 = Buffer.alloc(W * H);
    for (let i = 0; i < W * H; i++) clahe8[i] = Math.max(0, Math.min(255, an.maps.clahe[i] | 0));
    items.push({ key: 'clahe', name: 'CLAHE 结果图', dataUrl: base64PngGray(W, H, clahe8) });
    // ③ Canny/Sobel 边缘图（cannyThreshold 参数化，白底黑边）
    items.push({ key: 'canny', name: 'Canny 边缘图', dataUrl: base64PngGray(W, H, an.maps.cannyMask) });
    // ④ Otsu 分割图（暗色分割；otsuEnabled=false 时退化为均值×0.7）
    items.push({
      key: 'otsu', name: 'Otsu 分割图', dataUrl: base64PngGray(W, H, an.maps.darkMask),
      note: `分割阈值=${Math.round(an.maps.darkThresh)}（原图均值×0.7=${Math.round(an.maps.rawMean * 0.7)}，Otsu=${an.maps.darkThresh >= an.maps.rawMean * 0.7 ? '触发' : '被均值上限约束'})`,
    });
    // ⑤ 模型特征图：当前引擎为知识驱动判别，此图为其「特征激活响应」；
    //    接入 YOLOv8n 后此处替换为 backbone 特征图（接口不变，数据源切换）
    items.push({
      key: 'feature_map', name: '模型特征图(特征激活响应)',
      dataUrl: 'data:image/png;base64,' + buildActivationPng(an.maps.activation, an.maps.cw, an.maps.ch, W, H).toString('base64'),
      note: '占位数据源：知识驱动引擎特征激活；YOLOv8n backbone 特征图待接入',
    });
  } else {
    items.push({ key: 'original', name: '原始帧', dataUrl: null, note: '未提供图像（ROI直传模式）' });
    items.push({ key: 'clahe', name: 'CLAHE 结果图', dataUrl: null, note: '未提供图像' });
    items.push({ key: 'canny', name: 'Canny 边缘图', dataUrl: null, note: '未提供图像' });
    items.push({ key: 'otsu', name: 'Otsu 分割图', dataUrl: null, note: '未提供图像' });
    items.push({ key: 'feature_map', name: '模型特征图', dataUrl: null, note: '未提供图像' });
  }
  // ⑥ 热力图：本轮仅占位，下一轮实现（需深度学习模型梯度回传）
  items.push({ key: 'heatmap', name: '热力图(Grad-CAM)', dataUrl: null, note: '接口占位：下一轮接入深度学习模型后实现' });
  // 引用路径（可用 GET /api/detect/result/{taskId}/intermediate/{key} 取回二进制 PNG）
  return items;
}

/* ---------------- 检测结果统一化 ---------------- */
const VIEW_WIDTH_M = 3.5; // 与 fusion.js 标定一致：单帧视场宽 3.5m

/**
 * 把 fusion 检测对象映射为统一 DetectResult.detections 条目
 * @param {object} d fusion 检测对象
 * @param {number} widthPx 分析宽度基准（mm/px 标定）
 * @param {number|null} heightPx 高度基准（未知为 null）
 * @returns {object} 统一检测条目
 */
function mapDetection(d, widthPx, heightPx) {
  const bbox = d.position.bbox;
  const pxW = bbox[2] * widthPx;
  const pxH = heightPx ? bbox[3] * heightPx : pxW;
  const mmPx = (VIEW_WIDTH_M * 1000) / (widthPx || 640);
  const widthMm = Math.min(pxW, pxH) * mmPx; // 病害窄边物理宽度（mm）
  return {
    // —— detection 表字段（class_id/class_name/confidence/bbox/area_px/width_mm/level/review_status）
    class_id: CLASS_ID[d.type] || 0,
    class_name: d.type,
    confidence: d.confidence,
    bbox,
    area_px: Math.round(pxW * pxH),
    width_mm: Math.round(widthMm * 100) / 100,
    level: d.levelNo,
    level_text: d.level,
    review_status: '待审核',
    // —— 保留富字段（供教学/审核后续模块使用）
    subtype: d.subtype,
    position: d.position,
    physical: d.physical || {},
    basis: d.basis || [],
    evidence: d.evidence || {},
    suggestions: d.suggestions || [],
    tunnel: d.tunnel,
    detectedAt: d.detectedAt,
  };
}

/* ---------------- 主入口 ---------------- */

/**
 * 参数化图像/ROI 推理任务入口（P3 起为 async：CNN 通道存在时等待 ONNX 推理；
 * 无模型时行为与同步版本完全一致，调用方统一 await 即可）
 * @param {object} body 请求体（见文件头注释）
 * @returns {Promise<object>} DetectResult（并已写入中间产物缓存）
 */
async function detectImage(body) {
  const t0 = performance.now();
  const params = normalizeParams(body && body.params);
  const taskId = genTaskId();

  // ---- 输入解析：优先图像（PNG dataUrl），其次 ROI 直传 ----
  let scaled = null;          // {data,width,height} 缩放后 RGBA
  let an = null;              // vision.analyzeImage 输出
  let rois = null;
  let engineName = 'fusion-knowledge-v2'; // P3 引擎自描述：实际生效引擎
  let engineFallback = null;              // 降级原因（CNN 失败回退时非空）
  let visionRois = null;                  // 保留传统视觉候选，供低召回 CNN 空检时兜底
  let sensors = (body && body.sensors) || null;
  let widthPx = (body && body.widthPx) || null;
  let heightPx = (body && body.heightPx) || null;
  let hasImage = false;

  const dataUrl = body && body.image && (body.image.dataUrl || body.image.base64);
  // 边界防护：显式传入 image 但内容为空 → 400（区别于“不传 image 的空检测/正常衬砌”口径）
  if (body && body.image && !dataUrl) throw httpErr(400, '请求包含 image 但 dataUrl/base64 为空：请提供 PNG dataUrl，或移除 image 字段');
  if (Array.isArray(body && body.rois) && body.rois.length) {
    rois = body.rois; // 客户端/前端已给出候选区（原系统主链路）
    if (dataUrl) widthPx = widthPx || null; // 图像仅用于中间产物
  }
  if (typeof dataUrl === 'string' && dataUrl.length) {
    // 输入：data:image/png;base64,...  或 裸 base64（按 PNG 处理）
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    if (!b64) throw httpErr(400, '图像 dataUrl 内容为空');
    const pngBuf = Buffer.from(b64, 'base64');
    let dec;
    try {
      dec = vision.decodePng(pngBuf); // 支持 8bit 非隔行 PNG（gray/rgb/rgba）
    } catch (e) {
      throw httpErr(400, '图像解码失败：' + e.message + '（本轮支持 8bit 非隔行 PNG，JPEG 请先在浏览器转 PNG）');
    }
    const down = vision.downscaleRGBA(dec.rgba, dec.width, dec.height, MAX_ANALYZE_WIDTH);
    scaled = down;
    widthPx = down.width;
    heightPx = down.height;
    hasImage = true;
    if (!rois) {
      an = vision.analyzeImage(down.data, down.width, down.height, params);
      rois = an.rois;
      visionRois = an.rois;
      if (!sensors) sensors = an.sensors; // 缺省传感器由画面全局统计推算
      // ---- P3 双通道编排：CNN 候选优先，失败/无模型回退网格聚类（主链路绝不因 CNN 挂掉）----
      const detector = require('./detector');
      if (detector.isActive()) {
        try {
          const cnnRois = await detector.detect(pngBuf);
          if (cnnRois.length) {
            // CNN 只提供 bbox/类别先验，形态学特征由现有 vision 管线在框内补齐
            rois = vision.enrichRois(down.data, down.width, down.height, cnnRois, params);
            engineName = 'yolov8n-onnx';
          } else {
            // 冒烟权重召回率较低：空框不能覆盖原本有效的视觉候选。
            rois = visionRois;
            engineName = 'fusion-knowledge-v2';
            engineFallback = 'YOLOv8n 本帧无候选，已自动回退视觉候选识别';
          }
        } catch (e) {
          engineName = 'fusion-knowledge-v2';
          engineFallback = 'CNN 候选失败，已回退网格聚类：' + e.message;
        }
      }
    }
  }
  if (!rois) {
    // 无图像也无 ROI：可返回空检测（允许“正常衬砌”判定）
    rois = [];
  }
  if (!sensors) sensors = {}; // 传感器仍缺省时给空对象（融合引擎内置默认证据）
  const frame = {
    tunnel: (body && body.tunnel) || '默认隧道',
    mileage: (body && body.mileage) || 0,
    speed: (body && body.speed) || 0,
    source: (body && body.source) || 'API检测',
    sensors,
    timestamp: new Date().toISOString(),
    image: { widthPx: widthPx || 640, frameUrl: null, rois },
  };

  // ---- 融合推理（置信度阈值参数化；默认 0.55 与原行为一致） ----
  let fusionRes = fusion.analyze(frame, { threshold: params.confidenceThreshold });
  let dets = fusionRes.detections;

  // YOLO 有框但融合置信度门控后为空时，再用传统视觉候选复检，避免页面“完全识别不出”。
  if (!dets.length && engineName === 'yolov8n-onnx' && visionRois && visionRois.length) {
    frame.image.rois = visionRois;
    rois = visionRois;
    fusionRes = fusion.analyze(frame, { threshold: params.confidenceThreshold });
    dets = fusionRes.detections;
    engineName = 'fusion-knowledge-v2';
    engineFallback = 'YOLOv8n 候选未通过融合门控，已自动用视觉候选复检';
  }

  // ---- 可选 IoU-NMS（默认 null 关闭，与原系统无 NMS 行为一致） ----
  const nmsApplied = params.iouThreshold !== null && params.iouThreshold !== undefined;
  if (nmsApplied && dets.length > 1) {
    dets = nms(dets, params.iouThreshold);
  }

  // ---- 实例掩码分割提取（有图且有检测时）：逐框 ROI→阈值→连通域→掩码级几何参数 ----
  let maskRes = null;
  if (scaled && dets.length) {
    const mmPxM = (VIEW_WIDTH_M * 1000) / (frame.image.widthPx || 640);
    try {
      maskRes = maskSeg.extract(scaled.data, scaled.width, scaled.height, dets, mmPxM);
    } catch (e) {
      maskRes = null; // 掩码为增强能力，失败不阻断检测主链路
    }
    // P1-3 多证据融合重定级：掩码实测（凸包长度/面积）与 bbox 证据加权中位数复核等级
    if (maskRes) {
      dets.forEach((d, i) => {
        const mk = maskRes.masks[i];
        if (mk) {
          try {
            fusion.regradeWithEvidence(d, { mask: mk, mmPx: mmPxM, imageW: scaled.width, imageH: scaled.height });
          } catch (e) { /* 重定级失败保留原等级 */ }
        }
      });
    }
  }

  // ---- 中间产物组装（Base64 内联；引用进缓存） ----
  const intermediates = buildIntermediates(an, scaled ? scaled.data : null);
  intermediates.push(maskRes && maskRes.overlayPng
    ? {
        key: 'mask', name: '实例掩码分割提取',
        dataUrl: 'data:image/png;base64,' + maskRes.overlayPng.toString('base64'),
        note: `连通域实例掩码 ×${maskRes.masks.filter(Boolean).length}（暗/亮极性自适应，颜色=病害类别）`,
      }
    : { key: 'mask', name: '实例掩码分割提取', dataUrl: null, note: '无图像或无检测目标' });
  const interItems = intermediates
    .map((it) => ({ ...it, ref: `/api/detect/result/${taskId}/intermediate/${it.key}` }));

  const elapsedMs = Math.round((performance.now() - t0) * 100) / 100;
  const payload = {
    taskId,
    createdAt: new Date().toISOString(),
    engine: {
      // P3 引擎自描述：界面上能直接看到"当前是否真的在用 CNN"，杜绝名义引擎
      name: engineName,
      model: require('./detector').isActive() ? 'yolov8n-onnx' : null,
      modelLoaded: require('./detector').isActive(),
      clsThreshold: require('./detector').isActive() ? require('./detector').CLS_THRESHOLD : null,
      iouThreshold: require('./detector').isActive() ? require('./detector').IOU_THRESHOLD : null,
      fallback: engineFallback,
      note: engineName === 'yolov8n-onnx'
        ? '检测主干：YOLOv8n(ONNX) 候选 → 知识融合分级（两阶段，契约不变）'
        : (engineFallback || '当前引擎为知识驱动融合判别'),
    },
    params,
    input: {
      tunnel: frame.tunnel,
      mileage: frame.mileage,
      source: frame.source,
      sensors: frame.sensors,
      widthPx: widthPx || frame.image.widthPx,
      heightPx,
      hasImage,
      roisCount: rois.length,
    },
    summary: {
      detectionCount: dets.length,
      byClass: dets.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {}),
      nms: nmsApplied ? { applied: true, threshold: params.iouThreshold } : { applied: false },
    },
    detections: dets.map((d, i) => {
      const item = mapDetection(d, frame.image.widthPx, heightPx);
      // 掩码级几何参数（面积/长度/宽度按实例掩码实测，区别于 bbox 代理口径）
      if (maskRes) item.mask = maskRes.masks[i];
      // P1-3：证据融合重定级留痕（多证据加权中位数的证据表 + 等级变化记录）
      item.evidenceFusion = d.evidenceFusion || null;
      item.regraded = d._regraded || null;
      return item;
    }),
    intermediates: interItems,
    elapsedMs,
  };
  const { expiresAt } = cache.put(taskId, payload);
  payload.expiresAt = expiresAt;
  return payload;
}

/**
 * 按任务 ID 取回 DetectResult（含中间产物 Base64）
 * @param {string} taskId
 * @returns {object|null}
 */
function getResult(taskId) {
  return cache.get(taskId);
}

/**
 * 取回某任务单个中间产物的 PNG Buffer
 * @param {string} taskId
 * @param {string} key  intermediate key（original/clahe/canny/otsu/feature_map/heatmap）
 * @returns {{png:Buffer|null, item:object|null}}
 */
function getIntermediatePng(taskId, key) {
  const payload = cache.get(taskId);
  if (!payload) return { png: null, item: null };
  const item = (payload.intermediates || []).find((it) => it.key === key);
  if (!item || !item.dataUrl) return { png: null, item };
  return { png: Buffer.from(item.dataUrl.split(',')[1] || '', 'base64'), item };
}

/* =====================================================================
 * DetectResult 结构（返回 JSON）：
 * {
 *   taskId, createdAt, expiresAt,
 *   engine:   { name, model, modelLoaded, note },
 *   params:   { confidenceThreshold, iouThreshold, claheClipLimit,
 *               claheTileGridSize, gaussianKernelSize, cannyThreshold, otsuEnabled },
 *   input:    { tunnel, mileage, source, sensors, widthPx, heightPx, hasImage, roisCount },
 *   summary:  { detectionCount, byClass, nms },
 *   detections: [{ class_id, class_name, confidence, bbox, area_px, width_mm,
 *                  level, level_text, review_status, subtype, position,
 *                  mask: { area_px, area_mm2, length_mm, width_mm, coverage, polarity }|null,
 *                  physical, basis, evidence, suggestions, tunnel, detectedAt }],
 *   intermediates: [{ key, name, dataUrl|ref|null, note? }],   // 原始帧/CLAHE/Canny/Otsu/特征图/实例掩码/热力图占位
 *   elapsedMs
 * }
 * ===================================================================== */

module.exports = { PARAM_DEFAULTS, normalizeParams, detectImage, getResult, getIntermediatePng, nms, mapDetection, CLASS_ID };
