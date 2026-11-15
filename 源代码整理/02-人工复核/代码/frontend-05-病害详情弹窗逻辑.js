/* ============================================================================
 * 病害详情弹窗逻辑：openRvDetail()（组装四区）、renderFig()（真实原图回源 / 同类型示例图）、submitRv()（提交复核并原地刷新）、Esc 分层关闭
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\docs\prototype-holo-core.html  第 3648–3803 行（原文照搬，仅加本表头）
 * ========================================================================== */
        ? '<img src="' + API + '/api/samples/image/' + d.imageRef + '" alt="" loading="lazy"' +
          ' onerror="this.style.display=\'none\';this.parentNode.insertAdjacentHTML(\'beforeend\',\'<i>' + esc(String(d.type || '?').slice(0, 1)) + '</i>\')">'
        : '<i style="color:var(--lv' + (lv || 1) + ')">' + esc(String(d.type || '?').slice(0, 1)) + '</i>';
      var who = (d.review && d.review.reviewer) ? ('复核 ' + d.review.reviewer) : ('检验 ' + (d.source || '未标注'));
      var plan = (d.suggestions && d.suggestions.length ? d.suggestions[0] : (d.decision || '待定（见知识图谱推理）'));
      return '<div class="arc" data-id="' + esc(d.id) + '" style="border-left-color:var(--lv' + (lv || 1) + ')">' +
        '<div class="th">' + thumb + '</div>' +
        '<div class="bd">' +
        '<div class="l1"><b>' + esc(d.type) + (d.subtype ? '·' + esc(d.subtype) : '') + '</b>' +
        '<span class="lv" style="color:var(--lv' + (lv || 1) + ')">' + (lv ? lv + '级' : '--') + '</span>' +
        '<span class="st">' + esc(d.status) + '</span></div>' +
        '<div class="l2">' + esc(who) + ' · ' + fmtTime(d.detectedAt) + ' · ' +
        esc((d.position && d.position.chainage) || '--') + ' · 置信 ' +
        (typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '--') + '</div>' +
        '<div class="l3">处置：' + esc(plan) + '</div>' +
        '</div></div>';
    }).join('') +
      (list.length > show.length
        ? '<div class="arc-more">已显示 ' + show.length + ' / ' + list.length + ' 条（点下方「显示更多」）</div>'
        : '');
    $$('#ldList .arc').forEach(function (row) {
      row.addEventListener('click', function () { openRvDetail(row.dataset.id); });  // 点行 → 病害详情弹窗
    });
  }
  function bindLedger() {
    $$('#ldSeg button').forEach(function (b) {
      b.addEventListener('click', function () {
        $$('#ldSeg button').forEach(function (x) { x.classList.remove('is-on'); });
        b.classList.add('is-on');
        ldStatus = b.dataset.ld || '';
        ldLimit = 30;
        renderLedger();
      });
    });
    $('#ldType').addEventListener('change', function () { ldTypeV = this.value; ldLimit = 30; renderLedger(); });
    $('#ldMore').addEventListener('click', function () {
      ldLimit += 30;
      renderLedger();
      setBulletin('病害档案：已加载前 ' + ldLimit + ' 条', false);
    });
  }

  /* 卡片 04「检测历史」已并入卡片 03「病害档案」（每行带缩略图/检验人/时间/方案），
     原独立图库改为「打开样本库」按钮 → 页内样本库弹窗（openLib，见 libModal）。 */

  /* ---- 卡片 05 人工复核 ---- */
  var rvPage = 0;                                    // 当前批次（「刷新队列」翻页轮换）
  function renderReview() {
    /* 队列排序：真实样本记录优先（用户提供的实拍图先复核），同优先级按检出时间倒序；
       真实记录全部复核完后，队列自然回落到模拟/照片流记录（详情弹窗有同类型示例图兜底）。 */
    var pend = defects.filter(function (d) { return d.status === '待审核'; }).sort(function (a, b) {
      var ra = /真实样本/.test(a.source || '') ? 0 : 1;
      var rb = /真实样本/.test(b.source || '') ? 0 : 1;
      if (ra !== rb) return ra - rb;
      return new Date(b.detectedAt || 0) - new Date(a.detectedAt || 0);
    });
    $('#rvMeter').textContent = '待复核 ' + pend.length;
    var PER = 6, pages = Math.max(1, Math.ceil(pend.length / PER));
    if (rvPage >= pages) rvPage = pages - 1;         // 复核掉末页记录后页码回钳
    var show = pend.slice(rvPage * PER, rvPage * PER + PER);
    if (!show.length) { $('#rvList').innerHTML = '<div class="lab-none">待复核队列为空 · 全部已闭环。</div>'; return; }
    $('#rvList').innerHTML = show.map(function (d) {
      var lv = d.levelNo || (String(d.level || '').match(/^(\d)/) ? +RegExp.$1 : 0);
      return '<div class="rv" data-id="' + esc(d.id) + '">' +
        '<div class="h"><b>' + esc(d.type) + '</b>' +
        '<span class="lv" style="color:var(--lv' + (lv || 1) + ')">' + (lv ? lv + '级' : '--') + '</span>' +
        '<span class="cf">' + (typeof d.confidence === 'number' ? d.confidence.toFixed(2) : '--') + '</span></div>' +
        '<div class="po">' + esc((d.position && d.position.chainage) || '--') + ' · ' +
        esc((d.position && d.position.sector) || '--') + ' · ' + fmtTime(d.detectedAt) + '</div>' +
        '<div class="rv-btns">' +
        '<button class="btn" type="button" data-rv="pass">通过</button>' +
        '<button class="btn" type="button" data-rv="reject">驳回</button>' +
        '</div></div>';
    }).join('') +
      '<div class="rv-more">第 ' + (rvPage + 1) + ' / ' + pages + ' 批 · 共 ' + pend.length +
      ' 条待复核 · 点「刷新队列」翻看下一批</div>';
    $$('#rvList .rv').forEach(function (row) {
      var id = row.dataset.id;
      row.addEventListener('click', function () { openRvDetail(id); });   // 点行 → 病害详情弹窗
      $$('[data-rv]', row).forEach(function (b) {
        b.addEventListener('click', function (e) {
          e.stopPropagation();
          var action = b.dataset.rv === 'pass' ? '通过' : '驳回';
          b.disabled = true; b.textContent = '提交中';
          post('/api/defects/' + encodeURIComponent(id) + '/review',
            { reviewer: REVIEWER, action: action }).then(function () {
            setBulletin('复核完成 · ' + id + ' ' + action, false);
            return Promise.all([loadStats(), loadDefects()]);
          }).catch(function (er) {
            setBulletin('复核失败：' + (er.message || er), true);
            b.disabled = false; b.textContent = action === '通过' ? '通过' : '驳回';
          });
        });
      });
    });
  }

  /* ---- 病害详情弹窗：复核 / 台账点行展开 ------------------------------
     图像：真实样本（imageRef=SQLite image_id）走 /api/samples/image/:id 回源；
     模拟记录无原始影像 → 不生成示意图，检索一张**同病害类型的真实样本图**
     作示例展示（明确标注「非本记录原始影像」），检索不到则显示占位提示。 ---- */
  var rvCur = null;
  function statusTone(s) {
    if (s === '已审核') return { c: 'var(--hi)', t: '已审核 · 通过' };
    if (s === '已驳回') return { c: 'var(--vi-4)', t: '已驳回' };
    return { c: 'var(--lv2)', t: '待审核' };
  }
  function kv(k, v, mono) {
    return '<div><span class="k">' + k + '</span><span class="v' + (mono ? ' mono' : '') + '">' + v + '</span></div>';
  }
  function bboxHTML(b) {
    return '<div class="rvm-bbox" style="left:' + (b[0] * 100).toFixed(2) + '%;top:' + (b[1] * 100).toFixed(2)
      + '%;width:' + (b[2] * 100).toFixed(2) + '%;height:' + (b[3] * 100).toFixed(2) + '%"></div>';
  }
  function figHint(fig, txt) {
    fig.innerHTML = '<div class="lab-none">' + esc(txt) + '</div>';
  }
  var rvFigSeq = 0;                            // 弹窗图像加载序号（防快速连点旧回调覆盖）
  function renderFig(d) {
    var fig = $('#rvmFig');
    var bbox = (d.position && d.position.bbox) || null;
    var seq = ++rvFigSeq;                 // 防快速连点时旧请求回写覆盖
    if (/^\d+$/.test(String(d.imageRef))) {
      fig.innerHTML = '<img alt="检出时原始影像">';
      var im = fig.firstChild;
      im.onload = function () { if (seq === rvFigSeq && bbox) fig.insertAdjacentHTML('beforeend', bboxHTML(bbox)); };
      im.onerror = function () { if (seq === rvFigSeq) figHint(fig, '原始影像加载失败'); };
      im.src = API + '/api/samples/image/' + d.imageRef;
      return;
    }
    /* 模拟记录 → 同病害类型真实样本示例图（不叠 bbox：位置与本记录无关）。
       优先「同类型+同等级」精确匹配，取不到再退同类型；池内随机挑选 + 避免与上次同图。 */
    figHint(fig, '正在检索同类型真实样本…');
    var wantLv = d.levelNo || (String(d.level || '').match(/^(\d)/) ? +RegExp.$1 : 0);
    var qType = encodeURIComponent(d.type || '');
    var qLv = wantLv ? ('&level=' + wantLv) : '';
    Promise.all([
      get('/api/samples?type=' + qType + qLv + '&size=60').catch(function () { return null; }),
      get('/api/samples?type=' + qType + '&size=60')
    ]).then(function (rs) {
      if (seq !== rvFigSeq) return;
      var its = (rs[0] && rs[0].items && rs[0].items.length ? rs[0].items : (rs[1] && rs[1].items) || []);
      if (!its.length) { figHint(fig, '暂无「' + esc(d.type || '该类型') + '」的真实样本图'); return; }
      var pick = its[Math.floor(Math.random() * its.length)];
      if (its.length > 1 && pick.url === renderFig._lastUrl) pick = its[Math.floor(Math.random() * its.length)];
      renderFig._lastUrl = pick.url;
      var lvNote = (wantLv && rs[0] && rs[0].items && rs[0].items.length) ? ' · ' + wantLv + '级' : '';
      fig.innerHTML = '<img alt="同类型真实样本示例图">';
      var im2 = fig.firstChild;
      im2.onload = function () {
        if (seq !== rvFigSeq) return;
        fig.insertAdjacentHTML('beforeend',
          '<div style="position:absolute;left:10px;bottom:10px;padding:4px 10px;'
          + 'font:11px/1.6 Consolas,monospace;letter-spacing:.04em;color:#cfe3f2;'
          + 'background:rgba(5,8,15,.72);border:1px solid rgba(107,211,240,.28);border-radius:4px">'
          + '示例图 · 同类型真实样本（' + esc(d.type || '') + lvNote + '）· 非本记录原始影像</div>');
