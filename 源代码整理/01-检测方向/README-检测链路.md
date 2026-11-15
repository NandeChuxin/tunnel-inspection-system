# 检测方向 · 源码说明

> 覆盖「一张隧道病害图 → 检出框 + 类型 + 等级 → 可选写入台账」的完整链路。
> 本目录下的 `代码/` 是与这条链路直接相关的源码（后端整文件 + 前端按行号摘录）。

---

## 1 链路总览

```
浏览器 · 工位 01 检测工作台
  │  POST /api/detect/image
  │  { image:{dataUrl}, tunnel, mileage, source, archive, params:{confidenceThreshold} }
  ▼
backend/server.js  L271 ──►  backend/infer.js  detectImage(body)
                                 │
                                 ├─ vision.js             PNG 解码 → 灰度/尺寸归一（≤640 降采样）
                                 │                        中间产物：CLAHE → 高斯 → Canny/Sobel → Otsu
                                 ├─ 候选 ROI 提取          二值化投影 + 连通域 → 候选框
                                 ├─ mask.js               框内 Otsu（极性自适应）→ 8 邻域连通域
                                 │                        → 面积 / 长度 / 宽度（实例掩码）
                                 ├─ fusion.js             特征 → 融合打分 → gradeDefect() 四级定级
                                 │   （若运行时注入 model.createPredictor → 15 维特征 softmax 分类，
                                 │     未注入则退化为纯规则引擎 —— 这是回归安全的开关）
                                 └─ intermediate-cache.js 中间产物按 taskId 入缓存（TTL 30 分钟）
  ◄── DetectResult { taskId, elapsedMs, input{widthPx,heightPx}, params, detections[], intermediates[] }
       detections[]: { class_name, level, level_text, confidence, bbox, position{bbox,chainage,sector}, mask }

  archive !== false 时追加一步：portal.archiveDetect() → SQLite image / detection 表
  （前端默认 archive:false，避免演示台账被测试数据污染）
```

前端拿到 `DetectResult` 后：
- `renderCards()` 渲染右侧**检出结果卡列表**（类型·子类 / 等级 / 置信度 / 判定依据 / 养护建议）
- `draw()` 在画布上叠加**检出框**（坐标用后端返回的 `input.widthPx/heightPx` 尺度，不要用原图尺寸）
- 点击任一检出卡 → 确认浮层 → `window.__kgLearn(ctx)` 跳到知识图谱学这道病害

---

## 2 文件清单（后端，整文件照搬）

| 文件 | 职责 | 关键点 |
|---|---|---|
| `vision-图像处理与PNG编解码.js` | 纯 JS 图像处理：PNG 解码/编码、CLAHE、高斯、Canny、Sobel、Otsu、ROI | 只解 8bit 非隔行 PNG；照片需先转 PNG |
| `infer-检测编排与DetectResult.js` | 检测编排：解码 → ROI → 掩码 → 融合 → 组装返回 | 返回结构（DetectResult）请勿改动，前端与验收脚本都依赖它 |
| `fusion-特征融合与病害分级.js` | 特征计算 → 融合打分 → `gradeDefect()` 四级定级 | 提供 `setClassifier()` 注入点；未注入 = 规则引擎 |
| `model-训练模型推理(15维分类器).js` | 运行时构造 15 维特征分类器（softmax），读 `data/model_params.json` | `createPredictor(mp).classify` 注入 fusion |
| `mask-实例掩码(框内Otsu+连通域).js` | 框内 Otsu（极性自适应）→ 8 邻域连通域 → 面积/长度/宽度 | 掩码级标注能力，也是「中间产物」之一 |
| `detector-检测器占位与说明.js` | 说明本项目未使用 YOLOv8n（零依赖约束），检测由 vision+fusion 完成 | 历史占位，保留说明 |
| `intermediate-cache-中间产物缓存(TTL).js` | 中间产物按 taskId 缓存，供热力图/四步图复用 | TTL 30 分钟，避免重复计算 |
| `db-schema-数据库建表(image_detection等).sql` | 建表：`image`（图）、`detection`（检出，含 level/approved/reviewer 等） | schema v5，共 10 张表 |
| `train-*.js`（7 个） | 训练与评测管线（见第 4 节） | 零依赖实现，无 PyTorch |

## 3 文件清单（前端，按行号摘录）

