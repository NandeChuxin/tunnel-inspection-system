/**
 * tools/probe-rvrefresh.js — 诊断「刷新队列」按钮点击无响应
 * 步骤：① 未聚焦状态下注入 click 监听并点击 → 看 handler 是否执行/播报/meter 变化
 *      ② hover 复核卡到正前后再点 → 对比
 * 用法：node tools/probe-rvrefresh.js
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
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 注入监听：记录 click/pointerdown 到达按钮的情况
  await page.evaluate(() => {
    window.__probe = { clicks: 0, downs: 0, bullets: [] };
    const b = document.getElementById('rvRefresh');
    b.addEventListener('pointerdown', () => window.__probe.downs++);
    b.addEventListener('click', () => window.__probe.clicks++);
    // 观察队列 DOM 变化
    const list = document.getElementById('rvList');
    window.__probe.listMut = 0;
    new MutationObserver(() => window.__probe.listMut++).observe(list, { childList: true });
    // 播报条文本采样
    window.__probe.bulletOf = () => document.getElementById('bulletinTxt').textContent;
  });

  const snap = (tag) => page.evaluate((t) => Object.assign({ tag: t }, window.__probe,
    { meter: document.getElementById('rvMeter').textContent,
      rows: document.querySelectorAll('#rvList .rv').length }), tag);

  // ① 未聚焦直接点（轨道上复核卡不在正前）
  console.log('--- ① 未聚焦点击（含反馈断言） ---');
  console.log(JSON.stringify(await snap('before')));
  await page.click('#rvRefresh', { force: true });
  // 轮询捕捉「刷新中…」中间态 + 最终恢复
  let sawBusy = false, bullet = '';
  for (let i = 0; i < 25; i++) {
    await page.waitForTimeout(80);
    const txt = await page.evaluate(() => document.getElementById('rvRefresh').textContent);
    if (txt === '刷新中…') sawBusy = true;
    if (txt === '刷新队列' && i > 0) break;
  }
  bullet = await page.evaluate(() => document.getElementById('bulletinTxt').textContent);
  console.log(JSON.stringify(await snap('after')), '\n  sawBusy(刷新中…):', sawBusy, '· 播报:', bullet);

  // ② 悬停复核卡转到正前后再点
  console.log('--- ② 聚焦后点击 ---');
  await page.hover('.panel.p-review');
  await page.waitForTimeout(1200);
  await page.click('#rvRefresh', { force: true });
  await page.waitForTimeout(1000);
  console.log(JSON.stringify(await snap('after2')));

  const pass = sawBusy && /队列已刷新/.test(bullet);
  console.log(pass ? '✓ 通过：按钮有「刷新中…」反馈 + 播报条提示' : '✗ 未通过：缺少点击反馈');

  await page.screenshot({ path: OUT + 'arc-04-refresh.png' });
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 6).forEach((e) => console.log(' ', e));
  await browser.close();
  process.exit(pass && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
