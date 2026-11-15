/* 隧道病害智能检测与分析系统 — 前端逻辑
 * 数据采集中心：照片流（上传照片→识别→建议→审核，轻微病害自动闭环）
 *             视频流（上传视频/实时传输→逐帧分析）
 * 识别管线：客户端 Canvas 像素级特征提取（边缘密度/暗色占比/纹理方差）
 *          → POST /api/ingest → 后端多源融合识别 → 台账/审核
 */
const API = location.origin;

const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
// 病害类型色（画在 Canvas 检测框 / chip 上）— 浅底协调版：避开品牌绿 #2F6B4F，
// 与等级色 lv1~4 (#2F7A55/#B77A16/#D9642A/#C0453C) 拉开，每个类型有自己的色相。
const TYPE_COLORS = {
  '裂缝': '#96700F',     // 深金黄（线性病害）· 白字 4.5:1
  '渗漏水': '#256E9F',   // 钢蓝（水）· 白字 5.5:1
  '剥落掉块': '#c0392b', // 砖红 · 白字 5.4:1
  '衬砌错台': '#8e44ad', // 深紫 · 白字 5.9:1
  '白华析出': '#0E7A66'  // 青绿（矿物结晶）· 白字 5.4:1
};

// canvas 绘制：浅底协调版（与 style.css 的 ink-2/ink-3/lv* 对齐）
const C = {
  ink: '#3c4a43',          // 正文色（画在浅底上的轴/标签）
  ink3: '#68776e',         // 弱化文本
  track: 'rgba(20, 32, 26, 0.06)', // bar 背景轨道
  donutBg: '#fefefd',      // 环形图内圈（= 卡片底色）
  onFill: '#ffffff',       // 检测框标签文字（画在饱和色块上）
  accent: '#2F6B4F',       // 品牌绿（置信度条/图表首色）
  accent2: '#C08A3E'       // 古金（图表次色）
};
const LEVELS = ['1级-轻微', '2级-中等', '3级-严重', '4级-危及安全'];

let mileage = 21500;        // 桩号推进（照片流/视频流共用）
let analyzedFrames = 0;     // 已分析帧计数
let videoSampler = null;    // 视频逐帧采样定时器
let liveStream = null;      // 摄像头 MediaStream
let statusFilter = '';

async function api(path, opts) {
  const r = await fetch(API + path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(body.error || r.statusText);
  return body;
}

/* ---------------- 日志 ---------------- */
function log(msg, cls = '') {
  const el = $('log');
  const t = new Date().toLocaleTimeString('zh-CN', { hour12: false });
  const line = document.createElement('div');
  line.innerHTML = `<span class="t">[${t}]</span> <span class="${cls}">${msg}</span>`;
  el.prepend(line);
  while (el.children.length > 60) el.lastChild.remove();
}
function fmtChainage(m) {
  return `K${Math.floor(m / 1000)}+${String(Math.round(m % 1000)).padStart(3, '0')}`;
}

/* ================================================================
 * 客户端影像特征提取（模拟车载边缘计算盒的 ROI 提取，接口一致）
 * 预处理流水线（对齐计划书 §3.5）：
 *   ① CLAHE 自适应增强（clipLimit=2.0, 8×8 网格）—— 解决隧道弱光/光照不均
 *   ② 高斯滤波去噪（5×5, σ≈1）
 *   ③ Sobel 梯度（对应 Canny 边缘检测环节）
 *   ④ Otsu 自动阈值分割（暗色/高亮区域二值化）
 * 判别特征：边缘密度/暗色占比/高亮占比/纹理方差/细长比/直线性/走向/填充率
 * ================================================================ */
const CELL = 12;          // 分析网格尺寸 px
const GRAD_TH = 70;       // 边缘梯度阈值
const BRIGHT_FACT = 1.25; // 高亮判系数（白华析出）
const CLAHE_TILE = 8;     // CLAHE 网格 8×8
const CLAHE_CLIP = 2.0;   // CLAHE clipLimit

function gaussian5(gray, W, H) {
  // 5×5 可分离高斯核 [1,4,6,4,1]/16（σ≈1，对齐计划书 §3.5 第二阶段）
  const k = [1, 4, 6, 4, 1];
  const tmp = new Float32Array(W * H), out = new Float32Array(W * H);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0, wsum = 0;
    for (let i = -2; i <= 2; i++) {
      const xx = Math.max(0, Math.min(W - 1, x + i));
      acc += gray[y * W + xx] * k[i + 2]; wsum += k[i + 2];
    }
    tmp[y * W + x] = acc / wsum;
  }
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    let acc = 0, wsum = 0;
    for (let i = -2; i <= 2; i++) {
      const yy = Math.max(0, Math.min(H - 1, y + i));
      acc += tmp[yy * W + x] * k[i + 2]; wsum += k[i + 2];
    }
    out[y * W + x] = acc / wsum;
  }
  return out;
}

