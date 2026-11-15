/**
 * tools/build-materials.js — 组装「参赛材料包」（排除式复制，逐步落盘日志）
 * 用法：node tools/build-materials.js ；日志：docs/_mat.log（每步即写）
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const PROJ = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system';
const MAT = path.join(PROJ, '参赛材料');
const LOGF = path.join(PROJ, 'docs', '_mat.log');
const LOG = [];
function log(s) { LOG.push(s); fs.appendFileSync(LOGF, s + '\n'); }
// 每次运行清空旧日志（历史累积会混淆判断）
rmrf(LOGF);

function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }

/** 带排除清单的递归复制 */
function copyEx(src, dst, excludeDirs, excludeRe) {
  if (!fs.existsSync(src)) { log('!! 缺少: ' + src); return; }
  ensureDir(dst);
  for (const f of fs.readdirSync(src)) {
    const s = path.join(src, f), d = path.join(dst, f);
    const st = fs.statSync(s);
    if (st.isDirectory()) {
      if (excludeDirs && excludeDirs.includes(f)) continue;
      copyEx(s, d, excludeDirs, excludeRe);
    } else {
      if (excludeRe && excludeRe.test(f)) continue;
      fs.copyFileSync(s, d);
    }
  }
}
/** 单文件复制（缺文件记日志不中断） */
function copy(src, dst) {
  if (!fs.existsSync(src)) { log('!! 缺少: ' + src); return; }
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
  log('✓ ' + path.relative(MAT, dst));
}

log('== start ==');
const D1 = path.join(MAT, '01-技术方案素材');
const D2 = path.join(MAT, '02-源代码与模型');
const D3 = path.join(MAT, '03-效果验证');
const D4 = path.join(MAT, '04-演示材料');
const D5 = path.join(MAT, '05-授权与参考');
[D1, D2, D3, D4, D5].forEach(ensureDir);

/* 1) 源代码：排除式复制（backend 排除 data/smoke/日志/测试图；tools 排除 node_modules；docs 只留核心文档与原型 html） */
const src = path.join(D2, 'source');
rmrf(src);
ensureDir(src);
copyEx(path.join(PROJ, 'backend'), path.join(src, 'backend'), ['data', 'smoke'], /\.log$|^(jc_|jf_|jpeg_|w0_|w1_).*\.jpg$/i);
copyEx(path.join(PROJ, 'frontend'), path.join(src, 'frontend'), null, /\.log$/i);
copyEx(path.join(PROJ, 'tools'), path.join(src, 'tools'), ['node_modules'], /\.log$|_tmp\.|\.mp4$/i);
ensureDir(path.join(src, 'docs'));
copyEx(path.join(PROJ, 'docs'), path.join(src, 'docs'), ['_vid'], /\.(png|jpg|jpeg|mp4|log)$/i);
fs.copyFileSync(path.join(PROJ, 'README.md'), path.join(src, 'README.md'));
log('✓ 源码复制完成（排除 data/smoke/日志/测试图/媒体）');

/* 2) 模型与关键指标（附录「代码与模型」） */
ensureDir(path.join(src, 'backend', 'data', 'train'));
ensureDir(path.join(src, 'backend', 'data', 'train-real'));
for (const s of [
  'backend/data/model_params.json',
  'backend/data/model_params.pre-batch2.json',
  'backend/data/train/metrics.json',
  'backend/data/train-real/eval-real.json',
  'backend/data/train-real/labels.json',
  'backend/data/experiments.json',
]) {
  const sp = path.join(PROJ, s);
  const d = s.replace('backend/data/', '');
  if (fs.existsSync(sp)) { fs.copyFileSync(sp, path.join(src, 'backend', 'data', d)); log('✓ model/metrics: ' + d); }
  else log('!! 缺少: ' + sp);
}

