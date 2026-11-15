/**
 * w0-verify.js — W0 轮验证脚本（一键运行）
 *
 * 运行：node backend/w0-verify.js     （自动拉起服务，无需手动 start；零第三方依赖）
 *
 * 验证内容：
 *   [离线] 1. SQLite 迁移：8 张公共表一次建好、幂等可重跑
 *   [离线] 2. fusion 推理参数化回归：默认参数行为与改造前一致（返回结构/阈值0.55）
 *   [离线] 3. vision 图像管线：PNG 编解码往返、参数化预处理、ROI 提取、特征激活
 *   [离线] 4. infer 统一 DetectResult：中间产物 6 项（含热力图占位）、缓存 key=任务ID、TTL30min
 *   [HTTP] 5. 旧 API 回归：/api/health /api/simulate /api/defects /api/stats /api/ingest(400)
 *   [HTTP] 6. 新接口：/api/detect/image 默认参数 + 自定义参数，均返回中间产物；耗时 ≤1500ms
 *   [HTTP] 7. GET /api/detect/result/{taskId} 与 /intermediate/{key} 取回
 */
const { spawn } = require('child_process');
const net = require('net');
const fs = require('fs');
const path = require('path');

const BACKEND_DIR = path.join(__dirname);
let failures = 0;
const ok = (cond, msg) => {
  console.log((cond ? '  ✔ ' : '  ✘ ') + msg);
  if (!cond) failures++;
};

/* ---------------- 工具 ---------------- */
function assert(cond, msg) { ok(!!cond, msg); }

async function freePort() {
  return new Promise((res, rej) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => { const p = srv.address().port; srv.close(() => res(p)); });
    srv.on('error', rej);
  });
}
async function waitHealth(base, timeoutMs = 15000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    try {
      const r = await fetch(base + '/api/health');
      if (r.ok) return true;
    } catch (e) { /* 服务尚未就绪 */ }
    await new Promise((r) => setTimeout(r, 250));
  }
  return false;
}

/* ---------------- 合成隧道样本（确定性 LCG，模拟：裂缝+渗漏+衬砌纹理） ---------------- */
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
  // 竖直裂缝（锯齿，宽约12）
  for (let y = 28; y < 212; y++) {
    const off = Math.round(Math.sin(y / 17) * 1.2);
    for (let x = 148 + off; x < 160 + off; x++) {
      const g = 30 + rnd() * 10;
      const i = (y * W + x) * 4;
      rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
    }
  }
  // 渗漏暗斑（亮度渐变模拟湿渍扩散）
  for (let y = 148; y < 230; y++) for (let x = 236; x < 306; x++) {
    const g = 60 + 40 * (y - 148) / 82 + rnd() * 8;
    const i = (y * W + x) * 4;
    rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
  }
  return rgba;
}

