# YOLO 冒烟训练报告（3 epochs）

> **性质说明：这是一次「链路冒烟」训练，不是可用模型。** 下面所有数字都来自实际运行结果，未做任何修饰。
> 报告时间：2026-09-14 ｜ 运行环境：CPU（Intel Core Ultra 7 155H），无 NVIDIA 显卡

---

## 1 本次配置（实际生效值）

| 项 | 值 |
|---|---|
| 权重初始化 | `yolov8n.pt`（官方预训练，6.25MB，经镜像下载到 `yolo-workspace/weights/`） |
| 数据 | `yolo-workspace/dataset/data.yaml`（train 231 / val 66 / test 33，nc=3） |
| imgsz | 640 |
| epochs | **3**（冒烟） |
| batch | 4 |
| device | cpu |
| workers | 0 |
| seed | 42 |
| 框架 | Ultralytics 8.4.152 ｜ torch 2.14.0+cpu ｜ Python 3.13.14 |
| 耗时 | 约 **2.3 分钟**（3 epochs；≈46 秒/epoch） |

## 2 真实指标（val 集，来自 Ultralytics `val()`）

| 指标 | 值 |
|---|---|
| **mAP50** | **0.1180** |
| **mAP50-95** | **0.0472** |
| **Precision** | **0.7087** |
| **Recall** | **0.1363** |

逐类别：

| 类别 | AP50 | AP50-95 |
|---|---|---|
| Spalling（剥落） | 0.0686 | 0.0324 |
| Crack（裂缝） | 0.0915 | 0.0378 |
| Leakage（渗漏） | 0.1940 | 0.0716 |

逐 epoch 变化（训练日志原文，说明确实在学但远未收敛）：

| epoch | Box(P | R | mAP50 | mAP50-95) |
|---|---|---|---|
| 1/3 | 0.005 | 0.501 | 0.0517 | 0.0184 |
| 2/3 | 0.462 | 0.153 | 0.0907 | 0.0314 |
| 3/3 | 0.708 | 0.136 | 0.1190 | 0.0477 |

## 3 阶段 4 推理（用本次 3-epoch 权重，测试集 33 张）

在 `yolo-workspace/识别结果/`：`detections.json`、`detections.csv`、`vis/`（33 张画框图）。

| 项 | 实测 |
|---|---|
| 输入 | 测试集 33 张（conf 阈值 0.25，imgsz 640） |
| 有检出的图 | 15 / 33 |
| 目标总数 | 30 |
| 类别分布 | **Leakage 30，Spalling 0，Crack 0** |
| 置信度 | 最高 0.9571 ／ 中位 0.3674 ／ 最低 0.2583 |
| 大框（面积占比 >30%） | 8 / 30 |

## 4 诚实结论（重要）

- ✅ **链路已验证**：数据集 → 训练 → 权重 → 评估指标 → 推理输出（类别/置信度/归一化+像素坐标/可视化）全流程真实跑通，脚本无需修改即可复用于正式训练。
- ⛔ **本次权重不可用**：3 epochs 远不足以收敛。证据有三：① mAP50 仅 0.118；
  ② 推理结果**全部判为 Leakage**（Spalling/Crack 一个都没检出）；③ 出现多个覆盖画面 30%+ 的大框。
  这是欠训练的典型表现，**不要拿它当检测结果用**。
- 📌 **下一步**：按原始要求跑 `epochs=100`。本机实测 ≈46 秒/epoch，**100 epochs 约 75~90 分钟**（CPU），完全可跑：

```bash
C:/Users/17355/.workbuddy/binaries/python/envs/yolo/Scripts/python.exe \
  tools/yolo/train_yolo.py --data yolo-workspace/dataset/data.yaml \
  --model yolo-workspace/weights/yolov8n.pt --imgsz 640 --epochs 100 --batch 4 --workers 0 \
  --project yolo-workspace/runs --name yolov8n-100e
```

跑完权重要点：`yolo-workspace/runs/yolov8n-100e/weights/best.pt`；
指标：同目录 `metrics.json` 与 `指标摘要.md`；识别同阶段 4 命令（把 `--weights` 换成上面的路径）。

## 5 产物清单

```
yolo-workspace/
├─ weights/yolov8n.pt                         官方预训练权重（本次训练的起点）
├─ runs/smoke-yolov8n/
│   ├─ weights/best.pt, last.pt               本次 3-epoch 权重（5.94MB，不建议使用）
│   ├─ metrics.json                           真实指标（含逐类 AP）
│   ├─ 指标摘要.md                             同上，人读版
│   ├─ results.csv / results.png               逐 epoch 曲线
│   ├─ BoxPR_curve.png / BoxF1_curve.png 等    评估曲线
│   ├─ confusion_matrix.png                    混淆矩阵
│   └─ val_batch0~2_pred.jpg                   验证集预测可视化
└─ 识别结果/
    ├─ detections.json / detections.csv        类别 + 置信度 + 归一化/像素坐标
    └─ vis/                                    33 张画框图
```

## 6 本次踩到并已解决的环境坑（供复现参考）

| 现象 | 原因 | 解决 |
|---|---|---|
| `pip install ultralytics` 报 `502 Bad Gateway` | PyPI 直连经隧道不稳 | 换清华镜像 `-i https://pypi.tuna.tsinghua.edu.cn/simple` |
| 训练启动即失败，卡在 `yolov8n.pt` 下载（5KB/s → 502） | GitHub Releases 不可达 | 用 `ghproxy.net` 镜像下载权重到本地，`--model` 指本地文件 |
| 训练完成却读不到权重（`FileNotFoundError: .../last.pt`） | 相对 `--project` 被 Ultralytics 放进 `runs/detect/<相对路径>` | 改为绝对路径 + 以 `model.trainer.save_dir` 为准 |
| `ValueError: truth value of an array ... is ambiguous` | 对 numpy 数组写了 `x or []` | 改为显式判空/安全转换 |
| 画图时又去联网下字体 | Ultralytics 需 `Arial.ttf` | 把系统 `C:/Windows/Fonts/arial.ttf` 复制到其配置目录 |
