/**
 * tools/zip-source-package.js — 把「源代码整理」打成可直接提交的 zip
 *
 * 产出：源代码整理/源码包-当前版本.zip
 *   内容：整理好的两份链路说明 + 两模块代码 + 全量源码（backend / frontend / tools / 前端单文件 / README）
 *   包含：可运行演示数据库、训练参数、YOLOv8n ONNX 权重与 npm 依赖清单；
 *   排除：大体积原始媒体/训练图片、部署产物、node_modules
 * 用法：node tools/zip-source-package.js
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJ = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system';
const PKG = path.join(PROJ, '源代码整理');
const STAGE = path.join(PKG, '_stage');
const ZIP = path.join(PKG, '源码包-当前版本.zip');

const log = [];
function L(s) { log.push(s); console.log(s); }
function ensure(p) { fs.mkdirSync(p, { recursive: true }); }

function copyTree(src, dst, skipDirs, skipRe) {
  if (!fs.existsSync(src)) { L('!! 缺少 ' + src); return 0; }
  let n = 0;
  ensure(dst);
  for (const f of fs.readdirSync(src, { withFileTypes: true })) {
    if (skipDirs && skipDirs.includes(f.name)) continue;
    const s = path.join(src, f.name), d = path.join(dst, f.name);
    if (f.isDirectory()) n += copyTree(s, d, skipDirs, skipRe);
    else {
      if (skipRe && skipRe.test(f.name)) continue;
      fs.copyFileSync(s, d); n++;
    }
  }
  return n;
}

ensure(PKG);
if (fs.existsSync(STAGE)) fs.rmSync(STAGE, { recursive: true, force: true });
ensure(STAGE);

L('== 组装提交包 ==');

/* 1) 两份链路说明 + 抽取清单 + 两模块代码 */
fs.copyFileSync(path.join(PKG, 'README-源码导览.md'), path.join(STAGE, 'README-源码导览.md'));
fs.copyFileSync(path.join(PKG, '00-抽取清单.txt'), path.join(STAGE, '00-抽取清单.txt'));
let n = copyTree(path.join(PKG, '01-检测方向'), path.join(STAGE, '01-检测方向'));
n += copyTree(path.join(PKG, '02-人工复核'), path.join(STAGE, '02-人工复核'));
L('✓ 链路说明与代码：' + n + ' 个文件');

/* 2) 全量源码（不含运行数据） */
const FULL = path.join(STAGE, '全量源码');
ensure(FULL);
fs.copyFileSync(path.join(PROJ, 'README.md'), path.join(FULL, 'README.md'));
fs.copyFileSync(path.join(PROJ, 'package.json'), path.join(FULL, 'package.json'));
fs.copyFileSync(path.join(PROJ, 'package-lock.json'), path.join(FULL, 'package-lock.json'));
let m = copyTree(path.join(PROJ, 'backend'), path.join(FULL, 'backend'), ['data', 'node_modules', 'smoke'], /\.log$/i);
m += copyTree(path.join(PROJ, 'frontend'), path.join(FULL, 'frontend'));
m += copyTree(path.join(PROJ, 'tools'), path.join(FULL, 'tools'));
ensure(path.join(FULL, 'docs'));
fs.copyFileSync(path.join(PROJ, 'docs', 'prototype-holo-core.html'),
  path.join(FULL, 'docs', 'prototype-holo-core.html'));
fs.copyFileSync(path.join(PROJ, 'docs', '技术方案-隧途明鉴.md'),
  path.join(FULL, 'docs', '技术方案-隧途明鉴.md'));
L('✓ 全量源码：' + m + ' 个文件（已排除 backend/data 运行数据）');

/* 3) 最小可运行数据与模型：解决源码包只有页面、后端空库/无权重的问题。 */
const RUNTIME = path.join(STAGE, '可运行数据与模型');
ensure(path.join(RUNTIME, 'backend', 'data', 'train'));
[
  ['backend/data/tunnel.db', 'backend/data/tunnel.db'],
  ['backend/data/defects.json', 'backend/data/defects.json'],
  ['backend/data/model_params.json', 'backend/data/model_params.json'],
  ['backend/data/train/metrics.json', 'backend/data/train/metrics.json'],
  ['backend/data/train/eval-metrics.json', 'backend/data/train/eval-metrics.json'],
].forEach(([s, d]) => {
  const src = path.join(PROJ, s), dst = path.join(RUNTIME, d);
  if (fs.existsSync(src)) { ensure(path.dirname(dst)); fs.copyFileSync(src, dst); }
});
const onnxSrc = path.join(PROJ, 'yolo-workspace', 'runs', 'smoke-yolov8n', 'weights', 'best.onnx');
const onnxDst = path.join(RUNTIME, 'yolo-workspace', 'runs', 'smoke-yolov8n', 'weights', 'best.onnx');
ensure(path.dirname(onnxDst));
fs.copyFileSync(onnxSrc, onnxDst);
fs.copyFileSync(path.join(PROJ, 'yolo-workspace', 'runs', 'smoke-yolov8n', 'metrics.json'),
  path.join(RUNTIME, 'yolo-workspace', 'runs', 'smoke-yolov8n', 'metrics.json'));
copyTree(path.join(PROJ, 'backend', 'data', 'real-dataset'),
  path.join(RUNTIME, 'backend', 'data', 'real-dataset'));
fs.writeFileSync(path.join(RUNTIME, 'README-运行.txt'),
  '把本目录内容按原相对路径覆盖到“全量源码”，然后执行 npm install、npm start。\r\n' +
  '数据库已含 D:/Dataset 的 330 张真实图片与 530 个 YOLO 真值框；YOLOv8n ONNX 默认自动加载。\r\n');
L('✓ 已加入 SQLite 数据库、330 张真实图片、训练参数与 YOLOv8n ONNX 权重');

/* 4) 压缩 */
if (fs.existsSync(ZIP)) fs.rmSync(ZIP, { force: true });
execFileSync('powershell.exe', ['-NoProfile', '-Command',
  'Compress-Archive -Path "' + STAGE + '\\*" -DestinationPath "' + ZIP + '" -Force; ' +
  '(Get-Item "' + ZIP + '").Length'], { stdio: 'ignore' });
fs.rmSync(STAGE, { recursive: true, force: true });
const mb = (fs.statSync(ZIP).size / 1048576).toFixed(2);
L('✓ 已打包 ' + path.basename(ZIP) + '  ' + mb + ' MB');

fs.writeFileSync(path.join(PKG, '00-打包记录.txt'),
  new Date().toISOString() + '  源码包-当前版本.zip  ' + mb + ' MB\n' +
  '内容：README-源码导览.md / 00-抽取清单.txt / 01-检测方向 / 02-人工复核 / 全量源码(backend+frontend+tools+前端单文件+README)\n');
