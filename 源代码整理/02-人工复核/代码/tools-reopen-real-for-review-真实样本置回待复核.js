/**
 * tools/reopen-real-for-review.js — 把真实样本记录置回「待复核」，进入人工复核队列
 *
 * 背景：两批真实图（33+50 张）入库时直接标「已审核」（teacher 预审通过），
 *       导致人工复核队列里全是模拟记录、看不到用户给的真实图。
 * 本脚本：
 *   1) SQLite：真实样本（隧道「真实数据集」/「真实数据集(第二批)」）的 detection
 *      全部置 review_status='待审核'、reviewer=NULL；
 *   2) JSON 台账：imageRef 命中真实样本的记录同步置「待审核」、清 review、detectedAt 刷新
 *      （保证台账/统计/复核三处一致）。
 * 幂等：重复执行结果一致。
 * 前置：后端服务需停止（避免内存态覆盖台账）。
 * 用法：node tools/reopen-real-for-review.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('../backend/store');

const DB_FILE = path.join(__dirname, '..', 'backend', 'data', 'tunnel.db');

function main() {
  const db = new DatabaseSync(DB_FILE);
  const imgs = db.prepare(`
    SELECT im.image_id FROM image im
    JOIN tunnel t ON t.tunnel_id = im.tunnel_id
    WHERE t.name IN ('真实数据集', '真实数据集(第二批)') AND im.source = 'real'`).all();
  const ids = imgs.map((r) => r.image_id);
  const set = new Set(ids);
  console.log(`真实样本 image_id 共 ${ids.length} 张`);

  // 1) SQLite detection 置待审核
  const ph = ids.map(() => '?').join(',');
  const r1 = db.prepare(`UPDATE detection SET review_status='待审核', reviewer=NULL
                         WHERE image_id IN (${ph})`).run(...ids);
  console.log(`SQLite detection 置待审核 ${r1.changes} 条`);

  // 2) JSON 台账同步（按 imageRef 命中）
  const now = Date.now();
  let n = 0;
  store.defects.forEach((d, i) => {
    if (d.imageRef != null && set.has(Number(d.imageRef))) {
      d.status = '待审核';
      delete d.review;
      d.detectedAt = new Date(now + i).toISOString();  // 微递增，保持稳定排序
      n++;
    }
  });
  fs.writeFileSync(path.join(__dirname, '..', 'backend', 'data', 'defects.json'),
    JSON.stringify(store.defects, null, 2));
  console.log(`台账记录置待审核 ${n} 条 · 总台账 ${store.defects.length}`);
  db.close();
}

main();
