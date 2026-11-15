#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
register_upload.py — 阶段 1：接收与登记（逐个/批量上传都可用）

职责：
  · 判断类型：.jpg/.jpeg/.png → 图片；.txt → 首行首列是数字则 YOLO 标签，否则说明文档；
              .yaml/.yml → 数据集配置；其他 → 记入 unknown 并提示询问用途（不擅自归类）
  · 按 train / val / test × images / labels 登记文件名，同名图片与标签自动配对
  · 每次调用后按固定紧凑格式回执（不逐文件刷屏）
  · 幂等：重复登记同一文件不会重复计数；不修改、不删除任何原始文件

用法：
  # 逐个/批量登记用户上传的文件（副本存入工作区，原文件不动）
  python tools/yolo/register_upload.py --add a/1_1_008_22.jpg a/1_1_008_22.txt --split train

  # 扫描一个已存在的目录树（如本机 D:/Dataset）批量登记
  python tools/yolo/register_upload.py --scan D:/Dataset

  # 查看当前清单
  python tools/yolo/register_upload.py --status
"""
import argparse
import json
import os
import shutil
import sys
from datetime import datetime

WORK = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..', 'yolo-workspace')
WORK = os.path.abspath(WORK)
REG = os.path.join(WORK, '上传登记清单.json')
INBOX = os.path.join(WORK, 'inbox')          # 上传副本落盘处（原文件不动）
IMG_EXT = ('.jpg', '.jpeg', '.png', '.bmp', '.webp')
SPLITS = ['train', 'val', 'test']
EXPECT = {'train': 231, 'val': 66, 'test': 33}


def load():
    if os.path.exists(REG):
        with open(REG, 'r', encoding='utf-8') as f:
            return json.load(f)
    return {
        'created': datetime.now().isoformat(timespec='seconds'),
        'updated': None,
        'splits': {sp: {'images': [], 'labels': []} for sp in SPLITS},
        'data_yaml': None,
        'docs': [],
        'unknown': [],
        'source_note': '',
    }


def save(reg):
    reg['updated'] = datetime.now().isoformat(timespec='seconds')
    os.makedirs(WORK, exist_ok=True)
    with open(REG, 'w', encoding='utf-8') as f:
        json.dump(reg, f, ensure_ascii=False, indent=1)


def looks_like_yolo_label(path):
    """首行首列是数字 → YOLO 标签；否则视为说明文档。空文件按标签处理（YOLO 允许空标注）"""
    try:
        with open(path, 'r', encoding='utf-8', errors='replace') as f:
            for line in f:
                s = line.strip()
                if not s:
                    continue
                tok = s.split()[0]
                try:
                    float(tok)
                    return True
                except ValueError:
                    return False
            return True        # 空文件
    except Exception:
        return False


def guess_split(path, fallback):
    """从路径里找 train/val/test 段；找不到用 fallback"""
    parts = [p.lower() for p in os.path.abspath(path).split(os.sep)]
    for sp in SPLITS:
        if sp in parts:
            return sp
    for sp in SPLITS:
        if any(sp in p for p in parts):
            return sp
    return fallback


def register_one(reg, src, split_hint, copy_in=True):
    """登记单个文件，返回 ('image'|'label'|'yaml'|'doc'|'unknown', split)"""
    name = os.path.basename(src)
    ext = os.path.splitext(name)[1].lower()
    sp = guess_split(src, split_hint)

    if ext in IMG_EXT:
        kind = 'image'; key = 'images'
    elif ext == '.txt':
        if looks_like_yolo_label(src):
            kind = 'label'; key = 'labels'
        else:
            kind = 'doc'; key = None
    elif ext in ('.yaml', '.yml'):
        kind = 'yaml'; key = None
    else:
        kind = 'unknown'; key = None

    if copy_in:
        dst_dir = os.path.join(INBOX, sp if kind in ('image', 'label') else '_other',
                               'images' if kind == 'image' else 'labels' if kind == 'label' else '')
        os.makedirs(dst_dir, exist_ok=True)
        dst = os.path.join(dst_dir, name)
        if os.path.abspath(src) != os.path.abspath(dst):
            if not os.path.exists(dst):
                shutil.copy2(src, dst)        # 复制，不改动原文件
            src = dst

    if kind in ('image', 'label'):
        lst = reg['splits'][sp][key]
        if name not in lst:
            lst.append(name)
            reg['splits'][sp][key].sort()
    elif kind == 'yaml':
        reg['data_yaml'] = name
    elif kind == 'doc':
        if name not in reg['docs']:
            reg['docs'].append(name)
    else:
        if name not in reg['unknown']:
            reg['unknown'].append(name)
    return kind, sp


def stem(name):
    return os.path.splitext(name)[0]


def receipt(reg, n_img, n_lab, n_yaml, n_doc, n_unk):
    L = []
    L.append('本次收到：%d 个（图片 %d / 标签 %d%s%s）' % (
        n_img + n_lab + n_yaml + n_doc + n_unk, n_img, n_lab,
        '，data.yaml %d' % n_yaml if n_yaml else '',
        '，待确认用途 %d' % n_unk if n_unk else ''))
    parts, pairs = [], {}
    for sp in SPLITS:
        ii = {stem(x) for x in reg['splits'][sp]['images']}
        li = {stem(x) for x in reg['splits'][sp]['labels']}
        pairs[sp] = len(ii & li)                     # 同名（去扩展名）才算配对
        parts.append('%s %d 组（图 %d / 标 %d）' % (sp, pairs[sp], len(ii), len(li)))
    L.append('累计已收：' + '、'.join(parts) + '（图片 + 标签同名才算 1 组）')
    lack = []
    for sp in SPLITS:
        d = EXPECT[sp] - pairs[sp]
        if d > 0:
            lack.append('%s 还差 %d 组' % (sp, d))
        elif d < 0:
            lack.append('%s 多出 %d 组' % (sp, -d))
    if not reg.get('data_yaml'):
        lack.append('缺 data.yaml')
    L.append('还缺：' + ('、'.join(lack) if lack else '无 —— 已齐（330 组 + data.yaml）'))
    if reg['unknown']:
        L.append('待确认：%s —— 请说明这些文件的用途（识别图片 / 训练数据 / 其他）' % '、'.join(reg['unknown'][:8]))
    if lack:
        L.append('下一步：继续上传（可成组选择：一个子集的全部图片 + 同名标签）；传完回一句「传完了」我就开始核验。')
    else:
        L.append('下一步：清单已齐 —— 回「传完了」进入核验（或直接说「开始核验」）。')
    return '\n'.join(L)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--add', nargs='*', default=[], help='要登记的文件路径（可多个）')
    ap.add_argument('--split', default='auto', choices=['auto'] + SPLITS, help='未知子集时的默认归属')
    ap.add_argument('--scan', default=None, help='扫描一个已有的数据集目录树（如 D:/Dataset）')
    ap.add_argument('--no-copy', action='store_true', help='只登记不复制副本')
    ap.add_argument('--note', default=None, help='备注当前进度（如「本机已有完整数据集」）')
    ap.add_argument('--status', action='store_true', help='仅打印当前清单')
    args = ap.parse_args()

    reg = load()
    if args.status:
        print(receipt(reg, 0, 0, 0, 0, 0)); return
    if args.note:
        reg['source_note'] = args.note

    n_img = n_lab = n_yaml = n_doc = n_unk = 0
    files = list(args.add)
    if args.scan:
        root = args.scan
        for dp, _dn, fn in os.walk(root):
            for f in fn:
                files.append(os.path.join(dp, f))
    if not files and not args.note:
        print('没有要登记的文件。用法见脚本头部说明。'); return

    for src in files:
        if not os.path.isfile(src):
            continue
        kind, _sp = register_one(reg, src, args.split, copy_in=not args.no_copy)
        if kind == 'image': n_img += 1
        elif kind == 'label': n_lab += 1
        elif kind == 'yaml': n_yaml += 1
        elif kind == 'doc': n_doc += 1
        else: n_unk += 1

    save(reg)
    print(receipt(reg, n_img, n_lab, n_yaml, n_doc, n_unk))


if __name__ == '__main__':
    sys.exit(main())
