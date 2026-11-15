#!/usr/bin/env node
/**
 * build-6class.js — 构建「6 类目」YOLO 数据集（补齐 衬砌错台 / 白华析出）
 *
 * 背景：原 dataset/ 只有 3 类（Spalling / Crack / Leakage），而系统病害本体是
 * 五类四等级（剥落掉块 / 裂缝 / 渗漏水 / 衬砌错台 / 白华析出）。本脚本把数据侧
 * 补齐到与本体一致，并额外补 150 张「背景（无病害）」负样本，合计 6 个类目
 * （5 个病害类 + 背景负样本类），对应 backend/train/build-samples.js 的 CLASSES。
 *
 * 数据来源（逐图在 build-stats.json 中留 source 溯源）：
 *   1) 公开/自有实拍：yolo-workspace/dataset（330 张，仅覆盖 3 类）
 *   2) synthesizer.js：程序化衬砌背景 + 程序化病害贴片，贴片位置由 composeOne
 *      返回的 tightBox 精确回填 → 标注框与像素严格对应，无人工假设
 *   3) 真实底图 + 合成缺陷：用实拍隧道影像做底图，底图原有实拍标注按几何变换
 *      同步继承（不新增假设），缩小合成/实拍域差
 *   衬砌错台例外：不做贴片，改为整幅画布几何错动（理由见 applyLiningOffset）。
 *
 * 类别顺序（与 backend/detector.js 的 TYPES 必须严格一致）：
 *   0 Spalling      剥落掉块
 *   1 Crack         裂缝
 *   2 Leakage       渗漏水
 *   3 LiningOffset  衬砌错台
 *   4 Efflorescence 白华析出
 *   前 3 类下标与原 dataset 完全一致 → 实拍标注可直接复用，零重映射风险。
 *
 * 用法：
 *   node tools/yolo/build-6class.js [--target 160] [--seed 2026] [--out <dir>]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const vision = require('../../backend/vision');
const jpeg = require('../../backend/jpeg');
const syn = require('../../backend/synthesizer');

const ROOT = path.resolve(__dirname, '..', '..');
const SRC = path.join(ROOT, 'yolo-workspace', 'dataset');          // 原始 3 类实拍集
const PNG = path.join(ROOT, 'yolo-workspace', '.cache', 'png');     // 实拍底图 PNG 缓存
const SPLITS = ['train', 'val', 'test'];

/* ---------------- 类别定义 ---------------- */
const YOLO_CLASSES = ['Spalling', 'Crack', 'Leakage', 'LiningOffset', 'Efflorescence'];
const CN = {
  Spalling: '剥落掉块', Crack: '裂缝', Leakage: '渗漏水',
  LiningOffset: '衬砌错台', Efflorescence: '白华析出',
};
/** 合成器中文类名 → YOLO 下标 */
const IDX = { 剥落掉块: 0, 裂缝: 1, 渗漏水: 2, 衬砌错台: 3, 白华析出: 4 };

/* ---------------- 可复现随机 ---------------- */
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
let rand = mulberry32(2026);
const rint = (a, b) => a + Math.floor(rand() * (b - a + 1));

/* ---------------- 小工具 ---------------- */
const mkdir = (d) => fs.mkdirSync(d, { recursive: true });

/** 读 YOLO 标签 → [{c,x,y,w,h}]（归一化） */
function readLabel(file) {
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((ln) => {
    const p = ln.trim().split(/\s+/).map(Number);
    return { c: p[0], x: p[1], y: p[2], w: p[3], h: p[4] };
  }).filter((b) => Number.isFinite(b.c) && b.w > 0 && b.h > 0);
}

/** 写 YOLO 标签（空数组 → 空文件 = 负样本） */
function writeLabel(file, boxes) {
  const txt = boxes.map((b) => {
    if (!Number.isInteger(b.c) || b.c < 0 || b.c >= YOLO_CLASSES.length) {
      throw new Error(`非法类别下标 ${b.c}（${file}）——检查合成类名是否在 IDX 中`);
    }
    return `${b.c} ${b.x.toFixed(6)} ${b.y.toFixed(6)} ${b.w.toFixed(6)} ${b.h.toFixed(6)}`;
  }).join('\n');
  fs.writeFileSync(file, txt ? txt + '\n' : '');
}

