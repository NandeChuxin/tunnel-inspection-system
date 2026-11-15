/**
 * detector.js — YOLOv8n ONNX 检测模型适配器
 *
 * 项目计划书 §3.4 规定核心识别采用 YOLOv8n（CSPDarknet + PANet，640×640）。
 * 当前原型使用知识驱动判别模型（fusion.js），本模块为其预留统一的模型接入点：
 *
 * 默认加载仓库内 yolo-workspace/runs/smoke-yolov8n/weights/best.onnx；也可用
 * TUNNEL_YOLO_MODEL 覆盖。模型不可用时系统明确回退规则/学习双引擎。
 *
 * 部署路径（三步）：
 *   1. 用 Ultralytics 训练并导出：yolo export model=best.pt format=onnx
 *   2. npm i onnxruntime-node（或车载端 TensorRT/ONNX Runtime Python 服务）
 *   3. 设置环境变量 TUNNEL_YOLO_MODEL=<onnx路径> 并重启本服务
 *
 * 输出契约（与前端 detectRois 一致，可直接送入 /api/ingest 的 image.rois）：
 *   { bbox:[x,y,w,h]归一化, angle, edgeDensity, darkRatio, brightRatio, textureVar,
 *     hueShift, lengthPx, widthPx, elongation, fillRatio, linearity, orientation }
 * 模型输出的检测框映射 bbox；形态学特征可由裁剪出的 ROI 图块经特征计算器
 * （frontend/app.js 的网格统计逻辑）补全，或由分类头直接输出。
 */
const fs = require('fs');
const path = require('path');

let session = null;
let loadedModelPath = null;
let initError = null;

/* YOLOv8 检测头解析参数（算法优化方案 §5.3） */
const INPUT_SIZE = 640;
const CLS_THRESHOLD = 0.25;  // 类别分数粗筛阈值
const IOU_THRESHOLD = 0.45;  // NMS IoU 阈值
const N_ANCHOR = 8400;       // YOLOv8 输出锚点数 [1, 4+nc, 8400]

/** 是否处于深度学习检测模式 */
function isActive() {
  return session !== null;
}

async function init() {
  const bundled = path.join(__dirname, '..', 'yolo-workspace', 'runs', 'smoke-yolov8n', 'weights', 'best.onnx');
  const modelPath = process.env.TUNNEL_YOLO_MODEL || bundled;
  if (!fs.existsSync(modelPath)) throw new Error(`TUNNEL_YOLO_MODEL 指定的模型不存在: ${modelPath}`);
  let ort;
  try {
    ort = require('onnxruntime-node');
  } catch (e) {
    initError = '未安装 onnxruntime-node，请执行: npm install';
    throw new Error(initError);
  }
  try {
    session = await ort.InferenceSession.create(modelPath);
    loadedModelPath = modelPath;
    initError = null;
  } catch (e) {
    initError = e.message;
    throw e;
  }
  console.log(`[隧途明鉴] YOLOv8n 模型已加载: ${modelPath}`);
  return session;
}

/** 类别下标 → 病害类名（与 fusion.DEFECT_TYPES 训练顺序一致） */
// 当前 best.pt 的 data.yaml: ['Spalling', 'Crack', 'Leakage']，顺序必须严格一致。
const TYPES = ['剥落掉块', '裂缝', '渗漏水'];

function info() {
  return { active: isActive(), modelPath: loadedModelPath, error: initError, inputSize: INPUT_SIZE,
    classes: TYPES.slice(), clsThreshold: CLS_THRESHOLD, iouThreshold: IOU_THRESHOLD };
}

/** 贪婪 NMS（框格式 cx,cy,w,h 像素 + score） */
function nmsBoxes(boxes, iouTh) {
  const order = boxes.map((b, i) => i).sort((a, b) => boxes[b].score - boxes[a].score);
  const keep = [];
  const dropped = new Set();
  const iou = (a, b) => {
    const ax1 = a.cx - a.w / 2, ay1 = a.cy - a.h / 2, ax2 = a.cx + a.w / 2, ay2 = a.cy + a.h / 2;
    const bx1 = b.cx - b.w / 2, by1 = b.cy - b.h / 2, bx2 = b.cx + b.w / 2, by2 = b.cy + b.h / 2;
    const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(ax1, bx1));
    const iy = Math.max(0, Math.min(ay2, by2) - Math.max(ay1, by1));
    const inter = ix * iy;
    const ua = a.w * a.h + b.w * b.h - inter;
    return ua <= 0 ? 0 : inter / ua;
  };
  for (const i of order) {
    if (dropped.has(i)) continue;
    keep.push(boxes[i]);
    for (const j of order) {
      if (j === i || dropped.has(j)) continue;
      if (iou(boxes[i], boxes[j]) > iouTh) dropped.add(j);
    }
  }
  return keep;
}

