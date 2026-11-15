/**
 * tools/probe-dock-size.js — 验证展开卡片保持「原有尺寸」且不越出屏幕
 *
 * 对 6 张工位卡逐个展开，断言：
 *   ① 展开后的视觉高 ≈ 卡片固有高 × zoom(1.05) × DOCK_S(1.08)（±14% 容差，内部滚动会略小）
 *   ② 卡片完整落在视口内（top ≥ 0、bottom ≤ innerHeight + 2）
 *   ③ 水平中心与球心对齐（正上方）
 * 用法：node tools/probe-dock-size.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
const KEYS = ['lab', 'view', 'ledger', 'review', 'stats', 'kg'];

async function run(browser, W, H, tag) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?v=docksize' + Date.now(), { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 固有尺寸（清掉 maxHeight 量一次）
  const natural = await page.evaluate(() => {
    const o = {};
    document.querySelectorAll('.panel').forEach((el) => {
      const save = el.style.maxHeight;
      el.style.maxHeight = 'none';
      o[el.dataset.p] = { w: Math.round(el.offsetWidth), h: Math.round(el.offsetHeight) };
      el.style.maxHeight = save;
    });
    return o;
  });

  const rows = [];
  for (const k of KEYS) {
    // 展开
    await page.hover('.panel.p-' + k);
    await page.waitForTimeout(1300);
    await page.click('.panel.p-' + k + ' .ph');
    await page.waitForTimeout(2400);
    const m = await page.evaluate((key) => {
      const el = document.querySelector('.panel.p-' + key);
      const r = el.getBoundingClientRect();
      const cv = document.querySelector('.stage canvas').getBoundingClientRect();
      return {
        visH: Math.round(r.height), visW: Math.round(r.width),
        top: Math.round(r.top), bottom: Math.round(r.bottom),
        offX: Math.round((r.left + r.width / 2) - (cv.left + cv.width / 2)),
        maxH: el.style.maxHeight || '(无)',
        innerScroll: (function () { const pb = el.querySelector('.pb'); return pb ? Math.max(0, pb.scrollHeight - pb.clientHeight) : 0; })(),
      };
    }, k);
    const nat = natural[k];
    const expectH = Math.round(nat.h * 1.05 * 1.08);
    rows.push({ key: k, natH: nat.h, expect: expectH, ...m, ratio: +(m.visH / expectH).toFixed(3) });
    await page.keyboard.press('Escape');           // 收起
    await page.waitForTimeout(1100);
  }
  await page.screenshot({ path: OUT + 'dock-size-' + tag + '.png' });

  console.log(`── ${tag} (${W}×${H}) ──`);
  console.log('卡片   固有高  期望视觉高  实测视觉高  比值   顶   底   视口内 水平偏差 卡内滚动');
  let pass = true;
  for (const r of rows) {
    const inView = r.top >= 0 && r.bottom <= H + 2;
    const okSize = r.ratio >= 0.90 && r.ratio <= 1.12;   // 不被压缩（略高于固有高是 is-dock 布局所致）
    const okAlign = Math.abs(r.offX) <= 4;
    const okScroll = r.innerScroll <= 6;                 // 恢复原尺寸后不应再卡内滚动
    if (!(inView && okSize && okAlign && okScroll)) pass = false;
    console.log(
      r.key.padEnd(7) + String(r.natH).padStart(5) + String(r.expect).padStart(11) +
      String(r.visH).padStart(12) + String(r.ratio).padStart(8) +
      String(r.top).padStart(6) + String(r.bottom).padStart(6) +
      (inView ? '   ✓   ' : '   ✗   ') + String(r.offX).padStart(6) + (okAlign ? ' ✓' : ' ✗') +
      String(r.innerScroll).padStart(9) + (okScroll ? ' ✓' : ' ✗')
    );
  }
  console.log('报错:', errs.length, errs.slice(0, 3));
  console.log(pass ? '✓ 全部卡片保持原尺寸、完整在屏内、水平对齐球心' : '✗ 存在未通过项');
  await page.close();
  return pass && errs.length === 0;
}

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const a = await run(browser, 1600, 900, 'wide');
  const b = await run(browser, 1240, 780, 'small');
  await browser.close();
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
