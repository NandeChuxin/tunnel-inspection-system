const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', e => errs.push('[pageerror] ' + e.message));
  page.on('console', m => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  page.on('requestfailed', r => errs.push('[reqfail] ' + r.url()));
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  console.log('卡片:', await page.evaluate(() => [...document.querySelectorAll('[data-p]')].map(p => p.dataset.p + ':' + (p.querySelector('.no') || {}).textContent).join('  ')));

  // ① 病害档案卡：行内容（图 / 名称 / 检验 / 时间 / 方案）
  await page.click('.panel.p-ledger .ph');
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
  await page.waitForTimeout(500);
  const s1 = await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ldList .arc')];
    return {
      count: rows.length,
      withImg: rows.filter(r => r.querySelector('.th img')).length,
      placeholder: rows.filter(r => r.querySelector('.th i')).length,
      sample: rows.slice(0, 2).map(r => ({
        name: (r.querySelector('.l1 b') || {}).textContent,
        lv: (r.querySelector('.l1 .lv') || {}).textContent,
        st: (r.querySelector('.l1 .st') || {}).textContent,
        meta: (r.querySelector('.l2') || {}).textContent,
        plan: (r.querySelector('.l3') || {}).textContent.slice(0, 40),
      })),
      meter: document.getElementById('ldMeter').textContent,
    };
  });
  console.log('① 病害档案:', JSON.stringify(s1, null, 1));
  await page.screenshot({ path: OUT + 'arc-01-archive.png' });

  // ② 显示更多
  const before = await page.evaluate(() => document.querySelectorAll('#ldList .arc').length);
  await page.click('#ldMore');
  await page.waitForTimeout(500);
  const after = await page.evaluate(() => document.querySelectorAll('#ldList .arc').length);
  console.log('② 显示更多:', before, '→', after);

  // ③ 状态筛选
  await page.click('#ldSeg button[data-ld="已审核"]');
  await page.waitForTimeout(500);
  console.log('③ 已审核筛选:', await page.evaluate(() => {
    const rows = [...document.querySelectorAll('#ldList .arc')];
    return rows.length + ' 条 | 状态集合=' + [...new Set(rows.map(r => r.querySelector('.l1 .st').textContent))].join('/') + ' | 复核人样例=' + (rows[0] ? rows[0].querySelector('.l2').textContent.slice(0, 22) : '--');
  }));
  await page.click('#ldSeg button[data-ld=""]');
  await page.waitForTimeout(400);

  // ④ 点档案行 → 详情弹窗（图 + 方案 + 审核人 + 通过/驳回）
  await page.click('#ldList .arc');
  await page.waitForTimeout(1200);
  const s4 = await page.evaluate(() => {
    const m = document.getElementById('rvModal');
    const fig = document.getElementById('rvmFig');
    return {
      open: m.classList.contains('is-open'),
      hasImg: !!fig.querySelector('img'), imgOk: (() => { const i = fig.querySelector('img'); return i ? i.complete && i.naturalWidth > 0 : false; })(),
      hasSchematic: !!fig.querySelector('canvas'),
      kv: document.getElementById('rvmKv').textContent.replace(/\s+/g, ' ').slice(0, 150),
      sug: document.getElementById('rvmSug').textContent.replace(/\s+/g, ' ').slice(0, 80),
      audit: document.getElementById('rvmAudit').textContent.replace(/\s+/g, ' ').slice(0, 80),
      kgBtn: !!document.getElementById('rvmKg'),
    };
  });
  console.log('④ 详情弹窗:', JSON.stringify(s4, null, 1));
  await page.screenshot({ path: OUT + 'arc-02-modal.png' });

  // ⑤ 弹窗内通过 → 原地刷新为已审核
  if (await page.evaluate(() => !!document.getElementById('rvmPass'))) {
    await page.click('#rvmPass');
    await page.waitForTimeout(1400);
    console.log('⑤ 通过后:', await page.evaluate(() => ({
      st: document.getElementById('rvmStatus').textContent,
      audit: document.getElementById('rvmAudit').textContent.replace(/\s+/g, ' ').slice(0, 70),
    })));
  }
  await page.keyboard.press('Escape');
  await page.waitForTimeout(300);

  // ⑥ 样本库按钮仍可用
  await page.click('#hsOpen');
  await page.waitForTimeout(1200);
  console.log('⑥ 样本库:', await page.evaluate(() => ({ open: document.getElementById('libModal').classList.contains('is-open'), cards: document.querySelectorAll('#libGrid .lib-card').length })));
  await page.keyboard.press('Escape');

  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 8).forEach(e => console.log(' ', e));
  await browser.close();
})().catch(e => { console.error('PROBE FAIL:', e.message); process.exit(1); });
