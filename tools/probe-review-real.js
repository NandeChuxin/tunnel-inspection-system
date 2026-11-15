/**
 * tools/probe-review-real.js — 验证人工复核队列改造：
 *   ① 队列前几条全部是「真实样本导入」记录（用户实拍图优先）
 *   ② 点第一条 → 弹窗显示真实原图（imageRef 回源，非示例图角标）
 *   ③ 通过操作后队列下移一条、仍为真实样本记录
 * 用法：node tools/probe-review-real.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
const API = 'http://127.0.0.1:8787';

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?v=rvr' + Date.now(), { waitUntil: 'load' });
  await page.waitForTimeout(2800);

  // ① 队列构成
  const q = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#rvList .rv')];
    return rows.map((r) => r.dataset.id);
  });
  const details = [];
  for (const id of q) {
    const d = await fetch(API + '/api/defects/' + id).then((r) => r.json());
    details.push({ id, source: d.source, imageRef: d.imageRef, type: d.type, status: d.status });
  }
  console.log('① 队列前 ' + q.length + ' 条:', JSON.stringify(details, null, 1));
  const allReal = details.every((d) => /真实样本/.test(d.source || ''));
  console.log(allReal ? '✓ 队列全部为真实样本记录' : '✗ 队列混有非真实样本记录');

  // ② 点第一条 → 弹窗应显示真实原图（无示例图角标）
  await page.hover('.panel.p-review');
  await page.waitForTimeout(1400);
  await page.click('.panel.p-review .ph');
  for (let i = 0; i < 14; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
  await page.waitForTimeout(400);
  await page.evaluate((x) => document.querySelector('#rvList .rv[data-id="' + x + '"]').click(), q[0]);
  let fig = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    fig = await page.evaluate(() => {
      const f = document.getElementById('rvmFig'); const im = f.querySelector('img');
      return {
        hasImg: !!im, imgOk: im ? (im.complete && im.naturalWidth > 0) : false,
        exampleBadge: (f.textContent || '').includes('非本记录原始影像'),
        hasBbox: !!f.querySelector('.rvm-bbox'),
        src: im ? im.src : '',
      };
    });
    if (fig.imgOk) break;
  }
  console.log('② 弹窗图像:', JSON.stringify(fig, null, 1));
  await page.screenshot({ path: OUT + 'arc-06-review-real.png' });

  // ③ 通过 → 队列刷新
  const passBtn = await page.$('#rvmPass');
  if (passBtn) { await page.click('#rvmPass'); await page.waitForTimeout(1800); }
  await page.keyboard.press('Escape'); await page.waitForTimeout(400);
  const q2 = await page.evaluate(() => [...document.querySelectorAll('#rvList .rv')].map((r) => r.dataset.id));
  console.log('③ 通过后队列:', JSON.stringify(q2), '· 首条已移除:', !q2.includes(q[0]));

  const pass = allReal && fig.hasImg && fig.imgOk && !fig.exampleBadge && !q2.includes(q[0]);
  console.log(pass ? '✓ 全部通过：复核队列真实图优先 + 原图回源 + 复核流转正常' : '✗ 存在未通过项');
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 6).forEach((e) => console.log(' ', e));
  await browser.close();
  process.exit(pass && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
