/** Continuous, interaction-led system demo with narration and burned subtitles. */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const pw = require(path.join('C:/Users/17355/AppData/Local/npm-cache/_npx/423231821c231c73/node_modules/playwright-core'));

const ROOT = path.resolve(__dirname, '..');
const WORK = path.join(ROOT, 'docs', '_demo_dynamic');
const RAW = path.join(WORK, 'raw');
const SEG = path.join(WORK, 'segments');
const VOICE = path.join(ROOT, 'docs', '_demo_full', 'voice');
const OUT = path.join(ROOT, '参赛材料', '04-演示材料', '隧途明鉴-系统动态演示视频.mp4');
const SCRIPT_OUT = path.join(ROOT, '参赛材料', '04-演示材料', '系统动态演示视频-讲解稿.md');
const ITEMS = JSON.parse(fs.readFileSync(path.join(__dirname, 'demo-narration.json'), 'utf8'));
const FINAL_ITEMS = ITEMS.filter(x => x.id !== '04-training');
const SAMPLE = path.join(ROOT, 'backend', 'data', 'train-real', 'images', '3_3_033_26.png');
const FFMPEG = 'C:/Users/17355/AppData/Local/Microsoft/WinGet/Packages/Gyan.FFmpeg_Microsoft.Winget.Source_8wekyb3d8bbwe/ffmpeg-8.1.1-full_build/bin/ffmpeg.exe';
const FFPROBE = FFMPEG.replace('ffmpeg.exe', 'ffprobe.exe');
const FONT = 'C\\:/Windows/Fonts/msyh.ttc';
const SPEED = 1.45;
const W = 1600, H = 900;
const URL = 'http://127.0.0.1:8899/prototype-holo-core.html?dynamic=';
const LEGACY = 'file:///' + path.join(ROOT, 'frontend', 'legacy-home.html').replace(/\\/g, '/');

for (const d of [WORK, RAW, SEG, path.dirname(OUT)]) fs.mkdirSync(d, {recursive:true});
function run(bin,args){ execFileSync(bin,args,{stdio:'inherit'}); }
function dur(f){ return +execFileSync(FFPROBE,['-v','error','-show_entries','format=duration','-of','csv=p=0',f],{encoding:'utf8'}).trim(); }
function srtTime(t){ const n=Math.round(t*1000); return `${String(Math.floor(n/3600000)).padStart(2,'0')}:${String(Math.floor(n%3600000/60000)).padStart(2,'0')}:${String(Math.floor(n%60000/1000)).padStart(2,'0')},${String(n%1000).padStart(3,'0')}`; }
const wait = ms => new Promise(r=>setTimeout(r,ms));

