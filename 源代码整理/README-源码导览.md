# 源码导览 · 隧途明鉴（当前版本）

> 这份目录把**当前版本**的源码按「检测方向」与「人工复核方向」两条主线整理出来，
> 每条链路都给了：后端整文件、接口摘录、前端按行号摘录 + 一份说明文档。
> 抽取规则见 `00-抽取清单.txt`（含每个文件/代码段的出处与行号，可随时重跑复核）。

---

## 0 怎么用这份目录

| 你要什么 | 看哪里 |
|---|---|
| **检测方向的代码** | `01-检测方向/README-检测链路.md` + `01-检测方向/代码/` |
| **人工复核的代码** | `02-人工复核/README-人工复核链路.md` + `02-人工复核/代码/` |
| 完整工程（自己跑起来） | 仓库根目录：`backend/` `frontend/` `frontend`（`docs/prototype-holo-core.html`）`tools/` |
| 数据库表结构 | `01-检测方向/代码/db-schema-数据库建表(image_detection等).sql` |
| 抽取出处对照 | `00-抽取清单.txt` |

> 前端是**单文件**（`docs/prototype-holo-core.html`，约 5200 行 / 259KB），
> 所以与两条链路相关的代码是**按行号摘录**成独立文件的（原文照搬，只加了个出处表头）。
> 想看完整上下文，按表头里的行号回原文件即可。

---

## 1 项目一览

**隧途明鉴 · 隧道病害智能检测与分析系统** —— 面向土木（隧道与地下工程）的
「感知 + 知识推理」一体化工具：图像识别病害 → 特征量测 → 四级定级 → 知识图谱推理成因/危害/养护方案 → 人工复核闭环。

- **形态**：Node 零依赖单机应用 + 单文件前端；后端 8787，前端 8899（云端前后端同端口部署）
- **技术栈**：Node 标准库（`node:sqlite`、`node:http`、纯 JS 图像处理）；前端原生 HTML/CSS/JS + Canvas；**无第三方依赖、无 GPU、无商业组件**
- **病害类别**：剥落掉块 / 裂缝 / 渗漏水 / 错台 / 白华（五类四等级）
- **线上地址**：https://tunnel-defect-ai.app.workbuddy.host/

### 目录结构（仓库根）

```
tunnel-inspection-system/
├─ backend/                   后端（Node 零依赖，47 个 .js/.sql）
│   ├─ server.js              HTTP 路由与静态托管（38KB，全部接口都在这）
│   ├─ vision.js fusion.js infer.js model.js mask.js     ← 检测链路核心
│   ├─ store.js               病害台账（defects.json）读写
│   ├─ db/                    schema.sql（10 张表，v5）/ migrate.js / db.js
│   ├─ train/                 训练与评测管线（7 个脚本）
│   ├─ kg.js                  知识图谱引擎（123 实体 / 211 关系）
│   ├─ portal.js explain.js heatmap.js experiment.js synthesizer.js
│   ├─ report.js xlsx.js pdf.js research.js                报告与导出（零依赖）
│   └─ data/                  运行数据：tunnel.db / 真实样本图 / 模型参数 / 台账 / 实验台账
├─ docs/
│   ├─ prototype-holo-core.html   ★ 前端唯一真源（单文件，含全部界面与交互）
│   ├─ 技术方案-隧途明鉴.md        竞赛技术方案成稿
│   ├─ 系统设计文档.md / 设计语言.md / 隧道病害知识图谱搭建方案.md 等
│   ├─ research-report-2026-09-13.{md,xlsx}   科研评测报告
│   └─ tunnel-system-demo.mp4     系统演示视频（76s）
├─ frontend/                  原系统主界面（模块一/二/四，部署时作为 legacy-home 保留）
├─ tools/                     构建 / 导入 / 探针脚本（见第 7 节）
├─ 参赛材料/                   竞赛提交材料包（材料清单-README.txt 为索引）
├─ 源代码整理/                 ← 本目录
├─ deploy/                    云端部署构建产物（由 tools/build-deploy.js 生成，勿手改）
└─ README.md                  项目总说明
```

