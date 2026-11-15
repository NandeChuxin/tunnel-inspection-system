#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
rebuild_dataset.py — 阶段 2：把收到的文件重建成标准 YOLO 目录结构 + 生成 data.yaml

输入（二选一）：
  --from  D:/Dataset            直接从一个已有目录树重建（自动识别 images/labels × train/val/test）
  --inbox yolo-workspace/inbox  从登记器落盘的 inbox 重建（用户逐个上传的场景）

输出：
  <out>/images/{train,val,test}  <out>/labels/{train,val,test}  <out>/data.yaml
  只复制「图片与标签同名配对」的文件；未配对的写入报告，绝不静默丢弃。

用法：
  python tools/yolo/rebuild_dataset.py --from D:/Dataset --out yolo-workspace/dataset-grouped --group-resplit
"""
import argparse
import os
import random
import shutil
import sys

IMG_EXT = ('.jpg', '.jpeg', '.png', '.bmp', '.webp')
SPLITS = ['train', 'val', 'test']


def group_key(stem):
    """文件名 a_b_scene_frame 按 a_b_scene 分组，防止同一采集序列跨子集泄漏。"""
    parts = stem.split('_')
    return '_'.join(parts[:3]) if len(parts) >= 3 else stem


def split_overlaps(data):
    groups = {sp: {group_key(s) for s in data[sp]['images']} for sp in SPLITS}
    return {(a, b): sorted(groups[a] & groups[b])
            for i, a in enumerate(SPLITS) for b in SPLITS[i + 1:]}


def regroup(data, seed):
    """合并原有子集后按采集组做 70/20/10 确定性重划分。"""
    all_images, all_labels = {}, {}
    for sp in SPLITS:
        all_images.update(data[sp]['images'])
        all_labels.update(data[sp]['labels'])
    groups = sorted({group_key(s) for s in set(all_images) & set(all_labels)})
    random.Random(seed).shuffle(groups)
    n = len(groups)
    n_train, n_val = round(n * 0.7), round(n * 0.2)
    owner = {g: ('train' if i < n_train else 'val' if i < n_train + n_val else 'test')
             for i, g in enumerate(groups)}
    out = {sp: {'images': {}, 'labels': {}} for sp in SPLITS}
    for stem in sorted(set(all_images) & set(all_labels)):
        sp = owner[group_key(stem)]
        out[sp]['images'][stem] = all_images[stem]
        out[sp]['labels'][stem] = all_labels[stem]
    return out


def collect(root):
    """在 root 下找 images/labels × 子集；也兼容 <split>/images 这类布局"""
    out = {sp: {'images': {}, 'labels': {}} for sp in SPLITS}

    def put(sp, kind, stem, path):
        if sp in out:
            out[sp][kind][stem] = path

    for dp, _dn, fn in os.walk(root):
        parts = [p.lower() for p in os.path.relpath(dp, root).split(os.sep)]
        if parts == ['.']:
            parts = []
        sp = next((s for s in SPLITS if any(s == p or (s in p and p != 'images' and p != 'labels') for p in parts)), None)
        if not sp:
            continue
        low = [p for p in parts]
        is_label_dir = any('label' in p for p in low)
        is_image_dir = any('image' in p for p in low)
        for f in fn:
            stem, ext = os.path.splitext(f)
            ext = ext.lower()
            if ext in IMG_EXT and (is_image_dir or not is_label_dir):
                put(sp, 'images', stem, os.path.join(dp, f))
            elif ext == '.txt' and (is_label_dir or not is_image_dir):
                put(sp, 'labels', stem, os.path.join(dp, f))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--from', dest='src', required=True, help='源目录（如 D:/Dataset 或 inbox）')
    ap.add_argument('--out', default='yolo-workspace/dataset', help='重建后的数据集根目录')
    ap.add_argument('--group-resplit', action='store_true', help='忽略原子集，按采集组重新划分 70/20/10，杜绝同源泄漏')
    ap.add_argument('--seed', type=int, default=2026, help='--group-resplit 的确定性随机种子')
    ap.add_argument('--allow-group-overlap', action='store_true', help='保留原划分且允许同源组跨子集（不推荐）')
    args = ap.parse_args()

    src, out = args.src, args.out
    if not os.path.isdir(src):
        print('源目录不存在：%s' % src); return 2

    data = collect(src)
    original_overlaps = split_overlaps(data)
    leaking = {k: v for k, v in original_overlaps.items() if v}
    if args.group_resplit:
        data = regroup(data, args.seed)
        print('已按采集组重新划分（seed=%d）；原划分泄漏组数：%d' %
              (args.seed, sum(len(v) for v in leaking.values())))
    elif leaking and not args.allow_group_overlap:
        print('拒绝重建：检测到同源采集组跨 train/val/test，指标可能虚高。')
        for (a, b), groups in leaking.items():
            print('  %s/%s 重叠 %d 组：%s%s' %
                  (a, b, len(groups), ', '.join(groups[:8]), ' ...' if len(groups) > 8 else ''))
        print('请增加 --group-resplit（推荐），或显式使用 --allow-group-overlap 保留旧划分。')
        return 3
    if os.path.isdir(out) and os.path.basename(os.path.abspath(out)) == 'dataset':
        shutil.rmtree(out)          # 只清我们自己的产物目录
    paired = {sp: 0 for sp in SPLITS}
    miss_label, miss_image = [], []

    for sp in SPLITS:
        di = os.path.join(out, 'images', sp)
        dl = os.path.join(out, 'labels', sp)
        os.makedirs(di, exist_ok=True)
        os.makedirs(dl, exist_ok=True)
        ii, ll = data[sp]['images'], data[sp]['labels']
        for stem in sorted(set(ii) & set(ll)):
            shutil.copy2(ii[stem], os.path.join(di, os.path.basename(ii[stem])))
            shutil.copy2(ll[stem], os.path.join(dl, os.path.basename(ll[stem])))
            paired[sp] += 1
        for stem in sorted(set(ii) - set(ll)):
            miss_label.append('images/%s/%s' % (sp, os.path.basename(ii[stem])))
        for stem in sorted(set(ll) - set(ii)):
            miss_image.append('labels/%s/%s' % (sp, os.path.basename(ll[stem])))

    total = sum(paired.values())
    yml = os.path.join(out, 'data.yaml')
    with open(yml, 'w', encoding='utf-8') as f:
        f.write('# 由 tools/yolo/rebuild_dataset.py 自动生成\n')
        f.write('# 源目录: %s\n' % os.path.abspath(src).replace('\\', '/'))
        f.write('path: %s\n' % os.path.abspath(out).replace('\\', '/'))
        f.write('train: images/train\nval: images/val\ntest: images/test\n\n')
        f.write('nc: 3\nnames: [\'Spalling\', \'Crack\', \'Leakage\']\n')

    print('重建完成：%s' % os.path.abspath(out))
    print('配对组数：train %d / val %d / test %d  → 共 %d 组' % (
        paired['train'], paired['val'], paired['test'], total))
    print('data.yaml：%s' % os.path.abspath(yml))
    final_leaks = {k: v for k, v in split_overlaps(data).items() if v}
    if final_leaks:
        print('警告：仍存在 %d 个跨子集同源组。' % sum(len(v) for v in final_leaks.values()))
    else:
        print('分组泄漏审计：通过（train/val/test 无同源采集组交叉）。')
    if miss_label or miss_image:
        print('未配对：有图无标签 %d 个、有标签无图 %d 个（未复制）' % (len(miss_label), len(miss_image)))
        for x in miss_label[:10] + miss_image[:10]:
            print('  -', x)
        return 1
    print('无孤儿文件。')
    return 0


if __name__ == '__main__':
    sys.exit(main())
