/**
 * mask.js — 裂缝区域实例掩码分割提取与掩码级几何参数计算（纯 JS，零依赖）
 *
 * 目标（科研核查第 3/4 项补齐）：
 *   3. 裂缝区域掩码分割提取：对每个检测框内做 阈值分割 → 8 邻域连通域 → 取缺陷实例掩码
 *   4. 掩码级几何参数：面积/长度/宽度不再是 bbox 代理值，而按掩码像素实测：
 *        面积 = 连通域像素数 × mmPx²
 *        长度 = 连通域凸包直径（最大点对欧氏距离）× mmPx   —— 贴合裂缝走向的真实延展
 *        宽度 = 面积 / 长度（等效平均宽度）× 1（量纲自洽）
 *
 * 输入输出：
 *   extract(rgba, W, H, dets, mmPx)
 *     rgba   缩放后 RGBA 位图（infer.detectImage 内部 ≤640 分析图）
 *     dets   fusion 检测数组（position.bbox 归一化 [x,y,w,h]）
 *     mmPx   每像素毫米数（视场宽标定换算）
 *   返回 { masks: [...逐检测掩码对象或 null], overlayPng: Buffer|null }
 *
 * 掩码对象：{ area_px, area_mm2, length_mm, width_mm, coverage, note? }（null=该框未分割出实例）
 */
const vision = require('./vision');

/** 病害类别配色（与前端类型色板同族的固定 RGB） */
const PALETTE = {
  裂缝: [220, 60, 50],
  渗漏水: [40, 110, 220],
  剥落: [230, 150, 30],
  掉块: [230, 150, 30],
  施工缝: [120, 90, 200],
  麻面: [90, 170, 80],
};

/** 8 邻域偏移 */
const NB8 = [[-1, -1], [0, -1], [1, -1], [-1, 0], [1, 0], [-1, 1], [0, 1], [1, 1]];

/**
 * 单调链凸包（Andrew），输入像素点数组，返回逆时针凸包顶点
 * @param {Array<[number,number]>} pts 点集
 * @returns {Array<[number,number]>} 凸包顶点
 */
function convexHull(pts) {
  if (pts.length < 3) return pts.slice();
  const p = pts.slice().sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const cross = (o, a, b) => (a[0] - o[0]) * (b[1] - o[1]) - (a[1] - o[1]) * (b[0] - o[0]);
  const lower = [];
  for (const pt of p) {
    while (lower.length >= 2 && cross(lower[lower.length - 2], lower[lower.length - 1], pt) <= 0) lower.pop();
    lower.push(pt);
  }
  const upper = [];
  for (let i = p.length - 1; i >= 0; i--) {
    const pt = p[i];
    while (upper.length >= 2 && cross(upper[upper.length - 2], upper[upper.length - 1], pt) <= 0) upper.pop();
    upper.push(pt);
  }
  lower.pop(); upper.pop();
  return lower.concat(upper);
}

/**
 * 在 ROI 内做阈值分割 + 连通域，返回**全部合格连通域的并集**（P2-1 多实例掩码）。
 * 极性自适应：分别按「暗为前景」「亮为前景」两种二值取合格连通域集合，
 * 选与 ROI 边框环带均值反差更大的一侧（缺陷应与周边衬砌明显不同）。
 * 断续裂缝（工程上极常见）在框内呈多段，并集才能反映整体延展：
 *   面积 area = Σ 各段面积；长度 = 并集点集凸包直径；一致性 = Σ面积 / 并集凸包面积。
 * @param {Float32Array} gray ROI 灰度（row-major，局部坐标）
 * @param {number} rw,rh ROI 尺寸
 * @returns {{pts:Array<[number,number]>, area:number, polarity:string,
 *            instances:number, consistency:number}|null}
 */
function largestComponent(gray, rw, rh) {
  // 边框环带均值（外圈 2px）作为衬砌背景参考
  let ring = 0, ringN = 0;
  for (let y = 0; y < rh; y++) {
    for (let x = 0; x < rw; x++) {
      if (x < 2 || y < 2 || x >= rw - 2 || y >= rh - 2) { ring += gray[y * rw + x]; ringN++; }
    }
  }
  const ringMean = ringN ? ring / ringN : 128;
  const otsu = vision.otsuThreshold(gray, rw * rh);

  const pickBest = (below) => {
    const lab = new Int32Array(rw * rh).fill(-1);
    let best = null;
    const comps = [];
    for (let s = 0; s < rw * rh; s++) {
      if (lab[s] !== -1) continue;
      const isFg = below ? gray[s] < otsu : gray[s] > otsu;
      if (!isFg) { lab[s] = -2; continue; }
      // BFS 连通域
      const comp = [];
      const stack = [s];
      lab[s] = 1;
      while (stack.length) {
        const cur = stack.pop();
        const cx = cur % rw, cy = (cur / rw) | 0;
        comp.push([cx, cy]);
        for (const [dx, dy] of NB8) {
          const nx = cx + dx, ny = cy + dy;
          if (nx < 0 || ny < 0 || nx >= rw || ny >= rh) continue;
          const ni = ny * rw + nx;
          if (lab[ni] !== -1) continue;
          const fg = below ? gray[ni] < otsu : gray[ni] > otsu;
          if (fg) { lab[ni] = 1; stack.push(ni); }
          else lab[ni] = -2;
        }
      }
      if (comp.length >= 6) {
        comps.push({ pts: comp, area: comp.length });
        if (!best || comp.length > best.area) best = { pts: comp, area: comp.length };
      }
    }
    return { best, comps };
  };

  // 两极性各取连通域集合，按「最大组件均值与背景环带反差 × 面积权重」择优极性；
  // 选中极性的**全部**合格组件并入并集（P2-1：修正断续裂缝长度被单最大段低估的问题）
  const dark = pickBest(true);
  const bright = pickBest(false);
  const score = (c) => {
    if (!c) return -1;
    let sum = 0;
    for (const [x, y] of c.pts) sum += gray[y * rw + x];
    const cm = sum / c.area;
    return Math.abs(cm - ringMean) * Math.sqrt(c.area);
  };
  const sd = score(dark.best), sb = score(bright.best);
  if (sd < 0 && sb < 0) return null;
  const win = sd >= sb ? dark : bright;
  const polarity = sd >= sb ? 'dark' : 'bright';
  const comps = win.comps.length ? win.comps : (win.best ? [win.best] : []);
  if (!comps.length) return null;
  const pts = [].concat(...comps.map((c) => c.pts));
  const area = comps.reduce((a, c) => a + c.area, 0);
  // 一致性 = Σ面积 / 并集凸包面积（多段离散程度：单段=1，越离散越小，供等级证据使用）
  let consistency = 1;
  if (comps.length > 1 && pts.length >= 3) {
    const hull = convexHull(pts);
    let hullArea = 0;
    for (let i = 0; i < hull.length; i++) {
      const a = hull[i], b = hull[(i + 1) % hull.length];
      hullArea += a[0] * b[1] - b[0] * a[1];
    }
    hullArea = Math.abs(hullArea) / 2;
    if (hullArea > 1e-6) consistency = Math.min(1, area / hullArea);
  }
  return { pts, area, polarity, instances: comps.length, consistency: Math.round(consistency * 1000) / 1000 };
}

