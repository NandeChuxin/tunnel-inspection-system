#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
verify_dataset.py — YOLO 数据集四级核验（Level 1~4 + 划分/泄漏）

只读不写：不修改、不删除任何原始文件；结论全部来自实际解析。
用法：
    python tools/yolo/verify_dataset.py --root D:/Dataset --out yolo-workspace/核验报告-数据集.md
可选：
    --sample N   额外抽查 N 张图片用 cv2 复读（默认 0，仅用 PIL verify+load）
"""
import argparse
import hashlib
import os
import sys
from collections import Counter, defaultdict
from datetime import datetime

try:
    from PIL import Image
except Exception as e:  # pragma: no cover
    print('需要 Pillow：', e); sys.exit(2)

SPLITS = ['train', 'val', 'test']
IMG_EXT = ('.jpg', '.jpeg', '.png', '.bmp', '.webp')


def sha1_of(path, limit=1 << 20):
    """取前 1MB 摘要，用于发现「同名不同内容」或重复文件（开销小）"""
    h = hashlib.sha1()
    with open(path, 'rb') as f:
        h.update(f.read(limit))
    return h.hexdigest()


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='D:/Dataset')
    ap.add_argument('--out', default='yolo-workspace/核验报告-数据集.md')
    ap.add_argument('--sample', type=int, default=0)
    args = ap.parse_args()

    root = args.root
    L = []           # 报告行
    problems = []    # (层级, 说明)
    n_problem = 0

    def w(s=''):
        L.append(s)

    w('# YOLO 数据集核验报告')
    w()
    w('> 数据集根目录：`%s`' % root)
    w('> 核验时间：%s' % datetime.now().strftime('%Y-%m-%d %H:%M:%S'))
    w('> 本报告全部数字来自实际解析（只读，未修改任何原始文件）。')
    w()

    # ---------- 0 目录结构 ----------
    w('## 0 目录结构清点')
    w()
    w('| 子集 | 图片 | 标签 |')
    w('|---|---|---|')
    counts = {}
    for sp in SPLITS:
        idir = os.path.join(root, 'images', sp)
        ldir = os.path.join(root, 'labels', sp)
        ni = len([f for f in os.listdir(idir) if f.lower().endswith(IMG_EXT)]) if os.path.isdir(idir) else -1
        nl = len([f for f in os.listdir(ldir) if f.lower().endswith('.txt')]) if os.path.isdir(ldir) else -1
        counts[sp] = (ni, nl)
        w('| %s | %d | %d |' % (sp, ni, nl))
    ti = sum(v[0] for v in counts.values() if v[0] > 0)
    tl = sum(v[1] for v in counts.values() if v[1] > 0)
    w('| **合计** | **%d** | **%d** |' % (ti, tl))
    w()

    # ---------- Level 1 文件层 ----------
    w('## Level 1 文件层（可读 / 无损坏 / 无重复命名）')
    w()
    zero = []
    unreadable = []
    dup_names_in_split = defaultdict(list)
    img_index = {}          # split -> {stem: path}
    lab_index = {}
    digest = defaultdict(list)   # sha1 -> [paths]

    for sp in SPLITS:
        idir = os.path.join(root, 'images', sp)
        if not os.path.isdir(idir):
            problems.append(('L1', '缺少图片目录 images/%s' % sp)); continue
        img_index[sp] = {}
        for f in sorted(os.listdir(idir)):
            p = os.path.join(idir, f)
            if not os.path.isfile(p):
                continue
            if os.path.getsize(p) == 0:
                zero.append(p); continue
            stem = os.path.splitext(f)[0]
            if stem in img_index[sp]:
                dup_names_in_split[sp].append(stem)
            img_index[sp][stem] = p
            digest[sha1_of(p)].append(p)
            if not f.lower().endswith(IMG_EXT):
                problems.append(('L1', '非预期图片扩展名：%s' % p))

    for sp in SPLITS:
        ldir = os.path.join(root, 'labels', sp)
        if not os.path.isdir(ldir):
            problems.append(('L1', '缺少标签目录 labels/%s' % sp)); continue
        lab_index[sp] = {}
        for f in sorted(os.listdir(ldir)):
            p = os.path.join(ldir, f)
            if not os.path.isfile(p):
                continue
            if os.path.getsize(p) == 0 and f.lower().endswith('.txt'):
                # 空标签在 YOLO 里代表「无目标」，不算损坏；单列统计
                pass
            stem = os.path.splitext(f)[0]
            if not f.lower().endswith('.txt'):
                problems.append(('L1', '标签目录里出现非 txt 文件：%s' % p)); continue
            lab_index[sp][stem] = p

    dup_files = {k: v for k, v in digest.items() if len(v) > 1}
    w('| 检查项 | 结果 |')
    w('|---|---|')
    w('| 零字节文件 | %s |' % ('无' if not zero else '%d 个：%s' % (len(zero), ', '.join(os.path.basename(x) for x in zero[:10]))))
    w('| 同一子集内重名 | %s |' % ('无' if not dup_names_in_split else str(dict(dup_names_in_split))))
    w('| 内容重复文件（前 1MB sha1，跨子集也算） | %s |' % ('无' if not dup_files else '%d 组' % len(dup_files)))
    w('| Level 1 结论 | %s |' % ('通过' if not (zero or dup_names_in_split) else '**不通过**'))
    w()
    if dup_files:
        w('内容重复明细（同一份图出现在多处的可能性）：')
        for k, v in list(dup_files.items())[:20]:
            w('- `%s`' % '` ↔ `'.join(os.path.relpath(x, root) for x in v))
        w()

    # ---------- Level 2 图像层 ----------
    w('## Level 2 图像层（通道模式 / 尺寸 / 异常）')
    w()
    bad_img = []
    modes = Counter()
    sizes = Counter()
    dims = []
    for sp in SPLITS:
        for stem, p in sorted(img_index.get(sp, {}).items()):
            try:
                with Image.open(p) as im:
                    im.verify()                      # 结构校验
                with Image.open(p) as im:
                    im.load()                        # 真实解码
                    modes[im.mode] += 1
                    sizes[im.size] += 1
                    dims.append(im.size)
            except Exception as e:
                bad_img.append((p, str(e)))
    w('- 通道模式统计：%s' % ('、'.join('%s×%d' % (k, v) for k, v in modes.most_common())))
    w('- 尺寸种类数：%d（同一尺寸最多：%s，共 %d 张）' % (
        len(sizes), ('%dx%d' % sizes.most_common(1)[0][0]) if sizes else '-', sizes.most_common(1)[0][1] if sizes else 0))
    if dims:
        wss = [a * b for a, b in dims]
        w('- 像素规模：最小 %.2f MP / 中位 %.2f MP / 最大 %.2f MP' % (
            min(wss) / 1e6, sorted(wss)[len(wss) // 2] / 1e6, max(wss) / 1e6))
    small = [(p, s) for (p, s) in [(p, im) for p, im in []]]
    tiny = []
    for sp in SPLITS:
        for stem, p in img_index.get(sp, {}).items():
            try:
                with Image.open(p) as im:
                    if min(im.size) < 200:
                        tiny.append((p, im.size))
            except Exception:
                pass
    w('- 最小边 <200px 的图片：%s' % ('无' if not tiny else '%d 张' % len(tiny)))
    if tiny:
        for p, s in tiny[:10]:
            w('  - `%s` %dx%d' % (os.path.relpath(p, root), s[0], s[1]))
    w('- 无法解码的图片：%s' % ('无' if not bad_img else '%d 张' % len(bad_img)))
    for p, e in bad_img[:10]:
        w('  - `%s` → %s' % (os.path.relpath(p, root), e))
    w('- Level 2 结论：%s' % ('通过' if not bad_img else '**不通过**'))
    w()

    # ---------- Level 3 对应层 ----------
    w('## Level 3 对应层（图片 ↔ 标签一一对应，无孤儿）')
    w()
    w('| 子集 | 图片 | 标签 | 图片缺标签 | 标签缺图片 | 配对组数 |')
    w('|---|---|---|---|---|---|')
    pair_total = 0
    orphan_i_all, orphan_l_all = [], []
    for sp in SPLITS:
        ii = set(img_index.get(sp, {}))
        li = set(lab_index.get(sp, {}))
        oi = sorted(ii - li)      # 有图无标签
        ol = sorted(li - ii)      # 有标签无图
        pair_total += len(ii & li)
        orphan_i_all += [('images/%s/%s' % (sp, s)) for s in oi]
        orphan_l_all += [('labels/%s/%s' % (sp, s)) for s in ol]
        w('| %s | %d | %d | %d | %d | %d |' % (sp, len(ii), len(li), len(oi), len(ol), len(ii & li)))
    w()
    if orphan_i_all:
        w('- 有图无标签（%d）：%s' % (len(orphan_i_all), ', '.join(orphan_i_all[:20])))
    if orphan_l_all:
        w('- 有标签无图（%d）：%s' % (len(orphan_l_all), ', '.join(orphan_l_all[:20])))
    w('- Level 3 结论：%s' % ('通过' if not (orphan_i_all or orphan_l_all) else '**不通过**'))
    w()

    # ---------- Level 4 内容层 ----------
    w('## Level 4 内容层（标签 5 字段 / 类别索引 / 坐标范围）')
    w()
    cls_counter = Counter()
    boxes_per_split = Counter()
    bad_lines = []      # (文件, 行号, 原因, 原文)
    empty_label_files = []
    box_count = 0
    for sp in SPLITS:
        for stem, p in sorted(lab_index.get(sp, {}).items()):
            try:
                txt = open(p, 'r', encoding='utf-8', errors='replace').read()
            except Exception as e:
                bad_lines.append((p, 0, '读取失败：%s' % e, '')); continue
            lines = [ln for ln in txt.replace('\r\n', '\n').split('\n')]
            body = [ln for ln in lines if ln.strip() != '']
            if not body:
                empty_label_files.append(p)
                continue
            for i, ln in enumerate(lines, 1):
                if ln.strip() == '':
                    continue
                parts = ln.split()
                if len(parts) != 5:
                    bad_lines.append((p, i, '字段数 %d（应为 5）' % len(parts), ln.strip())); continue
                try:
                    c = int(float(parts[0]))
                    x, y, bw, bh = (float(v) for v in parts[1:])
                except Exception:
                    bad_lines.append((p, i, '存在非数值字段', ln.strip())); continue
                if not (0 <= c < 3):
                    bad_lines.append((p, i, '类别索引越界：%d（应为 0~2）' % c, ln.strip())); continue
                if not (0.0 <= x <= 1.0 and 0.0 <= y <= 1.0 and 0.0 <= bw <= 1.0 and 0.0 <= bh <= 1.0):
                    bad_lines.append((p, i, '归一化坐标越界', ln.strip())); continue
                if bw <= 0 or bh <= 0:
                    bad_lines.append((p, i, '宽或高 ≤ 0', ln.strip())); continue
                cls_counter[c] += 1
                boxes_per_split[sp] += 1
                box_count += 1
    names = {0: 'Spalling', 1: 'Crack', 2: 'Leakage'}
    w('| 类别索引 | 名称 | 框数 | 占比 |')
    w('|---|---|---|---|')
    for c in range(3):
        w('| %d | %s | %d | %.1f%% |' % (c, names[c], cls_counter[c], (100.0 * cls_counter[c] / box_count) if box_count else 0))
    w('| **合计** |  | **%d** | 100%% |' % box_count)
    w()
    w('- 各子集框数：%s' % '、'.join('%s %d' % (k, boxes_per_split[k]) for k in SPLITS))
    w('- 空标签文件（无目标，YOLO 允许）：%s' % ('无' if not empty_label_files else '%d 个' % len(empty_label_files)))
    if empty_label_files:
        for p in empty_label_files[:10]:
            w('  - `%s`' % os.path.relpath(p, root))
    w('- 不合法标注行：%s' % ('无' if not bad_lines else '%d 行' % len(bad_lines)))
    for p, i, why, raw in bad_lines[:20]:
        w('  - `%s:%d` %s ｜ %s' % (os.path.relpath(p, root), i, why, raw))
    w('- Level 4 结论：%s' % ('通过' if not bad_lines else '**不通过**'))
    w()

    # ---------- 划分与泄漏 ----------
    w('## 划分与泄漏核验')
    w()
    w('| 子集 | 组数 | 期望 | 实际占比 | 是否达标 |')
    w('|---|---|---|---|---|')
    expect = {'train': 231, 'val': 66, 'test': 33}
    ok_split = True
    for sp in SPLITS:
        n = len(img_index.get(sp, {}))
        pct = 100.0 * n / 330
        got = (n == expect[sp])
        ok_split &= got
        w('| %s | %d | %d | %.1f%% | %s |' % (sp, n, expect[sp], pct, '✓' if got else '✗'))
    w()
    # 跨子集同名
    stem_splits = defaultdict(set)
    for sp in SPLITS:
        for s in img_index.get(sp, {}):
            stem_splits[s].add(sp)
    cross = {s: v for s, v in stem_splits.items() if len(v) > 1}
    w('- 跨子集同名文件（数据泄漏风险）：%s' % ('无' if not cross else '%d 个' % len(cross)))
    for s, v in list(cross.items())[:20]:
        w('  - `%s` 出现在 %s' % (s, '、'.join(sorted(v))))
    w()

    # ---------- data.yaml ----------
    w('## data.yaml 核对')
    w()
    yml = os.path.join(root, 'data.yaml')
    yml_ok = True          # 初始为 True：下面逐项 &= ，避免 False 初值把结论恒定为「不通过」
    if os.path.exists(yml):
        raw = open(yml, 'r', encoding='utf-8', errors='replace').read()
        w('```yaml')
        w(raw.strip())
        w('```')
        try:
            import yaml as _y
            cfg = _y.safe_load(raw)
            checks = []
            checks.append(('nc == 3', cfg.get('nc') == 3, cfg.get('nc')))
            nm = [str(x) for x in (cfg.get('names') or [])]
            checks.append(("names == ['Spalling','Crack','Leakage']", nm == ['Spalling', 'Crack', 'Leakage'], nm))
            for k in ('train', 'val', 'test'):
                p = str(cfg.get(k, '')).strip()
                checks.append(('%s 路径存在' % k, os.path.isdir(p), p))
            w('| 检查项 | 结果 | 实际值 |')
            w('|---|---|---|')
            for name, ok, val in checks:
                w('| %s | %s | %s |' % (name, '✓' if ok else '✗', val))
                yml_ok &= bool(ok)
        except Exception as e:
            w('解析 data.yaml 失败：%s' % e)
            yml_ok = False
    else:
        w('未找到 data.yaml')
        yml_ok = False
    w()

    # ---------- 汇总 ----------
    n_problem = len(problems) + len(bad_img) + len(bad_lines) + len(orphan_i_all) + len(orphan_l_all)
    w('## 汇总')
    w()
    w('| 项目 | 值 |')
    w('|---|---|')
    w('| 图片总数 | %d |' % ti)
    w('| 标签总数 | %d |' % tl)
    w('| 配对数（图片+标签同名） | %d |' % pair_total)
    w('| 标注框总数 | %d |' % box_count)
    w('| Level 1 文件层 | %s |' % ('通过' if not (zero or dup_names_in_split) else '不通过'))
    w('| Level 2 图像层 | %s |' % ('通过' if not bad_img else '不通过'))
    w('| Level 3 对应层 | %s |' % ('通过' if not (orphan_i_all or orphan_l_all) else '不通过'))
    w('| Level 4 内容层 | %s |' % ('通过' if not bad_lines else '不通过'))
    w('| 划分 231/66/33 | %s |' % ('通过' if ok_split else '不通过'))
    w('| 跨子集泄漏 | %s |' % ('无' if not cross else '有'))
    w('| data.yaml | %s |' % ('通过' if yml_ok else '不通过/需修'))
    w('| **共发现问题** | **%d 处** |' % n_problem)
    w()

    out = args.out
    os.makedirs(os.path.dirname(os.path.abspath(out)), exist_ok=True)
    with open(out, 'w', encoding='utf-8') as f:
        f.write('\n'.join(L) + '\n')

    # 控制台紧凑摘要（给对话用）
    print('图片 %d / 标签 %d / 配对 %d / 框 %d' % (ti, tl, pair_total, box_count))
    print('各子集框数:', dict(boxes_per_split))
    print('类别框数:', {names[c]: cls_counter[c] for c in range(3)})
    print('模式:', dict(modes))
    print('尺寸种类:', len(sizes))
    print('问题数:', n_problem)
    if bad_lines[:3]:
        print('标注异常示例:', bad_lines[:3])
    if bad_img[:3]:
        print('图片异常示例:', bad_img[:3])
    if orphan_i_all[:3] or orphan_l_all[:3]:
        print('孤儿文件示例:', (orphan_i_all[:3], orphan_l_all[:3]))
    print('报告已写入:', out)


if __name__ == '__main__':
    main()
