/**
 * experiment.js — 模块二：虚实结合实训台（会话管理 / 操作日志 / 实验报告 PDF）
 *
 * 职责：
 *   1. 实训会话：创建（记录初始参数快照 + 训练样本图缓存）→ 调参运行（写 experiment_log）
 *      → 查询操作轨迹（支持参数快照回放）→ 关闭会话
 *   2. 实验报告：会话数据渲染为 A4 位图页（中文用 glyphs 位图字体光栅化）→ pdf.buildPdf
 *      报告含：会话信息 / 操作轨迹表 / 参数-检出数量对照（条形图+表）/ 学生自评 / 教师评语留白
 *
 * 依赖：db.js（node:sqlite）、infer.js（参数化推理）、pdf.js、raster-text.js
 */
const fs = require('fs');
const path = require('path');
const { performance } = require('perf_hooks');
const db = require('./db');
const infer = require('./infer');
const vision = require('./vision');
const raster = require('./raster-text');
const glyphs = require('./glyphs');
const { buildPdf } = require('./pdf');

const DEFAULT_SAMPLE = path.join(__dirname, 'data', 'w0_sample_tunnel.png');
const A4_W_PT = 595.28, A4_H_PT = 841.89;
const SCALE = 2;                          // 页面渲染放大倍数（144dpi，中文清晰）
const PX_W = Math.round(A4_W_PT * SCALE); // 1191
const PX_H = Math.round(A4_H_PT * SCALE); // 1684

/** 会话样本图缓存（session_id -> {dataUrl,w,h,tunnel}），上限 32 个（LRU 简化：满则清最旧） */
const sessionImages = new Map();
function cacheImage(sid, val) {
  if (sessionImages.size >= 32) {
    const first = sessionImages.keys().next().value;
    sessionImages.delete(first);
  }
  sessionImages.set(sid, val);
}

function httpErr(status, message) { const e = new Error(message); e.status = status; return e; }
function now() { return new Date().toISOString(); }
function fmtTs(iso) {
  try { return new Date(iso).toLocaleString('zh-CN', { hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit' }); }
  catch (e) { return String(iso || ''); }
}

/* ================= 会话 ================= */
/**
 * 创建实训会话
 * @param {object} body {user_name?, tunnel?, image?:{dataUrl}, params?}
 * @returns {object} {session_id, user_name, tunnel, start_time, params_snapshot, image:{width,height,defaulted}}
 */
function createSession(body = {}) {
  const userName = String(body.user_name || '学生').slice(0, 40);
  const tunnel = String(body.tunnel || '实训隧道').slice(0, 40);
  // 用户（不存在则建，角色 student）
  let user = db.get('SELECT * FROM users WHERE name = ? LIMIT 1', userName);
  if (!user) {
    const uid = db.insert('users', { name: userName, role: 'student', token: null });
    user = { user_id: uid, name: userName, role: 'student' };
  }
  // 样本图：优先上传 PNG；否则使用内置演示样本（合成样本，见合规说明）
  let img = null, defaulted = false;
  const dataUrl = body.image && body.image.dataUrl;
  if (typeof dataUrl === 'string' && dataUrl.length > 64) {
    const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
    const png = Buffer.from(b64, 'base64');
    const dec = vision.decodePng(png); // 校验合法
    img = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), w: dec.width, h: dec.height, synthetic: false };
  } else {
    const png = fs.readFileSync(DEFAULT_SAMPLE);
    const dec = vision.decodePng(png);
    img = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), w: dec.width, h: dec.height, synthetic: true };
    defaulted = true;
  }
  const params = infer.normalizeParams(body.params);
  const sid = db.insert('experiment_session', {
    user_id: user.user_id,
    start_time: now(),
    end_time: null,
    params_snapshot: JSON.stringify({ ...params, tunnel, image_synthetic: img.synthetic }),
  });
  cacheImage(sid, img);
  // 初始快照也写一条日志（审计起点）
  db.insert('experiment_log', {
    session_id: sid, ts: now(), action: 'create',
    params: JSON.stringify({ ...params, tunnel }), result_summary: JSON.stringify({ image: `${img.w}x${img.h}`, synthetic: img.synthetic }),
  });
  const startRow = db.get('SELECT start_time FROM experiment_session WHERE session_id=?', sid);
  return {
    session_id: sid, user_name: user.name, tunnel,
    start_time: fmtTs(startRow ? startRow.start_time : now()),
    params_snapshot: params,
    image: { width: img.w, height: img.h, synthetic: img.synthetic, defaulted, note: img.synthetic ? '内置演示样本为合成样本：仅实训演示与数据增强用' : '' },
  };
}

