/**
 * tools/record-video.js — 系统功能宣传视频：真实页面录屏 + ffmpeg 剪辑
 *
 * 阶段一（record）：playwright 驱动真实页面，CDP Page.startScreencast 捕获渲染帧流（jpeg+时间戳）
 *                   → 每段 frames.txt（变时基）；无头 rAF 正常产帧，帧率跟随真实渲染
 * 阶段二（assemble）：每段 concat(duration) → mp4（统一规格+首尾淡入淡出）→ concat → 全局字幕 → 成片
 *
 * 用法：node tools/record-video.js record|assemble|all
 * 依赖：playwright-core（npx 缓存）、系统 ffmpeg（winget build）、msyh.ttc
 */
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));

const PROJ = 'C:/Users/17355/.zcode/workspace/default/tunnel-inspection-system';
const WEBM = path.join(PROJ, 'docs', '_vid', 'webm');
const SEG = path.join(PROJ, 'docs', '_vid', 'seg');
const FFMPEG = 'C:\\Users\\17355\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffmpeg.exe';
const FFPROBE = 'C:\\Users\\17355\\AppData\\Local\\Microsoft\\WinGet\\Packages\\Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe\\ffmpeg-8.1.1-full_build\\bin\\ffprobe.exe';
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';
const URL = 'http://127.0.0.1:8899/prototype-holo-core.html?v=rec' + Date.now();
const W = 1600, H = 900;

const SEGS = ['s0-open', 's1-detect', 's2-archive', 's3-review', 's4-stats', 's5-kg', 's6-end'];

