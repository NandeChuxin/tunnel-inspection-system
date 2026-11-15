/* ============================================================================
 * §4 检测工作台（Lab）功能层：后端基址判定、PNG 载入、runDetect（POST /api/detect/image）、runHeat（POST /api/explain/detect）、视频取帧、结果卡渲染、检测框绘制、事件绑定
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\docs\prototype-holo-core.html  第 2354–3119 行（原文照搬，仅加本表头）
 * ========================================================================== */
    var pct = parseFloat(dv.dataset.pct);
    var C = 2 * Math.PI * 38;
    setTimeout(function () { dv.setAttribute('stroke-dashoffset', (C * (1 - pct / 100)).toFixed(1)); }, RM ? 0 : 200);
  }
}

/* --- 3.10 时钟 --- */
function tickClock() {
  var d = new Date();
  var p = function (n) { return (n < 10 ? '0' : '') + n; };
  $('#clock').textContent = p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
}

/* ============================================================================
   §4 检测工作台（LAB）—— 真实接后端的功能层
   ----------------------------------------------------------------------------
   本层不改 §1 状态、不碰 §2 引擎：它是「同一台仪器的另一个模式」。
   网络约定（这是它能在 8899 上直接调 8787 的原因，改动前务必读完）：
     1) 后端基址自动判定 —— 与后端同源（8787）时走相对路径，否则指到 8787；
     2) POST 一律 Content-Type: text/plain —— 属于「简单请求」，不触发 CORS 预检。
        server.js 对 JSON 响应都带 Access-Control-Allow-Origin: *，但没有处理
        OPTIONS；一旦用 application/json 就会先发预检、然后被拦掉。
     3) 检测默认 archive:false，不往演示台账写测试数据；要落库必须显式勾选。
   ========================================================================== */
