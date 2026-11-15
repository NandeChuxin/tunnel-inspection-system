# 隧途明鉴 LabVIEW 集成版

本目录把现有“隧途明鉴”系统封装为 LabVIEW 2025 可管理、可启动、可监控的工程。成熟的检测算法、SQLite 台账、报告和知识图谱继续由原 Node.js 后端执行；LabVIEW 作为工程入口和上位机界面，通过 HTTP API 调用后端。

## 工程结构

- `隧道检测.lvproj`：LabVIEW 工程文件。
- `Main.vi`：LabVIEW 主入口，打开本机检测工作台页面。
- `启动隧道检测.ps1`：启动后端与 Web 工作台，并写入 PID/日志。
- `停止隧道检测.ps1`：只停止由本集成版启动的进程。
- `检查系统.ps1`：检查 Node.js、源系统、端口和 API 健康状态。
- `config.json`：源系统位置、端口和入口页配置。
- `API接口清单.md`：供后续扩展原生 LabVIEW HTTP Client VI。

## 使用

1. 右键运行 `检查系统.ps1`，确认检查项通过。
2. 运行 `启动隧道检测.ps1`。
3. 双击 `运行LabVIEW主程序.vbs`，它会在 LabVIEW 2025 中载入 `Main.vi`、注入工作台 URL 并运行。也可打开 `隧道检测.lvproj` 查看和扩展 VI。
4. 结束时运行 `停止隧道检测.ps1`。

## 架构说明

这是“LabVIEW 上位机 + 本机算法服务”的实现方式，避免把已经验证过的 YOLO/图像处理、数据库与报告逻辑重新手工翻译后引入误差。当前 `Main.vi` 是实际的 LabVIEW VI，职责是进入完整检测工作台；LabVIEW 可继续扩展原生面板：用 HTTP Client GET/POST 节点调用 `config.json` 中的 API 基址，并用 `Flatten To JSON` / `Unflatten From JSON` 处理数据。

源系统默认位置：`C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system`。

