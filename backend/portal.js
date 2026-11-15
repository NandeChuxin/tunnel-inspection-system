/**
 * portal.js — 开放学习入口·样本库服务（模块四）
 *
 * 职责：
 *   1) listSamples(q)  样本库分页浏览：网格卡片 + 筛选（病害类型/来源/等级/隧道）
 *                      —— 样本 = 存在 ≥1 条检测记录的图像（含合成/真实）
 *   2) sampleDetail(id) 详情页聚合：原图元数据 + 检测结果 + 分级知识库条文
 *                      （knowledge_base 按 disease_type=class_name 且 level 关联）
 *   3) tunnelOptions()  筛选下拉需要的隧道清单
 *   4) imageFile(id)    原图回源（GET /api/samples/image/{id}，浏览器直接加载）
 *   5) listPool(q)      合成/真实图池清单（供「一键生成样本数据」选图）
 *   6) archiveDetect()  检测结果自动入库（image + detection，供 /api/detect/image 调用）
 *
 * 详情页“热力图”由前端对原图做 PNG 转换后走 /api/explain/detect 生成（复用餐模块一链路）。
 *
 * 依赖：db.js / fusion.js（LEVELS 等级文案）/ kb.js（知识条文）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const db = require('./db');
const fusion = require('./fusion');
const kb = require('./kb');
const vision = require('./vision');

const TYPES = fusion.DEFECT_TYPES;
const LV_TEXTS = fusion.LEVELS; // ['1级-轻微', ..., '4级-危及安全']

const BACKEND_DIR = __dirname;
const DATA_DIR = path.join(BACKEND_DIR, 'data');
const ANNOTATE_DIR = path.join(DATA_DIR, 'annotate');

/** 样本原图回源地址（模块四统一入口，避免依赖其它模块的路由） */
function imgUrl(imageId) { return '/api/samples/image/' + imageId; }

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/** 解析 bbox 文本 → 数组（异常兜底 [0,0,0,0]） */
function parseBbox(v) {
  try {
    const a = JSON.parse(v);
    return Array.isArray(a) ? a.map(Number) : [0, 0, 0, 0];
  } catch (e) { return [0, 0, 0, 0]; }
}
function lvText(lv) { return LV_TEXTS[lv - 1] || (lv + '级'); }

/**
 * 样本库分页浏览（含筛选）
 * @param {object} q {page,size,source:'synthetic'|'real',type,level,tunnel}
 * @returns {{page,size,total,pages,items:Array}}
 */
function listSamples(q = {}) {
  const cond = ['(SELECT COUNT(*) FROM detection d WHERE d.image_id = im.image_id) > 0'];
  const args = [];
  if (q.source) { cond.push('im.source = ?'); args.push(String(q.source)); }
  if (q.tunnel) { cond.push('t.name = ?'); args.push(String(q.tunnel)); }
  if (q.type) {
    cond.push('EXISTS (SELECT 1 FROM detection d WHERE d.image_id = im.image_id AND d.class_name = ?)');
    args.push(String(q.type));
  }
  if (q.level != null && q.level !== '') {
    cond.push('EXISTS (SELECT 1 FROM detection d WHERE d.image_id = im.image_id AND d.level = ?)');
    args.push(Number(q.level));
  }
  const where = 'WHERE ' + cond.join(' AND ');
  const total = db.get(`SELECT COUNT(*) n FROM image im LEFT JOIN tunnel t ON t.tunnel_id = im.tunnel_id ${where}`, ...args).n;
  const size = Math.min(60, Math.max(1, Number(q.size) || 24));
  const page = Math.max(1, Number(q.page) || 1);
  const pages = Math.max(1, Math.ceil(total / size));
  const rows = db.all(
    `SELECT im.image_id, im.capture_time, im.position_m, im.image_path, im.source, t.name AS tunnel_name
     FROM image im LEFT JOIN tunnel t ON t.tunnel_id = im.tunnel_id
     ${where} ORDER BY im.image_id DESC LIMIT ? OFFSET ?`, ...args, size, (page - 1) * size);

  // 每页图像的检测聚合（类型/等级/数量）
  const byImage = new Map();
  if (rows.length) {
    const marks = rows.map(() => '?').join(',');
    const dets = db.all(
      `SELECT image_id, class_name, COUNT(*) n, MAX(level) mx, MAX(confidence) mc
       FROM detection WHERE image_id IN (${marks}) GROUP BY image_id, class_name`,
      ...rows.map((r) => r.image_id));
    for (const g of dets) {
      if (!byImage.has(g.image_id)) byImage.set(g.image_id, { total: 0, classes: [] });
      const agg = byImage.get(g.image_id);
      agg.total += g.n;
      agg.classes.push({ class_name: g.class_name, count: g.n, max_level: g.mx, level_text: lvText(g.mx) });
    }
  }
  const items = rows.map((r) => {
    const agg = byImage.get(r.image_id) || { total: 0, classes: [] };
    const maxLv = agg.classes.length ? Math.max(...agg.classes.map((c) => c.max_level)) : null;
    return {
      image_id: r.image_id,
      name: path.basename(String(r.image_path || '')).replace(/\.(png|jpg|jpeg)$/i, ''),
      tunnel: r.tunnel_name || '未关联隧道',
      source: r.source,
      synthetic: r.source === 'synthetic',
      mileage: r.position_m,
      capture_time: r.capture_time,
      url: imgUrl(r.image_id),
      total_detections: agg.total,
      max_level: maxLv,
      level_text: maxLv ? lvText(maxLv) : '',
      classes: agg.classes,
    };
  });
  return { page, size, total, pages, items };
}

