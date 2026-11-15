#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
make_sample_sheet.py — 生成「6 类目数据样例 + 标注框」对照图

用途：答辩/评审时一眼看清训练数据到底长什么样，以及标注框是否贴着真实缺陷。
每行一个类目，每行取若干张「确实包含该类」的训练图，按标签画出 GT 框。

只读数据集，不修改任何文件。

用法：
    python tools/yolo/make_sample_sheet.py \
        --root yolo-workspace/dataset-6class \
        --out  yolo-workspace/数据样例-6类目.png [--per-row 4] [--thumb 260]
"""
import argparse
import json
import os
import sys

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception as e:  # pragma: no cover
    print('需要 Pillow：', e)
    sys.exit(2)

# 与 data.yaml / detector.TYPES 顺序一致
CLASSES = ['Spalling', 'Crack', 'Leakage', 'LiningOffset', 'Efflorescence']
CN = {
    'Spalling': '剥落掉块', 'Crack': '裂缝', 'Leakage': '渗漏水',
    'LiningOffset': '衬砌错台', 'Efflorescence': '白华析出',
}
COLOR = {
    0: (255, 86, 86), 1: (255, 196, 0), 2: (64, 160, 255),
    3: (176, 108, 255), 4: (60, 220, 160),
}


def load_font(size):
    for p in ('C:/Windows/Fonts/msyh.ttc', 'C:/Windows/Fonts/msyhbd.ttc',
              'C:/Windows/Fonts/simhei.ttf'):
        if os.path.exists(p):
            try:
                return ImageFont.truetype(p, size)
            except Exception:
                pass
    return ImageFont.load_default()


def parse_label(path):
    out = []
    if not os.path.exists(path):
        return out
    with open(path, encoding='utf-8') as f:
        for ln in f:
            p = ln.split()
            if len(p) != 5:
                continue
            c = int(float(p[0]))
            x, y, w, h = (float(v) for v in p[1:])
            out.append((c, x, y, w, h))
    return out


def yolo_to_xyxy(b, W, H):
    c, x, y, w, h = b
    return (max(0, (x - w / 2) * W), max(0, (y - h / 2) * H),
            min(W, (x + w / 2) * W), min(H, (y + h / 2) * H))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--root', default='yolo-workspace/dataset-6class')
    ap.add_argument('--split', default='train')
    ap.add_argument('--out', default='yolo-workspace/数据样例-6类目.png')
    ap.add_argument('--per-row', type=int, default=4)
    ap.add_argument('--thumb', type=int, default=260)
    args = ap.parse_args()

    img_dir = os.path.join(args.root, 'images', args.split)
    lbl_dir = os.path.join(args.root, 'labels', args.split)
    if not os.path.isdir(img_dir):
        print('图片目录不存在：%s' % img_dir)
        return 2

    # 建索引：stem -> {classes, boxes}
    items = []
    for f in sorted(os.listdir(lbl_dir)):
        if not f.endswith('.txt'):
            continue
        stem = f[:-4]
        ip = None
        for ext in ('.jpg', '.jpeg', '.png'):
            if os.path.exists(os.path.join(img_dir, stem + ext)):
                ip = os.path.join(img_dir, stem + ext)
                break
        if not ip:
            continue
        boxes = parse_label(os.path.join(lbl_dir, f))
        items.append({'stem': stem, 'img': ip, 'boxes': boxes,
                      'classes': sorted({b[0] for b in boxes})})

    if not items:
        print('未找到任何图文配对')
        return 3

    rows = []
    # 5 个病害类各挑 per-row 张；背景（空标签）也作为第 6 行展示
    for ci, name in enumerate(CLASSES):
        cands = [it for it in items if ci in it['classes']]
        # 优先单类图（框少、语义干净），再按文件名稳定排序
        cands.sort(key=lambda it: (len(it['classes']), len(it['boxes']), it['stem']))
        rows.append((f'{CN[name]}  {name}', cands[:args.per_row]))
    negs = [it for it in items if not it['boxes']]
    rows.append(('背景（负样本，无标注框）', negs[:args.per_row]))

    T = args.thumb
    label_h = 34
    pad = 6
    cols = args.per_row
    row_h = T + label_h
    sheet = Image.new('RGB', (cols * (T + pad) + pad, len(rows) * row_h + pad), (24, 26, 30))
    draw = ImageDraw.Draw(sheet)
    f_title = load_font(20)
    f_small = load_font(15)
    f_box = load_font(13)

    y = pad
    for title, picks in rows:
        draw.text((pad + 2, y + 4), title, fill=(236, 240, 245), font=f_title)
        for j, it in enumerate(picks):
            im = Image.open(it['img']).convert('RGB')
            W, H = im.size
            d = ImageDraw.Draw(im)
            for b in it['boxes']:
                x1, y1, x2, y2 = yolo_to_xyxy(b, W, H)
                col = COLOR.get(b[0], (255, 255, 255))
                d.rectangle([x1, y1, x2, y2], outline=col, width=3)
                tag = CLASSES[b[0]] if 0 <= b[0] < len(CLASSES) else str(b[0])
                tw = len(tag) * 7 + 6
                d.rectangle([x1, max(0, y1 - 17), x1 + tw, max(0, y1 - 17) + 17], fill=col)
                d.text((x1 + 3, max(0, y1 - 16)), tag, fill=(20, 20, 20), font=f_box)
            im = im.resize((T, T), Image.LANCZOS)
            # 缩略图下方的文件名（截断）
            name = it['stem']
            if len(name) > 30:
                name = name[:27] + '…'
            x0 = pad + j * (T + pad)
            sheet.paste(im, (x0, y + label_h))
            draw.text((x0 + 2, y + label_h + T + 2), name, fill=(140, 148, 158), font=f_small)
        y += row_h + 16

    os.makedirs(os.path.dirname(os.path.abspath(args.out)), exist_ok=True)
    sheet.save(args.out, 'PNG')
    print('样例图已生成：%s（%dx%d）' % (args.out, sheet.width, sheet.height))
    print('每行一个类目，每行 %d 张；框为数据集里的真实标注（GT），不是模型预测。' % cols)
    for title, picks in rows:
        print('  %-28s %d 张' % (title, len(picks)))
    return 0


if __name__ == '__main__':
    sys.exit(main())
