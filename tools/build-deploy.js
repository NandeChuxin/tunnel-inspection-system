/**
 * tools/build-deploy.js — 组装云端部署目录 deploy/
 *
 * 结构：
 *   deploy/
 *     package.json          {scripts:{start:"node backend/server.js"}}（零依赖）
 *     backend/              后端全量（含 data：tunnel.db / 真实样本图 / 模型 / 实验台账）
 *     frontend/             index.html = 工作界面（prototype-holo-core，同源 API）
 *                           legacy-home.html = 原系统主界面（保留可访问）
 *                           app.js / explain.js / portal.js / training.js / style.css
 *     downloads.html        资源下载页（演示视频 / 评测报告 / 消融图）
 *     downloads/            上述资源文件
 *
 * 用法：node tools/build-deploy.js
 */
const fs = require('fs');
const path = require('path');

const PROJ = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system';
const DEP = path.join(PROJ, 'deploy');
const LOGF = path.join(PROJ, 'docs', '_deploy.log');
rmrf(LOGF);
const LOG = [];
function log(s) { LOG.push(s); fs.appendFileSync(LOGF, s + '\n'); }

function rmrf(p) { if (fs.existsSync(p)) fs.rmSync(p, { recursive: true, force: true }); }
function ensureDir(p) { fs.mkdirSync(p, { recursive: true }); }
function copyEx(src, dst, excludeDirs, excludeRe) {
  if (!fs.existsSync(src)) { log('!! 缺少 ' + src); return; }
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

log('== start ==');
rmrf(DEP);
ensureDir(DEP);

/* 1) package.json（零依赖，start 监听 $PORT） */
fs.writeFileSync(path.join(DEP, 'package.json'), JSON.stringify({
  name: 'tunnel-defect-ai', version: '1.0.0', private: true,
  scripts: { start: 'node backend/server.js' },
  engines: { node: '>=22.5' },
}, null, 2));
log('✓ package.json');

/* 2) backend 全量（带本地演示数据 tunnel.db / train-real / synthetic / 模型 / 台账） */
copyEx(path.join(PROJ, 'backend'), path.join(DEP, 'backend'), ['smoke'], /\.log$|^(jc_|jf_|jpeg_|w0_|w1_).*\.jpg$/i);
log('✓ backend/（含 data 演示库与真实样本图）');

/* 3) frontend：frontend/index.html 已是 prototype-holo-core 副本（同源 API）；
      旧版传统主界面保留在 frontend/legacy-home.html —— 两者各就各位，直接拷贝即可 */
copyEx(path.join(PROJ, 'frontend'), path.join(DEP, 'frontend'), null, null);
const fe = path.join(DEP, 'frontend');
if (!fs.existsSync(path.join(fe, 'legacy-home.html'))) {
  /* 兜底：老仓库没有 legacy-home.html 时，从 git 历史之外的旧副本恢复不可行，仅提示 */
  log('!! frontend/legacy-home.html 缺失（旧版主界面副本不存在）');
}
fs.copyFileSync(path.join(PROJ, 'docs', 'prototype-holo-core.html'), path.join(fe, 'index.html'));
log('✓ frontend/（index=工作界面, legacy-home=原主界面）');

/* 4) 首页注入「资源下载」入口（仅部署副本，本地原型不动） */
const idxFile = path.join(fe, 'index.html');
let idx = fs.readFileSync(idxFile, 'utf-8');
const anchor = "document.body.appendChild(tag);";
if (idx.includes(anchor)) {
  idx = idx.replace(anchor, anchor +
    ";var dl=document.createElement('a');dl.textContent='资源下载';dl.href='downloads.html';" +
    "dl.style.cssText='position:fixed;left:10px;bottom:6px;z-index:99;font:11px/1 Consolas,monospace;" +
    "color:rgba(122,147,170,.85);letter-spacing:.06em';document.body.appendChild(dl);");
  fs.writeFileSync(idxFile, idx);
  log('✓ 首页已注入资源下载入口');
} else log('!! 未找到版本角标锚点，资源入口未注入');

/* 5) downloads.html + 资源文件（放 frontend/ 内：server 静态托管覆盖） */
ensureDir(path.join(fe, 'downloads'));
const dlRes = [
  ['docs/tunnel-system-demo.mp4', '系统演示视频-76s.mp4'],
  ['docs/research-report-2026-09-13.md', '科研评测报告-2026-09-13.md'],
  ['docs/research-report-2026-09-13.xlsx', '科研评测报告-2026-09-13.xlsx'],
  ['docs/消融实验.png', '消融实验.png'],
];
for (const [s, d] of dlRes) {
  const sp = path.join(PROJ, s);
  if (fs.existsSync(sp)) { fs.copyFileSync(sp, path.join(fe, 'downloads', d)); log('✓ downloads/' + d); }
  else log('!! 缺少 ' + sp);
}
fs.writeFileSync(path.join(fe, 'downloads.html'), `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>隧途明鉴 · 资源下载</title>
<style>
  body{margin:0;min-height:100vh;background:#eef0ec;font-family:"Microsoft YaHei",system-ui,sans-serif;color:#22303c;
    display:flex;align-items:center;justify-content:center;padding:24px}
  .card{background:#fefefd;border:1px solid rgba(47,107,79,.18);border-radius:16px;padding:28px 30px;
    max-width:560px;width:100%;box-shadow:0 12px 40px -18px rgba(47,107,79,.35)}
  h1{font-size:19px;margin:0 0 4px;color:#2F6B4F}
  p.sub{margin:0 0 18px;font-size:12.5px;color:#6b7a86}
  a.res{display:flex;justify-content:space-between;align-items:center;gap:12px;padding:12px 14px;margin-bottom:10px;
    background:#f4f6f2;border:1px solid rgba(47,107,79,.15);border-radius:10px;text-decoration:none;color:#22303c;
    font-size:14px;transition:background .15s}
  a.res:hover{background:#e9efe6}
  a.res b{font-weight:600}
  a.res span{font-size:11.5px;color:#8a97a3;white-space:nowrap}
  a.back{display:inline-block;margin-top:8px;font-size:12.5px;color:#2F6B4F;text-decoration:none}
</style></head><body>
<div class="card">
  <h1>隧途明鉴 · 资源下载</h1>
  <p class="sub">演示视频、评测报告与实验图表（点击下载）</p>
  <a class="res" href="downloads/系统演示视频-76s.mp4" download><b>系统演示视频</b><span>MP4 · 76 秒</span></a>
  <a class="res" href="downloads/科研评测报告-2026-09-13.md" download><b>科研评测报告</b><span>Markdown</span></a>
  <a class="res" href="downloads/科研评测报告-2026-09-13.xlsx" download><b>科研评测报告</b><span>Excel 双表</span></a>
  <a class="res" href="downloads/消融实验.png" download><b>消融实验图</b><span>PNG</span></a>
  <a class="back" href="./">← 返回工作平台</a>
</div>
</body></html>`);
log('✓ downloads.html');

console.log(LOG.join('\n'));
