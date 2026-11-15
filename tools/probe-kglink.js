/**
 * tools/probe-kglink.js — 验证详情弹窗「查看知识图谱推理」衔接：
 *   点行开弹窗 → 点 #rvmKg → 弹窗关闭 + kg 卡抬到球心 + #kgRes 渲染完整推理结论
 * 用法：node tools/probe-kglink.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
const API = 'http://127.0.0.1:8787';

(async () => {
  // 预取一条模拟记录（复核队列里的典型记录）
  const defects = await fetch(API + '/api/defects').then((r) => r.json());
  const items = defects.items || defects;
  const sim = items.find((x) => !x.imageRef && x.source === '巡检模拟');
  console.log('目标记录:', sim.id, sim.type, sim.level);

  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 展开病害档案卡 → 确保目标行在列表 → 点行开弹窗
  await page.click('.panel.p-ledger .ph');
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
  await page.waitForTimeout(500);
  for (let i = 0; i < 12; i++) {
    const hit = await page.evaluate((x) => !!document.querySelector('#ldList .arc[data-id="' + x + '"]'), sim.id);
    if (hit) break;
    const more = await page.evaluate(() => { const b = document.getElementById('ldMore'); if (!b || b.hidden) return false; b.click(); return true; });
    if (!more) break;
    await page.waitForTimeout(400);
  }
  await page.evaluate((x) => document.querySelector('#ldList .arc[data-id="' + x + '"]').click(), sim.id);
  await page.waitForTimeout(1000);
  const opened = await page.evaluate(() => document.getElementById('rvModal').classList.contains('is-open'));
  console.log('弹窗打开:', opened);

  // 点「查看知识图谱推理」→ 等推理渲染
  await page.click('#rvmKg');
  let kg = null;
  for (let i = 0; i < 30; i++) {
    await page.waitForTimeout(200);
    kg = await page.evaluate(() => {
      const res = document.getElementById('kgRes');
      const card = document.querySelector('.panel.p-kg');
      return {
        modalClosed: !document.getElementById('rvModal').classList.contains('is-open'),
        kgDocked: card.classList.contains('is-dock'),
        resHidden: res.hidden,
        text: res.textContent.replace(/\s+/g, ' ').slice(0, 160),
        hasConclusion: /病害|等级/.test(res.textContent) && !/正在推理|推理失败/.test(res.textContent),
      };
    });
    if (kg.hasConclusion) break;
  }
  console.log('图谱衔接:', JSON.stringify(kg, null, 1));
  await page.screenshot({ path: OUT + 'arc-05-kglink.png' });

  const pass = opened && kg.modalClosed && kg.hasConclusion;
  console.log(pass ? '✓ 通过：弹窗→图谱衔接正常' : '✗ 未通过');
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 6).forEach((e) => console.log(' ', e));
  await browser.close();
  process.exit(pass && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