/**
 * 按参数运行一次推理并写操作日志
 * @param {object} body {session_id, params?, action?}
 * @returns {object} {log_id, ts, params, result:{taskId,detectionCount,avgConfidence,elapsedMs,byClass,thumbnail}}
 */
async function runExperiment(body = {}) {
  const t0 = performance.now();
  const sid = Number(body.session_id);
  if (!sid) throw httpErr(400, '缺少 session_id');
  const row = db.get('SELECT * FROM experiment_session WHERE session_id = ?', sid);
  if (!row) throw httpErr(404, '会话不存在');
  let img = sessionImages.get(sid);
  if (!img) {
    // 进程重启后缓存丢失：回退默认演示样本（保持会话可继续）
    const png = fs.readFileSync(DEFAULT_SAMPLE);
    const dec = vision.decodePng(png);
    img = { dataUrl: 'data:image/png;base64,' + png.toString('base64'), w: dec.width, h: dec.height, synthetic: true };
    cacheImage(sid, img);
  }
  const params = infer.normalizeParams(body.params);
  const snap = (() => { try { return JSON.parse(row.params_snapshot || '{}'); } catch (e) { return {}; } })();
  const tunnel = snap.tunnel || '实训隧道';
  const dr = await infer.detectImage({ tunnel, image: { dataUrl: img.dataUrl }, params });
  const confs = dr.detections.map((d) => d.confidence);
  const summary = {
    taskId: dr.taskId,
    detectionCount: dr.summary.detectionCount,
    byClass: dr.summary.byClass,
    avgConfidence: confs.length ? Math.round((confs.reduce((a, b) => a + b, 0) / confs.length) * 1000) / 1000 : 0,
    elapsedMs: dr.elapsedMs,
  };
  const logId = db.insert('experiment_log', {
    session_id: sid, ts: now(), action: String(body.action || 'detect'),
    params: JSON.stringify(params), result_summary: JSON.stringify(summary),
  });
  // 结果缩略图（前端快速展示；大图走 W0 缓存接口）
  const origItem = (dr.intermediates || []).find((it) => it.key === 'original');
  let thumbnail = null;
  if (origItem && origItem.dataUrl) {
    const b64 = origItem.dataUrl.split(',')[1];
    const dec = vision.decodePng(Buffer.from(b64, 'base64'));
    const sc = vision.downscaleRGBA(dec.rgba, dec.width, dec.height, 360);
    thumbnail = 'data:image/png;base64,' + vision.encodePngRGB(sc.width, sc.height, vision.rgbFromRgba(sc.data)).toString('base64');
  }
  return {
    log_id: logId,
    session_id: sid,
    ts: fmtTs(new Date().toISOString()),
    params,
    result: { ...summary, thumbnail, elapsedTotalMs: Math.round(performance.now() - t0) },
  };
}

/**
 * 查询会话与操作轨迹（支持参数快照回放：log.params 可直接载入滑杆）
 * @param {number} sessionId
 */
function getLogs(sessionId) {
  const sid = Number(sessionId);
  const row = db.get('SELECT * FROM experiment_session WHERE session_id = ?', sid);
  if (!row) throw httpErr(404, '会话不存在');
  const logs = db.all('SELECT * FROM experiment_log WHERE session_id = ? ORDER BY log_id ASC', sid).map((l) => {
    let params = {}, summary = {};
    try { params = JSON.parse(l.params || '{}'); } catch (e) { /* 忽略 */ }
    try { summary = JSON.parse(l.result_summary || '{}'); } catch (e) { /* 忽略 */ }
    return { log_id: l.log_id, ts: fmtTs(l.ts), action: l.action, params, summary };
  });
  const user = row.user_id ? db.get('SELECT name FROM users WHERE user_id=?', row.user_id) : null;
  let snap = {}; try { snap = JSON.parse(row.params_snapshot || '{}'); } catch (e) { /* 忽略 */ }
  const detects = logs.filter((l) => l.action === 'detect');
  return {
    session: {
      session_id: row.session_id, user_name: user ? user.name : '学生',
      start_time: fmtTs(row.start_time), end_time: row.end_time ? fmtTs(row.end_time) : null,
      tunnel: snap.tunnel || '实训隧道', params_snapshot: snap,
      image_synthetic: !!snap.image_synthetic,
    },
    logs,
    stats: {
      runs: detects.length,
      totalDetections: detects.reduce((a, l) => a + (l.summary.detectionCount || 0), 0),
      avgElapsedMs: detects.length ? Math.round(detects.reduce((a, l) => a + (l.summary.elapsedMs || 0), 0) / detects.length) : 0,
    },
  };
}

