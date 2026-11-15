# 人工复核方向 · 源码说明

> 覆盖「检出记录进入待复核队列 → 人工看图核验 → 通过 / 驳回 → 台账状态闭环」的完整链路。
> 本目录下的 `代码/` 是与这条链路直接相关的源码（后端整文件 + 接口摘录 + 前端按行号摘录）。

---

## 1 链路总览

```
台账数据源：backend/data/defects.json（由 backend/store.js 读写）
  每条记录关键字段：id / type / levelNo / levelText / confidence / detectedAt / source /
                    imageRef（= SQLite image_id，用于回源真实原图）/
                    position{chainage,sector,bbox} /
                    status（待审核 | 已审核 | 已驳回）/
                    review{reviewer, action, note, levelOverride, decision, at}

前端 · 工位 04 人工复核
  │  GET /api/defects                     ← 一次取全量台账（server.js L223）
  │  renderReview()：
  │    ① 过滤 status === '待审核'
  │    ② 排序：真实样本记录优先 → 同优先级按 detectedAt 倒序
  │    ③ 分页轮换（每批 6 条，rvPage；「刷新队列」按钮翻页，循环）
  ▼
点「通过 / 驳回」（列表行内按钮）
  │  POST /api/defects/:id/review   { reviewer:'工作台复核员', action:'通过'|'驳回' }
  │      server.js L232 ——► store.updateDefect(id, {
  │           status: '已审核' | '已驳回',
  │           finalLevel, decision,
  │           review: { reviewer, action, note, levelOverride, decision, at }
  │      })
  ▼  成功后原地刷新：loadStats() + loadDefects()（该行移出队列，下一条真实记录补位）

点列表行 → 病害详情弹窗 #rvModal（看图后再决策）
  │  openRvDetail(id)   —— 组装四区
  │    ① 图像区 renderFig()：imageRef 为数字 → GET /api/samples/image/:id 回源真实原图
  │                           并在图上叠加检出框（bbox 百分比定位）
  │                           imageRef 非数字（模拟记录）→ 取同类型真实样本池随机一张作示例，
  │                           角标注明「非本记录原始影像」，不叠框
  │    ② 基本信息（类型·子类 / 等级 / 置信度 / 桩号 / 时间 / 来源）
  │    ③ 判定依据（特征指标 + 规范条款）
  │    ④ 处置办法 + 人工审核区（备注 textarea + 通过 / 驳回）
  └─ submitRv(action) → POST 复核接口 → 原地刷新为已审核态
```

---

## 2 文件清单（后端）

| 文件 | 出处 | 内容 |
|---|---|---|
| `server-复核接口摘录.js` | backend/server.js L223–262 | 复核方向**全部写入口**：<br>`GET /api/defects`（台账查询，支持 status/type/level/tunnel 过滤）<br>`POST /api/defects/:id/review`（通过·驳回，校验 reviewer 与 action）<br>`GET /api/defects/:id`（单条详情） |
| `store-病害台账JSON读写.js` | backend/store.js（整文件） | JSON 台账读写：`listDefects` / `getDefect` / `updateDefect` / `stats` |

复核接口的**入参与落库语义**（照抄 server.js 逻辑）：

```js
// POST /api/defects/:id/review
// 入参校验：body.reviewer 必填；body.action ∈ {'通过','驳回'}
const review = {
  reviewer: body.reviewer,
  action: body.action,
  note: body.note || '',
  levelOverride: body.levelOverride || null,          // 允许人工改判等级
  decision: body.decision || (body.action === '通过' ? '按建议方案纳入整治计划' : '退回复检'),
  at: new Date().toISOString(),
};
const patch = {
  status: body.action === '通过' ? '已审核' : '已驳回',
  finalLevel: body.levelOverride || d.level,
  decision: review.decision,
  review,
};
```

> 等级改判由人工决定（`levelOverride`）：知识图谱只给依据与建议，不改写检测链路定下的等级；
> 复核环节才是最终裁定点。

