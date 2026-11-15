/**
 * kb.js — 分级知识库服务（模块四：开放学习入口）
 *
 * 背景：任务书口径“9 套修复方案（3类×3级）”，真实仓库为超集实现——
 *   5 类病害 × 4 等级 = 20 套整治建议（见 docs/系统设计文档.md“✅ 超集实现”）。
 *   本模块把 fusion.js 内置 SUGGESTION_LIB（20 套）一次性迁移进 knowledge_base 表，
 *   repair_plan 逐句保留原文（用「；」分隔），并补 standard_basis / action / interval
 *   供样本详情页聚合展示。
 *
 * 职责：
 *   1) migrateLib()  —— 幂等迁移：代码常量 → knowledge_base 表（提供脚本入口，
 *                      运行 node backend/kb.js 直接执行）；
 *   2) 查表驱动诊断 —— server.js 启动后调用 fusion.setSuggestionResolver(kb.getSuggestions)，
 *                      运行态建议一律查表生成（教师可在线维护），不再读取代码常量；
 *   3) CRUD          —— teacher/admin 维护：create/update/remove 后自动刷新内存缓存；
 *                      角色校验在 server.js 路由层（auth.requireRole）。
 *
 * 对外：
 *   migrateLib()/getSuggestions(type,levelNo)/getRow(type,levelNo)/
 *   list({type,level})/create(body)/update(id,body)/remove(id)/count()/reload()
 */
const db = require('./db');
const fusion = require('./fusion');

/** 分级处置动作（按等级通用） */
const ACTION_BY_LEVEL = {
  1: '外观观测 / 表面封闭处理',
  2: '专项整治 / 加密观测',
  3: '综合整治 + 结构安全评估',
  4: '应急抢险 / 交通管制',
};
/** 复查/观测周期（按等级通用） */
const INTERVAL_BY_LEVEL = {
  1: '6 个月复查',
  2: '季度复查',
  3: '月度监测',
  4: '实时监测 / 立即复核',
};

/** 分级依据（规范条文精神，与 fusion.js 分级判据一致：裂缝按长度/走向，渗漏按面积/部位，错台按断面差…） */
const BASIS_BY_TYPE = {
  '裂缝': [
    '长度估算 <1.2m 的非纵向裂缝，未见发展趋势',
    '长度估算 ≥1.2m（纵向受力裂缝从严：出现即升 2 级）',
    '长度估算 ≥4m，或扩展速率较快',
    '长度估算 ≥8m，或纵向裂缝升级（衬砌失稳风险，参照 JTG H12）',
  ],
  '渗漏水': [
    '湿渍/渗水面积小：<0.5m²（拱部从严 <0.2m²）',
    '渗水面积 0.5~2m²（拱部 0.2~0.8m²）或持续发展',
    '渗水面积 ≥2m² 或拱部 ≥0.8m²',
    '涌水（湿度骤升+大面积暗渍），直接危及行车',
  ],
  '剥落掉块': [
    '剥落面积 <0.1m² 且非拱部',
    '面积 ≥0.1m²，或拱部起皮/剥落（落物风险）',
    '面积 ≥0.5m² 或拱部 ≥0.15m²',
    '面积 ≥1.5m² 或拱部 ≥0.5m²（危及行车）',
  ],
  '衬砌错台': [
    '断面差 <3mm',
    '断面差 3~8mm',
    '断面差 8~15mm',
    '断面差 ≥15mm 或发展迅速（限界与结构安全）',
  ],
  '白华析出': [
    '析出面积 <1m²，指示轻微渗水通道',
    '析出面积 ≥1m²，需溯源处置（渗漏伴随按渗漏定级）',
    '伴随渗漏扩展（综合按渗漏等级评估）',
    '伴随涌水/严重渗漏（按渗漏 4 级流程处置）',
  ],
};

/** 内存缓存：{ '裂缝': {1:{kb_id, planList:[..], ...}, ...} } */
let CACHE = { built: false };

