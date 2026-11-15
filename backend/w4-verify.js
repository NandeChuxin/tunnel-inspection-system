/**
 * w4-verify.js — 模块四「开放学习入口」一键验证（零第三方依赖）
 *
 * 覆盖完成标准：
 *   A. 迁移 v3：仍为 8 张公共表；users 增 password 列；幂等
 *   B. 知识库可配置：代码常量库 → knowledge_base 一次性迁移（表空播种，教师删除重启不补回）；
 *      20 条 repair_plan 与 fusion.SUGGESTION_LIB 逐条一致（迁移前后诊断建议一致）；
 *      查表 resolver 注入后建议实时反映教师修改/删除；CRUD（冲突 409 / 缺失 404）
 *   C. 角色权限：固定演示账号 admin/teacher/student（口令 123456）；登录发放 token；
 *      student 写操作（POST/DELETE /api/kb）返回 403；teacher 可增删改；admin 管理用户
 *   D. 样本库：/api/samples 分页+筛选（类型/来源/等级/隧道）；详情页聚合原图+检测框+
 *      诊断+知识库条文（disease_type+level 关联 knowledge_base）；页面接口延迟 ≤1s
 *   E. 诊断决策层查表：/api/detect/image 返回建议 === knowledge_base 修复方案（迁移等价）
 *
 * 运行：node backend/w4-verify.js （自动拉起独立端口服务与临时库，结束自动清理）
 * 之后建议跑一遍 node backend/w0-verify.js w1-verify.js w2-verify.js w3-verify.js 回归。
 */
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

let passCount = 0, failCount = 0;
function ok(cond, label) {
  if (cond) { passCount++; console.log('  ✔ ' + label); }
  else { failCount++; console.log('  ✘ ' + label); }
}

