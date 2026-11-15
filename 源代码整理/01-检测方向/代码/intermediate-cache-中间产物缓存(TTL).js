/**
 * intermediate-cache.js — 推理中间产物内存缓存（W0）
 *
 * 语义：以「任务 ID」为缓存 key 保存一次 /api/detect/image 的完整 DetectResult
 *       （含中间产物 Base64 与检测框），TTL 30 分钟；惰性清理 + 定期清扫。
 *
 * 输入：put(taskId, payload)  /  get(taskId) /  del(taskId)
 * 输出：payload 或 null；put 时返回 { taskId, expiresAt }
 *
 * 说明：仅用于单机教学/演示场景（内存占用受容量上限约束），重启即失效属预期；
 *       后续如需跨进程共享可替换为 Redis 等，接口保持不变。
 */
const TTL_MS = 30 * 60 * 1000;   // 30 分钟
const MAX_ITEMS = 100;           // 容量上限，超出时淘汰最旧

const map = new Map(); // taskId -> { payload, expiresAt, createdAt }

/** 惰性清理过期条目，返回剩余数 */
function sweep() {
  const now = Date.now();
  for (const [k, v] of map) {
    if (v.expiresAt <= now) map.delete(k);
  }
  return map.size;
}

/**
 * 写入缓存
 * @param {string} taskId 任务 ID
 * @param {object} payload DetectResult 对象（含 intermediates）
 * @returns {{taskId:string, expiresAt:number}} 缓存凭据
 */
function put(taskId, payload) {
  const now = Date.now();
  if (map.size >= MAX_ITEMS) { // 容量保护：淘汰已过期或最旧一条
    sweep();
    if (map.size >= MAX_ITEMS) {
      const oldest = map.keys().next().value;
      if (oldest) map.delete(oldest);
    }
  }
  const expiresAt = now + TTL_MS;
  map.set(taskId, { payload, expiresAt, createdAt: now });
  return { taskId, expiresAt };
}

/**
 * 读取缓存
 * @param {string} taskId 任务 ID
 * @returns {object|null} DetectResult；不存在或已过期返回 null
 */
function get(taskId) {
  const hit = map.get(taskId);
  if (!hit) return null;
  if (hit.expiresAt <= Date.now()) { map.delete(taskId); return null; }
  return hit.payload;
}

/** 删除单条缓存 */
function del(taskId) { map.delete(taskId); }

/** 启动周期清扫（server 启动时调用一次；unref 不阻塞进程退出） */
function startSweeper(intervalMs = 60 * 1000) {
  const t = setInterval(sweep, intervalMs);
  if (t.unref) t.unref();
  return t;
}

module.exports = { TTL_MS, put, get, del, sweep, startSweeper, size: () => map.size };