## 3 文件清单（前端，按行号摘录）

| 摘录文件 | 出处（docs/prototype-holo-core.html） | 内容 |
|---|---|---|
| `frontend-01-工位04复核卡UI.html` | L1283–1298 | 工位 04 面板结构：待复核计数 `#rvMeter`、队列容器 `#rvList`、`#rvRefresh` 刷新队列 |
| `frontend-02-复核队列逻辑.js` | L3596–3647 | `renderReview()`：队列排序（真实样本优先 + 时间倒序）、分页轮换、行内「通过/驳回」→ 调复核接口、点行开弹窗 |
| `frontend-03-病害详情弹窗UI.html` | L1516–1556 | `#rvModal` 结构：图像区 / 基本信息 / 判定依据 / 处置办法 + 人工审核区 |
| `frontend-04-病害详情弹窗样式.css` | L438–521 | 弹窗四区布局、图像与检出框叠加、状态色（待审核 `--lv2` / 通过 `--hi` / 驳回 `--vi-4`） |
| `frontend-05-病害详情弹窗逻辑.js` | L3648–3803 | `openRvDetail()` / `renderFig()`（真实原图回源、示例图兜底）/ `submitRv()`（提交并原地刷新）/ Esc 分层关闭 |
| `frontend-06-刷新队列按钮.js` | L5060–5090 | 「刷新队列」= 翻页轮换：按钮禁用 +「刷新中…」最小可见 400ms + 播报「第 x/y 批」 |

## 4 复核数据从哪来（工具脚本）

| 脚本 | 作用 |
|---|---|
| `tools-reopen-real-for-review-真实样本置回待复核.js` | 把真实样本（实拍图）的记录**置回「待审核」**并清掉预审标记 —— 否则批量入库时标记为已审核，复核队列里看不到真实图片 |
| `tools-sync-real-batch2-to-ledger-SQLite真值写台账.js` | 把 SQLite `detection` 表里的 YOLO 真值同步成台账行（幂等：先剔除本批 imageRef 的旧行再插） |

> 两个存储的关系：`image` / `detection`（SQLite，存图与检出真值）↔ `defects.json`（台账，界面读它）。
> 检测接口默认不写库；要让复核队列看到真实图片，需要上面两个脚本把数据「搬」到该在的位置。

---

## 5 状态机

```
                      POST /review  {action:'通过'}
  待审核 ─────────────────────────────────────► 已审核   （decision: 按建议方案纳入整治计划）
     │
     └──────────── POST /review {action:'驳回'} ─► 已驳回   （decision: 退回复检）
```

界面上的状态色：待审核 = 琥珀（`--lv2`）、通过 = 青绿（`--hi`）、驳回 = 红（`--vi-4`）。

---

## 6 快速自测

```bash
node backend/server.js            # 后端 8787
node tools/serve-docs.js          # 前端 8899

# 造一条待复核数据（把真实样本置回待审核，跑之前先停后端避免 SQLite 锁）
node tools/reopen-real-for-review.js

# 直接打接口验证一次复核闭环
curl -X POST http://127.0.0.1:8787/api/defects/<某条id>/review \
     -H "Content-Type: text/plain" \
     -d "{\"reviewer\":\"工作台复核员\",\"action\":\"通过\",\"note\":\"现场复核无异常\"}"
```

浏览器侧：打开 `http://127.0.0.1:8899/prototype-holo-core.html` → 工位 **04 人工复核** →
点任意一条 → 详情弹窗（真实原图 + 检出框 / 判定依据 / 处置方案）→ 填备注 →
**通过** 或 **驳回** → 该条移出队列，下一条补位。

> 提示：仓库里另有沉淀好的浏览器探针可直接回归这条链路 ——
> `tools/probe-review-real.js`（真实样本优先与弹窗图像）、
> `tools/probe-review-paging.js`（刷新队列翻页）、`tools/probe-rvfig.js`（弹窗图像与检出框）。
