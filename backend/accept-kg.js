/**
 * accept-kg.js — 模块五「隧道病害知识图谱」验收脚本
 *
 * 覆盖：
 *   A. 库表与播种（临时库，隔离，不污染演示库）
 *   B. 本体完整性：实体类型齐备 / 关系无悬空端点 / 每条措施与判据都能溯源到条款
 *   C. 子图检索：按类型+等级取子图，措施严格按等级过滤，节点边自洽
 *   D. 闭环推理：五类病害逐一推理，等级依据/成因/危害/措施/动作周期齐全；
 *      阈值复核；低置信度闸；未知类型 400
 *   E. HTTP 接口（对运行中的服务，默认 http://127.0.0.1:8787，可用 ACC_BASE 覆盖）
 *
 * 运行：node backend/accept-kg.js
 * 依赖：Node >= 22.5（node:sqlite），零第三方依赖
 */
'use strict';

const fs = require('fs');
const os = require('os');
const path = require('path');

const TMP_DB = path.join(os.tmpdir(), 'tis_accept_kg_' + Date.now() + '.db');
const BASE = process.env.ACC_BASE || 'http://127.0.0.1:8787';

let pass = 0, fail = 0;
const ok = (cond, msg) => { if (cond) { pass++; console.log('  ✔ ' + msg); } else { fail++; console.log('  ✘ ' + msg); } };

/* ---------- A. 库表与播种（临时库） ---------- */
console.log('\n== A. 库表与播种（临时库隔离） ==');
process.env.TUNNEL_DB_PATH = TMP_DB;
const migrate = require('./db/migrate');
const r = migrate.run();
const names = r.tables.map((t) => t.name);
ok(names.includes('kg_entity') && names.includes('kg_relation'), 'v5 迁移建出 kg_entity / kg_relation');
ok(r.tables.length === 10, '公共表共 10 张（含图谱 2 张）');

const kg = require('./kg');
const s1 = kg.seedIfEmpty();
ok(s1.seeded && s1.entities > 100 && s1.relations > 150,
  `首播种：${s1.entities} 实体 / ${s1.relations} 关系`);
const s2 = kg.seedIfEmpty();
ok(!s2.seeded && s2.entities === s1.entities, '重复播种被拒绝（表非空不覆盖，与学生维护态不冲突）');

/* ---------- B. 本体完整性 ---------- */
console.log('\n== B. 本体完整性 ==');
const ents = kg.ALL_ENTITIES();
const rels = kg.ALL_RELATIONS();
const ids = new Set(ents.map((e) => e.entity_id));
const et = {};
ents.forEach((e) => { et[e.etype] = (et[e.etype] || 0) + 1; });
['DefectType', 'RiskLevel', 'DefectFeature', 'StructurePart', 'CauseFactor', 'Hazard', 'RepairMeasure', 'Clause', 'Action']
  .forEach((t) => ok(et[t] > 0, `实体类型齐备：${t}（${et[t] || 0} 个）`));
ok(kg.TYPES.every((t) => ids.has('DT-' + t)), '五类病害类型节点与 YOLO 类别对齐');

const dangling = rels.filter((e) => !ids.has(e.head_id) || !ids.has(e.tail_id));
ok(dangling.length === 0, `关系端点全部存在（悬空 ${dangling.length} 条）`);

const badClause = rels.filter((e) => (e.rel === '引用规范' || e.rel === '判据依据' || e.rel === '判定依据' || e.rel === '等级映射') && !ids.has(e.tail_id));
ok(badClause.length === 0, '规范类关系指向真实条款实体（可溯源）');

const measures = ents.filter((e) => e.etype === 'RepairMeasure');
const mNoClause = measures.filter((m) => !rels.some((e) => e.head_id === m.entity_id && e.rel === '引用规范'));
ok(mNoClause.length === 0, `每条维修方案都挂了依据条款（缺 ${mNoClause.length} 条）`);

const causes = ents.filter((e) => e.etype === 'CauseFactor');
const orphanCause = causes.filter((c) => !rels.some((e) => e.tail_id === c.entity_id && e.rel === '成因'));
ok(orphanCause.length === 0, `每个成因因子都被某类病害引用（孤点 ${orphanCause.length} 个）`);

/* ---------- C. 子图检索 ---------- */
console.log('\n== C. 子图检索 ==');
let sgOK = true, filterOK = true, dangleOK = true;
kg.TYPES.forEach((t) => {
  for (let lv = 1; lv <= 4; lv++) {
    const g = kg.subgraph(t, lv);
    if (!g.nodes.length || !g.edges.length) sgOK = false;
    const nset = new Set(g.nodes.map((n) => n.entity_id));
    if (g.edges.some((e) => !nset.has(e.head_id) || !nset.has(e.tail_id))) dangleOK = false;
    const otherLevel = g.edges.filter((e) => {
      if (e.rel !== '对应措施') return false;
      let c = null; try { c = e.cond ? JSON.parse(e.cond) : null; } catch (err) { c = null; }
      return c && c.level && Number(c.level) !== lv;
    });
    if (otherLevel.length) filterOK = false;
  }
});
ok(sgOK, '20 组（5 类 × 4 级）子图均非空');
ok(dangleOK, '子图内所有边的端点都在节点集内（无悬空节点/边）');
ok(filterOK, '措施按等级严格过滤（不会串入其他等级的措施）');

