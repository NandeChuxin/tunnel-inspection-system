/* ============================================================================
 * 工位 01 的上传/粘贴/拖放绑定与「完整工作台」入口（Modules 内）
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\docs\prototype-holo-core.html  第 4873–5044 行（原文照搬，仅加本表头）
 * ========================================================================== */
        kgf.sel = null; kgf.detFor = null;        // 点空白：取消选中 → 恢复缓慢自转
        kgf.rot.drift = true; kgf.rot.target = null; kgf.rot.targetPitch = null;
        $('#kgfDetail').innerHTML = '<h4>节点详情</h4><div class="lab-none">点击画布中的知识点，它会转到正中并显示详解。</div>';
        if (!kgf.raf) drawKgFull();
        return;
      }
      kgf.sel = h.entity_id;
      kgf.detFor = null;
      rotateTo(h);                                // 整球把它转到正前方
      if (!kgf.raf) drawKgFull(); else renderKgfDetail();
    });
    cv.addEventListener('pointerleave', function () { if (kgf && kgf.hover) { kgf.hover = null; if (!kgf.raf) drawKgFull(); } });
    cv.addEventListener('wheel', function (e) {
      e.preventDefault();
      if (!kgf) return;
      kgf.s = Math.max(0.5, Math.min(2.4, kgf.s * (e.deltaY < 0 ? 1.1 : 0.9)));
      if (!kgf.raf) drawKgFull();
    }, { passive: false });
    cv.addEventListener('dblclick', function (e) {
      var r = cv.getBoundingClientRect();
      var h = kgfHit(e.clientX - r.left, e.clientY - r.top);
      if (!h || !kgf) return;
      kgf.sel = h.entity_id; kgf.detFor = null;
      rotateTo(h);
      renderKgfDetail();
      if (!kgf.raf) drawKgFull();
    });
    window.addEventListener('resize', function () {
      if (!$('#kgFull').classList.contains('is-open') || !kgf) return;
      resizeKgFull();
      if (!kgf.raf) drawKgFull();
    });
  }

  function zoomKgFull(f) {
    if (!kgf) return;
    kgf.s = Math.max(0.5, Math.min(2.4, kgf.s * f));
    drawKgFull();
  }

  /* ---- 卡片 06 导出 ----
     真 Excel：POST /api/report/excel（后端 xlsx.js 生成双 Sheet：检测概况 + 病害明细）。
     后端离线时降级导出 CSV（同字段，Excel 可直接打开），播报如实说明降级原因。 */
  function downloadBlob(blob, name) {
    var a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = name;
    a.click();
    setTimeout(function () { URL.revokeObjectURL(a.href); }, 4000);
  }
  function buildCsv() {
    var head = '病害ID,类型,等级,状态,桩号,部位,置信度,检出时间,隧道\n';
    var rows = defects.map(function (d) {
      return [d.id, d.type, d.level, d.status,
        (d.position && d.position.chainage) || '', (d.position && d.position.sector) || '',
        typeof d.confidence === 'number' ? d.confidence.toFixed(3) : '',
        d.detectedAt || '', d.tunnel || ''].map(function (v) {
        v = String(v == null ? '' : v);
        return /[",\n]/.test(v) ? '"' + v.replace(/"/g, '""') + '"' : v;
      }).join(',');
    }).join('\n');
    return new Blob(['\uFEFF' + head + rows], { type: 'text/csv;charset=utf-8' });
  }
  function exportExcel() {
    fetch(API + '/api/report/excel', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },   /* 跨源约定：text/plain 不触发 OPTIONS 预检 */
      body: JSON.stringify({ tunnel: '' })
    }).then(function (r) {
      if (!r.ok) throw new Error('HTTP ' + r.status);
      return r.blob();
    }).then(function (blob) {
      downloadBlob(blob, '病害台账-' + new Date().toISOString().slice(0, 10) + '.xlsx');
      setBulletin('已导出 Excel 报告（xlsx · 检测概况 + 病害明细双 Sheet · ' + defects.length + ' 条）', false);
    }).catch(function () {
      downloadBlob(buildCsv(), '病害台账-' + new Date().toISOString().slice(0, 10) + '.csv');
      setBulletin('后端离线 · 已降级导出 CSV（' + defects.length + ' 条 · Excel 可直接打开；联机后可导出双 Sheet xlsx）', true);
    });
  }
  function exportPdf() {
    var s = get('/api/stats');
    Promise.all([s, Promise.resolve(defects)]).then(function (arr) {
      var st = arr[0], list = arr[1].slice(0, 60);
      var w = window.open('', '_blank');
      if (!w) { setBulletin('浏览器拦截了新窗口 · 请允许弹出窗口后重试', true); return; }
      var rows = list.map(function (d) {
        return '<tr><td>' + esc(d.id) + '</td><td>' + esc(d.type) + '</td><td>' + esc(d.level) +
          '</td><td>' + esc(d.status) + '</td><td>' + esc((d.position && d.position.chainage) || '--') +
          '</td><td>' + fmtTime(d.detectedAt) + '</td></tr>';
      }).join('');
      var lv = st.byLevel || {};
      var lvSum = function (prefix) {
        var n = 0;
        Object.keys(lv).forEach(function (k) { if (String(k).indexOf(prefix) === 0) n += lv[k]; });
        return n;
      };
      w.document.write('<html><head><meta charset="utf-8"><title>隧道病害检测报告</title>' +
        '<style>body{font-family:"Microsoft YaHei",sans-serif;margin:36px;color:#1c2430}h1{font-size:20px}' +
        'table{border-collapse:collapse;width:100%;font-size:12px;margin-top:14px}' +
        'td,th{border:1px solid #c8d0da;padding:6px 8px;text-align:left}th{background:#eef2f7}' +
        '.kv{margin-top:10px;font-size:13px;line-height:2}</style></head><body>' +
        '<h1>隧道病害检测报告 · 青云山隧道</h1>' +
        '<div class="kv">台账总数：' + st.total + ' ｜ 待审核：' + (st.byStatus['待审核'] || 0) +
        ' ｜ 已审核：' + (st.byStatus['已审核'] || 0) + '<br>' +
        '等级分布：1级 ' + lvSum('1') + ' · 2级 ' + lvSum('2') +
        ' · 3级 ' + lvSum('3') + ' · 4级 ' + lvSum('4') + '</div>' +
        '<table><tr><th>病害ID</th><th>类型</th><th>等级</th><th>状态</th><th>桩号</th><th>检出时间</th></tr>' +
        rows + '</table>' +
        '<p style="font-size:11px;color:#67707e">生成时间 ' + new Date().toLocaleString() +
        ' · 使用浏览器「打印 → 另存为 PDF」导出</p></body></html>');
      w.document.close();
      setTimeout(function () { w.print(); }, 400);
      setBulletin('报告已生成 · 在新窗口中打印 / 另存为 PDF', false);
    }).catch(function (e) { setBulletin('报告生成失败：' + (e.message || e), true); });
  }

  /* ---- 卡片 01：上传照片 / 视频检测 ---- */
  var vEl = null, vTimer = 0, vBusy = false, vFrames = 0, vHits = 0;
  var busy = false;

  function stopVideoCard() {
    if (vTimer) { clearInterval(vTimer); vTimer = 0; }
    if (vEl) { try { vEl.pause(); } catch (e) {} }
    $('#orbStop').hidden = true;
    $('#orbTag').textContent = '照片';
  }
  function drawMini(srcLike, dets) {
    var c = $('#orbCanvas');
    var w = srcLike.videoWidth || srcLike.naturalWidth || srcLike.width;
    var h = srcLike.videoHeight || srcLike.naturalHeight || srcLike.height;
    if (!w || !h) return;
    var sc = Math.min(1, 480 / w);
    c.width = Math.max(1, Math.round(w * sc));
    c.height = Math.max(1, Math.round(h * sc));
    var ctx2 = c.getContext('2d');
    ctx2.drawImage(srcLike, 0, 0, c.width, c.height);
    (dets || []).forEach(function (d) {
      var bb = (d.position && d.position.bbox) || d.bbox;
      if (!bb) return;
      ctx2.strokeStyle = 'rgba(107,211,240,.95)';
      ctx2.lineWidth = 1.6;
      ctx2.strokeRect(bb[0] * c.width, bb[1] * c.height, bb[2] * c.width, bb[3] * c.height);
      ctx2.fillStyle = 'rgba(107,211,240,.14)';
      ctx2.fillRect(bb[0] * c.width, bb[1] * c.height, bb[2] * c.width, bb[3] * c.height);
    });
    $('#orbWrap').hidden = false;
  }
  function renderRes(dets, elapsed, note) {
    var el = $('#orbRes');
    if (!dets || !dets.length) {
      el.innerHTML = '<div class="lab-none">' + esc(note || '未检出病害：衬砌表观状态良好。') + '</div>';
      return;
    }
    var html = '<div class="lab-none">' + esc(note || ('检出 ' + dets.length + ' 处' +
      (elapsed ? ' · ' + Math.round(elapsed) + 'ms' : ''))) + '</div>';
    html += dets.slice(0, 5).map(function (d) {
      var name = d.class_name || d.type || '未分类';
      var lv = (typeof d.level === 'number') ? d.level : 0;
      var conf = d.confidence || 0;
      var pos = (d.position && d.position.chainage) || '--';
      return '<div class="rc" style="border-left:2px solid var(--lv' + (lv || 1) + ')">' +
        '<div class="h"><span class="ty">' + esc(name) + '</span>' +
        '<span class="bd" style="color:var(--lv' + (lv || 1) + ')">' + (lv ? lv + '级' : '') + '</span>' +
        '<span class="cf">' + Math.round(conf * 100) + '%</span></div>' +
        '<div class="po">' + esc(pos) + '</div></div>';
    }).join('');
    el.innerHTML = html;
  }
  function detectPng(png, note) {
    busy = true;
    $('#labMeter').textContent = '推理中…';
    return post('/api/detect/image', {
