/**
 * server.js — 隧道病害智能检测与分析系统后端服务（零依赖）
 *
 * 启动：node server.js   （默认端口 8787，可用 TUNNEL_PORT 覆盖）
 *
 * API：
 *   GET  /                       前端平台页面
 *   POST /api/ingest             车载终端数据包上传（影像帧 + 传感器）→ 自动识别入库
 *   POST /api/simulate           模拟巡检车采集一帧数据并走完整识别管线（演示用）
 *   GET  /api/defects            病害台账查询（支持 status/type/level/tunnel 过滤）
 *   GET  /api/defects/:id        病害详情（含整治建议与审核记录）
 *   POST /api/defects/:id/review 人工审核（通过/驳回/调整等级）→ 敲定处置决策
 *   GET  /api/frames             最近采集帧
 *   GET  /api/stats              统计分析
 *   POST /api/detect/image       (W0) 参数化检测：图像PNG/ROI + 置信度/IoU/CLAHE/高斯/Canny/Otsu 参数，
 *                                     返回统一 DetectResult（检测框+中间产物Base64+耗时）
 *                                     [自动] 带 tunnel 且未 archive=false → 检测结果自动入库样本库（模块四）
 *   GET  /api/detect/result/:taskId        (W0) 按任务ID取回检测结果与中间产物（缓存TTL 30min）
 *   GET  /api/detect/result/:taskId/intermediate/:key  (W0) 取单个中间产物PNG
 *   POST /api/explain/detect      (模块一) 可解释AI教学检测：4步CV链路中间图(clahe/gaussian/canny/otsu)
 *                                       + Eigen/Grad-CAM热力图(α=0.45叠加) + 统一检测结果
 *   PUT  /api/pipeline/params     (模块一) 调整CV链路参数：只重算受影响步骤（前序步骤字节不变）
 *   GET  /api/pipeline/params     (模块一) 查询当前管线参数与默认值
 *   POST /api/explain/export      (模块一) 合成对比讲解图(原图+热力+检测框+类别/等级标注)→PNG下载
 *
 *   POST /api/experiment/session   (模块二) 创建实训会话：记录初始参数快照 + 缓存样本图 → {session_id}
 *   POST /api/experiment/run       (模块二) 按参数运行一次推理并写 experiment_log（5滑块联动）
 *   GET  /api/experiment/log/:id   (模块二) 操作轨迹 + 统计（log.params 可回放快照）
 *   POST /api/experiment/close/:id (模块二) 结束会话（写 end_time）
 *   POST /api/experiment/report/:id (模块二) 实验报告PDF（会话信息/轨迹表/参数-检出对照/自评/评语留白）
 *   POST /api/sample/synthesize    (模块二) 病害样本合成器：裁剪+羽化+透视/光度扰动，批量≥20张/次
 *   GET  /api/sample/library       (模块二) 合成样本库分页浏览
 *   GET  /synthetic/*              (模块二) 合成样本图片静态托管
 *
 *
 *   POST /api/auth/login           (模块四) 登录获取 token（演示账号 admin/teacher/student，口令 123456）
 *   POST /api/auth/logout          (模块四) 吊销令牌
 *   GET  /api/auth/me              (模块四) 当前登录用户
 *   GET  /api/users                (模块四) 用户清单（admin）
 *   PUT  /api/users/:id/role       (模块四) 调整角色（admin）
 *   GET  /api/kb                   (模块四) 分级知识库检索（公开读；type/level 过滤 + 分页）
 *   POST /api/kb                   (模块四) 新建知识条目（teacher/admin）
 *   POST|PUT /api/kb/:id           (模块四) 更新知识条目（teacher/admin）
 *   DELETE /api/kb/:id             (模块四) 删除知识条目（teacher/admin；student → 403）
 *   GET  /api/kg/stats             (模块五) 知识图谱规模统计（实体/关系按类型计数）
 *   GET  /api/kg/standards         (模块五) 规范条款库 + 系统等级 ↔ JTG 五类映射（溯源徽章）
 *   GET  /api/kg/graph             (模块五) 子图检索：?type=病害类型&level=等级
 *   GET  /api/kg/explain/:id       (模块五) 闭环推理：一条病害 → 等级依据/成因/危害/措施
 *   GET  /api/samples              (模块四) 样本库分页浏览（筛选：类型/来源/等级/隧道）
 *   GET  /api/samples/:id          (模块四) 样本详情（原图 + 检测结果 + 知识库条文）
 *   GET  /api/samples/image/:id    (模块四) 样本原图回源（浏览器直接加载）
 *   GET  /api/samples/pool         (模块四) 图池清单（演示生成样本选图）
 *   GET  /api/samples/tunnels      (模块四) 有样本的隧道清单（筛选下拉）
 *   GET  /api/model/info           (训练轮) 当前判别引擎模式 rules/learned + 训练指标
 *   POST /api/model/mode           (训练轮) 运行时切换判别引擎 {mode:'rules'|'learned'}
 */
const http = require('http');
const fs = require('fs');
const path = require('path');
const { URL } = require('url');