/** 贴片像素框 → 归一化 YOLO 框（越界裁剪；退化框丢弃） */
function toYolo(box, W, H) {
  const cls = IDX[box.class_name];
  if (cls === undefined) throw new Error(`未知合成类名：${box.class_name}`);
  const x0 = Math.max(0, box.x), y0 = Math.max(0, box.y);
  const x1 = Math.min(W, box.x + box.w), y1 = Math.min(H, box.y + box.h);
  if (x1 - x0 < 3 || y1 - y0 < 3) return null;
  return { c: cls, x: (x0 + x1) / 2 / W, y: (y0 + y1) / 2 / H, w: (x1 - x0) / W, h: (y1 - y0) / H };
}

/** 归一化框 → 像素框 */
function toPx(b, W, H) {
  return { x: (b.x - b.w / 2) * W, y: (b.y - b.h / 2) * H, w: b.w * W, h: b.h * H };
}

/** 两框交集 / 第一个框面积 */
function coverOf(a, b) {
  const ix = Math.max(0, Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x));
  const iy = Math.max(0, Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y));
  return (ix * iy) / Math.max(1e-9, a.w * a.h);
}

/** 保存 RGBA → JPEG 文件 */
function saveJpeg(file, rgba, W, H, q = 92) {
  fs.writeFileSync(file, jpeg.encodeJpeg(W, H, vision.rgbFromRgba(rgba), q));
}

/* ---------------- 实拍集载入（含 PNG 底图缓存） ---------------- */
function loadRealSplit(split) {
  const imgDir = path.join(SRC, 'images', split);
  const lblDir = path.join(SRC, 'labels', split);
  const pngDir = path.join(PNG, split);
  if (!fs.existsSync(imgDir)) return [];
  return fs.readdirSync(imgDir).filter((f) => /\.(jpg|jpeg|png)$/i.test(f)).sort().map((f) => {
    const stem = f.replace(/\.[^.]+$/, '');
    return {
      split, stem,
      imgPath: path.join(imgDir, f),
      labelPath: path.join(lblDir, stem + '.txt'),
      pngPath: path.join(pngDir, stem + '.png'),
      boxes: readLabel(path.join(lblDir, stem + '.txt')),
    };
  });
}

/** 惰性解码实拍底图 PNG（缓存，避免重复解码） */
const pngCache = new Map();
function realCanvas(item) {
  if (!fs.existsSync(item.pngPath)) return null;
  if (!pngCache.has(item.pngPath)) {
    pngCache.set(item.pngPath, vision.decodePng(fs.readFileSync(item.pngPath)));
  }
  return pngCache.get(item.pngPath);
}

/* ---------------- 合成素材池 ---------------- */
/** 为某类构建贴片池：1~4 级各一张，形态随机（按类缓存，避免重复绘制） */
const poolCache = new Map();
function buildPool(cnName, n = 5) {
  if (poolCache.has(cnName)) return poolCache.get(cnName);
  const pool = [];
  for (let i = 0; i < n; i++) {
    const lv = 1 + (i % 4);
    const d = syn.makeDemoDefect(cnName, lv);
    pool.push({ rgba: d.rgba, alpha: d.alpha, w: d.w, h: d.h, class_name: cnName, level: d.level });
  }
  poolCache.set(cnName, pool);
  return pool;
}

/**
 * 在底图上试贴一轮缺陷，避开已有实拍框（避免贴片压住实拍标注造成框语义混乱）。
 * @returns {{rgba:Buffer, placed:Array}|null}
 */
function composeAvoiding(bgRgba, W, H, pool, avoidPx, tries = 8) {
  for (let t = 0; t < tries; t++) {
    const bg = { rgba: Buffer.from(bgRgba), alpha: new Uint8Array(W * H).fill(255), w: W, h: H };
    const { placed } = syn.composeOne(bg, pool);
    const clash = placed.some((p) => avoidPx.some((r) => coverOf(p, r) > 0.25));
    if (!clash) return { rgba: bg.rgba, placed };
  }
  return null;
}

