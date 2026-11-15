/**
 * tools/cleanup.js — 项目瘦身：删除开发过程中的产物文件（截图/日志/测试图/缓存）
 * 保留：源代码、设计文档、原型 HTML、验收脚本依赖的样例图、运行数据、验证探针
 * 用法：node tools/cleanup.js [--dry]
 */
const fs = require('fs');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dry = process.argv.includes('--dry');
const removed = [];
let freed = 0;

function rm(p, reason) {
  const full = path.join(ROOT, p);
  if (!fs.existsSync(full)) return;
  let sz = 0;
  const walk = (d) => {
    for (const f of fs.readdirSync(d, { withFileTypes: true })) {
      const fp = path.join(d, f.name);
      if (f.isDirectory()) walk(fp);
      else { try { sz += fs.statSync(fp).size; } catch (e) { /* */ } }
    }
  };
  const st = fs.statSync(full);
  if (st.isDirectory()) walk(full); else sz = st.size;
  if (!dry) fs.rmSync(full, { recursive: true, force: true });
  removed.push({ p, reason, kb: Math.round(sz / 1024) });
  freed += sz;
}

/* 1) docs/ 调试截图（探针连拍产物；关键截图已归档在参赛材料/04-演示材料） */
const docsShot = fs.readdirSync(path.join(ROOT, 'docs')).filter((f) =>
  /\.(png|jpg|jpeg)$/i.test(f) && /^(arc-|dock-|flat-|orbit-|ring-|sym-|live-site|boot-err|chk-|_tmp|_f)/i.test(f));
for (const f of docsShot) rm(path.join('docs', f), '调试截图');
/* docs 下其他非归档图片（保留 消融实验.png：评测报告引用） */
for (const f of fs.readdirSync(path.join(ROOT, 'docs')).filter((f) => /\.(png|jpg|jpeg)$/i.test(f) && f !== '消融实验.png')) {
  rm(path.join('docs', f), '过程图片');
}
/* 2) 日志与缓存 */
rm('docs/_mat.log', '构建日志');
rm('docs/_deploy.log', '构建日志');
rm('docs-serve.log', '服务日志');
rm('backend/server.log', '服务日志');
rm('docs/.playwright-cli', '浏览器工具缓存');
/* 3) backend/data 测试产物（w0_sample_tunnel.png 被验收脚本引用，保留） */
const dataDir = path.join(ROOT, 'backend', 'data');
if (fs.existsSync(dataDir)) {
  for (const f of fs.readdirSync(dataDir)) {
    if (/^(jc_|jf_|jpeg_|w1_)/i.test(f)) rm(path.join('backend', 'data', f), '模块测试图产物');
    if (/\.(tmp|bak)$/i.test(f)) rm(path.join('backend', 'data', f), '临时文件');
  }
}
/* 4) 根目录与 deploy 里的日志/临时 */
for (const f of fs.readdirSync(ROOT)) {
  if (/\.(log|tmp)$/i.test(f)) rm(f, '根目录日志/临时文件');
}

console.log((dry ? '[DRY] ' : '') + '共清理 ' + removed.length + ' 项 · 释放 ' + (freed / 1048576).toFixed(1) + ' MB');
const byReason = {};
for (const r of removed) byReason[r.reason] = (byReason[r.reason] || 0) + 1;
for (const [k, v] of Object.entries(byReason)) console.log('  ' + k + ': ' + v + ' 项');