const store = require('./store');
const fusion = require('./fusion');
const simulator = require('./simulator');
const report = require('./report');
const infer = require('./infer');                       // W0: 参数化推理管线(DetectResult)
const intermediateCache = require('./intermediate-cache'); // W0: 中间产物内存缓存(TTL 30min)
const explain = require('./explain');                   // 模块一: 可解释AI教学展示
const experiment = require('./experiment');             // 模块二: 实训会话/日志/PDF实验报告
const synth = require('./synthesizer');                 // 模块二: 病害样本合成器
const auth = require('./auth');                         // 模块四: 用户/角色/token 登录（中间件）
const kb = require('./kb');                             // 模块四: 分级知识库（迁移/查表/CRUD）
const portal = require('./portal');                     // 模块四: 样本库浏览/详情/原图回源/检测自动入库
const dbview = require('./dbview');                     // 模块四: 数据库浏览（只读，表白名单+脱敏）
const model = require('./model');                       // 数据驱动训练轮: 可训练判别模型（softmax）
const kg = require('./kg');                             // 模块五: 隧道病害知识图谱（本体+子图检索+闭环推理）

/** 训练模型运行态：文件路径 + 参数（启动加载，/api/model/mode 切换） */
const modelState = { file: null, params: null };

const PORT = Number(process.env.PORT) || Number(process.env.TUNNEL_PORT) || 8787;
/* 前端静态目录：默认 frontend/（旧版传统界面）；发布沙箱用 TUNNEL_FRONTEND=docs
   切到 docs/（prototype-holo-core 等最新界面），单端口同时提供静态页与 /api。 */
const FRONTEND_DIR = process.env.TUNNEL_FRONTEND
  ? path.join(__dirname, '..', process.env.TUNNEL_FRONTEND)
  : path.join(__dirname, '..', 'frontend');
const MEDIA_DIR = path.join(__dirname, 'data', 'media');
const DS_DIR = path.join(__dirname, 'dataset', 'img');      // 隧道缺陷检测数据集原图（D:\DataSet 导入）
const DS_INDEX = path.join(__dirname, 'dataset', 'index.json'); // 病害类型 → 数据集图片 索引
const SYN_DIR = synth.SYN_DIR;                          // 模块二: 合成样本输出目录（backend/data/synthetic）
const BILI_HEADERS = {
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/126 Safari/537.36',
  'Referer': 'https://www.bilibili.com/',
};
// 实时视频帧接入缓冲：外部摄像头/巡检车 POST 最新帧，前端按 seq 增量拉取。
// 只保留每路最新一帧，避免实时流长期占用内存。
const liveStreams = new Map();
let liveSeq = 0;
const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.svg': 'image/svg+xml',
  '.mp4': 'video/mp4',
};

/**
 * 在线视频导入：B站视频 → 解析直链 → 下载到本地媒体库 → 同源托管
 * （跨域 iframe 播放器画面受浏览器同源策略保护无法抽帧，必须落地为本地文件）
 */
async function importOnlineVideo(text) {
  const bm = text.match(/BV[0-9A-Za-z]{10}/);
  if (!bm) throw new Error('链接中未找到 BV 号');
  const bvid = bm[0];
  const cm = text.match(/cid=(\d+)/);

  const info = await (await fetch(`https://api.bilibili.com/x/web-interface/view?bvid=${bvid}`, { headers: BILI_HEADERS })).json();
  if (info.code !== 0) throw new Error('B站视频信息接口: ' + (info.message || info.code));
  const cid = (cm && cm[1]) || info.data.cid;

  const play = await (await fetch(`https://api.bilibili.com/x/player/playurl?bvid=${bvid}&cid=${cid}&qn=32&platform=html5&high_quality=1`, { headers: BILI_HEADERS })).json();
  if (play.code !== 0 || !play.data || !Array.isArray(play.data.durl) || !play.data.durl.length) {
    throw new Error('无法解析视频直链（可能需要登录权限）');
  }
  const res = await fetch(play.data.durl[0].url, { headers: BILI_HEADERS });
  if (!res.ok) throw new Error('视频下载失败 HTTP ' + res.status);
  const buf = Buffer.from(await res.arrayBuffer());
  if (buf.length < 1024) throw new Error('下载内容异常');

  fs.mkdirSync(MEDIA_DIR, { recursive: true });
  const file = `${bvid}.mp4`;
  fs.writeFileSync(path.join(MEDIA_DIR, file), buf);
  return {
    localUrl: `/media/${file}`,
    title: info.data.title,
    durationSec: info.data.duration,
    sizeKB: Math.round(buf.length / 1024),
  };
}

function send(res, code, data, type = 'application/json; charset=utf-8') {
  res.writeHead(code, { 'Content-Type': type, 'Access-Control-Allow-Origin': '*' });
  if (Buffer.isBuffer(data)) return res.end(data); // 静态文件二进制直出
  res.end(typeof data === 'string' ? data : JSON.stringify(data, null, 2));
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => {
      try { resolve(buf ? JSON.parse(buf) : {}); }
      catch (e) { const err = new Error('请求体不是合法 JSON'); err.status = 400; reject(err); }
    });
    req.on('error', reject);
  });
}


