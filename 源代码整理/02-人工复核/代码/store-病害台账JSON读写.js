/**
 * store.js — 数据持久化层
 * 以 JSON 文件落盘，保证服务重启后病害台账、审核记录不丢失。
 * 生产环境可替换为 SQLite / PostgreSQL / 时序数据库，接口保持不变。
 */
const fs = require('fs');
const path = require('path');

const DATA_DIR = process.env.TUNNEL_DATA_DIR || path.join(__dirname, 'data');
const DEFECT_FILE = path.join(DATA_DIR, 'defects.json');
const FRAME_FILE = path.join(DATA_DIR, 'frames.json');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });

function load(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf-8'));
  } catch (e) {
    return fallback;
  }
}

function save(file, obj) {
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(obj, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

const defects = load(DEFECT_FILE, []);
const frames = load(FRAME_FILE, []); // 最近采集帧（保留最近 500 帧）

function nextId(prefix, list) {
  const n = list.length + 1;
  return prefix + String(Date.now()).slice(-6) + String(n).padStart(3, '0');
}

module.exports = {
  defects,
  frames,

  addFrame(frame) {
    frame.id = nextId('FRM', frames);
    frames.push(frame);
    if (frames.length > 500) frames.splice(0, frames.length - 500);
    save(FRAME_FILE, frames);
    return frame;
  },

  addDefect(d) {
    d.id = nextId('DFC', defects);
    defects.push(d);
    save(DEFECT_FILE, defects);
    return d;
  },

  getDefect(id) {
    return defects.find((d) => d.id === id);
  },

  updateDefect(id, patch) {
    const d = defects.find((x) => x.id === id);
    if (!d) return null;
    Object.assign(d, patch, { updatedAt: new Date().toISOString() });
    save(DEFECT_FILE, defects);
    return d;
  },

  listDefects(filter = {}) {
    let list = defects.slice();
    if (filter.status) list = list.filter((d) => d.status === filter.status);
    if (filter.type) list = list.filter((d) => d.type === filter.type);
    if (filter.level) list = list.filter((d) => d.level === filter.level);
    if (filter.tunnel) list = list.filter((d) => d.tunnel === filter.tunnel);
    list.sort((a, b) => (a.detectedAt < b.detectedAt ? 1 : -1));
    return list;
  },

  listFrames(limit = 50) {
    return frames.slice(-limit).reverse();
  },

  stats() {
    const total = defects.length;
    const byType = {};
    const byLevel = {};
    const byStatus = {};
    for (const d of defects) {
      byType[d.type] = (byType[d.type] || 0) + 1;
      byLevel[d.level] = (byLevel[d.level] || 0) + 1;
      byStatus[d.status] = (byStatus[d.status] || 0) + 1;
    }
    return { total, byType, byLevel, byStatus };
  },
};
