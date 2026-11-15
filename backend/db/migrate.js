/**
 * migrate.js — SQLite 迁移执行器（公共数据模型 v2）
 *
 * 职责：
 *   将 backend/db/schema.sql 中的 8 张公共表建好（幂等，可重复执行）；
 *   对既有的 v1 库执行 ensureV2 列级升级（image 标注字段 / detection 结构重建）。
 *   对既有 v1~v3 库依次执行 ensureV3（users.password）/ ensureV4（detection.reviewer）补列。
 *
 * 输入：
 *   - 环境变量 TUNNEL_DB_PATH：数据库文件路径（默认 backend/data/tunnel.db）
 *   - 命令行 --check：仅校验并列出当前表，不执行建表
 *
 * 输出：
 *   - 执行成功打印 8 张表清单与各自行数；失败抛错（非零退出码）
 *
 * 依赖：Node >= 22.5 内置 node:sqlite，零第三方依赖。
 * 运行：node backend/db/migrate.js [--check]
 */
const fs = require('fs');
const path = require('path');

const SCHEMA_FILE = path.join(__dirname, 'schema.sql');
const EXPECTED_TABLES = ['tunnel', 'image', 'detection', 'experiment_session',
  'experiment_log', 'synthetic_sample', 'knowledge_base', 'users',
  'kg_entity', 'kg_relation'];

function openDb() {
  const dbPath = process.env.TUNNEL_DB_PATH || path.join(__dirname, '..', 'data', 'tunnel.db');
  if (!fs.existsSync(path.dirname(dbPath))) fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  // node:sqlite 为 Node 22.5+ 内置模块（22.x 下会有 Experimental 提示，不影响使用）
  const { DatabaseSync } = require('node:sqlite');
  const db = new DatabaseSync(dbPath);
  db.exec('PRAGMA foreign_keys = ON;');
  return { db, dbPath };
}

/**
 * 查询当前库中已存在的表清单
 * @param {object} db DatabaseSync 实例
 * @returns {Array<{name:string, count:number}>} 表名与行数
 */
function listTables(db) {
  const rows = db.prepare(
    "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
  ).all();
  return rows.map((r) => {
    let count = 0;
    try { count = db.prepare(`SELECT COUNT(*) AS n FROM "${r.name}"`).get().n; } catch (e) { /* 视图等 */ }
    return { name: r.name, count };
  });
}

/**
 * 列级 v2 升级（幂等，可在既有库上重复执行；不新增表，保持公共表仍为 8 张）：
 *   1) image      增列：annotate_mode / annotate_elapsed_s / annotator / annotate_at / annotate_meta
 *   2) detection  review_status 扩展允许 'approved'，并增列 annotate_mode / annotate_meta /
 *                 created_at —— SQLite 无法修改既有 CHECK 约束，采用「重建表」迁移：
 *                 rename 旧表 → 建新结构 → 回灌数据 → 删旧表 → 重建索引
 * @param {object} db DatabaseSync 实例
 */
function ensureV2(db) {
  // ---- image 增列 ----
  const imgCols = new Set(db.prepare('PRAGMA table_info(image)').all().map((c) => c.name));
  const imgAdds = [
    ['annotate_mode', 'TEXT'],
    ['annotate_elapsed_s', 'REAL'],
    ['annotator', 'TEXT'],
    ['annotate_at', 'TEXT'],
    ['annotate_meta', 'TEXT'],
  ];
  for (const [col, typ] of imgAdds) {
    if (!imgCols.has(col)) db.exec(`ALTER TABLE image ADD COLUMN ${col} ${typ}`);
  }
  // ---- detection 重建（v2） ----
  const detCols = new Set(db.prepare('PRAGMA table_info(detection)').all().map((c) => c.name));
  if (!detCols.has('annotate_mode')) {
    db.exec('BEGIN');
    try {
      db.exec('ALTER TABLE detection RENAME TO detection_old;');
      db.exec(`CREATE TABLE detection (
        detection_id   INTEGER PRIMARY KEY AUTOINCREMENT,
        image_id       INTEGER,
        class_id       INTEGER,
        class_name     TEXT    NOT NULL,
        confidence     REAL    NOT NULL,
        bbox           TEXT    NOT NULL,
        area_px        INTEGER,
        width_mm       REAL,
        level          INTEGER CHECK (level BETWEEN 1 AND 4),
        review_status  TEXT    DEFAULT '待审核'
          CHECK (review_status IN ('待审核','已审核','已驳回','approved')),
        annotate_mode  TEXT    DEFAULT 'auto_detect'
          CHECK (annotate_mode IN ('auto_detect','prelabel','manual')),
        annotate_meta  TEXT,
        created_at     TEXT    DEFAULT (datetime('now','localtime')),
        FOREIGN KEY (image_id) REFERENCES image (image_id)
      );`);
      db.exec(`INSERT INTO detection
        (image_id, class_id, class_name, confidence, bbox, area_px, width_mm, level, review_status, annotate_mode)
        SELECT image_id, class_id, class_name, confidence, bbox, area_px, width_mm, level, review_status, 'auto_detect'
        FROM detection_old;`);
      db.exec('DROP TABLE detection_old;');
      db.exec('CREATE INDEX idx_detection_image ON detection (image_id);');
      db.exec('CREATE INDEX idx_detection_class ON detection (class_id, confidence DESC);');
      db.exec('COMMIT');
    } catch (e) {
      db.exec('ROLLBACK');
      throw e;
    }
  }
}

