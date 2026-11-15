/**
 * start-preview.mjs — 一键启动预览（零依赖，Node ≥ 22.5）
 *
 * 作用：同时启动 ① 后端 API 服务（backend/server.js → http://127.0.0.1:8787）
 *              ② 前端预览静态服务（tools/serve-docs.js → http://127.0.0.1:8899）
 *       并打印预览地址。首次运行若数据库为空会自动播种演示数据（开箱即用）。
 *
 * 用法：  node start-preview.mjs
 * 停止：  Ctrl+C（两个子进程一并退出）
 *
 * 预览入口：http://127.0.0.1:8899/prototype-holo-core.html
 * （六个轨道工位：检测工作台 / 视图 / 病害档案 / 人工复核 / 统计与报告 / 知识图谱）
 */
import { spawn } from 'node:child_process';
import { setTimeout as sleep } from 'node:timers/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.dirname(fileURLToPath(import.meta.url));
const children = [];

function start(label, args, cwd) {
  const child = spawn(process.execPath, args, { cwd, stdio: ['ignore', 'pipe', 'pipe'] });
  const tag = `[${label}] `;
  child.stdout.on('data', (d) => process.stdout.write(String(d).split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n'));
  child.stderr.on('data', (d) => process.stderr.write(String(d).split('\n').filter(Boolean).map((l) => tag + l).join('\n') + '\n'));
  child.on('exit', (code) => console.log(`${tag}退出（code=${code}）`));
  children.push(child);
  return child;
}

async function waitFor(url, tries = 40) {
  for (let i = 0; i < tries; i++) {
    try { const r = await fetch(url); if (r.ok) return true; } catch { /* 未就绪继续等 */ }
    await sleep(250);
  }
  return false;
}

console.log('════════ 隧途明鉴 · 一键预览 ════════');
start('API 8787', ['server.js'], path.join(ROOT, 'backend'));
start('预览 8899', ['tools/serve-docs.js'], ROOT);

const apiOk = await waitFor('http://127.0.0.1:8787/api/stats');
const uiOk = await waitFor('http://127.0.0.1:8899/prototype-holo-core.html');
console.log('──────────────────────────────────────');
console.log(`  后端 API   : http://127.0.0.1:8787 ${apiOk ? '✓' : '✗（检查 backend/server.js 启动日志）'}`);
console.log(`  预览界面   : http://127.0.0.1:8899/prototype-holo-core.html ${uiOk ? '✓' : '✗'}`);
console.log('  在浏览器打开上面的预览界面地址即可使用（Ctrl+C 停止本脚本）');
console.log('──────────────────────────────────────');

function shutdown() {
  for (const c of children) { try { c.kill(); } catch { /* 已退出 */ } }
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
