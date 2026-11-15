/**
 * w1-verify.js — 模块一「可解释AI教学展示」一键验证（零第三方依赖）
 *
 * 覆盖完成标准：
 *   A. 热力图高亮区域与检测框位置吻合（框内/框外热强度比 ratio > 1.2，客观量化）
 *   B. 四步中间结果正确输出，参数调整后实时更新（且只重算受影响步骤：
 *      前序步骤 PNG 字节不变，可客观证明未做全链路重复推理）
 *   C. 导出讲解图包含全部标注元素（检测框颜色像素落在对应 bbox 内 + 页眉文本区非空白）
 *   D. 单张推理（含可视化）≤1.5 秒
 *   E. HTTP 端到端：POST /api/explain/detect · PUT|GET /api/pipeline/params ·
 *      POST /api/explain/export；回归原有 API（/api/simulate /api/stats /api/health）
 *
 * 运行：node backend/w1-verify.js   （自动拉起独立端口服务，结束自动关闭）
 */
const { spawn } = require('child_process');
const http = require('http');
const path = require('path');
const fs = require('fs');
const vision = require('./vision');
const heatmap = require('./heatmap');
const composite = require('./composite');
const explain = require('./explain');

let passCount = 0, failCount = 0;
function ok(cond, label) {
  if (cond) { passCount++; console.log('  ✔ ' + label); }
  else { failCount++; console.log('  ✘ ' + label); }
}

/** 合成教学样本：真实感衬砌纹理 + 竖直裂缝 + 渗漏暗斑（确定性，可复现） */
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
  for (let y = 28; y < 212; y++) {
    const off = Math.round(Math.sin(y / 17) * 1.2);
    for (let x = 148 + off; x < 160 + off; x++) {
      const g = 30 + rnd() * 10; const i = (y * W + x) * 4;
      rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
    }
  }
  for (let y = 148; y < 230; y++) for (let x = 236; x < 306; x++) {
    const g = 60 + 40 * (y - 148) / 82 + rnd() * 8; const i = (y * W + x) * 4;
    rgba[i] = g; rgba[i + 1] = g; rgba[i + 2] = g;
  }
  return rgba;
}

function sampleDataUrl() {
  const W = 480, H = 300;
  const rgba = makeTunnelSample(W, H, 42);
  return 'data:image/png;base64,' + vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba)).toString('base64');
}

/* ---------------- HTTP 小工具 ---------------- */
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
          try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { /* 保持 null */ }
          resolve({ status: res.statusCode, headers: res.headers, json: parsed, buf });
        }
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

function waitHealth(port, tries = 40) {
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await request(port, 'GET', '/api/health');
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        retry();
      } catch (e) { retry(); }
    };
    let n = 0;
    const retry = () => {
      if (++n > tries) return reject(new Error('服务启动超时'));
      setTimeout(tick, 250);
    };
    tick();
  });
}