var Lab = (function () {
  'use strict';

  /* 与后端同源就用相对路径；不对的话（比如本页在 8899 上）指到后端端口 */
  /* API 地址：本地开发（8899 静态 → 8787 后端）走 127.0.0.1:8787；
     云端部署（前后端同端口同源）直接用相对路径。 */
  var API = (location.hostname === '127.0.0.1' || location.hostname === 'localhost')
    ? (location.port === '8787' ? '' : 'http://127.0.0.1:8787')
    : '';

  var root = $('#lab');
  if (!root) return { init: function () {}, open: function () {}, close: function () {} };

  /* --- 元素 --- */
  var elNet = $('#labNet'), elNetTxt = $('#labNetTxt');
  var elStat = $('#labStat'), elHint = $('#labHint'), elSteps = $('#labSteps');
  var elCanvas = $('#labCanvas'), cctx = elCanvas.getContext('2d');
  var elVideo = $('#labVideo');
  var elList = $('#labList'), elCount = $('#labCount');
  var elDrop = $('#labDrop'), elDropV = $('#labDropV'), elVideoIn = $('#labVideoIn');
  var elFile = $('#labFile'), elFileV = $('#labFileV');
  var elUrlIn = $('#labUrlIn'), elUrlGo = $('#labUrlGo'), elUrlHint = $('#labUrlHint');
  var elLiveGo = $('#labLiveGo');
  var elThr = $('#labThr'), elThrV = $('#labThrV');
  var elAlpha = $('#labAlpha'), elAlphaV = $('#labAlphaV');
  var elMethod = $('#labMethod'), elArc = $('#labArc'), elArcTxt = $('#labArcTxt');

  /* --- 工作台自己的状态：刻意与 §1 的 state 分开，互不污染 --- */
  var S = {
    tab: 'photo', view: 'boxes',
    method: 'auto', alpha: 0.45, threshold: 0.55, archive: false,
    png: null,           // 当前源图的 PNG dataUrl：检测与热力图共用同一份输入
    src: null,           // 画面底图：<img>（照片）或 <canvas>（视频取帧）
    W: 0, H: 0,          // 分析尺寸（后端降采样后的真实尺寸，框与热力图都按它对齐）
    dets: [], heat: null, heatImg: {}, steps: null, mask: null,
    taskId: null, elapsedMs: null,
    hot: -1,             // 正在联动的检测框序号（结果卡悬停驱动）
    vtimer: 0, liveTimer: 0, liveSeq: 0, frames: 0, hits: 0, busy: false, timers: {}
  };

  /* 病害类型色：同一青蓝家族的五个明度档（不是五个色相）。紫不参与类型编码，
     只留给严重度 —— 这是全站的三条配色铁律之一。
     类名对应 backend/fusion.js 的 DEFECT_TYPES 五类。 */
  var TCOL = {
    '裂缝': '#2E9FD4',       // 线性病害 · 主青蓝
    '渗漏水': '#46C9C0',     // 水 · 偏青
    '剥落掉块': '#8FD9F5',   // 块体脱落 · 亮青
    '衬砌错台': '#5F8FD8',   // 结构错位 · 偏蓝
    '白华析出': '#9FE8DC'    // 矿物结晶 · 淡青绿
  };
  /* 等级色：青 → 紫的升温梯度，紫只落在最严重两档 */
  var LCOL = { 1: '#2F7C9E', 2: '#3FA6CC', 3: '#6B7BF0', 4: '#9B6BFF' };

  /* ★ 字段口径统一在这里收口 —— 后端的检测元素不是直觉命名的：
       class_name（不是 type）、level 是数字、level_text 才是「2级-中等」、
       bbox 同时挂在顶层和 position 上（同源，均归一化）、mask 几何在元素自己身上。
     漏掉这一层就会出现「画布上显示 undefined」这类静默错误。 */
  function norm(d) {
    var lv = (typeof d.level === 'number') ? d.level : 0;
    return {
      name: d.class_name || d.type || '未分类',
      sub: d.subtype || '',
      lv: lv,
      lvText: d.level_text || (lv ? lv + '级' : ''),
      conf: d.confidence || 0,
      bbox: (d.position && d.position.bbox) || d.bbox || null,
      chainage: (d.position && d.position.chainage) || '--',
      sector: (d.position && d.position.sector) || '--',
      mask: d.mask || null,
      phys: d.physical || null,
      basis: d.basis || [],
      sug: d.suggestions || []
    };
  }

  function esc(s) {
    return String(s == null ? '' : s).replace(/[&<>"]/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' })[c];
    });
  }
  function stat(t) { elStat.textContent = t; }

  /* ---- 后端调用：text/plain 免预检（见本节头部说明） ----
     整段包在 Promise.resolve().then 里：fetch 虽然几乎总是以「被拒绝的 Promise」
     报网络错误，但它对非法入参会同步抛错；同步抛错会跳过下面的 catch 与收尾，
     把推理中的标志和按钮禁用态永久卡住。包一层就没有这个隐患。 */
  function post(path, body) {
    return Promise.resolve().then(function () {
      return fetch(API + path, {
        method: 'POST',
        headers: { 'Content-Type': 'text/plain' },
        body: JSON.stringify(body)
      });
    }).then(function (r) {
      return r.json().catch(function () { return { error: 'HTTP ' + r.status + '：响应不是 JSON' }; })
        .then(function (j) {
          if (!r.ok || j.error) throw new Error(j.error || ('HTTP ' + r.status));
          return j;
        });
    });
  }

  /* ---- 后端连通性：离线时把原因说清楚，而不是让按钮静默失效 ---- */
  function probe() {
    elNet.classList.remove('is-on', 'is-off');
    elNetTxt.textContent = '正在探测后端…';
    fetch(API + '/api/health')
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (j) {
        var ok = !!(j && j.ok !== false);
        elNet.classList.toggle('is-on', ok);
        elNet.classList.toggle('is-off', !ok);
        elNetTxt.textContent = ok
          ? '后端在线 · ' + (API ? API.replace(/^https?:\/\//, '') : location.host)
          : '后端在，但健康检查返回异常';
      })
      .catch(function () {
        elNet.classList.add('is-off');
        elNetTxt.textContent = '后端离线 · 先在项目根目录跑 node backend/server.js';
      });
  }

  /* ============================ 画面合成 ============================
     三层顺序固定：底图 → 热力图（可选）→ 检测框。
     三个视图只是「画到第几层」的差别，所以切换视图不重新推理。 */
  function draw() {
    if (!S.src || !S.W || !S.H) return;
    elHint.hidden = true;
    elCanvas.hidden = false;
    elCanvas.width = S.W;
    elCanvas.height = S.H;
    fitStage();
    cctx.setTransform(1, 0, 0, 1, 0, 0);
    cctx.clearRect(0, 0, S.W, S.H);

    /* 1) 底图 */
    cctx.drawImage(S.src, 0, 0, S.W, S.H);

    /* 2) 热力图：'heat' 把 JET 伪彩按视图透明度压上去；'overlay' 直接用后端合成好的叠加图 */
    if (S.view === 'heat' && S.heatImg.color) {
      cctx.globalAlpha = S.alpha;
      cctx.drawImage(S.heatImg.color, 0, 0, S.W, S.H);
      cctx.globalAlpha = 1;
    } else if (S.view === 'overlay' && S.heatImg.overlay) {
      cctx.drawImage(S.heatImg.overlay, 0, 0, S.W, S.H);
    }

    /* 2.5) 实例掩码叠加：随「实例掩码」圆钮开关，把最近一次检测的
       intermediates.mask（连通域着色图）按固定透明度压在检测框之下 ——
       掩码数据与检测框同尺度（都来自后端缩放图），直接同尺寸绘制即可对齐 */
    if (S.maskOn && S.maskImg) {
      cctx.globalAlpha = 0.55;
      cctx.drawImage(S.maskImg, 0, 0, S.W, S.H);
      cctx.globalAlpha = 1;
    }

    /* 3) 检测框 */
    drawBoxes();
  }

  /* 等比缩放画面到可用空间：宽高比由构造保证，不依赖浏览器对 canvas 的 object-fit 实现 */
  function fitStage() {
    var box = elCanvas.parentNode;
    var availW = Math.max(120, box.clientWidth - 2);            // 减掉左右各 1px 边框
    var availH = Math.max(140, Math.min(window.innerHeight * 0.54, 620));
    var k = Math.min(availW / S.W, availH / S.H);
    elCanvas.style.width = Math.max(1, Math.round(S.W * k)) + 'px';
    elCanvas.style.height = Math.max(1, Math.round(S.H * k)) + 'px';
  }

  function drawBoxes() {
    var n = S.dets.length;
    cctx.font = 'bold 12px "Microsoft YaHei UI","Microsoft YaHei",sans-serif';
    for (var i = 0; i < n; i++) {
      var o = norm(S.dets[i]);
      var b = o.bbox; if (!b) continue;
      var x = b[0] * S.W, y = b[1] * S.H, w = b[2] * S.W, h = b[3] * S.H;
      var near = (S.hot === i);
      var on = (S.hot < 0 || near);              // 有联动时其余框压暗，视线只留一处
      var tc = TCOL[o.name] || '#3FA6CC';
      var lc = LCOL[o.lv] || '#3FA6CC';

      cctx.globalAlpha = on ? 1 : 0.3;
      cctx.strokeStyle = tc;
      cctx.lineWidth = near ? 2.8 : 1.6;
      cctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1);

      /* 四角短刻线：光学元件的定位角标，也让「这是机器给出的框」一眼可辨 */
      var L = Math.max(6, Math.min(w, h) * 0.2);
      cctx.lineWidth = 2.4;
      cctx.beginPath();
      cctx.moveTo(x, y + L); cctx.lineTo(x, y); cctx.lineTo(x + L, y);
      cctx.moveTo(x + w - L, y); cctx.lineTo(x + w, y); cctx.lineTo(x + w, y + L);
      cctx.moveTo(x + w, y + h - L); cctx.lineTo(x + w, y + h); cctx.lineTo(x + w - L, y + h);
      cctx.moveTo(x + L, y + h); cctx.lineTo(x, y + h); cctx.lineTo(x, y + h - L);
      cctx.stroke();

      /* 标签：深底 + 等级色文字与描边 —— 不论底图明暗都够看，不靠运气 */
      var lb = (i + 1) + '  ' + o.name + (o.sub ? '·' + o.sub : '') + '  ' + o.lvText +
        '  ' + Math.round(o.conf * 100) + '%';
      var lw = cctx.measureText(lb).width + 16, lh = 20;
      var lx = clamp(x, 0, Math.max(0, S.W - lw));
      var ly = (y - lh - 4 >= 0) ? (y - lh - 4) : (y + 4);
      cctx.fillStyle = 'rgba(6,10,22,.88)';
      cctx.fillRect(lx, ly, lw, lh);
      cctx.strokeStyle = lc;
      cctx.lineWidth = 1;
      cctx.strokeRect(lx + 0.5, ly + 0.5, lw - 1, lh - 1);
      cctx.fillStyle = lc;
      cctx.fillText(lb, lx + 8, ly + 14.5);
      cctx.globalAlpha = 1;
    }
  }

  /* ---------------------------- 结果卡 ---------------------------- */
  function renderCards() {
    var dets = S.dets || [];
    S.hot = -1;
    elCount.textContent = dets.length + ' 处';
    if (!dets.length) {
      elList.innerHTML = '<div class="lab-none">未检出病害：衬砌表观状态良好。</div>';
      return;
    }
    elList.innerHTML = dets.map(function (d, i) {
      var o = norm(d);
      var lc = LCOL[o.lv] || '#3FA6CC';
      var geo = '';
      if (o.bbox) geo += ' · 框 ' + o.bbox.map(function (v) { return v.toFixed(2); }).join(',');
      /* 掩码几何是连通域实测量，比 bbox 代理口径准 */
      if (o.mask && o.mask.area_px) {
        geo += ' · 掩码 ' + o.mask.area_px + 'px² / 长 ' + o.mask.length_mm +
          'mm / 宽 ' + o.mask.width_mm + 'mm';
      }
      var phys = '';
      if (o.phys) {
        var kv = Object.keys(o.phys).map(function (k) { return k + ' ' + o.phys[k]; });
        if (kv.length) phys = '<div class="bs">物理量：' + esc(kv.join(' · ')) + '</div>';
      }
      return '<div class="rc" data-i="' + i + '" style="border-left-color:' + (TCOL[o.name] || '#3FA6CC') + '">' +
        '<div class="h">' +
          '<span class="ty">' + esc(o.name) + (o.sub ? '<i>' + esc(o.sub) + '</i>' : '') + '</span>' +
          '<span class="bd" style="color:' + lc + '">' + esc(o.lvText) + '</span>' +
          '<span class="cf">' + Math.round(o.conf * 100) + '%</span>' +
        '</div>' +
        '<div class="po">' + esc(o.chainage) + ' · ' + esc(o.sector) + esc(geo) + '</div>' +
        (o.basis.length ? '<div class="bs">判定依据：' + o.basis.map(esc).join('；') + '</div>' : '') +
        phys +
        (o.sug.length
          ? '<ul class="sg">' + o.sug.map(function (s) { return '<li>' + esc(s) + '</li>'; }).join('') + '</ul>' : '') +
      '</div>';
    }).join('');

    /* 结果卡 ↔ 画面检测框联动：悬停哪一条，画布上哪一只框加粗、其余压暗；
       点击结果卡 → 询问是否跳转知识图谱学习该病害（感知 → 知识推理学习闭环） */
    $$('.rc', elList).forEach(function (card) {
      card.addEventListener('pointerenter', function () { S.hot = +card.dataset.i; draw(); });
      card.addEventListener('pointerleave', function () { if (S.hot === +card.dataset.i) { S.hot = -1; draw(); } });
      card.addEventListener('click', function () {
        var d = dets[+card.dataset.i];
        if (d) askKgLearn(d);
      });
    });
  }

  /* 点击检出卡 → 自绘确认浮层（沙箱 iframe 无原生 confirm 的可靠替代） */
  function askKgLearn(d) {
    var o = norm(d);
    $('#kgaTitle').textContent = '检出：' + o.name + (o.sub ? ' · ' + o.sub : '') +
      ' · ' + o.lvText + '（置信 ' + Math.round(o.conf * 100) + '%）';
    $('#kgAsk')._ctx = o;                             // 完整实例对象：跳转后做精确知识对应
    var m = $('#kgAsk');
    m.classList.add('is-open');
    m.setAttribute('aria-hidden', 'false');
  }
  function closeKgAsk() {
    var m = $('#kgAsk');
    m.classList.remove('is-open');
    m.setAttribute('aria-hidden', 'true');
  }

  /* ------------------------ 中间产物条 ------------------------ */
  function renderSteps() {
    var items = [];
    if (S.steps) {
      [['clahe', '① CLAHE 增强'], ['gaussian', '② 高斯滤波'], ['canny', '③ Canny 边缘'], ['otsu', '④ Otsu 分割']]
        .forEach(function (p) {
          var s = S.steps[p[0]];
          if (s && s.dataUrl) items.push({ img: s.dataUrl, cap: p[1], cached: s.cached });
        });
    }
    if (S.mask && S.mask.dataUrl) items.push({ img: S.mask.dataUrl, cap: '实例掩码', cached: null });
    elSteps.innerHTML = items.map(function (it) {
      return '<figure class="step"><img src="' + it.img + '" alt="' + esc(it.cap) + ' 中间产物">' +
        '<figcaption class="cap">' + it.cap + (it.cached === false ? ' · 本次重算' : '') + '</figcaption></figure>';
    }).join('');
  }

  /* 两张热力图都先预载进 Image 再画：否则每次重绘都要等异步加载，画面会闪 */
  function preloadHeat() {
    S.heatImg = {};
    if (!S.heat) return;
    ['color', 'overlay'].forEach(function (k) {
      var src = S.heat[k] && S.heat[k].dataUrl;
      if (!src) return;
      var im = new Image();
      im.onload = function () { S.heatImg[k] = im; draw(); };
      im.src = src;
    });
  }

  /* ---------------------------- 照片流 ---------------------------- */
  function loadPhoto(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('image/') !== 0) { stat('不是图片文件：' + file.name); return; }
    stopVideo();
    stat('正在解码 ' + file.name + ' …');
    var url = URL.createObjectURL(file);
    var img = new Image();
    img.onload = function () {
      /* 后端只收 PNG，所以先在浏览器里把 JPG 等格式转成 PNG 再传 */
      var c = document.createElement('canvas');
      c.width = img.naturalWidth; c.height = img.naturalHeight;
      c.getContext('2d').drawImage(img, 0, 0);
      S.src = img;
      S.png = c.toDataURL('image/png');
      S.W = img.naturalWidth; S.H = img.naturalHeight;
      S.dets = []; S.heat = null; S.heatImg = {}; S.steps = null; S.mask = null;
      elList.innerHTML = '<div class="lab-none">推理中…</div>';
      elCount.textContent = '0 处';
      draw();
      stat('已载入 ' + file.name + ' · ' + img.naturalWidth + '×' + img.naturalHeight + ' · 推理中…');
      URL.revokeObjectURL(url);
      runDetect(true);            // true = 同时把热力图与四步中间图一并算出来
    };
    img.onerror = function () { stat('图片解码失败：' + file.name); URL.revokeObjectURL(url); };
    img.src = url;
  }

  /* ---------------------------- 检测 ---------------------------- */
  function runDetect(withHeat) {
    if (!S.png) { stat('请先载入照片或视频'); return Promise.resolve(); }
    if (S.busy) return Promise.resolve();
    S.busy = true;
    setBtns(true);
    return post('/api/detect/image', {
      image: { dataUrl: S.png },
      tunnel: '青云山隧道', mileage: 1200, speed: 4.5, source: '工作台',
      archive: !!S.archive,                              // 默认 false：不污染演示台账
      params: { confidenceThreshold: S.threshold }
    }).then(function (j) {
      S.taskId = j.taskId;
      S.elapsedMs = j.elapsedMs;
      S.dets = j.detections || [];
      /* 分析尺寸以后端为准：热力图、四步图、检测框都在这个尺度上；
         拿原始尺寸去画会和热力图错位，这是最容易踩的一处。 */
      if (j.input && j.input.widthPx) { S.W = j.input.widthPx; S.H = j.input.heightPx; }
      var mi = (j.intermediates || []).filter(function (it) { return it.key === 'mask' && it.dataUrl; })[0];
      S.mask = mi || null;
      /* 掩码 Image 预加载：圆钮开启时可直接叠加（新检测结果到达后自动换图并重绘） */
      S.maskImg = null;
      if (S.mask && S.mask.dataUrl) {
        var miImg = new Image();
        miImg.onload = function () { if (S.maskOn) draw(); };
        miImg.src = S.mask.dataUrl;
        S.maskImg = miImg;
      }
      renderCards(); draw();
      stat('后端 ' + Math.round(j.elapsedMs) + 'ms · ' + S.W + '×' + S.H +
        ' · 检出 ' + S.dets.length + ' 处 · 阈值 ' + (j.params ? j.params.confidenceThreshold : S.threshold) +
        (S.archive ? ' · 已写入台账' : ' · 未写台账'));
      if (withHeat) return runHeat();
      renderSteps();
    }).catch(function (e) {
      var msg = e.message || String(e);
      stat('检测失败：' + msg);
      elList.innerHTML = '<div class="lab-none">检测失败：' + esc(msg) +
        '<br>若提示连接失败，说明后端没在跑：项目根目录执行 node backend/server.js</div>';
    }).then(function () { S.busy = false; setBtns(false); });
  }

  /* 热力图 + 四步中间图（模块一教学链路的同一套接口） */
  function runHeat() {
    if (!S.png) { stat('请先载入画面'); return Promise.resolve(); }
    stat('正在计算热力图与四步中间图…');
    return post('/api/explain/detect', {
      image: { dataUrl: S.png }, tunnel: '青云山隧道', mileage: 1200,
      heatmapMethod: S.method
    }).then(function (j) {
      S.heat = j.heatmap;
      S.steps = j.steps;
      if (j.meta && j.meta.widthPx) { S.W = j.meta.widthPx; S.H = j.meta.heightPx; }
      preloadHeat();
      renderSteps();
      draw();
      var m = S.heat || {};
      stat('热力图 ' + (m.method === 'gradcam' ? 'Grad-CAM' : 'Eigen-CAM') + ' · α=' + m.alpha +
        (m.fallbackReason ? ' · 已回退（' + m.fallbackReason + '）' : '') + ' · ' + Math.round(j.elapsedMs) + 'ms');
    }).catch(function (e) { stat('热力图失败：' + (e.message || e)); });
  }

  /* ---------------------------- 视频流 ---------------------------- */
  /* 统一挂载入口：把任意视频源挂到 <video> 上并开始取帧。
     src   —— blob:（本机文件）或 http(s)/相对路径（链接）
     isLocal=true 表示 src 是 objectURL，换源时要 revoke 掉，否则内存会漏 */
  function attachVideo(src, label, isLocal) {
    stopVideo();
    S.src = null; S.png = null; S.dets = []; S.heat = null; S.heatImg = {}; S.steps = null;
    if (elVideo._url) { URL.revokeObjectURL(elVideo._url); elVideo._url = null; }
    if (isLocal) elVideo._url = src;
    /* crossOrigin 必须在 src 之前设。跨域链接若源站不回 CORS 头，浏览器会把
       画布判为「已污染」，取帧的 toDataURL 直接抛 SecurityError ——
       这里先按最宽松的方式要一次，真被拦了在 sampleFrame 里降级提示。 */
    elVideo.crossOrigin = 'anonymous';
    elVideo.removeAttribute('src');
    elVideo.src = src;
    elVideo.loop = true;
    elVideo.muted = true;
    /* 提示行的文案由调用方负责（本地文件→复位、直链→「正在连接」、在线导入→结果），
       这里不再动它，否则刚写好的状态会被挂载动作冲掉。 */
    stat('视频接入中：' + label);
    var p = elVideo.play();
    (p && p.then ? p : Promise.resolve()).then(function () {
      S.frames = 0; S.hits = 0;
      S.vtimer = setInterval(sampleFrame, 900);
      sampleFrame();
    }).catch(function (e) {
      stat('视频无法播放：' + (e.message || e) + '（可点投放区旁的「载入」重试）');
    });
  }

  function loadVideo(file) {
    if (!file) return;
    if (file.type && file.type.indexOf('video/') !== 0) { stat('不是视频文件：' + file.name); return; }
    setUrlHint('', false);
    attachVideo(URL.createObjectURL(file), file.name, true);
  }

  /* 链接载入：同一个输入框，两种来源自动分流 ——
     ① B站链接 / BV 号：交给后端 /api/import/video 解析直链并落地成本地同源文件。
        不能直接把 B站页面地址塞给 <video>：那是网页不是媒体流，且跨域 iframe 的
        画面受同源策略保护，canvas 抽不了帧。后端注释里也是这么写的。
     ② 其余：当 mp4/webm 直链或同源路径直接挂载。 */
  function loadVideoUrl(raw) {
    var u = String(raw || '').trim();
    if (!u) { stat('请先粘贴视频链接'); elUrlIn.focus(); return; }
    /* 分流靠「像不像媒体文件」而不是「有没有 BV 字样」：后者会误伤
       /media/BVxxxxxxxxxx.mp4 这类路径（BV 号恰好嵌在文件名里）。 */
    var hasExt = /\.(mp4|webm|ogv|ogg|mov|m4v)([?#]|$)/i.test(u);
    var looksBili = /bilibili\.com|b23\.tv/i.test(u) || /BV[0-9A-Za-z]{10}/.test(u);
    if (!hasExt && looksBili) return importOnline(u);
    if (!/^(https?:|blob:|data:|\/|\.\/|\.\.\/)/i.test(u)) u = 'https://' + u;
    elUrlIn.value = u;
    setUrlHint('正在连接 ' + u, false);
    attachVideo(u, u, false);
  }

  /* 在线视频导入：后端下载要几秒到几十秒，按钮期间锁住并把状态说清楚 */
  function importOnline(u) {
    elUrlIn.value = u;
    setUrlLoad(true);
    setUrlHint('后端正在解析并下载该视频，大文件请稍候…', false);
    stat('在线视频导入中：' + u);
    return post('/api/import/video', { url: u }).then(function (j) {
      if (!j || !j.localUrl) throw new Error('后端未返回本地地址');
      var src = /^https?:/i.test(j.localUrl) ? j.localUrl : API + j.localUrl;
      var t = String(j.title || '在线视频');
      if (t.length > 24) t = t.slice(0, 24) + '…';     // B站标题常年超长，一行放不下
      setUrlHint('已导入《' + t + '》' +
        (j.durationSec ? ' · ' + j.durationSec + 's' : '') +
        (j.sizeKB ? ' · ' + j.sizeKB + 'KB' : '') + '，开始逐帧分析', false);
      attachVideo(src, '在线导入 · ' + t, false);
    }).catch(function (e) {
      setUrlHint('导入失败：' + (e.message || e) + '（需要外网可达；部分视频需登录权限）', true);
      stat('在线视频导入失败');
      return Promise.reject(e);
    }).then(function () { setUrlLoad(false); }, function () { setUrlLoad(false); });
  }

  function setUrlLoad(on) {
    if (!elUrlGo) return;
    elUrlGo.disabled = !!on;
    elUrlGo.textContent = on ? '导入中' : '载入';
  }

  function connectLive() {
    if (S.liveTimer) { stopVideo(); stat('实时端口已断开'); return; }
    stopVideo();
    S.liveSeq = 0; S.frames = 0; S.hits = 0;
    elLiveGo.textContent = '断开实时端口';
    setUrlHint('已监听 POST ' + API + '/api/live/frame · streamId=default，等待外部设备推帧…', false);
    stat('实时端口已连接 · 等待第 1 帧');
    S.liveTimer = setInterval(pollLiveFrame, 350);
    pollLiveFrame();
  }

  function pollLiveFrame() {
    if (S.busy) return;
    fetch(API + '/api/live/frame?streamId=default&after=' + S.liveSeq, { cache: 'no-store' })
      .then(function (r) { if (r.status === 204) return null; if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then(function (f) {
        if (!f || !f.dataUrl || f.seq <= S.liveSeq) return;
        S.liveSeq = f.seq;
        var im = new Image();
        im.onload = function () {
          var sc = Math.min(1, 480 / im.naturalWidth), c = document.createElement('canvas');
          c.width = Math.max(1, Math.round(im.naturalWidth * sc));
          c.height = Math.max(1, Math.round(im.naturalHeight * sc));
          c.getContext('2d').drawImage(im, 0, 0, c.width, c.height);
          S.src = c; S.png = c.toDataURL('image/png'); S.W = c.width; S.H = c.height;
          S.frames++; draw(); analyzeLiveFrame(f);
        };
        im.src = f.dataUrl;
      }).catch(function (e) { stat('实时端口读取失败：' + (e.message || e)); });
  }

  function analyzeLiveFrame(f) {
    if (S.busy || !S.png) return;
    S.busy = true;
    post('/api/detect/image', { image: { dataUrl: S.png }, tunnel: '实时视频流', source: '实时接入端口',
      captureTime: f.capturedAt, archive: !!S.archive, params: { confidenceThreshold: S.threshold } })
      .then(function (j) {
        S.dets = j.detections || []; if (S.dets.length) S.hits += S.dets.length;
        renderCards(); draw(); renderSteps();
        stat('实时端口 · 第 ' + S.frames + ' 帧 · 本帧 ' + S.dets.length + ' 处 · 累计 ' + S.hits +
          ' 处 · ' + Math.round(j.elapsedMs) + 'ms');
      }).catch(function (e) { stat('实时帧分析失败：' + (e.message || e)); })
      .then(function () { S.busy = false; });
  }

  /* 链接行下方的一句话提示：正常是灰的，出问题转琥珀色（全站唯一的警告色） */
  function setUrlHint(text, warn) {
    if (!elUrlHint) return;
    if (!text) {
      elUrlHint.textContent = '实时端口：POST /api/live/frame（streamId=default，PNG/JPEG dataUrl）；也支持 mp4/webm 或 B站链接';
      elUrlHint.classList.remove('warn');
      return;
    }
    elUrlHint.textContent = text;
    elUrlHint.classList.toggle('warn', !!warn);
  }

  /* 采样一帧送检。显示的是「被分析的那一帧」而不是实时画面 ——
     这样框和画面严格同一个瞬间，不会有肉眼可见的拖影。 */
  function sampleFrame() {
    if (!elVideo.videoWidth) return;
    if (S.busy) return;                        // 上一帧还没回来，跳过这一拍
    var maxW = 480;
    var sc = Math.min(1, maxW / elVideo.videoWidth);
    var w = Math.max(1, Math.round(elVideo.videoWidth * sc));
    var h = Math.max(1, Math.round(elVideo.videoHeight * sc));
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    c.getContext('2d').drawImage(elVideo, 0, 0, w, h);
    try {
      S.png = c.toDataURL('image/png');
    } catch (err) {
      /* 画布被跨域视频污染：读不到像素，检测链路从这里就断了，早点说清楚 */
      stopVideo();
      setUrlHint('该链接未开放跨域读取（CORS），浏览器禁止取帧。请下载到本地后上传，或换同源/允许 CORS 的地址。', true);
      stat('取帧被拦截：视频源不允许跨域读取');
      return;
    }
    S.src = c;
    S.W = w; S.H = h;
    S.heat = null; S.heatImg = {}; S.steps = null;
    S.frames++;
    S.busy = true;
    post('/api/detect/image', {
      image: { dataUrl: S.png }, tunnel: '青云山隧道', mileage: 1200, source: '视频流',
      archive: !!S.archive, params: { confidenceThreshold: S.threshold }
    }).then(function (j) {
      S.dets = j.detections || [];
      if (S.dets.length) S.hits += S.dets.length;
      if (j.input && j.input.widthPx) { S.W = j.input.widthPx; S.H = j.input.heightPx; }
      renderCards(); draw(); renderSteps();
      stat('已分析 ' + S.frames + ' 帧 · 本帧 ' + S.dets.length + ' 处 · 累计 ' + S.hits +
        ' 处 · 后端 ' + Math.round(j.elapsedMs) + 'ms/帧');
    }).catch(function (e) { stat('帧分析失败：' + (e.message || e)); })
      .then(function () { S.busy = false; });
  }

  function stopVideo() {
    if (S.vtimer) { clearInterval(S.vtimer); S.vtimer = 0; }
    if (S.liveTimer) { clearInterval(S.liveTimer); S.liveTimer = 0; }
    if (elLiveGo) elLiveGo.textContent = '接入实时端口';
    try { elVideo.pause(); } catch (e) { /* 未加载时忽略 */ }
  }

  /* ---------------------------- 控件 ---------------------------- */
  function switchTab(t) {
    if (t === S.tab) return;
    S.tab = t;
    $$('[data-labtab]').forEach(function (x) {
      var on = x.dataset.labtab === t;
      x.classList.toggle('is-on', on);
      x.setAttribute('aria-selected', on ? 'true' : 'false');
    });
    elDrop.hidden = (t !== 'photo');
    elVideoIn.hidden = (t !== 'video');
    if (t === 'photo') { stopVideo(); stat('照片流 · 点击投放区选择照片'); }
    else stat('视频流 · 选本地视频，或粘贴视频链接');
  }

  function setBtns(disabled) {
    ['#labRun', '#labHeat'].forEach(function (s) { var b = $(s); if (b) b.disabled = disabled; });
  }

  function reset() {
    stopVideo();
    S.png = null; S.src = null; S.dets = []; S.heat = null; S.heatImg = {};
    S.steps = null; S.mask = null; S.W = 0; S.H = 0; S.frames = 0; S.hits = 0; S.hot = -1;
    elCanvas.hidden = true; elHint.hidden = false;
    elSteps.innerHTML = '';
    elList.innerHTML = '<div class="lab-none">尚无结果。</div>';
    elCount.textContent = '0 处';
    stat('等待输入…');
  }

  /* 打开工作台时停掉球体的 rAF：推理和 680 点精灵绘制抢同一个主线程，
     后台还满帧画球纯属浪费。关闭时原地恢复，视觉上无感。 */
  function pauseCore(on) {
    if (RM) return;
    if (on) { if (rafId) { cancelAnimationFrame(rafId); rafId = 0; } }
    else if (!rafId) { rafId = requestAnimationFrame(frame); }
  }

  /* ---------------------------- 事件 ---------------------------- */
  function bind() {
    $('#labClose').addEventListener('click', closeLab);
    /* 点遮罩空白处也能关（点内容不关） */
    root.addEventListener('click', function (e) { if (e.target === root) closeLab(); });

    $$('[data-labtab]').forEach(function (b) {
      b.addEventListener('click', function () { switchTab(b.dataset.labtab); });
    });

    /* 投放区：点击 / 键盘 / 拖拽，三种都通 */
    elDrop.addEventListener('click', function () { elFile.click(); });
    elDrop.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elFile.click(); }
    });
    elFile.addEventListener('change', function () { if (elFile.files[0]) loadPhoto(elFile.files[0]); });
    elDropV.addEventListener('click', function () { elFileV.click(); });
    elDropV.addEventListener('keydown', function (e) {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); elFileV.click(); }
    });
    elFileV.addEventListener('change', function () { if (elFileV.files[0]) loadVideo(elFileV.files[0]); });

    /* 视频链接：点「载入」或直接回车都通 */
    elUrlGo.addEventListener('click', function () { loadVideoUrl(elUrlIn.value); });
    elLiveGo.addEventListener('click', connectLive);
    elUrlIn.addEventListener('keydown', function (e) {
      if (e.key === 'Enter') { e.preventDefault(); loadVideoUrl(elUrlIn.value); }
    });

    /* 地址打不开时（404 / 鉴权 / HLS 分片）给一句能自救的说明，
       别让用户对着不动的画面猜 */
    elVideo.addEventListener('error', function () {
      /* 用 src 属性判断而不是 currentSrc：资源加载失败时 currentSrc 会被清空，
         拿它当门禁等于把真正要报的错挡在门外。 */
      if (!elVideo.getAttribute('src')) return;
      setUrlHint('视频加载失败：地址不可达，或不是浏览器能直接播的格式（m3u8/HLS 分片、需鉴权的地址都不支持）。', true);
      stat('视频加载失败：地址不可用或格式不支持');
    });

    [elDrop, elDropV].forEach(function (z) {
      z.addEventListener('dragover', function (e) { e.preventDefault(); z.classList.add('drag'); });
      z.addEventListener('dragleave', function () { z.classList.remove('drag'); });
      z.addEventListener('drop', function (e) {
        e.preventDefault(); z.classList.remove('drag');
        var f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
        if (!f) return;
        if (f.type.indexOf('video/') === 0) { switchTab('video'); loadVideo(f); }
        else if (f.type.indexOf('image/') === 0) { switchTab('photo'); loadPhoto(f); }
        else stat('不支持的文件类型：' + (f.type || '未知'));
      });
    });

    /* 视图切换 */
    $$('#labSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        S.view = b.dataset.view;
        $$('#labSeg button').forEach(function (x) { x.classList.toggle('is-on', x === b); });
        if (S.view !== 'boxes' && !S.heat) stat('这一帧还没算热力图 · 点右侧「重算热力图」');
        draw();
      });
    });

    /* 参数：改阈值 → 重跑检测（带防抖）；改透明度 → 只重绘，不重新推理 */
    elThr.addEventListener('input', function () {
      S.threshold = elThr.value / 100;
      elThrV.textContent = S.threshold.toFixed(2);
      clearTimeout(S.timers.thr);
      S.timers.thr = setTimeout(function () { if (S.png) runDetect(false); }, 420);
    });
    elAlpha.addEventListener('input', function () {
      S.alpha = elAlpha.value / 100;
      elAlphaV.textContent = S.alpha.toFixed(2);
      draw();
    });
    elMethod.addEventListener('change', function () {
      S.method = elMethod.value;
      if (S.png) runHeat();
    });
    elArc.addEventListener('change', function () {
      S.archive = elArc.checked;
      elArcTxt.textContent = S.archive ? '开启 · 会写入台账' : '关闭 · 不落库';
    });

    $('#labRun').addEventListener('click', function () {
      if (S.tab === 'video') { if (elVideo.videoWidth) sampleFrame(); else stat('请先选择视频'); }
      else runDetect(true);
    });
    $('#labHeat').addEventListener('click', function () {
      if (!S.png) { stat('请先载入画面'); return; }
      runHeat();
    });
    $('#labClear').addEventListener('click', reset);

    /* Ctrl+V 粘贴图片直接检测 */
    document.addEventListener('paste', function (e) {
      if (!root.classList.contains('is-open')) return;
      var items = (e.clipboardData && e.clipboardData.items) || [];
      for (var i = 0; i < items.length; i++) {
        if (items[i].type && items[i].type.indexOf('image') === 0) {
          var f = items[i].getAsFile();
          if (f) { switchTab('photo'); loadPhoto(f); }
          return;
        }
      }
    });

    /* 窗口尺寸变了要重算画面缩放（fitStage 在 draw 里） */
    window.addEventListener('resize', function () {
      if (root.classList.contains('is-open') && S.W) draw();
    });

    /* L 打开 / Esc 关闭 */
    document.addEventListener('keydown', function (e) {
      if (root.classList.contains('is-open')) {
        if (e.key === 'Escape') { closeLab(); }
        return;                                   // 打开时不再响应 L，避免和输入打架
