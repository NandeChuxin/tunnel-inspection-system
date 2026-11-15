/* 模块四「数据库」— 前端逻辑（独立 IIFE，原生 JS）
 *
 * 三大能力：
 *  ① 样本库在线浏览：网格图库 + 顶部筛选（病害类型/来源/等级/隧道）+ 分页；
 *     详情页聚合：原图 + 检测框(Canvas 叠加) + 热力图(复用 /api/explain/detect Eigen-CAM) +
 *     诊断结果 + 分级知识库条文（knowledge_base 按 类型×等级 关联，后端 portal.sampleDetail 已拼装）。
 *  ② 知识库可配置：教师/管理员登录后可在线增删改 5类×4级 共 20 套处置知识；
 *     运行态诊断建议由后端查表生成（fusion 注入 kb resolver）。
 *  ③ 角色权限：student 只读（写操作服务器返回 403）、teacher/admin 可维护知识库；
 *     固定演示账号 admin/teacher/student，口令 123456；token 存 localStorage，请求带 Bearer 头。
 */
(() => {
  const $ = (id) => document.getElementById(id);
  const esc = (s) => String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
  const CLS_COLORS = { '裂缝': '#96700F', '渗漏水': '#256E9F', '剥落掉块': '#c0392b', '衬砌错台': '#8e44ad', '白华析出': '#0E7A66' };
  const ROLE_CN = { admin: '管理员', teacher: '教师', student: '学生' };
  const LV_CLS = { 1: 'lv1', 2: 'lv2', 3: 'lv3', 4: 'lv4' };

  const S = {
    page: 1, total: 0, items: [],
    detail: null, heatUrl: null,
    kbPage: 1,
  };

  /* ================= 通用工具 ================= */
  function authHeaders(json) {
    const h = json ? { 'Content-Type': 'application/json' } : {};
    const t = localStorage.getItem('wb4_token');
    if (t) h['Authorization'] = 'Bearer ' + t;
    return h;
  }
  async function api(method, u, body) {
    const r = await fetch(API + u, { method, headers: authHeaders(body !== undefined), body: body !== undefined ? JSON.stringify(body) : undefined });
    const j = await r.json().catch(() => ({}));
    if (!r.ok) {
      const e = new Error((j.error || r.statusText) + (r.status === 403 ? '（student 只读，写操作被拒绝）' : ''));
      e.status = r.status;
      throw e;
    }
    return j;
  }
  function loadImage(url) {
    return new Promise((resolve, reject) => {
      const im = new Image();
      im.onload = () => resolve(im);
      im.onerror = () => reject(new Error('图像加载失败'));
      im.src = url;
    });
  }
  /** <img src>（同源）→ ≤640 PNG dataUrl（后端推理只收 PNG） */
  async function urlToPngDataUrl(url, maxDim = 640) {
    const im = await loadImage(url);
    const sc = Math.min(1, maxDim / Math.max(im.naturalWidth, im.naturalHeight));
    const cv = document.createElement('canvas');
    cv.width = Math.max(1, Math.round(im.naturalWidth * sc));
    cv.height = Math.max(1, Math.round(im.naturalHeight * sc));
    cv.getContext('2d').drawImage(im, 0, 0, cv.width, cv.height);
    return cv.toDataURL('image/png');
  }
  const levelText = (lv) => ['1级-轻微', '2级-中等', '3级-严重', '4级-危及安全'][(lv || 1) - 1];
  const fmtDate = (t) => String(t || '').replace('T', ' ').slice(0, 16);

  /* ================= 页面开关与互斥 ================= */
  function setPortalVisible(on) {
    if (on) {
      ['__setTrainVisible', '__setTeachVisible'].forEach((k) => {
        if (typeof window[k] === 'function') window[k](false);
      });
      $('portalPage').style.display = '';
      document.querySelectorAll('main.grid, section.kpis').forEach((el) => { el.style.display = 'none'; });
      $('btnPortal').textContent = '返回监控台';
      refreshTunnels();
      refreshSamples();
      refreshKb();
      refreshDbTables(); // 数据库浏览面板（③）随页打开刷新
    } else {
      $('portalPage').style.display = 'none';
      document.querySelectorAll('main.grid, section.kpis').forEach((el) => { el.style.display = ''; });
      $('btnPortal').textContent = '数据库 · 模块四';
      $('btnPortal').blur();
    }
  }
  window.__setPortalVisible = setPortalVisible;
  $('btnPortal').addEventListener('click', () => setPortalVisible($('portalPage').style.display === 'none'));
  $('btnPortalBack').addEventListener('click', () => setPortalVisible(false));

  /* ================= 登录态 ================= */
  function myRole() { return localStorage.getItem('wb4_role') || ''; }
  function renderLogin() {
    const role = myRole();
    const name = localStorage.getItem('wb4_name') || '';
    $('btnLoginUser').textContent = role ? `👤 ${esc(name)} · ${ROLE_CN[role] || role}` : '👤 未登录';
    const canEdit = role === 'teacher' || role === 'admin';
    $('btnKBNew').disabled = !canEdit;
    $('kbRightHint').textContent = canEdit
      ? `当前 ${ROLE_CN[role]}：可新增/编辑/删除知识条目（保存后诊断建议即查表更新）`
      : role === 'student' ? 'student 只读：可浏览全部知识，写操作将返回 403' : '未登录：可浏览；登录 teacher/admin 后可维护';
  }
  function openLogin() { $('loginModal').style.display = 'flex'; $('lgMsg').textContent = ''; }
  function closeLogin() { $('loginModal').style.display = 'none'; }
  async function doLogin(name, pwd) {
    $('lgMsg').textContent = '登录中…';
    try {
      const j = await api('POST', '/api/auth/login', { name, password: pwd });
      localStorage.setItem('wb4_token', j.token);
      localStorage.setItem('wb4_role', j.user.role);
      localStorage.setItem('wb4_name', j.user.name);
      $('lgMsg').textContent = `✓ 已登录：${j.user.name}（${ROLE_CN[j.user.role] || j.user.role}）`;
      closeLogin();
      renderLogin();
      refreshKb();
    } catch (e) { $('lgMsg').textContent = '登录失败：' + e.message; }
  }
  $('btnLoginUser').addEventListener('click', () => {
    if (myRole()) { // 已登录 → 二次点击登出
      localStorage.removeItem('wb4_token'); localStorage.removeItem('wb4_role'); localStorage.removeItem('wb4_name');
      renderLogin(); refreshKb(); refreshDbTables(); // 登出后收回数据库浏览
    } else openLogin();
  });
  $('btnLgClose').addEventListener('click', closeLogin);
  $('btnLgLogin').addEventListener('click', () => doLogin($('lgName').value.trim(), $('lgPwd').value));
  $('lgPwd').addEventListener('keydown', (e) => { if (e.key === 'Enter') doLogin($('lgName').value.trim(), $('lgPwd').value); });
  document.querySelectorAll('.lg-quick button[data-user]').forEach((b) => {
    b.addEventListener('click', () => { $('lgName').value = b.dataset.user; $('lgPwd').value = '123456'; doLogin(b.dataset.user, '123456'); });
  });

  /* ================= ① 样本库浏览 ================= */
  function sampleFilter() {
    const p = new URLSearchParams();
    const set = (k, v) => { if (v !== '' && v != null) p.set(k, v); };
    set('type', $('selPLType').value); set('source', $('selPLSource').value);
    set('level', $('selPLLevel').value); set('tunnel', $('selPLTunnel').value);
    return p;
  }
  async function refreshSamples() {
    const p = sampleFilter();
    p.set('page', S.page); p.set('size', 24);
    try {
      const j = await (await fetch(API + '/api/samples?' + p.toString())).json();
      S.items = j.items || [];
      renderGrid();
      $('pgPage').textContent = `第 ${j.page} / ${j.pages} 页 · 共 ${j.total} 个样本`;
      $('btnPLPrev').disabled = j.page <= 1;
      $('btnPLNext').disabled = j.page >= j.pages;
      if (!S.items.length) $('pgNote').textContent = '无匹配样本：请调整筛选，或点「一键生成样本数据」。';
      else $('pgNote').textContent = '点击卡片打开详情：原图 + 检测框 + 热力图 + 诊断结果 + 知识库条文。';
    } catch (e) { $('pgGrid').innerHTML = '<div class="an-pool-empty">样本加载失败：' + esc(e.message) + '</div>'; }
  }
  function renderGrid() {
    const box = $('pgGrid');
    if (!S.items.length) {
      box.innerHTML = '<div class="an-pool-empty">样本库为空：可点「一键生成样本数据」用内置合成样本跑检测入库，或到模块二批量合成、模块三上传真实图像。</div>';
      return;
    }
    box.innerHTML = S.items.map((it) => {
      const chips = (it.classes || []).map((c) =>
        `<span class="pg-chip" style="color:${CLS_COLORS[c.class_name] || '#9fb4d0'}">${esc(c.class_name)}×${c.count}</span>`).join('');
      return `<div class="pg-card" data-id="${it.image_id}">
        <img class="thumb" src="${it.url}" alt="" loading="lazy">
        <div class="body">
          <div class="nm" title="${esc(it.name)}">${esc(it.name)}</div>
          <div class="meta">${esc(it.tunnel)} · K${it.mileage != null ? Math.floor(it.mileage / 1000) + '+' + String(Math.round(it.mileage % 1000)).padStart(3, '0') : '--'} · ${fmtDate(it.capture_time) || '--'}</div>
          <div class="chips">${chips || '<span class="teach-note">无病害标注</span>'}
            <span class="pg-src ${it.synthetic ? '' : 'real'}">${it.synthetic ? '⚠合成' : '真实'}</span>
            ${it.max_level ? `<span class="pg-lv lv${it.max_level}">L${it.max_level} ${esc(it.level_text || '')}</span>` : ''}
          </div>
        </div>
      </div>`;
    }).join('');
    box.querySelectorAll('.pg-card').forEach((c) => c.addEventListener('click', () => openDetail(Number(c.dataset.id))));
  }
  $('btnPLFilter').addEventListener('click', () => { S.page = 1; refreshSamples(); });
  $('btnPLReload').addEventListener('click', () => { refreshTunnels(); refreshSamples(); });
  $('btnPLPrev').addEventListener('click', () => { if (S.page > 1) { S.page--; refreshSamples(); } });
  $('btnPLNext').addEventListener('click', () => { S.page++; refreshSamples(); });

  async function refreshTunnels() {
    try {
      const sm = await (await fetch(API + '/api/samples/tunnels')).json();
      const sel = $('selPLTunnel');
      const keep = sel.value;
      const opts = ['<option value="">隧道：全部</option>']
        .concat((sm.items || []).map((t) => `<option>${esc(t.name)}</option>`)).join('');
      sel.innerHTML = opts;
      sel.value = keep;
    } catch (e) { /* 忽略：隧道下拉保持现状 */ }
  }

  /* ================= 详情弹层（原图+检测框+热力图+条文） ================= */
  async function openDetail(imageId) {
    try {
      const d = await (await fetch(API + '/api/samples/' + imageId)).json();
      S.detail = d; S.heatUrl = null;
      $('dmHeatCk').checked = false;
      $('dmHeat').style.display = 'none';
      const im = d.image;
      $('dmTitle').textContent = `样本详情 · ${im.name}`;
      $('dmMeta').innerHTML = `<div class="dm-meta-tags">
          <span class="pg-chip" style="color:${CLS_COLORS[Object.keys(d.summary.byClass || {})[0]] || '#9fb4d0'}">${esc(im.tunnel)}</span>
          <span class="pg-chip">${im.mileage != null ? 'K' + Math.floor(im.mileage / 1000) + '+' + String(Math.round(im.mileage % 1000)).padStart(3, '0') : '里程--'}</span>
          <span class="pg-chip">${fmtDate(im.capture_time) || '时间--'}</span>
          <span class="pg-src ${im.synthetic ? '' : 'real'}">${im.synthetic ? '⚠合成样本' : '真实图像'}</span>
        </div>
        <div class="teach-note">检出 <b>${d.summary.count}</b> 处 · ${d.summary.byClass.map((c) => `${esc(c.class_name)} ${c.count}`).join(' / ') || '--'} · width_mm 待补 ${d.summary.widthPending}</div>`;
      const img = $('dmImg');
      img.onload = () => { fitOverlays(); drawBoxes(); };
      img.src = im.url;
      renderDetailList(d);
      $('detailModal').style.display = 'flex';
    } catch (e) { alert('样本详情加载失败：' + e.message); }
  }
  function renderDetailList(d) {
    const box = $('dmList');
    if (!d.detections.length) {
      box.innerHTML = '<div class="dm-empty">该样本库内暂无检测记录：可在模块一/监控台对该图重新检测并自动入库。</div>';
      return;
    }
    box.innerHTML = d.detections.map((det) => {
      const kb = det.knowledge;
      return `<div class="dm-det">
        <h4 style="color:${CLS_COLORS[det.class_name] || '#14201a'}">● ${esc(det.class_name)}
          <span class="lv-badge ${LV_CLS[det.level] || ''}">${esc(det.level_text || '')}</span>
          <span style="color:var(--muted);font-weight:normal;font-size:11px">conf ${(det.confidence || 0).toFixed(2)} · ${esc(det.review_status || '')} · ${esc(det.annotate_mode || '')}</span>
        </h4>
        <div class="teach-note">物理宽 ${det.width_mm != null ? det.width_mm + ' mm' : '待补标定'} · 面积 ${det.area_px != null ? det.area_px + ' px' : '--'}</div>
        ${kb ? `<div class="kb">
          <div><span class="b">规范依据：</span>${esc(kb.standard_basis || '--')}</div>
          <div><span class="b">修复方案：</span><ul class="kb-plan">${(kb.planList || []).map((p) => `<li>${esc(p)}</li>`).join('') || '<li>--</li>'}</ul></div>
          <div><span class="b">处置动作：</span>${esc(kb.action || '--')} · <span class="b">复查周期：</span>${esc(kb.interval || '--')}</div>
        </div>` : '<div class="kb"><span class="b">知识条文：</span><span style="color:var(--danger)">该类型×等级条目缺失</span>（教师登录后在知识库补录，诊断即更新）</div>'}
      </div>`;
    }).join('');
  }
  function fitOverlays() {
    const stage = $('dmStage'), img = $('dmImg'), cv = $('dmCanvas'), hx = $('dmHeat');
    const r = img.getBoundingClientRect(), sr = stage.getBoundingClientRect();
    const left = (r.left - sr.left), top = (r.top - sr.top);
    [cv, hx].forEach((el) => {
      el.style.position = 'absolute';
      el.style.left = left + 'px';
      el.style.top = top + 'px';
      el.style.transform = 'none';
      el.style.width = r.width + 'px';
      el.style.height = r.height + 'px';
      el.style.maxWidth = 'none';
      el.style.maxHeight = 'none';
    });
  }
  function drawBoxes() {
    const d = S.detail, img = $('dmImg'), cv = $('dmCanvas');
    if (!d || !img.naturalWidth) return;
    cv.width = img.naturalWidth; cv.height = img.naturalHeight;
    const ctx = cv.getContext('2d');
    ctx.clearRect(0, 0, cv.width, cv.height);
    ctx.lineWidth = Math.max(2, cv.width / 180);
    for (const det of d.detections) {
      const [x, y, w, h] = det.bbox || [0, 0, 0, 0];
      const color = CLS_COLORS[det.class_name] || '#fff';
      ctx.strokeStyle = color;
      ctx.strokeRect(x * cv.width, y * cv.height, w * cv.width, h * cv.height);
      const label = `${det.class_name} ${det.level_text || ''} ${(det.confidence || 0).toFixed(2)}`;
      ctx.font = `bold ${Math.max(12, cv.width / 40)}px "Microsoft YaHei", sans-serif`;
      const tw = ctx.measureText(label).width;
      ctx.fillStyle = color;
      ctx.fillRect(x * cv.width, y * cv.height - ctx.font.length, tw + 8, ctx.font.length + 4);
      ctx.fillStyle = '#ffffff';
      ctx.fillText(label, x * cv.width + 4, y * cv.height - 3);
    }
  }
  $('dmClose').addEventListener('click', () => { $('detailModal').style.display = 'none'; });
  $('dmHeatCk').addEventListener('change', async () => {
    if (!$('dmHeatCk').checked) { $('dmHeat').style.display = 'none'; return; }
    try {
      $('dmHeatCk').disabled = true;
      if (!S.heatUrl) {
        $('dmMeta').innerHTML += '<div class="teach-note" id="heatBusy">热力图生成中（复用餐模块一 Eigen-CAM 链路）…</div>';
        const png = await urlToPngDataUrl(S.detail.image.url);
        const j = await api('POST', '/api/explain/detect', { image: { dataUrl: png }, tunnel: S.detail.image.tunnel || '青云山隧道', mileage: S.detail.image.mileage || 0, heatmapMethod: 'auto' });
        S.heatUrl = j.heatmap && j.heatmap.overlay && j.heatmap.overlay.dataUrl;
        const b = $('heatBusy'); if (b) b.remove();
      }
      if (S.heatUrl) { $('dmHeat').src = S.heatUrl; $('dmHeat').style.display = 'block'; fitOverlays(); }
      else { $('dmHeatCk').checked = false; alert('热力图生成失败（无有效图像输入）'); }
    } catch (e) {
      $('dmHeatCk').checked = false;
      alert('热力图生成失败：' + e.message);
    } finally { $('dmHeatCk').disabled = false; }
  });
  window.addEventListener('resize', () => { if ($('detailModal').style.display !== 'none') { fitOverlays(); drawBoxes(); } });

  /* ================= ② 知识库维护 ================= */
  async function refreshKb() {
    const p = new URLSearchParams();
    if ($('selKBType').value) p.set('type', $('selKBType').value);
    if ($('selKBLevel').value) p.set('level', $('selKBLevel').value);
    try {
      const j = await (await fetch(API + '/api/kb?' + p.toString())).json();
      const canEdit = myRole() === 'teacher' || myRole() === 'admin';
      const rows = (j.items || []).map((r) => `<tr>
        <td><span style="color:${CLS_COLORS[r.disease_type] || '#14201a'}">● ${esc(r.disease_type)}</span></td>
        <td><span class="lv-badge ${LV_CLS[r.level] || ''}">${esc(r.level_text || '')}</span></td>
        <td><div class="kb-basis">${esc(r.standard_basis || '--')}</div></td>
        <td><ul class="kb-cell-plan">${(r.planList || []).map((x) => `<li>${esc(x)}</li>`).join('') || '<li>--</li>'}</ul></td>
        <td class="conf">${esc(r.action || '--')}</td>
        <td class="conf">${esc(r.interval || '--')}</td>
        <td>${canEdit ? `<button class="btn ghost" data-act="edit" data-id="${r.kb_id}">编辑</button>
            <button class="btn danger" data-act="del" data-id="${r.kb_id}">删除</button>` : '<span class="teach-note">--</span>'}</td>
      </tr>`).join('') || '<tr><td colspan="7" class="teach-note" style="text-align:center">无匹配知识条目</td></tr>';
      $('kbBody').innerHTML = rows;
      $('kbRightHint').textContent = (canEdit ? '当前可编辑；' : (myRole() === 'student' ? 'student 只读（写操作 403）· ' : '浏览模式 · ')) + `共 ${j.total} 条（5 类 × 4 级 = 20 套基础库）`;
      $('kbBody').querySelectorAll('button[data-act]').forEach((b) => b.addEventListener('click', () => onKbAct(b.dataset.act, Number(b.dataset.id))));
    } catch (e) { $('kbBody').innerHTML = '<tr><td colspan="7">加载失败：' + esc(e.message) + '</td></tr>'; }
  }
  async function onKbAct(act, id) {
    if (act === 'del') {
      if (!confirm('确认删除该知识条目？删除后相关诊断建议将变为空。')) return;
      try { await api('DELETE', '/api/kb/' + id); refreshKb(); }
      catch (e) { alert('删除失败：' + e.message); }
      return;
    }
    // edit：载入表单
    try {
      const j = await (await fetch(API + '/api/kb')).json();
      const row = (j.items || []).find((r) => r.kb_id === id);
      if (!row) { alert('条目不存在'); return; }
      $('kbFId').value = row.kb_id;
      $('kbFDisease').value = row.disease_type;
      $('kbFLevel').value = String(row.level);
      $('kbFBasis').value = row.standard_basis || '';
      $('kbFPlan').value = (row.planList || []).join('\n');
      $('kbFAction').value = row.action || '';
      $('kbFInterval').value = row.interval || '';
      $('kbFormMsg').textContent = '编辑 kb#' + row.kb_id + '（裂缝×L1 等 20 条为迁移自代码常量库）';
      $('kbForm').style.display = 'grid';
      $('kbForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    } catch (e) { alert('加载条目失败：' + e.message); }
  }
  $('btnKBReload').addEventListener('click', refreshKb);
  $('selKBType').addEventListener('change', refreshKb);
  $('selKBLevel').addEventListener('change', refreshKb);
  $('btnKBNew').addEventListener('click', () => {
    $('kbFId').value = '';
    $('kbFDisease').value = '裂缝'; $('kbFLevel').value = '1';
    $('kbFBasis').value = ''; $('kbFPlan').value = ''; $('kbFAction').value = ''; $('kbFInterval').value = '';
    $('kbFormMsg').textContent = '新增条目：注意类型×等级组合不可与现有条目重复（重复可用上方编辑）。';
    $('kbForm').style.display = 'grid';
    $('kbForm').scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  });
  $('btnKbCancel').addEventListener('click', () => { $('kbForm').style.display = 'none'; });
  $('btnKbSave').addEventListener('click', async () => {
    const body = {
      disease_type: $('kbFDisease').value,
      level: Number($('kbFLevel').value),
      standard_basis: $('kbFBasis').value.trim(),
      repair_plan: $('kbFPlan').value.trim().split('\n').map((s) => s.trim()).filter(Boolean).join('；'),
      action: $('kbFAction').value.trim(),
      interval: $('kbFInterval').value.trim(),
    };
    if (!body.repair_plan) { $('kbFormMsg').textContent = '修复方案不能为空'; return; }
    $('kbFormMsg').textContent = '保存中…';
    try {
      const id = $('kbFId').value;
      const j = id ? await api('PUT', '/api/kb/' + id, body) : await api('POST', '/api/kb', body);
      $('kbFormMsg').textContent = '✓ 已保存 kb#' + j.kb_id + '（诊断建议已实时切换为查表内容）';
      $('kbForm').style.display = 'none';
      refreshKb();
    } catch (e) {
      $('kbFormMsg').textContent = '保存失败：' + e.message;
    }
  });

  /* ================= 演示：一键生成样本数据（合成样本 → 检测自动入库） ================= */
  $('btnPLDemo').addEventListener('click', async () => {
    const btn = $('btnPLDemo');
    btn.disabled = true;
    $('pgNote').textContent = '样本生成中：合成样本 ×12 → /api/detect/image 自动入库（两隧道·近12天·里程分布）…';
    try {
      const pool = await (await fetch(API + '/api/samples/pool?source=synthetic')).json();
      const cands = (pool.items || []).slice(0, 12).reverse();
      if (!cands.length) throw new Error('图池没有合成样本，请先到模块二批量生成 20 张');
      let total = 0;
      const now = Date.now();
      for (let i = 0; i < cands.length; i++) {
        const it = cands[i];
        const tunnel = i % 2 === 0 ? '青云山隧道' : '核桃坪隧道';
        const mileage = i % 2 === 0 ? 21100 + i * 90 : 8800 + i * 120;
        const captureTime = new Date(now - (cands.length - 1 - i) * 86400000).toISOString().slice(0, 10) + 'T09:' + String(15 + (i % 40)).padStart(2, '0') + ':00';
        const png = await urlToPngDataUrl(it.url);
        const j = await api('POST', '/api/detect/image', {
          tunnel, mileage, captureTime,
          imageId: it.image_id, image: { dataUrl: png },
          calibrationPxPerMm: 0.183, source: 'synthetic', archive: true,
        });
        total += (j.autoArchive && j.autoArchive.archived) ? j.autoArchive.detections_added : 0;
        $('pgNote').textContent = `样本生成 ${i + 1}/${cands.length} · ${esc(it.name)} → ${tunnel}（已入库 ${total} 条检测）`;
        await new Promise((r) => setTimeout(r, 30));
      }
      $('pgNote').textContent = `✓ 完成：${cands.length} 张合成样本 → 自动入库 ${total} 条检测（两隧道·近 12 天分布）。下方卡片即在线样本库。`;
      refreshTunnels(); refreshSamples();
    } catch (e) { $('pgNote').textContent = '生成失败：' + e.message; }
    finally { btn.disabled = false; }
  });

  /* ================= ③ 数据库浏览（SQLite 只读） ================= */
  const dbState = { table: '', page: 1, q: '' };
  const dbCanView = () => myRole() === 'teacher' || myRole() === 'admin';
  const fmtCell = (v) => {
    if (v === null || v === undefined || v === '') return '<span class="teach-note">--</span>';
    const s = String(v);
    return esc(s.length > 64 ? s.slice(0, 61) + '…' : s);
  };
  /** 拉取表清单填充下拉（保持当前选中）；未登录/权限不足时给出提示 */
  async function refreshDbTables() {
    const hint = $('dbHint');
    if (!dbCanView()) {
      hint.textContent = myRole() ? '当前角色无权限（需 teacher/admin）' : 'teacher/admin 登录后可浏览';
      $('dbSchema').textContent = ''; $('dbHead').innerHTML = ''; $('dbBody').innerHTML = '';
      $('dbPage').textContent = '--';
      return;
    }
    try {
      const j = await api('GET', '/api/db/tables');
      const sel = $('selDbTable');
      const keep = dbState.table || (j.tables[0] && j.tables[0].name) || '';
      sel.innerHTML = j.tables.map((t) =>
        `<option value="${esc(t.name)}">${esc(t.label)} · ${esc(t.name)}（${t.count} 行）</option>`).join('');
      sel.value = keep;
      dbState.table = sel.value;
      hint.textContent = `共 ${j.tables.length} 张公共表（只读，users.password 已脱敏）`;
      if (dbState.table) refreshDbRows();
    } catch (e) {
      hint.textContent = e.status === 401 || e.status === 403 ? 'teacher/admin 登录后可浏览' : '加载失败：' + e.message;
    }
  }
  /** 拉取当前表的结构与分页行数据并渲染 */
  async function refreshDbRows() {
    if (!dbState.table || !dbCanView()) return;
    const p = new URLSearchParams({ page: dbState.page, size: 25 });
    if (dbState.q) p.set('q', dbState.q);
    try {
      const j = await api('GET', '/api/db/tables/' + dbState.table + '?' + p.toString());
      $('dbSchema').innerHTML =
        `<b>${esc(j.label)}（${esc(j.name)}）</b> · ${j.columns.length} 列：` +
        j.columns.map((c) => `${esc(c.name)}<span style="color:var(--muted)">${esc(c.type)}${c.pk ? '·PK' : ''}</span>`).join(' / ');
      $('dbHead').innerHTML = '<tr>' + j.columns.map((c) => `<th>${esc(c.name)}</th>`).join('') + '</tr>';
      $('dbBody').innerHTML = j.items.length
        ? j.items.map((r) => '<tr>' + j.columns.map((c) => `<td>${fmtCell(r[c.name])}</td>`).join('') + '</tr>').join('')
        : `<tr><td colspan="${j.columns.length}" class="teach-note" style="text-align:center">${dbState.q ? '无匹配行' : '空表'}</td></tr>`;
      $('dbPage').textContent = `第 ${j.page} / ${j.pages} 页 · 匹配 ${j.total} 行（表共 ${j.count} 行）`;
      $('btnDbPrev').disabled = j.page <= 1;
      $('btnDbNext').disabled = j.page >= j.pages;
    } catch (e) {
      $('dbBody').innerHTML = `<tr><td class="teach-note">加载失败：${esc(e.message)}</td></tr>`;
    }
  }
  $('selDbTable').addEventListener('change', () => { dbState.table = $('selDbTable').value; dbState.page = 1; refreshDbRows(); });
  $('btnDbQuery').addEventListener('click', () => { dbState.q = $('dbQ').value.trim(); dbState.page = 1; refreshDbRows(); });
  $('dbQ').addEventListener('keydown', (e) => { if (e.key === 'Enter') $('btnDbQuery').click(); });
  $('btnDbReload').addEventListener('click', () => { dbState.page = 1; refreshDbTables(); });
  $('btnDbPrev').addEventListener('click', () => { if (dbState.page > 1) { dbState.page--; refreshDbRows(); } });
  $('btnDbNext').addEventListener('click', () => { dbState.page++; refreshDbRows(); });

  /* ================= 初始化 ================= */
  renderLogin();
  // 打开其它模块页时若本模块开着则关闭（各模块的可见性函数已互斥调用本钩子）
})();
