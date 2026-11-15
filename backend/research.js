/**
 * research.js — 科研工作流支撑层（零依赖）
 *
 * 1) 实验追踪台账：每次训练/评测/批量推理自动登记（数据集指纹 + 超参 + 核心指标），
 *    JSON 落盘 backend/data/experiments.json（不进 SQLite schema，避免公共表规格变动）。
 * 2) 数据集版本指纹：真实域与合成域样本数 + 清单哈希前 8 位，保证实验可复现可比对。
 * 3) 报告聚合：汇总 metrics.json / eval-real.json / 实验台账 → 供科研评测报告生成。
 *
 * 接口：GET /api/research/experiments（台账，最新在前）
 *       GET /api/research/report     （聚合数据）
 */
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const DATA_DIR = path.join(__dirname, 'data');
const LOG_FILE = path.join(DATA_DIR, 'experiments.json');
const TRAIN_REAL = path.join(DATA_DIR, 'train-real', 'labels.json');
const TRAIN_SYNTH = path.join(DATA_DIR, 'train', 'labels.json');
const METRICS_FILE = path.join(DATA_DIR, 'train', 'metrics.json');
const EVAL_REAL_FILE = path.join(DATA_DIR, 'train-real', 'eval-real.json');

/* ---------------- 实验台账 ---------------- */
function loadLog() {
  try { return JSON.parse(fs.readFileSync(LOG_FILE, 'utf-8')); }
  catch (e) { return []; }
}
function saveLog(log) {
  const tmp = LOG_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(log, null, 1));
  fs.renameSync(tmp, LOG_FILE);
}

/**
 * 登记一条实验记录
 * @param {object} rec {kind, label, params, metrics, artifacts}
 * @returns {object} 含 exp_id 的完整记录
 */
function addExperiment(rec) {
  const log = loadLog();
  const entry = Object.assign({
    exp_id: 'EXP-' + String(log.length + 1).padStart(4, '0'),
    ts: new Date().toISOString(),
    dataset: datasetFingerprint(),
  }, rec);
  log.push(entry);
  saveLog(log);
  return entry;
}

/** 台账（最新在前，可限条数） */
function listExperiments(limit) {
  const log = loadLog().slice().reverse();
  return { total: log.length, items: typeof limit === 'number' ? log.slice(0, limit) : log };
}

/* ---------------- 数据集版本指纹 ---------------- */
function datasetFingerprint() {
  const fp = {};
  try {
    const real = JSON.parse(fs.readFileSync(TRAIN_REAL, 'utf-8'));
    fp.real = real.items.length;
    fp.realHash = hashOf(real.items.map((i) => i.file).join(','));
  } catch (e) { fp.real = 0; }
  try {
    const syn = JSON.parse(fs.readFileSync(TRAIN_SYNTH, 'utf-8'));
    fp.synthetic = syn.items.length;
  } catch (e) { fp.synthetic = 0; }
  fp.tag = 'r' + fp.real + '-s' + fp.synthetic + '-' + (fp.realHash || 'na').slice(0, 8);
  return fp;
}
function hashOf(s) {
  return crypto.createHash('md5').update(s).digest('hex');
}

/* ---------------- 训练指标 → 实验记录 ---------------- */
/**
 * 从 train.js 的 metrics 提取科研关心的核心指标并登记
 * @param {object} metrics train.main() 返回/落盘的 metrics
 * @param {object} extra {kind, label, params}
 */
function addFromTrainMetrics(metrics, extra = {}) {
  const learned = metrics.learned || {};
  const defect = learned.defect || {};
  return addExperiment(Object.assign({
    kind: extra.kind || 'train',
    label: extra.label || '混合训练（合成 + 真实域上采样）',
    params: Object.assign({ threshold: learned.threshold }, extra.params || {}),
    metrics: {
      typeAcc: round4(learned.acc),
      macroF1: round4(learned.macroF1),
      defectF1: round4(defect.f1),
      precision: round4(defect.precision),
      recall: round4(defect.recall),
      levelAcc: round4(metrics.learned && metrics.learned.levelAcc),
      proposalRecall: round4(metrics.proposalRecall),
      rulesBaselineF1: round4(metrics.rulesBaseline && metrics.rulesBaseline.defect ? metrics.rulesBaseline.defect.f1 : null),
      valRois: metrics.valRois, trainRois: metrics.trainRois,
    },
    artifacts: { model: 'data/model_params.json', metrics: 'data/train/metrics.json' },
  }, extra.fields || {}));
}
function round4(v) { return typeof v === 'number' ? Math.round(v * 10000) / 10000 : v; }

