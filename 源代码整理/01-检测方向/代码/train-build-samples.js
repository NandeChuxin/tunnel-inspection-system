/**
 * train/build-samples.js — 训练样本构建（特征抽取 + 标注匹配 + 训练/验证切分 + 真实域增广）
 *
 * 流程：读取 gen-dataset 产出的 labels.json → 逐图 vision.analyzeImage（与运行态
 * 完全同一套网格特征/聚类管线）→ ROI 与 GT 框按 IoU≥0.3 匹配打标（背景/病害类）→
 * 按图像划分 train/val（约 75/25，避免同图泄漏）→ 落盘 samples.json。
 *
 * P1-2 真实域在线增广（算法优化方案 §P1-2）：item.real 且落入 train 切分的图像，
 * 追加 augment 份增广变体（水平翻转 / 顺时针 90° 旋转 / 亮度抖动+噪声），GT 框同步
 * 变换后走同一匹配管线进入 train（验证侧不动，防泄漏）。增广是图像级重提特征，
 * 引入真实的光照与视角多样性，区别于此前的"同批样本复制 realWeight 遍"。
 *
 * CLI：node backend/train/build-samples.js [--dir data/train] [--iou 0.3] [--augment 3]
 */
const fs = require('fs');
const path = require('path');
const vision = require('../vision');
const model = require('../model');

const CLASSES = ['背景', '裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出'];

/** 归一化框 IoU */
function iou(a, b) {
  const ax2 = a[0] + a[2], ay2 = a[1] + a[3], bx2 = b[0] + b[2], by2 = b[1] + b[3];
  const ix = Math.max(0, Math.min(ax2, bx2) - Math.max(a[0], b[0]));
  const iy = Math.max(0, Math.min(ay2, by2) - Math.max(a[1], b[1]));
  const inter = ix * iy;
  const ua = a[2] * a[3] + b[2] * b[3] - inter;
  return ua <= 0 ? 0 : inter / ua;
}

/* ---------------- P1-2 图像增广变体（GT 框同步变换） ---------------- */

/** 水平翻转 */
function augFlipH(rgba, W, H) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4, di = (y * W + (W - 1 - x)) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  return { rgba: out, W, H, tf: (b) => [W - b[0] - b[2], b[1], b[2], b[3]] };
}

/** 顺时针旋转 90°（宽高互换） */
function augRot90(rgba, W, H) {
  const out = new Uint8Array(rgba.length);
  for (let y = 0; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const si = (y * W + x) * 4;
      const di = (x * H + (H - 1 - y)) * 4;
      out[di] = rgba[si]; out[di + 1] = rgba[si + 1]; out[di + 2] = rgba[si + 2]; out[di + 3] = rgba[si + 3];
    }
  }
  // 像素 (x,y)→(H-1-y, x)，新图宽=H 高=W；GT 框 [X,Y,PW,PH] → [H-Y-PH, X, PH, PW]
  return { rgba: out, W: H, H: W, tf: (b) => [H - b[1] - b[3], b[0], b[3], b[2]] };
}

/** 亮度抖动（×factor，RGB 同比，模拟曝光差异） */
function augBrightness(rgba, factor) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    out[i] = Math.max(0, Math.min(255, rgba[i] * factor));
    out[i + 1] = Math.max(0, Math.min(255, rgba[i + 1] * factor));
    out[i + 2] = Math.max(0, Math.min(255, rgba[i + 2] * factor));
    out[i + 3] = rgba[i + 3];
  }
  return { rgba: out, identity: true };
}

/** 加性随机噪声（±amp，模拟传感器噪声） */
function augNoise(rgba, amp, rand) {
  const out = new Uint8Array(rgba.length);
  for (let i = 0; i < rgba.length; i += 4) {
    const nz = (rand() - 0.5) * 2 * amp;
    out[i] = Math.max(0, Math.min(255, rgba[i] + nz));
    out[i + 1] = Math.max(0, Math.min(255, rgba[i + 1] + nz));
    out[i + 2] = Math.max(0, Math.min(255, rgba[i + 2] + nz));
    out[i + 3] = rgba[i + 3];
  }
  return { rgba: out, identity: true };
}

/**
 * 构建训练样本
 * @param {{dir?:string, iouTh?:number, valRatio?:number, seed?:number,
 *          augment?:number, visionParams?:object}} opts
 *   augment：真实域 train 切分每图追加的增广变体份数（默认 0=不增广；建议 3）
 *   visionParams：透传 vision.analyzeImage（A/B 评测用，如 {normMode:'percentile'}）
 * @returns {object} {classes, featureNames, train, val, stats}
 */