/** 数据接入 → 融合识别 → 入库台账 */
function ingestFrame(frame) {
  const saved = store.addFrame({
    tunnel: frame.tunnel || '青云山隧道',
    mileage: frame.mileage ?? 0,
    speed: frame.speed ?? 5,
    sensors: frame.sensors || {},
    source: frame.source || '巡检模拟', // 照片流 | 视频流 | 巡检模拟
    image: { frameUrl: frame.image?.frameUrl || null, rois: frame.image?.rois || [] },
    device: frame.device || 'TCV-01',
    timestamp: frame.timestamp || new Date().toISOString(),
  });
  const result = fusion.analyze(saved);
  const defects = result.detections.map((det) => {
    const d = store.addDefect({ ...det, frameId: saved.id, source: saved.source });
    // 自动审核规则：1级（轻微）病害不经人工，系统直接审核闭环
    if (d.levelNo === 1) {
      return store.updateDefect(d.id, {
        status: '已审核',
        finalLevel: d.level,
        decision: '轻微病害，系统自动审核闭环',
        autoReviewed: true,
        review: {
          reviewer: '系统（自动审核）',
          action: '通过',
          note: '评估等级为轻微，按审核规则自动闭环',
          decision: '轻微病害，系统自动审核闭环',
          at: new Date().toISOString(),
        },
      });
    }
    return d;
  });
  return {
    frame: {
      id: saved.id, tunnel: saved.tunnel, mileage: saved.mileage, speed: saved.speed,
      sensors: saved.sensors, device: saved.device, timestamp: saved.timestamp,
    },
    analysis: result, defects,
  };
}

