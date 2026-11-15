/**
 * tools/math/_js_harness.js — 对拍桥（真实系统 ↔ Python 数学模型）
 *
 * 两种模式：
 *  1) 规则链路模式（默认）：用例自带 ROI 特征，走真实 classifyROI → gradeDefect 全链路
 *  2) 强制类型模式（--force-type=裂缝）：通过 setClassifier 注入桩分类器，
 *     把类型固定，从而单独隔离验证 gradeDefect（分级函数）在任意物理量取值下的输出
 *
 * 用法：node _js_harness.js cases.json out.json [--force-type=病害类型]
 */
const fs = require('fs');
const path = require('path');
const fusion = require(path.join(__dirname, '..', '..', 'backend', 'fusion.js'));

const inFile = process.argv[2];
const outFile = process.argv[3];
const forceArg = process.argv.find((a) => a.startsWith('--force-type='));
const FORCE = forceArg ? forceArg.split('=')[1] : null;

if (FORCE) {
  // 注入桩分类器（契约同 model.js：fn(roiFeatures, sensorEvidence) -> {type, confidence, ...}）
  fusion.setClassifier(() => ({ type: FORCE, score: 0.9, confidence: 0.9, margin: 0.5, scores: {} }));
}

const cases = JSON.parse(fs.readFileSync(inFile, 'utf8'));

const results = cases.map((c) => {
  const frame = {
    id: c.tag || 'case',
    tunnel: c.tunnel || '对拍隧道',
    mileage: 100,
    sensors: c.sensors || {},
    timestamp: '2026-09-16T00:00:00.000Z',
    image: { widthPx: c.imageW || 640, rois: [c.roi] },
  };
  const res = fusion.analyze(frame, { threshold: c.threshold ?? 0.5 });
  const d = res.detections[0] || null;
  return {
    tag: c.tag,
    nDetections: res.detections.length,
    detected: d ? d.type : null,
    subtype: d ? d.subtype : null,
    levelNo: d ? d.levelNo : null,
    level: d ? d.level : null,
    sector: d ? d.position.sector : null,
    physical: d ? d.physical : null,
    confidence: d ? d.confidence : null,
  };
});

fs.writeFileSync(outFile, JSON.stringify(results, null, 1), 'utf8');
console.log(JSON.stringify({
  ok: true, n: results.length, mode: FORCE ? `force:${FORCE}` : 'rules',
  classifier: fusion.getClassifier() ? 'injected' : 'builtin',
}));