function buildSamples(opts = {}) {
  const dir = opts.dir || path.join(__dirname, '..', 'data', 'train');
  const iouTh = opts.iouTh || 0.3;
  const valRatio = opts.valRatio || 0.25;
  const augment = Math.max(0, Number(opts.augment) || 0);
  const vp = opts.visionParams || {};
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, 'labels.json'), 'utf-8'));
  const rand = (() => { let a = (opts.seed || 7) >>> 0; return () => { a |= 0; a = (a + 0x6D2B79F5) | 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0) / 4294967296; }; })();

  const train = [], val = [];
  const stats = { images: 0, rois: 0, matched: 0, unmatchedGt: 0, negRois: 0, byType: {}, augImages: 0 };

  /** 单图处理：特征提取 → GT 匹配打标 → 入指定切分（train/val），isReal=真实域判据开关 */
  function processImage(rgba, W, H, defectList, splitArr, isReal) {
    const an = vision.analyzeImage(rgba, W, H, vp);
    // GT 归一化（clamp 到画布内，剔除完全出界的框）
    const gts = (defectList || []).map((d) => {
      let [x, y, w, h] = d.bbox;
      const x0 = Math.max(0, x), y0 = Math.max(0, y);
      const x1 = Math.min(W, x + w), y1 = Math.min(H, y + h);
      return { class_name: d.class_name, level: d.level, bbox: [x0 / W, y0 / H, (x1 - x0) / W, (y1 - y0) / H] };
    }).filter((g) => g.bbox[2] > 0.004 && g.bbox[3] > 0.004);

    const hitGt = new Set();
    for (const roi of an.rois) {
      stats.rois++;
      let best = null, bestScore = 0;
      gts.forEach((g, gi) => {
        const v = iou(roi.bbox, g.bbox);
        // 真实域标注为「区域级」大框：ROI 紧致小框完全落在 GT 内时 IoU 天然低，
        // 改用覆盖度（交集/GT 面积）兜底，避免真实病害 ROI 被误标为背景
        const ix = Math.max(0, Math.min(roi.bbox[0] + roi.bbox[2], g.bbox[0] + g.bbox[2]) - Math.max(roi.bbox[0], g.bbox[0]));
        const iy = Math.max(0, Math.min(roi.bbox[1] + roi.bbox[3], g.bbox[1] + g.bbox[3]) - Math.max(roi.bbox[1], g.bbox[1]));
        const cover = (ix * iy) / Math.max(1e-9, g.bbox[2] * g.bbox[3]);
        const score = isReal ? Math.max(v, cover) : v;
        if (score > bestScore) { bestScore = score; best = gi; }
      });
      const isDefect = best !== null && bestScore >= iouTh;
      const label = isDefect ? gts[best].class_name : '背景';
      if (isDefect) { stats.matched++; hitGt.add(best); stats.byType[label] = (stats.byType[label] || 0) + 1; }
      else stats.negRois++;
      splitArr.push({
        x: model.vectorize(roi, { gapmm: 0 }),
        y: CLASSES.indexOf(label),
        level: isDefect ? gts[best].level : null,
        roi,                       // 保留原始 ROI（规则引擎基线评测用）
      });
    }
    return hitGt.size;
  }

  manifest.items.forEach((item, idx) => {
    stats.images++;
    const png = vision.decodePng(fs.readFileSync(path.join(dir, 'images', item.file)));
    const split = rand() < valRatio ? val : train;
    const defectList = (item.defects || []).map((d) => ({ class_name: d.class_name, level: d.level, bbox: d.bbox.slice() }));
    processImage(png.rgba, png.width, png.height, defectList, split, item.real);

    // P1-2 增广：真实域 train 切分 ×augment 份（翻转/旋转/亮度/噪声）；
    // 合成域 train 切分追加 1 份亮度+噪声变体（缩小手绘/实拍暗斑与合成器风格的域差，
    // 算法优化方案 §5.6「训练集补强」）。验证侧绝不增广。
    if (augment > 0 && split === train) {
      const isReal = !!item.real;
      const variants = [
        () => augFlipH(png.rgba, png.width, png.height),
        () => augRot90(png.rgba, png.width, png.height),
        () => { const b = augBrightness(png.rgba, 0.85 + rand() * 0.3); return { rgba: b.rgba, W: png.width, H: png.height, tf: null }; },
        () => { const n = augNoise(png.rgba, 10, rand); return { rgba: n.rgba, W: png.width, H: png.height, tf: null }; },
      ];
      const want = isReal ? augment : 1;
      // 真实域全变体轮换；合成域固定取亮度+噪声变体（索引 2/3 随机其一）
      const order = isReal ? [0, 1, 2, 3] : (rand() < 0.5 ? [2, 3] : [3, 2]);
      let made = 0;
      for (const vi of order) {
        if (made >= want) break;
        const vr = variants[vi]();
        const W2 = vr.W || png.width, H2 = vr.H || png.height;
        const tf = vr.tf || ((b) => b);
        const gts2 = defectList.map((d) => ({ class_name: d.class_name, level: d.level, bbox: tf(d.bbox) }));
        processImage(vr.rgba, W2, H2, gts2, train, isReal);
        made++; stats.augImages++;
      }
    }
  });

  const out = { classes: CLASSES, featureNames: model.FEATURE_NAMES, train, val, stats };
  fs.writeFileSync(path.join(dir, 'samples.json'), JSON.stringify(out));
  return out;
}

/** CLI 入口 */
if (require.main === module) {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  const t0 = Date.now();
  const s = buildSamples({ dir: arg('dir', undefined), iouTh: Number(arg('iou', 0.3)), augment: Number(arg('augment', 0)) });
  console.log(`✓ 样本构建完成：train ${s.train.length} / val ${s.val.length}（ROI 共 ${s.stats.rois}，其中病害匹配 ${s.stats.matched}、背景 ${s.stats.negRois}）`);
  console.log('  病害样本分布:', JSON.stringify(s.stats.byType));
  if (s.stats.augImages) console.log(`  增广变体图: ${s.stats.augImages} 张（仅真实域 train 切分）`);
  console.log(`  未匹配上的 GT 框（候选提取未覆盖）: ${s.stats.unmatchedGt} · 耗时 ${Date.now() - t0}ms`);
}

module.exports = { buildSamples, CLASSES, iou };