/**
 * 样本详情：原图 + 检测结果（含分级知识条文）
 * @param {number} imageId
 */
function sampleDetail(imageId) {
  const im = db.get(
    `SELECT im.*, t.name AS tunnel_name FROM image im
     LEFT JOIN tunnel t ON t.tunnel_id = im.tunnel_id WHERE im.image_id = ?`, Number(imageId));
  if (!im) throw httpErr(404, '样本不存在：image_id=' + imageId);
  const detRows = db.all(
    'SELECT * FROM detection WHERE image_id=? ORDER BY confidence DESC, detection_id', Number(imageId));
  const detections = detRows.map((d) => {
    const kbRow = d.level != null ? kb.getRow(d.class_name, d.level) : null; // 按类型+等级关联知识库
    return {
      detection_id: d.detection_id,
      class_id: d.class_id,
      class_name: d.class_name,
      confidence: d.confidence,
      bbox: parseBbox(d.bbox),
      area_px: d.area_px,
      width_mm: d.width_mm,
      level: d.level,
      level_text: d.level != null ? lvText(d.level) : '',
      review_status: d.review_status,
      reviewer: d.reviewer,                 // v4：人工复核/标注人（自动入库为 NULL=待复核）
      annotate_mode: d.annotate_mode,
      created_at: d.created_at,
      knowledge: kbRow ? {
        kb_id: kbRow.kb_id,
        standard_basis: kbRow.standard_basis,
        repair_plan: kbRow.repair_plan,
        planList: kbRow.planList,
        action: kbRow.action,
        interval: kbRow.interval,
      } : null,
    };
  });
  const byClass = new Map();
  for (const d of detections) {
    byClass.set(d.class_name, (byClass.get(d.class_name) || 0) + 1);
  }
  return {
    image: {
      image_id: im.image_id,
      name: path.basename(String(im.image_path || '')).replace(/\.(png|jpg|jpeg)$/i, ''),
      tunnel: im.tunnel_name || '未关联隧道',
      source: im.source,
      synthetic: im.source === 'synthetic',
      mileage: im.position_m,
      capture_time: im.capture_time,
      annotate_mode: im.annotate_mode,
      annotator: im.annotator,
      annotate_elapsed_s: im.annotate_elapsed_s,
      url: imgUrl(im.image_id),
    },
    detections,
    summary: {
      count: detections.length,
      byClass: [...byClass.entries()].map(([name, n]) => ({ class_name: name, count: n })),
      widthPending: detections.filter((d) => d.width_mm == null).length,
    },
  };
}

/** 有检测样本涉及的隧道清单（筛选下拉用） */
function tunnelOptions() {
  return db.all(
    `SELECT DISTINCT t.name, COUNT(*) n FROM tunnel t
     JOIN image im ON im.tunnel_id = t.tunnel_id
     WHERE EXISTS (SELECT 1 FROM detection d WHERE d.image_id = im.image_id)
     GROUP BY t.name ORDER BY n DESC`)
    .map((r) => ({ name: r.name, count: r.n }));
}

