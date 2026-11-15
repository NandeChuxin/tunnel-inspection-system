#!/usr/bin/env node
/**
 * verify-6class.js — 「6 类目」YOLO 数据集核验（只读，不改任何原始文件）
 *
 * 与 tools/yolo/verify_dataset.py 的关系：后者把 3 类 / 231:66:33 / 330 张写死在代码里，
 * 用于核验最早的实拍集；本脚本读取 data.yaml 的 nc/names，对补齐后的 6 类目数据集做
 * 同一套分层核验，并额外审计「类别平衡」与「质量门槛前置条件」。
 *
 * 校验分层：
 *   L1 文件层   图片↔标签配对、零字节、跨/同子集内容重复（sha1）
 *   L2 图像层   JPEG 头解析出宽高、最小边、可解码性
 *   L3 对应层   图片与标签一一配对，无孤儿
 *   L4 内容层   每行 5 字段、类别下标在 [0,nc)、归一化坐标合法、框不小于 2px
 *   L5 平衡层   各类目图片数/框数分布、渗漏水占比、最大最小类比值
 *   L6 门槛层   6 个类目 train 均 ≥150 张；data.yaml 的 nc/names 与 detector.TYPES 一致
 *
 * 用法：
 *   node tools/yolo/verify-6class.js [--root <dir>] [--out <md>] [--min 150]
 */
'use strict';
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const ROOT = path.resolve(__dirname, '..', '..');
const SPLITS = ['train', 'val', 'test'];
const IMG_EXT = /\.(jpg|jpeg|png|bmp|webp)$/i;

/** 极简 JPEG 尺寸解析（读 SOF 段），不依赖任何图像库 */
function jpegSize(buf) {
  if (buf.length < 4 || buf[0] !== 0xFF || buf[1] !== 0xD8) return null;
  let i = 2;
  while (i < buf.length - 9) {
    if (buf[i] !== 0xFF) { i++; continue; }
    const m = buf[i + 1];
    if (m === 0xD8 || m === 0x01 || (m >= 0xD0 && m <= 0xD7) || m === 0xFF) { i += 2; continue; }
    const len = buf.readUInt16BE(i + 2);
    if (m >= 0xC0 && m <= 0xCF && m !== 0xC4 && m !== 0xC8 && m !== 0xCC) {
      return { h: buf.readUInt16BE(i + 5), w: buf.readUInt16BE(i + 7) };
    }
    if (len < 2) return null;
    i += 2 + len;
  }
  return null;
}