const g3 = kg.subgraph('渗漏水', 3);
const clauses3 = g3.nodes.filter((n) => n.etype === 'Clause');
ok(clauses3.length >= 3, `渗漏水×3级子图含 ${clauses3.length} 个规范条款节点（带依据）`);

/* ---------- D. 闭环推理 ---------- */
console.log('\n== D. 闭环推理 ==');
const base = { id: 'ACC-KG-1', confidence: 0.88, position: { chainage: 'K1+000', sector: '拱顶', bbox: [0.3, 0.3, 0.2, 0.1] }, physical: { '面积': '0.60m²' } };
kg.TYPES.forEach((t) => {
  const res = kg.explain(Object.assign({}, base, { type: t, levelNo: 3, level: '3级-严重' }));
  const good = res.levelNo === 3 && res.causes.length > 0 && res.hazards.length > 0 &&
    res.treatments.length > 0 && res.action && res.interval && res.subgraph.nodes.length > 5;
  ok(good, `${t}：等级 ${res.levelText} · 成因 ${res.causes.length} · 危害 ${res.hazards.length} · 建议 ${res.treatments.length} · 子图 ${res.subgraph.nodes.length}N`);
  ok(res.treatments.every((x) => x.clause), `${t}：每条建议都带依据条款`);
  ok(res.causes.every((c) => c.evidence), `${t}：每条成因都有证据说明`);
});
const ex = kg.explain(Object.assign({}, base, { type: '渗漏水', levelNo: 3, level: '3级-严重' }));
ok(['consistent', 'differs', 'unknown'].includes(ex.levelBasis.thresholdReview.status),
  '阈值复核给出明确状态：' + ex.levelBasis.thresholdReview.status + '（' + ex.levelBasis.thresholdReview.note + '）');
ok(ex.levelBasis.jtg.indexOf('类') >= 0, '等级带 JTG 规范映射：' + ex.levelBasis.jtg);
ok(ex.subgraph.edges.some((e) => e.rel === '识别为') && ex.subgraph.edges.some((e) => e.rel === '定级为'),
  '实例层虚拟节点已挂接（识别为 / 定级为）');
const exLow = kg.explain(Object.assign({}, base, { type: '裂缝', levelNo: 2, level: '2级-中等', confidence: 0.31 }));
ok(exLow.gate.status === 'review', '低置信度触发人工复核闸（不硬定级）');
let thrown = false;
try { kg.explain({ type: '不存在类', levelNo: 1 }); } catch (e) { thrown = e.status === 400; }
ok(thrown, '未知病害类型 → 400（不猜、不编）');

/* ---------- E. HTTP 接口 ---------- */
console.log('\n== E. HTTP 接口（' + BASE + '） ==');
const httpGet = (p) => new Promise((resolve) => {
  const u = new URL(p, BASE);
  require('http').get({ hostname: u.hostname, port: u.port, path: u.pathname + u.search }, (res) => {
    let s = ''; res.on('data', (d) => { s += d; });
    res.on('end', () => { let j = null; try { j = JSON.parse(s); } catch (e) { j = null; } resolve({ code: res.statusCode, body: j }); });
  }).on('error', () => resolve({ code: 0, body: null }));
});

(async () => {
  const st = await httpGet('/api/kg/stats');
  ok(st.code === 200 && st.body && st.body.entities > 0, `GET /api/kg/stats → 200（${st.body && st.body.entities} 实体 / ${st.body && st.body.relations} 关系）`);
  const all = await httpGet('/api/kg/all');
  const allOK = all.code === 200 && all.body && all.body.nodes.length === (st.body ? st.body.entities : -1) &&
    all.body.edges.length === (st.body ? st.body.relations : -1) &&
    all.body.nodes.every((n) => n.degree != null);
  ok(allOK, `GET /api/kg/all → 200（整图 ${all.body && all.body.nodes.length} 节点 / ${all.body && all.body.edges.length} 边，含度数）`);
  const gg = await httpGet('/api/kg/graph?type=' + encodeURIComponent('剥落掉块') + '&level=4');
  ok(gg.code === 200 && gg.body.nodes.length > 5, `GET /api/kg/graph → 200（${gg.body && gg.body.nodes.length} 节点 / ${gg.body && gg.body.edges.length} 边）`);
  const bad = await httpGet('/api/kg/graph?type=' + encodeURIComponent('不存在类'));
  ok(bad.code === 400, 'GET /api/kg/graph 未知类型 → 400');
  const ex2 = await httpGet('/api/kg/explain/ACC-NOT-EXIST');
  ok(ex2.code === 404, 'GET /api/kg/explain/{不存在} → 404');

  console.log('\n--------------------------------------------------');
  if (fail === 0) console.log(` ✅ 模块五验收全部通过：${pass} 项`);
  else console.log(` ❌ 失败 ${fail} 项 / 通过 ${pass} 项`);
  console.log('--------------------------------------------------');
  try { fs.unlinkSync(TMP_DB); } catch (e) { /* 忽略 */ }
  process.exit(fail === 0 ? 0 : 1);
})();
