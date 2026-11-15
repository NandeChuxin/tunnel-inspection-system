/**
 * verify-base.js —— 本轮「基础改造」验收脚本（一键运行，零第三方依赖）
 *
 * 运行：node backend/verify-base.js
 *
 * 验证内容（对应本轮 4 项任务）：
 *   [离线] 1. 迁移脚本：4 张必需表（tunnel / image / detection / users）+ 必备列
 *               （含 detection.reviewer）一次建好，且幂等可重复执行
 *   [HTTP] 2. 检测结果自动入库：POST /api/detect/image 带 tunnel 时，
 *               image 无记录则自动创建，detection 随之写入并正确关联 image_id
 *   [HTTP] 3. 宽度标定：带 calibrationPxPerMm → width_mm = 检测框窄边像素 / 比例；
 *               不带标定 → width_mm 存 NULL（标记“待补标定”）
 *   [HTTP] 4. 原有 API 回归：/api/health /api/simulate /api/defects /api/stats
 *               /api/ingest(400) /api/report/excel 行为不变
 *
 * 隔离：全程使用临时数据库（环境变量 TUNNEL_DB_PATH 指向系统临时目录），
 *       不读写演示库 backend/data/tunnel.db，可安全反复执行。
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const os = require('os');
const path = require('path');

const BACKEND_DIR = __dirname;
const TMP_DB = path.join(os.tmpdir(), `tis_verify_base_${Date.now()}.db`);
process.env.TUNNEL_DB_PATH = TMP_DB; // 必须在 require('./db/migrate') 之前设置

let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};

/* ---------------- 本轮验收口径（4 张必需表 + 必备列） ---------------- */
const SPEC = {
  tunnel: ['tunnel_id', 'name', 'type', 'location', 'length_m', 'owner'],
  image: ['image_id', 'tunnel_id', 'capture_time', 'position_m', 'image_path', 'source'],
  detection: ['detection_id', 'image_id', 'class_id', 'class_name', 'confidence', 'bbox',
    'area_px', 'width_mm', 'level', 'review_status', 'reviewer'],
  users: ['user_id', 'name', 'role', 'token'],
};

