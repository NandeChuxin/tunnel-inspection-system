#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
eval_real_only.py — 只用「实拍」验证集评估，作为合成验证指标的现实校验

背景：补齐后的 6 类目数据集 val 里有 40+40 张合成图（衬砌错台 / 白华析出），
这两类没有任何实拍标注可用。若只看混合 val 的 mAP，等于「用合成题考合成学生」，
指标会显著偏高。本脚本把 val 里的合成图剔掉，只在实拍图上评估，得到一份
可以和答辩口头承诺对得上的数字。

注意：
  * 衬砌错台 / 白华析出 在实拍集中实例数为 0 → 其 AP 必然为 0/NaN，属预期。
    这恰恰说明「这两类的真实世界性能尚未被验证」。
  * 结果写入 runs/<name>/metrics.real-only.json，**不覆盖** metrics.json
    （质量门控读的是 metrics.json，避免把混合口径指标换成实拍口径）。

用法：
    python tools/yolo/eval_real_only.py --weights yolo-workspace/runs/6class-yolov8n/weights/best.pt
"""
import argparse
import json
import os
import shutil
import sys


def build_real_only_split(src_root, dst_root, split='val'):
    """把 dataset-6class 的 val 里非合成图（剔除 syn_/neg_ 前缀）复制成新的一层数据集"""
    simg = os.path.join(src_root, 'images', split)
    slbl = os.path.join(src_root, 'labels', split)
    dimg = os.path.join(dst_root, 'images', split)
    dlbl = os.path.join(dst_root, 'labels', split)
    if os.path.isdir(dst_root):
        shutil.rmtree(dst_root)
    os.makedirs(dimg, exist_ok=True)
    os.makedirs(dlbl, exist_ok=True)
    n = 0
    for f in sorted(os.listdir(simg)):
        stem = os.path.splitext(f)[0]
        if stem.startswith('syn_') or stem.startswith('neg_'):
            continue                      # 只保留实拍
        shutil.copy2(os.path.join(simg, f), os.path.join(dimg, f))
        lp = os.path.join(slbl, stem + '.txt')
        if os.path.exists(lp):
            shutil.copy2(lp, os.path.join(dlbl, stem + '.txt'))
        n += 1
    return n


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default='yolo-workspace/runs/6class-yolov8n/weights/best.pt')
    ap.add_argument('--data', default='yolo-workspace/dataset-6class/data.yaml')
    ap.add_argument('--src', default='yolo-workspace/dataset-6class')
    ap.add_argument('--dst', default='yolo-workspace/dataset-6class-realval')
    ap.add_argument('--imgsz', type=int, default=640)
    args = ap.parse_args()

    if not os.path.exists(args.weights):
        print('权重不存在：%s' % args.weights)
        return 2

    # 读主 data.yaml 的类别定义，保证两边完全一致
    names = None
    nc = None
    try:
        import yaml
        with open(args.data, encoding='utf-8') as f:
            cfg = yaml.safe_load(f)
        names = cfg.get('names')
        nc = cfg.get('nc')
    except Exception as e:
        print('读取 data.yaml 失败：%s' % e)
        return 3

    n = build_real_only_split(args.src, args.dst, 'val')
    print('实拍 val 图片数：%d（已剔除 syn_/neg_ 合成图）' % n)
    if n == 0:
        print('没有实拍 val 图，无法评估')
        return 4

    # train 指回主数据集（只为通过 Ultralytics 的数据集自检，不参与评估）
    yml = os.path.join(args.dst, 'data.yaml')
    main_train = os.path.abspath(os.path.join(args.src, 'images', 'train')).replace('\\', '/')
    with open(yml, 'w', encoding='utf-8') as f:
        f.write('# 由 tools/yolo/eval_real_only.py 生成（仅实拍 val）\n')
        f.write('path: %s\n' % os.path.abspath(args.dst).replace('\\', '/'))
        f.write('train: %s\n' % main_train)
        f.write('val: images/val\n')
        f.write('nc: %s\n' % nc)
        f.write('names: %s\n' % json.dumps(names, ensure_ascii=False).replace('"', "'"))

    try:
        from ultralytics import YOLO
    except Exception as e:
        print('导入 ultralytics 失败：%s' % e)
        return 3

    print('实拍口径评估：weights=%s data=%s imgsz=%d' % (args.weights, yml, args.imgsz))
    metrics = YOLO(args.weights).val(data=yml, imgsz=args.imgsz, device='cpu', split='val')
    box = metrics.box
    rd = getattr(metrics, 'results_dict', None) or {}

    def _vec(v):
        if v is None:
            return []
        try:
            return [float(x) for x in v]
        except TypeError:
            return []

    maps = _vec(getattr(box, 'maps', None))
    ap50 = _vec(getattr(box, 'ap50', None))
    idx = [int(x) for x in _vec(getattr(box, 'ap_class_index', None))]
    nm = {int(k): v for k, v in (getattr(metrics, 'names', {}) or {}).items()}

    out = {
        'scope': 'real-only val（剔除全部合成图）',
        'weights': os.path.abspath(args.weights),
        'data': os.path.abspath(yml),
        'images': n, 'imgsz': args.imgsz,
        'mAP50': float(rd.get('metrics/mAP50(B)', getattr(box, 'map50', 0.0))),
        'mAP50-95': float(rd.get('metrics/mAP50-95(B)', getattr(box, 'map', 0.0))),
        'precision': float(rd.get('metrics/precision(B)', getattr(box, 'mp', 0.0))),
        'recall': float(rd.get('metrics/recall(B)', getattr(box, 'mr', 0.0))),
        'per_class_AP50': {}, 'per_class_mAP50_95': {},
        'note': '衬砌错台 / 白华析出 在实拍集中无标注实例，其 AP 为 0 属预期；这两类的真实世界性能尚未验证。',
    }
    for i, ci in enumerate(idx):
        name = nm.get(int(ci), str(ci))
        if i < len(ap50):
            out['per_class_AP50'][name] = float(ap50[i])
        if i < len(maps):
            out['per_class_mAP50_95'][name] = float(maps[i])

    run_dir = os.path.dirname(os.path.dirname(os.path.abspath(args.weights)))
    out_path = os.path.join(run_dir, 'metrics.real-only.json')
    with open(out_path, 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    print('\n════════ 实拍口径指标（不含合成图）════════')
    print('实拍 val 图 %d 张' % n)
    print('mAP50      %.4f' % out['mAP50'])
    print('mAP50-95   %.4f' % out['mAP50-95'])
    print('Precision  %.4f' % out['precision'])
    print('Recall     %.4f' % out['recall'])
    for name in out['per_class_AP50']:
        print('  %-14s AP50 %.4f  AP50-95 %.4f' % (
            name, out['per_class_AP50'].get(name, float('nan')),
            out['per_class_mAP50_95'].get(name, float('nan'))))
    print('\n注意：%s' % out['note'])
    print('结果：%s' % out_path)
    return 0


if __name__ == '__main__':
    sys.exit(main())