const server = http.createServer(async (req, res) => {
  const u = new URL(req.url, 'http://localhost');
  const p = u.pathname;

  try {
    // ---------- API ----------
    if (p === '/api/health') return send(res, 200, { ok: true, service: 'tunnel-inspection', time: new Date().toISOString() });

    // POST /api/live/frame {streamId?, image:{dataUrl}|dataUrl, capturedAt?, device?}
    if (p === '/api/live/frame' && req.method === 'POST') {
      const body = await readBody(req);
      const dataUrl = body.dataUrl || (body.image && body.image.dataUrl);
      if (typeof dataUrl !== 'string' || !/^data:image\/(png|jpe?g);base64,/i.test(dataUrl)) {
        return send(res, 400, { error: '请提供 PNG/JPEG dataUrl：{image:{dataUrl:"data:image/...;base64,..."}}' });
      }
      if (dataUrl.length > 12 * 1024 * 1024) return send(res, 413, { error: '单帧不得超过 12MB' });
      const streamId = String(body.streamId || 'default').replace(/[^\w.-]/g, '').slice(0, 64) || 'default';
      const frame = { streamId, seq: ++liveSeq, dataUrl,
        capturedAt: body.capturedAt || new Date().toISOString(), device: body.device || 'external-camera' };
      liveStreams.set(streamId, frame);
      return send(res, 202, { ok: true, streamId, seq: frame.seq, capturedAt: frame.capturedAt });
    }

    // GET /api/live/frame?streamId=default&after=123：无新帧返回 204。
    if (p === '/api/live/frame' && req.method === 'GET') {
      const streamId = String(u.searchParams.get('streamId') || 'default');
      const frame = liveStreams.get(streamId);
      if (!frame || frame.seq <= Number(u.searchParams.get('after') || 0)) {
        res.writeHead(204, { 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
        return res.end();
      }
      res.setHeader('Cache-Control', 'no-store');
      return send(res, 200, frame);
    }

    if (p === '/api/live/status' && req.method === 'GET') {
      return send(res, 200, { streams: Array.from(liveStreams.values()).map((f) => ({
        streamId: f.streamId, seq: f.seq, capturedAt: f.capturedAt, device: f.device,
      })) });
    }

    if (p === '/api/ingest' && req.method === 'POST') {
      const frame = await readBody(req);
      if (!frame.image || !Array.isArray(frame.image.rois)) {
        return send(res, 400, { error: '数据包缺少 image.rois 字段' });
      }
      return send(res, 200, ingestFrame(frame));
    }

    if (p === '/api/simulate' && req.method === 'POST') {
      const opt = await readBody(req);
      return send(res, 200, ingestFrame(simulator.makeFrame(opt)));
    }

    if (p === '/api/import/video' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body.url) return send(res, 400, { error: '请提供视频链接或 BV 号' });
      const out = await importOnlineVideo(String(body.url));
      return send(res, 200, out);
    }

    if (p === '/api/defects' && req.method === 'GET') {
      return send(res, 200, store.listDefects({
        status: u.searchParams.get('status') || undefined,
        type: u.searchParams.get('type') || undefined,
        level: u.searchParams.get('level') || undefined,
        tunnel: u.searchParams.get('tunnel') || undefined,
      }));
    }

    const mReview = p.match(/^\/api\/defects\/([^/]+)\/review$/);
    if (mReview && req.method === 'POST') {
      const d = store.getDefect(mReview[1]);
      if (!d) return send(res, 404, { error: '病害记录不存在' });
      const body = await readBody(req);
      if (!body.reviewer || !['通过', '驳回'].includes(body.action)) {
        return send(res, 400, { error: 'review 需包含 reviewer 与 action(通过|驳回)' });
      }
      const changes = Array.isArray(body.changes) ? body.changes : [];
      /* 复核前原始值：供前端「AI初始 vs 复核后最终」对比留痕 */
      const review = {
        reviewer: body.reviewer,
        action: body.action,
        note: body.note || '',
        levelOverride: body.levelOverride || null,
        typeOverride: body.typeOverride || null,
        areaOverride: body.areaOverride != null ? String(body.areaOverride) : null,
        rejectReason: body.rejectReason || null,
        decision: body.decision || (body.action === '通过' ? '按建议方案纳入整治计划' : '退回复检'),
        original: { type: d.type, level: d.level, area: (d.physical && d.physical['面积']) || null },
        changes,
        at: new Date().toISOString(),
      };
      const patch = {
        status: body.action === '通过' ? '已审核' : '已驳回',
        decision: review.decision,
        review,
      };
      /* 人工校正：类型 / 等级 / 面积 改判（未改判则沿用 AI 初始值；改动写入 changes 留痕） */
      patch.type = body.typeOverride && body.typeOverride !== d.type ? body.typeOverride : d.type;
      patch.finalLevel = review.levelOverride || d.level;
      if (review.levelOverride) patch.level = review.levelOverride;
      if (review.areaOverride != null) {
        patch.physical = Object.assign({}, d.physical || {}, { 面积: review.areaOverride });
      }
      /* 复核留痕：追加一条审计日志（含修改前后对比），全部操作可追溯 */
      patch.auditLog = (d.auditLog || []).concat({
        at: review.at,
        reviewer: review.reviewer,
        action: review.action,
        summary: review.action + (changes.length ? ' · 修正 ' + changes.length + ' 项' : ''),
        changes,
        note: body.note || '',
      });
      return send(res, 200, store.updateDefect(d.id, patch));
    }

    const mDetail = p.match(/^\/api\/defects\/([^/]+)$/);
    if (mDetail && req.method === 'GET') {
      const d = store.getDefect(mDetail[1]);
      return d ? send(res, 200, d) : send(res, 404, { error: '病害记录不存在' });
    }

    if (p === '/api/frames') return send(res, 200, store.listFrames(Number(u.searchParams.get('limit')) || 50));

    if (p === '/api/stats') return send(res, 200, store.stats());

    // ---------- W0: 参数化检测接口（新增，不影响上述既有 API） ----------
    // POST /api/detect/image —— 接受 图像(PNG dataUrl)/ROI 直传 + 自定义参数，
    //                          返回统一 DetectResult（检测框 + 中间产物 Base64 + 耗时），
    //                          中间产物以任务 ID 入缓存（TTL 30min）
    if (p === '/api/detect/image' && req.method === 'POST') {
      const body = await readBody(req);
      if (!body || typeof body !== 'object') return send(res, 400, { error: '请求体需为 JSON 对象' });
      try {
        const payload = await infer.detectImage(body);
        // 模块四：检测流程完成后自动写入样本库（带 tunnel 且未显式关闭时）
        if (body.archive !== false) {
          try { payload.autoArchive = portal.archiveDetect(body, payload); }
          catch (e) { payload.autoArchive = { archived: false, reason: '自动入库失败：' + e.message }; }
        }
        return send(res, 200, payload);
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // GET /api/detect/result/{taskId} —— 按任务 ID 取回 DetectResult（含中间产物）
    const mDetResult = p.match(/^\/api\/detect\/result\/([^/]+)$/);
    if (mDetResult && req.method === 'GET') {
      const payload = infer.getResult(mDetResult[1]);
      if (!payload) return send(res, 404, { error: '任务不存在或缓存已过期（TTL 30 分钟）' });
      return send(res, 200, payload);
    }

    // GET /api/detect/result/{taskId}/intermediate/{key} —— 取单个中间产物 PNG 原图
    const mDetImg = p.match(/^\/api\/detect\/result\/([^/]+)\/intermediate\/([^/]+)$/);
    if (mDetImg && req.method === 'GET') {
      const { png, item } = infer.getIntermediatePng(mDetImg[1], mDetImg[2]);
      if (!item) return send(res, 404, { error: '任务不存在或缓存已过期（TTL 30 分钟）' });
      if (!png) return send(res, 404, { error: '该中间产物当前无图像数据（占位或未提供原图）' });
      res.writeHead(200, {
        'Content-Type': 'image/png',
        'Cache-Control': 'private, max-age=600',
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(png);
    }

    // ---------- 模块一：可解释AI教学展示（新增，不影响上述既有 API） ----------
    // POST /api/explain/detect —— 教学检测：4步CV中间图 + CAM热力图(α=0.45) + 统一检测结果
    if (p === '/api/explain/detect' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        return send(res, 200, explain.explainDetect(body));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // PUT /api/pipeline/params —— 左栏调参：按依赖只重算受影响步骤
    if (p === '/api/pipeline/params' && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        return send(res, 200, explain.updatePipeline(body));
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // GET /api/pipeline/params —— 当前管线参数（滑杆初始化）
    if (p === '/api/pipeline/params' && req.method === 'GET') {
      return send(res, 200, explain.pipelineState());
    }

    // POST /api/explain/export —— 合成对比讲解图（PNG 下载）
    if (p === '/api/explain/export' && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const out = explain.exportLecture(body && body.taskId);
        res.writeHead(200, {
          'Content-Type': 'image/png',
          'Content-Disposition': `attachment; filename="lecture-${out.taskId}.png"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(out.png);
      } catch (e) {
        return send(res, e.status || 500, { error: e.message });
      }
    }

    // ---------- 模块二：虚实结合实训台（新增，不影响上述既有 API） ----------
    // POST /api/experiment/session —— 创建实训会话（初始参数快照 + 样本图缓存）
    if (p === '/api/experiment/session' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, experiment.createSession(body)); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // POST /api/experiment/run —— 按参数运行推理并写操作日志
    if (p === '/api/experiment/run' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, await experiment.runExperiment(body)); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/experiment/log/{session_id} —— 操作轨迹 + 统计（参数快照可回放）
    const mExpLog = p.match(/^\/api\/experiment\/log\/([^/]+)$/);
    if (mExpLog && req.method === 'GET') {
      try { return send(res, 200, experiment.getLogs(mExpLog[1])); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // POST /api/experiment/close/{session_id} —— 结束会话（写 end_time）
    const mExpClose = p.match(/^\/api\/experiment\/close\/([^/]+)$/);
    if (mExpClose && req.method === 'POST') {
      try { return send(res, 200, experiment.closeSession(mExpClose[1])); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // POST /api/experiment/report/{session_id} —— 生成实验报告 PDF（附件下载）
    const mExpReport = p.match(/^\/api\/experiment\/report\/([^/]+)$/);
    if (mExpReport && req.method === 'POST') {
      const body = await readBody(req);
      try {
        const rep = experiment.buildReport(mExpReport[1], body || {});
        res.writeHead(200, {
          'Content-Type': 'application/pdf',
          'Content-Disposition': `attachment; filename="experiment-report-EXP-${String(mExpReport[1]).padStart(6, '0')}.pdf"`,
          'Access-Control-Allow-Origin': '*',
        });
        return res.end(rep.pdf);
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // POST /api/sample/synthesize —— 病害样本合成（批量 ≥20 张/次；仅实训演示与数据增强）
    if (p === '/api/sample/synthesize' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, synth.synthesize(body)); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/sample/library —— 合成样本库分页浏览
    if (p === '/api/sample/library' && req.method === 'GET') {
      return send(res, 200, synth.listLibrary({
        page: Number(u.searchParams.get('page')) || 1,
        size: Math.min(60, Number(u.searchParams.get('size')) || 12),
      }));
    }

    // ---------- 报告导出（计划书 §3.6/§3.7：PDF/Excel 报告输出） ----------
    if (p === '/api/report/excel' && req.method === 'POST') {
      const body = await readBody(req);
      const xlsx = report.buildExcelReport(body.tunnel || u.searchParams.get('tunnel') || '');
      res.writeHead(200, {
        'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'Content-Disposition': `attachment; filename="tunnel-report-${Date.now()}.xlsx"`,
        'Access-Control-Allow-Origin': '*',
      });
      return res.end(xlsx);
    }

    if (p === '/api/report/pdf' && req.method === 'POST') {
      const body = await readBody(req);
      const html = report.buildPdfHtml(body.tunnel || '', body.images || []);
      return send(res, 200, html, 'text/html; charset=utf-8');
    }

    // ---------- 模块四：数据库（样本库/知识库/用户/数据库浏览，不影响上述既有 API） ----------
    // POST /api/auth/login —— 登录获取 token（固定演示账号 admin/teacher/student，口令 123456）
    if (p === '/api/auth/login' && req.method === 'POST') {
      const body = await readBody(req);
      try { return send(res, 200, auth.login(body && body.name, body && body.password)); }
      catch (e) { return send(res, e.status || 401, { error: e.message }); }
    }

    // POST /api/auth/logout —— 吊销当前令牌（按请求头中的 token 匹配）
    if (p === '/api/auth/logout' && req.method === 'POST') {
      const raw = ((req.headers && req.headers.authorization) || '').match(/^Bearer\s+(.+)$/i);
      const token = raw ? raw[1].trim() : null;
      auth.logout(token);
      return send(res, 200, { ok: true });
    }

    // GET /api/auth/me —— 当前登录用户
    if (p === '/api/auth/me' && req.method === 'GET') {
      const u = auth.bearerUser(req);
      if (!u) return send(res, 401, { error: '未登录或 token 无效' });
      return send(res, 200, { user: u });
    }

    // GET /api/users —— 用户清单（admin 管理用户）
    if (p === '/api/users' && req.method === 'GET') {
      try { auth.requireRole(req, ['admin']); return send(res, 200, { users: auth.listUsers() }); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // PUT /api/users/{id}/role —— 调整角色（admin）
    const mUserRole = p.match(/^\/api\/users\/([^/]+)\/role$/);
    if (mUserRole && req.method === 'PUT') {
      const body = await readBody(req);
      try {
        auth.requireRole(req, ['admin']);
        return send(res, 200, auth.setRole(mUserRole[1], body && body.role));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/db/tables —— 数据库表清单（行数+列结构；teacher/admin）
    if (p === '/api/db/tables' && req.method === 'GET') {
      try {
        auth.requireRole(req, ['teacher', 'admin']);
        return send(res, 200, dbview.listTables());
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/db/tables/{name} —— 单表结构+分页行数据（?page=&size=&q= 模糊搜索；teacher/admin）
    const mDbTable = p.match(/^\/api\/db\/tables\/([A-Za-z_]+)$/);
    if (mDbTable && req.method === 'GET') {
      try {
        auth.requireRole(req, ['teacher', 'admin']);
        return send(res, 200, dbview.tableRows(mDbTable[1], {
          page: u.searchParams.get('page') || undefined,
          size: u.searchParams.get('size') || undefined,
          q: u.searchParams.get('q') || undefined,
        }));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/model/info —— 当前判别引擎模式（rules/learned）与训练指标
    if (p === '/api/model/info' && req.method === 'GET') {
      const injected = typeof fusion.getClassifier() === 'function';
      return send(res, 200, {
        mode: injected ? 'learned' : 'rules',
        file: modelState.file,
        trainedAt: modelState.params && modelState.params.meta && modelState.params.meta.trainedAt,
        threshold: modelState.params && modelState.params.threshold,
        metrics: modelState.params && modelState.params.meta && modelState.params.meta.metrics,
        detector: require('./detector').info(),
      });
    }

    // POST /api/model/mode —— 运行时切换判别引擎（{mode:'rules'|'learned'}），选择持久化到模型文件
    if (p === '/api/model/mode' && req.method === 'POST') {
      const body = await readBody(req);
      const mode = body && body.mode;
      if (mode !== 'rules' && mode !== 'learned') return send(res, 400, { error: "mode 须为 'rules' 或 'learned'" });
      if (mode === 'learned' && !modelState.params) return send(res, 409, { error: '尚无训练模型：请先执行 node backend/train/train.js' });
      fusion.setClassifier(mode === 'learned' ? model.createPredictor(modelState.params).classify : null);
      if (modelState.params && modelState.file) {
        modelState.params.enabled = mode === 'learned';
        try { fs.writeFileSync(modelState.file, JSON.stringify(modelState.params, null, 1)); } catch (e) { /* 持久化失败仅影响重启后默认值 */ }
      }
      return send(res, 200, { ok: true, mode });
    }

    // GET /api/kb —— 分级知识库检索（公开读；type/level 过滤，可选分页）
    if (p === '/api/kb' && req.method === 'GET') {
      try {
        return send(res, 200, kb.list({
          type: u.searchParams.get('type') || undefined,
          level: u.searchParams.get('level') || undefined,
          page: u.searchParams.get('page') || undefined,
          size: u.searchParams.get('size') || undefined,
        }));
      } catch (e) { return send(res, 500, { error: e.message }); }
    }

    // POST /api/kb —— 新建知识条目（teacher/admin）
    if (p === '/api/kb' && req.method === 'POST') {
      const body = await readBody(req);
      try { auth.requireRole(req, ['teacher', 'admin']); return send(res, 200, kb.create(body)); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // POST|PUT /api/kb/{id} —— 更新知识条目（teacher/admin；按接口定义 POST /api/kb/{id} 亦视为更新）
    const mKb = p.match(/^\/api\/kb\/([^/]+)$/);
    if (mKb && (req.method === 'POST' || req.method === 'PUT')) {
      const body = await readBody(req);
      try {
        auth.requireRole(req, ['teacher', 'admin']);
        return send(res, 200, kb.update(mKb[1], body));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // DELETE /api/kb/{id} —— 删除知识条目（teacher/admin；student 写操作返回 403）
    if (mKb && req.method === 'DELETE') {
      try {
        auth.requireRole(req, ['teacher', 'admin']);
        return send(res, 200, kb.remove(mKb[1]));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // ---------- 科研工作流：实验追踪台账 / 评测报告聚合（公开只读） ----------
    if (p === '/api/research/experiments' && req.method === 'GET') {
      try {
        const research = require('./research');
        const limit = Number(u.searchParams.get('limit')) || undefined;
        return send(res, 200, research.listExperiments(limit));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    if (p === '/api/research/report' && req.method === 'GET') {
      try {
        const research = require('./research');
        return send(res, 200, research.aggregateReport());
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    // GET /api/research/report.md — Markdown 报告下载
    if (p === '/api/research/report.md' && req.method === 'GET') {
      try {
        const research = require('./research');
        const md = research.reportMarkdown(research.aggregateReport());
        res.writeHead(200, { 'Content-Type': 'text/markdown; charset=utf-8', 'Access-Control-Allow-Origin': '*' });
        return res.end(md);
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }
    // GET /api/research/report.xlsx — Excel 报告下载
    if (p === '/api/research/report.xlsx' && req.method === 'GET') {
      try {
        const research = require('./research');
        const buf = research.reportXlsx(research.aggregateReport());
        res.writeHead(200, { 'Content-Type': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          'Content-Disposition': 'attachment; filename="research-report.xlsx"', 'Access-Control-Allow-Origin': '*' });
        return res.end(buf);
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // ---------- 模块五：隧道病害知识图谱（公开只读：图谱规模 / 子图 / 闭环推理） ----------
    if (p === '/api/kg/stats' && req.method === 'GET') {
      try { return send(res, 200, kg.stats()); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/kg/standards —— 规范条款库 + 系统等级 ↔ JTG 五类映射（前端溯源徽章数据源，公开读）
    if (p === '/api/kg/standards' && req.method === 'GET') {
      try { return send(res, 200, kg.standards()); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/kg/all —— 整图（全部实体 + 全部关系，供全图谱界面一次渲染）
    if (p === '/api/kg/all' && req.method === 'GET') {
      try { return send(res, 200, kg.fullGraph()); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/kg/graph?type=渗漏水&level=3 —— 以病害类型（+等级）为中心的 2~3 跳子图
    if (p === '/api/kg/graph' && req.method === 'GET') {
      try {
        const type = u.searchParams.get('type') || kg.TYPES[0];
        const lv = Number(u.searchParams.get('level')) || null;
        if (kg.TYPES.indexOf(type) < 0) return send(res, 400, { error: '未知病害类型：' + type });
        return send(res, 200, kg.subgraph(type, lv));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/kg/explain/{病害ID}（亦支持 ?id=）—— 一条病害的完整推理结论
    const mKgExplain = p.match(/^\/api\/kg\/explain\/([^/]+)$/);
    if ((mKgExplain || p === '/api/kg/explain') && req.method === 'GET') {
      try {
        const id = mKgExplain ? decodeURIComponent(mKgExplain[1]) : u.searchParams.get('id');
        if (!id) return send(res, 400, { error: '缺少病害 ID（/api/kg/explain/{id} 或 ?id=）' });
        const d = store.getDefect(id);
        if (!d) return send(res, 404, { error: '病害记录不存在：' + id });
        return send(res, 200, kg.explain(d));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/samples —— 样本库分页浏览（无需登录）
    if (p === '/api/samples' && req.method === 'GET') {
      try {
        return send(res, 200, portal.listSamples({
          page: u.searchParams.get('page'), size: u.searchParams.get('size'),
          source: u.searchParams.get('source') || undefined,
          type: u.searchParams.get('type') || undefined,
          level: u.searchParams.get('level') || undefined,
          tunnel: u.searchParams.get('tunnel') || undefined,
        }));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/samples/tunnels —— 有样本的隧道清单（筛选下拉；须在 /api/samples/:id 之前匹配）
    if (p === '/api/samples/tunnels' && req.method === 'GET') {
      try { return send(res, 200, { items: portal.tunnelOptions() }); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/samples/pool —— 图池清单（演示「一键生成样本数据」选图；须在 /api/samples/:id 之前匹配）
    if (p === '/api/samples/pool' && req.method === 'GET') {
      try {
        return send(res, 200, portal.listPool({
          source: u.searchParams.get('source') || undefined,
          tunnel: u.searchParams.get('tunnel') || undefined,
          limit: u.searchParams.get('limit') || undefined,
        }));
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/samples/image/{id} —— 样本原图回源（浏览器直接 <img> 加载；须在 /api/samples/:id 之前匹配）
    const mSampleImg = p.match(/^\/api\/samples\/image\/([^/]+)$/);
    if (mSampleImg && req.method === 'GET') {
      try {
        const { buf, mime } = portal.imageFile(mSampleImg[1]);
        res.writeHead(200, { 'Content-Type': mime, 'Cache-Control': 'private, max-age=300', 'Access-Control-Allow-Origin': '*' });
        return res.end(buf);
      } catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // GET /api/samples/{id} —— 样本详情（原图 + 检测结果 + 知识库条文）
    const mSample = p.match(/^\/api\/samples\/([^/]+)$/);
    if (mSample && req.method === 'GET') {
      try { return send(res, 200, portal.sampleDetail(mSample[1])); }
      catch (e) { return send(res, e.status || 500, { error: e.message }); }
    }

    // ---------- 静态资源 ----------
    // /synthetic/* —— 合成样本图片托管（文件名含“合成样本”语义）
    const mSyn = p.match(/^\/synthetic\/([^/]+)$/);
    if (mSyn) {
      const sfp = path.join(SYN_DIR, decodeURIComponent(mSyn[1]));
      if (fs.existsSync(sfp) && fs.statSync(sfp).isFile()) {
        return send(res, 200, fs.readFileSync(sfp), MIME[path.extname(sfp).toLowerCase()] || 'image/jpeg');
      }
      return send(res, 404, { error: '合成样本不存在' });
    }

    // GET /api/dataset/index —— 病害类型 → 数据集原图清单（人工复核 / 病害档案 取真图）
    if (p === '/api/dataset/index' && req.method === 'GET') {
      try {
        const idx = JSON.parse(fs.readFileSync(DS_INDEX, 'utf-8'));
        const out = {};
        for (const k of Object.keys(idx)) out[k] = idx[k].map((n) => '/dataset/' + n);
        return send(res, 200, out);
      } catch (e) { return send(res, 200, {}); }
    }

    // /dataset/* —— 隧道缺陷检测数据集原图托管（由 D:\DataSet\images 导入，按病害类型取图）
    const mDs = p.match(/^\/dataset\/([^/]+)$/);
    if (mDs) {
      const dfp = path.join(DS_DIR, decodeURIComponent(mDs[1]));
      if (fs.existsSync(dfp) && fs.statSync(dfp).isFile()) {
        return send(res, 200, fs.readFileSync(dfp), MIME[path.extname(dfp).toLowerCase()] || 'image/jpeg');
      }
      return send(res, 404, { error: '数据集图片不存在' });
    }

    const mMedia = p.match(/^\/media\/([^/]+)$/);
    if (mMedia) {
      const fp = path.join(MEDIA_DIR, mMedia[1]);
      if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
        return send(res, 200, fs.readFileSync(fp), MIME[path.extname(fp).toLowerCase()] || 'application/octet-stream');
      }
      return send(res, 404, { error: '媒体文件不存在' });
    }
    let file = p === '/' ? '/index.html' : p;
    try { file = decodeURIComponent(file); } catch (e) { /* 保留原路径 */ }
    const fp = path.join(FRONTEND_DIR, path.normalize(file).replace(/^([.][.][/\\])+/, ''));
    if (fs.existsSync(fp) && fs.statSync(fp).isFile()) {
      const ext = path.extname(fp).toLowerCase();
      return send(res, 200, fs.readFileSync(fp), MIME[ext] || 'application/octet-stream');
    }
    return send(res, 404, { error: 'Not Found', path: p });
  } catch (e) {
    return send(res, e.status || 500, { error: e.message });
  }
});

server.listen(PORT, () => {
  console.log(`[隧途明鉴 · 隧道病害智能检测与分析系统] 服务已启动: http://localhost:${PORT}`);
  console.log('  数据接入: POST /api/ingest   模拟采集: POST /api/simulate   视频导入: POST /api/import/video');
  console.log(`  病害台账: GET  /api/defects   统计: GET /api/stats   报告: POST /api/report/excel|pdf`);
  console.log('  W0 参数化检测: POST /api/detect/image   (中间产物缓存 TTL 30 分钟，内存)');
  console.log('  模块一 AI教学: POST /api/explain/detect   PUT /api/pipeline/params   POST /api/explain/export');
  console.log('  模块二 实训台: POST /api/experiment/session|run|report   GET /api/experiment/log   POST|GET /api/sample/synthesize|library');
  console.log('  模块四 数据库: POST /api/auth/login   GET /api/db/tables(/:name)   GET /api/samples|/api/samples/:id|image/:id|pool|tunnels   GET|POST|PUT|DELETE /api/kb(/id)   GET /api/users(admin)');
  console.log('  模块五 知识图谱: GET /api/kg/stats   GET /api/kg/graph?type=&level=   GET /api/kg/explain/:defectId');
  // W0: 启动中间产物缓存周期清扫（unref，不阻塞进程退出）
  intermediateCache.startSweeper();
  // W0: 静默尝试初始化 SQLite 公共表（backend/db/schema.sql，幂等）；失败仅提示不影响运行
  try {
    const migrate = require('./db/migrate');
    const r = migrate.run();
    console.log(`[数据库] SQLite 公共表就绪: ${r.tables.length} 张（${r.tables.map((t) => t.name).join(', ')}）`);
    // 模块四：一次性播种分级知识库（表空才播种，教师可维护状态优先）+ 注入诊断建议查表 resolver
    const kbm = kb.migrateLib();
    fusion.setSuggestionResolver(kb.getSuggestions);
    console.log(`[知识库] ${kbm.inserted ? '已迁移代码常量库 ' + kbm.inserted + ' 套 → knowledge_base（5类×4级）' : '已有 ' + kb.count() + ' 条（教师维护态，不覆盖）'}；诊断建议已切换为查表生成`);
    // 模块四：固定演示账号（admin/teacher/student，口令 123456）
    const seed = auth.seedDemoUsers();
    console.log(`[账号] 演示账号就绪 admin/teacher/student（口令 123456）新增 ${seed.added} · 补默认口令 ${seed.patched}`);
    // 模块五：一次性播种知识图谱本体（表空才播种；已有图谱不覆盖）
    const kgs = kg.seedIfEmpty();
    console.log(`[知识图谱] ${kgs.seeded ? '已播种 ' + kgs.entities + ' 实体 / ' + kgs.relations + ' 关系' : '已有 ' + kgs.entities + ' 实体 / ' + kgs.relations + ' 关系（不覆盖）'}`);
    // 演示数据自播种（开箱即用）：库为空时用内置合成样本走真实推理链路入库（可整批删除）
    require('./seed-demo').seedIfEmpty().then((demoSeed) => {
      console.log(`[演示数据] ${demoSeed.seeded
        ? '已播种 ' + demoSeed.count + ' 条演示检测记录（5 类病害 · 来源「演示播种」，可在台账删除）'
        : '已有检测数据 · 跳过演示播种' + (demoSeed.reason ? '（' + demoSeed.reason + '）' : '')}`);
    }).catch((e) => console.log(`[演示数据] 播种跳过: ${e.message}`));
  } catch (e) {
    console.log(`[数据库] SQLite 初始化跳过: ${e.message}（手动执行: node backend/db/migrate.js）`);
  }
  // 默认仅加载达到质量门槛的 YOLOv8n ONNX；实验权重默认停用并明确回退。
  require('./detector').init().catch((e) => console.log(`[提示] ${e.message}`));
  // 数据驱动训练轮：加载训练判别模型（data/model_params.json），enabled 时注入融合引擎
  try {
    const mf = process.env.TUNNEL_MODEL_PARAMS || path.join(__dirname, 'data', 'model_params.json');
    const mp = model.loadFromFile(mf);
    if (mp) {
      modelState.file = mf;
      modelState.params = mp;
      if (mp.enabled !== false) {
        fusion.setClassifier(model.createPredictor(mp).classify);
        console.log(`[模型] 已注入训练判别模型（softmax·${mp.classes.length}类，阈值 ${mp.threshold}）—— GET /api/model/info 查指标，POST /api/model/mode 切换 rules/learned`);
      } else {
        console.log('[模型] 训练模型已加载但 enabled=false，当前使用规则引擎（POST /api/model/mode 可切换）');
      }
    } else {
      console.log('[模型] 未找到训练模型（node backend/train/train.js 可训练生成），当前使用规则引擎');
    }
  } catch (e) { console.log(`[模型] 加载失败: ${e.message}`); }
});
