/**
 * tools/capture-ui-detail.js — 采集系统「真实检测 / 病害详情 / 样本库 / 完整工作台」界面截图
 * 用法：node tools/capture-ui-detail.js <输出目录>
 */
const path = require('path');
const fs = require('fs');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));

const OUT = process.argv[2] || path.join(__dirname, '..', 'docs');
const URL = 'http://127.0.0.1:8899/prototype-holo-core.html?v=det' + Date.now();
const REAL = [
  'D:/Dataset/images/test/1_3_040_5.jpg',
  'D:/Dataset/images/test/1_3_039_12.jpg',
  'D:/Dataset/images/test/1_1_008_22.jpg',
  'D:/Dataset/images/test/1_3_020_12.jpg',
];

function ensure(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }
const T = (p) => path.join(OUT, p);

(async () => {
  ensure(OUT);
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 }, deviceScaleFactor: 2 });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  await page.goto(URL, { waitUntil: 'load' });
  await page.waitForTimeout(3200);

  // ── ① 打开检测工作台，逐张真实图片跑一次检测并截图结果面板 ──
  await page.hover('.panel.p-lab');
  await page.waitForTimeout(1300);
  await page.click('.panel.p-lab .ph');
  await page.waitForTimeout(1200);
  for (let i = 0; i < REAL.length; i++) {
    if (!fs.existsSync(REAL[i])) { console.log('skip', REAL[i]); continue; }
    await page.setInputFiles('#orbFile', REAL[i]);
    for (let k = 0; k < 14; k++) { await page.waitForTimeout(160); await page.screenshot({ path: T('_f.png') }); }
    await page.waitForTimeout(3200);
    await page.screenshot({ path: T('ui_detect_full_' + (i + 1) + '.png') });
    const txt = await page.evaluate(() => {
      const el = document.getElementById('orbRes');
      return el ? el.innerText.replace(/\s+/g, ' ').slice(0, 260) : '';
    });
    console.log('detect', i + 1, path.basename(REAL[i]), '=>', txt);
  }

  // 热力图分析
  try {
    await page.click('#orbHeat');
    await page.waitForTimeout(2600);
    await page.screenshot({ path: T('ui_heatmap.png') });
    console.log('heatmap ok');
  } catch (e) { console.log('heatmap skip', e.message); }

  // ── ② 病害详情弹窗（真实图 + bbox 叠加） ──
  await page.keyboard.press('Escape');
  await page.waitForTimeout(600);
  await page.hover('.panel.p-ledger');
  await page.waitForTimeout(1300);
  await page.click('.panel.p-ledger .ph');
  await page.waitForTimeout(1400);
  const rows = await page.$$('#ldList .arc');
  console.log('ledger rows', rows.length);
  for (let i = 0; i < Math.min(3, rows.length); i++) {
    try {
      const rs = await page.$$('#ldList .arc');
      await rs[i].click();
      await page.waitForTimeout(2600);
      await page.screenshot({ path: T('ui_detail_' + (i + 1) + '.png') });
      const open = await page.evaluate(() => {
        const m = document.getElementById('rvModal');
        return m ? m.className : 'none';
      });
      console.log('detail', i + 1, open);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(700);
    } catch (e) { console.log('detail', i + 1, 'skip', e.message); }
  }

  // ── ③ 样本库弹窗 ──
  try {
    await page.click('#hsOpen');
    await page.waitForTimeout(2600);
    await page.screenshot({ path: T('ui_library.png') });
    console.log('library ok');
    await page.keyboard.press('Escape');
    await page.waitForTimeout(700);
  } catch (e) { console.log('library skip', e.message); }

  // ── ④ 完整工作台（frontend/index.html） ──
  try {
    await page.goto('http://127.0.0.1:8899/../frontend/index.html', { waitUntil: 'load' }).catch(() => {});
    await page.waitForTimeout(2500);
    await page.screenshot({ path: T('ui_workbench_full.png') });
    console.log('workbench url', page.url());
  } catch (e) { console.log('workbench skip', e.message); }

  console.log('ERR', errs.length, errs.slice(0, 5));
  await browser.close();
  console.log('files:', fs.readdirSync(OUT).filter((f) => /^ui_/.test(f)).join(', '));
})().catch((e) => { console.error('FAIL', e.message); process.exit(1); });