/* ---------------- 原图回源（详情页 / 样本卡片 / 演示生成） ---------------- */

/** 按 image_path 解析磁盘文件（兼容 backend 相对、data 相对、绝对三类存储） */
function resolveImageFile(row) {
  if (!row || !row.image_path) return null;
  const cands = [
    path.join(DATA_DIR, row.image_path),      // data/synthetic\xx.jpg、data/annotate/up_xx.png
    path.join(BACKEND_DIR, row.image_path),
    path.isAbsolute(row.image_path) ? row.image_path : path.join(BACKEND_DIR, row.image_path),
  ];
  for (const p of cands) {
    try { if (fs.statSync(p).isFile()) return { buf: fs.readFileSync(p), file: p }; } catch (e) { /* 试下一个 */ }
  }
  return null;
}

/**
 * 取某图像的原始文件（供 GET /api/samples/image/{id} 浏览器直接 <img> 加载）
 * @param {number} imageId
 * @returns {{buf:Buffer, mime:string}}
 */
function imageFile(imageId) {
  const row = db.get('SELECT * FROM image WHERE image_id=?', Number(imageId));
  if (!row) throw httpErr(404, '样本图像不存在：image_id=' + imageId);
  const hit = resolveImageFile(row);
  if (!hit) throw httpErr(404, '样本图像文件缺失：' + (row.image_path || ''));
  const ext = path.extname(hit.file).toLowerCase();
  const mime = ext === '.png' ? 'image/png' : (ext === '.jpg' || ext === '.jpeg') ? 'image/jpeg' : 'application/octet-stream';
  return { buf: hit.buf, mime };
}

/**
 * 图池清单：供「一键生成样本数据」挑选用作检测来源的图像
 * @param {object} q {source:'synthetic'|'real', tunnel, limit}
 * @returns {{total:number, items:Array<{image_id,name,url,source,synthetic}>}}
 */