/* ================================================================ */
async function runOffline() {
  console.log('\n== 1. SQLite 迁移（10 张公共表：8 张业务 + 2 张知识图谱） ==');
  const migrate = require('./db/migrate');
  const r1 = migrate.run();
  ok(!r1.missing.length, `迁移成功，共 ${r1.tables.length} 张表（期望 10）`);
  for (const t of r1.tables) console.log(`     - ${t.name.padEnd(18)} ${t.count} 行`);
  const r2 = migrate.run(); // 幂等重跑
  ok(r2.tables.length === 10, '迁移幂等：重复执行不报错、表数仍为 10');

  console.log('\n== 2. fusion 推理参数化回归（默认行为不变） ==');
  const fusion = require('./fusion');
  const simulator = require('./simulator');
  const frameA = simulator.makeFrame({ tunnel: '回归隧道', mileage: 12000 });
  const resDefault = fusion.analyze(frameA);                          // 改造前调用方式（无参数）
  const resExplicit = fusion.analyze(frameA, {});                     // 改造后默认参数调用
  ok(resDefault.threshold === 0.55 && resExplicit.threshold === 0.55, '默认置信度阈值仍为 0.55');
  ok(resDefault.detections.length === resExplicit.detections.length, `检测数一致（无参=${resDefault.detections.length} / 默认参=${resExplicit.detections.length}）`);
  const legacyKeys = ['frameId', 'analyzedAt', 'threshold', 'detections'];
  ok(legacyKeys.every((k) => k in resDefault) && Object.keys(resDefault).length === legacyKeys.length,
    '返回结构未新增字段（兼容旧调用方）');
  const d0 = resDefault.detections[0];
  ok(!d0 || ['type', 'level', 'levelNo', 'confidence', 'position', 'suggestions'].every((k) => k in d0),
    '单条检测字段结构不变');
  const resStrict = fusion.analyze(frameA, { threshold: 0.999 });
  ok(resStrict.detections.length <= resDefault.detections.length, `阈值调高检测数不增（${resStrict.detections.length} ≤ ${resDefault.detections.length}）`);
  const resLoose = fusion.analyze(frameA, { threshold: 0.01 });
  ok(resLoose.detections.length >= resDefault.detections.length, `阈值调低检测数不降（${resLoose.detections.length} ≥ ${resDefault.detections.length}）`);

  console.log('\n== 3. vision 图像管线（纯 JS 零依赖） ==');
  const vision = require('./vision');
  const W = 480, H = 300;
  const rgba = makeTunnelSample(W, H, 42);
  const pngBuf = vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba));
  const sampleFile = path.join(BACKEND_DIR, 'data', 'w0_sample_tunnel.png');
  fs.writeFileSync(sampleFile, pngBuf);
  const dec = vision.decodePng(pngBuf);
  ok(dec.width === W && dec.height === H && dec.rgba.length === W * H * 4, 'PNG 编码→解码往返一致');
  const tVis = Date.now();
  const an = vision.analyzeImage(dec.rgba, W, H, {}); // 默认参数（2.0/8×8/5×5/70/Otsu）
  const visMs = Date.now() - tVis;
  ok(an.rois.length >= 1, `预处理+ROI 提取完成（${an.rois.length} 个候选，耗时 ${visMs}ms）`);
  ok('clahe' in an.maps && 'cannyMask' in an.maps && 'darkMask' in an.maps && 'activation' in an.maps,
    '中间产物图就绪：CLAHE / Canny / Otsu / 特征激活');
  const tCustom = Date.now();
  vision.analyzeImage(dec.rgba, W, H, { claheClipLimit: 1.5, claheTileGridSize: 6, gaussianKernelSize: 3, cannyThreshold: 55, otsuEnabled: false });
  ok(true, `自定义预处理参数可执行（耗时 ${Date.now() - tCustom}ms）`);

  console.log('\n== 4. infer 统一 DetectResult + 中间产物缓存 ==');
  const infer = require('./infer');
  const p = infer.normalizeParams({});
  ok(p.confidenceThreshold === 0.55 && p.claheClipLimit === 2.0 && p.claheTileGridSize === 8
    && p.gaussianKernelSize === 5 && p.cannyThreshold === 70 && p.otsuEnabled === true && p.iouThreshold === null,
    '参数默认值 = 当前系统使用值（0.55 / 2.0 / 8 / 5 / 70 / Otsu开 / IoU关）');
  const dataUrl = 'data:image/png;base64,' + pngBuf.toString('base64');
  const dr = await infer.detectImage({ tunnel: '验证隧道', mileage: 12500, image: { dataUrl }, params: {} });
  assert(dr.taskId && dr.createdAt, '返回 taskId 与时间戳');
  assert(Array.isArray(dr.detections), 'detections 为数组');
  const keys = dr.intermediates.map((i) => i.key);
  assert(['original', 'clahe', 'canny', 'otsu', 'feature_map', 'heatmap'].every((k) => keys.includes(k)),
    '中间产物 6 项齐全（原始帧/CLAHE/Canny/Otsu/特征图/热力图）');
  const heat = dr.intermediates.find((i) => i.key === 'heatmap');
  assert(heat && heat.dataUrl === null && /占位/.test(heat.note), '热力图为占位接口（dataUrl=null，备注下一轮实现）');
  const orig = dr.intermediates.find((i) => i.key === 'original');
  assert(orig && orig.dataUrl.startsWith('data:image/png;base64,'), '中间产物 Base64 内联回传');
  assert(dr.expiresAt - Date.now() >= 29.5 * 60 * 1000, '缓存 TTL ≥ 30 分钟（expiresAt 校验）');
  assert(dr.elapsedMs < 1500, `单张推理总耗时 ${dr.elapsedMs}ms < 1500ms`);
  const cached = infer.getResult(dr.taskId);
  assert(cached && cached.taskId === dr.taskId, '缓存可取回（key=任务ID）');
  const { png } = infer.getIntermediatePng(dr.taskId, 'original');
  assert(png && png.length > 100, '中间产物 PNG 原图取回成功');
  const det0 = dr.detections[0];
  if (det0) {
    assert(['class_id', 'class_name', 'confidence', 'bbox', 'area_px', 'width_mm', 'level', 'review_status']
      .every((k) => k in det0), '检测框含统一字段（class/conf/bbox/area/width_mm/level/review_status）');
  }
  const classes = dr.summary.byClass || {};
  console.log(`     检出 ${dr.detections.length} 处:`, JSON.stringify(classes));
  return dataUrl;
}

