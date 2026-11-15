/**
 * seed-demo.js — 演示数据自播种（开箱即用）
 * =========================================
 * 解决「拿到的包数据库是空的、起服务看不到数据」的问题：
 * 首次启动（SQLite detection 表为空 且 病害台账 JSON 无记录）时，
 * 用内置程序化合成样本走**真实推理链路**（infer.detectImage → portal.archiveDetect）
 * 入库 5 类病害演示记录，让「病害档案 / 样本库 / 统计 / 人工复核」开箱即有数据。
 *
 * 合规与诚实性：
 *   · 全部样本由 synthesizer 程序化合成（非真实隧道影像），
 *     source 标记「演示播种」，台账可整批删除（删 JSON/清表即恢复空库）；
 *   · 走的是与生产完全相同的 detectImage → archiveDetect 链路，不是假数据直插。
 *
 * 触发：server.js 启动序列调用 seedIfEmpty()；也可手动 `node backend/seed-demo.js`。
 */
const db = require('./db');
const vision = require('./vision');
const synthesizer = require('./synthesizer');
const infer = require('./infer');
const portal = require('./portal');
const Store = require('./store');

const SEED_NOTE = '演示播种';

/** 内置演示脚本：5 类病害 × 2 座隧道 × 多等级/里程（8 条） */
const DEMO = [
  { kind: '裂缝', level: 2, tunnel: '青云山隧道', mileage: 1200 },
  { kind: '裂缝', level: 3, tunnel: '青云山隧道', mileage: 1580 },
  { kind: '渗漏水', level: 2, tunnel: '青云山隧道', mileage: 2310 },
  { kind: '白华析出', level: 1, tunnel: '青云山隧道', mileage: 3050 },
  { kind: '剥落掉块', level: 2, tunnel: '示范段隧道', mileage: 640 },
  { kind: '剥落掉块', level: 3, tunnel: '示范段隧道', mileage: 980 },
  { kind: '衬砌错台', level: 2, tunnel: '示范段隧道', mileage: 1520 },
  { kind: '渗漏水', level: 1, tunnel: '示范段隧道', mileage: 210 },
];

function isEmpty_() {
  try {
    const r = db.get('SELECT COUNT(*) AS c FROM detection');
    if (r && Number(r.c) > 0) return false;
  } catch (e) { /* 表可能尚未建：视为空，交给上层 migrate 后再试 */ }
  try {
    if (Array.isArray(require('./store').defects) && require('./store').defects.length > 0) return false;
  } catch (e) { /* 台账读取失败不阻断：以 SQLite 为准 */ }
  return true;
}

function composeDataUrl(kind, level) {
  const W = 640, H = 480;   // 与 makeBackground(·, W, H) 一致；其返回值不携带宽高字段
  const bg = synthesizer.makeBackground(null, W, H);
  const demo = synthesizer.makeDemoDefect(kind, level);
  synthesizer.composeOne(bg, [{ rgba: demo.rgba, alpha: demo.alpha, w: demo.w, h: demo.h, class_name: kind, level }]);
  const rgb = vision.rgbFromRgba(bg.rgba);
  const png = vision.encodePngRGB(W, H, rgb);
  return 'data:image/png;base64,' + png.toString('base64');
}

/**
 * 库为空时播种演示数据。返回：
 *   { seeded:true,  count, byType } | { seeded:false, reason }
 */
async function seedIfEmpty() {
  try {
    // 幂等建表（独立运行本脚本时也生效；server 启动序列已跑过则无开销）
    try { require('./db/migrate').run(); } catch (e) { /* node:sqlite 不可用时由外层提示 */ }
    // SEED_DEMO_FORCE=1：跳过"库为空"检查强制播种（仅测试/演示复位用）
    if (process.env.SEED_DEMO_FORCE !== '1' && !isEmpty_()) {
      return { seeded: false, reason: '已有检测数据' };
    }
    let count = 0;
    const byType = {};
    for (const d of DEMO) {
      try {
        const dataUrl = composeDataUrl(d.kind, d.level);
        // detectImage 是异步管线（YOLO/图像分析均可能异步）；必须等待完成后再归档。
        // 旧实现把 Promise 当 DetectResult 传入，导致空库首次播种静默失败。
        const res = await infer.detectImage({ image: { dataUrl }, params: { confidenceThreshold: 0.4 } });
        const captured = new Date(Date.now() - Math.round(Math.random() * 11 * 86400000)).toISOString();
        const archived = portal.archiveDetect(
          { tunnel: d.tunnel, mileage: d.mileage, captureTime: captured, source: SEED_NOTE, image: { dataUrl } },
          res
        );
        /* 双存储同步（见 README「双存储」说明）：病害台账 / 统计 / 病害档案读 JSON 台账，
           播种记录必须按台账字段口径（type/level/...）同步写入，否则干净包里
           「样本库有数据、台账统计仍为空」。imageRef 指回样本库图片，档案缩略图可显示。 */
        for (const det of (res.detections || [])) {
          Store.addDefect({
            type: det.class_name,
            subtype: det.subtype || '',
            level: det.level_text || (det.level ? det.level + '级' : ''),
            levelNo: det.level || null,
            confidence: det.confidence,
            position: det.position || {},
            physical: det.physical || {},
            basis: det.basis || [],
            suggestions: det.suggestions || [],
            status: '待审核',
            detectedAt: det.detectedAt || captured,
            tunnel: d.tunnel,
            imageRef: archived && archived.image_id ? '/api/samples/image/' + archived.image_id : null,
            source: SEED_NOTE,
          });
        }
        count += (res.detections || []).length ? 1 : 0;
        byType[d.kind] = (byType[d.kind] || 0) + 1;
      } catch (e) {
        // 单条失败不影响其余播种（如某类未检出则该条自然不入库）
        console.log(`[演示数据] 跳过 ${d.kind}${d.level}级: ${e.message}`);
      }
    }
    return { seeded: count > 0, count, byType, note: SEED_NOTE };
  } catch (e) {
    return { seeded: false, reason: e.message };
  }
}

module.exports = { seedIfEmpty };

if (require.main === module) {
  const r = seedIfEmpty();
  console.log(JSON.stringify(r, null, 1));
}
