-- =====================================================================
-- 隧途明鉴 · 教学科研赋能平台 — SQLite 公共数据模型（schema v5）
-- ---------------------------------------------------------------------
-- 一次性建立 10 张公共业务表（全部 IF NOT EXISTS，可重复执行）；
-- v2 增列（不增表）：image 增加 AI辅助标注工作字段，detection 增加
--   annotate_mode / annotate_meta / created_at 并扩展 review_status='approved'。
-- v3 增列（不增表）：users 增加 password（演示登录口令；原型明文仅供教学演示）。
-- v4 增列（不增表）：detection 增加 reviewer（人工复核 / 标注人姓名；自动入库时为 NULL=待复核）。
-- v5 增表：kg_entity / kg_relation —— 隧道病害知识图谱（本体层 + 三元组关系），
--   与 detection 实例层通过关系挂接，支撑「识别→定级→成因→危害→养护建议」闭环推理。
--   （v2~v5 对既有库的幂等升级由 migrate.js ensureV2/ensureV3/ensureV4/ensureV5 负责。）
--   1. tunnel              隧道档案
--   2. image               图像索引（隧道图像 / 合成样本元数据）
--   3. detection           检测结果库
--   4. experiment_session  实训会话
--   5. experiment_log      实训操作日志
--   6. synthetic_sample    合成样本
--   7. knowledge_base      分级知识库（标准依据 / 修复方案 / 处置与周期）
--   8. users               用户与角色（student / teacher / admin）
-- 执行方式：node backend/db/migrate.js  （幂等；--check 仅校验不建表）
-- 依赖：Node >= 22.5（内置 node:sqlite），零第三方依赖
-- =====================================================================

PRAGMA foreign_keys = ON;

-- ---------- 1. tunnel 隧道档案 ----------
CREATE TABLE IF NOT EXISTS tunnel (
  tunnel_id INTEGER PRIMARY KEY AUTOINCREMENT,   -- 隧道主键
  name       TEXT    NOT NULL,                   -- 隧道名称
  type       TEXT    DEFAULT '公路隧道',          -- 隧道类型（公路/铁路/水工/市政…）
  location   TEXT,                               -- 地理位置
  length_m   REAL,                               -- 隧道长度（米）
  owner      TEXT                                -- 管养单位 / 业主
);

-- ---------- 2. image 图像索引 ----------
-- 记录一张参与检测的图像：真实巡检影像 或 合成样本；position_m 为里程桩号
-- W3(v2)：新增 AI辅助标注工作字段（每张图校正耗时/模式/操作元数据），供“标注效率对比”
CREATE TABLE IF NOT EXISTS image (
  image_id           INTEGER PRIMARY KEY AUTOINCREMENT, -- 图像主键
  tunnel_id          INTEGER,                           -- 所属隧道（可空：合成样本不一定挂隧道）
  capture_time       TEXT,                              -- 采集时间 ISO8601
  position_m         REAL,                              -- 里程桩号（米）
  image_path         TEXT,                              -- 图像相对/绝对路径或引用
  source             TEXT    DEFAULT 'real'             -- 来源 real=真实 / synthetic=合成
    CHECK (source IN ('real','synthetic')),
  annotate_mode      TEXT                              -- W3 标注模式：prelabel=AI辅助校正 manual=纯手工（NULL=未参与标注）
    CHECK (annotate_mode IN ('prelabel','manual')),
  annotate_elapsed_s REAL,                              -- W3 人工校正耗时（秒，浏览器端实测计时）
  annotator          TEXT,                              -- W3 标注/校正人
  annotate_at        TEXT,                              -- W3 标注完成时间 ISO8601
  annotate_meta      TEXT,                              -- W3 标注过程元数据 JSON{pre_count,add_count,del_count,move_count,final_count,calibration}
  FOREIGN KEY (tunnel_id) REFERENCES tunnel (tunnel_id)
);
CREATE INDEX IF NOT EXISTS idx_image_tunnel ON image (tunnel_id);
CREATE INDEX IF NOT EXISTS idx_image_position ON image (position_m);