/* ================================================================ */
async function runHttp(dataUrl) {
  console.log('\n== 5. 旧 API 回归（HTTP） ==');
  const health = await (await fetch(BASE + '/api/health')).json();
  ok(health.ok === true, '/api/health 正常');
  const sim = await (await fetch(BASE + '/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' })).json();
  const simKeys = Object.keys(sim).sort();
  ok(JSON.stringify(simKeys) === JSON.stringify(['analysis', 'defects', 'frame']), '/api/simulate 返回结构未变（frame/analysis/defects）');
  ok(sim.analysis.threshold === 0.55, `/api/simulate 分析阈值仍为 0.55（实际 ${sim.analysis.threshold}）`);
  const defects = await (await fetch(BASE + '/api/defects')).json();
  ok(Array.isArray(defects), '/api/defects 正常');
  const stats = await (await fetch(BASE + '/api/stats')).json();
  ok(stats && typeof stats.total === 'number', '/api/stats 正常');
  const bad = await fetch(BASE + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"foo":1}' });
  ok(bad.status === 400, '/api/ingest 非法包仍返回 400');

  console.log('\n== 6. 新接口：/api/detect/image ==');
  const tHttp = Date.now();
  const postBody = JSON.stringify({ tunnel: '验证隧道', mileage: 12600, image: { dataUrl }, params: {} });
  const r1 = await fetch(BASE + '/api/detect/image', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: postBody });
  const dr1 = await r1.json();
  ok(r1.status === 200 && dr1.taskId, '默认参数调用返回 200 + taskId');
  ok(dr1.params.confidenceThreshold === 0.55 && dr1.params.claheClipLimit === 2.0 && dr1.params.iouThreshold === null,
    '参数默认值回显（0.55 / CLAHE 2.0 / IoU 关闭）');
  const keys1 = dr1.intermediates.map((i) => i.key);
  ok(['original', 'clahe', 'canny', 'otsu', 'feature_map', 'heatmap'].every((k) => keys1.includes(k)), '中间产物 6 项齐全');
  ok(dr1.elapsedMs < 1500, `默认参数总耗时 ${dr1.elapsedMs}ms < 1500ms（HTTP 实测 ${Date.now() - tHttp}ms）`);
  const hasLeak = dr1.detections.some((d) => d.class_name === '渗漏水');
  ok(hasLeak, '默认参数检出渗漏水（合成样本暗斑）');

  // 自定义参数（全部生效点）
  const customParams = {
    confidenceThreshold: 0.3, iouThreshold: 0.5, claheClipLimit: 1.5,
    claheTileGridSize: 6, gaussianKernelSize: 3, cannyThreshold: 55, otsuEnabled: false,
  };
  const r2 = await fetch(BASE + '/api/detect/image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tunnel: '验证隧道', image: { dataUrl }, params: customParams }),
  });
  const dr2 = await r2.json();
  const p2 = dr2.params;
  ok(r2.status === 200
    && p2.confidenceThreshold === 0.3 && p2.iouThreshold === 0.5 && p2.claheClipLimit === 1.5
    && p2.claheTileGridSize === 6 && p2.gaussianKernelSize === 3 && p2.cannyThreshold === 55
    && p2.otsuEnabled === false, '自定义参数全部生效并回显');
  ok(dr2.summary.nms && dr2.summary.nms.applied === true, 'IoU 阈值启用 NMS（summary.nms.applied=true）');
  ok(dr2.elapsedMs < 1500, `自定义参数总耗时 ${dr2.elapsedMs}ms < 1500ms`);
  ok(dr2.detections.length >= 1, '自定义参数调用返回有效检测');
  // 仅放宽置信度（其余同默认）→ 检测数应不减少，验证阈值参数真正作用于推理
  const r2b = await fetch(BASE + '/api/detect/image', {
    method: 'POST', headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ tunnel: '验证隧道', image: { dataUrl }, params: { confidenceThreshold: 0.3 } }),
  });
  const dr2b = await r2b.json();
  ok(dr2b.detections.length >= dr1.detections.length,
    `仅放宽置信度后检出不减少（${dr2b.detections.length} ≥ ${dr1.detections.length}）`);
  console.log(`     默认参数检出 ${dr1.detections.length} 处 / 全自定义参数检出 ${dr2.detections.length} 处 / 阈值0.3检出 ${dr2b.detections.length} 处`);

  console.log('\n== 7. 取回：result / intermediate ==');
  const g1 = await fetch(BASE + '/api/detect/result/' + dr1.taskId);
  const g1j = await g1.json();
  ok(g1.status === 200 && g1j.taskId === dr1.taskId, 'GET /api/detect/result/{taskId} 取回一致');
  const g2 = await fetch(BASE + '/api/detect/result/' + dr1.taskId + '/intermediate/original');
  ok(g2.status === 200 && g2.headers.get('content-type') === 'image/png', 'GET /intermediate/original 返回 PNG');
  const g3 = await fetch(BASE + '/api/detect/result/TASK__not_exist');
  ok(g3.status === 404, '不存在的任务返回 404（缓存 TTL 管理生效）');
}