function clahe(gray, W, H) {
  // 限制对比度自适应直方图均衡（clipLimit=2.0, 8×8 tile + 双线性插值，对齐计划书 §3.5 第一阶段）
  const tw = Math.ceil(W / CLAHE_TILE), th = Math.ceil(H / CLAHE_TILE);
  const clipLimit = CLAHE_CLIP * (tw * th) / 256;
  const maps = [];
  for (let ty = 0; ty < CLAHE_TILE; ty++) {
    for (let tx = 0; tx < CLAHE_TILE; tx++) {
      const hist = new Float32Array(256);
      let cnt = 0;
      for (let y = ty * th; y < Math.min((ty + 1) * th, H); y++)
        for (let x = tx * tw; x < Math.min((tx + 1) * tw, W); x++) { hist[gray[y * W + x] | 0]++; cnt++; }
      let excess = 0;
      for (let i = 0; i < 256; i++) if (hist[i] > clipLimit) { excess += hist[i] - clipLimit; hist[i] = clipLimit; }
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
    const ty0c = clampi(ty0, 0, CLAHE_TILE - 1), ty1c = clampi(ty0 + 1, 0, CLAHE_TILE - 1);
    for (let x = 0; x < W; x++) {
      const fx = x / tw - 0.5, tx0 = Math.floor(fx), wx = clampi(fx - tx0, 0, 1);
      const tx0c = clampi(tx0, 0, CLAHE_TILE - 1), tx1c = clampi(tx0 + 1, 0, CLAHE_TILE - 1);
      const v = gray[y * W + x] | 0;
      const v00 = maps[ty0c * CLAHE_TILE + tx0c][v], v01 = maps[ty0c * CLAHE_TILE + tx1c][v];
      const v10 = maps[ty1c * CLAHE_TILE + tx0c][v], v11 = maps[ty1c * CLAHE_TILE + tx1c][v];
      out[y * W + x] = (v00 * (1 - wx) + v01 * wx) * (1 - wy) + (v10 * (1 - wx) + v11 * wx) * wy;
    }
  }
  return out;
}

function otsu(gray, W, H) {
  // Otsu 自动阈值（对齐计划书 §3.5 第四阶段分割）
  const hist = new Float32Array(256);
  for (let i = 0; i < W * H; i++) hist[gray[i] | 0]++;
  const total = W * H;
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

function detectRois(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  const px = ctx.getImageData(0, 0, W, H).data;
  const N = W * H;
  const raw = new Float32Array(N);           // 原始灰度：保留明暗语义（暗渍/白华判别）
  let sum = 0;
  for (let i = 0; i < N; i++) {
    raw[i] = 0.299 * px[i * 4] + 0.587 * px[i * 4 + 1] + 0.114 * px[i * 4 + 2];
    sum += raw[i];
  }
  const rawMean = sum / N;
  const darkThresh = Math.min(otsu(raw, W, H), rawMean * 0.7);   // ④ Otsu 暗色分割（基于原图）
  const brightThresh = rawMean * BRIGHT_FACT;                     // 高亮（白华）基于原图
  // ① CLAHE 增强 + ② 高斯滤波：仅用于边缘/纹理检测（③），避免均衡化破坏明暗语义
  const enhanced = gaussian5(clahe(raw, W, H), W, H);
  const gray = enhanced;

  // Sobel 梯度
  const grad = new Float32Array(N);
  for (let y = 1; y < H - 1; y++) {
    for (let x = 1; x < W - 1; x++) {
      const i = y * W + x;
      const gx = -gray[i - W - 1] - 2 * gray[i - 1] - gray[i + W - 1] + gray[i - W + 1] + 2 * gray[i + 1] + gray[i + W + 1];
      const gy = -gray[i - W - 1] - 2 * gray[i - W] - gray[i - W + 1] + gray[i + W - 1] + 2 * gray[i + W] + gray[i + W + 1];
      grad[i] = Math.sqrt(gx * gx + gy * gy);
    }
  }

  // 网格单元统计：边缘/暗色/高亮/纹理
  const cw = Math.max(1, Math.floor(W / CELL)), ch = Math.max(1, Math.floor(H / CELL));
  const cellEdge = new Float32Array(cw * ch), cellDark = new Float32Array(cw * ch);
  const cellTex = new Float32Array(cw * ch), cellBright = new Float32Array(cw * ch);
  for (let cy = 0; cy < ch; cy++) {
    for (let cx = 0; cx < cw; cx++) {
      let e = 0, d = 0, b = 0, g = 0, n = 0;
      for (let y = cy * CELL; y < Math.min((cy + 1) * CELL, H); y++) {
        for (let x = cx * CELL; x < Math.min((cx + 1) * CELL, W); x++) {
          const i = y * W + x;
          if (grad[i] > GRAD_TH) e++;       // 边缘/纹理：基于 CLAHE 增强图
          if (raw[i] < darkThresh) d++;     // 暗色湿渍：基于原图 Otsu 阈值
          if (raw[i] > brightThresh) b++;   // 高亮白华：基于原图相对阈值
          g += grad[i]; n++;
        }
      }
      const k = cy * cw + cx;
      cellEdge[k] = e / n; cellDark[k] = d / n;
      cellBright[k] = b / n; cellTex[k] = g / n / 255;
    }
  }

  // 候选单元与连通域聚类
  const active = new Uint8Array(cw * ch);
  for (let k = 0; k < cw * ch; k++) {
    if (cellEdge[k] > 0.22 || cellDark[k] > 0.5 || cellBright[k] > 0.35) active[k] = 1;
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
    if (cells.length < 3) continue; // 噪声滤除

    // 聚类统计 + PCA 形态分析
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
    const elongation = Math.min(20, Math.sqrt(l1 / l2));        // 细长比
    const linearity = Math.min(1, l1 / (l1 + l2));              // 线状直线性（各向异性度）
    const theta = 0.5 * Math.atan2(2 * xy, xx - yy);            // 主轴方向：方向向量 (cosθ, sinθ)
    const axisV = Math.abs(Math.sin(theta)) >= Math.abs(Math.cos(theta)); // 主轴接近竖直
    // 走向：各向异性弱视为斜向，否则竖直=环向、水平=纵向
    const orientation = linearity >= 0.7 ? (axisV ? 'vertical' : 'horizontal') : 'diagonal';
    const bboxW = maxX - minX + 1, bboxH = maxY - minY + 1;
    const fillRatio = n / (bboxW * bboxH);                      // 前景填充率

    const bx = minX * CELL, by = minY * CELL;
    const bw = Math.min(W - bx, bboxW * CELL), bh = Math.min(H - by, bboxH * CELL);
    const edgeDensity = Math.min(1, (eSum / n) * 1.6);
    const darkRatio = Math.min(1, (dSum / n) * 1.3);
    const brightRatio = Math.min(1, (bSum / n) * 1.4);
    const textureVar = Math.min(1, (tSum / n) * 1.6);
    const score = Math.max(edgeDensity, darkRatio, brightRatio, textureVar);
    if (score < 0.42) continue;

    // 区域平均亮度相对全图 → 色度偏移代理（暗→负，亮→正；基于原图明暗语义）
    let bSum2 = 0, bn = 0;
    for (let y = by; y < by + bh; y += 2) for (let x = bx; x < bx + bw; x += 2) { bSum2 += raw[y * W + x]; bn++; }
    const hueShift = Math.max(-0.6, Math.min(0.6, (bSum2 / bn - rawMean) / rawMean));

    // 环向角度：以图幅中心为断面圆心，上=拱顶 0°，顺时针
    const ccx = bx + bw / 2 - W / 2, ccy = by + bh / 2 - H / 2;
    const angle = ((Math.atan2(ccx, -ccy) * 180 / Math.PI) + 360) % 360;

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
    });
  }
  return rois;
}

