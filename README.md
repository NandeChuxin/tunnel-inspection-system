# 隧途明鉴 — 隧道病害智能检测与分析系统（原型版）

以车载摄像头与多类传感器为前端感知终端，依托光电成像采集隧道表面影像，数据实时上传后端平台；通过**多源异构数据融合算法**智能识别裂缝、渗漏水、剥落掉块、衬砌错台、白华析出等病害，自动完成**类型判定、等级评估、位置精准标注（桩号+环向方位）**，同步生成整治建议方案，最终由**人工审核敲定处置决策**，实现"自动化巡检 → 智能分析 → 辅助决策"全流程闭环。

## 快速启动

**一键预览（推荐）**——同时启动后端 API 与预览界面，打印访问地址：

```bash
node start-preview.mjs
```

- 预览界面：<http://127.0.0.1:8899/prototype-holo-core.html>（六轨道工位：检测工作台 / 视图 / 病害档案 / 人工复核 / 统计与报告 / 知识图谱）
- 后端 API：<http://127.0.0.1:8787>（`GET /api/model/info` 可查当前引擎与训练指标）
- 首次运行数据库为空时**自动播种演示数据**（内置合成样本走真实推理链路入库，可在台账删除）

**分步启动**（等价）：

```bash
node backend/server.js        # 后端 API → http://localhost:8787（端口可用 TUNNEL_PORT 修改）
node tools/serve-docs.js      # 预览静态服务 → http://localhost:8899
```

环境要求：**Node.js ≥ 22.5**（用到 node:sqlite 实验特性），零第三方依赖，无需 npm install。
训练 / 评测脚本（可选）：`node backend/train/train-mix.js`、`node backend/train/ablation.js`、回归护栏 `backend/verify-base.js` 与 `backend/w0~w4-verify.js`。

## 数据采集中心：照片流 + 视频流

### 照片流

- 点击/拖拽上传隧道照片（JPG/PNG），前端 Canvas 对画面做像素级特征提取（Sobel 边缘密度、暗色湿渍占比、纹理方差、环向角度），提交后端多源融合识别；
- 识别结果直接标注在照片上（类型+等级+置信度框选），逐条给出**整治建议方案**；
- **自动审核规则：1 级（轻微）病害由系统自动审核闭环**，2 级及以上进入人工审核队列，审核员核定等级、选择处置决策后敲定。

### 视频流

- 支持**上传视频文件**、**实时传输**（摄像头）或**导入在线视频**（粘贴 B 站链接/BV 号，后端解析直链下载为本地同源文件后接入），对视频逐帧采样分析（每 0.7s 一帧）；
- 当前帧实时绘制病害标注框，下方滚动展示逐帧检出卡片，桩号随帧推进；
- 检出病害同样进入台账与审核闭环流程。

### 使用说明

1. **照片流**：上传一张照片即可看到标注结果、整治建议与审核状态；
2. **视频流**：上传视频文件或点击"实时传输（摄像头）"，逐帧分析自动开始，可随时"停止分析"；
3. **病害台账**：按状态（待审核/已审核/已驳回）与隧道过滤检索，来源列区分照片流/视频流；
4. **人工审核**：详情弹窗展示证据链与整治建议，审核人填写意见、核定等级、选择处置决策后"通过并敲定决策"或"驳回复检"。

### 功能演示要点

