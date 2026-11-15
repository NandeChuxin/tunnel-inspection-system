#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
export_onnx.py — 把训练好的 best.pt 导出为 ONNX（供 detector.js 的 onnxruntime-node 加载）

导出参数固定为 detector.js 的推理契约，改任一项都必须同步改 detector.js：
    imgsz=640           → detector.INPUT_SIZE = 640
    opset=12            → onnxruntime-node 1.22 稳定支持
    dynamic=False       → 固定 [1,3,640,640] 输入、[1,4+nc,8400] 输出
    simplify=True       → onnx-simplifier 精简计算图
    half=False          → CPU 推理用 FP32

输出：<weights 同目录>/<stem>.onnx，即 runs/<name>/weights/best.onnx。
detector.readQuality() 会到 runs/<name>/metrics.json 读配套指标 → 导出后必须保证
metrics.json 已存在，否则质量门控会判为「未找到配套 metrics.json」而停用。

用法：
    python tools/yolo/export_onnx.py --weights yolo-workspace/runs/6class-yolov8n/weights/best.pt
"""
import argparse
import json
import os
import sys


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', default='yolo-workspace/runs/6class-yolov8n/weights/best.pt')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--opset', type=int, default=12)
    ap.add_argument('--data', default=None, help='仅用于导出后打印类别名；不影响导出结果')
    args = ap.parse_args()

    if not os.path.exists(args.weights):
        print('权重不存在：%s' % args.weights)
        return 2

    try:
        from ultralytics import YOLO
    except Exception as e:
        print('导入 ultralytics 失败：%s' % e)
        return 3

    print('导出 ONNX：weights=%s imgsz=%d opset=%d' % (args.weights, args.imgsz, args.opset))
    model = YOLO(args.weights)
    out = model.export(
        format='onnx', imgsz=args.imgsz, opset=args.opset,
        simplify=True, dynamic=False, half=False,
    )

    out = str(out)
    size = os.path.getsize(out)
    print('\n✓ ONNX 已导出：%s（%.2f MB）' % (out, size / 1048576))

    # 记录导出参数，供复现与契约核对
    meta = {
        'weights': os.path.abspath(args.weights),
        'onnx': os.path.abspath(out),
        'imgsz': args.imgsz, 'opset': args.opset,
        'dynamic': False, 'simplify': True, 'half': False,
        'bytes': size,
        'names': {int(k): v for k, v in (getattr(model, 'names', {}) or {}).items()},
        'task': getattr(model, 'task', 'detect'),
    }
    meta_path = os.path.splitext(out)[0] + '.export.json'
    with open(meta_path, 'w', encoding='utf-8') as f:
        json.dump(meta, f, ensure_ascii=False, indent=1)

    run_dir = os.path.dirname(os.path.dirname(os.path.abspath(out)))
    metrics = os.path.join(run_dir, 'metrics.json')
    print('类别：%s' % json.dumps(meta['names'], ensure_ascii=False))
    print('导出参数：%s' % meta_path)
    if os.path.exists(metrics):
        with open(metrics, encoding='utf-8') as f:
            m = json.load(f)
        print('配套 metrics.json：epochs=%s mAP50=%s recall=%s' % (
            m.get('epochs'), m.get('mAP50'), m.get('recall')))
    else:
        print('⚠ 未找到配套 metrics.json（%s）—— 质量门控会因此停用模型，请先跑 train_yolo.py' % metrics)
        return 1
    return 0


if __name__ == '__main__':
    sys.exit(main())