/** 依据画面全局统计模拟传感器读数（湿度↔暗色占比、温度↔亮度等） */
function sensorsFromCanvas(canvas) {
  const W = canvas.width, H = canvas.height;
  const ctx = canvas.getContext('2d', { willReadFrequently: true }).getImageData(0, 0, W, H).data;
  const N = Math.ceil(W * H / 7);
  let dark = 0, sum = 0;
  const grays = new Float32Array(N);
  for (let i = 0, k = 0; i < W * H; i += 7, k++) {
    const g = 0.299 * ctx[i * 4] + 0.587 * ctx[i * 4 + 1] + 0.114 * ctx[i * 4 + 2];
    grays[k] = g; sum += g;
  }
  const mean = sum / N;
  const otsuT = Math.min(otsu(grays, N, 1), mean * 0.8);
  for (let k = 0; k < N; k++) if (grays[k] < otsuT) dark++;
  const darkRatio = dark / N;
  return {
    humidity: Math.round((52 + darkRatio * 45) * 10) / 10,
    temperature: Math.round((20 - darkRatio * 9) * 10) / 10,
    vibration: Math.round((0.05 + Math.random() * 0.3) * 100) / 100,
    gapmm: Math.round((0.2 + Math.random() * 2.3) * 10) / 10,
  };
}

/* ---------------- 识别结果渲染 ---------------- */
function updateSensors(s) {
  $('sChainage').textContent = fmtChainage(s.mileage);
  $('sHum').textContent = s.humidity ?? '--';
  $('sTemp').textContent = s.temperature ?? '--';
  $('sVib').textContent = s.vibration ?? '--';
  $('sGap').textContent = s.gapmm ?? '--';
  $('sFrames').textContent = analyzedFrames;
}

function drawConfidence(scores) {
  const cv = $('confCanvas'), ctx = cv.getContext('2d');
  const W = cv.width, rowH = 46, top = 10;
  ctx.clearRect(0, 0, W, W);
  ctx.font = '13px sans-serif';
  Object.entries(scores).forEach(([type, v], i) => {
    const y = top + i * rowH;
    ctx.fillStyle = C.ink3; ctx.textAlign = 'left';
    ctx.fillText(type, 6, y + 14);
    ctx.fillStyle = C.track;
    ctx.fillRect(80, y, W - 130, 16);
    const w = (W - 130) * v;
    const g = ctx.createLinearGradient(80, 0, 80 + w, 0);
    g.addColorStop(0, C.accent); g.addColorStop(1, v > 0.62 ? '#2F7A55' : '#A8B8AA');
    ctx.fillStyle = g;
    ctx.fillRect(80, y, w, 16);
    ctx.fillStyle = '#c0392b'; ctx.globalAlpha = 0.55;
    ctx.fillRect(80 + (W - 130) * 0.62, y - 3, 2, 22); ctx.globalAlpha = 1;
    ctx.fillStyle = C.ink; ctx.textAlign = 'right';
    ctx.fillText(v.toFixed(2), W - 6, y + 14);
  });
  ctx.fillStyle = C.ink3; ctx.textAlign = 'left'; ctx.font = '11px sans-serif';
  ctx.fillText('竖线 = 识别阈值 0.62，超过阈值判定为对应病害类型', 80, W - 8);
}