---

## 2 跑起来（3 条命令）

```bash
node backend/server.js      # ① 后端 + API（默认 8787，读环境变量 PORT）
node tools/serve-docs.js    # ② 前端静态服务（默认 8899，默认入口 prototype-holo-core.html）

# 然后浏览器打开
http://127.0.0.1:8899/prototype-holo-core.html
```

前端会自动判定后端基址：本地 **8899 → `http://127.0.0.1:8787`**；云端同源部署时走相对路径。
（跨源请求必须用 `Content-Type: text/plain` 发送 JSON 字符串——后端没有处理 `OPTIONS`。）

---

## 3 两条重点链路 · 入口速查

### 3.1 检测方向

| 环节 | 位置 |
|---|---|
| 前端面板 | `prototype-holo-core.html` **L1194–1219**（工位 01 检测工作台） |
| 前端功能层 | 同文件 **L2354–3119**（§4 Lab 模块：`runDetect()` / `runHeat()` / 结果卡 / 检出框） |
| 前端接线 | 同文件 **L4873–5044**（上传·粘贴·拖放·阈值） |
| 后端接口 | `backend/server.js` **L267–310**（`POST /api/detect/image`） |
| 后端实现 | `vision.js`（图像处理）→ `infer.js`（编排）→ `fusion.js`（融合+分级）→ `mask.js`（实例掩码）→ `model.js`（训练模型，可选注入） |
| 训练评测 | `backend/train/*.js`（合成/真实混合训练、端到端评测、消融、YOLO 导出） |

详细说明：**`01-检测方向/README-检测链路.md`**

### 3.2 人工复核方向

| 环节 | 位置 |
|---|---|
| 前端面板 | `prototype-holo-core.html` **L1283–1298**（工位 04 人工复核） |
| 队列逻辑 | 同文件 **L3596–3647**（`renderReview()`：真实样本优先 + 分页轮换 + 通过/驳回） |
| 详情弹窗 | 同文件 **L1516–1556**（结构）/ **L438–521**（样式）/ **L3648–3803**（逻辑） |
| 刷新队列 | 同文件 **L5060–5090**（翻页轮换 + 最小可见反馈） |
| 后端接口 | `backend/server.js` **L223–262**（`GET /api/defects`、`POST /api/defects/:id/review`、`GET /api/defects/:id`） |
| 台账存储 | `backend/store.js`（读写 `backend/data/defects.json`） |
| 数据准备 | `tools/reopen-real-for-review.js`、`tools/sync-real-batch2-to-ledger.js` |

详细说明：**`02-人工复核/README-人工复核链路.md`**

---

## 4 前端单文件 · 分区地图

`docs/prototype-holo-core.html` 的分区（行号为当前版本，改动后会漂移，可用关键字搜）：

| 分区 | 行号 | 说明 |
|---|---|---|
| 设计令牌（CSS 变量） | L20 | 配色/字号/间距的唯一真源 |
| 舞台与面板（玻璃卡片） | L142–403 | 轨道卡片、展开态玻璃 |
| 病害详情弹窗样式 | L438–521 | 复核/台账点行展开的弹窗 |
| 工位 01 检测工作台 | L1194–1219 | UI |
| 工位 02 病害识别·热力图 | L1220–1252 | UI |
| 工位 03 病害档案 | L1253–1282 | UI（台账 + 检测历史合并） |
| 工位 04 人工复核 | L1283–1298 | UI |
| 工位 05 统计与报告 | L1299–1322 | UI（含科研实验台账） |
| 工位 06 知识图谱 | L1323–1364 | UI |
| 病害详情弹窗 / 跳图谱确认浮层 / 样本库 / 全图谱 | L1516–1655 | 浮层 HTML |
| §2 引擎层（星球渲染） | L1692–2114 | Canvas 绘制、弧轨、主循环 |
| §3 交互层 | L2115–2353 | 悬停聚焦、指针视差、播报条、时钟 |
| §4 检测工作台（Lab） | L2354–3119 | 检测全流程前端 |
| §5 轨道（Orbit） | L3188–3414 | 卡片落位/展开/夹紧 |
| §6 功能面板（Modules） | L3415–5119 | 台账/复核/知识图谱/统计/样本库 |
| §3.11 启动 | L5121–5198 | 启动兜底与错误横幅 |

