# LabVIEW 原生面板接口清单

API 基址：`http://127.0.0.1:8787`

| 功能 | 方法 | 路径 | LabVIEW 用途 |
|---|---|---|---|
| 健康检查 | GET | `/api/health` | 状态灯、时间戳 |
| 模型信息 | GET | `/api/model/info` | 显示推理引擎与指标 |
| 模拟采集 | POST | `/api/simulate` | 演示单帧采集与入库 |
| 病害台账 | GET | `/api/defects` | 表格、筛选、审核状态 |
| 统计 | GET | `/api/stats` | 图表与汇总指标 |
| 图像检测 | POST | `/api/detect/image` | 图像/ROI 与检测参数 |
| 检测结果 | GET | `/api/detect/result/{taskId}` | 检测框与中间产物 |
| 人工复核 | POST | `/api/defects/{id}/review` | 通过、驳回、核定等级 |
| 知识图谱 | GET | `/api/kg/graph?type=&level=` | 图谱子图 |
| 解释链路 | GET | `/api/kg/explain/{id}` | 成因、危害与处置建议 |
| Excel 报告 | POST | `/api/report/excel` | 导出检测报告 |
| PDF 报告 | POST | `/api/report/pdf` | 导出打印报告 |

建议 VI 分层：`Main.vi`（事件循环）→ `API/*.vi`（HTTP）→ `Models/*.ctl`（类型定义）→ `UI/*.vi`（显示）。所有网络调用设置超时并在错误簇中保留 HTTP 状态码与响应正文。

