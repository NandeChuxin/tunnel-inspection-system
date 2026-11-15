'use strict';

const assert = require('assert');
const fusion = require('./fusion');

function roi(extra = {}) {
  return {
    bbox: [0.1, 0.1, 0.2, 0.2], angle: 0,
    edgeDensity: 0.7, darkRatio: 0.1, brightRatio: 0.1,
    textureVar: 0.2, hueShift: 0, lengthPx: 120, widthPx: 8,
    elongation: 8, fillRatio: 0.2, linearity: 0.9,
    ...extra,
  };
}

function analyze(r) {
  return fusion.analyze({
    tunnel: 'test', mileage: 0, sensors: {},
    image: { widthPx: 640, rois: [r] },
  }, { threshold: 0.55 }).detections[0];
}

try {
  fusion.setClassifier(() => ({ type: '裂缝', confidence: 0.7, probs: { 裂缝: 0.7 } }));

  const high = analyze(roi({ clsHint: '渗漏水', clsScore: 0.9 }));
  assert.equal(high.type, '渗漏水', '高置信 YOLO 应参与并主导判型');
  assert.equal(high.evidence.classifier, 'yolo');

  const conflict = analyze(roi({ clsHint: '渗漏水', clsScore: 0.5 }));
  assert.equal(conflict.type, '裂缝', '中置信冲突不应推翻特征分类');
  assert.match(conflict.evidence.conflict, /裂缝 vs yolo:渗漏水/);

  const agree = analyze(roi({ clsHint: '裂缝', clsScore: 0.5 }));
  assert.equal(agree.type, '裂缝');
  assert.match(agree.evidence.classifier, /\+yolo$/, '应记录 YOLO 与特征分类的一致证据');
  assert(agree.confidence > 0.7, '同类证据应提升融合置信度');

  console.log('fusion-yolo-test: 3/3 passed');
} finally {
  fusion.setClassifier(null);
}