-- ---------- 3. detection 检测结果库 ----------
-- 每条病害检测框一行；bbox 存归一化 [x,y,w,h] JSON；width_mm 为标定物理宽度
-- W3(v2)：review_status 支持 'approved'（人工复核通过，科研数据集口径）；
--        annotate_mode 区分 auto_detect(自动入库)/prelabel(AI辅助校正)/manual(纯手工)
CREATE TABLE IF NOT EXISTS detection (
  detection_id   INTEGER PRIMARY KEY AUTOINCREMENT, -- 检测结果主键
  image_id       INTEGER,                           -- 所属图像
  class_id       INTEGER,                           -- 病害类别编号（1裂缝 2渗漏水 3剥落掉块 4衬砌错台 5白华析出）
  class_name     TEXT    NOT NULL,                  -- 病害类别名（中文）
  confidence     REAL    NOT NULL,                  -- 置信度 0~1
  bbox           TEXT    NOT NULL,                  -- 归一化检测框 JSON [x,y,w,h]
  area_px        INTEGER,                           -- 检测框面积（像素）
  width_mm       REAL,                              -- 标定物理宽度（毫米；NULL=未标定待补）
  level          INTEGER CHECK (level BETWEEN 1 AND 4), -- 评估等级 1~4（1轻微 … 4危及安全）
  review_status  TEXT    DEFAULT '待审核'            -- 审核状态：待审核/已审核/已驳回/approved(科研复核通过)
    CHECK (review_status IN ('待审核','已审核','已驳回','approved')),
  reviewer       TEXT,                              -- v4 人工复核/标注人（users.name；自动入库为 NULL=待复核）
  annotate_mode  TEXT    DEFAULT 'auto_detect'      -- W3 标注模式：auto_detect/prelabel/manual
    CHECK (annotate_mode IN ('auto_detect','prelabel','manual')),
  annotate_meta  TEXT,                              -- W3 标注元数据（冗余：来源/操作计数等 JSON）
  created_at     TEXT    DEFAULT (datetime('now','localtime')), -- W3 入库时间
  FOREIGN KEY (image_id) REFERENCES image (image_id)
);
CREATE INDEX IF NOT EXISTS idx_detection_image ON detection (image_id);
CREATE INDEX IF NOT EXISTS idx_detection_class ON detection (class_id, confidence DESC);

-- ---------- 8. users 用户与角色 ----------
-- 平台用户（含教学角色）；token 为临时会话令牌；password 为演示登录口令
-- （原型明文，仅供教学演示：固定账号 admin/teacher/student 口令 123456；
--   v3 由 migrate.js ensureV3 对既有库幂等补列，此处建表语句已含该列）
CREATE TABLE IF NOT EXISTS users (
  user_id INTEGER PRIMARY KEY AUTOINCREMENT,        -- 用户主键
  name    TEXT NOT NULL,                            -- 用户姓名
  role    TEXT DEFAULT 'student'                    -- 角色：student 学生 / teacher 教师 / admin 管理员
    CHECK (role IN ('student','teacher','admin')),
  token   TEXT,                                     -- 会话令牌
  password TEXT                                     -- 演示口令（v3；明文，教学原型专用）
);

-- ---------- 4. experiment_session 实训会话 ----------
-- 学生/教师开展一次算法实验或实训的会话；params_snapshot 存该次参数快照 JSON
CREATE TABLE IF NOT EXISTS experiment_session (
  session_id      INTEGER PRIMARY KEY AUTOINCREMENT, -- 会话主键
  user_id         INTEGER,                           -- 发起用户（users.user_id）
  start_time      TEXT    NOT NULL,                  -- 开始时间 ISO8601
  end_time        TEXT,                              -- 结束时间 ISO8601（未结束为空）
  params_snapshot TEXT,                              -- 推理/预处理参数快照 JSON
  FOREIGN KEY (user_id) REFERENCES users (user_id)
);
CREATE INDEX IF NOT EXISTS idx_session_user ON experiment_session (user_id, start_time DESC);

