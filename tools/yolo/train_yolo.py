#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
train_yolo.py — 阶段 3：Ultralytics YOLO 训练（真实执行，不做任何数字编造）

前置：
    pip install -r tools/yolo/requirements-yolo.txt
    （CPU 环境建议先装 CPU 版 torch：见 requirements-yolo.txt 内注释）

用法：
    python tools/yolo/train_yolo.py \
        --data yolo-workspace/dataset-grouped/data.yaml \
        --model yolov8n.pt --imgsz 640 --epochs 100 --batch -1 \
        --project yolo-workspace/runs --name tunnel-yolov8n

输出：
    yolo-workspace/runs/<name>/weights/best.pt      最佳权重（阶段 4 用它推理）
    yolo-workspace/runs/<name>/metrics.json         本次真实指标（mAP50 / mAP50-95 / P / R + 各类 AP）
    yolo-workspace/runs/<name>/指标摘要.md

说明：本脚本只负责「跑训练 + 汇总 Ultralytics 返回的真实指标」。
      未装 torch / ultralytics 时会明确退出并提示安装命令，不会假装训练过。
"""
import argparse
import json
import os
import sys

# 说明：首次运行会自动下载预训练权重（yolov8n.pt，约 6MB），需要联网。


def die_no_ultralytics():
    print('=' * 72)
    print('未检测到 ultralytics / torch —— 当前环境无法实际训练（未实际训练）。')
    print('安装命令（二选一）：')
    print('  # 通用（自动装 torch，体积较大）')
    print('  pip install -r tools/yolo/requirements-yolo.txt')
    print('  # Windows CPU-only（体积更小、无需显卡）')
    print('  pip install torch torchvision --index-url https://download.pytorch.org/whl/cpu')
    print('  pip install ultralytics')
    print('装好后重跑本脚本即可。')
    print('=' * 72)
    sys.exit(3)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--data', default='yolo-workspace/dataset-grouped/data.yaml',
                    help='数据配置（默认使用按采集组隔离、无同源泄漏的数据集）')
    ap.add_argument('--model', default='yolov8n.pt', help='预训练权重或 .yaml 结构（默认 yolov8n.pt）')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--epochs', type=int, default=100)
    ap.add_argument('--batch', default='-1', help='-1 = auto（按显存/内存自适应）')
    ap.add_argument('--device', default='auto', help='auto | cpu | 0 | 0,1')
    ap.add_argument('--workers', type=int, default=2)
    ap.add_argument('--seed', type=int, default=42)
    ap.add_argument('--patience', type=int, default=30, help='早停耐心值')
    ap.add_argument('--project', default='yolo-workspace/runs')
    ap.add_argument('--name', default='tunnel-yolov8n')
    ap.add_argument('--eval-only', action='store_true', help='跳过训练，仅对已有权重做一次验证评估')
    ap.add_argument('--weights', default=None, help='--eval-only 时指定权重（默认 <project>/<name>/weights/best.pt）')
    ap.add_argument('--cache', default=False, action='store_true',
                    help='把解码后的图片缓存到内存（ram）。CPU 训练时可显著减少每轮 JPEG 解码开销')
    ap.add_argument('--cos-lr', default=False, action='store_true', help='余弦学习率调度')
    ap.add_argument('--close-mosaic', type=int, default=0,
                    help='最后 N 轮关闭 mosaic（>0 时生效；小数据集常设 10 提升收敛末期精度）')
    args = ap.parse_args()

    try:
        from ultralytics import YOLO
        import torch
    except Exception as e:
        print('导入 ultralytics 失败：%s' % e)
        die_no_ultralytics()

    if not os.path.exists(args.data):
        print('data.yaml 不存在：%s' % args.data)
        print('先用 tools/yolo/rebuild_dataset.py 重建数据集，或把 --data 指向本机 dataset 的 data.yaml')
        return 2

    device = args.device
    if device == 'auto':
        device = '0' if (hasattr(torch, 'cuda') and torch.cuda.is_available()) else 'cpu'
    batch = int(args.batch) if str(args.batch).lstrip('-').isdigit() else args.batch

    print('训练配置：data=%s model=%s imgsz=%d epochs=%d batch=%s device=%s' % (
        args.data, args.model, args.imgsz, args.epochs, batch, device))
    if device == 'cpu':
        print('提示：当前为 CPU 训练。330 张图 / epochs=%d / imgsz=%d 在 CPU 上会非常慢（数小时级），'
              '如需快速验证可先跑 --epochs 3 做冒烟测试。' % (args.epochs, args.imgsz))

    if args.eval_only:
        # 只评估：直接用已有权重做一次 val，不重训（也不加载 --model，避免无谓的权重下载）
        weights = args.weights or os.path.join(os.path.abspath(args.project), args.name, 'weights', 'best.pt')
        if not os.path.exists(weights):
            print('--eval-only 需要已有权重，未找到：%s' % weights); return 2
        run_dir = os.path.dirname(os.path.dirname(os.path.abspath(weights)))
        # 实际训练轮次以运行目录里的 args.yaml 为准（不能用命令行默认值，否则指标文件会写错轮次）
        _ay = os.path.join(run_dir, 'args.yaml')
        if os.path.exists(_ay):
            try:
                import yaml as _yaml
                _a = _yaml.safe_load(open(_ay, encoding='utf-8')) or {}
                if _a.get('epochs'):
                    args.epochs = int(_a['epochs'])
            except Exception:
                pass
        print('只评估模式：weights=%s（实际轮次 epochs=%s）' % (weights, args.epochs))
    else:
        model = YOLO(args.model)
        _train_kw = dict(
            data=args.data, imgsz=args.imgsz, epochs=args.epochs, batch=batch,
            device=device, workers=args.workers, seed=args.seed, patience=args.patience,
            project=os.path.abspath(args.project), name=args.name, exist_ok=True,
            cache=args.cache, cos_lr=args.cos_lr,
        )
        if args.close_mosaic > 0:
            _train_kw['close_mosaic'] = args.close_mosaic
        model.train(**_train_kw)
        # 真实输出目录由 trainer 决定（相对 project 会被 Ultralytics 放到 runs/detect/ 下），
        # 一律以 model.trainer.save_dir 为准，不要自己拼路径。
        run_dir = str(getattr(model.trainer, 'save_dir', '') or os.path.join(args.project, args.name))
        best = os.path.join(run_dir, 'weights', 'best.pt')
        weights = best if os.path.exists(best) else os.path.join(run_dir, 'weights', 'last.pt')

    # ---------- 用验证集做一次标准评估，取出真实指标 ----------
    metrics_obj = YOLO(weights).val(data=args.data, imgsz=args.imgsz, device=device, split='val')
    box = metrics_obj.box
    rd = getattr(metrics_obj, 'results_dict', None) or {}

    def _vec(v):
        """把 numpy 数组/标量安全转成 float 列表。
        坑：不能写 `v or []` —— numpy 数组（元素>1）的真值判断会抛
        'The truth value of an array with more than one element is ambiguous'。"""
        if v is None:
            return []
        try:
            return [float(x) for x in v]
        except TypeError:
            return []

    maps = _vec(getattr(box, 'maps', None))                  # 各类 mAP50-95
    ap50 = _vec(getattr(box, 'ap50', None))                  # 各类 AP50（新版才有）
    idx = [int(x) for x in _vec(getattr(box, 'ap_class_index', None))]
    names = {int(k): v for k, v in (getattr(metrics_obj, 'names', {}) or {}).items()}
    out = {
        'data': os.path.abspath(args.data),
        'weights': os.path.abspath(weights),
        'imgsz': args.imgsz, 'epochs': args.epochs, 'device': device,
        'mAP50': float(rd.get('metrics/mAP50(B)', getattr(box, 'map50', 0.0))),
        'mAP50-95': float(rd.get('metrics/mAP50-95(B)', getattr(box, 'map', 0.0))),
        'precision': float(rd.get('metrics/precision(B)', getattr(box, 'mp', 0.0))),
        'recall': float(rd.get('metrics/recall(B)', getattr(box, 'mr', 0.0))),
        'per_class_mAP50_95': {},
        'per_class_AP50': {},
    }
    for i, ci in enumerate(idx):
        nm = names.get(int(ci), str(ci))
        if i < len(maps):
            out['per_class_mAP50_95'][nm] = float(maps[i])
        if i < len(ap50):
            out['per_class_AP50'][nm] = float(ap50[i])

    os.makedirs(run_dir, exist_ok=True)
    with open(os.path.join(run_dir, 'metrics.json'), 'w', encoding='utf-8') as f:
        json.dump(out, f, ensure_ascii=False, indent=1)

    lines = ['# YOLO 训练指标（真实评估结果，来自 Ultralytics val()）', '',
             '| 指标 | 值 |', '|---|---|',
             '| mAP50 | %.4f |' % out['mAP50'],
             '| mAP50-95 | %.4f |' % out['mAP50-95'],
             '| Precision | %.4f |' % out['precision'],
             '| Recall | %.4f |' % out['recall'],
             '| 权重 | `%s` |' % out['weights'], '',
             '| 类别 | AP50 | AP50-95 |', '|---|---|---|']
    for nm in out['per_class_AP50'] or out['per_class_mAP50_95']:
        lines.append('| %s | %.4f | %.4f |' % (
            nm, out['per_class_AP50'].get(nm, float('nan')), out['per_class_mAP50_95'].get(nm, float('nan'))))
    with open(os.path.join(run_dir, '指标摘要.md'), 'w', encoding='utf-8') as f:
        f.write('\n'.join(lines) + '\n')

    print('\n════════ 训练完成（真实指标）════════')
    print('mAP50      %.4f' % out['mAP50'])
    print('mAP50-95   %.4f' % out['mAP50-95'])
    print('Precision  %.4f' % out['precision'])
    print('Recall     %.4f' % out['recall'])
    for nm in out['per_class_AP50'] or out['per_class_mAP50_95']:
        print('  %-9s AP50 %.4f  AP50-95 %.4f' % (nm, out['per_class_AP50'].get(nm, -1), out['per_class_mAP50_95'].get(nm, -1)))
    print('权重：%s' % out['weights'])
    print('指标：%s' % os.path.join(run_dir, 'metrics.json'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
