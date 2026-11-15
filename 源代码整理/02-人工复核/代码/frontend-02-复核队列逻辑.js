/* ============================================================================
 * 卡片 05 人工复核逻辑：队列排序（真实样本优先+时间倒序）、分页轮换、renderReview()、通过/驳回按钮 → POST /api/defects/:id/review
 * 出处：C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system\docs\prototype-holo-core.html  第 3596–3647 行（原文照搬，仅加本表头）
 * ========================================================================== */
      $('#ctCrack').textContent = vals.crack;
      $('#ctSeep').textContent = vals.seep;
      $('#ctSpall').textContent = vals.spall;
      var max = Math.max(1, vals.crack, vals.seep, vals.spall);
      var bars = { crack: 0, seep: 0, spall: 0 };
      Object.keys(bars).forEach(function (k, i) {
        bars[k] = Math.round(vals[k] / max * 100);
        var item = $('#dist .item[data-key="' + k + '"]');
        if (item) { var b = $('.bar i', item); if (b) b.style.width = bars[k] + '%'; }
      });
      $('#viewMeter').textContent = s.total + ' 处';
      void map;
    }).catch(function () { $('#stMeter').textContent = '离线'; });
  }

  function loadModel() {
    get('/api/model/info').then(function (j) {
      var m = j.mode || (j.enabled ? 'learned' : 'rules');
      $('#viewModel').textContent = (m === 'learned') ? '学习模型' : '规则模型';
    }).catch(function () { $('#viewModel').textContent = '--'; });
  }

  /* ---- 台账缓存：卡片 02/03/05 共用 ---- */
  function loadDefects() {
    return get('/api/defects').then(function (list) {
      defects = list || [];
      renderLedger();
      renderReview();
      var d0 = defects[0];
      $('#viewLast').textContent = d0
        ? (d0.type + ' ' + (d0.levelNo || '') + '级 · ' + (d0.position && d0.position.chainage || '--'))
        : '暂无';
    }).catch(function () { $('#ldList').innerHTML = '<div class="lab-none">台账读取失败（后端离线）</div>'; });
  }

  /* ---- 卡片 03 病害档案（台账 + 检测历史合并）：一行 = 图 + 名称 + 检验/时间 + 方案 ---- */
  var ldStatus = '', ldTypeV = '', ldLimit = 30;
  function renderLedger() {
    var list = defects.filter(function (d) {
      if (ldStatus && d.status !== ldStatus) return false;
      if (ldTypeV && d.type !== ldTypeV) return false;
      return true;
    });
    $('#ldMeter').textContent = list.length + ' 条';
    var show = list.slice(0, ldLimit);
    if (!show.length) { $('#ldList').innerHTML = '<div class="lab-none">没有符合条件的记录。</div>'; return; }
    $('#ldList').innerHTML = show.map(function (d) {
      var lv = d.levelNo || (String(d.level || '').match(/^(\d)/) ? +RegExp.$1 : 0);
      /* 缩略图：有实拍原图（imageRef=样本库 image_id）就回源真图；
         模拟照片流记录没有原图，用"类型首字 + 等级色"占位，不假装有图 */
      var hasImg = /^\d+$/.test(String(d.imageRef));
      var thumb = hasImg
