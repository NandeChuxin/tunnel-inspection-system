/**
 * tools/sync-real-to-ledger.js — 真实样本检出结果同步到 JSON 台账（离线执行）
 *
 * 背景：/api/detect/image 的自动入库只写 SQLite（image/detection 表，样本库可见）；
 * 但 /api/defects、/api/stats（台账/统计/复核）读 store.js JSON 台账。
 * 本脚本离线复跑 33 张真实图的推理（当前 model_params.json），把检出记录按主链路
 * 同构写入台账（type/level/position/physical/basis/evidence/suggestions 与 ingestFrame 产物对齐），
 * imageRef 关联 SQLite image_id；1 级轻微自动审核闭环（与主链路口径一致）。
 *
 * 附带清理：删除排查测试产生的重复 image 行（本批窗口之后、source='real' 的孤立行）。
 *
 * 前置：后端服务需先停止（避免内存态覆盖 JSON 台账）。
 * 用法：node tools/sync-real-to-ledger.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('../backend/store');
const infer = require('../backend/infer');
const fusion = require('../backend/fusion');
const model = require('../backend/model');

const REAL_DIR = path.join(__dirname, '..', 'backend', 'data', 'train-real');
const DB_FILE = path.join(__dirname, '..', 'backend', 'data', 'tunnel.db');
const LEVEL_LABEL = { 1: '1级-轻微', 2: '2级-中等', 3: '3级-严重', 4: '4级-危及安全' };

function main() {
  // ---- ① 注入与 server.js 相同的训练模型 ----
  const mp = model.loadFromFile(path.join(__dirname, '..', 'backend', 'data', 'model_params.json'));
  if (mp && mp.enabled) fusion.setClassifier(model.createPredictor(mp).classify);

  // ---- ② 从 SQLite 取本批 image_id（按 capture_time 升序 = manifest 导入顺序） ----
  const manifest = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'manifest.json'), 'utf-8'));
  const db = new DatabaseSync(DB_FILE, { readOnly: true });
  const rows = db.prepare("SELECT image_id, capture_time FROM image WHERE source='real' ORDER BY capture_time ASC").all();
  db.close();
  // 本批 33 张是连续时间窗：取最后 34 行里的前 33 行可抗干扰——更稳的做法：
  // 按时间排序后，末尾若多出 1 行（测试重复导入），它与倒数第 2 行时间差 > 60s，剔除。
  const last = rows[rows.length - 1];
  const filtered = rows.filter((r) => {
    const dt = (new Date(last.capture_time) - new Date(r.capture_time)) / 1000;
    return !(r.image_id === last.image_id && dt > 60);
  });
  const batch = filtered.slice(-manifest.length);
  if (batch.length !== manifest.length) {
    console.error(`!! image 行数不匹配：batch=${batch.length} manifest=${manifest.length}`);
    process.exit(1);
  }
  console.log(`本批 image_id：${batch[0].image_id} ~ ${batch[batch.length - 1].image_id}（共 ${batch.length}）`);

  // ---- ③ 复跑推理 + 写台账 ----
  const before = store.defects.length;
  let added = 0, autoApproved = 0, images = 0;
  manifest.forEach((m, idx) => {
    const b64 = fs.readFileSync(m.path).toString('base64');
    const res = infer.detectImage({ image: { dataUrl: 'data:image/png;base64,' + b64 }, tunnel: '真实数据集', mileage: 0 });
    images++;
    const imageRef = batch[idx].image_id;
    for (const d of res.detections) {
      const levelNo = d.levelNo || d.level || 2;
      const rec = store.addDefect({
        type: d.class_name,
        level: LEVEL_LABEL[levelNo] || LEVEL_LABEL[2],
        levelNo,
        confidence: d.confidence,
        position: { chainage: 'K0000+000', mileageM: 0, sector: '数据集样本', angleDeg: 0, bbox: d.bbox },
        physical: d.physical || null,
        basis: d.basis || [],
        evidence: d.evidence || null,
        suggestions: d.suggestions || [],
        status: '待审核',
        detectedAt: new Date().toISOString(),
        tunnel: '真实数据集',
        imageRef,
        frameId: null,
        source: '真实样本导入',
      });
      added++;
      if (rec.levelNo === 1) {
        store.updateDefect(rec.id, { status: '已审核', review: { by: '系统自动', decision: '通过', at: new Date().toISOString(), note: '真实样本导入 · 1级轻微自动闭环' } });
        autoApproved++;
      }
    }
    process.stdout.write(`\r${images}/${manifest.length}`);
  });
  console.log(`\n同步完成：新增台账 ${added} 条（1级自动闭环 ${autoApproved}）· 台账 ${before} → ${store.defects.length}`);

  // ---- ④ 清理排查测试的重复 image 行与其 detection 行 ----
  const wdb = new DatabaseSync(DB_FILE);
  const dup = wdb.prepare("SELECT image_id FROM image WHERE source='real' ORDER BY capture_time DESC LIMIT 1").get();
  if (dup && dup.image_id > batch[batch.length - 1].image_id) {
    wdb.prepare('DELETE FROM detection WHERE image_id=?').run(dup.image_id);
    wdb.prepare('DELETE FROM image WHERE image_id=?').run(dup.image_id);
    console.log(`已清理重复测试行 image#${dup.image_id}`);
  } else {
    console.log('无需清理（末行即本批最后一张）');
  }
  wdb.close();
}

main();