/** 在画面 canvas 上绘制病害标注框（按 position.bbox 归一化坐标） */
function drawBoxes(cv, detections) {
  const ctx = cv.getContext('2d');
  detections.forEach((d, i) => {
    const [x, y, w, h] = d.position.bbox;
    const X = x * cv.width, Y = y * cv.height, BW = w * cv.width, BH = h * cv.height;
    const c = TYPE_COLORS[d.type] || '#fff';
    ctx.strokeStyle = c; ctx.lineWidth = 2.5;
    ctx.strokeRect(X, Y, BW, BH);
    // 标签
    const label = `${i + 1} ${d.type} ${d.level} ${(d.confidence * 100) | 0}%`;
    ctx.font = 'bold 12px sans-serif';
    const tw = ctx.measureText(label).width + 10;
    const ly = Y > 22 ? Y - 18 : Y + BH + 4;
    ctx.fillStyle = c; ctx.globalAlpha = 0.9;
    ctx.fillRect(X, ly, tw, 17); ctx.globalAlpha = 1;
    ctx.fillStyle = C.onFill;
    ctx.fillText(label, X + 5, ly + 13);
  });
}

/** 病害结果卡片（含判定依据、物理量、整治建议与审核入口） */
function defectCards(defects, { prepend = false, container = null } = {}) {
  const box = container || $('photoCards');
  const html = defects.map((d) => `
    <div class="dcard" data-id="${d.id}">
      <div class="dcard-head">
        <span class="dtype" style="color:${TYPE_COLORS[d.type]}">● ${esc(d.type)}<i class="dsub">${esc(d.subtype || '')}</i></span>
        <span class="badge lv${d.levelNo}">${esc(d.finalLevel || d.level)}</span>
        <span class="dpos">${esc(d.position.chainage)} · ${esc(d.position.sector)} · 置信度 ${d.confidence.toFixed(2)}</span>
        ${d.autoReviewed
          ? '<span class="badge st-ok">轻微 · 自动审核闭环</span>'
          : d.status === '待审核' ? '<span class="badge st-wait">待人工审核</span>'
          : d.status === '已审核' ? '<span class="badge st-ok">已审核</span>'
          : '<span class="badge st-no">已驳回</span>'}
        ${d.status === '待审核' ? `<button class="link-btn act-review" data-id="${d.id}">审核</button>` : ''}
      </div>
      ${d.physical && Object.keys(d.physical).length ? `<div class="dphys">${Object.entries(d.physical).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</div>` : ''}
      ${d.basis && d.basis.length ? `<div class="dbasis">判定依据：${d.basis.map(esc).join('；')}</div>` : ''}
      <ul class="sug-list">${d.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    </div>`).join('');
  if (prepend) {
    box.insertAdjacentHTML('afterbegin', html);
    while (box.children.length > 30) box.lastChild.remove();
  } else {
    box.insertAdjacentHTML('beforeend', html);
  }
}

/* ---------------- 上传识别公共管线 ---------------- */
let lastAnalysisWidth = 640; // 最近一次分析的画布宽（mm/px 标定基准）
async function submitFrame(rois, sensors, source, analysisWidth) {
  mileage += source === '视频流' ? 3 : 6;
  const body = JSON.stringify({
    tunnel: $('tunnelFilter').value,
    mileage, speed: 4.5, source, sensors,
    image: { rois, widthPx: analysisWidth || lastAnalysisWidth },
  });
  return api('/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body });
}

function handleAnalysisResult(resp, source, canvas) {
  analyzedFrames++;
  updateSensors({ mileage, ...resp.frame.sensors });
  drawConfidence(resp.analysis.fusionScores || {});
  const dets = resp.defects;
  if (canvas) drawBoxes(canvas, dets);
  const auto = dets.filter((d) => d.autoReviewed).length;
  const wait = dets.length - auto;
  if (dets.length) {
    for (const d of dets) {
      log(`【${source}】检出 <b>${esc(d.type)}</b>（${esc(d.level)}）@ ${esc(d.position.chainage)} ${esc(d.position.sector)}，置信度 ${d.confidence.toFixed(2)}${d.autoReviewed ? '，<span class="ok">轻微病害已自动审核闭环</span>' : '，已生成整治建议并入人工审核队列'}`, d.levelNo >= 3 ? 'dg' : d.autoReviewed ? 'ok' : 'wr');
    }
  } else {
    log(`【${source}】帧识别完成：未检出病害`, 'ok');
  }
  defectCards(dets, prependFor(source));
  refreshDefects(); refreshStats();
  return dets;
}
function prependFor(source) {
  if (source === '视频流') return { prepend: true, container: $('videoCards') };
  return { prepend: false, container: $('photoCards') };
}

/* ================================================================
 * 照片流：上传照片 → 识别 → 建议 → 审核
 * ================================================================ */
const photoZone = $('photoZone'), photoInput = $('photoInput');

photoZone.addEventListener('click', () => photoInput.click());
photoZone.addEventListener('dragover', (e) => { e.preventDefault(); photoZone.classList.add('drag'); });
photoZone.addEventListener('dragleave', () => photoZone.classList.remove('drag'));
photoZone.addEventListener('drop', (e) => {
  e.preventDefault(); photoZone.classList.remove('drag');
  if (e.dataTransfer.files[0]) loadPhoto(e.dataTransfer.files[0]);
});
photoInput.addEventListener('change', () => { if (photoInput.files[0]) loadPhoto(photoInput.files[0]); });

function loadPhoto(file) {
  const img = new Image();
  img.onload = async () => {
    const cv = $('photoCanvas');
    const maxW = 560;
    const scale = Math.min(1, maxW / img.width);
    cv.width = Math.round(img.width * scale);
    cv.height = Math.round(img.height * scale);
    cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
    cv.dataset.filled = '1';
    $('photoResultWrap').style.display = '';
    $('photoCards').innerHTML = '';

    log(`【照片流】收到照片 ${esc(file.name)}（${img.width}×${img.height}），开始特征提取与融合识别…`, 'ac');
    const rois = detectRois(cv);
    const sensors = sensorsFromCanvas(cv);
    delete sensors._mean;
    updateSensors({ mileage, ...sensors });
    if (!rois.length) {
      log('【照片流】未检出可疑病害区域：衬砌表观状态良好', 'ok');
      drawConfidence({ '裂缝': 0.1, '渗漏水': 0.1, '剥落掉块': 0.1, '衬砌错台': 0.05 });
      analyzedFrames++; $('sFrames').textContent = analyzedFrames;
      return;
    }
    try {
      const resp = await submitFrame(rois, sensors, '照片流', cv.width);
      handleAnalysisResult(resp, '照片流', cv);
    } catch (e) {
      log('【照片流】识别失败：' + esc(e.message), 'dg');
    }
  };
  img.src = URL.createObjectURL(file);
}

/* ================================================================
 * 视频流：上传视频 / 实时传输 → 逐帧分析
 * ================================================================ */
const videoEl = $('videoEl'), videoCanvas = $('videoCanvas');
const workCanvas = document.createElement('canvas'); // 逐帧分析工作画布

$('videoInput').addEventListener('change', () => {
  const f = $('videoInput').files[0];
  if (!f) return;
  stopVideo();
  videoEl.srcObject = null;
  videoEl.src = URL.createObjectURL(f);
  videoEl.loop = true;
  startVideo(`本地视频：${f.name}`);
});

$('btnLive').addEventListener('click', async () => {
  stopVideo();
  try {
    liveStream = await navigator.mediaDevices.getUserMedia({ video: { width: 640 } });
    videoEl.src = '';
    videoEl.srcObject = liveStream;
    startVideo('实时传输（摄像头画面）');
  } catch (e) {
    log('【视频流】无法打开摄像头：' + esc(e.message), 'dg');
  }
});

$('btnStopVideo').addEventListener('click', stopVideo);

// 在线视频导入（B站等，后端解析直链落地为本地同源文件后接入逐帧分析）
$('btnImportBili').addEventListener('click', async () => {
  const url = $('biliUrl').value.trim();
  if (!url) { alert('请先粘贴B站视频链接或BV号'); return; }
  log('【视频流】正在解析在线视频并导入…', 'ac');
  try {
    const r = await api('/api/import/video', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ url }),
    });
    stopVideo();
    videoEl.srcObject = null;
    videoEl.removeAttribute('src');
    videoEl.src = r.localUrl;
    videoEl.loop = false;
    startVideo(`在线导入：${r.title}`);
    log(`【视频流】导入成功《${esc(r.title)}》时长 ${r.durationSec}s / ${r.sizeKB}KB，开始逐帧病害分析`, 'ok');
  } catch (e) {
    log('【视频流】导入失败：' + esc(e.message), 'dg');
  }
});

