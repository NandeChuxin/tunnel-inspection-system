/**
 * tools/build-source-package.js — 整理「检测方向」与「人工复核」两条链路的源码包
 *
 * 产出：
 *   源代码整理/
 *     01-检测方向/代码/   后端检测链路文件 + 前端检测代码段（按行号抽取，带出处表头）
 *     02-人工复核/代码/   后端复核接口/台账 + 前端复核与详情弹窗代码段
 *     00-抽取清单.txt     每个抽取段的源文件与行号范围（可复核）
 *
 * 说明：前端是单文件（docs/prototype-holo-core.html，~5200 行），
 *       这里把与两条链路相关的段落按行号抽取成独立文件，便于阅读与提交。
 * 用法：node tools/build-source-package.js
 */
const fs = require('fs');
const path = require('path');

const PROJ = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system';
const OUT = path.join(PROJ, '源代码整理');
const D1 = path.join(OUT, '01-检测方向', '代码');
const D2 = path.join(OUT, '02-人工复核', '代码');
const FE = path.join(PROJ, 'docs', 'prototype-holo-core.html');
const SERVER = path.join(PROJ, 'backend', 'server.js');

const log = [];
function L(s) { log.push(s); fs.appendFileSync(path.join(OUT, '00-抽取清单.txt'), s + '\n'); }
function ensure(p) { fs.mkdirSync(p, { recursive: true }); }
function clr(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); fs.mkdirSync(p, { recursive: true }); }

/* ---------- 前端按行号抽取 ---------- */
const feLines = fs.readFileSync(FE, 'utf8').split('\n');
const svLines = fs.readFileSync(SERVER, 'utf8').split('\n');

function extract(lines, from, to) {
  return lines.slice(from - 1, to).join('\n');
}
function writeExcerpt(dst, srcName, from, to, title, lines) {
  const header = [
    '/* ============================================================================',
    ' * ' + title,
    ' * 出处：' + srcName + '  第 ' + from + '–' + to + ' 行（原文照搬，仅加本表头）',
    ' * ========================================================================== */',
    '',
  ].join('\n');
  fs.writeFileSync(dst, header + extract(lines, from, to) + '\n');
  L('✓ ' + path.relative(OUT, dst) + '   ← ' + path.basename(srcName) + ' L' + from + '–' + to);
}

/* ---------- 后端整文件复制 ---------- */
function copyFile(srcRel, dstDir, dstName) {
  const s = path.join(PROJ, srcRel);
  if (!fs.existsSync(s)) { L('!! 缺少 ' + srcRel); return; }
  fs.copyFileSync(s, path.join(dstDir, dstName));
  L('✓ ' + path.relative(OUT, path.join(dstDir, dstName)) + '   ← ' + srcRel + '（整文件）');
}

/* ============================ 执行 ============================ */
ensure(OUT);
fs.writeFileSync(path.join(OUT, '00-抽取清单.txt'),
  '源码抽取清单（由 tools/build-source-package.js 生成，可随时重跑复核）\n生成时间：' + new Date().toISOString() + '\n\n');
clr(D1); clr(D2);

L('【01 检测方向 · 后端】');
[['backend/vision.js', 'vision-图像处理与PNG编解码.js'],
 ['backend/fusion.js', 'fusion-特征融合与病害分级.js'],
 ['backend/infer.js', 'infer-检测编排与DetectResult.js'],
 ['backend/model.js', 'model-训练模型推理(15维分类器).js'],
 ['backend/mask.js', 'mask-实例掩码(框内Otsu+连通域).js'],
 ['backend/detector.js', 'detector-YOLOv8n-ONNX推理.js'],
 ['backend/intermediate-cache.js', 'intermediate-cache-中间产物缓存(TTL).js'],
 ['backend/db/schema.sql', 'db-schema-数据库建表(image_detection等).sql'],
].forEach(([s, d]) => copyFile(s, D1, d));

L('');
L('【01 检测方向 · 训练与评测（backend/train/）】');
['gen-dataset.js', 'build-samples.js', 'train.js', 'train-mix.js', 'eval-real.js', 'ablation.js', 'export-yolo.js']
  .forEach((f) => copyFile('backend/train/' + f, D1, 'train-' + f));

