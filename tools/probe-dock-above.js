/**
 * tools/probe-dock-above.js — 验证「展开卡片落在星球正上方且不遮挡星球/球心数字」
 *
 * 断言（宽屏轨道模式）：
 *   ① 卡片中心 X 与球心 X 对齐（正上方，水平不偏）
 *   ② 卡片底边 ≤ 球顶（不与球体区域重叠）
 *   ③ 卡片顶边 ≥ 0（完整在视口内）
 *   ④ 球心数字区域（球心 ± 40px）不被卡片覆盖
 * 另在 1300×800（仍走轨道模式）复测一遍。
 * 用法：node tools/probe-dock-above.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';

async function run(browser, W, H, tag) {
  const page = await browser.newPage({ viewport: { width: W, height: H } });
  const errs = [];
  page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?v=dockabove' + Date.now(), { waitUntil: 'load' });
  await page.waitForTimeout(3000);

  // 启动健康检查（无启动红条）
  const bootBad = await page.evaluate(() => [...document.querySelectorAll('div')].some((d) => /页面启动出错/.test(d.textContent)));

  await page.hover('.panel.p-lab');
  await page.waitForTimeout(1400);
  await page.click('.panel.p-lab .ph');
  await page.waitForTimeout(2600);

  const m = await page.evaluate(() => {
    const el = document.querySelector('.panel.p-lab');
    const r = el.getBoundingClientRect();
    const cv = document.querySelector('.stage canvas').getBoundingClientRect();
    const sphereCx = cv.left + cv.width / 2;
    const sphereCy = cv.top + cv.height / 2;
    const RAD = Math.min(cv.width, cv.height) * 0.175;
    const cardCx = r.left + r.width / 2;
    // 球心数字区（球心 ± 40px 的小方块）
    const numBox = { l: sphereCx - 60, t: sphereCy - 46, r: sphereCx + 60, b: sphereCy + 46 };
    const overlapNum = Math.max(0, Math.min(r.right, numBox.r) - Math.max(r.left, numBox.l)) *
                       Math.max(0, Math.min(r.bottom, numBox.b) - Math.max(r.top, numBox.t));
    return {
      card: { cx: Math.round(cardCx), top: Math.round(r.top), bottom: Math.round(r.bottom), w: Math.round(r.width), h: Math.round(r.height) },
      sphere: { cx: Math.round(sphereCx), cy: Math.round(sphereCy), rad: Math.round(RAD), top: Math.round(sphereCy - RAD) },
      offX: Math.round(cardCx - sphereCx),
      gapToSphereTop: Math.round((sphereCy - RAD) - r.bottom),
      cardInViewport: r.top >= 0,
      overlapNumArea: Math.round(overlapNum),
      maxHeightInline: el.style.maxHeight,
    };
  });
  await page.screenshot({ path: OUT + 'dock-above-' + tag + '.png' });

  const pass = !bootBad && Math.abs(m.offX) <= 4 && m.gapToSphereTop >= 0 && m.cardInViewport && m.overlapNumArea === 0 && errs.length === 0;
  console.log(`── ${tag} (${W}×${H}) ──`);
  console.log(JSON.stringify(m, null, 1));
  console.log('启动红条:', bootBad, '· 报错:', errs.length, errs.slice(0, 3));
  console.log(pass ? '✓ 通过：卡片在星球正上方，球体与球心数字完全可见' : '✗ 未通过');
  await page.close();
  return pass;
}

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const a = await run(browser, 1600, 900, 'wide');
  const b = await run(browser, 1300, 800, 'mid');
  await browser.close();
  process.exit(a && b ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