/**
 * 列级 v3 升级（幂等，可在既有库上重复执行；不新增表）：
 *   users 增列 password —— W4 开放学习入口：固定演示账号（admin/teacher/student，口令 123456）
 *   登录用；原型明文存储（注释与 schema.sql 同步说明）。
 * @param {object} db DatabaseSync 实例
 */
function ensureV3(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(users)').all().map((c) => c.name));
  if (!cols.has('password')) db.exec('ALTER TABLE users ADD COLUMN password TEXT');
}

/**
 * v4 幂等增列：detection.reviewer（人工复核 / 标注人姓名）
 * 输入：db —— DatabaseSync 实例；输出：无（缺列则 ALTER 补列，已有列则跳过，可重复执行）
 */
function ensureV4(db) {
  const cols = new Set(db.prepare('PRAGMA table_info(detection)').all().map((c) => c.name));
  if (!cols.has('reviewer')) db.exec('ALTER TABLE detection ADD COLUMN reviewer TEXT');
}

/**
 * v5 幂等建表：知识图谱 kg_entity / kg_relation（增表不增列）
 * 输入：db —— DatabaseSync 实例；输出：无（表已存在则跳过，可重复执行）
 * 说明：schema.sql 里已含 IF NOT EXISTS 建表语句；此处为**既有 v1~v4 库**兜底，
 *       保证老库不重跑全量 schema 也能拿到图谱表。
 */
function ensureV5(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS kg_entity (
      entity_id  TEXT PRIMARY KEY,
      etype      TEXT NOT NULL,
      name       TEXT NOT NULL,
      props      TEXT,
      source     TEXT,
      updated_at TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kg_entity_type ON kg_entity (etype);
    CREATE TABLE IF NOT EXISTS kg_relation (
      triple_id INTEGER PRIMARY KEY AUTOINCREMENT,
      head_id   TEXT NOT NULL,
      rel       TEXT NOT NULL,
      tail_id   TEXT NOT NULL,
      weight    REAL DEFAULT 1.0,
      cond      TEXT,
      source    TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_kg_rel_head ON kg_relation (head_id, rel);
    CREATE INDEX IF NOT EXISTS idx_kg_rel_tail ON kg_relation (tail_id, rel);
  `);
  db.exec('PRAGMA user_version = 5');
}

/**
 * 执行迁移（幂等）
 * @param {boolean} checkOnly true=仅校验列出表
 * @returns {Array} 表清单 [{name,count}]
 */
function run(checkOnly = false) {
  const { db, dbPath } = openDb();
  try {
    if (!checkOnly) {
      const sql = fs.readFileSync(SCHEMA_FILE, 'utf-8');
      db.exec(sql); // schema.sql 全表 IF NOT EXISTS + user_version=5，可重复执行
      ensureV2(db); // 既有 v1 库的列级幂等升级（无操作则跳过）
      ensureV3(db); // 既有 v1/v2 库的列级幂等升级（users.password，无操作则跳过）
      ensureV4(db); // 既有 v1~v3 库的列级幂等升级（detection.reviewer，无操作则跳过）
      ensureV5(db); // 既有 v1~v4 库的图谱表兜底（kg_entity / kg_relation，无操作则跳过）
    }
    const tables = listTables(db);
    const names = tables.map((t) => t.name);
    return { dbPath, tables, missing: EXPECTED_TABLES.filter((t) => !names.includes(t)) };
  } finally {
    db.close();
  }
}

/* 命令行直接执行时打印结果 */
if (require.main === module) {
  const checkOnly = process.argv.includes('--check');
  try {
    const { dbPath, tables, missing } = run(checkOnly);
    console.log(`[数据库] 文件: ${dbPath}`);
    if (missing.length) {
      console.error(`[数据库] 缺少 ${missing.length} 张表: ${missing.join(', ')}，请先执行 node backend/db/migrate.js`);
      process.exit(1);
    }
    console.log(`[数据库] ${checkOnly ? '校验' : '迁移'}完成，共 ${tables.length} 张表：`);
    for (const t of tables) console.log(`  - ${t.name.padEnd(18)} ${t.count} 行`);
    process.exit(0);
  } catch (e) {
    console.error('[数据库] 迁移失败: ' + e.message);
    process.exit(1);
  }
}

module.exports = { run, EXPECTED_TABLES };