/* ---------------- 工具 ---------------- */
async function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
    srv.on('error', rej);
  });
}
async function waitHealth(base, timeoutMs = 20000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try { const r = await fetch(base + '/api/health'); if (r.ok) return true; } catch (e) { /* 未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}
/** 统一 HTTP 请求：返回 { status, json, buf, headers } */
async function req(base, method, p, body) {
  const opt = { method, headers: {} };
  if (body !== undefined) {
    opt.headers['Content-Type'] = 'application/json';
    opt.body = JSON.stringify(body);
  }
  const r = await fetch(base + p, opt);
  const buf = Buffer.from(await r.arrayBuffer());
  let json = null;
  try { json = JSON.parse(buf.toString('utf-8')); } catch (e) { /* 二进制响应 */ }
  return { status: r.status, json, buf, headers: r.headers };
}

/* ---------------- 确定性合成隧道样本（裂缝 + 渗漏 + 衬砌纹理） ---------------- */
function makeTunnelSample(W, H, seed) {
  let s = seed || 1;
  const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
  const rgba = Buffer.alloc(W * H * 4);
  for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
    const g = 118 + 28 * Math.sin(x / 68) + 14 * Math.sin(y / 51 + x / 23) + (rnd() - 0.5) * 16;
    const gg = Math.max(0, Math.min(255, g));
    const i = (y * W + x) * 4;
    rgba[i] = gg; rgba[i + 1] = gg; rgba[i + 2] = gg; rgba[i + 3] = 255;
  }
  // 竖直裂缝（锯齿，宽约 12px）
  for (let y = 28; y < Math.min(H - 20, 212); y++) {
    const off = Math.round(Math.sin(y / 17) * 1.2);
    for (let x = 148 + off; x < 160 + off && x < W; x++) {
      const g = 30 + rnd() * 10;
      const i = (y * W + x) * 4;
      rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
    }
  }
  // 渗漏暗斑（亮度渐变模拟湿渍扩散）
  for (let y = 148; y < Math.min(H, 230); y++) for (let x = 236; x < 306 && x < W; x++) {
    const g = 60 + 40 * (y - 148) / 82 + rnd() * 8;
    const i = (y * W + x) * 4;
    rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
  }
  return rgba;
}
const SAMPLE_W = 320, SAMPLE_H = 260;

/* ================================================================ */
async function runOffline() {
  console.log('\n== 1. 迁移脚本：必需表 + 扩展表 + 图谱表（临时库） ==');
  console.log('   隔离库文件: ' + TMP_DB);
  const migrate = require('./db/migrate');
  const r1 = migrate.run();                     // 首次：空库 → 一次建好
  ok(!r1.missing.length && r1.tables.length === 10,
    `迁移成功：共 ${r1.tables.length} 张公共表（必需 4 张 + 扩展 4 张 + 知识图谱 2 张），无缺失`);
  /* v5：知识图谱两表必须建出来（模块五的存储底座） */
  const kgNames = r1.tables.map((t) => t.name);
  ok(kgNames.includes('kg_entity') && kgNames.includes('kg_relation'),
    'v5 图谱表齐备：kg_entity / kg_relation');

  const r2 = migrate.run();                     // 幂等重跑
  ok(r2.tables.length === r1.tables.length && !r2.missing.length,
    '迁移幂等：连续执行两次不报错、表清单不变');

  // 列级核对：4 张必需表 + 必备列齐备（含本轮新增 detection.reviewer）
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(TMP_DB);
  const tables = raw.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
  for (const [t, cols] of Object.entries(SPEC)) {
    if (!tables.includes(t)) { ok(false, `缺少必需表 ${t}`); continue; }
    const have = new Set(raw.prepare(`PRAGMA table_info(${t})`).all().map((c) => c.name));
    const lack = cols.filter((c) => !have.has(c));
    ok(!lack.length, `${t} 表列齐备（${cols.length} 项）${lack.length ? '，缺: ' + lack.join(',') : ''}`);
  }
  ok(raw.prepare('PRAGMA user_version').get().user_version >= 4, '迁移版本标记 user_version ≥ 4');
  raw.close();
}

async function runHttp(base) {
  const vision = require('./vision');
  // seed=1：当前 model_params.json（batch2 重训后）对该合成样例稳定检出≥1 处（seed=7 已不再触发检出）
  const rgb = vision.rgbFromRgba(makeTunnelSample(SAMPLE_W, SAMPLE_H, 1));
  const dataUrl = 'data:image/png;base64,' + vision.encodePngRGB(SAMPLE_W, SAMPLE_H, rgb).toString('base64');
  const { DatabaseSync } = require('node:sqlite');
  const raw = new DatabaseSync(TMP_DB);
  const SCALE = 0.183; // px/mm（约 0.183 px 对应 1mm 的标定）

  // ---------- 2. 自动入库 ----------
  console.log('\n== 2. 检测结果自动入库（带隧道 + 标定） ==');
  const before = raw.prepare('SELECT COUNT(*) n FROM image').get().n;
  const d1 = await req(base, 'POST', '/api/detect/image', {
    tunnel: '基础改造验证隧道', mileage: 33120, captureTime: '2026-09-10T10:00:00',
    image: { dataUrl }, calibrationPxPerMm: SCALE, archive: true,
  });
  ok(d1.status === 200, `POST /api/detect/image 返回 200（实际 ${d1.status}）`);
  const aa = d1.json && d1.json.autoArchive;
  ok(aa && aa.archived === true, 'autoArchive.archived = true（检测完成后自动入库）');
  ok(aa && aa.image_id > 0, `自动创建/关联 image 记录（image_id=${aa && aa.image_id}）`);
  ok(aa && aa.detections_added > 0, `detection 行写入 ${aa && aa.detections_added} 条`);
  const after = raw.prepare('SELECT COUNT(*) n FROM image').get().n;
  ok(after === before + 1, `image 表新增 1 条（${before} → ${after}）：该图原本无记录时自动创建`);

  const imgId = aa && aa.image_id;
  const dets = raw.prepare('SELECT * FROM detection WHERE image_id=?').all(imgId);
  ok(dets.length === (aa && aa.detections_added), `detection 行与响应一致（${dets.length} 条）`);
  ok(dets.every((d) => d.image_id === imgId), 'detection.image_id 正确关联新建 image');
  ok(dets.every((d) => d.class_name && d.class_id != null), 'detection 含 class_name / class_id');
  ok(dets.every((d) => { try { const b = JSON.parse(d.bbox); return Array.isArray(b) && b.length === 4; } catch (e) { return false; } }),
    'detection.bbox 为归一化 [x,y,w,h] JSON');
  ok(dets.every((d) => d.level >= 1 && d.level <= 4), 'detection.level ∈ 1~4');
  ok(dets.every((d) => d.review_status === '待审核'), "detection.review_status = '待审核'（待人工复核）");
  ok(dets.every((d) => d.reviewer === null), 'detection.reviewer 为空=NULL（自动入库、无人复核）');
  const linked = raw.prepare('SELECT tunnel_id FROM image WHERE image_id=?').get(imgId);
  ok(linked && linked.tunnel_id != null, 'image 已关联 tunnel（隧道档案 find-or-create）');

  // ---------- 3. 宽度标定 ----------
  console.log('\n== 3. 宽度标定工具（像素→毫米换算 / 无标定存 NULL） ==');
  const W = d1.json.input && d1.json.input.widthPx;
  const src = d1.json.detections.map((d) => d.bbox);
  let calibOk = dets.length > 0;
  for (let i = 0; i < dets.length; i++) {
    const b = src[i] || [0, 0, 0, 0];
    const expect = Math.round(Math.min(b[2] * W, b[3] * W) / SCALE * 100) / 100;
    if (Math.abs((dets[i].width_mm || 0) - expect) > 0.02) calibOk = false;
  }
  ok(calibOk, `有标定：width_mm = 窄边像素 / ${SCALE}（示例 ${dets[0] ? dets[0].width_mm : '-'} mm）`);
  ok(dets.every((d) => d.width_mm != null && d.width_mm > 0), '有标定时所有 detection.width_mm 均非空');

  const d2 = await req(base, 'POST', '/api/detect/image', {
    tunnel: '基础改造验证隧道', mileage: 33200, image: { dataUrl }, archive: true,
  });
  const aa2 = d2.json && d2.json.autoArchive;
  const dets2 = raw.prepare('SELECT * FROM detection WHERE image_id=?').all(aa2 && aa2.image_id);
  ok(dets2.length > 0, `无标定同样完成入库（${dets2.length} 条）`);
  ok(dets2.every((d) => d.width_mm === null), '无 calibrationPxPerMm：width_mm 存 NULL（待补标定）');
  ok(aa2 && /待补/.test(String(aa2.width_mm_status)), `响应标记 width_mm_status=「${aa2 && aa2.width_mm_status}」`);

  // reviewer 传导
  const d3 = await req(base, 'POST', '/api/detect/image', {
    tunnel: '基础改造验证隧道', mileage: 33280, image: { dataUrl },
    calibrationPxPerMm: SCALE, archive: true, reviewer: '李工（复核）',
  });
  const dets3 = raw.prepare('SELECT * FROM detection WHERE image_id=?').all(d3.json.autoArchive.image_id);
  ok(dets3.every((d) => d.reviewer === '李工（复核）'), 'reviewer 可写入 detection.reviewer（本轮新增列生效）');

  // 无隧道 → 监控台检测不入库
  const d4 = await req(base, 'POST', '/api/detect/image', {
    tunnel: '', image: { dataUrl }, archive: true,
  });
  ok(d4.status === 200 && d4.json.autoArchive && d4.json.autoArchive.archived === false,
    '无 tunnel：检测正常返回但自动入库跳过（监控台检测不污染样本库）');

  // ---------- 4. 原有 API 回归 ----------
  console.log('\n== 4. 原有 API 回归（行为不变） ==');
  const h = await req(base, 'GET', '/api/health');
  ok(h.status === 200 && h.json.ok === true, 'GET /api/health → 200 ok');

  const sim = await req(base, 'POST', '/api/simulate', { tunnel: '回归隧道', mileage: 12000 });
  ok(sim.status === 200 && sim.json.analysis && Array.isArray(sim.json.defects),
    `POST /api/simulate → 200（analysis.detections=${sim.json.analysis.detections.length}，台账 defects=${sim.json.defects.length}）`);

  const defs = await req(base, 'GET', '/api/defects');
  ok(defs.status === 200 && Array.isArray(defs.json), `GET /api/defects → 200 数组（${defs.json.length} 条）`);

  const st = await req(base, 'GET', '/api/stats');
  ok(st.status === 200 && st.json && typeof st.json === 'object', 'GET /api/stats → 200 统计对象');

  if (defs.json.length) {
    const one = await req(base, 'GET', '/api/defects/' + defs.json[0].id);
    const rv = await req(base, 'POST', `/api/defects/${defs.json[0].id}/review`,
      { reviewer: '张工', action: '通过', decision: '纳入整治计划' });
    ok(one.status === 200 && rv.status === 200 && rv.json.review && rv.json.review.reviewer === '张工',
      'GET /api/defects/{id} 与 POST /api/defects/{id}/review 均正常');
  }

  const bad = await req(base, 'POST', '/api/ingest', {});
  ok(bad.status === 400 && bad.json.error, `POST /api/ingest 缺 image.rois → 400「${bad.json.error}」`);

  const xls = await req(base, 'POST', '/api/report/excel', { tunnel: '回归隧道' });
  ok(xls.status === 200 && xls.buf.length > 100, `POST /api/report/excel → 200 xlsx（${xls.buf.length} 字节）`);

  const pdf = await req(base, 'POST', '/api/report/pdf', { tunnel: '回归隧道' });
  ok(pdf.status === 200 && pdf.buf.length > 100, `POST /api/report/pdf → 200 html（${pdf.buf.length} 字节）`);

  // 样本详情透出 reviewer
  const sd = await req(base, 'GET', '/api/samples/' + (aa && aa.image_id));
  ok(sd.status === 200 && sd.json.detections && sd.json.detections.length > 0 && 'reviewer' in sd.json.detections[0],
    'GET /api/samples/{id} 详情含 reviewer 字段');

  raw.close();
}

/* ================================================================ */
(async function main() {
  console.log('==================================================');
  console.log(' 本轮「基础改造」验收：建表 + 检测结果自动入库 + 宽度标定 + 原接口回归');
  console.log('==================================================');
  let child = null;
  let port = 0;
  try {
    await runOffline();
    port = await freePort();
    const base = `http://127.0.0.1:${port}`;
    child = spawn(process.execPath, [path.join(BACKEND_DIR, 'server.js')], {
      env: { ...process.env, TUNNEL_DB_PATH: TMP_DB, TUNNEL_PORT: String(port) },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {});
    child.stderr.on('data', () => {});
    const up = await waitHealth(base);
    if (!up) { ok(false, '服务启动失败（健康检查超时）'); } else {
      console.log(`\n[服务] 已在 ${base} 就绪（临时库）`);
      await runHttp(base);
    }
  } catch (e) {
    ok(false, '执行异常：' + (e && e.stack ? e.stack : e.message));
  } finally {
    if (child) { try { child.kill(); } catch (e) { /* ignore */ } }
    await new Promise((r) => setTimeout(r, 300));
    try { fs.unlinkSync(TMP_DB); } catch (e) { /* ignore */ }
  }
  console.log('\n--------------------------------------------------');
  console.log(failures === 0 ? ' ✅ 全部通过：本轮 4 项要求均已满足' : ` ❌ 失败 ${failures} 项，请检查上方 ✘`);
  console.log('--------------------------------------------------');
  process.exit(failures === 0 ? 0 : 1);
})();