/**
 * 衬砌错台：在整幅画布上做几何错动，而不是贴一块矩形贴片。
 *
 * 真实错台是两段衬砌沿施工缝相对位移 —— 表现为一条横向贯通接缝 + 上下错位 + 缝线阴影。
 * 用 synthesizer 的贴片方式贴上去，得到的只是一块「方形补丁」：看着像贴纸，
 * 训练时更糟 —— 模型会学到「带斑点的矩形 = 错台」这个假特征，到真实影像上
 * 任何矩形纹理都可能误触发。所以这一类改用画布级位移：
 *   1) 缝线以下整体横移 off 像素（边缘 clamp 采样，避免出现空白条）
 *   2) 缝线本身压暗并羽化
 *   3) 下半段整体轻微提亮/压暗（两段表面朝向不同 → 受光不同）
 * 标注框覆盖「错动带」，宽 0.94W、高 0.18~0.35H，是真正的检测目标而不是补丁。
 *
 * @returns {{rgba:Buffer, seamY:number, bandH:number, shift:number}}
 */
function applyLiningOffset(rgba, W, H) {
  const ly = Math.round(H * (0.30 + rand() * 0.40));      // 错台缝所在行
  const off = Math.round(W * (0.012 + rand() * 0.05));    // 横向错动量（px）
  const shift = off * (rand() < 0.5 ? 1 : -1);
  const bandH = Math.round(H * (0.18 + rand() * 0.17));   // 标注带高度

  const out = Buffer.from(rgba);
  // 1) 缝线以下整体横移
  for (let y = ly; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const sx = Math.min(W - 1, Math.max(0, x - shift));
      const so = (y * W + sx) * 4, dof = (y * W + x) * 4;
      out[dof] = rgba[so]; out[dof + 1] = rgba[so + 1]; out[dof + 2] = rgba[so + 2];
    }
  }
  // 2) 缝线阴影（中心最深，向两侧羽化）
  const half = 2 + Math.round(rand() * 3);
  for (let dy = -half; dy <= half; dy++) {
    const y = ly + dy;
    if (y < 0 || y >= H) continue;
    const k = 1 - Math.abs(dy) / (half + 1);
    const mul = 1 - 0.55 * k;
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.round(out[o + c] * mul));
    }
  }
  // 3) 下半段整体受光差
  const lift = 1 + (rand() < 0.5 ? -1 : 1) * (0.05 + rand() * 0.05);
  for (let y = ly; y < H; y++) {
    for (let x = 0; x < W; x++) {
      const o = (y * W + x) * 4;
      for (let c = 0; c < 3; c++) out[o + c] = Math.max(0, Math.min(255, Math.round(out[o + c] * lift)));
    }
  }
  return { rgba: out, seamY: ly, bandH, shift };
}