- **报告导出**：一键导出 Excel 检测报告（检测概况 + 病害明细 双 Sheet）与打印版 PDF 报告（病害标注图、统计表、整治建议），对齐计划书 §3.6/§3.7；
- **统计可视化**：病害类型分布柱状图 + 等级分布环形图实时刷新；
- **弱光适应**：内置 CLAHE→高斯滤波→梯度→Otsu 预处理流水线（计划书 §3.5），弱光环境识别不退化；
- **照片流**：上传照片即刻得到框选标注（类型/等级/置信度）与整治建议，轻微病害自动闭环；
- **视频流**：文件/实时传输/B站在线视频三种接入方式，逐帧分析、桩号推进、检出卡片滚动展示；
- **闭环工作流**：识别结果默认"待审核"（1 级轻微自动闭环），人工审核后变为"已审核/已驳回"，全程留痕；
- **算法可解释**：每条病害记录附判定依据、量测结果（标定物理量）与影像/传感器/融合三级证据链；
- **YOLOv8n 已接入并带质量门控**：仓库内 `best.onnx` 只有达到最低训练轮次、mAP50 和召回率才会自动启用；可用 `TUNNEL_YOLO_MODEL` 指定正式模型。低质量实验权重默认回退，教学调试时可显式设置 `TUNNEL_ALLOW_EXPERIMENTAL_YOLO=1`；`GET /api/model/info` 可核验 `detector.active` 与 `detector.quality`。
  - **五类病害已全覆盖**：训练集 `yolo-workspace/dataset-6class/`（1475 图 / 3490 框）覆盖 剥落掉块 / 裂缝 / 渗漏水 / 衬砌错台 / 白华析出，另含 150 张背景负样本，合计 6 个类目；`nc=5`，类别下标与 `backend/detector.js` 的 `TYPES` 逐位一致（有单测守着）。详见 `yolo-workspace/数据集说明-6类目.md`，样例见 `yolo-workspace/数据样例-6类目.png`。
  - **当前状态（2026-11-15：已训练并启用）**：`runs/6class-yolov8n/` 已完成 **20 epochs** 训练（CPU，约 1.2 小时），
    导出 `best.onnx`（11.7 MB / opset 12 / 输出 `[1, 9, 8400]`，契约与 `detector.js` 一致），
    `node tools/yolo/verify-model.js` 门控 4 项全过，`detector.active = true`、YOLO 默认启用。
  - **⚠️ 两套口径必须分开报（重要）**：
    - **混合验证集**（166 图，含 80 张合成图，`metrics.json`）：mAP50 **0.6328**、mAP50-95 0.4265、P 0.7151、R 0.6101 —— **门控按此口径判定通过**。
    - **实拍验证集**（66 图，剔除全部合成，`metrics.real-only.json`）：mAP50 **0.4253**、mAP50-95 0.2471、P 0.5402、R **0.4164**。
    - **差距 20.8 个百分点全部来自两个纯合成类**：混合口径下 衬砌错台 AP50 **0.967**、白华析出 **0.985**，
      而这两类**实拍标注为 0**，真实世界性能尚未被验证（其 AP 在实拍口径下即为 0）。
    - 有实拍的三类（实拍口径）：渗漏水 **0.664** / 裂缝 **0.318** / 剥落掉块 **0.293**。
      **裂缝是隧道最主要病害，AP50 仅 0.318**，当前不具备独立工程可用性。
  - **结论口径**：门控已通过、检测器已启用，但**不得据此宣称「检测精度达标」**。对外材料应写
    「混合口径 mAP50 0.633；实拍口径 0.425；裂缝 AP50 0.318；错台/白华真实性能未验证」。
    下一步须现场采集标注后重训，并持续以 `eval_real_only.py` 作为对外口径。

## API 一览