/** 结束会话（写 end_time） */
function closeSession(sessionId) {
  const sid = Number(sessionId);
  const row = db.get('SELECT * FROM experiment_session WHERE session_id = ?', sid);
  if (!row) throw httpErr(404, '会话不存在');
  if (!row.end_time) db.run('UPDATE experiment_session SET end_time=? WHERE session_id=?', now(), sid);
  return getLogs(sid);
}

/* ================= 实验报告（位图页渲染 → PDF） ================= */
/** 页面画布工具（RGBA，白底） */
function makePage() {
  const rgba = Buffer.alloc(PX_W * PX_H * 4, 255);
  for (let i = 0; i < PX_W * PX_H; i++) rgba[i * 4 + 3] = 255;
  const api = {
    fill(x, y, w, h, [r, g, b]) {
      for (let j = 0; j < h; j++) for (let i = 0; i < w; i++) {
        const xx = x + i, yy = y + j;
        if (xx < 0 || yy < 0 || xx >= PX_W || yy >= PX_H) continue;
        const o = (yy * PX_W + xx) * 4;
        rgba[o] = r; rgba[o + 1] = g; rgba[o + 2] = b;
      }
    },
    rect(x, y, w, h, color, lw = 2) {
      api.fill(x, y, w, lw, color);
      api.fill(x, y + h - lw, w, lw, color);
      api.fill(x, y, lw, h, color);
      api.fill(x + w - lw, y, lw, h, color);
    },
    hline(x, y, w, color, lw = 2) { api.fill(x, y, w, lw, color); },
    text(x, y, str, fontPx, color, opacity = 1) { return raster.draw(rgba, PX_W, PX_H, x, y, str, fontPx, color, opacity); },
  };
  return { rgba, api };
}

const MISSING = new Set();
/** 带缺字检测的文本绘制（缺字计数用于验证报告可读性） */
function safeText(page, x, y, str, fontPx, color) {
  for (const ch of String(str || '')) {
    if (!glyphs.GLYPHS[ch] && ch !== ' ' && ch !== '\n') MISSING.add(ch);
  }
  return page.text(x, y, str, fontPx, color);
}

const INK = [26, 34, 48], BLUE = [47, 84, 150], GRAY = [110, 120, 135], LINE = [200, 208, 220];

/**
 * 生成实训实验报告 PDF
 * @param {number} sessionId
 * @param {object} body {student_name?, self_eval?}
 * @returns {{pdf:Buffer, pages:number, missingChars:string[]}}
 */
function buildReport(sessionId, body = {}) {
  MISSING.clear();
  const data = getLogs(sessionId);
  const s = data.session;
  const student = String(body.student_name || s.user_name || '学生').slice(0, 30);
  const selfEval = String(body.self_eval || '').slice(0, 400);
  return renderReport(data, { student, selfEval, sessionId: s.session_id });
}