async function recordDynamic(){
  const coreOnly=process.argv[2]==='recordcore';
  const legacyOnly=process.argv[2]==='recordlegacy';
  const browser=await pw.chromium.launch({channel:'msedge',headless:true});
  const ctx=await browser.newContext({viewport:{width:W,height:H},deviceScaleFactor:1});
  const page=await ctx.newPage();
  const targets=Object.fromEntries(ITEMS.map(x=>[x.id,dur(path.join(VOICE,x.id+'.wav'))/SPEED+0.7]));

  async function lively(ms){
    const start=Date.now(); let i=0;
    while(Date.now()-start<ms){
      const x=800+Math.cos(i/5)*360, y=450+Math.sin(i/7)*190;
      await page.mouse.move(x,y,{steps:3}); await page.waitForTimeout(90); i++;
    }
  }
  async function record(id,act){
    const dir=path.join(RAW,id); fs.mkdirSync(dir,{recursive:true});
    const cdp=await ctx.newCDPSession(page); const frames=[];
    cdp.on('Page.screencastFrame',ev=>{frames.push({data:Buffer.from(ev.data,'base64'),ts:Date.now()}); cdp.send('Page.screencastFrameAck',{sessionId:ev.sessionId}).catch(()=>{});});
    await cdp.send('Page.startScreencast',{format:'jpeg',quality:78,maxWidth:W,maxHeight:H,everyNthFrame:2});
    const started=Date.now(); await act();
    const left=Math.max(0,targets[id]*1000-(Date.now()-started)); if(left) await lively(left);
    await cdp.send('Page.stopScreencast'); await cdp.detach();
    if(frames.length<2) throw new Error('Too few frames for '+id);
    const lines=[];
    for(let i=0;i<frames.length;i++){
      const name=String(i).padStart(6,'0')+'.jpg'; fs.writeFileSync(path.join(dir,name),frames[i].data);
      if(i<frames.length-1) lines.push(`file '${name}'\nduration ${Math.max(.02,(frames[i+1].ts-frames[i].ts)/1000).toFixed(4)}`);
    }
    lines.push(`file '${String(frames.length-1).padStart(6,'0')}.jpg'`);
    fs.writeFileSync(path.join(dir,'frames.txt'),lines.join('\n'));
    console.log('REC',id,frames.length,'frames',((frames.at(-1).ts-frames[0].ts)/1000).toFixed(1),'sec');
  }
  async function home(){ await page.goto(URL+Date.now(),{waitUntil:'load'}); await page.waitForTimeout(2200); }
  async function dock(key){ await page.hover('.panel.p-'+key); await page.waitForTimeout(900); await page.click('.panel.p-'+key+' .ph'); await page.waitForTimeout(900); }
  async function darkLegacy(){
    await page.addStyleTag({content:`
      html,body,.app,.shell,main,section,.teach-page,.train-page,.portal-page{background:#050b16!important;color:#dcecff!important}
      body *:not(img):not(svg):not(path):not(canvas){background-color:#0a1425!important;color:#dcecff!important}
      header,.topbar,.navbar,.card,.panel,.teach-card,.train-card,.portal-card,.stat-card,.data-card,
      .teach-head,.train-head,.portal-head,.teach-grid>*,.train-grid>*,.portal-grid>*,table,thead,tbody,tr,td,th,
      .upload-zone,.teach-upload,.syn-panel,.exp-panel,.pg-grid,.kb-panel,.db-panel,.an-card,.an-pool{
        background:#0a1425!important;color:#dcecff!important;border-color:#26445e!important;box-shadow:none!important}
      button,.btn,select,input,textarea{background:#0d1b30!important;color:#e5f4ff!important;border-color:#315b78!important}
      .muted,.sub,.hint,.teach-sub,.syn-warn,.an-pool-empty{color:#8fb1c9!important}
      canvas{background:#07111f!important} *{scrollbar-color:#315b78 #07111f!important}
    `});
  }

  await home();
  if(!coreOnly&&!legacyOnly) await record('01-title',async()=>{ await lively(9000); });

  if(!legacyOnly) await record('02-workbench',async()=>{
    await dock('lab');
    await page.click('#orbOpenLab',{force:true,timeout:5000}); await page.waitForTimeout(1200);
    await page.check('#labArc').catch(()=>{});
    await page.setInputFiles('#labFile',SAMPLE);
    await page.waitForFunction(()=>document.querySelectorAll('#labList .rc').length>0,{timeout:25000}).catch(()=>{});
    await page.waitForTimeout(2500);
    for(const v of ['heat','overlay','boxes']){ await page.click(`[data-view="${v}"]`,{force:true,timeout:3000}).catch(()=>{}); await page.waitForTimeout(2200); }
    const cards=page.locator('#labList .rc'); if(await cards.count()) {
      await cards.first().evaluate(e=>e.scrollIntoView({behavior:'smooth',block:'center'})).catch(()=>{});
      await cards.first().hover({force:true,timeout:3000}).catch(()=>{}); await page.waitForTimeout(1800);
    }
  });

  if(!legacyOnly) await record('03-explain',async()=>{
    await page.click('[data-view="heat"]',{force:true,timeout:3000}).catch(()=>{}); await page.waitForTimeout(2500);
    await page.click('[data-view="overlay"]',{force:true,timeout:3000}).catch(()=>{}); await page.waitForTimeout(2300);
    await page.locator('#labSteps .step').first().hover().catch(()=>{});
    await page.locator('#labThr').evaluate(e=>{e.value='48';e.dispatchEvent(new Event('input',{bubbles:true}));});
    await page.waitForTimeout(1600); await page.click('#labRun',{force:true,timeout:3000}).catch(()=>{}); await page.waitForTimeout(5000);
    await page.locator('#labSteps').evaluate(e=>e.scrollIntoView({behavior:'smooth',block:'center'})).catch(()=>{}); await page.waitForTimeout(2800);
  });

  if(coreOnly){ await browser.close(); return; }

  await record('04-training',async()=>{
    await page.goto(LEGACY,{waitUntil:'load'}); await darkLegacy(); await page.waitForTimeout(1200); await page.click('#btnTrain'); await page.waitForTimeout(1200);
    const sliders=page.locator('#trainPage input[type=range]');
    for(let i=0;i<Math.min(3,await sliders.count());i++){ await sliders.nth(i).evaluate((e,i)=>{e.value=String(+e.min+(+e.max-+e.min)*(0.35+i*.2));e.dispatchEvent(new Event('input',{bubbles:true}));},i); await page.waitForTimeout(1300); }
    await page.mouse.wheel(0,650); await page.waitForTimeout(2200); await page.mouse.wheel(0,-420); await page.waitForTimeout(1600);
  });

  if(legacyOnly){
    await record('07-database',async()=>{
      await page.goto(LEGACY,{waitUntil:'load'}); await darkLegacy(); await page.waitForTimeout(1200); await page.click('#btnPortal'); await page.waitForTimeout(1500);
      for(const sel of ['#pgTabSamples','#pgTabKb','#pgTabDb']){if(await page.locator(sel).count()){await page.click(sel);await page.waitForTimeout(1800);}}
      await page.mouse.wheel(0,620); await page.waitForTimeout(1800); await page.mouse.wheel(0,-360);
    });
    await browser.close(); return;
  }

  await home();
  await record('05-ledger-review',async()=>{
    await dock('ledger'); await page.waitForTimeout(1600); await page.locator('#ldList').evaluate(e=>e.scrollTop=260).catch(()=>{}); await page.waitForTimeout(1600); await page.locator('#ldList').evaluate(e=>e.scrollTop=0).catch(()=>{});
    const row=page.locator('#ldList .arc').first(); if(await row.count()){await row.click();await page.waitForTimeout(3000);await page.keyboard.press('Escape');}
    await page.keyboard.press('Escape').catch(()=>{}); await page.waitForTimeout(900); await dock('review');
    const rv=page.locator('#rvList .rv').first(); if(await rv.count()){await rv.click();await page.waitForTimeout(3000);await page.locator('#rvmPass').hover().catch(()=>{});}
  });

  await home();
  await record('06-stats',async()=>{ await dock('stats'); await page.waitForTimeout(2200); await page.locator('#stResearch').hover().catch(()=>{}); await page.mouse.wheel(0,280); await page.waitForTimeout(1800); });

  await record('07-database',async()=>{
    await page.goto(LEGACY,{waitUntil:'load'}); await darkLegacy(); await page.waitForTimeout(1200); await page.click('#btnPortal'); await page.waitForTimeout(1500);
    for(const sel of ['#pgTabSamples','#pgTabKb','#pgTabDb']){if(await page.locator(sel).count()){await page.click(sel);await page.waitForTimeout(1800);}}
    await page.mouse.wheel(0,620); await page.waitForTimeout(1800); await page.mouse.wheel(0,-360);
  });

  await home();
  await record('08-kg',async()=>{
    await dock('kg'); await page.waitForTimeout(1800); await page.click('#kgOpenFull'); await page.waitForTimeout(2600);
    await page.mouse.move(780,430); await page.mouse.down(); for(let i=0;i<30;i++){await page.mouse.move(780+i*11,430+Math.sin(i/4)*35);await page.waitForTimeout(45);} await page.mouse.up();
    await page.waitForTimeout(1800); await page.mouse.wheel(0,-420); await page.waitForTimeout(1800); await page.mouse.click(800,430); await page.waitForTimeout(3500);
  });

  await page.keyboard.press('Escape').catch(()=>{}); await home();
  await record('09-ending',async()=>{ await lively(10000); });
  await browser.close();
}