/* ---------- 阶段一：录屏 ---------- */
async function record() {
  fs.mkdirSync(WEBM, { recursive: true });
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });

  async function seg(name, act) {
    const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
    const page = await ctx.newPage();
    await page.goto(URL, { waitUntil: 'load' });
    await page.waitForTimeout(2600);            // 等页面数据与轨道动画就绪
    // CDP 帧捕获：只捕获真实重绘帧，ack 才会继续推流
    const cdp = await ctx.newCDPSession(page);
    const frames = [];
    cdp.on('Page.screencastFrame', (ev) => {
      frames.push({ data: Buffer.from(ev.data, 'base64'), ts: Date.now() });
      cdp.send('Page.screencastFrameAck', { sessionId: ev.sessionId }).catch(() => {});
    });
    await cdp.send('Page.startScreencast', { format: 'jpeg', quality: 70, maxWidth: W, maxHeight: H, everyNthFrame: 1 });
    try { await act(page); } catch (e) { console.error(`[${name}] 动作出错（继续）:`, e.message.split('\n')[0]); }
    await page.waitForTimeout(600);
    await cdp.send('Page.stopScreencast').catch(() => {});
    // 帧落盘 + 变时基清单
    const dir = path.join(WEBM, name); fs.mkdirSync(dir, { recursive: true });
    if (!frames.length) throw new Error(`[${name}] 未捕获到任何帧`);
    const list = [];
    for (let i = 0; i < frames.length; i++) {
      const f = String(i).padStart(6, '0') + '.jpg';
      fs.writeFileSync(path.join(dir, f), frames[i].data);
      const dur = i < frames.length - 1 ? (frames[i + 1].ts - frames[i].ts) / 1000 : 1 / 30;
      list.push(`file '${f}'\nduration ${Math.max(0.012, dur).toFixed(4)}`);
    }
    list.push(`file '${String(frames.length - 1).padStart(6, '0')}.jpg'`); // concat 尾帧重复（demuxer 要求）
    fs.writeFileSync(path.join(dir, 'frames.txt'), list.join('\n'));
    await ctx.close();
    console.log(`✓ 已录制 ${name} · ${frames.length} 帧 · ${(frames[frames.length - 1].ts - frames[0].ts) / 1000 | 0}s`);
  }

  /* 通用：把某卡 hover 到正前并展开（dock） */
  async function dock(page, key) {
    await page.hover('.panel.p-' + key);
    await page.waitForTimeout(1400);
    await page.click('.panel.p-' + key + ' .ph');
    for (let i = 0; i < 14; i++) { await page.waitForTimeout(80); await page.screenshot({ path: path.join(WEBM, '_f.png') }); }
    await page.waitForTimeout(400);
  }

  await seg('s0-open', async (page) => {
    // 全景：鼠标缓慢画圈制造球体视差 + 轨道自转
    const cx = 800, cy = 450;
    for (let a = 0; a < Math.PI * 2; a += 0.12) {
      await page.mouse.move(cx + Math.cos(a) * 380, cy + Math.sin(a) * 180);
      await page.waitForTimeout(90);
    }
    await page.waitForTimeout(1500);
  });

  await seg('s1-detect', async (page) => {
    await dock(page, 'lab');
    await page.waitForTimeout(5200);
  });

  await seg('s2-archive', async (page) => {
    await dock(page, 'ledger');
    // 滚动列表展示真实缩略图流
    await page.evaluate(() => { const l = document.querySelector('.panel.p-ledger .pb'); if (l) l.scrollTop = 220; });
    await page.waitForTimeout(1600);
    await page.evaluate(() => { const l = document.querySelector('.panel.p-ledger .pb'); if (l) l.scrollTop = 0; });
    await page.waitForTimeout(900);
    // 点一条带真实原图的记录 → 详情弹窗（原图 + 检出框）
    const clicked = await page.evaluate(() => {
      const rows = [...document.querySelectorAll('#ldList .arc')];
      const real = rows.find((r) => r.querySelector('.th img'));
      if (real) { real.click(); return true; } return false;
    });
    if (clicked) { await page.waitForTimeout(2600); await page.keyboard.press('Escape'); await page.waitForTimeout(500); }
    await page.waitForTimeout(2500);
  });

  await seg('s3-review', async (page) => {
    await dock(page, 'review');
    await page.waitForTimeout(800);
    // 点队列第一条 → 填备注 → 通过 → 原地刷新
    await page.evaluate(() => { const r = document.querySelector('#rvList .rv'); if (r) r.click(); });
    await page.waitForTimeout(1600);
    const hasPass = await page.evaluate(() => !!document.getElementById('rvmPass'));
    if (hasPass) {
      const note = await page.$('#rvmNote');
      if (note) await note.fill('同意通过，按规范处置并按周期复查');
      await page.click('#rvmPass');
      await page.waitForTimeout(1900);
      await page.waitForTimeout(2400);
      await page.keyboard.press('Escape');
      await page.waitForTimeout(500);
    }
    await page.waitForTimeout(2000);
  });

  await seg('s4-stats', async (page) => {
    await dock(page, 'stats');
    await page.waitForTimeout(5000);
  });

  await seg('s5-kg', async (page) => {
    await dock(page, 'kg');
    await page.waitForTimeout(700);
    await page.click('#kgOpenFull');
    await page.waitForTimeout(3400);              // 球自转
    // 拖拽转球
    await page.mouse.move(800, 450); await page.mouse.down();
    for (let i = 0; i < 24; i++) { await page.mouse.move(800 + i * 14, 450 + Math.sin(i / 4) * 26); await page.waitForTimeout(34); }
    await page.mouse.up();
    await page.waitForTimeout(1400);
    // 点中心选节点 → 转正动画
    await page.mouse.click(800, 430);
    await page.waitForTimeout(4200);
    await page.keyboard.press('Escape');
    await page.waitForTimeout(2200);
  });

  await seg('s6-end', async (page) => {
    await page.mouse.move(400, 260);
    await page.waitForTimeout(400);
    for (let a = 0; a < Math.PI * 1.6; a += 0.1) {
      await page.mouse.move(800 + Math.cos(a) * 360, 450 + Math.sin(a) * 160);
      await page.waitForTimeout(95);
    }
    await page.waitForTimeout(3600);
  });

  await browser.close();
  console.log('录制完成 →', WEBM);
}

/* ---------- 阶段二：剪辑 ---------- */
function probeDur(f) {
  return parseFloat(execFileSync(FFPROBE, ['-v', 'error', '-show_entries', 'format=duration', '-of', 'csv=p=0', f], { encoding: 'utf-8' }).trim());
}
/** 帧清单总时长（frames.txt 各 duration 之和，尾部重复帧忽略） */
function durOf(framesTxt) {
  return fs.readFileSync(framesTxt, 'utf-8').split('\n')
    .filter((l) => l.startsWith('duration'))
    .map((l) => parseFloat(l.split(/\s+/)[1]))
    .reduce((a, b) => a + b, 0);
}