/** 报告渲染（结构化：逐页生成位图 → PDF） */
function renderReport(data, opt) {
  const s = data.session;
  const detects = data.logs.filter((l) => l.action === 'detect');
  const pages = [];
  const newPage = () => { const p = makePage(); pages.push(p); return p; };

  /* ---- 第 1 页：标题 + 会话信息 + 初始参数 ---- */
  {
    const pg = newPage();
    const { api } = pg;
    api.fill(0, 0, PX_W, 12, BLUE);
    safeText(api, 64, 66, '隧途明鉴 · 虚实结合实训台', 40, BLUE);
    safeText(api, 64, 132, '参数探究实训 · 实验报告', 30, INK);
    safeText(api, 64, 184, '生成时间 ' + fmtTs(now()) + ' · 参照《公路隧道养护技术规范》（JTG H12）分级精神', 17, GRAY);
    api.hline(64, 230, PX_W - 128, LINE, 3);
    let y = 266;
    safeText(api, 64, y, '一、会话信息', 24, BLUE); y += 48;
    const infoRows = [
      ['会话编号', 'EXP-' + String(opt.sessionId).padStart(6, '0')],
      ['学生姓名', opt.student],
      ['实训隧道', s.tunnel],
      ['开始时间', s.start_time],
      ['结束时间', s.end_time || '（未结束，按当前数据生成）'],
      ['检测运行', data.stats.runs + ' 次 · 累计检出 ' + data.stats.totalDetections + ' 处 · 平均推理 ' + data.stats.avgElapsedMs + ' ms'],
      ['样本说明', s.image_synthetic ? '内置演示样本（合成样本，仅实训与数据增强用）' : '学生上传样本'],
    ];
    for (const [k, v] of infoRows) {
      safeText(api, 84, y, k, 19, GRAY);
      safeText(api, 270, y, String(v), 19, INK);
      y += 38;
    }
    y += 10;
    safeText(api, 64, y, '二、初始参数快照（创建会话时记录，可回放复现）', 24, BLUE); y += 46;
    const p = s.params_snapshot || {};
    const paramRows = [
      ['置信度阈值', p.confidenceThreshold],
      ['IoU 阈值(NMS)', p.iouThreshold === null || p.iouThreshold === undefined ? '关闭' : p.iouThreshold],
      ['CLAHE clipLimit', p.claheClipLimit],
      ['CLAHE 网格', p.claheTileGridSize + '×' + p.claheTileGridSize],
      ['高斯核', p.gaussianKernelSize + '×' + p.gaussianKernelSize],
      ['Canny/Sobel 阈值', p.cannyThreshold],
      ['Otsu 分割', p.otsuEnabled ? '开启' : '关闭'],
    ];
    for (const [k, v] of paramRows) {
      api.hline(84, y + 28, PX_W - 188, LINE, 1);
      safeText(api, 84, y, k, 19, INK);
      safeText(api, 430, y, String(v), 19, BLUE);
      y += 38;
    }
  }

  /* ---- 操作轨迹表（每页 22 行，可跨页） ---- */
  const COLS = [
    ['#', 64, 44], ['时间', 108, 168], ['置信度', 276, 84], ['CLAHE', 360, 78],
    ['网格', 438, 64], ['高斯', 502, 64], ['Canny', 566, 76], ['Otsu', 642, 62],
    ['检出', 704, 64], ['均置信度', 768, 96], ['耗时ms', 864, 84], ['动作', 948, 120],
  ];
  const ROWS_PER_PAGE = 22;
  let logIdx = 0;
  let pageNo = 0;
  const traceLogs = data.logs.filter((l) => l.action === 'detect' || l.action === 'create');
  while (logIdx < traceLogs.length || pageNo === 0) {
    const pg = newPage();
    const { api } = pg;
    safeText(api, 64, 60, '三、操作轨迹' + (pageNo > 0 ? '（续 ' + (pageNo + 1) + '）' : ''), 24, BLUE);
    // 表头
    const hy = 118;
    api.fill(64, hy, PX_W - 128, 40, BLUE);
    for (const [name, x, w] of COLS) safeText(api, x + 6, hy + 9, name, 17, [255, 255, 255]);
    // 行
    let y = hy + 46;
    const rows = traceLogs.slice(logIdx, logIdx + ROWS_PER_PAGE);
    for (const l of rows) {
      const zebra = ((logIdx / 1) % 2 === 1);
      if (zebra) api.fill(64, y - 4, PX_W - 128, 34, [244, 247, 251]);
      const p = l.params || {}, sm = l.summary || {};
      const cells = [
        String(l.log_id), l.ts,         String(p.confidenceThreshold ?? ''),
        String(p.claheClipLimit ?? ''),
        p.claheTileGridSize != null ? p.claheTileGridSize + '×' + p.claheTileGridSize : '',
        p.gaussianKernelSize != null ? p.gaussianKernelSize + '×' + p.gaussianKernelSize : '',
        String(p.cannyThreshold ?? ''), p.otsuEnabled === undefined ? '' : (p.otsuEnabled ? '开' : '关'),
        sm.detectionCount != null ? String(sm.detectionCount) : '',
        sm.avgConfidence != null ? String(sm.avgConfidence) : '',
        sm.elapsedMs != null ? String(sm.elapsedMs) : '',
        l.action === 'create' ? '创建/快照' : '参数运行',
      ];
      cells.forEach((c, i) => {
        const [, x, w] = COLS[i];
        safeText(api, x + 6, y, String(c).slice(0, 24), 16, l.action === 'create' ? GRAY : INK);
      });
      y += 34;
      logIdx++;
    }
    if (!rows.length) safeText(api, 84, y + 10, '（暂无运行记录）', 18, GRAY);
    pageNo++;
    if (logIdx >= traceLogs.length) break;
  }

  /* ---- 末页：参数-检出对照（条形图 + 汇总） + 自评 + 评语留白 ---- */
  {
    const pg = newPage();
    const { api } = pg;
    safeText(api, 64, 60, '四、参数-检出数量对照', 24, BLUE);
    // 条形图：x=运行序号，y=检出数量
    const gx = 110, gy = 150, gw = PX_W - 260, gh = 300;
    const maxDet = Math.max(1, ...detects.map((l) => l.summary.detectionCount || 0));
    api.rect(gx, gy, gw, gh, LINE, 2);
    // 横网格线
    for (let g = 1; g <= 4; g++) api.hline(gx, gy + (gh / 4) * g, gw, [235, 239, 245], 1);
    const bw = Math.max(10, Math.min(46, (gw - 40) / Math.max(1, detects.length) - 12));
    detects.slice(0, 40).forEach((l, i) => {
      const n = l.summary.detectionCount || 0;
      const bh = Math.round((n / maxDet) * (gh - 46));
      const x = gx + 24 + i * ((gw - 48) / Math.max(1, Math.min(40, detects.length)));
      api.fill(x, gy + gh - 24 - bh, bw, bh, BLUE);
      safeText(api, x - 4, gy + gh - 24 - bh - 26, String(n), 15, INK);
      safeText(api, x - 6, gy + gh - 20, '#' + (l.log_id), 12, GRAY);
    });
    safeText(api, gx, gy + gh + 26, '运行序（每次运行为一组参数组合；柱高=检出数量）', 15, GRAY);
    // 参数-结果摘要表（最近 12 次）
    let y = gy + gh + 66;
    safeText(api, 64, y, '最近运行参数组合与结果：', 19, INK); y += 36;
    const sumCols = [['#', 84, 46], ['置信度', 130, 84], ['CLAHE', 214, 80], ['Canny', 294, 76], ['Otsu', 370, 62], ['检出', 432, 60], ['均置信度', 492, 96], ['耗时ms', 588, 84]];
    detects.slice(-12).forEach((l, i) => {
      const p = l.params || {}, sm = l.summary || {};
      const cells = [String(l.log_id), String(p.confidenceThreshold ?? ''), String(p.claheClipLimit ?? ''), String(p.cannyThreshold ?? ''), p.otsuEnabled ? '开' : '关', String(sm.detectionCount ?? ''), String(sm.avgConfidence ?? ''), String(sm.elapsedMs ?? '')];
      cells.forEach((c, j) => { const [, x] = sumCols[j]; safeText(api, x + 4, y, c, 15, INK); });
      y += 26;
    });
    // 学生自评
    y += 18;
    safeText(api, 64, y, '五、实训观察与自评', 24, BLUE); y += 44;
    if (opt.selfEval) {
      // 简单按 46 字/行折行
      for (let i = 0; i < opt.selfEval.length; i += 46) {
        safeText(api, 84, y, opt.selfEval.slice(i, i + 46), 18, INK);
        y += 30;
      }
    } else {
      for (let k = 0; k < 3; k++) { api.hline(84, y + 22, PX_W - 208, LINE, 1); y += 40; }
    }
    // 教师评语留白
    y += 16;
    safeText(api, 64, y, '六、教师评语', 24, BLUE); y += 44;
    for (let k = 0; k < 4; k++) { api.hline(84, y + 22, PX_W - 208, LINE, 1); y += 44; }
    safeText(api, PX_W - 400, y + 6, '教师签名：＿＿＿＿＿＿　日期：＿＿＿＿＿＿', 17, GRAY);
  }

  const rgbPages = pages.map((p) => {
    // RGBA → RGB
    const rgb = vision.rgbFromRgba(p.rgba);
    return { wPt: A4_W_PT, hPt: A4_H_PT, pxW: PX_W, pxH: PX_H, rgb };
  });
  const pdf = buildPdf(rgbPages);
  return { pdf, pages: rgbPages.length, missingChars: [...MISSING] };
}

module.exports = { createSession, runExperiment, getLogs, closeSession, buildReport };
