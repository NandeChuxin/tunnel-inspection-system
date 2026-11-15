/**
 * dbview.js — 模块四「数据库浏览」只读查询层（零依赖，原生 node:sqlite）
 *
 * 职责：为前端数据库浏览面板提供公共表的【结构 + 行数据】只读查询。
 *       只做 SELECT，不提供任何写接口；表名走白名单防注入；
 *       users.password 一律脱敏返回（演示口令也不外泄）。
 *
 * 对外函数：
 *   listTables()                -> { tables: [{ name, label, count, columns }] }
 *   tableRows(name, opts)       -> { name, label, count, columns, page, pages, size, total, items }
 *      opts: { page=1, size=25, q='' }  q 为模糊搜索词（在该表全部 TEXT 列上 LIKE 匹配）
 */
const db = require('./db');

/** 公共表白名单（与 db/schema.sql 的 8 张表一致）+ 中文标签 */
const TABLES = [
  { name: 'tunnel', label: '隧道档案' },
  { name: 'image', label: '图像索引' },
  { name: 'detection', label: '检测结果库' },
  { name: 'experiment_session', label: '实训会话' },
  { name: 'experiment_log', label: '实训操作日志' },
  { name: 'synthetic_sample', label: '合成样本台账' },
  { name: 'knowledge_base', label: '分级知识库' },
  { name: 'users', label: '平台用户' },
];

/** 读取表结构（PRAGMA table_info） */
function columnsOf(name) {
  return db.all(`PRAGMA table_info(${name})`).map((c) => ({
    name: c.name, type: c.type || 'TEXT', notnull: !!c.notnull, pk: !!c.pk,
  }));
}

/**
 * 清单：每张表 行数 + 列结构
 * @returns {{tables: Array<{name:string,label:string,count:number,columns:Array}>}}
 */
function listTables() {
  const tables = TABLES.map((t) => {
    const row = db.get(`SELECT COUNT(*) AS n FROM ${t.name}`);
    return { ...t, count: row ? Number(row.n) : 0, columns: columnsOf(t.name) };
  });
  return { tables };
}

/** LIKE 转义（% _ \） */
function likeEscape(s) {
  return String(s).replace(/[\\%_]/g, (c) => '\\' + c);
}

/**
 * 单表分页行数据（只读）
 * @param {string} name 表名（须在白名单内）
 * @param {{page?:number|string, size?:number|string, q?:string}} opts
 * @returns {object} { name, label, count, columns, page, pages, size, total, items }
 */
function tableRows(name, opts = {}) {
  const meta = TABLES.find((t) => t.name === name);
  if (!meta) { const e = new Error('非法表名: ' + name); e.status = 400; throw e; }
  const cols = columnsOf(name);
  const size = Math.min(200, Math.max(1, Number(opts.size) || 25));
  const page = Math.max(1, Number(opts.page) || 1);
  const total = Number((db.get(`SELECT COUNT(*) AS n FROM ${name}`) || { n: 0 }).n);

  // 模糊搜索：在该表全部 TEXT 列上 LIKE（参数化 + 转义，防注入）
  let where = '';
  const args = [];
  const q = String(opts.q || '').trim();
  if (q) {
    const textCols = cols.filter((c) => /TEXT|CHAR|CLOB/i.test(c.type)).map((c) => c.name);
    if (textCols.length) {
      where = 'WHERE ' + textCols.map((c) => `${c} LIKE ? ESCAPE '\\'`).join(' OR ');
      textCols.forEach(() => args.push('%' + likeEscape(q) + '%'));
    }
  }
  const filtered = where
    ? Number((db.get(`SELECT COUNT(*) AS n FROM ${name} ${where}`, ...args) || { n: 0 }).n)
    : total;
  const pages = Math.max(1, Math.ceil(filtered / size));
  const cur = Math.min(page, pages);
  const items = db.all(
    `SELECT * FROM ${name} ${where} ORDER BY rowid DESC LIMIT ? OFFSET ?`,
    ...args, size, (cur - 1) * size,
  );

  // 脱敏：users.password 永不回传明文
  for (const r of items) {
    if (name === 'users' && Object.prototype.hasOwnProperty.call(r, 'password')) r.password = '******';
  }
  return { name, label: meta.label, count: total, columns: cols, page: cur, pages, size, total: filtered, items };
}

module.exports = { listTables, tableRows, TABLES };
