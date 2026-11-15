/**
 * tools/probe-review-paging.js — 验证「刷新队列」翻页轮换：
 *   点刷新 → 队列 6 条 id 变化（第 1 批 → 第 2 批）+ rv-more 批次文案 + 播报
 * 用法：node tools/probe-review-paging.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?v=pg' + Date.now(), { waitUntil: 'load' });
  await page.waitForTimeout(2800);

  const ids = () => page.evaluate(() => [...document.querySelectorAll('#rvList .rv')].map((r) => r.dataset.id));
  const more = () => page.evaluate(() => (document.querySelector('.rv-more') || {}).textContent || '');

  const before = await ids();
  console.log('① 第 1 批:', before.join(','));

  await page.click('#rvRefresh', { force: true });
  await page.waitForTimeout(1400);
  const after = await ids();
  const m1 = await more();
  console.log('② 点刷新后:', after.join(','), '\n   批次文案:', m1);

  await page.click('#rvRefresh', { force: true });
  await page.waitForTimeout(1400);
  const after2 = await ids();
  const m2 = await more();
  console.log('③ 再点刷新:', after2.join(','), '\n   批次文案:', m2);
  const bullet = await page.evaluate(() => document.getElementById('bulletinTxt').textContent);
  console.log('   播报:', bullet);

  const changed1 = before.join() !== after.join();
  const changed2 = after.join() !== after2.join();
  const pass = changed1 && changed2 && /第 2 \/ /.test(m1) && /第 3 \/ /.test(m2);
  console.log(pass ? '✓ 通过：每次刷新翻到下一批，批次文案正确' : '✗ 未通过');
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 6).forEach((e) => console.log(' ', e));
  await browser.close();
  process.exit(pass && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