async function main() {
  console.log('== 模块一「可解释AI教学展示」验证 ==\n── 离线单元 ──');

  // ---- 1) 热力图算法模块 ----
  const chan = { edge: new Float32Array(9), dark: new Float32Array(9), bright: new Float32Array(9), tex: new Float32Array(9) };
  chan.edge[4] = 1; chan.dark[4] = 1;
  const eg = heatmap.eigenCAM(chan, 3, 3);
  ok(Math.abs(eg[4] - 0.5) < 1e-6 && eg[0] === 0, 'Eigen-CAM = ΣA_k/C（通道均值）');
  const gg = heatmap.gradCAM(chan, 3, 3, [0.8, 0.2, 0, 0], '裂缝');
  ok(gg[4] > 0 && gg[0] === 0, 'Grad-CAM = ReLU(Σw_k·A_k)');
  const j0 = heatmap.jetColor(0), j1 = heatmap.jetColor(0.625), j2 = heatmap.jetColor(1);
  ok(j0[2] > 100 && j1[0] > 200 && j1[1] > 200 && j2[0] > 100 && j2[1] < 60, 'JET 伪彩色标（近似 OpenCV COLORMAP_JET）');

  // ---- 2) explainDetect 全量 ----
  const dataUrl = sampleDataUrl();
  const t0 = Date.now();
  const r = explain.explainDetect({ image: { dataUrl }, tunnel: '青云山隧道' });
  const wallMs = Date.now() - t0;
  ok(r.detections.length > 0, `教学检测有检出（${r.detections.length} 处：${r.detections.map((d) => d.class_name + d.level_text).join('、')}）`);
  ok(r.elapsedMs < 1500 && wallMs < 1500, `单张推理(含可视化) ${r.elapsedMs}ms（墙钟 ${wallMs}ms）< 1500ms`);
  const stepKeys = Object.keys(r.steps);
  ok(stepKeys.join(',') === 'clahe,gaussian,canny,otsu' && stepKeys.every((k) => r.steps[k].dataUrl && r.steps[k].dataUrl.startsWith('data:image/png;base64,')),
    '四步中间结果按步骤ID输出（clahe/gaussian/canny/otsu，Base64 PNG）');
  ok(r.heatmap.overlay.dataUrl && r.heatmap.alpha === 0.45 && r.heatmap.color.dataUrl,
    `热力图 α=0.45 叠加图与伪彩图齐备（实际方式=${r.heatmap.method}，目标类=${r.heatmap.targetClass}）`);
  ok(r.heatmap.overlap.ratio > 1.2 && r.heatmap.overlap.inside > r.heatmap.overlap.outside,
    `热力高亮与检测框吻合：框内 ${r.heatmap.overlap.inside} ≫ 框外 ${r.heatmap.overlap.outside}（ratio ${r.heatmap.overlap.ratio}）`);
  ok(r.heatmap.fallbackReason && r.heatmap.method === 'eigen',
    'auto 主路线：深度模型梯度未接入 → 自动回退 Eigen-CAM（需求预设回退语义）');

  // ---- 3) 局部重算（只重跑受影响步骤） ----
  const p1 = explain.updatePipeline({ taskId: r.taskId, params: { cannyThreshold: 110 } });
  ok(p1.recomputedSteps.join(',') === 'canny' && p1.firstAffectedStep === 'canny',
    '仅调 Canny 阈值 → 只重算 canny（依赖链定位正确）');
  ok(p1.steps.clahe.dataUrl === r.steps.clahe.dataUrl && p1.steps.gaussian.dataUrl === r.steps.gaussian.dataUrl,
    'clahe/gaussian PNG 字节不变（前序步骤未重跑，缓存命中）');
  ok(p1.steps.canny.dataUrl !== r.steps.canny.dataUrl, 'canny 结果已实时更新');

  const p2 = explain.updatePipeline({ taskId: r.taskId, params: { claheClipLimit: 3.0 } });
  ok(p2.recomputedSteps.join(',') === 'clahe,gaussian,canny', '调 CLAHE → 依依赖链重算 clahe→gaussian→canny');
  ok(p2.steps.otsu.dataUrl === r.steps.otsu.dataUrl, 'Otsu 与前 3 步无依赖 → 字节不变（独立分支不重复计算）');

  // Otsu 开关需用「Otsu 阈值未被均值×0.7 上限约束」的样本才能体现掩码变化：
  // 亮背景(≈235)+暗斑(≈55) → Otsu≈59 ≪ 上限156，关闭 Otsu 后阈值升至均值×0.7，掩码实时改变
  const brightUrl = (() => {
    let s = 7;
    const rnd = () => { s = (s * 16807) % 2147483647; return s / 2147483647; };
    const W = 320, H = 240;
    const rgba = Buffer.alloc(W * H * 4);
    for (let i = 0; i < W * H; i++) {
      const g = 235 + (rnd() - 0.5) * 14, o = i * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g; rgba[o + 3] = 255;
    }
    for (let y = 90; y < 150; y++) for (let x = 120; x < 200; x++) {
      const g = 55 + (rnd() - 0.5) * 10, o = (y * W + x) * 4;
      rgba[o] = rgba[o + 1] = rgba[o + 2] = g;
    }
    return 'data:image/png;base64,' + vision.encodePngRGB(W, H, vision.rgbFromRgba(rgba)).toString('base64');
  })();
  const rOtsu = explain.explainDetect({ image: { dataUrl: brightUrl }, tunnel: 'Otsu验证' });
  const pOtsuOn = explain.updatePipeline({ taskId: rOtsu.taskId, params: {} }); // 取当前步骤基线
  const p3 = explain.updatePipeline({ taskId: rOtsu.taskId, params: { otsuEnabled: false } });
  ok(p3.recomputedSteps.join(',') === 'otsu' && p3.steps.otsu.dataUrl !== pOtsuOn.steps.otsu.dataUrl,
    'Otsu 开关 → 仅重算 otsu，且分割结果实时更新（阈值 59→均值×0.7）');

  // ---- 4) 热力图方式切换（复用会话，不整链重推理） ----
  const p4 = explain.updatePipeline({ taskId: r.taskId, heatmapMethod: 'eigen' });
  ok(p4.heatmapChanged === true && p4.heatmap.method === 'eigen' && p4.heatmap.overlay.dataUrl,
    '配置切换热力图方式（auto→eigen）即时生效');
  const p5 = explain.updatePipeline({ taskId: r.taskId, heatmapMethod: 'gradcam' });
  ok(p5.heatmap.method === 'eigen' && p5.heatmap.fallbackReason,
    '强制 Grad-CAM 但无模型梯度 → 按需求回退 Eigen 并给出说明（两种实现保留、可配置）');

  // ---- 5) 导出讲解图：标注元素齐备 ----
  const ex = explain.exportLecture(r.taskId);
  const dec = vision.decodePng(ex.png);
  const d0 = r.detections[0];
  const color = composite.TYPE_COLORS[d0.class_name];
  const [bx, by, bw, bh] = d0.bbox;
  let found = 0;
  for (let y = Math.floor(by * dec.height); y < Math.ceil((by + bh) * dec.height); y++) {
    for (let x = Math.floor(bx * dec.width); x < Math.ceil((bx + bw) * dec.width); x++) {
      const o = (y * dec.width + x) * 4;
      if (Math.abs(dec.rgba[o] - color[0]) <= 8 && Math.abs(dec.rgba[o + 1] - color[1]) <= 8 && Math.abs(dec.rgba[o + 2] - color[2]) <= 8) found++;
    }
  }
  ok(ex.detectionsRendered === r.detections.length && found > 50,
    `讲解图：${ex.detectionsRendered} 个检测框均已绘制（首框内命中 ${found} 个类别色像素）`);
  // 页眉文本区非空白（标题+信息行已渲染）
  let dark = 0;
  for (let y = 0; y < 30; y++) for (let x = 0; x < dec.width; x += 2) {
    const o = (y * dec.width + x) * 4;
    if (dec.rgba[o] > 200 && dec.rgba[o + 1] > 200) dark++;
  }
  ok(dark > 30, '讲解图：页眉含标题/隧道/桩号/等级文本（白色文字像素已渲染）');
  ok(dec.width === ex.W && dec.height === ex.H, `讲解图尺寸一致（${ex.W}×${ex.H}）`);

  // ---- 6) HTTP 端到端 + 原有 API 回归 ----
  console.log('\n── HTTP 端到端（独立端口 8791） ──');
  const PORT = 8791;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, TUNNEL_PORT: String(PORT) }, stdio: 'ignore',
  });
  try {
    await waitHealth(PORT);
    ok(true, '服务启动成功');

    const rd = await request(PORT, 'POST', '/api/explain/detect', { image: { dataUrl }, tunnel: '青云山隧道' });
    ok(rd.status === 200 && rd.json.taskId && rd.json.steps && rd.json.heatmap,
      `POST /api/explain/detect 200（检出 ${rd.json.summary.detectionCount}，耗时 ${rd.json.elapsedMs}ms）`);
    ok(rd.json.elapsedMs < 1500, 'HTTP 链路推理 ≤1.5s');

    const rp = await request(PORT, 'PUT', '/api/pipeline/params', { taskId: rd.json.taskId, params: { cannyThreshold: 90 } });
    ok(rp.status === 200 && rp.json.recomputedSteps.join(',') === 'canny',
      'PUT /api/pipeline/params 200（仅重算 canny）');

    const rg = await request(PORT, 'GET', '/api/pipeline/params');
    ok(rg.status === 200 && rg.json.params && rg.json.params.cannyThreshold === 90,
      'GET /api/pipeline/params 200（返回当前参数）');

    const re = await request(PORT, 'POST', '/api/explain/export', { taskId: rd.json.taskId }, true);
    ok(re.status === 200 && (re.headers['content-type'] || '').includes('image/png') && re.buf.length > 10000 && re.headers['content-disposition'].includes('attachment'),
      `POST /api/explain/export 200（PNG ${Math.round(re.buf.length / 1024)}KB，附件下载）`);

    // 回归：原有 API
    const rs = await request(PORT, 'POST', '/api/simulate', {});
    ok(rs.status === 200 && rs.json.analysis, '回归 POST /api/simulate 200（原功能不受影响）');
    const rst = await request(PORT, 'GET', '/api/stats');
    ok(rst.status === 200 && typeof rst.json.json === 'undefined' && rst.json.total !== undefined, '回归 GET /api/stats 200');
    const rw0 = await request(PORT, 'POST', '/api/detect/image', { image: { dataUrl }, params: { confidenceThreshold: 0.3 } });
    ok(rw0.status === 200 && Array.isArray(rw0.json.intermediates), '回归 W0 POST /api/detect/image 200');
  } finally {
    child.kill();
  }

  console.log(`\n== 结果：${passCount} 通过 / ${failCount} 失败 ==`);
  if (failCount) process.exit(1);
}

main().catch((e) => { console.error('验证脚本异常：', e); process.exit(1); });