function listPool(q = {}) {
  const cond = [];
  const args = [];
  if (q.source) { cond.push('im.source = ?'); args.push(String(q.source)); }
  if (q.tunnel) { cond.push('t.name = ?'); args.push(String(q.tunnel)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const limit = Math.min(200, Math.max(1, Number(q.limit) || 200));
  const rows = db.all(
    `SELECT im.image_id, im.image_path, im.source, t.name AS tunnel_name
     FROM image im LEFT JOIN tunnel t ON t.tunnel_id = im.tunnel_id
     ${where} ORDER BY im.image_id DESC LIMIT ?`, ...args, limit);
  const items = rows.map((r) => ({
    image_id: r.image_id,
    name: path.basename(String(r.image_path || '')).replace(/\.(png|jpg|jpeg)$/i, ''),
    tunnel: r.tunnel_name || '',
    source: r.source,
    synthetic: r.source === 'synthetic',
    url: imgUrl(r.image_id),
  }));
  return { total: items.length, items };
}

/* ---------------- 检测结果自动入库（样本库数据来源） ---------------- */

/** 隧道 find-or-create */
function ensureTunnel(name) {
  const hit = db.get('SELECT tunnel_id FROM tunnel WHERE name=?', String(name || ''));
  if (hit) return hit.tunnel_id;
  return db.insert('tunnel', { name: String(name || '未知隧道'), type: '公路隧道' });
}

/** 上传单张 PNG（dataUrl）→ 落盘 data/annotate/ + 建 image 行 */
function saveUploadedImage(dataUrl, body = {}) {
  if (typeof dataUrl !== 'string' || !dataUrl) throw httpErr(400, '缺少 image.dataUrl(PNG)');
  const b64 = dataUrl.includes(',') ? dataUrl.split(',')[1] : dataUrl;
  const pngBuf = Buffer.from(b64, 'base64');
  let dec;
  try { dec = vision.decodePng(pngBuf); }
  catch (e) { throw httpErr(400, '图像解码失败：' + e.message + '（请用 PNG）'); }
  if (!dec || dec.width < 8 || dec.height < 8) throw httpErr(400, '图像尺寸异常');
  fs.mkdirSync(ANNOTATE_DIR, { recursive: true });
  const fname = `up_${Date.now().toString(36)}${crypto.randomBytes(3).toString('hex')}.png`;
  fs.writeFileSync(path.join(ANNOTATE_DIR, fname), pngBuf);
  const imageId = db.insert('image', {
    tunnel_id: body.tunnel ? ensureTunnel(body.tunnel) : null,
    capture_time: body.captureTime || new Date().toISOString(),
    position_m: body.mileage != null ? Number(body.mileage) : null,
    image_path: path.join('data', 'annotate', fname),
    source: body.source === 'synthetic' ? 'synthetic' : 'real',
  });
  return { image_id: imageId, width: dec.width, height: dec.height };
}

/**
 * 检测完成后自动入库：image 元数据 + detection 行（样本库的数据来源）
 * 无 pxPerMm 标定时 width_mm 存 NULL，并标记“待补标定”。
 * @param {object} body 原检测请求体（tunnel/mileage/captureTime/imageId/calibrationPxPerMm…）
 * @param {object} res  infer.detectImage 返回的 DetectResult
 */
function archiveDetect(body = {}, res) {
  if (!res || !Array.isArray(res.detections)) return { archived: false, reason: '无检测结果' };
  const tunnelName = String(body.tunnel || '').trim();
  if (!tunnelName) return { archived: false, reason: '缺 tunnel：样本入库需关联隧道（监控台检测不自动入库）' };
  if (!(res.input && res.input.hasImage) && !body.imageId) return { archived: false, reason: '无图像输入' };

  // 1) image 行：优先复用 body.imageId；否则注册（dataUrl → PNG 落盘）
  let imageId = body.imageId != null ? Number(body.imageId) : null;
  if (imageId) {
    db.run('UPDATE image SET tunnel_id=?, capture_time=COALESCE(?,capture_time), position_m=COALESCE(?,position_m) WHERE image_id=?',
      ensureTunnel(tunnelName), body.captureTime || new Date().toISOString(),
      body.mileage != null ? Number(body.mileage) : null, imageId);
  } else {
    const dataUrl = body.image && (body.image.dataUrl || body.image.base64);
    if (typeof dataUrl !== 'string') return { archived: false, reason: '图像需为 PNG dataUrl' };
    const reg = saveUploadedImage(dataUrl, { tunnel: tunnelName, captureTime: body.captureTime, mileage: body.mileage, source: body.source });
    imageId = reg.image_id;
  }

  // 2) 该图既有自动入库行先清（保持每图一份最新快照）
  db.run("DELETE FROM detection WHERE image_id=? AND annotate_mode='auto_detect'", imageId);

  // 3) 标定换算：有 pxPerMm → width_mm=窄边像素/比例；否则 NULL（待补）
  const scale = body.calibrationPxPerMm != null && Number(body.calibrationPxPerMm) > 0 ? Number(body.calibrationPxPerMm) : null;
  const W = res.input && res.input.widthPx;
  let added = 0;
  for (const d of res.detections) {
    const bbox = Array.isArray(d.bbox) ? d.bbox : [0, 0, 0, 0];
    const pxW = W ? bbox[2] * W : null;
    const pxH = W ? bbox[3] * W : null;   // 引擎无真实高度时按方形近似（仅用于窄边物理宽）
    const widthMm = (scale && pxW != null) ? Math.round(Math.min(pxW, pxH) / scale * 100) / 100 : null;
    db.insert('detection', {
      image_id: imageId,
      class_id: d.class_id, class_name: d.class_name,
      confidence: d.confidence,
      bbox,
      area_px: d.area_px != null ? d.area_px : (pxW != null ? Math.round(pxW * pxH) : null),
      width_mm: widthMm,
      level: d.level,
      review_status: '待审核',          // 机器自动入库，待人工复核
      reviewer: body.reviewer ? String(body.reviewer) : null, // v4 detection.reviewer：复核/标注人（自动入库为空）
      annotate_mode: 'auto_detect',
      annotate_meta: JSON.stringify({ from: 'detect-archive', taskId: res.taskId || '' }),
    });
    added++;
  }
  return {
    archived: true,
    image_id: imageId,
    tunnel: tunnelName,
    detections_added: added,
    width_mm_status: scale ? '已标定' : '待补（无 pxPerMm 标定，width_mm 存 NULL）',
  };
}

module.exports = {
  TYPES, LV_TEXTS,
  listSamples, sampleDetail, tunnelOptions, parseBbox, lvText,
  imageFile, listPool, archiveDetect, ensureTunnel, imgUrl,
  saveUploadedImage,          // 模块三复用：PNG dataUrl → 落盘 + image 行（图池/预标注上传）
};