function startVideo(title) {
  videoEl.muted = true;
  $('videoWrap').style.display = '';
  $('videoTitle').textContent = `逐帧分析（${title}）`;
  $('btnStopVideo').style.display = '';
  $('btnLive').disabled = true;
  $('videoCards').innerHTML = '';
  log(`【视频流】视频源接入：${esc(title)}，开始逐帧分析（每 0.7s 采样一帧）`, 'ac');
  // 后台标签页可能被浏览器暂停以省电，持续重试播放直至恢复
  let retries = 0;
  const tryPlay = () => {
    if ((videoEl.src || videoEl.srcObject) === null || retries > 60) return;
    videoEl.play().then(() => {
      if (videoSampler) clearInterval(videoSampler);
      videoSampler = setInterval(analyzeVideoFrame, 700);
    }).catch(() => {
      retries += 1;
      setTimeout(tryPlay, 1000);
    });
  };
  tryPlay();
}

function stopVideo() {
  if (videoSampler) { clearInterval(videoSampler); videoSampler = null; }
  if (liveStream) { liveStream.getTracks().forEach((t) => t.stop()); liveStream = null; }
  videoEl.pause();
  $('btnStopVideo').style.display = 'none';
  $('btnLive').disabled = false;
}

let lastVideoTime = -1;
function analyzeVideoFrame() {
  if (!videoEl.videoWidth) return;
  if (videoEl.srcObject === null && videoEl.ended) { stopVideo(); return; }
  // 目标分析分辨率
  const maxW = 480;
  const sc = Math.min(1, maxW / videoEl.videoWidth);
  const w = Math.round(videoEl.videoWidth * sc), h = Math.round(videoEl.videoHeight * sc);
  workCanvas.width = w; workCanvas.height = h;
  workCanvas.getContext('2d', { willReadFrequently: true }).drawImage(videoEl, 0, 0, w, h);

  // 展示画布同步当前帧
  videoCanvas.width = w; videoCanvas.height = h;
  videoCanvas.getContext('2d').drawImage(videoEl, 0, 0, w, h);
  videoCanvas.dataset.filled = '1';

  const rois = detectRois(workCanvas);
  const sensors = sensorsFromCanvas(workCanvas);
  delete sensors._mean;

  if (!rois.length) {
    analyzedFrames++;
    updateSensors({ mileage, ...sensors });
    $('videoMeta').textContent = `已分析 ${analyzedFrames} 帧 · 当前帧无病害 · ${fmtChainage(mileage)}`;
    return;
  }
  submitFrame(rois, sensors, '视频流', w)
    .then((resp) => {
      const dets = handleAnalysisResult(resp, '视频流', videoCanvas);
      $('videoMeta').textContent = `已分析 ${analyzedFrames} 帧 · 当前帧检出 ${dets.length} 处病害 · ${fmtChainage(mileage)}`;
    })
    .catch((e) => log('【视频流】帧分析失败：' + esc(e.message), 'dg'));
}