| 方法 | 路径 | 说明 |
|------|------|------|
| POST | /api/ingest | 车载终端数据包上传（自动识别入库） |
| POST | /api/simulate | 模拟采集一帧（演示/联调） |
| POST | /api/import/video | 导入在线视频（B站链接/BV号 → 解析直链 → 本地托管） |
| POST | /api/live/frame | 实时视频帧接入（PNG/JPEG dataUrl，支持 streamId 多路流） |
| GET  | /api/live/frame | 检测台增量读取最新帧（streamId + after，无新帧返回 204） |
| GET  | /api/live/status | 当前实时视频流状态 |
| GET  | /api/defects | 台账查询（status/type/level/tunnel 过滤） |
| GET  | /api/defects/:id | 病害详情 |
| POST | /api/defects/:id/review | 人工审核（通过/驳回 + 等级核定 + 处置决策） |
| GET  | /api/stats | 统计分析 |
| POST | /api/detect/image | 【W0】参数化检测：图像(PNG dataUrl)或ROI + 置信度/IoU/CLAHE/高斯/Canny/Otsu 参数 → 统一 DetectResult（检测框 + 中间产物 Base64 + 耗时） |
| GET  | /api/detect/result/:taskId | 【W0】按任务ID取回 DetectResult（缓存 key=任务ID，TTL 30 分钟） |
| GET  | /api/detect/result/:taskId/intermediate/:key | 【W0】取单个中间产物 PNG 原图（original/clahe/canny/otsu/feature_map/mask/heatmap） |
| POST | /api/explain/detect | 【模块一】可解释AI教学检测：4 步 CV 中间图(clahe/gaussian/canny/otsu) + Eigen/Grad-CAM 热力图(α=0.45 叠加) + 统一检测结果 |
| PUT  | /api/pipeline/params | 【模块一】左栏调参：按依赖只重算受影响步骤（前序步骤 PNG 字节不变） |
| GET  | /api/pipeline/params | 【模块一】查询当前管线参数与默认值 |
| POST | /api/explain/export | 【模块一】合成对比讲解图（原图+热力+检测框+类别/等级标注）→ PNG 下载 |
| POST | /api/experiment/session | 【模块二】创建实训会话（初始参数快照 + 样本图缓存）→ {session_id} |
| POST | /api/experiment/run | 【模块二】按参数运行推理并写 experiment_log（5 滑杆联动） |
| GET  | /api/experiment/log/:session_id | 【模块二】操作轨迹 + 统计（log.params 为参数快照，可回放） |
| POST | /api/experiment/close/:session_id | 【模块二】结束会话（写 end_time） |
| POST | /api/experiment/report/:session_id | 【模块二】实验报告 PDF（会话信息/轨迹表/参数-检出对照/自评/教师评语留白） |
| POST | /api/sample/synthesize | 【模块二】病害样本合成器（裁剪羽化+透视/光度扰动，批量 ≥20 张/次） |
| GET  | /api/sample/library | 【模块二】合成样本库分页浏览（?page=&size=） |
| GET  | /synthetic/* | 【模块二】合成样本图片静态托管 |
| POST | /api/auth/login | 【模块四】登录获取 token（演示账号 admin/teacher/student，口令 123456） |
| POST | /api/auth/logout | 【模块四】吊销令牌（Authorization: Bearer <token>） |
| GET  | /api/auth/me | 【模块四】当前登录用户（角色校验中间件） |
| GET  | /api/users | 【模块四】用户清单（admin 管理用户；teacher/student 访问 403） |
| PUT  | /api/users/:id/role | 【模块四】调整用户角色（admin） |
| GET  | /api/model/info | 【训练轮】当前判别引擎模式（rules/learned）+ 训练指标 |
| POST | /api/model/mode | 【训练轮】运行时切换判别引擎（{"mode":"rules"\|"learned"}，选择持久化） |
| GET  | /api/samples | 【模块四】样本库分页浏览（?page=&size=&type=&source=&level=&tunnel=） |
| GET  | /api/db/tables | 【模块四】数据库表清单（行数+列结构；teacher/admin，只读） |
| GET  | /api/db/tables/:name | 【模块四】单表结构+分页行数据（?page=&size=&q=；teacher/admin，users.password 脱敏） |
| GET  | /api/samples/:id | 【模块四】样本详情（原图元数据 + 检测结果 + knowledge_base 条文按 类型×等级 关联） |
| GET  | /api/kb | 【模块四】分级知识库检索（公开读；?type=&level=；teacher/admin 登录后可维护） |
| POST | /api/kb | 【模块四】新建知识条目（teacher/admin；student 写操作 403） |
| PUT/POST | /api/kb/:id | 【模块四】更新知识条目（teacher/admin） |
| DELETE | /api/kb/:id | 【模块四】删除知识条目（teacher/admin） |
| GET | /api/kg/stats | 【模块五】知识图谱规模统计（实体/关系按类型计数） |
| GET | /api/kg/all | 【模块五】整图（全部实体 + 关系 + 节点度数，供全图谱界面） |
| GET | /api/kg/graph | 【模块五】子图检索（?type=病害类型&level=1~4） |
| GET | /api/kg/explain/:defectId | 【模块五】闭环推理（等级依据/特征对照/成因/危害/建议/动作周期/置信度闸） |
| POST | /api/detect/image | 检测完成自动入库：带 tunnel 时把检测结果写入结构化病害库（?archive=false 关闭） |

端到端验证：

```bash
node backend/smoke-test.js   # 原有 API 深度回归（需先启动服务）
node backend/w0-verify.js    # W0 一键验证（自动拉起服务：8张表/参数化/中间产物/旧API兼容）
node backend/verify-base.js  # 基础改造验收（临时库隔离：4表+必备列/检测自动入库/宽度标定/原API回归）
node backend/w1-verify.js    # 模块一一键验证（热力图吻合度/局部重算/讲解图标注/延迟≤1.5s）
node backend/w2-verify.js    # 模块二一键验证（会话/轨迹回放/PDF/合成批量≥20张/静态托管/回归，独立端口+临时库）
node backend/accept-kg.js    # 模块五知识图谱验收（临时库播种 + 本体完整性 + 子图 + 五类闭环推理 + 接口）
node backend/eval-detect.js  # 检测精度端到端 A/B 评测（规则引擎 vs 训练模型，独立评测集）
node backend/train/ablation.js     # 特征组消融实验（5 组配置重训对比 → data/train/ablation.json）
node backend/render-viz.js         # 科研可视化：混淆矩阵热力图 + P/R/F1 对比 + 消融图（docs/*.png）
node backend/train/export-yolo.js  # 导出 Ultralytics 可用的 YOLO 格式数据集（images/labels/dataset.yaml）
```

**实例掩码分割提取**：带图检测时自动执行（`backend/mask.js`）——逐检测框 ROI→Otsu（暗/亮极性自适应）→8 邻域连通域→实例掩码；
`detections[].mask` 返回掩码级几何参数（`area_px/area_mm2/length_mm/width_mm/coverage`，长度=凸包直径、宽度=面积÷长度，
区别于 bbox 代理口径）；中间产物 `mask` 键为实例上色叠加图。

---

## 检测模型训练（数据驱动训练轮）

用「程序化合成训练集 + 纯 JS softmax 分类器」替代知识引擎里的手工判别权重，零第三方依赖、普通笔记本 CPU 秒级训练：

```bash
node backend/train/gen-dataset.js --count 480 --seed 2026   # ① 生成训练图+精确bbox标注（data/train/）
node backend/train/build-samples.js                          # ② ROI特征抽取+标注匹配+train/val切分
node backend/train/train.js                                  # ③ 训练+阈值标定+规则基线对比 → data/model_params.json
node backend/eval-detect.js --count 120 --seed 999           # ④ 端到端 A/B 评测（独立评测集）
```

- **模型**：15 维 ROI 特征（边缘/暗色/高亮/纹理/色偏/细长比/直线性/填充率/尺寸/走向/断面差）→ 标准化 → softmax 6 分类（背景+5 病害），全批量 GD+动量+L2+类均衡权重；置信度阈值在验证集扫描标定。
- **边界声明（如实）**：目标候选由 YOLOv8n ONNX CNN 产生，类型/等级仍接规则与自研 softmax 融合层；当前 ONNX 图未暴露中间特征与类别梯度，因此热力图实际使用 **Eigen-CAM**，界面不会把启发式权重冒充 Grad-CAM。
- **实测（口径一 · ROI 级分类）**：源 `backend/data/train/metrics.json`，训练 5703 ROI / 验证 376 ROI。
  学习引擎类型准确率 **86.2%**、宏 F1 73.3%、病害 **P 82.9% / R 95.3% / F1 88.6%**；
  规则基线（阈值 0.55）类型准确率 32.4%、病害 **P 36.5% / R 75.6% / F1 49.2%**。
- **实测（口径二 · 端到端检测）**：源 `backend/data/train/eval-metrics.json`，120 张独立评测图，IoU≥0.3 且类别一致。
  规则→学习：F1 **24.2%→56.4%**、查准率 **24.0%→76.8%**、召回率 **24.4%→44.5%**、平均框 IoU **0.629→0.717**。
- **实测（口径三 · 特征组消融）**：源 `backend/data/train/ablation.json`，23 维全量特征 / 174 验证 ROI / 4000 epochs，
  与口径一、二**不是同一实验**。全量特征类型准确率 89.1%、宏 F1 87.2%、病害 F1 93.3%；
  去掉「光照不变组」后准确率升至 90.8%（该组在当前合成域贡献为负），去掉「色彩亮度组」降至 82.2%、宏 F1 73.8%。
- **⚠️ 指标使用约定**：上述三份文件对应三个独立实验（特征维数、验证集规模、任务粒度均不同）。
  任何材料引用时必须同时标注**来源文件名 + 评测集规模**，**禁止跨口径拼接数字**。
  早期材料出现的「ROI 级 acc 89.0% / 病害 F1 92.9% / 规则基线 56.6%」出自已被覆盖的 `val=182` 旧实验，
  **仓库内已无对应指标文件可追溯**（现存最早版本 `metrics.pre-v2.json` 为 `val=311`、acc 81.4%、规则 F1 54.0%），
  对外材料一律以本节口径一/二/三为准，不得再引用该组数字。
- **运行态**：服务启动自动注入 `data/model_params.json`（enabled=true 时）；`GET /api/model/info` 查看模式与指标，`POST /api/model/mode {"mode":"rules"|"learned"}` 运行时切换（选择持久化）。未注入/文件缺失自动回退规则引擎，行为与训练前一致。
- **等级分级**仍走规范物理量分级（gradeDefect）。唯一现行口径取自 `backend/data/train/metrics.json`：held-out 127 ROI 严格准确率 **33.1%**、±1 级 **64.6%**；独立 120 图端到端口径取自 `eval-metrics.json`：学习引擎 **30.1%**、规则引擎 **40.0%**。不同评测集不得横向混写。
- **⚠️ 已知短板（如实声明）**：`metrics.json` 中「等级全猜 2 级」的多数类基线为 **37.0%**，高于学习引擎的 33.1%；
  端到端 120 图上学习引擎定级（30.1%）亦低于规则引擎（40.0%）。即**当前 AI 在「病害定级」环节尚未超过传统规则与朴素基线**，
  定级仍应以规范物理量分级为准、AI 结果只作辅助提示。下一轮须以真实标注数据重训分级头，或引入置信度拒判机制。
  根因分析与改进路线（含离线对照实验：有序回归使严格准确率 32.7%→39.4%）见仓库同级目录 `定级改进方案.md`。
- 训练图/特征样本可再生（体积原因不入库，重跑 ①② 即可）；合成训练集与系统演示同分布（复用模块二 makeBackground/makeDemoDefect/composeOne），真实影像泛化需后续以真实标注数据再训练。

---

## W0：推理层参数化改造 + 公共数据模型（教学科研赋能平台第 0 轮）

面向土木工程（隧道方向）教学科研场景，本仓库保持 Node.js 零第三方依赖架构完成增量升级：

- **推理参数化**：`backend/fusion.js` 识别阈值参数化；`backend/vision.js` 以纯 JS 移植前端
  预处理流水线（CLAHE→高斯→Canny→Otsu）并全参数化，**默认值 = 原系统使用值**
  （置信度 0.55、IoU 关闭、CLAHE 2.0/8×8、5×5 高斯、阈值 70、Otsu 开），默认调用行为不变；
- **统一 DetectResult**：`backend/infer.js` 编排 解码→预处理→ROI→融合→(可选 IoU-NMS)，
  输出检测框（类别/置信度/bbox/area_px/width_mm/等级/审核状态）+ 中间产物
  （原始帧/CLAHE/Canny/Otsu/特征激活图，热力图接口占位、下一轮接入深度学习实现）+ 总耗时；
- **中间产物缓存**：`backend/intermediate-cache.js`，内存缓存 key=任务ID，TTL 30 分钟，Base64 内联回传；
- **公共数据模型**：`backend/db/schema.sql` 独立迁移脚本一次建好 8 张表
  （tunnel / image / detection / experiment_session / experiment_log / synthetic_sample /
  knowledge_base / users），执行器 `backend/db/migrate.js`（Node≥22.5 内置 node:sqlite，幂等）：

```bash
node backend/db/migrate.js          # 建表（可重复执行）
node backend/db/migrate.js --check  # 仅校验表清单
```

> **schema v4（基础改造）**：`detection` 表新增 `reviewer`（人工复核/标注人姓名；自动入库为 `NULL`=待复核），
> 由 `migrate.js` 的 `ensureV4` 对既有库幂等补列，重复执行安全。
> 检测结果自动入库与像素→毫米宽度标定见 `backend/portal.js` 的 `archiveDetect()`
> （带 `tunnel` 才入库；`calibrationPxPerMm` 缺省时 `width_mm` 存 `NULL`=待补标定）。
> 本轮一键验收：`node backend/verify-base.js`（临时库隔离，不污染演示库）。

## 模块一：可解释AI教学展示（W1）

把黑盒检测变成教学工具——学生能看到 AI"为什么"判定为病害。前端顶栏「教学展示 · 模块一」进入
双通道对比界面：**左栏**传统 CV 链路（①CLAHE ②高斯 ③Canny ④Otsu 分步图 + 滑杆调参），
**右栏**检测模型结果（原图/热力图切换 + 检测框 + 类别/等级标注 + 一键导出讲解图）。

- **判定依据热力图**（`backend/heatmap.js`）：双实现可配置（`heatmapMethod: auto|eigen|gradcam`）
  - Eigen-CAM：h = Σ A_k / C（特征通道平均，无梯度依赖）；
  - Grad-CAM 形态：h = ReLU(Σ w_k·A_k)；A_k 取引擎 4 个网格级证据通道
    （边缘/暗色/高亮/纹理，`vision.analyzeImage().maps.channels`），w_k 为目标类通道敏感度权重。
    真实 YOLOv8n 接入后 A_k 换 backbone 特征图、w_k 换 hook 梯度全局平均池化，接口不变；
  - `auto`（默认）先尝试真实模型梯度，未接入时按需求预设回退 Eigen-CAM 并说明原因；
  - 归一化 → 双线性上采样 → JET 伪彩 → α=0.45 叠加；返回框内/框外热强度比（吻合度客观量化，
    实测样本 ratio≈6.3）。
- **分步链路与局部重算**（`backend/explain.js`）：会话态保存原图与各阶段浮点缓冲，滑杆调参
  走依赖链（clahe→gaussian→canny；otsu 独立）**只重算受影响步骤后缀**，前序步骤 PNG
  字节不变（验证脚本可客观证明"不做全链路重复推理"）。
- **对比讲解图导出**（`backend/composite.js` + `backend/raster-text.js`）：纯 JS 合成
  原图(叠热力)+检测框+类别/等级/置信度标注+页眉信息；中文标注由
  `tools/gen-glyphs.py`（开发期 Pillow）离线渲染为 `glyphs.js` 字形位图，运行时零依赖。
- **延迟**：单张推理含全部可视化实测约 115~155ms（≤1.5s 约束，普通笔记本余量 10 倍）。

## 模块二：虚实结合实训台（W2）

前端顶栏「虚实实训 · 模块二」进入，面向"参数-结果关系"的教学实训与病害数据增强：

- **参数探究实训会话**（`backend/experiment.js` + `frontend/training.js`）
  - 创建会话：可上传学生样本图（Canvas ≤640 PNG），否则使用内置演示样本（合成样本，界面/报告显著标注）；
    服务端记录**初始参数快照**并写 `experiment_session`，`users` 自动建学生角色；
  - 5 滑杆（置信度阈值 / CLAHE clipLimit / CLAHE 网格 / 高斯核 / Canny 低阈值）拖动 →
    **debounce 300ms** → `POST /api/experiment/run`，返回结果缩略图 + 检出数量/平均置信度/推理耗时，
    HTTP 实测约 100ms（完成标准 ≤800ms）；
  - 每次运行把**参数组合 + 结果摘要**写入 `experiment_log`；轨迹表点击任一行即**回放该参数快照**
    （载入滑杆并复现运行）；
  - 结束会话 → `POST /api/experiment/report/:id` 用**自研纯 JS PDF 生成器**（位图页 → JPEG DCT
    直嵌）产出真实 .pdf：会话信息 / 操作轨迹表（跨页 22 行/页）/ 参数-检出数量对照条形图+表 /
    学生自评区 / 教师评语留白区；中文用 `glyphs.js` 位图字形光栅化，验证缺字数=0；
- **病害样本合成器**（`backend/synthesizer.js` + `jpeg.js` 纯 JS JPEG 编码）
  - 两种素材：内置演示缺陷池（5 类 ×1~4 级程序化像素绘制）或 **标注素材裁剪**（上传 PNG +
    类别/等级/YOLO 框%，服务端按框裁剪 + 边缘羽化）；
  - 每张：随机 1~3 处粘贴（互不重叠）→ 缩放 → 透视微变换(±5°)+错切 → 亮度/对比度(±20%) →
    伽马(0.8~1.2) → 模糊(核 3/5) → 全图高斯噪声(σ=0.02) → JPEG 落盘
    `data/synthetic/sample_序号_类型_等级.jpg`，单次批量 20~50 张；
  - 逐张写 `synthetic_sample` + `image(source='synthetic')`；样本库分页浏览 + `/synthetic/*` 静态托管；
- **合规约束**：合成器 UI、响应 `marker`、文件名语义、DB `source='synthetic'` 全链路标注
  「合成样本：仅用于实训演示与数据增强，不得与科研实测数据混用」；合成结果在独立目录，不与实测混用；
- **零依赖**：纯 JS JPEG（`backend/jpeg.js`：RGB→YCbCr4:2:0→DCT→量化→zigzag→Huffman，经 Pillow 对拍校验）
  与 PDF（`backend/pdf.js`）编码器均为运行时零第三方依赖；Pillow/pypdf 仅开发期校验用。

## 模块四：数据库（W4）

前端顶栏「数据库 · 模块四」进入；右上「👤」登录（**演示账号 admin/teacher/student，口令均 123456**）。
样本库/知识库公开浏览，教师在线维护知识库，teacher/admin 可只读浏览 SQLite 全部公共表：

- **数据库浏览**（`backend/dbview.js`，只读）
  - `GET /api/db/tables`：8 张公共表清单（行数 + 列结构；teacher/admin）；
  - `GET /api/db/tables/:name`：单表结构 + 分页行数据（`?page=&size=&q=` 文本列模糊搜索）；
    表名白名单防注入，`users.password` 一律脱敏返回；

- **样本库在线浏览**（`backend/portal.js` + `frontend/portal.js`）
  - 网格图库 + 顶部筛选（**病害类型 / 来源 合成|真实 / 等级 1~4 / 隧道**）+ 分页；
    样本 = 存在 ≥1 条检测记录的图像（`GET /api/samples`，接口实测 ~3ms，完成标准 ≤1s）；
  - 点击卡片 → 详情弹层聚合展示：**原图**（`/api/samples/image/:id` 回源）+ **检测框**
    （Canvas 叠加）+ **热力图**（复用 `POST /api/explain/detect` Eigen-CAM，可选叠加）+
    **诊断结果** + **知识库条文**（`knowledge_base` 按 `disease_type=class_name 且 level` 关联，
    `GET /api/samples/:id` 服务端拼装，含规范依据/修复方案/处置动作/复查周期）；
  - 「一键生成样本数据」：内置合成样本 → detect 自动入库（两隧道 · 近 12 天分布），演示即得。
- **知识库可配置**（`backend/kb.js`，9 套任务书口径在真实仓库为 5 类×4 级=**20 套**超集实现）
  - 一次性迁移：代码常量库 `fusion.SUGGESTION_LIB` → `knowledge_base` 表（表空播种、事务内完成，
    教师删除后重启**不补回**），`repair_plan` 逐句原文保留 + 补全 `standard_basis/action/interval`；
    校验：20 条与迁移前逐条一致（**迁移后诊断建议与迁移前一致**）；
  - **诊断决策层改为查表**：server 启动向 `fusion` 注入 `kb.getSuggestions` resolver，融合/教学/
    实训/科研入库的建议一律读 `knowledge_base`，教师在线改一条 → 后续检测即按新方案出建议；
  - CRUD（teacher/admin，student 写操作一律 **403**）：`POST/PUT/DELETE /api/kb(/:id)`，
    覆盖冲突返回 409、更新缺失 404；GUI 提供新增/编辑/删除表单。
- **角色权限**（`backend/auth.js`）
  - `users` 表 + token 登录（DB v3 增 `password` 列，原型明文，演示口令 123456）；
    `POST /api/auth/login` 下发 32 位 hex token，请求带 `Authorization: Bearer <token>`；
    中间件 `requireRole` 校验：**student 只读、teacher 维护知识库、admin 管理用户**
    （`GET /api/users` + `PUT /api/users/:id/role`）；未登录写 401、越权写 403。

## 模块五：隧道病害知识图谱（W5）

闭环：**YOLO 识别 → 特征量化 → 图谱推理 → 等级依据 → 成因分析 → 结构危害 → 养护建议（含规范条款）**。
入口：原型页 `docs/prototype-holo-core.html` 第 **06** 张卡片（也可从「人工复核」病害详情弹窗一键跳转推理）。

- **本体与存储**（`backend/kg.js` + `kg_entity` / `kg_relation`，schema **v5**）
  - 10 类实体：病害类型 / 风险等级 / 病害特征 / 结构部位 / 成因因子 / 结构危害 / 维修方案 / 规范条款 / 处置动作 / 检测实例（实例层虚拟挂接 `detection`）；
  - 13 类关系：发生于 / 典型特征 / 判据依据 / 成因 / 导致 / 危害 / 判定依据 / 等级映射 / 对应措施 / 引用规范 / 对应动作 / 识别为 / 定级为；
  - 播种规模 **123 实体 / 211 关系**（表空才播种，事务内完成，与 `knowledge_base` 同口径：学生/教师维护态优先，删除后重启不补回）；
  - 条款来源：《公路隧道养护技术规范》JTG H12—2015、《铁路桥隧建筑物劣化评定标准 隧道》TB/T 2820.2—1997、
    《地下工程渗漏治理技术规程》JGJ/T 212—2010、GB 50108、GB 50367、GB/T 50476、TB 10003、JTG/T 3660
    —— **每条措施都挂依据条款，可溯源，不编造**。
- **接口**（公开只读）
  - `GET /api/kg/stats`：图谱规模（实体/关系按类型计数）；
  - `GET /api/kg/all`：**整图**（全部实体 + 全部关系 + 节点度数），供「全图谱界面」一次渲染；
  - `GET /api/kg/graph?type=&level=`：以病害类型（+等级）为中心的 2~3 跳子图（节点+边，供卡片内的局部视图）；
  - `GET /api/kg/explain/:defectId`：一条病害的完整推理结论 —— 等级依据（判据 + 条款 + **阈值复核**）、
    特征量化对照、成因排序（先验权重 + 证据）、结构危害、养护建议（工艺 + 条款 + 施工窗口）、处置动作与复查周期、置信度闸。
- **两个视图分工**（原型第 06 卡）
  - 卡片内 = **局部子图**：回答"这一条病害怎么推理"；
  - 卡片「全图谱」按钮 = **整图界面**（`#kgFull` 覆盖层）：123 实体 / 211 关系铺成一颗 **3D 知识球** ——
    9 类实体各占一个纬度带（带内按经度均布），实时投影渲染（绕 Y 偏航 + 绕 X 俯仰 + 透视，深度渐隐、背面减淡）；
    **点击任意知识点，整球把它转到正中**（偏航+俯仰双向缓动），左侧面板立即显示**知识详解**
    （属性 / 出处 / 邻接关系）与**常见图例**（沿关系找到关联病害类型 → 样本库实拍图）；
    空闲时缓慢自转，拖空白转球（偏航/俯仰），滚轮缩放，双击聚焦；
    类型显隐、关键字查找、闭环流程条高亮照旧；
    白核节点**不再持续发光/喷白色粒子**（选中只是一圈细环 + 邻居提亮，克制可读）；
    `prefers-reduced-motion` 下退化为静止一帧，关闭浮层即停 rAF（后台不空转）。
- **设计约定**：等级由检测链路给出，图谱**不改写等级**，只给依据条款 / 成因 / 危害 / 建议，并做「记录等级 vs 阈值命中等级」一致性复核；
  图谱查不到时回退 `knowledge_base` → 再回退 `fusion.SUGGESTION_LIB` 常量，任何情况下不返回空建议。
- **一键验收**：`node backend/accept-kg.js`（47 项：库表/播种幂等/本体完整性/关系无悬空端点/20 组子图/五类闭环推理/接口 200·400·404）。

## 科研工作流（W6：实验追踪 / 批量推理 / 评测报告）

面向科研与学科辅助场景，系统围绕「数据 → 实验 → 模型 → 图谱分析 → 成果导出」提供完整闭环：

- **实验追踪台账**（`backend/research.js`）：每次训练（`train.js` / `train-mix.js`）与批量推理自动登记——
  数据集版本指纹（真实域/合成域样本数 + 清单哈希 `r83-s480-xxxx`）、超参（epochs/realWeight/threshold）、
  核心指标（类型准确率 / 宏F1 / 病害F1 / P / R / 等级准确率 / 候选召回）；查询接口 `GET /api/research/experiments`。
- **批量推理管线**（`tools/batch-infer.js`）：对图像目录批量运行与生产一致的全链路推理，
  导出 **YOLO（每图 txt）/ COCO（json，含 score）/ CSV** 三种格式，供外部评测脚本与论文数据集使用：
  `node tools/batch-infer.js --dir <图像目录> --limit 20 --format yolo,coco,csv`
- **科研评测报告**（`tools/research-report.js`）：一键聚合「验证集总体指标 + 规则引擎基线对比 + 真实域端到端专项
  （含按类别 TP/FP/FN/P/R/F1 与 IoU）+ 实验台账 + 知识工程产出」→ Markdown（可入论文/汇报）+ Excel 三 Sheet：
  `node tools/research-report.js`；界面 05 卡提供「科研评测报告」按钮在线下载，`GET /api/research/report(.md|.xlsx)`。
- **知识工程产出**：领域本体 10 类实体 / 13 类关系（123 实体 / 211 关系），支撑「识别 → 定级 → 成因 → 危害 → 养护方案」
  闭环推理与感知/知识交叉验证（置信度闸），是可独立发表的科研资产。

## 技术栈

- 后端：Node.js 标准库（零第三方依赖），分层为 接入服务 / 融合识别引擎 / 台账存储；
- 前端：原生 HTML/CSS/JavaScript，Canvas 绘制环向标注与统计图，无外部 CDN；
- 存储：JSON 文件（`backend/data/`，台账接口保持兼容）；W0 新增公共教学数据模型落 SQLite
  （`backend/data/tunnel.db`，8 张表，Node 内置 node:sqlite，零第三方依赖）；
- 详细设计见 [docs/系统设计文档.md](docs/系统设计文档.md)。