function assemble() {
  fs.mkdirSync(SEG, { recursive: true });
  // 1) 每段帧序列（concat 变时基）→ mp4（30fps、首尾各 0.5s 淡入淡出）
  //    超长段做时间压缩（duration×speed，speed<1 = 快放）
  const SPEEDS = { 's2-archive': 0.4, 's4-stats': 0.45, 's5-kg': 0.35 };
  const mp4s = [];
  for (const name of SEGS) {
    const src = path.join(WEBM, name, 'frames.txt');
    if (!fs.existsSync(src)) throw new Error('缺少片段：' + src);
    const out = path.join(SEG, name + '.mp4');
    const sp = SPEEDS[name] || 1;
    const dur = durOf(src) * sp;
    execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', src, '-vf',
      `setpts=PTS*${sp},fps=30,scale=${W}:${H},fade=t=in:st=0:d=0.5,fade=t=out:st=${Math.max(0.6, dur - 0.55).toFixed(2)}:d=0.5,format=yuv420p`,
      '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-an', out]);
    mp4s.push(out);
    console.log(`✓ 片段 ${name} ${durOf(src).toFixed(1)}s → ${dur.toFixed(1)}s（×${(1 / sp).toFixed(1)} 快放）`);
  }
  // 2) concat（同规格 copy）
  const list = path.join(SEG, 'list.txt');
  fs.writeFileSync(list, mp4s.map((f) => "file '" + f.replace(/\\/g, '/') + "'").join('\n'));
  const merged = path.join(SEG, 'merged.mp4');
  execFileSync(FFMPEG, ['-y', '-f', 'concat', '-safe', '0', '-i', list, '-c', 'copy', merged]);
  // 3) 全局字幕（按累计时间轴淡入淡出）
  const durs = mp4s.map(probeDur);
  const starts = []; let acc = 0;
  for (const d of durs) { starts.push(acc); acc += d; }
  const TITLES = [
    '01 AI 检测工作台 · 白盒化检测链路',
    '02 病害档案 · 真实影像 + 检出框回溯',
    '03 人工复核 · 人机协同审核闭环',
    '04 统计与报告 · Excel / PDF 一键导出',
    '05 知识图谱 · 识别—定级—成因—处置闭环推理',
  ];
  const filters = [];
  // 片头（0~s0 段内居中主标题）
  filters.push(`drawtext=fontfile='${FONT}':text='隧途明鉴':fontsize=88:fontcolor=white:borderw=3:bordercolor=black@0.55:x=(w-text_w)/2:y=h/2-140:alpha='clip(min((t-0.8)/0.8,(6.2-t)/0.8),0,1)'`);
  filters.push(`drawtext=fontfile='${FONT}':text='隧道病害智能检测与分析系统':fontsize=34:fontcolor=white@0.92:borderw=2:bordercolor=black@0.5:x=(w-text_w)/2:y=h/2-10:alpha='clip(min((t-1.3)/0.8,(6.2-t)/0.8),0,1)'`);
  // 各功能段左下角小标
  TITLES.forEach((txt, i) => {
    const si = i + 1;                              // 对应 seg 下标（s1..s5）
    if (si >= starts.length) return;
    const st = starts[si] + 0.9, en = starts[si] + durs[si] - 0.9;
    filters.push(`drawtext=fontfile='${FONT}':text='${txt}':fontsize=36:fontcolor=white:borderw=3:bordercolor=black@0.55:x=64:y=h-110:alpha='clip(min((t-${st.toFixed(2)})/0.6,(${en.toFixed(2)}-t)/0.6),0,1)'`);
  });
  // 片尾
  const eSt = starts[starts.length - 1] + 1.0;
  filters.push(`drawtext=fontfile='${FONT}':text='AI 赋能隧道工程教学与科研':fontsize=52:fontcolor=white:borderw=3:bordercolor=black@0.55:x=(w-text_w)/2:y=h/2-80:alpha='clip(min((t-${eSt.toFixed(2)})/0.8,1),0,1)'`);
  filters.push(`drawtext=fontfile='${FONT}':text='零依赖 · 单机部署 · 浏览器全链路':fontsize=30:fontcolor=white@0.9:borderw=2:bordercolor=black@0.5:x=(w-text_w)/2:y=h/2+20:alpha='clip(min((t-${(eSt + 0.6).toFixed(2)})/0.8,1),0,1)'`);
  const final = path.join(PROJ, 'docs', 'tunnel-system-demo.mp4');
  execFileSync(FFMPEG, ['-y', '-i', merged, '-vf', filters.join(','), '-c:v', 'libx264', '-preset', 'medium', '-crf', '20', '-an', final]);
  console.log('成片 →', final, '·', acc.toFixed(1) + 's');
}

const phase = process.argv[2] || 'all';
(phase === 'record' ? record() : Promise.resolve())
  .then(() => { if (phase === 'assemble' || phase === 'all') { assemble(); } })
  .catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
