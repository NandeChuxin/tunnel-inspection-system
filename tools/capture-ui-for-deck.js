/**
 * tools/capture-ui-for-deck.js — 为演示文稿采集系统真实界面截图
 *
 * 六工位轨道界面逐个展开截取卡片本体，另采集整体轨道视图与知识图谱 3D 全图。
 * 用法：node tools/capture-ui-for-deck.js <输出目录>
 */
const path = require('path');
const fs = require('fs');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));

const OUT = process.argv[2] || path.join(__dirname, '..', 'docs');
const URL = 'http://127.0.0.1:8899/prototype-holo-core.html?v=deck' + Date.now();
const PANELS = ['lab', 'view', 'ledger', 'review', 'stats', 'kg'];

function ensure(dir) { if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true }); }

(async () => {
  ensure(OUT);
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });

  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3200);

  const bootBad = await page.evaluate(() => [...document.querySelectorAll('div')].some((d) => /页面启动出错/.test(d.textContent)));
  console.log('启动红条:', bootBad);

  // ① 整体轨道视图（默认态，六卡环绕）
  await page.screenshot({ path: path.join(OUT, 'ui_orbit.png') });

  for (const key of PANELS) {
    const sel = '.panel.p-' + key;
    const exists = await page.$(sel);
    if (!exists) { console.log(key, 'MISSING'); continue; }
    // 收起上一个
    await page.keyboard.press('Escape');
    await page.waitForTimeout(500);
    await page.hover(sel);
    await page.waitForTimeout(1500);
    await page.click(sel + ' .ph');
    for (let i = 0; i < 8; i++) { await page.waitForTimeout(90); await page.screenshot({ path: path.join(OUT, '_frame.png') }); }
    await page.waitForTimeout(1400);
    const box = await page.evaluate((s) => {
      const el = document.querySelector(s);
      const r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height), cls: el.className };
    }, sel);
    // 整屏（六工位轨道 + 展开卡片的真实使用态）
    await page.screenshot({ path: path.join(OUT, 'ui_full_' + key + '.png') });
    if (box.width > 40 && box.height > 40) {
      const clip = {
        x: Math.max(0, box.x), y: Math.max(0, box.y),
        width: Math.min(1600 - Math.max(0, box.x), box.width),
        height: Math.min(900 - Math.max(0, box.y), box.height),
      };
      await page.screenshot({ path: path.join(OUT, 'ui_' + key + '.png'), clip });
      console.log(key, 'card', JSON.stringify(clip), box.cls);
    } else {
      console.log(key, 'BAD BOX', JSON.stringify(box));
    }
    // 知识图谱：追加全图谱 3D
    if (key === 'kg') {
      const has = await page.$('#kgOpenFull');
      if (has) {
        await page.click('#kgOpenFull');
        await page.waitForTimeout(2600);
        await page.screenshot({ path: path.join(OUT, 'ui_kg3d.png') });
        await page.keyboard.press('Escape');
        await page.waitForTimeout(600);
      }
    }
  }

  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);

  const files = fs.readdirSync(OUT).filter((f) => f.startsWith('ui_'));
  console.log('产出:', files.join(', '));
  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 6).forEach((e) => console.log('  ', e));
  await browser.close();
})().catch((e) => { console.error('CAPTURE FAIL:', e.message); process.exit(1); });
