#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""
predict_yolo.py — 阶段 4：用训练好的权重做缺陷识别（推理）

用法：
  # 单张
  python tools/yolo/predict_yolo.py --weights yolo-workspace/runs/tunnel-yolov8n/weights/best.pt \
         --source D:/path/待识别.jpg --out yolo-workspace/识别结果
  # 整个目录（可含 jpg/png）
  python tools/yolo/predict_yolo.py --weights ... --source D:/待识别目录 --out yolo-workspace/识别结果

输出：
  <out>/detections.json   每个目标的：类别、置信度、归一化 xywh、像素 xyxy
  <out>/detections.csv    同上，表格形式
  <out>/vis/<图名>         画框后的可视化结果图（可用 --no-vis 关闭）

说明：
  · 权重不存在时会明确报错退出（不会假装识别过）。
  · 输出坐标全部来自模型实际推理结果。
"""
import argparse
import csv
import json
import os
import sys

IMG_EXT = ('.jpg', '.jpeg', '.png', '.bmp', '.webp')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--weights', required=True, help='训练得到的 best.pt')
    ap.add_argument('--source', required=True, help='待识别图片或目录')
    ap.add_argument('--imgsz', type=int, default=640)
    ap.add_argument('--conf', type=float, default=0.25)
    ap.add_argument('--iou', type=float, default=0.45)
    ap.add_argument('--out', default='yolo-workspace/识别结果')
    ap.add_argument('--device', default='auto')
    ap.add_argument('--no-vis', action='store_true', help='不输出可视化图片')
    args = ap.parse_args()

    if not os.path.exists(args.weights):
        print('权重不存在：%s' % args.weights)
        print('请先完成阶段 3 训练（tools/yolo/train_yolo.py），权重在其输出目录 weights/best.pt')
        return 3
    try:
        from ultralytics import YOLO
        import torch
    except Exception as e:
        print('导入 ultralytics 失败：%s' % e)
        print('请先：pip install -r tools/yolo/requirements-yolo.txt'); return 3

    device = args.device
    if device == 'auto':
        device = '0' if (hasattr(torch, 'cuda') and torch.cuda.is_available()) else 'cpu'

    model = YOLO(args.weights)
    # project 必须给绝对路径：相对路径会被 Ultralytics 塞进 runs/detect/<相对路径> 下，
    # 结果图就不在 --out 里了（这一步踩过坑）。
    results = model.predict(source=args.source, imgsz=args.imgsz, conf=args.conf,
                            iou=args.iou, device=device, save=not args.no_vis,
                            project=os.path.abspath(args.out), name='vis', exist_ok=True, verbose=False)

    rows = []
    for r in results:
        path = getattr(r, 'path', '')
        names = r.names if isinstance(r.names, dict) else {i: n for i, n in enumerate(r.names)}
        b = r.boxes
        if b is None or len(b) == 0:
            rows.append({'image': os.path.basename(path), 'index': None, 'class_id': None,
                         'class_name': None, 'confidence': None,
                         'xywhn': None, 'xyxy_px': None, 'note': '无检出'})
            continue
        xyxy = b.xyxy.cpu().numpy()
        xywhn = b.xywhn.cpu().numpy()
        cls = b.cls.cpu().numpy().astype(int)
        conf = b.conf.cpu().numpy()
        for i in range(len(b)):
            rows.append({
                'image': os.path.basename(path),
                'index': int(i) + 1,
                'class_id': int(cls[i]),
                'class_name': str(names.get(int(cls[i]), cls[i])),
                'confidence': round(float(conf[i]), 4),
                'xywhn': [round(float(v), 6) for v in xywhn[i]],           # 归一化 cx,cy,w,h
                'xyxy_px': [round(float(v), 2) for v in xyxy[i]],          # 像素 x1,y1,x2,y2
            })

    os.makedirs(args.out, exist_ok=True)
    with open(os.path.join(args.out, 'detections.json'), 'w', encoding='utf-8') as f:
        json.dump({'weights': os.path.abspath(args.weights), 'conf': args.conf,
                   'imgsz': args.imgsz, 'device': device, 'detections': rows}, f, ensure_ascii=False, indent=1)
    with open(os.path.join(args.out, 'detections.csv'), 'w', newline='', encoding='utf-8-sig') as f:
        w = csv.writer(f)
        w.writerow(['image', 'idx', 'class_id', 'class_name', 'confidence',
                    'cx_n', 'cy_n', 'w_n', 'h_n', 'x1_px', 'y1_px', 'x2_px', 'y2_px'])
        for d in rows:
            if d.get('class_id') is None:
                w.writerow([d['image'], '', '', '', '', '', '', '', '', '', '', '', ''])
                continue
            x, y, bw, bh = d['xywhn']; x1, y1, x2, y2 = d['xyxy_px']
            w.writerow([d['image'], d['index'], d['class_id'], d['class_name'], d['confidence'],
                        x, y, bw, bh, x1, y1, x2, y2])

    n_img = len(results)
    n_det = len([r for r in rows if r.get('class_id') is not None])
    print('识别完成：%d 张图，共 %d 个目标' % (n_img, n_det))
    for d in rows[:20]:
        if d.get('class_id') is None:
            print('  %-28s 无检出' % d['image']); continue
        x, y, bw, bh = d['xywhn']
        print('  %-28s #%d %-9s conf=%.3f  xywhn=(%.3f,%.3f,%.3f,%.3f)  px=(%s)'
              % (d['image'], d['index'], d['class_name'], d['confidence'], x, y, bw, bh,
                 ','.join(str(int(v)) for v in d['xyxy_px'])))
    print('明细：%s' % os.path.join(args.out, 'detections.json'))
    print('可视化：%s' % (os.path.join(args.out, 'vis') if not args.no_vis else '(已关闭)'))
    return 0


if __name__ == '__main__':
    sys.exit(main())
