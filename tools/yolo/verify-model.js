#!/usr/bin/env node
/**
 * verify-model.js — YOLO 质量门控 + ONNX 推理端到端验收
 *
 * 不是在测「函数返回 true」，而是把 detector.js 真正初始化一遍，验证链条：
 *   best.onnx 存在 → 找到配套 metrics.json → assessQuality 判定可启用
 *   → onnxruntime-node 实际加载 → 输出张量形状 [1, 4+nc, 8400] 与类别数一致
 *   → 拿一张真实测试集影像真正跑一次推理 → 输出 bbox/clsHint 合法
 *
 * 任一步失败即退出码 1，并打印卡在哪一环。
 *
 * 用法：
 *   node tools/yolo/verify-model.js [--image <png>]
 */
'use strict';
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', '..');
const detector = require(path.join(ROOT, 'backend', 'detector'));
const EXPECTED_ANCHORS = 8400;      // 640×640 下 YOLOv8 的 80²+40²+20²

function fail(msg) {
  console.log('\n✗ 验收失败：' + msg);
  process.exit(1);
}

(async () => {
  const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const info0 = detector.info();
  const modelPath = process.env.TUNNEL_YOLO_MODEL ||
    path.join(ROOT, 'yolo-workspace', 'runs', '6class-yolov8n', 'weights', 'best.onnx');

  console.log('════════ YOLO 质量门控 + ONNX 端到端验收 ════════\n');
  console.log('模型路径：' + modelPath);
  if (!fs.existsSync(modelPath)) fail('模型文件不存在');

  /* ---- ① 配套指标 + 门槛判定 ---- */
  const metricsPath = path.join(path.dirname(path.dirname(modelPath)), 'metrics.json');
  if (!fs.existsSync(metricsPath)) fail('缺少配套 metrics.json：' + metricsPath);
  const m = JSON.parse(fs.readFileSync(metricsPath, 'utf8'));
  const assessment = detector.assessQuality({
    epochs: Number(m.epochs), mAP50: Number(m.mAP50), recall: Number(m.recall),
  });

  console.log('\n① 指标文件：' + metricsPath);
  console.log('   门槛：' + JSON.stringify(detector.QUALITY_MIN));
  const rows = [
    ['epochs', Number(m.epochs), detector.QUALITY_MIN.epochs],
    ['mAP50', Number(m.mAP50), detector.QUALITY_MIN.mAP50],
    ['recall', Number(m.recall), detector.QUALITY_MIN.recall],
  ];
  for (const [k, v, min] of rows) {
    console.log(`   ${k.padEnd(8)} ${String(v).padEnd(10)} ≥ ${min}  ${Number.isFinite(v) && v >= min ? '✓' : '✗'}`);
  }
  console.log('   判定：' + (assessment.ready ? '✓ 达到生产启用门槛' : '✗ ' + assessment.reason));
  if (!assessment.ready) fail('质量门控未通过：' + assessment.reason);

  /* ---- ② 真正初始化（走 detector.init 的完整门控逻辑） ---- */
  console.log('\n② 调用 detector.init() …');
  await detector.init();
  if (!detector.isActive()) fail('init() 返回了但 isActive() 仍为 false');
  const info = detector.info();
  console.log('   active = ' + info.active);
  console.log('   quality.ready = ' + (info.quality && info.quality.ready));
  console.log('   类别 = [' + info.classes.join(', ') + ']');
  if (info.classes.length !== 5) fail('detector.TYPES 应为 5 类，实际 ' + info.classes.length);

  /* ---- ③ ONNX 输出张量形状 ---- */
  console.log('\n③ 校验 ONNX 输出张量形状 …');
  const ort = require(path.join(ROOT, 'node_modules', 'onnxruntime-node'));
  const session = await ort.InferenceSession.create(modelPath);
  const isz = detector.INPUT_SIZE;
  const probe = new ort.Tensor('float32', new Float32Array(3 * isz * isz), [1, 3, isz, isz]);
  const out = await session.run({ [session.inputNames[0]]: probe });
  const outName = session.outputNames[0];
  const dims = out[outName].dims;
  const planes = dims[1];
  console.log('   输入名 = ' + session.inputNames[0] + ' ｜ 输出名 = ' + outName);
  console.log('   输出形状 = [' + dims.join(', ') + ']');
  if (dims[0] !== 1 || planes !== 4 + info.classes.length || dims[2] !== EXPECTED_ANCHORS) {
    fail(`输出形状应为 [1, ${4 + info.classes.length}, ${EXPECTED_ANCHORS}]，实际 [${dims.join(', ')}]（类别数或 imgsz 与 detector.js 契约不一致）`);
  }
  console.log('   ✓ 4 + nc = ' + planes + '，锚点 = ' + dims[2] + '，与 detector.js 契约一致');

  /* ---- ④ 真实影像推理 ---- */
  console.log('\n④ 用真实测试集影像跑一次 detector.detect() …');
  let imgPath = argOf('image', null);
  if (!imgPath) {
    const cand = path.join(ROOT, 'yolo-workspace', '.cache', 'png', 'test');
    const pngs = fs.existsSync(cand) ? fs.readdirSync(cand).filter((f) => f.endsWith('.png')).sort() : [];
    if (!pngs.length) fail('未找到可用的测试 PNG（先执行 PNG 缓存生成，或用 --image 指定）');
    imgPath = path.join(cand, pngs[0]);
  }
  const buf = fs.readFileSync(imgPath);
  const t0 = Date.now();
  const dets = await detector.detect(buf);
  const ms = Date.now() - t0;
  console.log('   影像：' + path.relative(ROOT, imgPath) + '（' + (buf.length / 1024).toFixed(0) + ' KB）');
  console.log('   耗时：' + ms + ' ms ｜ 检出框：' + dets.length + ' 个');
  const tally = {};
  for (const d of dets) {
    if (!Array.isArray(d.bbox) || d.bbox.length !== 4) fail('bbox 结构不合法');
    const [x, y, w, h] = d.bbox;
    if (![x, y, w, h].every((v) => Number.isFinite(v) && v >= 0 && v <= 1)) fail('bbox 归一化坐标越界：' + d.bbox);
    if (!info.classes.includes(d.clsHint)) fail('clsHint 不在类别表内：' + d.clsHint);
    if (!(d.clsScore >= detector.CLS_THRESHOLD && d.clsScore <= 1)) fail('clsScore 越界：' + d.clsScore);
    tally[d.clsHint] = (tally[d.clsHint] || 0) + 1;
  }
  for (const d of dets.slice(0, 10)) {
    console.log(`     - ${d.clsHint.padEnd(6)} ${d.clsScore.toFixed(3)}  bbox=[${d.bbox.map((v) => v.toFixed(3)).join(', ')}]`);
  }
  if (dets.length) console.log('   类别分布：' + JSON.stringify(tally, null, 0));

  console.log('\n════════ 验收结论 ════════');
  console.log('✓ 质量门控自动启用：YOLO 已加载且 active=true');
  console.log('✓ ONNX 契约一致：输入 ' + isz + '×' + isz + '，输出 [1, ' + planes + ', ' + dims[2] + ']');
  console.log('✓ 真实影像推理：' + dets.length + ' 个合法检测框（' + ms + ' ms）');
  console.log('\n提示：本脚本不做精度判断，精度以 metrics.json 的 val 指标为准。');
  process.exit(0);
})().catch((e) => fail(e && e.stack ? e.stack : String(e)));