| 摘录文件 | 出处（docs/prototype-holo-core.html） | 内容 |
|---|---|---|
| `frontend-01-检测工作台UI.html` | L1194–1219 | 工位 01 面板结构：`#labFile` 上传、`#labDrop` 拖放区、`#labCanvas` 画布、`#labList` 检出列表、阈值滑杆 |
| `frontend-02-Lab模块-检测逻辑.js` | L2354–3119 | §4 检测工作台（Lab）功能层：API 基址判定、PNG 载入、`runDetect()`、`runHeat()`、视频取帧、结果卡渲染、检出框绘制、事件绑定 |
| `frontend-03-卡片01上传绑定.js` | L4873–5044 | 上传/粘贴/拖放绑定 + 「完整工作台」入口 |
| `frontend-04-源码索引-接口摘录.js` | backend/server.js L267–310 | 后端检测接口本体（`POST /api/detect/image`）与参数化管线接口 |

---

## 4 训练与评测管线（backend/train/）

| 步骤 | 脚本 | 作用 |
|---|---|---|
| ① 造数据 | `gen-dataset.js` | 程序化合成病害图 + 紧致 bbox（PNG） |
| ② 打样本 | `build-samples.js` | 从图中切 ROI 并打标：合成域用 IoU≥0.3，真实域用**覆盖度匹配** |
| ③ 训练 | `train.js` / `train-mix.js` | `train.js`：纯合成；`train-mix.js`：**合成 480 + 真实样本 ×3 混合**（推荐）→ 写 `data/model_params.json` |
| ④ 评测 | `eval-real.js` | 真实集端到端 A/B（规则引擎 vs 训练模型）：P/R/F1/IoU |
| ⑤ 消融 | `ablation.js` | 5 组留一，验证各环节贡献 |
| ⑥ 导出 | `export-yolo.js` | 按 8:2 导出 YOLO 格式数据集（供外部训练） |

复现命令：

```bash
node backend/train/build-samples.js
node backend/train/train-mix.js --epochs 5000 --realWeight 3
node backend/train/eval-real.js
```

实测指标（2026-09-13，83 张实拍 + 480 合成混合训练）：

| 指标 | 规则引擎基线 | 混合训练模型 |
|---|---|---|
| 真实域 ROI F1 | 4.5% | **64.3%**（+59.8pp） |
| 真实域查准率 P | 20.5% | **48.6%** |
| 真实域查全率 R | 89.5% | **94.7%** |
| 全集合 ROI F1 | 56.6% | **85.8%** |
| 类型准确率 | 31.2% | **81.4%** |

旧模型备份：`backend/data/model_params.pre-batch2.json`（升级前）与 `model_params.pre-real.json`（更早）。

---

## 5 参数默认值（改动前请三思，验收脚本与前端默认值与之耦合）

| 参数 | 默认 | 说明 |
|---|---|---|
| 置信度阈值 | `0.55` | 前端滑杆可实时覆盖（`params.confidenceThreshold`） |
| NMS | 关闭 | 当前不做非极大值抑制 |
| CLAHE | clip `2.0` / tile `8×8` | 弱光衬砌增强 |
| 高斯 | `5×5` | 去噪 |
| Canny / Sobel | `70` | 边缘阈值 |
| Otsu | 开启 | 二值化 |
| `CELL` | `12` | 特征网格 |

---

## 6 对外接口（检测方向）

| 接口 | 方法 | 入参 | 出参 |
|---|---|---|---|
| `/api/detect/image` | POST | `{ image:{dataUrl}, tunnel, mileage, speed, source, archive, params:{confidenceThreshold} }` | `DetectResult`（见第 1 节） |
| `/api/explain/detect` | POST | `{ image:{dataUrl}, heatmapMethod:'auto'\|'eigen'\|'gradcam' }` | `{ heatmap{method,alpha,dataUrl}, steps{...}, meta{widthPx,heightPx} }` |
| `/api/pipeline/params` | PUT | 管线参数覆盖（教学用，局部重算） | 当前生效参数 |
| `/api/model/info` / `/api/model/mode` | GET/POST | 查看 / 切换「规则引擎 ↔ 训练模型」 | 当前模式 |

> 注意：前端跨源调用时必须用 `Content-Type: text/plain` 发送 JSON 字符串——后端没有处理 `OPTIONS`，
> 用 `application/json` 会先触发 CORS 预检然后被拦掉。

---

## 7 快速自测

```bash
# 1) 起服务
node backend/server.js            # 后端 8787
node tools/serve-docs.js          # 前端 8899 → docs/prototype-holo-core.html

# 2) 整目录批量检测并导出三种格式（YOLO txt / COCO json / CSV）
node tools/batch-infer.js --dir backend/data/train-real/images --format yolo,coco,csv --out out/

# 3) 验收
node backend/verify-base.js       # 基础链路（含检测接口与自动入库断言）
```

浏览器侧：打开 `http://127.0.0.1:8899/prototype-holo-core.html` → 工位 **01 检测工作台** → 上传任意隧道照片 → 右侧出现检出列表 → 点一条可跳知识图谱。