/** 读表重建内存缓存（写操作后调用） */
function reload() {
  const rows = db.all('SELECT * FROM knowledge_base ORDER BY disease_type, level');
  const m = {};
  for (const r of rows) {
    m[r.disease_type] = m[r.disease_type] || {};
    m[r.disease_type][Number(r.level)] = {
      kb_id: r.kb_id,
      standard_basis: r.standard_basis || '',
      action: r.action || '',
      interval: r.interval || '',
      repair_plan: r.repair_plan || '',
      planList: (r.repair_plan || '').split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean),
    };
  }
  CACHE = { built: true, m };
  return m;
}
function map() { if (!CACHE.built) reload(); return CACHE.m; }

/** 拆解建议文本 → 数组（与迁移前 SUGGESTION_LIB 数组逐条一致） */
function splitPlan(text) {
  return String(text || '').split(/[；;\n]+/).map((s) => s.trim()).filter(Boolean);
}

/** 迁移库里的类型清单（fusion.DEFECT_TYPES） */
function defectTypes() { return fusion.DEFECT_TYPES; }

/**
 * 一次性迁移（仅当 knowledge_base 全空时执行，事务内播种；教师随后增删改不受重启影响）：
 * fusion.SUGGESTION_LIB（20 套，5 类×4 级）→ knowledge_base 表。
 * repair_plan 逐句原文拼接；standard_basis/action/interval 按知识模板补全。
 * @returns {{inserted:number, total:number}}
 */
