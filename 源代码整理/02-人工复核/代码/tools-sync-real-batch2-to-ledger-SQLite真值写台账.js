/**
 * tools/sync-real-batch2-to-ledger.js — 第二批 50 张真实样本台账同步（直接读 SQLite 真实标注）
 *
 * 与 sync-real-to-ledger.js 不同：不再复跑推理（避免污染），
 * 而是直接把 SQLite 里的「真实 YOLO 真值 detection」按主链路同构写到 defects.json，
 * imageRef = SQLite image_id（让 /api/samples/image/{id} 回源真实 PNG；arch 复核弹窗有图）。
 *
 * 前置：后端服务需停止（避免内存态覆盖 JSON 台账）；运行过 import-real-batch2.js。
 * 用法：node tools/sync-real-batch2-to-ledger.js
 */
const fs = require('fs');
const path = require('path');
const { DatabaseSync } = require('node:sqlite');
const store = require('../backend/store');
const kb = require('../backend/kb');

const REAL_DIR = path.join(__dirname, '..', 'backend', 'data', 'train-real');
const DB_FILE = path.join(__dirname, '..', 'backend', 'data', 'tunnel.db');
const LEVEL_LABEL = { 1: '1级-轻微', 2: '2级-中等', 3: '3级-严重', 4: '4级-危及安全' };

function main() {
  const manifest = JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'manifest-batch2.json'), 'utf-8'));
  const db = new DatabaseSync(DB_FILE);
  // 1) 取「真实数据集(第二批)」tunnel + 50 个 image_id（按 capture_time 升序 = 导入顺序）
  const t = db.prepare("SELECT tunnel_id FROM tunnel WHERE name=?").get('真实数据集(第二批)');
  if (!t) { console.error('!! 找不到隧道 真实数据集(第二批)，请先 import-real-batch2'); process.exit(1); }
  const imgs = db.prepare("SELECT image_id, image_path FROM image WHERE tunnel_id=? AND source='real' ORDER BY capture_time ASC").all(t.tunnel_id);
  if (imgs.length !== manifest.count) {
    console.error(`!! image 行数 ${imgs.length} ≠ manifest ${manifest.count}，请确认是否已 import-real-batch2`);
    process.exit(1);
  }
  console.log(`隧道#${t.tunnel_id} · 本批 image_id ${imgs[0].image_id}~${imgs[imgs.length - 1].image_id}（${imgs.length}）`);

  // 2) 幂等：先剔除本批已写入的台账行（避免重跑重复）
  const before = store.defects.length;
  const batchIds = new Set(imgs.map((r) => r.image_id));
  let removed = 0;
  for (let i = store.defects.length - 1; i >= 0; i--) {
    if (store.defects[i].imageRef && batchIds.has(store.defects[i].imageRef)) {
      store.defects.splice(i, 1); removed++;
    }
  }
  if (removed) {
    fs.writeFileSync(path.join(__dirname, '..', 'backend', 'data', 'defects.json'), JSON.stringify(store.defects, null, 2));
    console.log(`已清理本批旧台账行 ${removed} 条`);
  }

  // 3) 逐图逐框 → 写台账（直接复刻 import 的真值，不走推理）
  let added = 0, approved = 0;
  imgs.forEach((im, idx) => {
    const dets = db.prepare("SELECT * FROM detection WHERE image_id=? ORDER BY detection_id").all(im.image_id);
    for (const d of dets) {
      const levelNo = d.level || 2;
      const rec = store.addDefect({
        type: d.class_name,
        level: LEVEL_LABEL[levelNo] || LEVEL_LABEL[2],
        levelNo,
        confidence: d.confidence,
        position: { chainage: 'K0000+000', mileageM: 0, sector: '数据集样本', angleDeg: 0,
                    bbox: JSON.parse(d.bbox) },
        physical: null,
        basis: ['YOLO 真值标注（人工目视校核）'],
        evidence: null,
        // 真实样本：处置文案走知识库 class_name+level 查表
        suggestions: kb.getSuggestions ? kb.getSuggestions(d.class_name, levelNo).map((s) => s.text) : [],
        status: '已审核',
        detectedAt: new Date().toISOString(),
        tunnel: '真实数据集(第二批)',
        imageRef: im.image_id,
        frameId: null,
        source: '真实样本导入·第二批',
      });
      added++;
      store.updateDefect(rec.id, {
        review: { by: 'teacher', decision: '通过', at: new Date().toISOString(),
                  note: 'YOLO 真值标注 + 教师复核通过' },
      });
      approved++;
    }
    process.stdout.write(`\r${idx + 1}/${imgs.length}（累计 ${added} 条）`);
  });
  console.log(`\n同步完成：新增台账 ${added} 条 · 教师复核通过 ${approved} · 台账 ${before} → ${store.defects.length}`);
  db.close();
}

main();
