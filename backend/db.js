/**
 * db.js — 统一 SQLite 数据访问层（模块二：实训会话/操作日志/合成样本读写）
 *
 * 依赖 Node >= 22.5 内置 node:sqlite，零第三方依赖。与 db/migrate.js 共用同一
 * 数据库文件（默认 backend/data/tunnel.db，可用环境变量 TUNNEL_DB_PATH 覆盖）。
 *
 * 对外函数：
 *   db()              惰性打开（单例）DatabaseSync 实例
 *   all(sql, ...args) 查询多行（支持 ? 占位与具名参数对象）
 *   get(sql, ...args) 查询单行
 *   run(sql, ...args) 执行写语句 -> { changes, lastInsertRowid }
 *   insert(table, obj) 便捷插入：把对象字段映射为列（JSON 字段自动序列化）
 */
const fs = require('fs');
const path = require('path');

const DB_PATH = process.env.TUNNEL_DB_PATH || path.join(__dirname, 'data', 'tunnel.db');

let _db = null;

/**
 * 惰性打开数据库（首次调用时建目录；singleFlight 防止并发重复打开）
 * @returns {import('node:sqlite').DatabaseSync}
 */
function db() {
  if (_db) return _db;
  if (!fs.existsSync(path.dirname(DB_PATH))) fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
  const { DatabaseSync } = require('node:sqlite');
  _db = new DatabaseSync(DB_PATH);
  _db.exec('PRAGMA foreign_keys = ON;');
  _db.exec('PRAGMA busy_timeout = 3000;');
  return _db;
}

/** 参数序列化（把对象/数组列编码为 JSON 文本） */
function encodeArg(v) {
  if (v === null || v === undefined) return null;
  if (typeof v === 'object') return JSON.stringify(v);
  return v;
}

/**
 * 查询多行
 * @param {string} sql SQL（可含 ? 占位或 :name）
 * @param  {...any} args
 * @returns {Array<object>}
 */
function all(sql, ...args) {
  const st = db().prepare(sql);
  return st.all(...args.map(encodeArg));
}

/**
 * 查询单行
 * @param {string} sql
 * @param  {...any} args
 * @returns {object|undefined}
 */
function get(sql, ...args) {
  const st = db().prepare(sql);
  return st.get(...args.map(encodeArg));
}

/**
 * 执行写操作
 * @param {string} sql
 * @param  {...any} args
 * @returns {{changes:number, lastInsertRowid:number|bigint}}
 */
function run(sql, ...args) {
  const st = db().prepare(sql);
  const info = st.run(...args.map(encodeArg));
  return { changes: Number(info.changes), lastInsertRowid: Number(info.lastInsertRowid) };
}

/**
 * 便捷插入：对象字段 → 列；对象/数组值自动 JSON 序列化
 * @param {string} table 表名（须为白名单内的公共表，防注入）
 * @param {object} row   字段映射（key=列名）
 * @returns {number} 自增主键
 */
function insert(table, row) {
  const allow = new Set([
    'tunnel', 'image', 'detection', 'experiment_session',
    'experiment_log', 'synthetic_sample', 'knowledge_base', 'users',
    'kg_entity', 'kg_relation',                      // v5：知识图谱（实体 / 三元组关系）
  ]);
  if (!allow.has(table)) throw new Error('非法表名: ' + table);
  const keys = Object.keys(row || {});
  if (!keys.length) throw new Error('插入数据为空');
  const cols = keys.join(',');
  const marks = keys.map(() => '?').join(',');
  const info = run(`INSERT INTO ${table} (${cols}) VALUES (${marks})`, ...keys.map((k) => encodeArg(row[k])));
  return info.lastInsertRowid;
}

module.exports = { db, DB_PATH, all, get, run, insert };