function request(port, method, p, body, headersIn) {
  return new Promise((resolve, reject) => {
    const data = body != null ? JSON.stringify(body) : null;
    const headers = { ...(headersIn || {}) };
    if (data) { headers['Content-Type'] = 'application/json'; headers['Content-Length'] = Buffer.byteLength(data); }
    const req = require('http').request({
      host: '127.0.0.1', port, method, path: p, headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const buf = Buffer.concat(chunks);
        let parsed = null;
        try { parsed = JSON.parse(buf.toString('utf8')); } catch (e) { /* keep null */ }
        resolve({ status: res.statusCode, headers: res.headers, json: parsed, buf });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}
function bearer(tok) { return { Authorization: 'Bearer ' + tok }; }
function waitHealth(port, tries = 80) {
  return new Promise((resolve, reject) => {
    let n = 0;
    const tick = async () => {
      try {
        const r = await request(port, 'GET', '/api/health');
        if (r.status === 200 && r.json && r.json.ok) return resolve();
        if (++n > tries) return reject(new Error('服务启动超时'));
        setTimeout(tick, 250);
      } catch (e) { if (++n > tries) return reject(new Error('服务启动超时')); setTimeout(tick, 250); }
    };
    tick();
  });
}
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  const tmpA = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-unit-'));
  const tmpB = fs.mkdtempSync(path.join(os.tmpdir(), 'w4-http-'));
  const SAMPLE_B64 = fs.readFileSync(path.join(__dirname, 'data', 'w0_sample_tunnel.png')).toString('base64');
  const SAMPLE = 'data:image/png;base64,' + SAMPLE_B64;

  /* ════════ A/B 离线（临时库） ════════ */
  console.log('== 模块四「开放学习入口」验证 ==\n── A 离线：迁移 v3（保持 8 表 + users.password） ──');
  process.env.TUNNEL_DB_PATH = path.join(tmpA, 'db.sqlite');
  ['db/migrate', 'db', 'kb', 'auth', 'fusion'].forEach((m) => { delete require.cache[require.resolve('./' + m)]; });
  const migrate = require('./db/migrate');
  const dbA = require('./db');
  const kb = require('./kb');
  const fusion = require('./fusion');
  const auth = require('./auth');
  const r1 = migrate.run(); const r2 = migrate.run();
  // v5 起 schema 含知识图谱 2 表（kg_entity/kg_relation）→ 公共表 8→10（v5 后修正断言）
  ok(r1.missing.length === 0 && r1.tables.length === 10 && r2.tables.length === 10,
    `迁移建表成功且幂等：${r1.tables.length} 张公共表（v5：8 业务 + 2 知识图谱）`);
  const uCols = dbA.all('PRAGMA table_info(users)').map((c) => c.name);
  ok(uCols.includes('password'), 'users 表已增列 password（演示口令）');

  console.log('\n── B 离线：知识库迁移 / 查表等价 / CRUD ──');
  const m = kb.migrateLib();
  ok(m.inserted === 20 && kb.count() === 20, '代码常量库 → knowledge_base 一次性迁移：20 套（5类×4级，超集覆盖任务书 9 套）');
  const m2 = kb.migrateLib();
  ok(m2.inserted === 0 && kb.count() === 20, '迁移幂等：二次运行不重复播种');
  let eq = true, fails = [];
  for (const type of fusion.DEFECT_TYPES) {
    for (let lv = 1; lv <= 4; lv++) {
      const row = kb.getRow(type, lv);
      const libPlan = (fusion.SUGGESTION_LIB[type][fusion.LEVELS[lv - 1]] || []).join('；');
      if (!row || row.repair_plan !== libPlan) { eq = false; fails.push(type + '|' + lv); }
    }
  }
  ok(eq, '20 条 repair_plan 与迁移前 SUGGESTION_LIB 逐条一致（迁移后诊断建议与迁移前一致）');
  fusion.setSuggestionResolver(kb.getSuggestions);
  ok(JSON.stringify(fusion.suggestionsOf('渗漏水', 2)) === JSON.stringify(fusion.SUGGESTION_LIB['渗漏水'][fusion.LEVELS[1]]),
    '注入查表 resolver：建议 === 常量库内容（等价性）');
  const rc = kb.getRow('裂缝', 1);
  kb.remove(rc.kb_id);
  ok(kb.count() === 19 && fusion.suggestionsOf('裂缝', 1).length === 0, '教师删除 裂缝×1 → 建议立即为空（查表驱动）');
  const m3 = kb.migrateLib();
  ok(m3.inserted === 0 && kb.count() === 19, '删除后重启不补回（教师维护状态优先，一次性迁移只在表空时播种）');
  const rcNew = kb.create({ disease_type: '裂缝', level: 1, repair_plan: '重建方案A；重建方案B', standard_basis: '重建依据' });
  ok(rcNew.planList.length === 2 && fusion.suggestionsOf('裂缝', 1).length === 2, '删除后可重建同一组合，建议实时更新');
  let dup409 = false;
  try { kb.create({ disease_type: '裂缝', level: 1, repair_plan: 'x' }); } catch (e) { dup409 = e.status === 409; }
  ok(dup409, '重复组合创建返回 409');
  let miss404 = false;
  try { kb.update(99999, { repair_plan: 'x' }); } catch (e) { miss404 = e.status === 404; }
  ok(miss404, '更新不存在的 kb_id 返回 404');
  kb.update(rcNew.kb_id, { repair_plan: fusion.SUGGESTION_LIB['裂缝'][fusion.LEVELS[0]].join('；') });
  ok(kb.count() === 20, '恢复 裂缝×1 后知识库共 20 条');

  console.log('\n── A/B 离线：演示账号与 token ──');
  const seed = auth.seedDemoUsers();
  ok(seed.added >= 3, '固定演示账号播种（admin/teacher/student）');
  ok(auth.listUsers().filter((u) => ['admin', 'teacher', 'student'].includes(u.name) && ['admin', 'teacher', 'student'].includes(u.role)).length === 3,
    '三个演示账号角色正确');
  const lg = auth.login('teacher', '123456');
  ok(!!lg.token && lg.user.role === 'teacher', '登录 teacher 成功并下发 token');
  let bad401 = false;
  try { auth.login('student', 'bad'); } catch (e) { bad401 = e.status === 401; }
  ok(bad401, '错误口令返回 401');
  ok(!!auth.me(lg.token), 'me(token) 可解析当前用户');
  auth.logout(lg.token);
  ok(!auth.me(lg.token), 'logout 后 token 吊销');

  /* ════════ C/D/E HTTP 端到端（端口 8795） ════════ */
  console.log('\n── C/D/E HTTP 端到端（端口 8795，独立临时库） ──');
  const PORT = 8795;
  const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
    env: { ...process.env, TUNNEL_PORT: String(PORT), TUNNEL_DB_PATH: path.join(tmpB, 'db.sqlite') }, stdio: 'ignore',
  });
  const dbB = (() => {
    process.env.TUNNEL_DB_PATH = path.join(tmpB, 'db.sqlite');
    delete require.cache[require.resolve('./db')];
    return require('./db');
  })();
  try {
    await waitHealth(PORT);
    ok(true, '服务启动成功（独立库，启动即迁移知识库+播种账号）');
    ok(dbB.get('SELECT COUNT(*) n FROM knowledge_base').n === 20, '启动日志播种 20 套知识库');

    // C1 登录
    const sTok = (await request(PORT, 'POST', '/api/auth/login', { name: 'student', password: '123456' })).json;
    const tTok = (await request(PORT, 'POST', '/api/auth/login', { name: 'teacher', password: '123456' })).json;
    const aTok = (await request(PORT, 'POST', '/api/auth/login', { name: 'admin', password: '123456' })).json;
    ok(sTok.token && sTok.user.role === 'student' && tTok.token && aTok.token && aTok.user.role === 'admin',
      'POST /api/auth/login：student/teacher/admin 三个演示账号均可登录');
    const badLg = await request(PORT, 'POST', '/api/auth/login', { name: 'student', password: 'x' });
    ok(badLg.status === 401, '错误口令登录返回 401');
    const me = await request(PORT, 'GET', '/api/auth/me', null, bearer(tTok.token));
    ok(me.status === 200 && me.json.user.name === 'teacher', 'GET /api/auth/me 解析当前用户');

    // C2 角色权限
    const kb0 = await request(PORT, 'GET', '/api/kb');
    ok(kb0.status === 200 && kb0.json.total === 20, 'GET /api/kb 公开可读（20 条）');
    const stuPost = await request(PORT, 'POST', '/api/kb', { disease_type: '渗漏水', level: 1, repair_plan: 'x' }, bearer(sTok.token));
    const stuDel = await request(PORT, 'DELETE', '/api/kb/1', null, bearer(sTok.token));
    ok(stuPost.status === 403 && stuDel.status === 403, 'student 写操作（POST/DELETE /api/kb）返回 403');
    const noTok = await request(PORT, 'POST', '/api/kb', { disease_type: '渗漏水', level: 1, repair_plan: 'x' });
    ok(noTok.status === 401, '未登录写操作返回 401');

    // teacher 维护：先定位 渗漏水×2 更新再还原；再删 白华×4 重建
    const listSw = await request(PORT, 'GET', '/api/kb?type=' + encodeURIComponent('渗漏水'));
    const rowSw = listSw.json.items.find((r) => r.level === 2);
    const origSwPlan = rowSw.repair_plan;
    const up = await request(PORT, 'PUT', '/api/kb/' + rowSw.kb_id, { repair_plan: '临时更新方案A；临时更新方案B' }, bearer(tTok.token));
    ok(up.status === 200 && up.json.planList.length === 2 && up.json.repair_plan !== origSwPlan, 'teacher PUT 更新知识条目成功');
    const listW4 = await request(PORT, 'GET', '/api/kb?type=' + encodeURIComponent('白华析出'));
    const rowBai = listW4.json.items.find((r) => r.level === 4);
    const del = await request(PORT, 'DELETE', '/api/kb/' + rowBai.kb_id, null, bearer(tTok.token));
    ok(del.status === 200 && del.json.deleted === rowBai.kb_id, 'teacher DELETE 知识条目成功');
    const afterDel = await request(PORT, 'GET', '/api/kb');
    ok(afterDel.json.total === 19, '删除后知识库 19 条');
    const cre = await request(PORT, 'POST', '/api/kb', { disease_type: '白华析出', level: 4, repair_plan: rowBai.repair_plan, standard_basis: rowBai.standard_basis, action: rowBai.action, interval: rowBai.interval }, bearer(tTok.token));
    ok(cre.status === 200 && (await request(PORT, 'GET', '/api/kb')).json.total === 20, 'teacher POST 重建条目成功（共 20 条）');
    const rest = await request(PORT, 'PUT', '/api/kb/' + rowSw.kb_id, { repair_plan: origSwPlan }, bearer(tTok.token));
    ok(rest.json.repair_plan === origSwPlan, '渗漏水×2 已还原初始方案（库保持迁移原状）');

    // C3 admin 用户管理
    const usersByT = await request(PORT, 'GET', '/api/users', null, bearer(tTok.token));
    ok(usersByT.status === 403, 'teacher 访问用户管理返回 403');
    const usersByA = await request(PORT, 'GET', '/api/users', null, bearer(aTok.token));
    const stuRow = usersByA.json.users.find((u) => u.name === 'student');
    ok(usersByA.status === 200 && usersByA.json.users.length >= 3, 'admin GET /api/users 返回用户清单（3 演示账号）');
    const roleUp = await request(PORT, 'PUT', '/api/users/' + stuRow.user_id + '/role', { role: 'teacher' }, bearer(aTok.token));
    const roleBack = await request(PORT, 'PUT', '/api/users/' + stuRow.user_id + '/role', { role: 'student' }, bearer(aTok.token));
    ok(roleUp.status === 200 && roleUp.json.role === 'teacher' && roleBack.json.role === 'student', 'admin 可调整用户角色（已还原 student）');

    // D 样本库：detect 自动入库（建图+检测）→ 浏览/详情
    const det = await request(PORT, 'POST', '/api/detect/image', { image: { dataUrl: SAMPLE }, tunnel: '青云山隧道', mileage: 21000, captureTime: '2026-09-09T10:30:00', calibrationPxPerMm: 0.183, archive: true });
    const iid = det.json && det.json.autoArchive && det.json.autoArchive.image_id;
    ok(det.status === 200 && det.json.autoArchive && det.json.autoArchive.archived && det.json.autoArchive.detections_added > 0,
      '检测自动入库（建样本图像 image_id=' + iid + ' + 结构化检测行）');
    const t0 = Date.now();
    const samples = await request(PORT, 'GET', '/api/samples?page=1&size=24');
    const listMs = Date.now() - t0;
    ok(samples.status === 200 && samples.json.total >= 1 && samples.json.items.length === 1, `GET /api/samples 分页浏览命中样本（${samples.json.total}）`);
    ok(listMs < 1000, '样本库接口延迟 ' + listMs + 'ms（完成标准：页面加载 ≤1s）');
    const it = samples.json.items[0];
    ok(it.image_id === iid && it.tunnel === '青云山隧道' && it.source === 'real' && it.total_detections > 0,
      '列表卡片：隧道/来源/检出数正确');
    const d1 = await request(PORT, 'GET', '/api/samples/' + iid);
    ok(d1.status === 200 && d1.json.image.image_id === iid && d1.json.detections.length > 0, 'GET /api/samples/{id} 详情返回检测结果');
    const allKb = d1.json.detections.every((x) => !!x.knowledge && x.knowledge.planList.length > 0);
    ok(allKb, '详情每条检测已按 类型×等级 关联 knowledge_base 条文');
    const cls = d1.json.detections[0].class_name, lv0 = d1.json.detections[0].level;
    const fType = await request(PORT, 'GET', '/api/samples?type=' + encodeURIComponent(cls));
    const fLv = await request(PORT, 'GET', '/api/samples?level=' + lv0);
    const fTun = await request(PORT, 'GET', '/api/samples?tunnel=' + encodeURIComponent('青云山隧道'));
    ok(fType.status === 200 && fType.json.total >= 1 && fLv.json.total >= 1 && fTun.json.total >= 1,
      `筛选生效：type=${cls} / level=L${lv0} / tunnel=青云山隧道 均能命中`);
    const fSrc = await request(PORT, 'GET', '/api/samples?source=synthetic');
    ok(fSrc.status === 200 && fSrc.json.total === 0, '来源筛选（synthetic）返回空（当前仅 real 样本）');
    const miss = await request(PORT, 'GET', '/api/samples/999999');
    ok(miss.status === 404, '不存在的样本详情返回 404');

    // E 诊断建议查表：detect 返回建议 === knowledge_base 内容
    const det2 = await request(PORT, 'POST', '/api/detect/image', { imageId: iid, image: { dataUrl: SAMPLE }, tunnel: '青云山隧道', archive: true });
    const kbs = kbList2Local(dbB);
    let allEq = true, cnt = 0;
    for (const d of (det2.json.detections || [])) {
      const expect = kbs[d.class_name] && kbs[d.class_name][d.level] ? kbs[d.class_name][d.level].split(/[；;\n]+/) : [];
      if (JSON.stringify(d.suggestions) !== JSON.stringify(expect)) allEq = false;
      cnt += d.suggestions ? d.suggestions.length : 0;
    }
    ok(allEq && cnt > 0, '检测返回建议 === knowledge_base 修复方案（诊断决策层已查表，不再读代码常量）');
  } finally {
    child.kill();
    await wait(300);
  }
  try { fs.rmSync(tmpA, { recursive: true, force: true }); } catch (e) { /* 句柄占用：随进程退出清理 */ }
  try { fs.rmSync(tmpB, { recursive: true, force: true }); } catch (e) { /* 句柄占用：随进程退出清理 */ }
  console.log(`\n结果：${passCount} 通过 / ${failCount} 失败`);
  process.exit(failCount ? 1 : 0);
}

/** 直连临时库读出 type×level → repair_plan 文本（验证期望值用） */
function kbList2Local(db) {
  const map = {};
  for (const r of db.all('SELECT disease_type, level, repair_plan FROM knowledge_base')) {
    map[r.disease_type] = map[r.disease_type] || {};
    map[r.disease_type][r.level] = r.repair_plan;
  }
  return map;
}

main().catch((e) => { console.error('验证脚本异常：' + e.message); process.exit(1); });
