/**
 * tools/import-real-to-db.js — 33 张真实样本批量导入数据库
 *
 * 逐张读取 backend/data/train-real/images/*.png → base64 dataUrl →
 * POST /api/detect/image { image, tunnel:'真实数据集', source:'真实样本导入' }
 * → 服务端真实推理 + 自动入库（image + detection 两表，待人工复核）。
 *
 * 前置：后端服务已用新模型启动（127.0.0.1:8787）。
 * 用法：node tools/import-real-to-db.js [--port 8787] [--delay 120]
 */
const fs = require('fs');
const path = require('path');
const http = require('http');

const REAL_DIR = path.join(__dirname, '..', 'backend', 'data', 'train-real');
const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const PORT = Number(arg('port', 8787));
const DELAY = Number(arg('delay', 120));

function post(payload) {
  return new Promise((resolve, reject) => {
    const body = JSON.stringify(payload);
    const req = http.request({
      host: '127.0.0.1', port: PORT, path: '/api/detect/image', method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
      timeout: 30000,
    }, (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => { try { resolve(JSON.parse(buf)); } catch (e) { reject(new Error('bad json: ' + buf.slice(0, 120))); } });
    });
    req.on('error', reject);
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.end(body);
  });
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'manifest.json'), 'utf-8'));
  // 健康检查
  await new Promise((resolve, reject) => {
    http.get({ host: '127.0.0.1', port: PORT, path: '/api/stats', timeout: 5000 }, (r) => { resolve(); }).on('error', reject);
  });
  console.log(`服务可达，开始导入 ${manifest.length} 张…`);
  let ok = 0, det = 0, fail = 0;
  const rows = [];
  for (const m of manifest) {
    const b64 = fs.readFileSync(m.path).toString('base64');
    try {
      const res = await post({
        image: { dataUrl: 'data:image/png;base64,' + b64 },
        tunnel: '真实数据集',
        source: '真实样本导入',
        mileage: null,
      });
      const arch = res.autoArchive || {};
      const n = (res.detections || []).length;
      det += n;
      if (arch.archived) { ok++; rows.push(`${m.source} → image#${arch.image_id} 检出${n} 处`); }
      else { fail++; rows.push(`${m.source} → 未入库：${arch.reason || '?'}`); }
    } catch (e) {
      fail++; rows.push(`${m.source} → 请求失败：${e.message}`);
    }
    process.stdout.write(`\r${ok + fail}/${manifest.length}`);
    await sleep(DELAY);
  }
  console.log(`\n导入完成：入库 ${ok} / 失败 ${fail} / 共检出病害 ${det} 处`);
  rows.forEach((r) => console.log('  ' + r));
  fs.writeFileSync(path.join(REAL_DIR, 'import-result.json'), JSON.stringify({ ok, fail, det, rows }, null, 1));
}

main().catch((e) => { console.error('导入中止：', e.message); process.exit(1); });
