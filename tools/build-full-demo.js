/** Build a 3-5 minute narrated MP4 from real system UI captures. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'docs', '_demo_full');
const SHOTS = path.join(WORK, 'shots');
const VOICE = path.join(WORK, 'voice');
const SEGS = path.join(WORK, 'segments');
const OUT = path.join(ROOT, '参赛材料', '04-演示材料', '隧途明鉴-系统演示视频-完整版.mp4');
const SCRIPT_OUT = path.join(ROOT, '参赛材料', '04-演示材料', '系统演示视频-讲解稿.md');
const FFMPEG = 'C:/Users/17355/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe';
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';
const items = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-narration.json'), 'utf8'));
const W = 1600, H = 900;
const LEGACY_URL = 'file:///' + path.join(ROOT, 'frontend', 'legacy-home.html').replace(/\\/g, '/');

for (const dir of [WORK, SHOTS, VOICE, SEGS, path.dirname(OUT)]) fs.mkdirSync(dir, { recursive: true });

function run(bin, args) { execFileSync(bin, args, { stdio: 'inherit' }); }
function duration(file) {
  return Number(execFileSync(FFPROBE, ['-v','error','-show_entries','format=duration','-of','csv=p=0',file], {encoding:'utf8'}).trim());
}
function escDraw(s) { return s.replace(/\\/g,'\\\\').replace(/:/g,'\\:').replace(/'/g,"\\'").replace(/%/g,'\\%'); }
function srtTime(t) {
  const ms = Math.max(0, Math.round(t * 1000));
  const h = String(Math.floor(ms / 3600000)).padStart(2,'0');
  const m = String(Math.floor(ms % 3600000 / 60000)).padStart(2,'0');
  const s = String(Math.floor(ms % 60000 / 1000)).padStart(2,'0');
  return `${h}:${m}:${s},${String(ms % 1000).padStart(3,'0')}`;
}

async function capture() {
  const browser = await pw.chromium.launch({ channel: 'msedge', headless: true });
  const ctx = await browser.newContext({ viewport: { width: W, height: H }, deviceScaleFactor: 1 });
  const page = await ctx.newPage();
  async function shot(id, suffix='a') {
    await page.waitForTimeout(900);
    await page.screenshot({ path: path.join(SHOTS, `${id}-${suffix}.png`) });
  }
  async function dock(key, id) {
    await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?demo=' + Date.now(), {waitUntil:'load'});
    await page.waitForTimeout(1800);
    await page.hover('.panel.p-' + key);
    await page.waitForTimeout(700);
    await page.click('.panel.p-' + key + ' .ph');
    await page.waitForTimeout(900);
    await shot(id, 'a');
  }

  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?demo=' + Date.now(), {waitUntil:'load'});
  await page.waitForTimeout(2400); await shot('01-title', 'a');
  await dock('lab', '02-workbench');

  await page.goto(LEGACY_URL, {waitUntil:'load'});
  await page.waitForTimeout(1800);
  await page.click('#btnTeach'); await page.waitForTimeout(1400); await shot('03-explain', 'a');
  const teachHeat = page.locator('#teachPage'); if (await teachHeat.count()) { await teachHeat.evaluate(e => e.scrollTop = 420); await shot('03-explain', 'b'); }
  await page.click('#btnTrain'); await page.waitForTimeout(1400); await shot('04-training', 'a');
  const trainPage = page.locator('#trainPage'); if (await trainPage.count()) { await trainPage.evaluate(e => e.scrollTop = 420); await shot('04-training', 'b'); }

  await dock('ledger', '05-ledger-review');
  const row = page.locator('#ldList .arc').first();
  if (await row.count()) { await row.click(); await page.waitForTimeout(900); await shot('05-ledger-review', 'b'); await page.keyboard.press('Escape'); }
  await dock('review', '05-ledger-review'); await shot('05-ledger-review', 'c');
  await dock('stats', '06-stats');

  await page.goto(LEGACY_URL, {waitUntil:'load'});
  await page.waitForTimeout(1400); await page.click('#btnPortal'); await page.waitForTimeout(1500); await shot('07-database', 'a');
  const portalPage = page.locator('#portalPage'); if (await portalPage.count()) { await portalPage.evaluate(e => e.scrollTop = 450); await shot('07-database', 'b'); }

  await dock('kg', '08-kg');
  const full = page.locator('#kgOpenFull');
  if (await full.count()) { await full.click(); await page.waitForTimeout(1800); await shot('08-kg', 'b'); await page.keyboard.press('Escape'); }

  await page.goto('http://127.0.0.1:8899/prototype-holo-core.html?demo=' + Date.now(), {waitUntil:'load'});
  await page.waitForTimeout(2200); await shot('09-ending', 'a');
  await browser.close();
}

function writeScript() {
  const lines = ['# 《隧途明鉴》系统演示视频讲解稿', '', '目标时长：3–5 分钟；成片格式：MP4；画面：1600×900；包含配音与同步字幕。', ''];
  items.forEach((x, i) => lines.push(`## ${i + 1}. ${x.title}`, '', x.text, ''));
  fs.writeFileSync(SCRIPT_OUT, lines.join('\n'), 'utf8');
}

function makeVoice() {
  run('powershell.exe', ['-NoProfile','-ExecutionPolicy','Bypass','-File',path.join(__dirname,'make-demo-voice.ps1'),'-JsonPath',path.join(__dirname,'demo-narration.json'),'-OutputDir',VOICE]);
}

function makeVideo() {
  const segFiles = [];
  const subtitles = [];
  let globalStart = 0, cueNo = 1;
  for (const item of items) {
    const audio = path.join(VOICE, item.id + '.wav');
    const dur = duration(audio) + 0.9;
    const shots = fs.readdirSync(SHOTS).filter(f => f.startsWith(item.id + '-')).sort().map(f => path.join(SHOTS,f));
    if (!shots.length) throw new Error('Missing capture for ' + item.id);
    const per = dur / shots.length;
    const visualParts = [];
    for (let i=0; i<shots.length; i++) {
      const out = path.join(SEGS, `${item.id}-v${i}.mp4`);
      const frames = Math.max(1, Math.round(per * 30));
      const z = i % 2 ? "zoompan=z='min(zoom+0.00035,1.055)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'" : "zoompan=z='min(zoom+0.00028,1.045)':x='iw/2-(iw/zoom/2)':y='ih/2-(ih/zoom/2)'";
      run(FFMPEG, ['-y','-loop','1','-i',shots[i],'-vf',`${z}:d=${frames}:s=${W}x${H}:fps=30,format=yuv420p`,'-t',per.toFixed(3),'-c:v','libx264','-preset','veryfast','-crf','21','-an',out]);
      visualParts.push(out);
    }
    const list = path.join(SEGS, item.id + '-visual.txt');
    fs.writeFileSync(list, visualParts.map(f => `file '${f.replace(/\\/g,'/')}'`).join('\n'));
    const visual = path.join(SEGS, item.id + '-visual.mp4');
    run(FFMPEG, ['-y','-f','concat','-safe','0','-i',list,'-c','copy',visual]);
    const seg = path.join(SEGS, item.id + '.mp4');
    const title = escDraw(item.title);
    const vf = `drawbox=x=0:y=0:w=iw:h=82:color=0x071521@0.72:t=fill,drawtext=fontfile='${FONT}':text='${title}':fontsize=34:fontcolor=white:x=48:y=24,fade=t=in:st=0:d=0.35,fade=t=out:st=${Math.max(0,dur-0.45).toFixed(2)}:d=0.45`;
    run(FFMPEG, ['-y','-i',visual,'-i',audio,'-vf',vf,'-af','apad=pad_dur=0.9','-t',dur.toFixed(3),'-c:v','libx264','-preset','veryfast','-crf','21','-c:a','aac','-b:a','160k','-ar','48000','-ac','2',seg]);
    segFiles.push(seg);

    const sentences = item.text.match(/[^。！？]+[。！？]?/g) || [item.text];
    const weights = sentences.map(s => s.replace(/\s/g,'').length);
    const total = weights.reduce((a,b)=>a+b,0);
    let local = 0;
    for (let i=0; i<sentences.length; i++) {
      const sd = (dur - 0.9) * weights[i] / total;
      subtitles.push(`${cueNo++}\n${srtTime(globalStart + local)} --> ${srtTime(globalStart + local + sd)}\n${sentences[i].trim()}\n`);
      local += sd;
    }
    globalStart += dur;
  }
  const concat = path.join(SEGS, 'all.txt');
  fs.writeFileSync(concat, segFiles.map(f => `file '${f.replace(/\\/g,'/')}'`).join('\n'));
  const merged = path.join(WORK, 'merged.mp4');
  run(FFMPEG, ['-y','-f','concat','-safe','0','-i',concat,'-c','copy',merged]);
  const srt = path.join(WORK, 'subtitles.srt'); fs.writeFileSync(srt, subtitles.join('\n'), 'utf8');
  const subPath = srt.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
  run(FFMPEG, ['-y','-i',merged,'-vf',`subtitles='${subPath}':force_style='FontName=Microsoft YaHei,FontSize=20,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,BorderStyle=1,Outline=2,Shadow=0,MarginV=34,Alignment=2'`,'-c:v','libx264','-preset','medium','-crf','22','-maxrate','5M','-bufsize','10M','-c:a','copy','-movflags','+faststart',OUT]);
  console.log(`DONE ${OUT} ${duration(OUT).toFixed(2)}s`);
}

(async () => {
  writeScript();
  await capture();
  makeVoice();
  makeVideo();
})().catch(e => { console.error(e); process.exit(1); });