/* ---------------- 科研报告聚合 ---------------- */
function aggregateReport() {
  const out = { generatedAt: new Date().toISOString(), dataset: datasetFingerprint() };
  try { out.trainMetrics = JSON.parse(fs.readFileSync(METRICS_FILE, 'utf-8')); } catch (e) { out.trainMetrics = null; }
  try { out.evalReal = JSON.parse(fs.readFileSync(EVAL_REAL_FILE, 'utf-8')); } catch (e) { out.evalReal = null; }
  out.experiments = loadLog().slice().reverse();
  // 模型文件版本
  try {
    const p = JSON.parse(fs.readFileSync(path.join(DATA_DIR, 'model_params.json'), 'utf-8'));
    out.modelVersion = { trainedAt: p.meta && p.meta.trainedAt, threshold: p.threshold, enabled: p.enabled,
      classes: p.classes, epochs: p.meta && p.meta.epochs };
  } catch (e) { out.modelVersion = null; }
  return out;
}

/* ---------------- 科研评测报告（Markdown + Excel，CLI 与 HTTP 共用） ---------------- */
function _pc(v) { return typeof v === 'number' ? (v * 100).toFixed(1) + '%' : '--'; }
function _cmp(a, b) { return (typeof a === 'number' && typeof b === 'number' && a > 0 ? '+' + ((b - a) / a * 100).toFixed(0) + '%' : '--'); }

