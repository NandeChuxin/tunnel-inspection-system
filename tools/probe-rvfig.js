/**
 * tools/probe-rvfig.js — 验证病害详情弹窗图像改版：
 *   模拟记录（imageRef=null）→ 同病害类型真实样本示例图 + 角标（不再 canvas 示意图）
 *   真实记录（imageRef=id）  → 原图回源 + bbox 叠加
 * 用法：node tools/probe-rvfig.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
const API = 'http://127.0.0.1:8787';

(async () => {
  // 预取一条真实记录 id（含 imageRef）作为点击目标
  const realRes = await fetch(API + '/api/samples?source=real&size=1').then((r) => r.json());
  const realId = realRes.items[0].detection_ids ? null : null; // 台账 id 与 image_id 不同，改为从 defects 找
  const defects = await fetch(API + '/api/defects').then((r) => r.json());
  const items = defects.items || defects;
  const real = items.find((x) => /^\d+$/.test(String(x.imageRef || '')));
  const sim = items.find((x) => !x.imageRef && x.source === '巡检模拟');
  console.log('目标：模拟', sim.id, '(type=' + sim.type + ') · 真实', real.id, '(imageRef=' + real.imageRef + ')');

  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const page = await browser.newPage({ viewport: { width: 1600, height: 900 } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  page.on('requestfailed', (r) => { if (!/favicon/.test(r.url())) errs.push('[reqfail] ' + r.url()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html', { waitUntil: 'load' });
  await page.waitForTimeout(2500);

  // 展开病害档案卡
  await page.click('.panel.p-ledger .ph');
  for (let i = 0; i < 12; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
  await page.waitForTimeout(500);

  // 目标行可能不在前 30：循环点「显示更多」直到两行都出现（最多 10 次 = 330 行）
  async function ensureRow(id) {
    for (let i = 0; i < 12; i++) {
      const hit = await page.evaluate((x) => !!document.querySelector('#ldList .arc[data-id="' + x + '"]'), id);
      if (hit) return true;
      const more = await page.evaluate(() => { const b = document.getElementById('ldMore'); if (!b || b.hidden) return false; b.click(); return true; });
      if (!more) return false;
      await page.waitForTimeout(400);
    }
    return false;
  }

  async function openAndCheck(id, label) {
    const ok = await ensureRow(id);
    if (!ok) return { label, error: '行未找到：' + id };
    await page.evaluate((x) => document.querySelector('#ldList .arc[data-id="' + x + '"]').click(), id);
    // 轮询弹窗图像就绪（img 加载完成或出现占位），最多 6s
    let fig = null;
    for (let i = 0; i < 30; i++) {
      await page.waitForTimeout(200);
      fig = await page.evaluate(() => {
        const f = document.getElementById('rvmFig');
        const img = f.querySelector('img');
        return {
          html: f.innerHTML.length,
          hasImg: !!img,
          imgOk: img ? (img.complete && img.naturalWidth > 0) : false,
          hasCanvas: !!f.querySelector('canvas'),
          badge: (f.textContent || '').includes('非本记录原始影像'),
          hasBbox: !!f.querySelector('.rvm-bbox'),
          hint: (f.querySelector('.lab-none') || {}).textContent || null,
          cap: document.getElementById('rvmCap').textContent.slice(0, 60),
        };
      });
      if ((fig.hasImg && fig.imgOk) || (fig.hint && /暂无|失败/.test(fig.hint))) break;
    }
    await page.screenshot({ path: OUT + 'arc-03-rvfig-' + label + '.png' });
    await page.keyboard.press('Escape');
    await page.waitForTimeout(350);
    return Object.assign({ label }, fig);
  }

  const r1 = await openAndCheck(sim.id, 'mock');
  console.log('① 模拟记录弹窗:', JSON.stringify(r1, null, 1));

  // ①b 示例图随机轮换：同一条模拟记录连开 4 次，应出现 ≥2 个不同 src
  const srcSet = new Set();
  for (let i = 0; i < 4; i++) {
    await page.evaluate((x) => { const r = document.querySelector('#ldList .arc[data-id="' + x + '"]'); if (r) r.click(); }, sim.id);
    for (let t = 0; t < 30; t++) {
      await page.waitForTimeout(150);
      const st = await page.evaluate(() => {
        const f = document.getElementById('rvmFig'); const im = f.querySelector('img');
        return im && im.complete && im.naturalWidth > 0 ? im.src : null;
      });
      if (st) { srcSet.add(st); break; }
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(300);
  }
  console.log('①b 连开 4 次示例图 URL 数:', srcSet.size, [...srcSet].map((s) => s.split('/').pop()).join(', '));
  const rotateOk = srcSet.size >= 2;

  const r2 = await openAndCheck(real.id, 'real');
  console.log('② 真实记录弹窗:', JSON.stringify(r2, null, 1));

  const pass = r1.hasImg && r1.imgOk && r1.badge && !r1.hasCanvas
    && r2.hasImg && r2.imgOk && !r2.hasCanvas && r2.hasBbox && rotateOk;
  console.log(pass ? '✓ 全部通过：示例图轮换 + 模拟/真实两路径正常' : '✗ 存在未通过项');

  console.log('ERRORS(' + errs.length + '):'); errs.slice(0, 8).forEach((e) => console.log(' ', e));
  await browser.close();
  process.exit(pass && errs.length === 0 ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
