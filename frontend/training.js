/* 模块二「虚实结合实训台」— 前端逻辑（原生 JS，独立于 app.js/explain.js）
 *
 * 功能：
 *   A. 参数探究实训会话
 *      1) 开始会话（可上传样本图；否则内置合成演示样本）→ 记录初始参数快照
 *      2) 5 滑杆（置信度/CLAHE clip/网格/高斯/Canny）拖动 → debounce 300ms →
 *         POST /api/experiment/run（写 experiment_log + 返回缩略图/检出/均置信度/耗时）
 *      3) 操作轨迹可点击回放（把 log.params 快照载回滑杆并复现运行）
 *      4) 结束会话 + 生成 PDF 实验报告（会话信息/轨迹表/参数-检出对照/自评/教师评语留白）
 *   B. 病害样本合成器
 *      1) 内置演示缺陷池 / 标注素材(YOLO框)裁剪粘贴 两种模式
 *      2) 批量 ≥20 张 → POST /api/sample/synthesize → 文件+DB(source=synthetic)一致
 *      3) 合成样本库分页浏览 GET /api/sample/library（图片 /synthetic/xx.jpg 静态托管）
 *   合规：所有合成样本显著标注「仅用于实训演示与数据增强，不得与科研实测数据混用」
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));

  const TYPE_COLORS = {
// 浅底协调版 — 与 app.js TYPE_COLORS 对齐
  '裂缝': '#96700F', '渗漏水': '#256E9F', '剥落掉块': '#c0392b',
  '衬砌错台': '#8e44ad', '白华析出': '#0E7A66',
  };
  const LV_CLASS = { 1: 'lv1', 2: 'lv2', 3: 'lv3', 4: 'lv4' };
  const LV_TEXT = { 1: '轻微', 2: '中等', 3: '严重', 4: '危及安全' };

  const S = { sid: null, session: null, ended: true, logs: [], busy: false, pendingRun: false, curLogId: null };
  const SYN = { sources: [], page: 1, size: 18 };

  /* ================= 页面开关（与模块一互斥） ================= */
  function setTrainVisible(on) {
    if (on) { // 打开实训台：隐藏其它模块页并复位其顶栏按钮
      const tp = $('teachPage');
      if (tp) tp.style.display = 'none';
      $('btnTeach').textContent = '教学展示 · 模块一';
      ['__setTeachVisible', '__setPortalVisible'].forEach((k) => {
        if (typeof window[k] === 'function') window[k](false);
      });
    }
    $('trainPage').style.display = on ? '' : 'none';
    document.querySelectorAll('main.grid, section.kpis').forEach((el) => { el.style.display = on ? 'none' : ''; });
    $('btnTrain').textContent = on ? '返回监控台' : '虚实实训 · 模块二';
    if (!on) $('btnTrain').blur();
  }
  window.__setTrainVisible = setTrainVisible; // explain.js 打开模块一时调用本函数实现互斥
  $('btnTrain').addEventListener('click', () => setTrainVisible($('trainPage').style.display === 'none'));
  $('btnTrainBack').addEventListener('click', () => setTrainVisible(false));

  /* ================= 图片文件 → PNG dataUrl（Canvas 转码） ================= */
  function fileToPngDataUrl(file, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, maxDim / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * sc));
        cv.height = Math.max(1, Math.round(img.height * sc));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve({ dataUrl: cv.toDataURL('image/png'), width: cv.width, height: cv.height });
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = URL.createObjectURL(file);
    });
  }
  const readJSON = async (r) => { const t = await r.json().catch(() => ({})); if (!r.ok) throw new Error(t.error || r.statusText); return t; };

  /* ================= A. 实训会话 ================= */
  const SLIDER_IDS = [['qConf', 'vTConf'], ['qClip', 'vTClip'], ['qTile', 'vTTile'], ['qKernel', 'vTKernel'], ['qCanny', 'vTCanny']];
  function readParams() {
    return {
      confidenceThreshold: parseFloat($('qConf').value),
      claheClipLimit: parseFloat($('qClip').value),
      claheTileGridSize: parseInt($('qTile').value, 10),
      gaussianKernelSize: parseInt($('qKernel').value, 10),
      cannyThreshold: parseInt($('qCanny').value, 10),
    };
  }
  function syncSliders(p) {
    if (!p) return;
    $('qConf').value = p.confidenceThreshold; $('vTConf').textContent = p.confidenceThreshold;
    $('qClip').value = p.claheClipLimit; $('vTClip').textContent = Number(p.claheClipLimit).toFixed(1);
    $('qTile').value = p.claheTileGridSize; $('vTTile').textContent = p.claheTileGridSize + '×' + p.claheTileGridSize;
    $('qKernel').value = p.gaussianKernelSize; $('vTKernel').textContent = p.gaussianKernelSize + '×' + p.gaussianKernelSize;
    $('qCanny').value = p.cannyThreshold; $('vTCanny').textContent = p.cannyThreshold;
  }
  const setEnabled = (on) => {
    SLIDER_IDS.forEach(([id]) => { $(id).disabled = !on; });
    $('btnTrEnd').disabled = !on;
    $('btnTrStart').disabled = on || !S.ended;   // 未结束不允许开新会话
    $('trStudent').disabled = !S.ended;
  };
  function setSessionBadge(state) {
    const el = $('trSessionState');
    el.textContent = state.text;
    el.className = 'badge ' + (state.cls || 'st-wait');
  }

  async function startSession() {
    if (!S.ended) return;
    setSessionBadge({ text: '创建会话中…', cls: 'st-wait' });
    const body = {
      user_name: $('trStudent').value.trim() || '学生',
      tunnel: $('trTunnelName').value.trim() || '实训隧道',
    };
    const f = $('trSampleInput').files[0];
    if (f) {
      try { body.image = await fileToPngDataUrl(f, 640); }
      catch (e) { alert('样本图解析失败：' + e.message); return; }
    }
    try {
      const r = await fetch(API + '/api/experiment/session', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const c = await readJSON(r);
      S.sid = c.session_id; S.session = c; S.ended = false; S.curLogId = null;
      S.logs = [];
      $('trTimeline').innerHTML = '';
      $('trByClass').innerHTML = ''; $('trThumb').style.display = 'none';
      syncSliders(c.params_snapshot);
      $('trMeta').textContent =
        `会话编号 EXP-${String(S.sid).padStart(6, '0')} · 隧道 ${c.tunnel} · 样本 ${c.image.width}×${c.image.height}` +
        (c.image.synthetic ? '（内置演示样本为合成样本，仅实训用）' : '（学生上传）');
      setSessionBadge({ text: '进行中', cls: 'st-ok' });
      setEnabled(true);
      $('trReportHint').textContent = '报告内容：会话信息 · 初始参数快照 · 操作轨迹表 · 参数-检出数量对照条形图 · 学生自评 · 教师评语留白。';
      $('trRunNote').textContent = '会话已创建（初始参数快照已记录）。拖动任一滑杆（300ms 防抖）开始探究…';
      await runExperiment(); // 立即以初始快照跑一次，给出第一帧结果
      refreshTimeline();
    } catch (e) {
      setSessionBadge({ text: '未开始', cls: 'st-wait' });
      alert('创建会话失败：' + e.message);
    }
  }

  /** 执行一次参数探究运行（写 experiment_log） */
  async function runExperiment(opts = {}) {
    if (!S.sid || S.ended) return;
    if (S.busy) { S.pendingRun = true; return; }
    S.busy = true;
    $('trRunNote').textContent = '推理中…';
    try {
      const r = await fetch(API + '/api/experiment/run', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ session_id: S.sid, params: readParams(), action: 'detect' }),
      });
      const b = await readJSON(r);
      applyRunResult(b, opts.replay);
      $('trRunNote').textContent = opts.replay
        ? `已回放 #${b.log_id} 参数并复现运行（${b.result.elapsedMs}ms）`
        : `运行 #${b.log_id} 完成（防抖 300ms，端到端 ${b.result.elapsedTotalMs}ms）`;
    } catch (e) {
      $('trRunNote').textContent = '运行失败：' + e.message;
    } finally {
      S.busy = false;
      if (S.pendingRun) { S.pendingRun = false; return runExperiment(); }
    }
  }

  function applyRunResult(b, replay) {
    S.curLogId = b.log_id;
    $('trCount').textContent = b.result.detectionCount;
    $('trAvg').textContent = (b.result.avgConfidence || 0).toFixed(3);
    $('trMs').textContent = b.result.elapsedMs;
    $('trTask').textContent = b.result.taskId;
    const img = $('trThumb');
    if (b.result.thumbnail) { img.src = b.result.thumbnail; img.style.display = ''; }
    const bc = b.result.byClass || {};
    const chips = Object.entries(bc).map(([k, v]) => `<span class="chip" style="color:${TYPE_COLORS[k] || '#fff'}">● ${esc(k)} × ${v}</span>`).join('');
    $('trByClass').innerHTML = chips ? '按类别：' + chips : '未检出病害';
    $('trSessionState').textContent = '进行中';
    $('btnTrainReport').disabled = false;
    refreshTimeline();
  }

  /** 拉取操作轨迹并渲染（点击行 = 回放参数快照） */
  async function refreshTimeline() {
    if (!S.sid) return;
    try {
      const r = await fetch(API + '/api/experiment/log/' + S.sid);
      const g = await readJSON(r);
      S.logs = g.logs || [];
      S.session = Object.assign(S.session || {}, g.session || {});
      const ended = !!g.session.end_time;
      const rows = S.logs.slice().reverse().map((l) => {
        const p = l.params || {}, sm = l.summary || {};
        const isCreate = l.action === 'create';
        const pv = isCreate ? '（创建/快照）' : `cf=${p.confidenceThreshold} cl=${p.claheClipLimit} tile=${p.claheTileGridSize}×${p.claheTileGridSize} ks=${p.gaussianKernelSize}×${p.gaussianKernelSize} canny=${p.cannyThreshold}`;
        return `<tr data-logid="${l.log_id}" class="${l.log_id === S.curLogId ? 'cur' : ''}">
          <td>${l.log_id}</td><td class="conf">${esc(l.ts)}</td><td>${isCreate ? '—' : p.confidenceThreshold}</td>
          <td>${isCreate ? '—' : p.claheClipLimit}</td><td>${isCreate ? '—' : (p.claheTileGridSize + '×' + p.claheTileGridSize)}</td>
          <td>${isCreate ? '—' : (p.gaussianKernelSize + '×' + p.gaussianKernelSize)}</td><td>${isCreate ? '—' : p.cannyThreshold}</td>
          <td><b>${isCreate ? '' : sm.detectionCount}</b></td><td>${isCreate ? '' : sm.elapsedMs}</td>
          <td><span class="replay" title="${esc(pv)}">${isCreate ? '快照' : (ended ? '回放' : '回放')}</span></td>
        </tr>`;
      }).join('');
      $('trTimeline').innerHTML = rows || '<tr><td colspan="10" style="color:var(--muted)">暂无操作记录</td></tr>';
      $('trTimeline').onclick = (ev) => {
        const tr = ev.target.closest('tr[data-logid]');
        if (!tr) return;
        const l = S.logs.find((x) => x.log_id === Number(tr.dataset.logid));
        if (!l) return;
        replayLog(l);
      };
    } catch (e) { /* 忽略 */ }
  }

  /** 回放一条快照：把 log.params 载入滑杆并复现一次运行 */
  function replayLog(l) {
    if (l.action === 'create') return;               // 创建快照本身不是运行
    if ($('btnTrEnd').disabled === false) {
      syncSliders(l.params || {});
      $('trRunNote').textContent = '回放 #' + l.log_id + '：参数已载入滑杆，正在复现…';
      runExperiment({ replay: true });
    } else {
      alert('会话已结束，请重新开始会话后再回放。');
    }
  }

  async function endSession() {
    if (!S.sid || S.ended) return;
    try {
      const r = await fetch(API + '/api/experiment/close/' + S.sid, { method: 'POST' });
      const g = await readJSON(r);
      S.ended = true;
      setSessionBadge({ text: '已结束', cls: 'st-no' });
      setEnabled(false);
      $('trMeta').textContent = `会话 EXP-${String(S.sid).padStart(6, '0')} 已结束（${g.session.end_time}）。可生成实验报告 PDF，或点击“开始会话”开启新实训。`;
      $('trRunNote').textContent = `共运行 ${g.stats.runs} 次 · 累计检出 ${g.stats.totalDetections} 处 · 平均推理 ${g.stats.avgElapsedMs} ms`;
      refreshTimeline();
    } catch (e) {
      alert('结束会话失败：' + e.message);
    }
  }

  /** 生成并下载实验报告 PDF */
  async function generateReport() {
    if (!S.sid) return;
    $('btnTrainReport').textContent = '生成中…';
    try {
      const r = await fetch(API + '/api/experiment/report/' + S.sid, {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          student_name: ($('trStudent').value.trim() || (S.session && S.session.user_name) || '学生'),
          self_eval: $('trSelfEval').value.trim(),
        }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || r.statusText); }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `实验报告-EXP-${String(S.sid).padStart(6, '0')}.pdf`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
      $('trReportHint').textContent = '✓ 实验报告已下载（含会话信息/操作轨迹表/参数-检出对照/自评/教师评语留白）。';
    } catch (e) {
      $('trReportHint').textContent = '报告生成失败：' + e.message;
    } finally {
      $('btnTrainReport').textContent = '⬇ 生成实验报告 PDF';
    }
  }

  /* ---- 滑杆联动（debounce 300ms） ---- */
  let sliderTimer = null;
  SLIDER_IDS.forEach(([id, vid], i) => {
    $(id).addEventListener('input', () => {
      const v = $(id).value;
      const labels = [null, (x) => Number(x).toFixed(1), (x) => x + '×' + x, (x) => x + '×' + x, null];
      $(vid).textContent = labels[i] ? labels[i](v) : v;
      if (!S.sid) return;                     // 未开始会话仅展示数值
      clearTimeout(sliderTimer);
      sliderTimer = setTimeout(() => runExperiment(), 300);
    });
  });
  $('btnTrStart').addEventListener('click', startSession);
  $('btnTrEnd').addEventListener('click', endSession);
  $('btnTrainReport').addEventListener('click', generateReport);
  $('trSampleInput').addEventListener('change', () => {
    const f = $('trSampleInput').files[0];
    if (f) $('trMeta').textContent = '已选择样本图：' + f.name + '（开始会话时将自动转码为 ≤640 PNG）';
  });

  /* ================= B. 病害样本合成器 ================= */
  /* ---- 素材模式切换 ---- */
  document.querySelectorAll('[data-synmode]').forEach((btn) => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('[data-synmode]').forEach((b) => b.classList.remove('active'));
      btn.classList.add('active');
      const mode = btn.dataset.synmode;
      $('synDemoMode').style.display = mode === 'demo' ? '' : 'none';
      $('synCropMode').style.display = mode === 'crop' ? '' : 'none';
    });
  });

  /* ---- 标注素材：上传 + 裁剪框 + 加入来源 ---- */
  let srcImgDims = null;
  $('synSrcInput').addEventListener('change', async () => {
    const f = $('synSrcInput').files[0];
    if (!f) return;
    try {
      const d = await fileToPngDataUrl(f, 1200);
      srcImgDims = d;
      $('synSrcInfo').textContent = f.name + `（${d.width}×${d.height}）`;
      $('synSrcPrev').src = d.dataUrl;
      $('synCropEditor').style.display = '';
    } catch (e) { alert('素材解析失败：' + e.message); }
  });
  $('btnSynAddSrc').addEventListener('click', () => {
    if (!srcImgDims) { alert('请先上传病害素材原图'); return; }
    const pct = [parseFloat($('bbX').value) || 0, parseFloat($('bbY').value) || 0,
      Math.min(100, Math.max(1, parseFloat($('bbW').value) || 100)), Math.min(100, Math.max(1, parseFloat($('bbH').value) || 100))];
    const src = {
      id: Date.now(),
      dataUrl: srcImgDims.dataUrl, W: srcImgDims.width, H: srcImgDims.height,
      pct, cls: $('synCropClass').value, lv: Number($('synCropLevel').value),
    };
    SYN.sources.push(src);
    renderSources();
  });
  function renderSources() {
    $('synSources').innerHTML = SYN.sources.map((s) => `
      <div class="syn-src-item">
        <img src="${s.dataUrl}" alt="素材">
        <span><b>${esc(s.cls)}</b> · ${LV_TEXT[s.lv]}级（Lv${s.lv}） · 裁剪框 ${s.pct.map((v) => Math.round(v)).join('/')}%  → 像素 ${Math.round(s.pct[0] / 100 * s.W)}×${Math.round(s.pct[1] / 100 * s.H)}（${Math.round(s.pct[2] / 100 * s.W)}×${Math.round(s.pct[3] / 100 * s.H)}px）</span>
        <button class="rm" data-id="${s.id}">✕ 移除</button>
      </div>`).join('') || '<div class="teach-note">尚未添加病害来源：上传原图 → 设定类别/等级/裁剪框 → 点击“加入病害来源”。</div>';
    $('synSources').querySelectorAll('.rm').forEach((btn) => {
      btn.addEventListener('click', () => {
        SYN.sources = SYN.sources.filter((s) => s.id !== Number(btn.dataset.id));
        renderSources();
      });
    });
  }

  /* ---- 批量合成 ---- */
  let synRunning = false;
  $('btnSynRun').addEventListener('click', async () => {
    if (synRunning) return;
    const mode = document.querySelector('[data-synmode].active').dataset.synmode;
    const count = Number($('synCount').value);
    const [ow, oh] = $('synSize').value.split('x').map(Number);
    const body = { count, outWidth: ow, outHeight: oh };
    if (mode === 'demo') {
      const kind = $('synKind').value;
      const lv = Number($('synLevel').value);
      // 素材池里放 8 份同规格演示缺陷（后端每样本随机 1~3 处粘贴）
      body.defects = kind ? Array.from({ length: 8 }, () => ({ class_name: kind, level: lv })) : undefined;
    } else {
      if (!SYN.sources.length) { alert('请先“加入病害来源”（或切换为内置演示池模式）'); return; }
      body.defects = SYN.sources.map((s) => ({
        image: { dataUrl: s.dataUrl },
        bbox: [Math.round(s.pct[0] / 100 * s.W), Math.round(s.pct[1] / 100 * s.H),
          Math.round(s.pct[2] / 100 * s.W), Math.round(s.pct[3] / 100 * s.H)],
        class_name: s.cls, level: s.lv,
      }));
    }
    synRunning = true;
    $('synBusy').textContent = `正在批量合成 ${count} 张（裁剪→羽化→透视/光度扰动→JPEG 落盘→入库）…`;
    try {
      const r = await fetch(API + '/api/sample/synthesize', {
        method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
      });
      const b = await readJSON(r);
      const items = b.generated || [];
      $('synBusy').textContent = '';
      $('synBatch').innerHTML = `
        <div class="syn-batch-head">✓ 已生成 <b>${items.length}</b> 张 · 用时 ${b.batch.elapsedMs}ms · 目录 ${esc(b.batch.dir)} · 文件名 <b>sample_序号_类型_等级.jpg</b></div>
        <div class="syn-grid">${items.map((it) => `
          <div class="syn-card" title="sample_id=${it.sample_id}">
            <img src="${API + '/' + it.file}" alt="${esc(it.name)}" loading="lazy">
            <div class="t"><b>${esc(it.class_name)}</b> Lv${it.level} · #${it.sample_id}<br>${esc(it.name)}</div>
            <div class="s">合成样本</div>
          </div>`).join('')}</div>`;
      SYN.page = 1;
      loadLibrary();
    } catch (e) {
      $('synBusy').textContent = '合成失败：' + e.message;
    } finally {
      synRunning = false;
    }
  });

  /* ---- 合成样本库分页 ---- */
  async function loadLibrary() {
    try {
      const r = await fetch(API + `/api/sample/library?page=${SYN.page}&size=${SYN.size}`);
      const b = await readJSON(r);
      $('libInfo').textContent = `共 ${b.total} 张 · 第 ${b.page}/${b.pages || 1} 页`;
      $('libPrev').disabled = b.page <= 1;
      $('libNext').disabled = b.page >= (b.pages || 1);
      $('libGrid').innerHTML = b.items.map((it) => `
        <div class="lib-card" title="${esc(it.name)} · ${esc(it.marker)}">
          <img src="${API + '/' + it.file}" alt="${esc(it.name)}" loading="lazy">
          <div class="meta"><b>${esc(it.class_name)}</b> Lv${it.level} · #${it.sample_id}<br>${esc(it.name)}
          <span class="s">⚠ 合成样本</span></div>
        </div>`).join('') || '<div class="teach-note">暂无合成样本</div>';
    } catch (e) { $('libGrid').innerHTML = '<div class="teach-note">样本库加载失败：' + esc(e.message) + '</div>'; }
  }
  $('libPrev').addEventListener('click', () => { if (SYN.page > 1) { SYN.page--; loadLibrary(); } });
  $('libNext').addEventListener('click', () => { SYN.page++; loadLibrary(); });

  /* ================= 初始化 ================= */
  renderSources();
  loadLibrary();
})();