---

## 5 其余模块（同样在 server.js + 同一前端文件内）

| 模块 | 后端 | 前端 |
|---|---|---|
| 模块一 可解释教学（四步中间图 + 热力图） | `explain.js` `heatmap.js` `composite.js` `raster-text.js` | 工位 02 + `runHeat()` |
| 模块二 虚实实训 + 合成样本 | `experiment.js` `synthesizer.js` `jpeg.js` `pdf.js` | 实训台（legacy 界面） |
| 模块四 开放学习（账号 / 知识库 / 样本库） | `auth.js` `kb.js` `portal.js` | 样本库弹窗 |
| 模块五 知识图谱（推理 + 3D 全图谱） | `kg.js`（+ `kg_entity` / `kg_relation` 表） | 工位 06 + `#kgFull` |
| 统计与报告 / 科研工作流 | `report.js` `xlsx.js` `pdf.js` `research.js` | 工位 05 |

---

## 6 数据与存储（易踩的两个坑）

1. **双存储**：`SQLite`（`image` / `detection`，存图与检出真值）与 **JSON 台账**（`defects.json`，界面读它）。
   检测接口默认 `archive:false` **不写库**；要让复核队列/档案看到数据，需要同步脚本把数据搬到该在的位置。
2. **图片回源**：台账里的 `imageRef` 是数字时 = SQLite 的 `image_id`，前端通过
   `GET /api/samples/image/:id` 回源真实原图；非数字（模拟记录）才用同类型样本作示例图。

---

## 7 验证与质量

**验收脚本**（后端，全绿）：

```bash
node backend/verify-base.js     # 基础链路（检测接口、自动入库、台账、图谱表等）
node backend/accept-w4.js       # 模块四：86 项
node backend/accept-rd.js       # 报告导出：72 项
node backend/accept-kg.js       # 知识图谱：46 项
```

**浏览器探针**（无头 Edge，沉淀在 `tools/`，可重复回归）：

| 探针 | 覆盖 |
|---|---|
| `probe-lab2kg.js` | 检测 →（确认）→ 跳知识图谱学习闭环（宽/窄双分辨率） |
| `probe-dock-size.js` | 展开卡片保持原尺寸、完整在屏内、水平对齐球心 |
| `probe-dock-above.js` | 展开卡片落在星球正上方且不遮挡球心数字 |
| `probe-review-real.js` / `probe-review-paging.js` / `probe-rvfig.js` | 人工复核：真实样本优先、翻页、弹窗图像与检出框 |
| `probe-kg3d.js` / `probe-kglink.js` | 3D 知识球、图谱衔接 |
| `probe-archive.js` / `probe-blank.js` / `probe-state.js` | 病害档案、白屏与启动态 |

---

## 8 部署

```bash
node tools/build-deploy.js    # 组装 deploy/（后端全量 + 前端 + 资源下载页），零依赖
# 再把 deploy/ 发布到应用托管（云端同端口，前后端同源）
```

`deploy/` 是构建产物：`build-deploy.js` 会**先清空再重建**，所以不要手改 `deploy/` 里的文件；
要长期生效请改源文件（或 `build-deploy.js`）。

---

## 9 关于本目录的命名约定

- 后端整文件照搬时加前缀标明职责，例如 `fusion-特征融合与病害分级.js`
- 前端摘录文件统一以 `frontend-` 开头，并在文件头写明**出处与行号范围**
- 所有抽取动作由 `tools/build-source-package.js` 完成，**可重复执行**：
  原文件改动后重跑一次，摘录即同步到最新版本
