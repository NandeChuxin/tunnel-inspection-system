/**
 * tools/research-report.js — 科研评测报告一键生成（CLI 薄封装，逻辑在 backend/research.js）
 *
 * 产出：docs/research-report-<日期>.md + .xlsx
 * 用法：node tools/research-report.js [--out docs/research-report]
 */
const fs = require('fs');
const path = require('path');
const research = require('../backend/research');

const arg = (n, d) => { const i = process.argv.indexOf('--' + n); return i > 0 ? process.argv[i + 1] : d; };
const OUT = path.resolve(arg('out', path.join(__dirname, '..', 'docs', 'research-report')));
const stamp = new Date().toISOString().slice(0, 10);

const agg = research.aggregateReport();
const mdFile = OUT + '-' + stamp + '.md';
fs.mkdirSync(path.dirname(mdFile), { recursive: true });
fs.writeFileSync(mdFile, research.reportMarkdown(agg));
const xlFile = OUT + '-' + stamp + '.xlsx';
fs.writeFileSync(xlFile, research.reportXlsx(agg));
console.log('✓ 科研评测报告：\n  Markdown → ' + mdFile + '\n  Excel    → ' + xlFile);