/** 聚合数据 → Markdown 报告文本 */
function reportMarkdown(agg) {
  const tm = agg.trainMetrics || {};
  const L = tm.learned || {}, RB = tm.rulesBaseline || {};
  const ds = agg.dataset, mv = agg.modelVersion || {};
  const md = [];
  md.push('# 隧途明鉴 · 隧道病害智能检测系统 —— 科研评测报告');
  md.push('');
  md.push(`> 生成时间：${agg.generatedAt} · 数据集指纹：\`${ds.tag}\`（真实域 ${ds.real} 张 / 合成域 ${ds.synthetic} 张）`);
  md.push(`> 模型版本：trainedAt=${mv.trainedAt || '--'} · epochs=${mv.epochs || '--'} · threshold=${mv.threshold || '--'} · 类别=${(mv.classes || []).slice(1).join('/')}`);
  md.push('');
  md.push('## 1. 验证集总体指标（ROI 级，6 分类含背景）');
  md.push('');
  md.push('| 指标 | 规则引擎基线 | 训练模型 | 提升幅度 |');
  md.push('|---|---|---|---|');
  md.push(`| 类型准确率 | ${_pc(RB.acc)} | ${_pc(L.acc)} | ${_cmp(RB.acc, L.acc)} |`);
  md.push(`| 病害宏 F1 | ${_pc(RB.macroF1)} | ${_pc(L.macroF1)} | ${_cmp(RB.macroF1, L.macroF1)} |`);
  md.push(`| 病害二分类 F1 | ${_pc(RB.defect && RB.defect.f1)} | ${_pc(L.defect && L.defect.f1)} | ${_cmp(RB.defect && RB.defect.f1, L.defect && L.defect.f1)} |`);
  md.push(`| ├ 查准率 P | ${_pc(RB.defect && RB.defect.precision)} | ${_pc(L.defect && L.defect.precision)} | |`);
  md.push(`| └ 查全率 R | ${_pc(RB.defect && RB.defect.recall)} | ${_pc(L.defect && L.defect.recall)} | |`);
  md.push(`| 等级准确率（严格） | ${(tm.levelMajorityBaseline ? tm.levelMajorityBaseline.acc * 100 : 0).toFixed(1)}%（多数类基线） | ${_pc(L.levelAcc)} | |`);
  md.push(`| 候选召回（GT 覆盖） | ${_pc(tm.proposalRecall)} | | |`);
  md.push(`| 样本规模 | train ${tm.trainRois || '--'} / val ${tm.valRois || '--'} ROI | | |`);
  md.push('');
  md.push('## 2. 真实域专项评测');
  md.push('');
  if (agg.evalReal) {
    const er = agg.evalReal;
    md.push(`> 端到端评测（IoU≥${er.iouTh}）· ${er.images} 张真实图 · 评测时间 ${(er.evaluatedAt || '').slice(0, 10)}`);
    md.push('');
    md.push('| 指标 | 规则引擎 | 训练模型 |');
    md.push('|---|---|---|');
    md.push(`| 病害检出 F1（图级） | ${_pc(er.rules && er.rules.f1)} | ${_pc(er.learned && er.learned.f1)} |`);
    md.push(`| 查准率 P | ${_pc(er.rules && er.rules.precision)} | ${_pc(er.learned && er.learned.precision)} |`);
    md.push(`| 查全率 R | ${_pc(er.rules && er.rules.recall)} | ${_pc(er.learned && er.learned.recall)} |`);
    md.push(`| 检出框平均 IoU | ${er.rules ? er.rules.meanIoU.toFixed(3) : '--'} | ${er.learned ? er.learned.meanIoU.toFixed(3) : '--'} |`);
    md.push('');
    const rows = er.learned && er.learned.perClass ? Object.entries(er.learned.perClass) : [];
    if (rows.length) {
      md.push('**按类别（训练模型）**：');
      md.push('');
      md.push('| 类别 | TP | FP | FN | P | R | F1 |');
      md.push('|---|---|---|---|---|---|---|');
      for (const [cls, s] of rows) md.push(`| ${cls} | ${s.tp} | ${s.fp} | ${s.fn} | ${_pc(s.P)} | ${_pc(s.R)} | ${_pc(s.f1)} |`);
    }
  } else {
    md.push('（eval-real.json 未找到——运行 backend/train/eval-real.js 生成）');
  }
  md.push('');
  md.push('## 3. 实验台账（最近 ' + Math.min(10, agg.experiments.length) + ' 次 / 共 ' + agg.experiments.length + ' 次）');
  md.push('');
  md.push('| 实验号 | 时间 | 类型 | 说明 | 数据集指纹 | 核心指标 |');
  md.push('|---|---|---|---|---|---|');
  for (const e of agg.experiments.slice(0, 10)) {
    const core = Object.entries(e.metrics || {}).filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}=${typeof v === 'number' && v < 1 ? v.toFixed(3) : v}`).slice(0, 4).join(' ');
    md.push(`| ${e.exp_id} | ${(e.ts || '').slice(0, 16).replace('T', ' ')} | ${e.kind} | ${e.label} | ${(e.dataset && e.dataset.tag) || '--'} | ${core} |`);
  }
  md.push('');
  md.push('## 4. 知识工程产出（感知 + 知识推理一体化）');
  md.push('');
  md.push('- 领域本体：10 类实体 / 13 类关系，123 实体 / 211 关系（规范条款结构化入库）');
  md.push('- 闭环推理：病害 → 等级判定依据（特征阈值 + 条款）→ 成因（先验排序）→ 结构危害 → 养护方案（措施/窗口/周期）');
  md.push('- 交叉验证：感知定级与图谱阈值定级不一致时输出「建议人工复核」（置信度闸）');
  return md.join('\n');
}

/** 聚合数据 → Excel buffer（评测总览 + 实验台账 两 Sheet） */
function reportXlsx(agg) {
  const { buildXlsx } = require('./xlsx');
  const tm = agg.trainMetrics || {};
  const L = tm.learned || {}, RB = tm.rulesBaseline || {};
  const ds = agg.dataset, mv = agg.modelVersion || {};
  const overview = [
    [{ v: '隧途明鉴 —— 科研评测报告' }, '', '', ''],
    ['生成时间', agg.generatedAt.slice(0, 19).replace('T', ' '), '数据集指纹', ds.tag],
    ['真实域样本', ds.real, '合成域样本', ds.synthetic],
    ['模型 trainedAt', mv.trainedAt || '--', 'threshold', mv.threshold != null ? mv.threshold : '--'],
    ['', '', '', ''],
    [{ v: '指标', header: 1 }, { v: '规则引擎基线', header: 1 }, { v: '训练模型', header: 1 }, { v: '提升', header: 1 }],
    ['类型准确率', _pc(RB.acc), _pc(L.acc), _cmp(RB.acc, L.acc)],
    ['病害宏 F1', _pc(RB.macroF1), _pc(L.macroF1), _cmp(RB.macroF1, L.macroF1)],
    ['病害二分类 F1', _pc(RB.defect && RB.defect.f1), _pc(L.defect && L.defect.f1), _cmp(RB.defect && RB.defect.f1, L.defect && L.defect.f1)],
    ['查准率 P', _pc(RB.defect && RB.defect.precision), _pc(L.defect && L.defect.precision), ''],
    ['查全率 R', _pc(RB.defect && RB.defect.recall), _pc(L.defect && L.defect.recall), ''],
    ['等级准确率（严格）', (tm.levelMajorityBaseline ? tm.levelMajorityBaseline.acc * 100 : 0).toFixed(1) + '%（基线）', _pc(L.levelAcc), ''],
    ['候选召回', _pc(tm.proposalRecall), '', ''],
  ];
  const expRows = [['实验号', '时间', '类型', '说明', '真实域样本', '合成域样本', '核心指标'].map((h) => ({ v: h, header: 1 }))];
  for (const e of agg.experiments) {
    const core = Object.entries(e.metrics || {}).filter(([, v]) => typeof v === 'number')
      .map(([k, v]) => `${k}=${typeof v === 'number' && v < 1 ? v.toFixed(3) : v}`).join(' ');
    expRows.push([e.exp_id, (e.ts || '').replace('T', ' ').slice(0, 19), e.kind, e.label,
      (e.dataset && e.dataset.real) || '', (e.dataset && e.dataset.synthetic) || '', core]);
  }
  return buildXlsx([
    { name: '评测总览', rows: overview, widths: [22, 24, 24, 14] },
    { name: '实验台账', rows: expRows, widths: [12, 20, 12, 46, 12, 12, 60] },
  ]);
}

module.exports = { addExperiment, listExperiments, addFromTrainMetrics, datasetFingerprint, aggregateReport, reportMarkdown, reportXlsx };
