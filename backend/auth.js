/**
 * auth.js — 用户 / 角色 / Token 登录（模块四：开放学习入口）
 *
 * 职责：
 *   1) 固定演示账号播种（幂等）：admin / teacher / student，口令统一 123456；
 *      users.password 为原型明文（schema v3 增列，见 db/schema.sql），仅用于教学演示，
 *      不面向生产；实验模块自动创建的「学生」等历史用户 password 为 NULL，登录按默认 123456 处理。
 *   2) 登录发放 token（users.token，crypto 随机十六进制），logout 吊销，me 校验。
 *   3) 角色中间件（供 server.js 路由层使用）：
 *        bearerUser(req)        从 Authorization: Bearer <token> 解析当前用户（无→null）
 *        requireRole(req, roles) 未登录抛 401 / 角色不符抛 403
 *   4) 用户管理（admin）：listUsers / setRole（students 只读、teacher 可维护知识库、admin 管用户）
 *
 * 对外（除 db 外零依赖）：
 *   seedDemoUsers()        幂等播种 3 个演示账号并补齐历史用户默认口令
 *   login(name, password)  → { token, user:{user_id,name,role} }（失败抛 401）
 *   logout(token)          吊销令牌
 *   me(token)              → user 或 null
 *   bearerUser(req) / requireRole(req, roles)
 *   listUsers() / setRole(userId, role)
 *   ROLES / DEMO_ACCOUNTS
 */
const crypto = require('crypto');
const db = require('./db');

const ROLES = ['student', 'teacher', 'admin'];
const ROLE_CN = { student: '学生', teacher: '教师', admin: '管理员' };
/** 固定演示账号（简化部署：三个角色各一，口令统一 123456） */
const DEMO_ACCOUNTS = [
  { name: 'admin', password: '123456', role: 'admin' },
  { name: 'teacher', password: '123456', role: 'teacher' },
  { name: 'student', password: '123456', role: 'student' },
];
const DEFAULT_PASSWORD = '123456'; // 历史自动创建用户(NULL password)的统一演示口令

/** 构造带 HTTP 状态码的错误（路由层统一转 JSON） */
function httpErr(status, message) {
  const e = new Error(message);
  e.status = status;
  return e;
}

/**
 * 幂等播种：① 确保 3 个固定演示账号存在；② 历史 password IS NULL 的用户补默认口令。
 * @returns {{added:number, patched:number}}
 */
function seedDemoUsers() {
  let added = 0;
  for (const u of DEMO_ACCOUNTS) {
    const row = db.get('SELECT user_id FROM users WHERE name=?', u.name);
    if (!row) {
      db.insert('users', { name: u.name, role: u.role, password: u.password, token: null });
      added++;
    } else {
      // 已有同名账号：仅当角色缺失(role 为 NULL/非 ROLES)时校正，不覆盖演示账号既有角色
      const cur = db.get('SELECT role FROM users WHERE user_id=?', row.user_id);
      if (!cur || !ROLES.includes(cur.role)) {
        db.run('UPDATE users SET role=?, password=COALESCE(password,?) WHERE user_id=?', u.role, u.password, row.user_id);
      } else if (cur.role !== u.role && u.name === 'admin') {
        // admin 演示账号必须为 admin 角色
        db.run('UPDATE users SET role=? WHERE user_id=?', u.role, row.user_id);
      }
    }
  }
  const patched = db.run("UPDATE users SET password=? WHERE password IS NULL", DEFAULT_PASSWORD).changes;
  return { added, patched };
}

/** 登录校验：口令错 / 用户不存在 → 401 */
function login(name, password) {
  const n = String(name || '').trim();
  const p = String(password || '');
  if (!n || !p) throw httpErr(401, '请输入用户名与口令');
  const user = db.get('SELECT * FROM users WHERE name=?', n);
  if (!user) throw httpErr(401, '用户不存在：' + n);
  const stored = user.password || DEFAULT_PASSWORD; // 历史 NULL 口令按默认演示口令处理
  if (p !== stored) throw httpErr(401, '口令错误');
  const token = crypto.randomBytes(16).toString('hex');
  db.run('UPDATE users SET token=? WHERE user_id=?', token, user.user_id);
  return { token, user: { user_id: user.user_id, name: user.name, role: user.role } };
}

/** 按 token 取用户（无 → null） */
function userOfToken(token) {
  if (!token) return null;
  return db.get('SELECT user_id, name, role FROM users WHERE token=?', String(token).trim()) || null;
}

/** 吊销令牌 */
function logout(token) {
  if (!token) return { ok: true };
  db.run('UPDATE users SET token=NULL WHERE token=?', String(token).trim());
  return { ok: true };
}

/* ---------------- 角色中间件（路由层使用） ---------------- */

/** 从请求头解析当前用户（Authorization: Bearer <token>） */
function bearerUser(req) {
  const h = (req.headers && req.headers.authorization) || '';
  const m = String(h).match(/^Bearer\s+(.+)$/i);
  if (!m) return null;
  return userOfToken(m[1].trim());
}

/**
 * 角色校验：未登录 401，角色不在允许列表 403
 * @param {object} req http.IncomingMessage
 * @param {string[]} roles 允许角色（如 ['teacher','admin']）
 * @returns {object} 当前用户
 */
function requireRole(req, roles) {
  const u = bearerUser(req);
  if (!u) throw httpErr(401, '未登录或 token 无效：请先 POST /api/auth/login');
  if (!roles.includes(u.role)) throw httpErr(403, '权限不足：该操作需 ' + roles.map((r) => ROLE_CN[r] || r).join('/') + ' 角色');
  return u;
}

/* ---------------- 用户管理（admin） ---------------- */

/** 用户清单（不含令牌，避免泄露会话） */
function listUsers() {
  return db.all('SELECT user_id, name, role FROM users ORDER BY user_id');
}

/** 调整角色（仅 admin 可调用；校验在路由层） */
function setRole(userId, role) {
  if (!ROLES.includes(String(role))) throw httpErr(400, '非法角色：' + role + '（允许 ' + ROLES.join('/') + '）');
  const row = db.get('SELECT user_id FROM users WHERE user_id=?', Number(userId));
  if (!row) throw httpErr(404, '用户不存在');
  db.run('UPDATE users SET role=? WHERE user_id=?', String(role), Number(userId));
  return db.get('SELECT user_id, name, role FROM users WHERE user_id=?', Number(userId));
}

module.exports = {
  ROLES, ROLE_CN, DEMO_ACCOUNTS, DEFAULT_PASSWORD,
  seedDemoUsers, login, logout, userOfToken, me: userOfToken,
  bearerUser, requireRole, listUsers, setRole, httpErr,
};