/**
 * 对全部检测做实例掩码提取与几何参数计算，并生成上色叠加 PNG
 * @param {Uint8Array|Buffer} rgba 全图 RGBA
 * @param {number} W,H 全图尺寸
 * @param {Array} dets fusion 检测数组（position.bbox 归一化）
 * @param {number} mmPx 每像素毫米数
 * @returns {{masks:Array<object|null>, overlayPng:Buffer|null}}
 */
function extract(rgba, W, H, dets, mmPx) {
  const masks = new Array(dets.length).fill(null);
  if (!dets.length) return { masks, overlayPng: null };

  // 叠加图底图：调暗原图
  const out = new Uint8Array(W * H * 4);
  for (let i = 0; i < W * H; i++) {
    out[i * 4] = rgba[i * 4] * 0.35 | 0;
    out[i * 4 + 1] = rgba[i * 4 + 1] * 0.35 | 0;
    out[i * 4 + 2] = rgba[i * 4 + 2] * 0.35 | 0;
    out[i * 4 + 3] = 255;
  }

  let painted = 0;
  dets.forEach((d, di) => {
    const bb = (d.position && d.position.bbox) || d.bbox;
    if (!bb) return;
    const x0 = Math.max(0, Math.floor(bb[0] * W)), y0 = Math.max(0, Math.floor(bb[1] * H));
    const x1 = Math.min(W, Math.ceil((bb[0] + bb[2]) * W)), y1 = Math.min(H, Math.ceil((bb[1] + bb[3]) * H));
    const rw = x1 - x0, rh = y1 - y0;
    if (rw < 4 || rh < 4) return;

    // ROI 灰度
    const gray = new Float32Array(rw * rh);
    for (let y = 0; y < rh; y++) {
      for (let x = 0; x < rw; x++) {
        const gi = (y0 + y) * W + (x0 + x);
        gray[y * rw + x] = 0.299 * rgba[gi * 4] + 0.587 * rgba[gi * 4 + 1] + 0.114 * rgba[gi * 4 + 2];
      }
    }
    const comp = largestComponent(gray, rw, rh);
    if (!comp) return;

    // 几何参数：面积 / 凸包直径(长度) / 面积÷长度(等效宽度)
    const hull = convexHull(comp.pts);
    let d2max = 0;
    for (let i = 0; i < hull.length; i++) {
      for (let j = i + 1; j < hull.length; j++) {
        const dx = hull[i][0] - hull[j][0], dy = hull[i][1] - hull[j][1];
        const d2 = dx * dx + dy * dy;
        if (d2 > d2max) d2max = d2;
      }
    }
    const lenPx = Math.sqrt(d2max);
    const widPx = comp.area / Math.max(1e-6, lenPx); // 等效平均宽度（面积/长度）
    masks[di] = {
      area_px: comp.area,
      area_mm2: Math.round(comp.area * mmPx * mmPx * 100) / 100,
      length_mm: Math.round(lenPx * mmPx * 100) / 100,
      width_mm: Math.round(widPx * mmPx * 100) / 100,
      coverage: Math.round((comp.area / (rw * rh)) * 1000) / 1000,
      polarity: comp.polarity,
      // P2-1 多实例字段：instances=合格连通域段数；consistency=Σ面积/并集凸包面积
      instances: comp.instances || 1,
      consistency: comp.consistency != null ? comp.consistency : 1,
    };

    // 上色：该实例掩码像素
    const color = PALETTE[d.type] || [200, 200, 60];
    for (const [lx, ly] of comp.pts) {
      const o = ((y0 + ly) * W + (x0 + lx)) * 4;
      out[o] = color[0]; out[o + 1] = color[1]; out[o + 2] = color[2];
      painted++;
    }
  });

  // RGBA → RGB 紧缩后编码 PNG（encodePngRGB 只收 RGB）
  let overlayPng = null;
  if (painted) {
    const rgb = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) {
      rgb[i * 3] = out[i * 4];
      rgb[i * 3 + 1] = out[i * 4 + 1];
      rgb[i * 3 + 2] = out[i * 4 + 2];
    }
    overlayPng = vision.encodePngRGB(W, H, rgb);
  }
  return { masks, overlayPng };
}

module.exports = { extract, PALETTE };