/* ---------------- 病害台账 ---------------- */
async function refreshDefects() {
  const q = new URLSearchParams();
  if (statusFilter) q.set('status', statusFilter);
  q.set('tunnel', $('tunnelFilter').value);
  const list = await api('/api/defects?' + q.toString());
  $('defectBody').innerHTML = list.map((d) => `
    <tr data-id="${d.id}">
      <td class="conf">${d.id}</td>
      <td>${esc(d.source || '巡检模拟')}</td>
      <td><span style="color:${TYPE_COLORS[d.type]}">●</span> ${esc(d.type)}<i class="dsub">${esc(d.subtype || '')}</i></td>
      <td><span class="badge lv${d.levelNo}">${esc(d.finalLevel || d.level)}</span></td>
      <td class="conf">${esc(d.position.chainage)}</td>
      <td>${esc(d.position.sector)}</td>
      <td class="conf">${d.confidence.toFixed(2)}</td>
      <td>${d.status === '待审核' ? '<span class="badge st-wait">待审核</span>'
          : d.status === '已审核' ? `<span class="badge st-ok">${d.autoReviewed ? '自动闭环' : '已审核'}</span>`
          : '<span class="badge st-no">已驳回</span>'}</td>
      <td>${d.status === '待审核' ? '<button class="link-btn act-review">审核</button>' : '<button class="link-btn act-view">查看</button>'}</td>
    </tr>`).join('') || '<tr><td colspan="9" style="text-align:center;color:var(--muted);padding:24px">暂无病害记录，请在左侧「数据采集中心」上传照片或接入视频流</td></tr>';
}

async function refreshStats() {
  const q = new URLSearchParams();
  q.set('tunnel', $('tunnelFilter').value);
  const all = await api('/api/defects?' + q.toString());
  const st = {
    total: all.length,
    pending: all.filter((d) => d.status === '待审核').length,
    ok: all.filter((d) => d.status === '已审核').length,
    severe: all.filter((d) => d.levelNo >= 3).length,
  };
  $('kpiTotal').textContent = st.total;
  $('kpiPending').textContent = st.pending;
  $('kpiReviewed').textContent = st.ok;
  $('kpiSevere').textContent = st.severe;
  drawTypeChart(all);
  drawLevelChart(all);
}

/* 统计可视化：类型分布柱状图 + 等级分布环形图（计划书 §3.7 病害统计可视化） */
function drawTypeChart(defects) {
  const cv = $('typeChart'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  const byType = {};
  for (const d of defects) byType[d.type] = (byType[d.type] || 0) + 1;
  const entries = Object.entries(byType).sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    ctx.fillStyle = C.ink3; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', cv.width / 2, cv.height / 2);
    return;
  }
  const max = entries[0][1], bw = 40, gap = (cv.width - entries.length * bw) / (entries.length + 1);
  ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
  entries.forEach(([type, n], i) => {
    const h = Math.round((cv.height - 52) * n / max);
    const x = gap + i * (bw + gap), y = cv.height - 26 - h;
    ctx.fillStyle = TYPE_COLORS[type] || C.accent;
    ctx.globalAlpha = 0.88;
    ctx.fillRect(x, y, bw, h);
    ctx.globalAlpha = 1;
    ctx.fillStyle = C.ink;
    ctx.fillText(n + ' 处', x + bw / 2, y - 5);
    ctx.fillStyle = C.ink3;
    ctx.fillText(type, x + bw / 2, cv.height - 10);
  });
}