-- ---------- 5. experiment_log 实训操作日志 ----------
-- 会话内每一步操作的审计日志（action + 参数 + 结果摘要）
CREATE TABLE IF NOT EXISTS experiment_log (
  log_id         INTEGER PRIMARY KEY AUTOINCREMENT, -- 日志主键
  session_id     INTEGER,                           -- 所属会话
  ts             TEXT    NOT NULL,                  -- 操作时间 ISO8601
  action         TEXT    NOT NULL,                  -- 操作动作名（如 detect/compare/review）
  params         TEXT,                              -- 本次操作参数 JSON
  result_summary TEXT,                              -- 结果摘要 JSON（检出数/耗时等）
  FOREIGN KEY (session_id) REFERENCES experiment_session (session_id)
);
CREATE INDEX IF NOT EXISTS idx_log_session ON experiment_log (session_id, ts);

-- ---------- 6. synthetic_sample 合成样本 ----------
-- 数据增强 / 教学用合成病害样本的生成记录
CREATE TABLE IF NOT EXISTS synthetic_sample (
  sample_id      INTEGER PRIMARY KEY AUTOINCREMENT, -- 样本主键
  source_bg      TEXT,                              -- 背景来源图像引用
  source_defect  TEXT,                              -- 病害贴图来源引用
  params         TEXT,                              -- 合成参数 JSON（位置/缩放/光照/噪声…）
  output_path    TEXT                               -- 合成结果图像路径
);

-- ---------- 7. knowledge_base 分级知识库 ----------
-- 病害分级处置知识：标准依据 + 修复方案 + 处置动作 + 复查周期
CREATE TABLE IF NOT EXISTS knowledge_base (
  kb_id         INTEGER PRIMARY KEY AUTOINCREMENT,  -- 知识条目主键
  disease_type  TEXT    NOT NULL,                   -- 病害类别（裂缝/渗漏水/剥落掉块/衬砌错台/白华析出）
  level         INTEGER NOT NULL CHECK (level BETWEEN 1 AND 4), -- 等级 1~4
  standard_basis TEXT,                              -- 分级依据（规范条款/判据）
  repair_plan   TEXT,                               -- 修复方案
  action        TEXT,                               -- 处置动作（观测/整治/应急/限行…）
  interval      TEXT                                -- 复查/观测周期
);
CREATE INDEX IF NOT EXISTS idx_kb_type_level ON knowledge_base (disease_type, level);

-- ---------- 9. kg_entity 知识图谱实体 ----------
-- 本体层：病害类型 / 风险等级 / 病害特征 / 结构部位 / 成因因子 / 结构危害 /
--         维修方案 / 规范条款 / 处置动作（实例层是 detection，通过 kg_relation 挂接）
CREATE TABLE IF NOT EXISTS kg_entity (
  entity_id  TEXT PRIMARY KEY,          -- 实体标识，如 DT-裂缝 / LV-3 / FT-裂缝宽度
  etype      TEXT NOT NULL,             -- 实体类型（上列 9 类）
  name       TEXT NOT NULL,             -- 显示名
  props      TEXT,                      -- JSON：阈值区间/单位/权重/修正系数等
  source     TEXT,                      -- 出处（标准号+条款 / 论文 / 专家经验）
  updated_at TEXT
);
CREATE INDEX IF NOT EXISTS idx_kg_entity_type ON kg_entity (etype);

-- ---------- 10. kg_relation 知识图谱关系（三元组） ----------
CREATE TABLE IF NOT EXISTS kg_relation (
  triple_id INTEGER PRIMARY KEY AUTOINCREMENT,
  head_id   TEXT NOT NULL,              -- 头实体
  rel       TEXT NOT NULL,              -- 关系名：发生于/典型特征/成因/危害/对应措施/引用规范…
  tail_id   TEXT NOT NULL,              -- 尾实体
  weight    REAL DEFAULT 1.0,           -- 先验常见度 / 置信权重（专家先验，非实测）
  cond      TEXT,                       -- JSON：适用条件（部位、等级门槛等）
  source    TEXT                         -- 出处（标准号+条款 / 论文 / 专家经验）
);
CREATE INDEX IF NOT EXISTS idx_kg_rel_head ON kg_relation (head_id, rel);
CREATE INDEX IF NOT EXISTS idx_kg_rel_tail ON kg_relation (tail_id, rel);

-- 迁移版本标记（供 migrate.js 判断；v2/v3/v4/v5 起列级幂等升级见 migrate.js ensureV2~ensureV5）
PRAGMA user_version = 5;