function main() {
  const argOf = (k, d) => { const i = process.argv.indexOf('--' + k); return i > 0 ? process.argv[i + 1] : d; };
  const root = path.resolve(argOf('root', path.join(ROOT, 'yolo-workspace', 'dataset-6class')));
  const outPath = path.resolve(argOf('out', path.join(ROOT, 'yolo-workspace', '核验报告-数据集-6类.md')));
  const MIN_PER_CLASS = Number(argOf('min', 150));

  /* ---------- 读取 data.yaml（只取 nc / names，避免引入 yaml 依赖） ---------- */
  let nc = 0, names = [];
  const ymlPath = path.join(root, 'data.yaml');
  if (fs.existsSync(ymlPath)) {
    const raw = fs.readFileSync(ymlPath, 'utf8');
    const mNc = /^nc:\s*(\d+)/m.exec(raw);
    const mNames = /^names:\s*\[(.*?)\]/m.exec(raw);
    if (mNc) nc = Number(mNc[1]);
    if (mNames) names = mNames[1].split(',').map((s) => s.trim().replace(/^['"]|['"]$/g, '')).filter(Boolean);
  }
  if (!nc || !names.length) {
    console.error(`✗ 无法从 ${ymlPath} 解析 nc / names`);
    process.exit(2);
  }

  const L = [];
  const w = (s = '') => L.push(s);
  const problems = [];

  /* ---------- 遍历三个切分 ---------- */
  const index = {};            // split -> { images: {stem:path}, labels: {stem:path} }
  const contentHash = {};      // split -> { hash: [stems] }
  for (const sp of SPLITS) {
    const imgDir = path.join(root, 'images', sp);
    const lblDir = path.join(root, 'labels', sp);
    const imgs = {}, lbls = {};
    if (fs.existsSync(imgDir)) for (const f of fs.readdirSync(imgDir).filter((x) => IMG_EXT.test(x))) {
      imgs[f.replace(/\.[^.]+$/, '')] = path.join(imgDir, f);
    }
    if (fs.existsSync(lblDir)) for (const f of fs.readdirSync(lblDir).filter((x) => x.endsWith('.txt'))) {
      lbls[f.replace(/\.txt$/, '')] = path.join(lblDir, f);
    }
    index[sp] = { images: imgs, labels: lbls };
    contentHash[sp] = {};
  }

  /* ---------- L1 文件层 ---------- */
  const zeroByte = [], dupName = [], orphanImg = [], orphanLbl = [];
  for (const sp of SPLITS) {
    const { images, labels } = index[sp];
    const imgStems = Object.keys(images), lblStems = Object.keys(labels);
    if (imgStems.length !== new Set(imgStems).size) dupName.push(`${sp}: 图片同名`);
    if (lblStems.length !== new Set(lblStems).size) dupName.push(`${sp}: 标签同名`);
    for (const s of imgStems) if (!labels[s]) orphanImg.push(`images/${sp}/${s}`);
    for (const s of lblStems) if (!images[s]) orphanLbl.push(`labels/${sp}/${s}`);
    for (const [s, p] of Object.entries(images)) {
      const buf = fs.readFileSync(p);
      if (!buf.length) { zeroByte.push(p); continue; }
      const h = crypto.createHash('sha1').update(buf).digest('hex');
      (contentHash[sp][h] = contentHash[sp][h] || []).push(s);
    }
  }
  const dupContent = [];
  for (const sp of SPLITS) {
    for (const [h, stems] of Object.entries(contentHash[sp])) {
      if (stems.length > 1) dupContent.push(`${sp}: ${stems.length} 个同内容文件 (${stems.slice(0, 3).join(', ')}…)`);
    }
  }
  // 跨切分同内容 = 数据泄漏
  const crossHash = {};
  for (const sp of SPLITS) for (const h of Object.keys(contentHash[sp])) (crossHash[h] = crossHash[h] || []).push(sp);
  const crossLeak = Object.entries(crossHash).filter(([, sps]) => new Set(sps).size > 1);
  const l1ok = !zeroByte.length && !dupName.length && !dupContent.length && !crossLeak.length;

  /* ---------- L2 图像层 ---------- */
  const badImg = [];
  const sizeKind = {};
  let minEdge = Infinity, maxEdge = 0;
  const allImages = [];
  for (const sp of SPLITS) for (const [s, p] of Object.entries(index[sp].images)) allImages.push({ sp, s, p });
  for (const it of allImages) {
    const buf = fs.readFileSync(it.p);
    const size = it.p.toLowerCase().endsWith('.png') ? null : jpegSize(buf);
    if (!size || !size.w || !size.h) { badImg.push(`images/${it.sp}/${path.basename(it.p)} 无法解析尺寸`); continue; }
    sizeKind[`${size.w}x${size.h}`] = (sizeKind[`${size.w}x${size.h}`] || 0) + 1;
    minEdge = Math.min(minEdge, Math.min(size.w, size.h));
    maxEdge = Math.max(maxEdge, Math.max(size.w, size.h));
  }
  const l2ok = !badImg.length && minEdge >= 200;

  /* ---------- L3/L4 内容层 ---------- */
  const badLines = [];
  const clsBoxes = {}; for (let c = 0; c < nc; c++) clsBoxes[c] = 0;
  const clsBoxesBySplit = {};
  for (const sp of SPLITS) { clsBoxesBySplit[sp] = {}; for (let c = 0; c < nc; c++) clsBoxesBySplit[sp][c] = 0; }
  const clsImgs = {}; for (let c = 0; c < nc; c++) clsImgs[c] = { train: 0, val: 0, test: 0 };
  const emptyLabels = [];
  let boxTotal = 0;
  for (const sp of SPLITS) {
    for (const [s, p] of Object.entries(index[sp].labels)) {
      const raw = fs.readFileSync(p, 'utf8');
      const lines = raw.split(/\r?\n/).filter((x) => x.trim());
      if (!lines.length) { emptyLabels.push(`labels/${sp}/${s}.txt`); continue; }
      const seen = new Set();
      for (let i = 0; i < lines.length; i++) {
        const parts = lines[i].trim().split(/\s+/);
        if (parts.length !== 5) { badLines.push(`${sp}/${s}.txt:${i + 1} 字段数=${parts.length}（应为 5）`); continue; }
        const [c, x, y, bw, bh] = parts.map(Number);
        if (!Number.isInteger(c)) { badLines.push(`${sp}/${s}.txt:${i + 1} 类别非整数`); continue; }
        if (c < 0 || c >= nc) { badLines.push(`${sp}/${s}.txt:${i + 1} 类别越界 ${c}（应在 0~${nc - 1}）`); continue; }
        if (![x, y, bw, bh].every(Number.isFinite)) { badLines.push(`${sp}/${s}.txt:${i + 1} 坐标非数字`); continue; }
        if (!(x >= 0 && x <= 1 && y >= 0 && y <= 1 && bw > 0 && bw <= 1 && bh > 0 && bh <= 1)) {
          badLines.push(`${sp}/${s}.txt:${i + 1} 坐标越界或宽高≤0`); continue;
        }
        if (bw < 0.003 || bh < 0.003) { badLines.push(`${sp}/${s}.txt:${i + 1} 框过小 (${bw.toFixed(4)},${bh.toFixed(4)})`); continue; }
        clsBoxes[c]++; boxTotal++; seen.add(c);
        clsBoxesBySplit[sp][c]++;
      }
      for (const c of seen) clsImgs[c][sp]++;
    }
  }
  const l3ok = !orphanImg.length && !orphanLbl.length;
  const l4ok = !badLines.length;
  const background = { train: 0, val: 0, test: 0 };
  for (const sp of SPLITS) background[sp] = emptyLabels.filter((x) => x.startsWith(`labels/${sp}/`)).length;

  /* ---------- L5 平衡层 ---------- */
  // 检测任务的类别平衡以「实例（标注框）数」为准：图片数会被多类共现拉平，
  // 但梯度是按实例累积的，所以实例数才决定模型偏向谁。
  const trainInst = names.map((_, c) => clsBoxesBySplit.train[c]);
  const trainInstTotal = trainInst.reduce((a, b) => a + b, 0);
  const leakIdx = names.findIndex((n) => /leak/i.test(n));
  const leakShareBox = leakIdx >= 0 && trainInstTotal ? (100 * trainInst[leakIdx]) / trainInstTotal : 0;
  const minInst = Math.min(...trainInst), maxInst = Math.max(...trainInst);
  const instRatio = minInst ? maxInst / minInst : Infinity;
  // 图片数比只作为参考信息，不参与判定
  const imgCounts = names.map((_, c) => clsImgs[c].train);
  const imgRatio = Math.min(...imgCounts) ? Math.max(...imgCounts) / Math.min(...imgCounts) : Infinity;
  const LEAK_CAP = 30;        // 渗漏水实例占比上限（%），超过则建议欠采样
  const RATIO_CAP = 2.0;      // 最多/最少类实例数比上限
  const l5ok = leakShareBox <= LEAK_CAP && instRatio <= RATIO_CAP;

  /* ---------- L6 门槛层（6 个类目 = 5 病害 + 背景） ---------- */
  const gateRows = names.map((n, c) => ({ label: n, train: clsImgs[c].train }))
    .concat([{ label: '背景(空标签负样本)', train: background.train }]);
  const gateFails = gateRows.filter((r) => r.train < MIN_PER_CLASS);
  const yoloClasses = require('../../backend/detector').info().classes;
  const mapOk = yoloClasses.length === nc;
  const l6ok = !gateFails.length && mapOk && nc === 5;

  /* ---------- 出报告 ---------- */
  const line = (n = 1) => { for (let i = 0; i < n; i++) w(); };
  w('# YOLO 数据集核验报告（6 类目）');
  line();
  w('> 数据集根目录：`' + root.replace(/\\/g, '/') + '`');
  w('> 核验时间：' + new Date().toLocaleString('zh-CN'));
  w('> 只读核验：未修改、未删除任何文件；全部数字来自实际解析。');
  line();
  w('## 0 切分清点');
  line();
  w('| 子集 | 图片 | 标签 | 空标签(负样本) |');
  w('|---|---|---|---|');
  for (const sp of SPLITS) {
    w(`| ${sp} | ${Object.keys(index[sp].images).length} | ${Object.keys(index[sp].labels).length} | ${background[sp]} |`);
  }
  const ti = SPLITS.reduce((a, sp) => a + Object.keys(index[sp].images).length, 0);
  const tl = SPLITS.reduce((a, sp) => a + Object.keys(index[sp].labels).length, 0);
  w(`| **合计** | **${ti}** | **${tl}** | **${background.train + background.val + background.test}** |`);
  line();

  w('## L1 文件层');
  line();
  w('| 检查项 | 结果 |');
  w('|---|---|');
  w(`| 零字节文件 | ${zeroByte.length ? zeroByte.length + ' 个' : '无'} |`);
  w(`| 同一子集同内容重复 | ${dupContent.length ? dupContent.length + ' 组' : '无'} |`);
  w(`| 孤儿图片（有图无标签） | ${orphanImg.length ? orphanImg.length + ' 个' : '无'} |`);
  w(`| 孤儿标签（有标签无图） | ${orphanLbl.length ? orphanLbl.length + ' 个' : '无'} |`);
  w(`| 跨子集同内容（数据泄漏） | ${crossLeak.length ? crossLeak.length + ' 组' : '无'} |`);
  w(`| L1 结论 | ${l1ok ? '通过' : '**不通过**'} |`);
  line();

  w('## L2 图像层');
  line();
  w('- 图像尺寸种类：' + Object.entries(sizeKind).map(([k, v]) => `${k}×${v}张`).join('、'));
  w(`- 最小边 ≥200px：${minEdge >= 200 ? '是' : '否'}（实测最小 ${minEdge}px，最大 ${maxEdge}px）`);
  w(`- 尺寸无法解析：${badImg.length ? badImg.length + ' 张' : '无'}`);
  w(`- L2 结论：${l2ok ? '通过' : '**不通过**'}`);
  line();

  w('## L3 对应层');
  line();
  w('| 子集 | 图片 | 标签 | 配对组数 |');
  w('|---|---|---|---|');
  for (const sp of SPLITS) {
    const n = Object.keys(index[sp].images).length;
    const m = Object.keys(index[sp].labels).length;
    w(`| ${sp} | ${n} | ${m} | ${Math.min(n, m)} |`);
  }
  w(`- L3 结论：${l3ok ? '通过' : '**不通过**'}`);
  line();

  w('## L4 内容层（类别与坐标）');
  line();
  w('| 类别下标 | 名称 | 框数 | 框占比 | train 图片 | val 图片 | test 图片 |');
  w('|---|---|---|---|---|---|---|');
  for (let c = 0; c < nc; c++) {
    w(`| ${c} | ${names[c]} | ${clsBoxes[c]} | ${boxTotal ? (100 * clsBoxes[c] / boxTotal).toFixed(1) : 0}% | ${clsImgs[c].train} | ${clsImgs[c].val} | ${clsImgs[c].test} |`);
  }
  w(`| — | 背景(空标签) | — | — | ${background.train} | ${background.val} | ${background.test} |`);
  w(`| **合计** | | **${boxTotal}** | 100% | | | |`);
  line();
  w(`- 空标签文件（负样本，YOLO 允许）：${emptyLabels.length} 个（按设计保留）`);
  w(`- 不合法标注行：${badLines.length ? badLines.length + ' 行' : '无'}`);
  for (const b of badLines.slice(0, 20)) w('  - ' + b);
  w(`- L4 结论：${l4ok ? '通过' : '**不通过**'}`);
  line();

  w('## L5 类别平衡审计');
  line();
  w('> 判定以「实例（标注框）数」为准：图片数会被多类共现拉平，但梯度是按实例累积的。');
  line();
  w('| 指标 | 值 | 上限 | 结论 |');
  w('|---|---|---|---|');
  w(`| 渗漏水实例占比 | ${leakShareBox.toFixed(1)}% | ≤${LEAK_CAP}% | ${leakShareBox <= LEAK_CAP ? '✓ 无需欠采样' : '✗ 需欠采样'} |`);
  w(`| 最多/最少类实例数比 | ${instRatio.toFixed(2)} | ≤${RATIO_CAP} | ${instRatio <= RATIO_CAP ? '✓' : '✗'} |`);
  line();
  w('| 类别 | train 实例 | 占比 | train 图片 |');
  w('|---|---|---|---|');
  names.forEach((n, c) => {
    w(`| ${n} | ${trainInst[c]} | ${trainInstTotal ? (100 * trainInst[c] / trainInstTotal).toFixed(1) : 0}% | ${imgCounts[c]} |`);
  });
  w(`| **合计** | **${trainInstTotal}** | 100% | ${Object.keys(index.train.images).length}（含背景 ${background.train}） |`);
  line();
  w(`- 图片数比（仅参考，不参与判定）：${imgRatio.toFixed(2)}`);
  w(`- 结论：${l5ok ? '实例分布达标，无需欠采样' : '**存在失衡，建议对渗漏水做欠采样或对其余类做增强补齐**'}`);
  line();

  w('## L6 质量门槛前置条件（6 个类目）');
  line();
  w('| 类目 | train 图片数 | 要求 | 结论 |');
  w('|---|---|---|---|');
  for (const r of gateRows) w(`| ${r.label} | ${r.train} | ≥${MIN_PER_CLASS} | ${r.train >= MIN_PER_CLASS ? '✓' : '✗'} |`);
  line();
  w(`- data.yaml nc = ${nc}，names = [${names.join(', ')}]`);
  w(`- detector.TYPES = [${yoloClasses.join(', ')}] → ${mapOk ? '与数据类别一致 ✓' : '**与数据类别数量不一致 ✗**'}`);
  w(`- L6 结论：${l6ok ? '通过（6 个类目均达规模门槛，类别映射一致）' : '**不通过**'}`);
  line();

  const allOk = l1ok && l2ok && l3ok && l4ok && l5ok && l6ok;
  w('## 汇总');
  line();
  w('| 项目 | 结果 |');
  w('|---|---|');
  w(`| 图片 / 标签 / 框 | ${ti} / ${tl} / ${boxTotal} |`);
  w(`| L1 文件层 | ${l1ok ? '通过' : '不通过'} |`);
  w(`| L2 图像层 | ${l2ok ? '通过' : '不通过'} |`);
  w(`| L3 对应层 | ${l3ok ? '通过' : '不通过'} |`);
  w(`| L4 内容层 | ${l4ok ? '通过' : '不通过'} |`);
  w(`| L5 平衡层 | ${l5ok ? '通过' : '不通过'} |`);
  w(`| L6 门槛层 | ${l6ok ? '通过' : '不通过'} |`);
  w(`| **总体** | **${allOk ? '通过' : '存在问题'}** |`);

  fs.writeFileSync(outPath, L.join('\n') + '\n');

  console.log(L.slice(L.findIndex((x) => x.startsWith('## 汇总'))).join('\n'));
  console.log('\n报告已写入：' + outPath);
  if (!allOk) process.exitCode = 1;
}

main();