/* 3) zip */
const zip = path.join(D2, 'source-code.zip');
rmrf(zip);
const sizeFile = path.join(D2, '_zipsize.txt');
rmrf(sizeFile);
try {
  execFileSync('powershell.exe', ['-NoProfile', '-Command',
    'Compress-Archive -Path "' + src + '\\*" -DestinationPath "' + zip + '" -Force; ' +
    'if (Test-Path "' + zip + '") { [string](Get-Item "' + zip + '").Length | Set-Content "' + sizeFile + '" -Encoding Ascii }'],
    { stdio: 'ignore', timeout: 240000 });
  const sz = fs.existsSync(sizeFile) ? fs.readFileSync(sizeFile, 'utf-8').trim() : '?';
  log('✓ source-code.zip 打包完成 ' + (parseInt(sz || 0, 10) / 1048576).toFixed(1) + ' MB');
} catch (e) { log('!! zip 失败: ' + e.message.split('\n')[0]); }
rmrf(src);

/* 4) 效果验证 */
copy(path.join(PROJ, 'docs', 'research-report-2026-09-13.md'), path.join(D3, '科研评测报告-2026-09-13.md'));
copy(path.join(PROJ, 'docs', 'research-report-2026-09-13.xlsx'), path.join(D3, '科研评测报告-2026-09-13.xlsx'));
copy(path.join(PROJ, 'backend', 'data', 'experiments.json'), path.join(D3, '实验台账-experiments.json'));
copy(path.join(PROJ, 'backend', 'data', 'train', 'metrics.json'), path.join(D3, '训练指标-metrics.json'));
copy(path.join(PROJ, 'backend', 'data', 'train-real', 'eval-real.json'), path.join(D3, '真实域端到端评测-eval-real.json'));

/* 4) 演示材料（源图可能已在瘦身中清理：仅在存在时刷新，已归档副本保留） */
copy(path.join(PROJ, 'docs', 'tunnel-system-demo.mp4'), path.join(D4, '系统演示视频-76s.mp4'));
['消融实验.png', 'arc-07-research.png', 'arc-08-kgask.png', 'arc-08-lab2kg-wide.png', 'arc-08-lab2kg-narrow.png']
  .filter((f) => fs.existsSync(path.join(PROJ, 'docs', f)))
  .forEach((f) => copy(path.join(PROJ, 'docs', f), path.join(D4, f)));

/* 4b) 技术方案成稿 → 01 */
const techDoc = path.join(PROJ, 'docs', '技术方案-隧途明鉴.md');
if (fs.existsSync(techDoc)) copy(techDoc, path.join(D1, '技术方案-隧途明鉴.md'));
/* 清理参赛材料内的临时文件 */
rmrf(path.join(D2, '_zipsize.txt'));
rmrf(path.join(D2, '_ziplist.txt'));

/* 6) 说明索引 */
fs.writeFileSync(path.join(MAT, '材料清单-README.txt'), [
  '参赛材料包 · 隧途明鉴（全球校园 AI 算法精英大赛 · AI+学科交叉赛道）',
  '',
  '01-技术方案素材/  技术方案素材包.md —— 八部分大纲逐节「提纲+事实素材」，据此汇总正文',
  '02-源代码与模型/  source-code.zip —— 全部源代码 + model_params.json 模型 + metrics 指标',
  '                  （不含运行数据库与图像数据；复现步骤见 zip 内 README）',
  '03-效果验证/      科研评测报告（md+xlsx）、实验台账、训练指标、真实域端到端评测',
  '04-演示材料/      系统演示视频（76s 真实录屏）+ 各功能界面截图',
  '05-授权与参考/    数据与知识产权说明（草稿，【待补】2处）、参考文献与引用条款清单（18 项规范条款）',
  '',
  '【您需要补齐】：技术方案正文（按素材包汇总）、团队分工、数据集授权来源、试点案例。',
].join('\n'));
log('== done ==');
console.log('LOG lines: ' + LOG.length);