function drawLevelChart(defects) {
  const cv = $('levelChart'), ctx = cv.getContext('2d');
  ctx.clearRect(0, 0, cv.width, cv.height);
  // 等级色 — 与 style.css --lv1..4 保持一致
  const lvColors = { 1: '#2F7A55', 2: '#A06A12', 3: '#B8501C', 4: '#C0453C' };
  const byLevel = {};
  for (const d of defects) byLevel[d.levelNo] = (byLevel[d.levelNo] || 0) + 1;
  const entries = [1, 2, 3, 4].filter((l) => byLevel[l]).map((l) => [l, byLevel[l]]);
  const total = entries.reduce((s, [, n]) => s + n, 0);
  const cx = cv.width / 2, cy = cv.height / 2, R = 58;
  if (!total) {
    ctx.fillStyle = C.ink3; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText('暂无数据', cv.width / 2, cy);
    return;
  }
  let a0 = -Math.PI / 2;
  for (const [lv, n] of entries) {
    const a1 = a0 + (n / total) * Math.PI * 2;
    ctx.beginPath();
    ctx.moveTo(cx, cy);
    ctx.arc(cx, cy, R, a0, a1);
    ctx.closePath();
    ctx.fillStyle = lvColors[lv];
    ctx.globalAlpha = 0.9;
    ctx.fill();
    ctx.globalAlpha = 1;
    // 环孔
    ctx.beginPath();
    ctx.arc(cx, cy, R * 0.55, 0, Math.PI * 2);
    ctx.fillStyle = C.donutBg;
    ctx.fill();
    // 标签
    const mid = (a0 + a1) / 2;
    ctx.fillStyle = C.ink; ctx.font = '11px sans-serif'; ctx.textAlign = 'center';
    ctx.fillText(`${lv}级 ${n}处`, cx + Math.cos(mid) * (R + 26), cy + Math.sin(mid) * (R + 26) + 4);
    a0 = a1;
  }
  ctx.fillStyle = C.ink3; ctx.font = '12px sans-serif'; ctx.textAlign = 'center';
  ctx.fillText('共' + total + '处', cx, cy + 4);
}

/* 报告导出（计划书 §3.6/§3.7：PDF/Excel 报告输出） */
async function exportExcel() {
  try {
    const r = await fetch(API + '/api/report/excel', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnel: $('tunnelFilter').value }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const blob = await r.blob();
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `隧途明鉴检测报告-${new Date().toISOString().slice(0, 10)}.xlsx`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    log(`已导出 Excel 检测报告（检测概况 + 病害明细 双 Sheet）`, 'ok');
  } catch (e) {
    log('Excel 报告导出失败：' + esc(e.message), 'dg');
  }
}

async function exportPdf() {
  try {
    const images = [];
    const pc = $('photoCanvas'), vc = $('videoCanvas');
    if (pc && pc.width && pc.dataset.filled) images.push(pc.toDataURL('image/jpeg', 0.8));
    if (vc && vc.width && vc.dataset.filled) images.push(vc.toDataURL('image/jpeg', 0.8));
    const r = await fetch(API + '/api/report/pdf', {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ tunnel: $('tunnelFilter').value, images }),
    });
    if (!r.ok) throw new Error('HTTP ' + r.status);
    const html = await r.text();
    const w = window.open('', '_blank');
    if (w) {
      w.document.write(html);
      w.document.close();
    } else {
      // 新窗口被拦截时退化为页内 iframe 承载报告
      const old = document.getElementById('reportFrame');
      if (old) old.remove();
      const f = document.createElement('iframe');
      f.id = 'reportFrame';
      f.srcdoc = html;
      f.style.cssText = 'position:fixed;inset:0;width:100%;height:100%;border:0;z-index:99;background:#fff';
      document.body.appendChild(f);
      const closeBtn = document.createElement('button');
      closeBtn.textContent = '× 关闭报告';
      closeBtn.style.cssText = 'position:fixed;top:10px;right:14px;z-index:100;padding:6px 14px;border:none;border-radius:6px;background:#1a2230;color:#fff;cursor:pointer';
      closeBtn.onclick = () => { f.remove(); closeBtn.remove(); };
      document.body.appendChild(closeBtn);
    }
    log('检测报告已生成，使用浏览器打印即可存为 PDF', 'ok');
  } catch (e) {
    log('PDF 报告生成失败：' + esc(e.message), 'dg');
  }
}

/* ---------------- 详情 / 审核弹窗 ---------------- */
function levelOptions(sel) {
  return LEVELS.map((l) => `<option value="${l}" ${l === sel ? 'selected' : ''}>${l}</option>`).join('');
}

