/**
 * serve-docs.js — 隧道病害原型族（docs/）静态托管服务（零依赖）
 *
 * 启动：node tools/serve-docs.js   （默认端口 8899，可用 DOCS_PORT 覆盖）
 *
 * 行为：
 *   - 根目录指向 ../docs（与 backend/server.js 的 frontend/ 平行），挂载 docs 下所有原型页面与素材
 *   - 自动 decodeURIComponent 路径，匹配含中文/百分号编码的静态文件（原型直接 file:// 时无法走通）
 *   - 简易 MIME 映射，文本走 utf-8，二进制按类型直返
 *   - /         → docs/prototype-holo-core.html（唯一正式版本，线上部署同源）
 *   - 命中 /<name>.html → 同名文件；其它资源按路径查 docs/ 子目录
 */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..', 'docs');
const PORT = Number(process.env.DOCS_PORT || 8899);
const DEFAULT_INDEX = 'prototype-holo-core.html';

const MIME = {
  '.html': 'text/html; charset=utf-8',
  '.htm':  'text/html; charset=utf-8',
  '.css':  'text/css; charset=utf-8',
  '.js':   'application/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg':  'image/svg+xml',
  '.png':  'image/png',
  '.jpg':  'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif':  'image/gif',
  '.webp': 'image/webp',
  '.mp4':  'video/mp4',
  '.webm': 'video/webm',
  '.ico':  'image/x-icon',
  '.txt':  'text/plain; charset=utf-8',
  '.md':   'text/markdown; charset=utf-8',
  '.woff': 'font/woff',
  '.woff2':'font/woff2',
};

function safeJoin(rel) {
  // 路径白名单：禁止 ../ 跳出 docs/
  const decoded = decodeURIComponent(rel || '/');
  const trimmed = decoded.replace(/^\/+/, '');
  if (trimmed === '' || trimmed.endsWith('/')) {
    return path.join(ROOT, trimmed, DEFAULT_INDEX);
  }
  const full = path.normalize(path.join(ROOT, trimmed));
  if (!full.startsWith(ROOT)) return null;            // 越界拒绝
  return full;
}

const server = http.createServer((req, res) => {
  const ts = new Date().toISOString().slice(11, 19);
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.writeHead(405, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Method Not Allowed');
    return;
  }
  const pathname = (req.url || '/').split('?')[0];   // 剥掉查询串（?v=xxx 版本参数不参与文件查找）
  let target = safeJoin(pathname);
  if (!target) {
    res.writeHead(403, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Forbidden');
    console.log(`[${ts}] 403 ${req.url}`);
    return;
  }
  fs.stat(target, (err, st) => {
    if (err || !st.isFile()) {
      // 兜底：无扩展名/找不到 → 试 .html
      if (!path.extname(target)) {
        target = target + '.html';
        return fs.stat(target, (e2, st2) => {
          if (e2 || !st2.isFile()) return notFound(res, req.url, ts);
          serveFile(res, target, st2, req, ts);
        });
      }
      return notFound(res, req.url, ts);
    }
    serveFile(res, target, st, req, ts);
  });
});

function serveFile(res, target, st, req, ts) {
  const ext = path.extname(target).toLowerCase();
  const mime = MIME[ext] || 'application/octet-stream';
  res.setHeader('Content-Type', mime);
  res.setHeader('Content-Length', st.size);
  res.setHeader('Access-Control-Allow-Origin', '*'); // 允许原型与 backend 跨源协作
  res.setHeader('Cache-Control', 'no-store'); // 原型迭代频繁：禁一切缓存（no-cache 仍可能被 iframe 会话复用）
  if (req.method === 'HEAD') { res.writeHead(200); res.end(); return; }
  const stream = fs.createReadStream(target);
  stream.on('error', () => {
    res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('Read Error');
  });
  stream.pipe(res);
  console.log(`[${ts}] 200 ${req.url} -> ${path.relative(ROOT, target)} (${st.size}B)`);
}

function notFound(res, url, ts) {
  res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
  res.end('Not Found');
  console.log(`[${ts}] 404 ${url}`);
}

server.listen(PORT, '127.0.0.1', () => {
  console.log(`docs 静态服务已启动: http://127.0.0.1:${PORT}/`);
  console.log(`根目录: ${ROOT}`);
  console.log(`默认入口: ${DEFAULT_INDEX}`);
});

process.on('SIGINT', () => { console.log('bye'); server.close(() => process.exit(0)); });