/* ---------------- 主流程 ---------------- */
function main() {
  const argOf = (k, d) => {
    const i = process.argv.indexOf('--' + k);
    return i > 0 ? process.argv[i + 1] : d;
  };
  const TARGET = Number(argOf('target', 160));      // 每类训练图数目标
  const SEED = Number(argOf('seed', 2026));
  const OUT = path.resolve(argOf('out', path.join(ROOT, 'yolo-workspace', 'dataset-6class')));
  rand = mulberry32(SEED);

  // 每类合成配额（按切分）：train 补足到 TARGET；val/test 各给缺失类一批做可测样本
  // 注意：key 必须是中文类名（IDX 的键），否则 toYolo 取不到类别下标 → 标注被丢弃
  const SYNTH_PLAN = {
    train: {},                                      // train 由 deficit 自动补齐，不使用本表
    val: { 衬砌错台: 40, 白华析出: 40 },
    test: { 衬砌错台: 20, 白华析出: 20 },
  };
  const NEG = { train: 150, val: 20, test: 10 };     // 背景负样本张数（第 6 类目）

  if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true, force: true });
  for (const sp of SPLITS) {
    for (const kind of ['images', 'labels']) mkdir(path.join(OUT, kind, sp));
  }

  const stats = {
    seed: SEED, target: TARGET, classes: YOLO_CLASSES, cn: CN,
    splits: {}, perClass: {}, sources: { real: 0, synthOnReal: 0, synthProcedural: 0, background: 0 },
    warnings: [],
  };

  /* ---- 1) 实拍集复制（前 3 类，下标不变 → 标签原样复制） ---- */
  const real = {};
  for (const sp of SPLITS) {
    real[sp] = loadRealSplit(sp);
    for (const it of real[sp]) {
      fs.copyFileSync(it.imgPath, path.join(OUT, 'images', sp, it.stem + '.jpg'));
      fs.copyFileSync(it.labelPath, path.join(OUT, 'labels', sp, it.stem + '.txt'));
      stats.sources.real++;
    }
  }

  /** 统计某切分中「包含某类」的图片数 */
  const classImageCount = (sp) => {
    const dir = path.join(OUT, 'labels', sp);
    const cnt = {};
    YOLO_CLASSES.forEach((c, i) => (cnt[i] = 0));
    for (const f of fs.readdirSync(dir)) {
      const set = new Set(readLabel(path.join(dir, f)).map((b) => b.c));
      for (const c of set) if (cnt[c] !== undefined) cnt[c]++;
    }
    return cnt;
  };

  /** 统计某切分的「实例（标注框）数」—— 检测任务的类别平衡应以实例数为主 */
  const classInstanceCount = (sp) => {
    const dir = path.join(OUT, 'labels', sp);
    const cnt = {};
    YOLO_CLASSES.forEach((c, i) => (cnt[i] = 0));
    for (const f of fs.readdirSync(dir)) {
      for (const b of readLabel(path.join(dir, f))) if (cnt[b.c] !== undefined) cnt[b.c]++;
    }
    return cnt;
  };

  /* ---- 2) 合成图生成器 ---- */
  let synSeq = 0;
  /**
   * 生成一张合成图并落盘
   * @param {string} sp 切分
   * @param {string} cnName 中文类名（目标类别）
   * @param {object|null} bgItem 底图（实拍）；null = 程序化背景
   */
  function emitSynthetic(sp, cnName, bgItem) {
    let rgba, W, H, inherited = [], pasted = [], source;

    if (cnName === '衬砌错台') {
      /* ---- 错台：画布级几何错动（不用贴片，理由见 applyLiningOffset 注释） ---- */
      let base;
      if (bgItem) {
        const dec = realCanvas(bgItem);
        if (!dec) return false;
        W = dec.width; H = dec.height;
        base = Buffer.from(dec.rgba);
        source = 'synthOnReal';
      } else {
        W = 640; H = 640;
        base = syn.makeBackground(null, W, H).rgba;
        source = 'synthProcedural';
      }
      const res = applyLiningOffset(base, W, H);
      rgba = res.rgba;
      const box = toYolo({
        x: Math.round(W * 0.03), y: res.seamY - res.bandH / 2,
        w: Math.round(W * 0.94), h: res.bandH, class_name: cnName,
      }, W, H);
      if (!box) return false;
      pasted = [box];
      // 底图继承的实拍框：中心落在缝以下的，跟着一起位移（否则框会和位移后的像素错开）
      if (bgItem) {
        inherited = bgItem.boxes.map((b) => {
          if (b.y * H < res.seamY) return b;
          const nx = Math.min(1 - b.w / 2, Math.max(b.w / 2, b.x + res.shift / W));
          return { ...b, x: nx };
        });
      }
    } else {
      /* ---- 其余四类：synthesizer 贴片管线 ---- */
      const pool = buildPool(cnName, 5);
      let placed = [];
      if (bgItem) {
        const dec = realCanvas(bgItem);
        if (!dec) return false;
        W = dec.width; H = dec.height;
        const avoidPx = bgItem.boxes.map((b) => toPx(b, W, H));
        const res = composeAvoiding(dec.rgba, W, H, pool, avoidPx);
        if (!res) return false;
        rgba = res.rgba; placed = res.placed;
        inherited = bgItem.boxes.slice();             // 底图实拍标注原样继承
        source = 'synthOnReal';
      } else {
        W = 640; H = 640;
        const bg = syn.makeBackground(null, W, H);
        const pl = syn.composeOne(bg, pool).placed;
        rgba = bg.rgba; placed = pl;
        source = 'synthProcedural';
      }
      pasted = placed.map((p) => toYolo(p, W, H)).filter(Boolean);
    }

    if (!pasted.length) return false;                 // 一个有效框都没有 → 丢弃
    const boxes = inherited.concat(pasted);
    const stem = `syn_${String(++synSeq).padStart(4, '0')}_${YOLO_CLASSES[IDX[cnName]]}`;
    saveJpeg(path.join(OUT, 'images', sp, stem + '.jpg'), rgba, W, H, 92);
    writeLabel(path.join(OUT, 'labels', sp, stem + '.txt'), boxes);
    stats.sources[source]++;
    return true;
  }

  /** 挑实拍底图（同切分内轮转；train 复用增广是允许的，val/test 不跨切分取用） */
  const bgCursor = {};
  function nextBg(sp) {
    const list = real[sp] || [];
    if (!list.length) return null;
    bgCursor[sp] = bgCursor[sp] || 0;
    for (let k = 0; k < list.length; k++) {
      const it = list[(bgCursor[sp] + k) % list.length];
      if (realCanvas(it)) { bgCursor[sp] = (bgCursor[sp] + k + 1) % list.length; return it; }
    }
    return null;
  }

  /* ---- 3) train：逐类补齐到 TARGET（背景负样本另算，不计入类目标） ---- */
  const cntTrain = classImageCount('train');
  const deficit = {};
  YOLO_CLASSES.forEach((name, idx) => { deficit[idx] = Math.max(0, TARGET - cntTrain[idx]); });
  stats.deficit = { ...deficit };

  for (const cnName of Object.keys(IDX)) {
    const need = deficit[IDX[cnName]] || 0;
    let made = 0, guard = 0;
    while (made < need && guard < need * 20) {
      guard++;
      // 一律用实拍底图：程序化背景是平滑灰度渐变，和真实混凝土差太远，
      // 会把「平滑底 = 缺陷」这种假线索教给模型（README 的踩坑表里记了这一条）
      if (emitSynthetic('train', cnName, nextBg('train'))) made++;
    }
    if (made < need) stats.warnings.push(`${cnName}: 计划补 ${need} 张，实际 ${made} 张`);
    stats.perClass[cnName] = { ...(stats.perClass[cnName] || {}), trainAdded: made };
  }

  /* ---- 4) val / test：为缺失类别补可测样本（指标才不是 NaN） ---- */
  for (const sp of ['val', 'test']) {
    for (const [cnName, num] of Object.entries(SYNTH_PLAN[sp])) {
      let made = 0, guard = 0;
      while (made < num && guard < num * 20) {
        guard++;
        if (emitSynthetic(sp, cnName, nextBg(sp))) made++;
      }
      stats.perClass[cnName] = { ...(stats.perClass[cnName] || {}), [sp + 'Added']: made };
    }
  }

  /* ---- 5) 背景负样本（第 6 类目）：实拍干净裁块 or 程序化干净背景，空标签 ---- */
  function emitNegative(sp) {
    // 优先：从实拍图里裁一块「不压任何标注框」的干净区域 → 真实混凝土纹理负样本
    for (let t = 0; t < 40; t++) {
      const it = nextBg(sp);
      if (!it) break;
      const dec = realCanvas(it);
      const W = dec.width, H = dec.height;
      const cw = Math.min(512, W), ch = Math.min(512, H);
      const ox = rint(0, W - cw), oy = rint(0, H - ch);
      const crop = { x: ox, y: oy, w: cw, h: ch };
      const clash = it.boxes.map((b) => toPx(b, W, H)).some((r) => coverOf(r, crop) > 0.02);
      if (clash) continue;
      const out = Buffer.alloc(cw * ch * 4);
      for (let y = 0; y < ch; y++) {
        const so = ((oy + y) * W + ox) * 4;
        out.set(dec.rgba.subarray(so, so + cw * 4), y * cw * 4);
      }
      const stem = `neg_${String(++synSeq).padStart(4, '0')}`;
      saveJpeg(path.join(OUT, 'images', sp, stem + '.jpg'), out, cw, ch, 92);
      writeLabel(path.join(OUT, 'labels', sp, stem + '.txt'), []);
      stats.sources.background++;
      return true;
    }
    // 兜底：程序化干净背景（无缺陷）
    const W = 640, H = 640;
    const bg = syn.makeBackground(null, W, H);
    const stem = `neg_${String(++synSeq).padStart(4, '0')}`;
    saveJpeg(path.join(OUT, 'images', sp, stem + '.jpg'), bg.rgba, W, H, 92);
    writeLabel(path.join(OUT, 'labels', sp, stem + '.txt'), []);
    stats.sources.background++;
    return true;
  }
  for (const sp of SPLITS) {
    let made = 0, guard = 0;
    while (made < NEG[sp] && guard < NEG[sp] * 10) { guard++; if (emitNegative(sp)) made++; }
    stats.perClass['背景'] = { ...(stats.perClass['背景'] || {}), [sp]: made };
    if (made < NEG[sp]) stats.warnings.push(`背景负样本(${sp}): 计划 ${NEG[sp]}，实际 ${made}`);
  }

  /* ---- 5b) 实例级类别平衡：按「标注框数」再校正一次 ----
   * 为什么需要第二遍：贴在实拍底图上的合成图会继承底图的实拍标注，于是补错台/白华
   * 的同时也在给裂缝/渗漏水/剥落加样本。只按「图片数」补一次，框数仍然会偏。
   * 检测模型的类别平衡应以**实例数**为准，所以这里按实例缺口迭代补齐。
   * 贴片类每图平均约 1.4 个框，错台是整幅一个错动带 → 固定 1 框/图，据此折算图片数。
   * BOX_BUDGET 限制本轮最多再加多少张，避免训练时长失控。 */
  const BOX_BUDGET = 320;
  let balAdded = 0;
  stats.balancePasses = [];
  for (let pass = 1; pass <= 3; pass++) {
    const inst = classInstanceCount('train');
    const vals = YOLO_CLASSES.map((_, i) => inst[i]);
    const mean = vals.reduce((a, b) => a + b, 0) / vals.length;
    const low = [];
    YOLO_CLASSES.forEach((name, i) => { if (vals[i] < 0.85 * mean) low.push(i); });
    stats.balancePasses.push({ pass, instances: { ...inst }, mean: Math.round(mean), topUp: low.map((i) => YOLO_CLASSES[i]) });
    if (!low.length) break;
    for (const i of low) {
      if (balAdded >= BOX_BUDGET) break;
      const cnName = Object.keys(IDX).find((k) => IDX[k] === i);
      const perImage = cnName === '衬砌错台' ? 1 : 1.4;
      const rounds = Math.min(BOX_BUDGET - balAdded, Math.max(0, Math.ceil((0.92 * mean - vals[i]) / perImage)));
      let made = 0, guard = 0;
      while (made < rounds && balAdded < BOX_BUDGET && guard < rounds * 20) {
        guard++;
        if (emitSynthetic('train', cnName, nextBg('train'))) { made++; balAdded++; }
      }
      if (made) stats.balanceAdded = { ...(stats.balanceAdded || {}), [cnName]: (stats.balanceAdded?.[cnName] || 0) + made };
    }
  }
  stats.balanceBoxBudget = BOX_BUDGET;
  stats.balanceImagesAdded = balAdded;

  /* ---- 6) 统计 + data.yaml ---- */
  for (const sp of SPLITS) {
    const cnt = classImageCount(sp);
    const inst = classInstanceCount(sp);
    const per = {}, perInst = {};
    YOLO_CLASSES.forEach((n, i) => { per[n] = cnt[i]; perInst[n] = inst[i]; });
    const lblDir = path.join(OUT, 'labels', sp);
    const emptyLabels = fs.readdirSync(lblDir).filter((f) => readLabel(path.join(lblDir, f)).length === 0).length;
    stats.splits[sp] = {
      images: fs.readdirSync(path.join(OUT, 'images', sp)).length,
      labels: fs.readdirSync(lblDir).length,
      emptyLabels,
      perClassImages: per,
      perClassInstances: perInst,
    };
  }

  const yml = [
    '# 由 tools/yolo/build-6class.js 生成',
    '# 6 类目 = 5 个病害类（YOLO nc=5）+ 背景负样本类（空标签，不计入 nc）',
    '# 类别下标与 backend/detector.js 的 TYPES 严格一致，改动必须同步',
    `path: ${OUT.replace(/\\/g, '/')}`,
    'train: images/train',
    'val: images/val',
    'test: images/test',
    '',
    'nc: 5',
    `names: [${YOLO_CLASSES.map((n) => `'${n}'`).join(', ')}]`,
    '',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'data.yaml'), yml);
  fs.writeFileSync(path.join(OUT, 'build-stats.json'), JSON.stringify(stats, null, 1));

  /* ---- 7) 打印摘要 ---- */
  console.log('════════ 6 类目数据集构建完成 ════════');
  console.log(`输出：${OUT}`);
  console.log(`随机种子 ${SEED} · 每类目标 ${TARGET} 张`);
  console.log('\n切分汇总：');
  for (const sp of SPLITS) {
    const s = stats.splits[sp];
    console.log(`  ${sp.padEnd(5)} 图片 ${String(s.images).padStart(4)} / 标签 ${String(s.labels).padStart(4)}`);
  }
  console.log('\n各类目「包含该类」的图片数：');
  console.log('  ' + '类别'.padEnd(14) + SPLITS.map((s) => s.padStart(7)).join(''));
  for (const n of YOLO_CLASSES) {
    console.log('  ' + (CN[n] + '(' + n + ')').padEnd(14) +
      SPLITS.map((sp) => String(stats.splits[sp].perClassImages[n]).padStart(7)).join(''));
  }
  console.log('  ' + '背景(负样本)'.padEnd(14) +
    SPLITS.map((sp) => String(stats.splits[sp].emptyLabels).padStart(7)).join(''));

  console.log('\n来源构成：', JSON.stringify(stats.sources));
  const ti = stats.splits.train.perClassInstances;
  const tv = YOLO_CLASSES.map((n) => ti[n]);
  const tt = tv.reduce((a, b) => a + b, 0);
  const mean = tt / tv.length;
  console.log('\ntrain 实例（标注框）分布：');
  YOLO_CLASSES.forEach((n, i) => {
    console.log(`  ${(CN[n] + '(' + n + ')').padEnd(26)} ${String(tv[i]).padStart(5)}  ${(100 * tv[i] / tt).toFixed(1)}%`);
  });
  console.log(`  ${'合计'.padEnd(24)} ${String(tt).padStart(5)}  最大/最小 = ${(Math.max(...tv) / Math.min(...tv)).toFixed(2)}（均值 ${Math.round(mean)}）`);
  if (stats.balanceImagesAdded) console.log(`  实例平衡补图：${stats.balanceImagesAdded} 张`);
  if (stats.warnings.length) {
    console.log('\n⚠ 告警：');
    stats.warnings.forEach((w) => console.log('  - ' + w));
  }
  console.log(`\ndata.yaml：${path.join(OUT, 'data.yaml')}`);
  console.log(`完整统计：${path.join(OUT, 'build-stats.json')}`);

  // 规模门槛自检
  const fails = [];
  for (const n of YOLO_CLASSES) {
    const c = stats.splits.train.perClassImages[n];
    if (c < 150) fails.push(`train ${CN[n]} 仅 ${c} 张 < 150`);
  }
  const negTrain = stats.perClass['背景'].train;
  if (negTrain < 150) fails.push(`train 背景负样本仅 ${negTrain} 张 < 150`);
  if (fails.length) { console.log('\n✗ 规模门槛未通过：\n  - ' + fails.join('\n  - ')); process.exitCode = 1; }
  else console.log('\n✓ 规模门槛通过：6 个类目 train 均 ≥150 张');
}

main();
