/**
 * publish-start.cjs — 发布沙箱专用启动入口（本地开发请继续用 start-preview.mjs）
 *
 * 发布环境只有一个公网端口（PORT 环境变量），且页面在前端以「同源」方式调用 /api。
 * 本入口做两件事：
 *   1) TUNNEL_FRONTEND=docs —— 让 backend/server.js 的静态目录指向 docs/
 *      （prototype-holo-core.html / consistency-engine.html / assets），单端口同时
 *      提供最新界面与后端 API；
 *   2) 直接加载 backend/server.js —— 它已支持 PORT 环境变量并监听全部网卡。
 *
 * YOLO 说明：onnxruntime-node 为 optionalDependencies，沙箱装不上时自动跳过，
 * 服务端检测到后按质量门控逻辑停用 YOLO、回退规则引擎，不影响其余功能。
 */
process.env.TUNNEL_FRONTEND = 'docs';
require('./backend/server.js');