L('');
L('【01 检测方向 · 前端（docs/prototype-holo-core.html 摘录）】');
writeExcerpt(path.join(D1, 'frontend-01-检测工作台UI.html'), FE, 1194, 1219,
  '工位 01 检测工作台 · 面板结构与控件（HTML，含 labFile 上传框 / labDrop 拖放区 / labCanvas 画布 / labList 检出列表）', feLines);
writeExcerpt(path.join(D1, 'frontend-02-Lab模块-检测逻辑.js'), FE, 2354, 3119,
  '§4 检测工作台（Lab）功能层：后端基址判定、PNG 载入、runDetect（POST /api/detect/image）、'
  + 'runHeat（POST /api/explain/detect）、视频取帧、结果卡渲染、检测框绘制、事件绑定', feLines);
writeExcerpt(path.join(D1, 'frontend-03-卡片01上传绑定.js'), FE, 4873, 5044,
  '工位 01 的上传/粘贴/拖放绑定与「完整工作台」入口（Modules 内）', feLines);
writeExcerpt(path.join(D1, 'frontend-04-源码索引-接口摘录.js'), SERVER, 267, 310,
  '后端 server.js：POST /api/detect/image（检测接口）与参数化管线接口', svLines);

L('');
L('【02 人工复核 · 后端】');
copyFile('backend/store.js', D2, 'store-病害台账JSON读写.js');
writeExcerpt(path.join(D2, 'server-复核接口摘录.js'), SERVER, 223, 262,
  '后端 server.js：GET /api/defects（台账查询）/ POST /api/defects/:id/review（通过·驳回）/ '
  + 'GET /api/defects/:id（单条详情）—— 人工复核的全部写入口', svLines);

L('');
L('【02 人工复核 · 前端（docs/prototype-holo-core.html 摘录）】');
writeExcerpt(path.join(D2, 'frontend-01-工位04复核卡UI.html'), FE, 1283, 1298,
  '工位 04 人工复核 · 面板结构（HTML：待复核计数 rvMeter / 队列 rvList / 刷新队列 rvRefresh）', feLines);
writeExcerpt(path.join(D2, 'frontend-02-复核队列逻辑.js'), FE, 3596, 3647,
  '卡片 05 人工复核逻辑：队列排序（真实样本优先+时间倒序）、分页轮换、renderReview()、'
  + '通过/驳回按钮 → POST /api/defects/:id/review', feLines);
writeExcerpt(path.join(D2, 'frontend-03-病害详情弹窗UI.html'), FE, 1516, 1556,
  '病害详情弹窗 #rvModal 结构（HTML）：图像区 / 基本信息 / 判定依据 / 处置办法 + 人工审核区（备注 + 通过/驳回）', feLines);
writeExcerpt(path.join(D2, 'frontend-04-病害详情弹窗样式.css'), FE, 438, 521,
  '病害详情弹窗样式（CSS）：四区布局、图像与检出框叠加、状态色（待审核/通过/驳回）', feLines);
writeExcerpt(path.join(D2, 'frontend-05-病害详情弹窗逻辑.js'), FE, 3648, 3803,
  '病害详情弹窗逻辑：openRvDetail()（组装四区）、renderFig()（真实原图回源 / 同类型示例图）、'
  + 'submitRv()（提交复核并原地刷新）、Esc 分层关闭', feLines);
writeExcerpt(path.join(D2, 'frontend-06-刷新队列按钮.js'), FE, 5060, 5090,
  '「刷新队列」按钮：翻页轮换 + 「刷新中…」最小可见反馈 + 播报', feLines);

L('');
L('【附：复核数据从哪来（工具脚本）】');
copyFile('tools/reopen-real-for-review.js', D2, 'tools-reopen-real-for-review-真实样本置回待复核.js');
copyFile('tools/sync-real-batch2-to-ledger.js', D2, 'tools-sync-real-batch2-to-ledger-SQLite真值写台账.js');

fs.writeFileSync(path.join(OUT, '00-抽取清单.txt'), fs.readFileSync(path.join(OUT, '00-抽取清单.txt'), 'utf8') + '\n');
console.log(JSON.stringify({ ok: true, lines: log.length }, null, 1));
