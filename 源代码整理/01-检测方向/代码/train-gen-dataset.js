/**
 * train/gen-dataset.js — 训练数据集生成器（数据驱动训练轮 · 纯 JS 零依赖）
 *
 * 产出「图像 + 像素级精确标注」的训练集到 backend/data/train/：
 *   images/*.png   512×384 训练图（程序化衬砌背景 + 1~3 处内置缺陷渲染，复用 synthesizer 合成编排）
 *   labels.json    逐图标注 {file, W, H, negative, defects:[{class_name, level, bbox:[x,y,w,h] 像素坐标}]}
 *
 * 与模块二合成器同源（makeBackground/makeDemoDefect/composeOne），因此训练分布与
 * 系统实际演示/检测分布一致；输出 PNG 免 JPEG 解码，供 vision.analyzeImage 直接消费。
 *
 * CLI：node backend/train/gen-dataset.js [--count 240] [--seed 42] [--neg 0.15] [--out data/train]
 */
const fs = require('fs');
const path = require('path');
const vision = require('../vision');
const synth = require('../synthesizer');

const OUT_W = 512, OUT_H = 384;
const TYPES = synth.TYPE_ORDER;

/** 可复现伪随机（mulberry32） */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0; a = (a + 0x6D2B79F5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 生成一批训练图（PNG）与标注 manifest
 * @param {{count?:number, seed?:number, negRatio?:number, outDir?:string}} opts
 * @returns {object} manifest（含逐图标注）
 */
function generate(opts = {}) {
  const count = Math.max(20, Math.min(2000, Math.round(opts.count || 240)));
  const seed = Number(opts.seed) || 42;
  const negRatio = opts.negRatio == null ? 0.15 : Math.max(0, Math.min(0.5, opts.negRatio));
  const outDir = opts.outDir || path.join(__dirname, '..', 'data', 'train');
  const imgDir = path.join(outDir, 'images');
  const rand = rng(seed);
  const rint = (a, b) => a + Math.round(rand() * (b - a));
  fs.rmSync(imgDir, { recursive: true, force: true });
  fs.mkdirSync(imgDir, { recursive: true });

  const items = [];
  const nNeg = Math.round(count * negRatio);
  for (let i = 0; i < count; i++) {
    const negative = i < nNeg; // 前 negRatio 批次为纯背景负样本
    const bg = synth.makeBackground(null, OUT_W, OUT_H);
    let placed = [];
    if (!negative) {
      // 类型均衡采样：主题类型均匀，其余 patch 全均匀（1~3 处）
      const theme = TYPES[i % TYPES.length];
      const k = rint(1, 3);
      const patches = [];
      for (let p = 0; p < k; p++) {
        const cls = p === 0 ? theme : TYPES[Math.floor(rand() * TYPES.length)];
        const lv = 1 + Math.floor(rand() * 4);
        patches.push(synth.makeDemoDefect(cls, lv));
      }
      placed = synth.composeOne(bg, patches).placed;
    }
    const file = `img_${String(i).padStart(4, '0')}${negative ? '_neg' : ''}.png`;
    fs.writeFileSync(path.join(imgDir, file), vision.encodePngRGB(OUT_W, OUT_H, vision.rgbFromRgba(bg.rgba)));
    items.push({
      file, W: OUT_W, H: OUT_H, negative,
      defects: placed.map((p) => ({ class_name: p.class_name, level: p.level, bbox: [p.x, p.y, p.w, p.h] })),
    });
  }
  const manifest = { generatedAt: new Date().toISOString(), seed, count, negRatio, outSize: `${OUT_W}x${OUT_H}`, items };
  fs.writeFileSync(path.join(outDir, 'labels.json'), JSON.stringify(manifest, null, 1));
  return manifest;
}

/** CLI 入口 */
if (require.main === module) {
  const arg = (name, dft) => {
    const i = process.argv.indexOf('--' + name);
    return i > 0 ? process.argv[i + 1] : dft;
  };
  const t0 = Date.now();
  const m = generate({
    count: Number(arg('count', 240)),
    seed: Number(arg('seed', 42)),
    negRatio: Number(arg('neg', 0.15)),
    outDir: arg('out', undefined),
  });
  const byType = {};
  for (const it of m.items) for (const d of it.defects) byType[d.class_name] = (byType[d.class_name] || 0) + 1;
  console.log(`✓ 生成 ${m.items.length} 张训练图（负样本 ${m.items.filter((x) => x.negative).length}）→ ${m.outSize}`);
  console.log('  缺陷实例分布:', JSON.stringify(byType));
  console.log(`  输出目录: ${arg('out', path.join(__dirname, '..', 'data', 'train'))} · 耗时 ${Date.now() - t0}ms`);
}

module.exports = { generate, OUT_W, OUT_H };
