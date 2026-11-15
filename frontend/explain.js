/* 模块一「可解释AI教学展示」— 前端逻辑（独立于 app.js，原生 JS）
 *
 * 双通道对比：
 *   左栏  传统 CV 链路：① CLAHE ② 高斯 ③ Canny ④ Otsu 分步图 + 滑杆调参
 *         （调参 → PUT /api/pipeline/params，服务端只重算受影响步骤，cached 标记沿用缓存）
 *   右栏  检测模型结果：原图/热力图叠加切换 + 检测框 + 类别/等级标注 + 讲解图导出
 * 接口：POST /api/explain/detect · PUT|GET /api/pipeline/params · POST /api/explain/export
 */
(() => {
  const $ = (id) => document.getElementById(id);

  const TYPE_COLORS = {
    // 浅底协调版 — 与 app.js TYPE_COLORS 对齐
    '裂缝': '#96700F', '渗漏水': '#256E9F', '剥落掉块': '#c0392b',
    '衬砌错台': '#8e44ad', '白华析出': '#0E7A66',
  };
  const LV_CLASS = { 1: 'lv1', 2: 'lv2', 3: 'lv3', 4: 'lv4' };

  const state = {
    taskId: null,
    detections: [],
    originalUrl: null,
    overlayUrl: null,
    colorUrl: null,
    busy: false,
  };

  /* ---------------- 页面开关 ---------------- */
  function setTeachVisible(on) {
    // 与其它模块页互斥（模块二/三/四注册了 window.__setXxxVisible）
    if (on) {
      ['__setTrainVisible', '__setPortalVisible'].forEach((k) => {
        if (typeof window[k] === 'function') window[k](false);
      });
    }
    $('teachPage').style.display = on ? '' : 'none';
    document.querySelectorAll('main.grid, section.kpis').forEach((el) => { el.style.display = on ? 'none' : ''; });
    $('btnTeach').textContent = on ? '返回监控台' : '教学展示 · 模块一';
    if (!on) $('btnTeach').blur();
  }
  $('btnTeach').addEventListener('click', () => setTeachVisible($('teachPage').style.display === 'none'));
  $('btnTeachBack').addEventListener('click', () => setTeachVisible(false));
  window.__setTeachVisible = setTeachVisible; // 供模块三（科研数据）打开时互斥关闭本页

  /* ---------------- 上传与全量检测 ---------------- */
  const zone = $('teachZone'), input = $('teachInput');
  zone.addEventListener('click', () => input.click());
  zone.addEventListener('dragover', (e) => { e.preventDefault(); zone.classList.add('drag'); });
  zone.addEventListener('dragleave', () => zone.classList.remove('drag'));
  zone.addEventListener('drop', (e) => {
    e.preventDefault(); zone.classList.remove('drag');
    if (e.dataTransfer.files[0]) runFile(e.dataTransfer.files[0]);
  });
  input.addEventListener('change', () => { if (input.files[0]) runFile(input.files[0]); });

  async function runFile(file) {
    if (state.busy) return;
    state.busy = true;
    $('teachMeta').textContent = `正在解析 ${file.name} 并进行可解释推理…`;
    try {
      const dataUrl = await fileToPngDataUrl(file, 640);
      const r = await fetch(API + '/api/explain/detect', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          image: { dataUrl },
          tunnel: $('tunnelFilter').value,
          heatmapMethod: $('heatMethod').value,
        }),
      });
      const body = await r.json();
      if (!r.ok) throw new Error(body.error || r.statusText);
      applyDetectResult(body);
    } catch (e) {
      $('teachMeta').textContent = '检测失败：' + e.message;
    } finally {
      state.busy = false;
    }
  }

  /** 任意图片文件 → ≤640 边长 PNG dataUrl（Canvas 转码，后端零依赖只收 PNG） */
  function fileToPngDataUrl(file, maxDim) {
    return new Promise((resolve, reject) => {
      const img = new Image();
      img.onload = () => {
        const sc = Math.min(1, maxDim / Math.max(img.width, img.height));
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(img.width * sc));
        cv.height = Math.max(1, Math.round(img.height * sc));
        cv.getContext('2d').drawImage(img, 0, 0, cv.width, cv.height);
        resolve(cv.toDataURL('image/png'));
      };
      img.onerror = () => reject(new Error('图片解码失败'));
      img.src = URL.createObjectURL(file);
    });
  }

  function applyDetectResult(r) {
    state.taskId = r.taskId;
    state.detections = r.detections || [];
    state.originalUrl = r.original && r.original.dataUrl;
    state.overlayUrl = r.heatmap && r.heatmap.overlay && r.heatmap.overlay.dataUrl;
    state.colorUrl = r.heatmap && r.heatmap.color && r.heatmap.color.dataUrl;

    // 左栏：四步图
    for (const k of ['clahe', 'gaussian', 'canny', 'otsu']) {
      const img = $('step' + k[0].toUpperCase() + k.slice(1));
      if (img && r.steps[k] && r.steps[k].dataUrl) img.src = r.steps[k].dataUrl;
      document.querySelectorAll(`i[data-step="${k}"]`).forEach((el) => {
        el.textContent = r.steps[k] && r.steps[k].dataUrl ? (r.steps[k].cached ? '缓存' : '已重算') : '';
      });
    }
    // 滑杆同步为服务端归一化参数
    syncSliders(r.params);

    // 右栏：视图与检测
    $('heatToggle').checked = true;
    renderView();
    renderCards();
    const hm = r.heatmap || {};
    const ov = hm.overlap || {};
    $('teachMeta').innerHTML =
      `任务 <b class="conf">${r.taskId}</b> · 检出 <b>${r.summary.detectionCount}</b> 处 · 热力图 <b>${(hm.method || '').toUpperCase()}</b>` +
      `（目标类：${hm.targetClass || '--'}，框内/框外热强度比 ${ov.ratio || '--'}）` +
      ` · 推理耗时 <b>${r.elapsedMs}ms</b>` +
      (hm.fallbackReason ? `<span class="warn-text">（${hm.fallbackReason}）</span>` : '');
  }

  /* ---------------- 右栏视图：底图切换 + 检测框绘制 ---------------- */
  function renderView() {
    const img = $('viewBase');
    const useHeat = $('heatToggle').checked;
    img.src = (useHeat && state.overlayUrl) ? state.overlayUrl : (state.originalUrl || '');
    const cv = $('viewBoxes');
    img.onload = () => {
      const wrap = $('teachView');
      const maxW = wrap.clientWidth || 640;
      const sc = Math.min(1, maxW / img.naturalWidth);
      const W = Math.round(img.naturalWidth * sc), H = Math.round(img.naturalHeight * sc);
      img.style.width = W + 'px'; img.style.height = H + 'px';
      cv.width = W; cv.height = H;
      cv.style.width = W + 'px'; cv.style.height = H + 'px';
      const ctx = cv.getContext('2d');
      ctx.clearRect(0, 0, W, H);
      state.detections.forEach((d, i) => {
        const [x, y, w, h] = d.bbox;
        const X = x * W, Y = y * H, BW = w * W, BH = h * H;
        const c = TYPE_COLORS[d.class_name] || '#fff';
        ctx.strokeStyle = c; ctx.lineWidth = 2.5;
        ctx.strokeRect(X, Y, BW, BH);
        const label = `${i + 1} ${d.class_name} ${d.level_text} ${Math.round(d.confidence * 100)}%`;
        ctx.font = 'bold 12px "Microsoft YaHei", sans-serif';
        const tw = ctx.measureText(label).width + 10;
        const ly = Y > 22 ? Y - 18 : Y + BH + 4;
        ctx.fillStyle = c; ctx.globalAlpha = 0.92;
        ctx.fillRect(X, ly, tw, 17); ctx.globalAlpha = 1;
        ctx.fillStyle = '#ffffff';
        ctx.fillText(label, X + 5, ly + 13);
      });
    };
    if (img.complete && img.naturalWidth) img.onload();
  }

  function renderCards() {
    $('teachCards').innerHTML = state.detections.map((d, i) => `
      <div class="dcard">
        <div class="dcard-head">
          <span class="dtype" style="color:${TYPE_COLORS[d.class_name] || '#fff'}">● ${i + 1}. ${esc(d.class_name)}<i class="dsub">${esc(d.subtype || '')}</i></span>
          <span class="badge ${LV_CLASS[d.level] || ''}">${esc(d.level_text || '')}</span>
          <span class="dpos">置信度 ${d.confidence.toFixed(2)} · 窄边 ${d.width_mm}mm</span>
        </div>
        ${d.basis && d.basis.length ? `<div class="dbasis">判定依据：${d.basis.map(esc).join('；')}</div>` : ''}
      </div>`).join('') || '<div class="teach-meta">未检出病害：衬砌表观状态良好</div>';
  }

  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));

  /* ---------------- 左栏调参：PUT 局部重算（防抖） ---------------- */
  let putTimer = null;
  function currentParams() {
    return {
      claheClipLimit: parseFloat($('pClip').value),
      claheTileGridSize: parseInt($('pTile').value, 10),
      gaussianKernelSize: parseInt($('pKernel').value, 10),
      cannyThreshold: parseInt($('pCanny').value, 10),
      otsuEnabled: $('pOtsu').checked,
    };
  }
  function syncSliders(p) {
    if (!p) return;
    $('pClip').value = p.claheClipLimit; $('vClip').textContent = p.claheClipLimit;
    $('pTile').value = p.claheTileGridSize; $('vTile').textContent = p.claheTileGridSize + '×' + p.claheTileGridSize;
    $('pKernel').value = p.gaussianKernelSize; $('vKernel').textContent = p.gaussianKernelSize + '×' + p.gaussianKernelSize;
    $('pCanny').value = p.cannyThreshold; $('vCanny').textContent = p.cannyThreshold;
    $('pOtsu').checked = !!p.otsuEnabled;
  }

  function scheduleParamsPut(extra = {}) {
    if (!state.taskId) return;
    clearTimeout(putTimer);
    putTimer = setTimeout(async () => {
      const labels = { clahe: '①CLAHE', gaussian: '②高斯', canny: '③Canny', otsu: '④Otsu' };
      try {
        const r = await fetch(API + '/api/pipeline/params', {
          method: 'PUT', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ taskId: state.taskId, params: currentParams(), ...extra }),
        });
        const body = await r.json();
        if (!r.ok) throw new Error(body.error || r.statusText);
        for (const k of ['clahe', 'gaussian', 'canny', 'otsu']) {
          const img = $('step' + k[0].toUpperCase() + k.slice(1));
          if (img && body.steps[k] && body.steps[k].dataUrl) img.src = body.steps[k].dataUrl;
          document.querySelectorAll(`i[data-step="${k}"]`).forEach((el) => {
            el.textContent = body.steps[k] && body.steps[k].dataUrl ? (body.steps[k].cached ? '缓存' : '重算') : '';
          });
        }
        if (body.heatmap && body.heatmap.overlay) {
          state.overlayUrl = body.heatmap.overlay.dataUrl;
          state.colorUrl = body.heatmap.color && body.heatmap.color.dataUrl;
          if ($('heatToggle').checked) renderView();
        }
        const names = (body.recomputedSteps || []).map((k) => labels[k] || k).join('、') || '无（参数未变化）';
        $('teachRecomputeNote').textContent =
          `本次仅重算：${names}｜其余步骤缓存命中，不做全链路重复推理（${body.elapsedMs}ms）`;
      } catch (e) {
        $('teachRecomputeNote').textContent = '调参失败：' + e.message;
      }
    }, 250);
  }

  ['pClip', 'pTile', 'pKernel', 'pCanny'].forEach((id) => {
    $(id).addEventListener('input', () => {
      $('vClip').textContent = parseFloat($('pClip').value).toFixed(1);
      $('vTile').textContent = $('pTile').value + '×' + $('pTile').value;
      $('vKernel').textContent = $('pKernel').value + '×' + $('pKernel').value;
      $('vCanny').textContent = $('pCanny').value;
      scheduleParamsPut();
    });
  });
  $('pOtsu').addEventListener('change', () => scheduleParamsPut());
  $('heatMethod').addEventListener('change', () => scheduleParamsPut({ heatmapMethod: $('heatMethod').value }));
  $('heatToggle').addEventListener('change', renderView);

  /* ---------------- 导出对比讲解图 ---------------- */
  $('btnTeachExport').addEventListener('click', async () => {
    if (!state.taskId) { alert('请先上传图片完成一次检测'); return; }
    try {
      const r = await fetch(API + '/api/explain/export', {
        method: 'POST', headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ taskId: state.taskId }),
      });
      if (!r.ok) { const b = await r.json().catch(() => ({})); throw new Error(b.error || r.statusText); }
      const blob = await r.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `对比讲解图-${state.taskId}.png`;
      a.click();
      setTimeout(() => URL.revokeObjectURL(a.href), 5000);
    } catch (e) {
      alert('讲解图导出失败：' + e.message);
    }
  });

  /* ---------------- 初始化：读取服务端默认参数 ---------------- */
  (async () => {
    try {
      const r = await fetch(API + '/api/pipeline/params');
      const body = await r.json();
      syncSliders(body.params || body.defaults);
    } catch (e) { /* 保持前端默认值 */ }
  })();
})();
