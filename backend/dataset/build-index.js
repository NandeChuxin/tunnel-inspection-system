/* build-index.js — 解析 D:\DataSet\labels 建立「系统病害类型 → 数据集图片」索引
 * 数据集类别: 0=Spalling剥落, 1=Crack裂缝, 2=Leakage渗漏
 * 系统类型映射: 剥落掉块→0, 裂缝→1, 渗漏水→2 （数据集没有的 白华析出/衬砌错台 不建立）
 * 每张图取其 labels 中首个目标框的类别作为该图的主病害类别。
 * 输出: backend/dataset/index.json = { 裂缝:[文件名,...], 渗漏水:[...], 剥落掉块:[...] }
 */
const fs = require('fs');
const path = require('path');

const LABEL_ROOT = 'D:\\DataSet\\labels';
const IMG_DIR = path.join(__dirname, 'img');
const OUT = path.join(__dirname, 'index.json');

const CLASS_NAMES = ['剥落掉块', '裂缝', '渗漏水']; // 0 Spalling / 1 Crack / 2 Leakage

function readClass(file) {
  try {
    const txt = fs.readFileSync(file, 'utf-8').trim();
    const first = txt.split(/\r?\n/)[0];
    if (!first) return null;
    const cls = Number(first.split(/\s+/)[0]);
    return Number.isInteger(cls) && cls >= 0 && cls < 3 ? cls : null;
  } catch (e) { return null; }
}

const buckets = [[], [], []];
for (const sub of ['train', 'val', 'test']) {
  const dir = path.join(LABEL_ROOT, sub);
  if (!fs.existsSync(dir)) continue;
  for (const f of fs.readdirSync(dir)) {
    if (!/\.txt$/i.test(f)) continue;
    const cls = readClass(path.join(dir, f));
    const img = f.replace(/\.txt$/i, '.jpg');
    if (cls == null) continue;
    if (!fs.existsSync(path.join(IMG_DIR, img))) continue;
    buckets[cls].push(img);
  }
}

const index = {};
CLASS_NAMES.forEach((name, i) => { index[name] = buckets[i]; });
fs.writeFileSync(OUT, JSON.stringify(index, null, 2), 'utf-8');
console.log('index.json: 剥落掉块', index['剥落掉块'].length,
  '裂缝', index['裂缝'].length, '渗漏水', index['渗漏水'].length);