function assemble(){
  const parts=[]; const cues=[]; let gt=0,no=1;
  for(const item of FINAL_ITEMS){
    const frames=path.join(RAW,item.id,'frames.txt'); const voice=path.join(VOICE,item.id+'.wav');
    const target=dur(voice)/SPEED+0.7; const visual=path.join(SEG,item.id+'-v.mp4'); const part=path.join(SEG,item.id+'.mp4');
    run(FFMPEG,['-y','-f','concat','-safe','0','-i',frames,'-vf',`fps=30,scale=${W}:${H},format=yuv420p`,'-t',target.toFixed(3),'-c:v','libx264','-preset','veryfast','-crf','21','-an',visual]);
    run(FFMPEG,['-y','-i',visual,'-i',voice,'-filter_complex',`[1:a]atempo=${SPEED},apad=pad_dur=0.7[a]`,'-map','0:v','-map','[a]','-t',target.toFixed(3),'-c:v','copy','-c:a','aac','-b:a','160k','-ar','48000','-ac','2',part]); parts.push(part);
    const ss=item.text.match(/[^。！？]+[。！？]?/g)||[item.text], total=ss.reduce((a,s)=>a+s.length,0); let lt=0;
    for(const s of ss){const sd=(target-.7)*s.length/total;cues.push(`${no++}\n${srtTime(gt+lt)} --> ${srtTime(gt+lt+sd)}\n${s.trim()}\n`);lt+=sd;} gt+=target;
  }
  const list=path.join(SEG,'all.txt');fs.writeFileSync(list,parts.map(f=>`file '${f.replace(/\\/g,'/')}'`).join('\n'));
  const merged=path.join(WORK,'merged.mp4');run(FFMPEG,['-y','-f','concat','-safe','0','-i',list,'-c','copy',merged]);
  const srt=path.join(WORK,'subtitles.srt');fs.writeFileSync(srt,cues.join('\n'),'utf8'); const sp=srt.replace(/\\/g,'/').replace(/:/g,'\\:').replace(/'/g,"\\'");
  run(FFMPEG,['-y','-i',merged,'-vf',`subtitles='${sp}':force_style='FontName=Microsoft YaHei,FontSize=16,PrimaryColour=&H00FFFFFF,OutlineColour=&H90000000,Outline=2,MarginV=30,Alignment=2'`,'-c:v','libx264','-preset','medium','-crf','22','-maxrate','5M','-bufsize','10M','-c:a','copy','-movflags','+faststart',OUT]);
  const md=['# 《隧途明鉴》动态演示视频讲解稿','',...FINAL_ITEMS.map((x,i)=>({...x,title:x.title.replace(/^0[4-9]/,m=>String(Number(m)-1).padStart(2,'0'))})).flatMap((x,i)=>[`## ${i+1}. ${x.title}`,'',x.text,''])];fs.writeFileSync(SCRIPT_OUT,md.join('\n'),'utf8');
  console.log('DONE',OUT,dur(OUT).toFixed(2)+'s');
}
(async()=>{if(process.argv[2]==='recordcore'||process.argv[2]==='recordlegacy'){await recordDynamic();return;} if(process.argv[2]!=='assemble') await recordDynamic();assemble();})().catch(e=>{console.error(e);process.exit(1);});