/**
 * 以 YOLOv8n 推理一帧影像（算法优化方案 §5.3 目标实现）
 * @param {Buffer} imageBuf PNG 字节（由调用方传入，内部解码）
 * @returns {Promise<Array>} ROI 候选数组：bbox 归一化 + clsHint/clsScore
 *          （形态学特征由 vision.enrichRois 在框内补齐后进入 fusion）
 */
async function detect(imageBuf) {
  if (!session) throw new Error('YOLO 模型未加载（未设置 TUNNEL_YOLO_MODEL）');
  const ort = require('onnxruntime-node');
  const vision = require('./vision');
  // ① 解码 + letterbox 缩放到 640×640（保持长宽比，记录 pad 偏移与缩放系数）
  const dec = vision.decodePng(imageBuf);
  const scale = Math.min(INPUT_SIZE / dec.width, INPUT_SIZE / dec.height);
  const nw = Math.max(1, Math.round(dec.width * scale)), nh = Math.max(1, Math.round(dec.height * scale));
  const padX = Math.floor((INPUT_SIZE - nw) / 2), padY = Math.floor((INPUT_SIZE - nh) / 2);
  const canvas = new Uint8Array(INPUT_SIZE * INPUT_SIZE * 4).fill(114); // 灰底填充
  for (let y = 0; y < nh; y++) {
    for (let x = 0; x < nw; x++) {
      const si = (Math.min(dec.height - 1, Math.round(y / scale)) * dec.width + Math.min(dec.width - 1, Math.round(x / scale))) * 4;
      const di = ((y + padY) * INPUT_SIZE + (x + padX)) * 4;
      canvas[di] = dec.rgba[si]; canvas[di + 1] = dec.rgba[si + 1]; canvas[di + 2] = dec.rgba[si + 2];
    }
  }
  // ② 归一化到 CHW float32（RGB / 255）
  const chw = new Float32Array(3 * INPUT_SIZE * INPUT_SIZE);
  const NP = INPUT_SIZE * INPUT_SIZE;
  for (let i = 0; i < NP; i++) {
    chw[i] = canvas[i * 4] / 255;
    chw[NP + i] = canvas[i * 4 + 1] / 255;
    chw[2 * NP + i] = canvas[i * 4 + 2] / 255;
  }
  // ③ ONNX 推理（YOLOv8 输出 [1, 4+nc, 8400]）
  const t = new ort.Tensor('float32', chw, [1, 3, INPUT_SIZE, INPUT_SIZE]);
  const out = await session.run({ images: t });
  const pred = out[Object.keys(out)[0]].data;
  // ④ 解析：先按类别分数阈值粗筛，再执行 NMS
  const boxes = [];
  const NC = TYPES.length;
  for (let a = 0; a < N_ANCHOR; a++) {
    let bestCls = -1, bestSc = 0;
    for (let c = 0; c < NC; c++) {
      const s = pred[(4 + c) * N_ANCHOR + a];
      if (s > bestSc) { bestSc = s; bestCls = c; }
    }
    if (bestSc < CLS_THRESHOLD) continue;
    boxes.push({
      cx: pred[0 * N_ANCHOR + a], cy: pred[1 * N_ANCHOR + a],
      w: pred[2 * N_ANCHOR + a], h: pred[3 * N_ANCHOR + a],
      score: bestSc, cls: bestCls,
    });
  }
  const kept = nmsBoxes(boxes, IOU_THRESHOLD);
  // ⑤ 还原到原图坐标 → 归一化 bbox（严格对齐 vision 的归一化口径）
  return kept.map((b) => {
    const x0 = (b.cx - b.w / 2 - padX) / scale;
    const y0 = (b.cy - b.h / 2 - padY) / scale;
    const bw = b.w / scale, bh = b.h / scale;
    return {
      bbox: [
        Math.max(0, x0 / dec.width),
        Math.max(0, y0 / dec.height),
        Math.min(1, bw / dec.width),
        Math.min(1, bh / dec.height),
      ],
      clsHint: TYPES[b.cls],   // 类别先验（供 fusion 参考，不直接采用）
      clsScore: b.score,
      angle: 0,                // 由 vision.enrichRois 在 ROI 内重算
      // 其余形态学特征留空，由 vision.enrichRois 在框内补齐
    };
  });
}

module.exports = { init, isActive, info, detect, CLS_THRESHOLD, IOU_THRESHOLD, INPUT_SIZE };
