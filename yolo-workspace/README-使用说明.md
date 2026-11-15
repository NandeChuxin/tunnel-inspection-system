# YOLO 训练与识别工作区（yolo-workspace）

> 本目录按 YOLO/Ultralytics 流程处理「隧道缺陷检测数据集」：登记 → 核验 → 重建 → 训练 → 识别。
> **所有数字均来自实际解析与实际运行，未编造。** 只以只读方式访问原始数据，未修改、未删除任何原始文件。

---

## 0 当前状态（一句话）

**5 类病害的数据已补齐到 6 个类目（含背景负样本），六层核验全通过；但 50 epochs 正式训练尚未跑完，
所以 `best.onnx` 还不存在、YOLO 仍按质量门控默认停用。** 训练只需一条命令（见 §3.2），CPU 约 3.5 小时。

| 阶段 | 状态 | 产物 |
|---|---|---|
| 阶段 1 接收与登记 | ✅ 完成 | `上传登记清单.json` |
| 阶段 2 核验（原始 3 类） | ✅ 共发现问题 0 处 | `核验报告-数据集.md` |
| 阶段 2b 数据集重建 | ✅ 330 组配对、无孤儿 | `dataset/` |
| **阶段 2c 补齐 6 类目** | ✅ **六层核验全通过** | **`dataset-6class/`** → 详见 `数据集说明-6类目.md` |
| 阶段 3 冒烟训练（3 epochs） | ✅ 已实际执行（链路验证用，权重不可用） | `runs/smoke-yolov8n/` → `训练报告-冒烟3epochs.md` |
| 阶段 3′ 正式训练（50 epochs） | ⏳ **待执行** | 命令见 §3.2 |
| 阶段 4 ONNX 导出 + 门控启用 | ⏳ 依赖阶段 3′ | 命令见 §3.3 |
| 阶段 5 识别 | ✅ 曾用冒烟权重跑通（33 张） | `识别结果/`（旧权重结果，勿当结论） |

### 数据集现状（`dataset-6class/`）

| 项目 | 实际值 |
|---|---|
| 图片 / 标签 / 框 | **1475 / 1475 / 3490** |
| 切分 | train 1226 · val 166 · test 83 |
| 类别 | `nc=5`：Spalling / Crack / Leakage / LiningOffset / Efflorescence |
| 类目（含背景负样本） | **6 个**，train 每类 ≥150 张 |
| 背景负样本 | 180 张（空标签；train 150 / val 20 / test 10） |
| 合成图底图 | **全部用实拍底图**（程序化背景已停用，理由见 `数据集说明-6类目.md`） |
| 渗漏水实例占比 | 42.5% → **23.1%** |
| 最多/最少类实例数比 | **1.92**（阈值 ≤2.0） |
| L1~L6 核验 | 文件 / 图像 / 对应 / 内容 / 平衡 / 门槛 **全部通过** |
| data.yaml | nc=5，names 与 `backend/detector.js` 的 `TYPES` 逐位一致 |

> 想先看数据长什么样：打开 **`数据样例-6类目.png`**（6 个类目各抽 4 张 + GT 框）。
> 重新生成：`python tools/yolo/make_sample_sheet.py --root yolo-workspace/dataset-6class --out yolo-workspace/数据样例-6类目.png`

> 「6 类目」的准确含义（5 个病害类 + 背景负样本）、数据来源构成、错台为什么用
> 画布级几何错动而不是贴片、以及「错台/白华没有实拍标注」这一诚实边界，
> 都写在 **`数据集说明-6类目.md`** 里。动模型前请先读它。

---

## 1 两个数据集，别搞混

| 目录 | 类别 | 用途 |
|---|---|---|
| `dataset/` | 3 类（Spalling/Crack/Leakage） | 最早的实拍集，历史基线，`核验报告-数据集.md` 对应它 |
| **`dataset-6class/`** | **5 类 + 背景负样本** | **当前正式训练集**，`核验报告-数据集-6类.md` 对应它 |

`dataset-grouped/` 是最早按采集组重划分的实验产物，保留作对照。

---

## 2 目录内容

```
yolo-workspace/
├─ 数据集说明-6类目.md            ★ 6 类目怎么来的、数据来源、诚实边界
├─ 核验报告-数据集-6类.md          ★ 六层核验（自动生成）
├─ 数据样例-6类目.png             ★ 6 类目样例 + GT 框（人工复核数据质量用）
├─ dataset-6class/               ★ 当前正式训练集（1475 图 / 3490 框）
│   ├─ images|labels/{train,val,test}/
│   ├─ data.yaml                 nc=5
│   └─ build-stats.json          逐类补齐量 / 来源计数 / 平衡轮次
├─ dataset/                      原始 3 类实拍集（历史基线）
├─ dataset-grouped/              按采集组重划分的对照集
├─ 核验报告-数据集.md             原始 3 类集核验（0 问题）
├─ 训练报告-冒烟3epochs.md        3 epochs 冒烟（链路验证，权重不可用）
├─ weights/yolov8n.pt            官方预训练权重（经镜像下载）
├─ runs/smoke-yolov8n/           3 epochs 冒烟产物
└─ 识别结果/                     旧权重推理产物（勿当结论）
```

---