function migrateLib() {
  if (count() > 0) return { inserted: 0, total: count(), skipped: '非空（教师可维护状态优先，不重复播种）' };
  const TYPES = fusion.DEFECT_TYPES;
  const LEVELS = fusion.LEVELS; // ['1级-轻微',...]
  db.run('BEGIN');
  try {
    let inserted = 0;
    for (const type of TYPES) {
      for (let lv = 1; lv <= 4; lv++) {
        const lib = fusion.SUGGESTION_LIB[type];
        const plans = lib && lib[LEVELS[lv - 1]];
        if (!Array.isArray(plans) || !plans.length) continue;
        db.insert('knowledge_base', {
          disease_type: type,
          level: lv,
          standard_basis: (BASIS_BY_TYPE[type] || [])[lv - 1] || '',
          repair_plan: plans.join('；'),
          action: ACTION_BY_LEVEL[lv] || '',
          interval: INTERVAL_BY_LEVEL[lv] || '',
        });
        inserted++;
      }
    }
    db.run('COMMIT');
    reload();
    return { inserted, total: count() };
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
}

/** 查表生成建议（fusion 注入用）：返回修复方案字符串数组 */
function getSuggestions(type, levelNo) {
  const row = map()[type] && map()[type][Number(levelNo)];
  return row ? row.planList.slice() : [];
}

/** 取单条知识（详情页条文展示） */
function getRow(type, levelNo) {
  const row = map()[type] && map()[type][Number(levelNo)];
  if (!row) return null;
  return {
    kb_id: row.kb_id, disease_type: type, level: Number(levelNo),
    level_text: fusion.LEVELS[Number(levelNo) - 1] || (Number(levelNo) + '级'),
    standard_basis: row.standard_basis, repair_plan: row.repair_plan,
    planList: row.planList, action: row.action, interval: row.interval,
  };
}

/** 检索（disease_type/level 过滤；支持分页可选） */
function list({ type, level, page, size } = {}) {
  const cond = [];
  const args = [];
  if (type) { cond.push('disease_type = ?'); args.push(String(type)); }
  if (level != null && level !== '') { cond.push('level = ?'); args.push(Number(level)); }
  const where = cond.length ? 'WHERE ' + cond.join(' AND ') : '';
  const total = db.get(`SELECT COUNT(*) n FROM knowledge_base ${where}`, ...args).n;
  let rows;
  if (page) {
    const sz = Math.min(200, Math.max(1, Number(size) || 20));
    const pg = Math.max(1, Number(page) || 1);
    rows = db.all(`SELECT kb_id, disease_type, level, standard_basis, repair_plan, action, interval
                   FROM knowledge_base ${where} ORDER BY disease_type, level
                   LIMIT ? OFFSET ?`, ...args, sz, (pg - 1) * sz);
  } else {
    rows = db.all(`SELECT kb_id, disease_type, level, standard_basis, repair_plan, action, interval
                   FROM knowledge_base ${where} ORDER BY disease_type, level`, ...args);
  }
  return {
    total,
    items: rows.map((r) => ({
      kb_id: r.kb_id, disease_type: r.disease_type, level: r.level,
      level_text: fusion.LEVELS[r.level - 1] || (r.level + '级'),
      standard_basis: r.standard_basis, repair_plan: r.repair_plan,
      planList: splitPlan(r.repair_plan), action: r.action, interval: r.interval,
    })),
  };
}

function validateBody(b) {
  if (!b || typeof b !== 'object') throw httpErr(400, '请求体需为 JSON 对象');
  const type = String(b.disease_type || '').trim();
  if (!fusion.DEFECT_TYPES.includes(type)) {
    throw httpErr(400, 'disease_type 需为：' + fusion.DEFECT_TYPES.join('/'));
  }
  const lv = Number(b.level);
  if (!Number.isInteger(lv) || lv < 1 || lv > 4) throw httpErr(400, 'level 需为 1~4 的整数');
  const plan = String(b.repair_plan || '').trim();
  if (!plan) throw httpErr(400, 'repair_plan（修复方案）不能为空');
  return {
    disease_type: type,
    level: lv,
    standard_basis: String(b.standard_basis || '').trim(),
    repair_plan: plan,
    action: String(b.action || '').trim() || ACTION_BY_LEVEL[lv],
    interval: String(b.interval || '').trim() || INTERVAL_BY_LEVEL[lv],
  };
}

/** 新建知识条目（teacher/admin 权限在路由层） */
function create(body) {
  const row = validateBody(body);
  const dup = db.get('SELECT kb_id FROM knowledge_base WHERE disease_type=? AND level=?', row.disease_type, row.level);
  if (dup) throw httpErr(409, '该类型×等级已存在（kb_id=' + dup.kb_id + '），请用更新');
  const kb_id = db.insert('knowledge_base', row);
  reload();
  return { kb_id, ...getRow(row.disease_type, row.level) };
}

/** 更新知识条目 */
function update(kbId, body) {
  const old = db.get('SELECT * FROM knowledge_base WHERE kb_id=?', Number(kbId));
  if (!old) throw httpErr(404, '知识条目不存在：kb_id=' + kbId);
  const row = validateBody({ ...old, ...body }); // 缺省字段沿用原值
  const dup = db.get('SELECT kb_id FROM knowledge_base WHERE disease_type=? AND level=? AND kb_id<>?',
    row.disease_type, row.level, Number(kbId));
  if (dup) throw httpErr(409, '目标类型×等级已被 kb_id=' + dup.kb_id + ' 占用');
  db.run('UPDATE knowledge_base SET disease_type=?, level=?, standard_basis=?, repair_plan=?, action=?, interval=? WHERE kb_id=?',
    row.disease_type, row.level, row.standard_basis, row.repair_plan, row.action, row.interval, Number(kbId));
  reload();
  return { kb_id: Number(kbId), ...getRow(row.disease_type, row.level) };
}

/** 删除知识条目 */
function remove(kbId) {
  const info = db.run('DELETE FROM knowledge_base WHERE kb_id=?', Number(kbId));
  if (!info.changes) throw httpErr(404, '知识条目不存在：kb_id=' + kbId);
  reload();
  return { deleted: Number(kbId) };
}

function count() { return db.get('SELECT COUNT(*) n FROM knowledge_base').n; }

function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/* 命令行直接执行迁移（一次性脚本入口）：node backend/kb.js */
if (require.main === module) {
  try {
    const r = migrateLib();
    console.log('[知识库迁移] 新增 ' + r.inserted + ' 条，当前共 ' + r.total + ' 条（5 类病害 × 4 等级 = 20 套，超集覆盖任务书 9 套口径）');
    process.exit(0);
  } catch (e) {
    console.error('[知识库迁移] 失败：' + e.message);
    process.exit(1);
  }
}

module.exports = {
  migrateLib, reload, map,
  getSuggestions, getRow, list, create, update, remove, count,
  defectTypes, splitPlan,
  ACTION_BY_LEVEL, INTERVAL_BY_LEVEL, BASIS_BY_TYPE,
};
