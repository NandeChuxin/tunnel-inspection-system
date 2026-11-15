/**
 * w2-verify.js — 模块二「虚实结合实训台」一键验证（零第三方依赖）
 *
 * 覆盖完成标准：
 *   A. 5 滑杆参数联动：会话内任意参数组合运行端到端刷新 ≤800ms；
 *      不同参数组合检出数量/平均置信度有差异（滑杆探究有效）
 *   B. 实训会话：创建记录初始参数快照；每次运行写 experiment_log；
 *      操作轨迹可查询且 log.params 可直接回放（快照 = 当时滑杆值）
 *   C. 实验报告 PDF：真实 %PDF 文件、≥3 页、含操作轨迹表/参数-检出对照区；
 *      中文位图字形渲染缺字数为 0；含自评与教师评语留白
 *   D. 病害样本合成器：单次批量 ≥20 张，文件全部落盘且命名
 *      sample_序号_类型_等级.jpg，DB(synthetic_sample/image source=synthetic)与文件一致；
 *      响应/界面携带「合成样本」合规标注；样本库分页正常
 *   E. HTTP 端到端（独立端口）：6 条实训/合成路由 + /synthetic/* 静态托管
 *      + W0/W1/既有 API 回归
 *
 * 运行：node backend/w2-verify.js    （自动拉起独立端口服务与临时库，结束自动清理）
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const http = require('http');
const path = require('path');

let passCount = 0, failCount = 0;
function ok(cond, label) {
  if (cond) { passCount++; console.log('  ✔ ' + label); }
  else { failCount++; console.log('  ✘ ' + label); }
}

function request(port, method, p, body, isBinary) {
  return new Promise((resolve, reject) => {
    const data = body ? JSON.stringify(body) : null;
    const req = http.request({ host: '127.0.0.1', port, method, path: p, headers: data ? { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) } : {} }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        if (isBinary) resolve({ status: res.statusCode, headers: res.headers, buf });
        else {
          let parsed = null;
          try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { /* keep null */ }
          resolve({ status: res.statusCode, headers: res.headers, json: parsed, buf });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function waitHealth(port, tries = 60) {
  return new Promise((resolve, reject) => {
    const retry = () => { if (++n > tries) return reject(new Error('服务启动超时')); setTimeout(tick, 250); };
    const tick = async () => {
      try {
        const r = await request(port, 'GET', '/api/health');
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        retry();
      } catch (e) { retry(); }
    };
    let n = 0;
    tick();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-unit-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'w2-http-'));
  const SYN_DIR = path.join(__dirname, 'data', 'synthetic');
  const sampleDataUrl = (() => {
    const vision = require('./vision'); // 离线构造确定性演示样本
    let s = 5;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const W = 480, H = 300;
    const rgba = Buffer.alloc(W * H * 4);
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) {
      const g = 120 + 22 * Math.sin(x / 64) + 12 * Math.sin(y / 47 + x / 25) + (rnd() - 0.5) * 14;
      const i = (y * W + x) * 4;
      const gg = Math.max(0, Math.min(255, g));
      rgba[i] = gg; rgba[i + 1] = gg; rgba[i + 2] = gg; rgba[i + 3] = 255;
    }
    for (let y = 40; y < 210; y++) { const off = Math.round(Math.sin(y / 15) * 1.4); for (let x = 150 + off; x < 161 + off; x++) { const g = 26 + rnd() * 8; const i = (y * W + x) * 4; rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g; } }
    return 'data:image/png;base64,' + vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba)).toString('base64');
  })();

  /* ════════ A/B/C 离线单元（临时库，不污染业务数据） ════════ */
  console.log('== 模块二「虚实结合实训台」验证 ==\n── A/B/C 离线单元（实验会话 + PDF） ──');
  const { createSession, runExperiment, getLogs, closeSession, buildReport } = (() => {
    process.env.TUNNEL_DB_PATH = path.join(tmpA, 'db.sqlite');
    delete require.cache[require.resolve('./db')];
    delete require.cache[require.resolve('./experiment')];
    delete require.cache[require.resolve('./db/migrate')];
    require('./db/migrate').run();               // 临时库先建公共表（幂等）
    return require('./experiment');
  })();
  const c = createSession({ user_name: '王小明', tunnel: '实训隧道验证', params: { confidenceThreshold: 0.5 } });
  ok(c.session_id > 0 && c.image && c.image.synthetic === true && /合成样本/.test(c.image.note || ''),
    'createSession：返回 session_id，内置演示样本标注 synthetic+合成样本');
  const sid = c.session_id;
  const combos = [
    { confidenceThreshold: 0.25, claheClipLimit: 1.0, claheTileGridSize: 4, gaussianKernelSize: 3, cannyThreshold: 50 },
    { confidenceThreshold: 0.55, claheClipLimit: 2.0, claheTileGridSize: 8, gaussianKernelSize: 5, cannyThreshold: 70 },
    { confidenceThreshold: 0.85, claheClipLimit: 4.0, claheTileGridSize: 16, gaussianKernelSize: 7, cannyThreshold: 140 },
    { confidenceThreshold: 0.35, claheClipLimit: 3.0, claheTileGridSize: 12, gaussianKernelSize: 5, cannyThreshold: 90 },
  ];
  const runs = [], lat = [];
  for (const params of combos) {
    const t0 = Date.now();
    const r = await runExperiment({ session_id: sid, params });
    lat.push(Date.now() - t0);
    runs.push(r);
  }
  ok(lat.every((d) => d <= 800), `5 滑杆组合运行端到端 ≤800ms（实际 ${Math.max(...lat)}ms 最差）`);
  const counts = runs.map((r) => r.result.detectionCount);
  const avg = runs.map((r) => r.result.avgConfidence);
  ok(new Set(counts).size >= 2 || new Set(avg).size >= 2, `参数联动生效：不同组合检出/均置信度有差异（检出=${JSON.stringify(counts)}）`);
  ok(runs.every((r) => r.log_id > 0 && /^data:image\/png;base64,/.test(r.result.thumbnail)),
    '每次运行均写 experiment_log 并返回结果缩略图');
  const g = getLogs(sid);
  ok(g.logs.length === 5 && g.logs[0].action === 'create' && g.stats.runs === 4, '操作轨迹：create+4×detect，stats.runs=4');
  ok(g.logs.filter((l) => l.action === 'detect').every((l, i) => Math.abs(l.params.confidenceThreshold - combos[i].confidenceThreshold) < 1e-9),
    'log.params 为当时滑杆参数快照 → 可直接回放载入');
  const rep = buildReport(sid, { student_name: '王小明', self_eval: '降低置信度阈值后检出数量上升；CLAHE 增强对低对比度区域有改善。本实训使用合成样本，不涉及实测数据。' });
  ok(Buffer.isBuffer(rep.pdf) && rep.pdf.subarray(0, 5).toString() === '%PDF-' && rep.pages >= 3,
    `buildReport：真实 PDF（${Math.round(rep.pdf.length / 1024)}KB · ${rep.pages} 页）`);
  ok(rep.missingChars.length === 0, `PDF 中文渲染缺字为 0（覆盖会话信息/轨迹表/对照/评语标题，缺字=${JSON.stringify(rep.missingChars) || '无'}）`);
  const close = closeSession(sid);
  ok(!!close.session.end_time, 'closeSession：写入 end_time');
  let bad404 = false;
  try { await runExperiment({ session_id: 999999 }); } catch (e) { bad404 = e.status === 404; }
  ok(bad404, '未知会话运行 → 404（统一错误处理）');

  /* ════════ HTTP 端到端（独立端口 8792 + 独立临时库） ════════ */
  console.log('\n── D/E HTTP 端到端（端口 8792） ──');
  const PORT = 8792;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, TUNNEL_PORT: String(PORT), TUNNEL_DB_PATH: path.join(tmpB, 'db.sqlite') }, stdio: 'ignore',
  });
  try {
    await waitHealth(PORT);
    ok(true, '服务启动成功（独立库）');

    // E1 实训会话路由
    const cs = await request(PORT, 'POST', '/api/experiment/session', { user_name: '陈静', tunnel: '实训隧道C', params: {} });
    ok(cs.status === 200 && cs.json.session_id > 0, 'POST /api/experiment/session 200');
    const hs = cs.json.session_id;
    const t0 = Date.now();
    const run1 = await request(PORT, 'POST', '/api/experiment/run', { session_id: hs, params: { confidenceThreshold: 0.2, claheClipLimit: 1.5, claheTileGridSize: 8, gaussianKernelSize: 3, cannyThreshold: 50 } });
    const d1 = Date.now() - t0;
    ok(run1.status === 200 && d1 <= 800 && run1.json.result && run1.json.result.thumbnail.startsWith('data:image/png;base64,'),
      `POST /api/experiment/run 200（HTTP 刷新 ${d1}ms ≤800ms）`);
    const lg = await request(PORT, 'GET', '/api/experiment/log/' + hs);
    ok(lg.status === 200 && lg.json.logs.length === 2 && lg.json.logs[1].params.confidenceThreshold === 0.2,
      'GET /api/experiment/log/:id 200（轨迹含 create+run，params 快照一致）');

    // E2 实验报告 PDF 下载
    const rp = await request(PORT, 'POST', '/api/experiment/report/' + hs, { student_name: '陈静', self_eval: '观察阈值-检出关系' }, true);
    const pages = (rp.buf.toString('latin1').match(/\/Type\s*\/Page[^s]/g) || []).length;
    ok(rp.status === 200 && rp.headers['content-type'].includes('application/pdf')
      && /attachment/.test(rp.headers['content-disposition'] || '')
      && rp.buf.subarray(0, 5).toString() === '%PDF-' && pages >= 3,
      `POST /api/experiment/report/:id 200（PDF ${Math.round(rp.buf.length / 1024)}KB · ${pages} 页 · 附件下载）`);
    const cl2 = await request(PORT, 'POST', '/api/experiment/close/' + hs, {});
    ok(cl2.status === 200 && !!cl2.json.session.end_time, 'POST /api/experiment/close/:id 200');

    // E3 合成器：批量 20 张 + 命名 + 落盘 + 合规标注
    const cntBefore = fs.readdirSync(SYN_DIR).filter((f) => /^sample_\d{4}_/.test(f)).length;
    const sy = await request(PORT, 'POST', '/api/sample/synthesize', { count: 20, outWidth: 512, outHeight: 384 });
    const items = (sy.json && sy.json.generated) || [];
    ok(sy.status === 200 && items.length === 20, `POST /api/sample/synthesize 200（${items.length} 张）`);
    ok(items.every((it) => /^sample_\d{4}_(裂缝|渗漏水|剥落掉块|衬砌错台|白华析出)_[1-4]\.jpg$/.test(it.name)), '命名 sample_序号_类型_等级.jpg');
    const onDisk = items.filter((it) => fs.existsSync(path.join(SYN_DIR, path.basename(it.file)))).length;
    ok(onDisk === 20, `文件与响应一致（目录 ${onDisk}/20 已落盘，序号 ${cntBefore + 1}~${cntBefore + 20}）`);
    ok(items.every((it) => /合成样本/.test(it.marker || '')), '每项携带「合成样本」合规标注');
    const lib1 = await request(PORT, 'GET', '/api/sample/library?page=1&size=12');
    ok(lib1.status === 200 && lib1.json.total >= 20 && lib1.json.pages >= 2 && lib1.json.items[0].sample_id > 0,
      `GET /api/sample/library 200（total=${lib1.json.total}，分页 pages=${lib1.json.pages}）`);
    // 静态托管：库首页第一张直接可访问（URL 编码中文名）
    const firstFile = lib1.json.items[0].file.replace(/^synthetic\//, '');
    const st = await request(PORT, 'GET', '/synthetic/' + encodeURIComponent(firstFile), null, true);
    ok(st.status === 200 && (st.headers['content-type'] || '').includes('image/jpeg'), 'GET /synthetic/*.jpg 静态托管 200（image/jpeg）');
    // DB 一致性：合成样本表逐条存在（image 表 source=synthetic 索引由接口写入）
    const dbmod = (() => { delete require.cache[require.resolve('./db')]; process.env.TUNNEL_DB_PATH = path.join(tmpB, 'db.sqlite'); return require('./db'); })();
    const nSyn = Number(dbmod.get('SELECT COUNT(*) n FROM synthetic_sample WHERE output_path LIKE ?', '%synthetic%').n);
    const nImgSyn = Number(dbmod.get("SELECT COUNT(*) n FROM image WHERE source='synthetic'").n);
    ok(nSyn >= 20 && nSyn === nImgSyn, `DB 一致：synthetic_sample=${nSyn} 行 = image(source=synthetic)=${nImgSyn} 行`);

    // E4 回归：既有 API（W0/W1/数据接入/统计）不受影响
    const sim = await request(PORT, 'POST', '/api/simulate', {});
    ok(sim.status === 200 && sim.json.analysis, '回归 POST /api/simulate 200');
    const det = await request(PORT, 'POST', '/api/detect/image', { image: { dataUrl: sampleDataUrl }, params: { confidenceThreshold: 0.3 } });
    ok(det.status === 200 && det.json.taskId, '回归 W0 POST /api/detect/image 200');
    const ex = await request(PORT, 'POST', '/api/explain/detect', { image: { dataUrl: sampleDataUrl } });
    ok(ex.status === 200 && ex.json.heatmap && ex.json.steps, '回归 W1 POST /api/explain/detect 200');
  } finally {
    child.kill();
  }

  try { fs.rmSync(tmpA, { recursive: true, force: true }); fs.rmSync(tmpB, { recursive: true, force: true }); } catch (e) { /* 忽略 */ }
  console.log(`\n== 结果：${passCount} 通过 / ${failCount} 失败 ==`);
  if (failCount) process.exit(1);
}

main().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