## 3 怎么继续

### 3.1 依赖已装好（独立 venv，不影响系统 Python）

```
C:/Users/17355/.workbuddy/binaries/python/envs/yolo/Scripts/python.exe
   ├─ torch 2.14.0+cpu   ├─ torchvision 0.29.0+cpu   ├─ ultralytics 8.4.152
   └─ onnx 1.23.2        └─ onnxslim（导出 ONNX 需要，已装）
```

自检：

```bash
.../envs/yolo/Scripts/python.exe -c "import torch,ultralytics,onnx;print(torch.__version__,ultralytics.__version__,onnx.__version__)"
```

### 3.2 正式训练（50 epochs，CPU 实测约 3.5 小时）

```bash
cd D:/隧道检测/tunnel-inspection-system
.../envs/yolo/Scripts/python.exe tools/yolo/train_yolo.py \
  --data yolo-workspace/dataset-6class/data.yaml \
  --model yolo-workspace/weights/yolov8n.pt \
  --imgsz 640 --epochs 50 --batch 16 --workers 0 --cache --cos-lr --close-mosaic 10 \
  --patience 50 --seed 42 \
  --project yolo-workspace/runs --name 6class-yolov8n
```

**实测耗时（本机 Intel Core Ultra 7 155H，纯 CPU，无独显）**：
1226 张 train / batch 16 / imgsz 640 → **约 4.0 分钟/epoch**，50 epochs ≈ **3.5 小时**。

几个已踩过的坑，别改：

| 参数 | 为什么必须这样 |
|---|---|
| `--workers 0` | Ultralytics 在 CPU 上会强制 `workers=0`（源码注释：`faster CPU training as time dominated by inference`），传 8 也会被覆盖 |
| `--cache` | 把解码后的图缓到内存（约 1.4 GB），省掉每轮 JPEG 解码。代价：日志会警告「可能非确定性」，可复现性要求很高时改用 `--cache false` |
| `--batch 16` | CPU 上 16 是吞吐拐点，再大内存换不来速度 |
| `--close-mosaic 10` | 最后 10 轮关 mosaic，小数据集收敛末期更稳 |
| `--imgsz 640` | 必须与 `backend/detector.js` 的 `INPUT_SIZE=640`、`N_ANCHOR=8400` 对齐，改一个要同步改三处 |

产出：`runs/6class-yolov8n/weights/best.pt` + `metrics.json` + `指标摘要.md`。

### 3.3 导出 ONNX 并让门控自动启用（训练完成后再做）

```bash
# ① 导出（自动写 best.onnx 与 best.export.json）
.../envs/yolo/Scripts/python.exe tools/yolo/export_onnx.py \
  --weights yolo-workspace/runs/6class-yolov8n/weights/best.pt --imgsz 640

# ② 端到端验收：门控判定 → ORT 实际加载 → 输出张量形状 → 真实影像推理
node tools/yolo/verify-model.js

# ③ 实拍口径复评（剔除合成 val，看清真实世界表现）
.../envs/yolo/Scripts/python.exe tools/yolo/eval_real_only.py \
  --weights yolo-workspace/runs/6class-yolov8n/weights/best.pt
```

门控规则（`backend/detector.js` 的 `QUALITY_MIN`，三选三才算过）：

| 项 | 门槛 |
|---|---|
| epochs | ≥ 20 |
| mAP50 | ≥ 0.5 |
| recall | ≥ 0.4 |

`backend/detector.js` 会到 `runs/6class-yolov8n/metrics.json` 读配套指标 —— 所以**导出前必须已跑完
`train_yolo.py`**（它负责写 `metrics.json`）。指标不达标时门控会拒绝启用并打印卡在哪一项，
这是设计行为，不是 bug。

### 3.4 识别（阶段 5）

```bash
.../envs/yolo/Scripts/python.exe tools/yolo/predict_yolo.py \
  --weights yolo-workspace/runs/6class-yolov8n/weights/best.pt \
  --source yolo-workspace/dataset-6class/images/test \
  --out yolo-workspace/识别结果-6类 --conf 0.25
```

---

## 4 核验与回归命令（都不需要 GPU）

```bash
# 数据集六层核验（文件/图像/对应/内容/平衡/门槛）
node tools/yolo/verify-6class.js

# 门控 + 类别映射契约单测（改了 detector.js 必跑）
node backend/detector-quality-test.js

# 全量回归
npm test
```

`detector-quality-test.js` 会逐位断言 `data.yaml` 的 `names` 与 `detector.TYPES` 一致 ——
**类别下标错一位不会报错，只会让模型把「错台」当「渗漏水」输出**，所以这条测试是硬护栏，别删。

---

## 5 一个诚实的补充：本项目另有「零依赖检测链路」

本仓库原有一套自研零依赖检测链路（`backend/vision.js` + `fusion.js` + `infer.js`，见 `源代码整理/01-检测方向/`），
不装 torch 也能对图片输出「病害类别 + 等级 + 置信度 + 检出框」，线上平台在用 —— 但它**不是 YOLO**，
没有 YOLO 权重与 mAP。两者不要混为一谈。

YOLO 启用后，两条链路可现场切换对比：`rules`（规则+融合）vs `learned`（YOLOv8n）。
