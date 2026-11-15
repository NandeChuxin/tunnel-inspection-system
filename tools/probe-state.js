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

  const s = await page.evaluate(() => ({
    cards: [...document.querySelectorAll('[data-p]')].map(p => p.dataset.p + ':' + (p.querySelector('.no') || {}).textContent),
    kgCardExists: !!document.querySelector('.panel.p-kg'),
    kgFullBtn: !!document.getElementById('kgOpenFull'),
    kgFullOverlay: !!document.getElementById('kgFull'),
    ldRows: document.querySelectorAll('#ldList .ld').length,
    hsRows: document.querySelectorAll('#hsList .hs, #hsList > *').length,
    rvRows: document.querySelectorAll('#rvList .rv').length,
    banner: [...document.querySelectorAll('div')].some(x => (x.textContent || '').startsWith('页面启动出错')),
    kgMeter: (document.getElementById('kgMeter') || {}).textContent,
  }));
  console.log('页面状态:', JSON.stringify(s, null, 1));

  // 知识图谱卡：能否打开全图谱 3D
  if (s.kgCardExists) {
    await page.click('.panel.p-kg .ph');
    for (let i = 0; i < 10; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
    await page.waitForTimeout(400);
    await page.click('#kgOpenFull');
    await page.waitForTimeout(2200);
    const g = await page.evaluate(() => {
      const cv = document.getElementById('kgfCanvas');
      let px = 0;
      if (cv) { const d = cv.getContext('2d').getImageData(0, 0, cv.width, cv.height).data; for (let i = 3; i < d.length; i += 4) if (d[i] > 10) px++; }
      return { open: document.getElementById('kgFull').classList.contains('is-open'), painted: px, hasKgf: !!window.__kgf };
    });
    console.log('全图谱 3D:', JSON.stringify(g));
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }

  // 台账/历史/复核 数据结构抽查
  const rows = await page.evaluate(() => {
    const ld = [...document.querySelectorAll('#ldList .ld')].slice(0, 2).map(r => r.textContent.replace(/\s+/g, ' ').slice(0, 70));
    const rv = [...document.querySelectorAll('#rvList .rv')].slice(0, 1).map(r => r.textContent.replace(/\s+/g, ' ').slice(0, 70));
    return { ld, rv, hsHTML: (document.getElementById('hsList') || {}).innerHTML ? document.getElementById('hsList').innerHTML.slice(0, 160) : null };
  });
  console.log('行样例:', JSON.stringify(rows, null, 1));
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 8).forEach(e => console.log(' ', e));
  await browser.close();
})().catch(e => { console.error('PROBE FAIL:', e.message); process.exit(1); });
