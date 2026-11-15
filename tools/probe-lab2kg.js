/**
 * tools/probe-lab2kg.js — 验证工作台「检出 → 询问 → 跳转知识图谱学习」闭环：
 *   ① 上传真实样本图 → 检出列表（.rc 卡）出现
 *   ② 点击检出卡 → #kgAsk 确认浮层（标题含检出信息）
 *   ③ 点「去知识图谱学习」→ 浮层关 + kg 卡可见反馈（宽屏：抬卡；窄屏：滚动定位+脉冲）
 * 场景：宽屏 1600×900（轨道抬卡）+ 窄屏 1100×800（文档流回退，预览面板常见宽度）
 * 用法：node tools/probe-lab2kg.js
 */
const path = require('path');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));
const OUT = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/docs/';
const IMG = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system/backend/data/train-real/images/1_1_008_22.png';

(async () => {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  let allOk = true;

  for (const vp of [{ w: 1600, h: 900, tag: 'wide' }, { w: 1100, h: 800, tag: 'narrow' }]) {
    const page = await browser.newPage({ viewport: { width: vp.w, height: vp.h } });
    const errs = [];
    page.on('pageerror', (e) => errs.push('[pageerror] ' + e.message));
    page.on('console', (m) => { if (m.type() === 'error') errs.push('[console] ' + m.text()); });
    await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?v=l2k' + Date.now(), { waitUntil: 'load' });
    await page.waitForTimeout(2600);

    // ① 上传真实样本图 → 检测
    await page.hover('.panel.p-lab');
    await page.waitForTimeout(1400);
    await page.click('.panel.p-lab .ph');
    for (let i = 0; i < 14; i++) { await page.waitForTimeout(80); await page.screenshot({ path: OUT + '_tmp.png' }); }
    await page.waitForTimeout(400);
    await page.setInputFiles('#labFile', IMG);
    let dets = [];
    for (let i = 0; i < 40; i++) {
      await page.waitForTimeout(250);
      dets = await page.evaluate(() => [...document.querySelectorAll('#labList .rc')].map((c) => c.querySelector('.ty').textContent.trim()));
      if (dets.length) break;
    }
    console.log(`[${vp.tag}] ① 检出列表:`, JSON.stringify(dets));

    // ② 点击第一张检出卡 → 确认浮层
    await page.evaluate(() => document.querySelector('#labList .rc').click());
    await page.waitForTimeout(400);
    const ask = await page.evaluate(() => {
      const m = document.getElementById('kgAsk');
      return { open: m.classList.contains('is-open'), title: document.getElementById('kgaTitle').textContent };
    });
    console.log(`[${vp.tag}] ② 确认浮层:`, JSON.stringify(ask));

    // ③ 去知识图谱学习
    await page.click('#kgaYes');
    let kg = null;
    for (let i = 0; i < 25; i++) {
      await page.waitForTimeout(200);
      kg = await page.evaluate(() => {
        const res = document.getElementById('kgRes');
        const card = document.querySelector('.panel.p-kg');
        const r = card.getBoundingClientRect();
        const inView = r.top < innerHeight * 0.8 && r.bottom > 0;   // 卡片进入视口
        return {
          askClosed: !document.getElementById('kgAsk').classList.contains('is-open'),
          kgDocked: card.classList.contains('is-dock'),
          type: document.getElementById('kgType').value,
          level: document.getElementById('kgLevel').value,
          instOk: /本次检出/.test(res.textContent || ''),
          triOk: document.getElementById('kgTri').children.length > 0 && !/正在读取|失败/.test(document.getElementById('kgTri').textContent),
          hiCount: document.querySelectorAll('#kgTri .tr.hi').length,
          inView, flashed: card.classList.contains('flash'),
        };
      });
      if (kg.triOk) break;
    }
    console.log(`[${vp.tag}] ③ 图谱学习:`, JSON.stringify(kg, null, 1));
    await page.screenshot({ path: OUT + 'arc-08-lab2kg-' + vp.tag + '.png' });

    // 宽屏要求抬卡；窄屏要求进入视口 + 脉冲
    const ok = dets.length > 0 && ask.open && kg.askClosed && kg.triOk && kg.instOk && kg.hiCount > 0
      && (vp.tag === 'wide' ? kg.kgDocked : kg.inView && kg.flashed);
    console.log(`[${vp.tag}] ${ok ? '✓ 通过' : '✗ 未通过'}`);
    if (!ok || errs.length) { allOk = false; errs.slice(0, 5).forEach((e) => console.log('  ', e)); }
    await page.close();
  }

  console.log(allOk ? '✓ 全部分辨率通过' : '✗ 存在未通过项');
  await browser.close();
  process.exit(allOk ? 0 : 1);
})().catch((e) => { console.error('PROBE FAIL:', e.message); process.exit(1); });
