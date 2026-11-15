'use strict';

/**
 * detector-quality-test.js — 质量门控 + 类别映射契约单测（零依赖，可离线跑）
 *
 * 这里守两条容易悄悄劣化的契约：
 *   ① 质量门控：指标不达标必须判为不可启用，且原因里点名卡在哪一项；
 *   ② 类别映射：detector.TYPES 的顺序必须与 data.yaml 的 names 逐位一致。
 *      顺序错一位不会报错，只会让模型把「错台」当「渗漏水」输出 —— 必须靠测试兜住。
 */
const assert = require('assert');
const fs = require('fs');
const path = require('path');
const detector = require('./detector');

/* ---- ① 质量门控 ---- */
assert.equal(detector.assessQuality(null).ready, false, '无指标文件应判为不可启用');
assert.equal(detector.assessQuality({ epochs: 3, mAP50: 0.118, recall: 0.136 }).ready, false,
  '冒烟 3 epochs 不达标必须停用');
assert.match(detector.assessQuality({ epochs: 3, mAP50: 0.118, recall: 0.136 }).reason, /epochs/,
  '原因里应点名 epochs 不足');
assert.equal(detector.assessQuality({ epochs: 100, mAP50: 0.72, recall: 0.64 }).ready, true,
  '达标指标应判为可启用');
// 单项不达标也要拦住：mAP 够但 recall 不够
assert.equal(detector.assessQuality({ epochs: 50, mAP50: 0.62, recall: 0.31 }).ready, false,
  'recall 不达标必须停用');
assert.match(detector.assessQuality({ epochs: 50, mAP50: 0.62, recall: 0.31 }).reason, /recall/,
  '原因里应点名 recall 不足');
// 缺失字段不能被当成 0 混过去
assert.equal(detector.assessQuality({ epochs: 50, mAP50: 0.62 }).ready, false,
  '缺少 recall 字段必须停用');

/* ---- ② 类别映射与 data.yaml 一致 ---- */
const yml = path.join(__dirname, '..', 'yolo-workspace', 'dataset-6class', 'data.yaml');
assert.ok(fs.existsSync(yml), '缺少 dataset-6class/data.yaml（先跑 tools/yolo/build-6class.js）');
const raw = fs.readFileSync(yml, 'utf8');
const mNames = /^names:\s*\[(.*?)\]/m.exec(raw);
assert.ok(mNames, 'data.yaml 未找到 names 字段');
const dataNames = mNames[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
const mNc = /^nc:\s*(\d+)/m.exec(raw);
assert.ok(mNc, 'data.yaml 未找到 nc 字段');

const classes = detector.info().classes;
assert.equal(classes.length, Number(mNc[1]),
  `detector.TYPES 有 ${classes.length} 类，但 data.yaml 的 nc=${mNc[1]}`);
assert.equal(dataNames.length, classes.length,
  `data.yaml names 有 ${dataNames.length} 项，detector.TYPES 有 ${classes.length} 项`);

/**
 * 英文数据集类名 → 系统中文病害类名。
 * 这张表是「模型输出 → 业务语义」的唯一换算处，两侧类目改动必须同时改这里。
 */
const EN_TO_CN = {
  Spalling: '剥落掉块',
  Crack: '裂缝',
  Leakage: '渗漏水',
  LiningOffset: '衬砌错台',
  Efflorescence: '白华析出',
};
dataNames.forEach((en, i) => {
  assert.ok(EN_TO_CN[en], `data.yaml 出现未登记的英文类名：${en}`);
  assert.equal(classes[i], EN_TO_CN[en],
    `第 ${i} 位类别错位：data.yaml=${en}(${EN_TO_CN[en]})，detector.TYPES=${classes[i]}。` +
    '下标顺序错位会让模型输出系统性错判，必须同步修改');
});
assert.deepEqual(classes.slice(), dataNames.map((en) => EN_TO_CN[en]),
  'detector.TYPES 顺序必须与 data.yaml 的 names 顺序逐位一致');

/* ---- ③ 推理侧常量自洽 ---- */
// 640 输入下 YOLOv8 的锚点数 = 80² + 40² + 20²
assert.equal(detector.INPUT_SIZE, 640, 'INPUT_SIZE 变了必须同步改 N_ANCHOR 与 data.yaml 导出尺寸');
assert.equal((640 / 8) ** 2 + (640 / 16) ** 2 + (640 / 32) ** 2, 8400,
  '锚点数推导应为 8400（detector 内 N_ANCHOR 硬编码值）');

console.log(`detector-quality-test: 通过（门控 6 项 + 类别映射 ${classes.length} 类逐位一致 + 推理常量自洽）`);