async function openDetail(id, reviewMode) {
  const d = await api('/api/defects/' + id);
  const history = d.review
    ? `<div class="review-history">最近审核：${esc(d.review.reviewer)} · ${esc(d.review.action)} · ${esc(d.review.decision)}${d.review.note ? ' · 意见：' + esc(d.review.note) : ''} <span style="opacity:.6">${d.review.at.slice(0, 19).replace('T', ' ')}</span></div>`
    : '';
  $('mTitle').innerHTML = `病害详情 <span class="conf" style="color:var(--muted);font-size:12px">${d.id}</span>`;
  $('mBody').innerHTML = `
    <div class="detail-grid">
      <div class="item"><b>病害类型</b><span style="color:${TYPE_COLORS[d.type]}">● ${esc(d.type)}</span><i class="dsub">${esc(d.subtype || '')}</i></div>
      <div class="item"><b>评估等级</b><span class="badge lv${d.levelNo}">${esc(d.finalLevel || d.level)}</span>${d.finalLevel && d.finalLevel !== d.level ? ` <span style="font-size:11px;color:var(--muted)">(系统初判 ${esc(d.level)})</span>` : ''}</div>
      ${d.physical && Object.keys(d.physical).length ? `<div class="item"><b>量测结果</b>${Object.entries(d.physical).map(([k, v]) => `${esc(k)} ${esc(v)}`).join(' · ')}</div>` : ''}
      <div class="item"><b>识别置信度</b><span class="conf">${d.confidence.toFixed(2)}</span></div>
      <div class="item"><b>数据来源</b>${esc(d.source || '巡检模拟')}</div>
      <div class="item"><b>位置桩号</b><span class="conf">${esc(d.position.chainage)}</span></div>
      <div class="item"><b>环向方位</b>${esc(d.position.sector)}（${d.position.angleDeg}°）</div>
      <div class="item"><b>发现时间</b>${esc(d.detectedAt.slice(0, 19).replace('T', ' '))}</div>
      <div class="item"><b>当前状态</b>${esc(d.status)}</div>
    </div>
    <div class="sec-title">判定依据</div>
    <ul class="sug-list">${(d.basis || []).map((s) => `<li>${esc(s)}</li>`).join('') || '<li>多源融合证据</li>'}</ul>
    <div class="sec-title">证据链（多源融合）</div>
    ${[['image', '影像特征'], ['sensor', '传感器证据'], ['fused', '融合置信度']].map(([k, name]) =>
      `<div class="ev-bar"><span class="name">${name}</span><div class="track"><div class="fill" style="width:${(d.evidence[k] * 100).toFixed(0)}%"></div></div><span class="conf">${d.evidence[k].toFixed(2)}</span></div>`
    ).join('')}
    <div class="sec-title">整治建议方案（${d.finalLevel || d.level}）</div>
    <ul class="sug-list">${d.suggestions.map((s) => `<li>${esc(s)}</li>`).join('')}</ul>
    ${history}
    ${reviewMode ? `
    <div class="sec-title">人工审核与处置决策</div>
    <div class="review-form">
      <label>审核人</label><input id="rReviewer" placeholder="如：张工（隧道养护科）">
      <label>等级核定</label><select id="rLevel">${levelOptions(d.level)}</select>
      <label>处置决策</label><select id="rDecision">
        <option>按建议方案纳入整治计划</option>
        <option>纳入月度整治计划</option>
        <option>立即处置（应急）</option>
        <option>继续观测，暂不处置</option>
        <option>退回复检</option>
      </select>
      <label>审核意见</label><textarea id="rNote" placeholder="填写审核意见与处置要求…"></textarea>
      <div class="review-actions">
        <button class="btn primary" id="rPass">✓ 通过并敲定决策</button>
        <button class="btn danger" id="rReject">✕ 驳回复检</button>
      </div>
    </div>` : ''}
  `;
  $('modalMask').classList.add('show');
  if (reviewMode) {
    $('rPass').onclick = () => submitReview(id, '通过');
    $('rReject').onclick = () => submitReview(id, '驳回');
  }
}

async function submitReview(id, action) {
  const reviewer = $('rReviewer').value.trim();
  if (!reviewer) { alert('请填写审核人'); return; }
  const body = {
    reviewer, action,
    levelOverride: $('rLevel').value,
    decision: $('rDecision').value,
    note: $('rNote').value.trim(),
  };
  await api(`/api/defects/${id}/review`, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
  log(`病害 <b>${id}</b> 人工审核${action}，决策：${esc(body.decision)}`, action === '通过' ? 'ok' : 'dg');
  $('modalMask').classList.remove('show');
  refreshDefects(); refreshStats();
}

/* ---------------- 事件绑定 ---------------- */
$('mClose').onclick = () => $('modalMask').classList.remove('show');
$('modalMask').onclick = (e) => { if (e.target === $('modalMask')) $('modalMask').classList.remove('show'); };
$('tunnelFilter').onchange = () => { refreshDefects(); refreshStats(); };
$('btnExcel').onclick = exportExcel;
$('btnPdf').onclick = exportPdf;

// 采集中心选项卡切换
document.querySelectorAll('[data-srctab]').forEach((btn) => {
  btn.addEventListener('click', () => {
    document.querySelectorAll('[data-srctab]').forEach((b) => b.classList.remove('active'));
    btn.classList.add('active');
    const isPhoto = btn.dataset.srctab === 'photo';
    $('tabPhoto').style.display = isPhoto ? '' : 'none';
    $('tabVideo').style.display = isPhoto ? 'none' : '';
    if (!isPhoto) stopVideo(); // 切走时停止视频分析
  });
});

// 台账状态过滤
$('statusTabs').addEventListener('click', (e) => {
  if (!e.target.classList.contains('tab')) return;
  document.querySelectorAll('#statusTabs .tab').forEach((t) => t.classList.remove('active'));
  e.target.classList.add('active');
  statusFilter = e.target.dataset.status;
  refreshDefects();
});

// 台账行点击 / 卡片审核按钮
$('defectBody').addEventListener('click', (e) => {
  const tr = e.target.closest('tr');
  if (!tr || !tr.dataset.id) return;
  const reviewMode = e.target.classList.contains('act-review') || !!tr.querySelector('.act-review');
  openDetail(tr.dataset.id, !!reviewMode);
});
document.addEventListener('click', (e) => {
  const btn = e.target.closest('.act-review[data-id]');
  if (btn) openDetail(btn.dataset.id, true);
});

/* ---------------- 初始化 ---------------- */
(async function init() {
  log('系统就绪：请在「数据采集中心」上传照片（照片流）或接入视频（视频流）', 'ac');
  log('审核规则：1级轻微病害系统自动审核闭环；2级及以上进入人工审核队列', '');
  await refreshDefects().catch(() => {});
  await refreshStats().catch(() => {});
  setInterval(refreshStats, 8000);
})();