/* ================================================================ */
async function main() {
  console.log('==========================================================');
  console.log('  隧途明鉴 W0 验证 · 推理层参数化 + 公共数据模型');
  console.log('==========================================================');
  const dataUrl = await runOffline();

  // 拉起服务做 HTTP 层验证（随机空闲端口，结束后自动关闭）
  const port = await freePort();
  process.env.TUNNEL_PORT = String(port);
  const child = spawn(process.execPath, ['server.js'], {
    cwd: BACKEND_DIR, env: { ...process.env }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  global.BASE = `http://127.0.0.1:${port}`;
  let childLog = '';
  child.stdout.on('data', (d) => (childLog += d));
  child.stderr.on('data', (d) => (childLog += d));
  const up = await waitHealth(global.BASE);
  if (!up) {
    console.error('服务启动失败:\n' + childLog);
    child.kill();
    process.exit(1);
  }
  try {
    await runHttp(dataUrl);
  } finally {
    child.kill();
  }

  console.log('\n==========================================================');
  if (failures === 0) console.log('  W0 验证全部通过 ✔  （补充深度回归可运行: node backend/smoke-test.js）');
  else console.log(`  W0 验证存在 ${failures} 项失败 ✘`);
  console.log('==========================================================');
  process.exit(failures ? 1 : 0);
}

main().catch((e) => { console.error('W0 验证异常:', e); process.exit(1); });
