/**
 * report.js — 诊断决策层报告生成（对齐项目计划书 §3.6/§3.7）
 *  - Excel：检测概况 + 病害明细 双 Sheet（OpenPyXL 对应实现，零依赖 xlsx 写入器）
 *  - PDF：打印版检测报告（含病害标注图、统计表、整治建议），浏览器打印即可存为 PDF
 */
const store = require('./store');
const { buildXlsx } = require('./xlsx');

const TYPE_COLORS = { '裂缝': '#f5d327', '渗漏水': '#2f9bff', '剥落掉块': '#ff5d6c', '衬砌错台': '#b06cff', '白华析出': '#9be37d' };

/** 收集报告数据 */
function collectData(tunnel) {
  const defects = store.listDefects(tunnel ? { tunnel } : {});
  const stats = store.stats();
  const byLevel = defects.reduce((m, d) => ((m[d.level] = (m[d.level] || 0) + 1), m), {});
  const byType = defects.reduce((m, d) => ((m[d.type] = (m[d.type] || 0) + 1), m), {});
  return { defects, stats, byLevel, byType };
}

/** Excel 报告：Sheet1 检测概况 / Sheet2 病害明细 */
function buildExcelReport(tunnel) {
  const { defects, byType, byLevel } = collectData(tunnel);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });

  const overview = [
    [{ v: '隧途明鉴 —— 隧道病害智能检测与分析系统 · 检测报告' }, '', '', ''],
    ['', '', '', ''],
    [{ v: '检测概况', header: 1 }, { v: '', header: 1 }, { v: '', header: 1 }, { v: '', header: 1 }],
    ['报告生成时间', now, '病害总数', defects.length],
    ['检测范围', tunnel || '全部隧道', '严重病害(3/4级)', (byLevel['3级-严重'] || 0) + (byLevel['4级-危及安全'] || 0)],
    ['待人工审核', defects.filter((d) => d.status === '待审核').length, '已审核闭环', defects.filter((d) => d.status === '已审核').length],
    ['自动审核闭环', defects.filter((d) => d.autoReviewed).length, '驳回复检', defects.filter((d) => d.status === '已驳回').length],
    ['', '', '', ''],
    [{ v: '病害类型分布', header: 1 }, { v: '数量', header: 1 }, { v: '病害等级分布', header: 1 }, { v: '数量', header: 1 }],
    ...Object.keys(byType).map((t, i) => {
      const lvKeys = Object.keys(byLevel);
      return [t, byType[t], lvKeys[i] || '', lvKeys[i] ? byLevel[lvKeys[i]] : ''];
    }),
    ['', '', '', ''],
    [{ v: '审核说明：1级轻微病害由系统自动审核闭环；2级及以上进入人工审核队列，审核记录详见明细表。', }, '', '', ''],
  ];

  const detailHeader = ['病害ID', '来源', '隧道', '类型', '亚型', '评估等级', '桩号', '环向方位',
    '置信度', '量测结果', '整治建议', '状态', '审核人', '处置决策'];
  const detail = [detailHeader.map((h) => ({ v: h, header: 1 }))];
  for (const d of defects) {
    detail.push([
      d.id, d.source || '巡检模拟', d.tunnel, d.type, d.subtype || '', d.finalLevel || d.level,
      d.position.chainage, d.position.sector, d.confidence,
      d.physical ? Object.entries(d.physical).map(([k, v]) => `${k}${v}`).join(' ') : '',
      d.suggestions.join('；'),
      d.status,
      d.review ? d.review.reviewer : '',
      d.decision || '',
    ]);
  }

  return buildXlsx([
    { name: '检测概况', rows: overview, widths: [22, 46, 22, 30] },
    { name: '病害明细', rows: detail, widths: [16, 10, 14, 10, 10, 14, 10, 10, 8, 24, 60, 10, 18, 30] },
  ]);
}

/** 打印版 PDF 报告（HTML，浏览器 Ctrl+P / 自动唤起打印即可存 PDF） */
function buildPdfHtml(tunnel, images) {
  const { defects, byType, byLevel } = collectData(tunnel);
  const now = new Date().toLocaleString('zh-CN', { hour12: false });
  const imgHtml = (images || []).slice(0, 6).map((src, i) =>
    `<div class="imgbox"><img src="${src}"/><span>标注图 ${i + 1}</span></div>`).join('');

  const rows = defects.map((d, i) => `
    <tr>
      <td>${i + 1}</td><td>${esc(d.id)}</td><td>${esc(d.source || '巡检模拟')}</td>
      <td style="color:${TYPE_COLORS[d.type] || '#333'}">● ${esc(d.type)}${d.subtype ? `·${esc(d.subtype)}` : ''}</td>
      <td>${esc(d.finalLevel || d.level)}</td><td>${esc(d.position.chainage)}</td><td>${esc(d.position.sector)}</td>
      <td>${d.confidence.toFixed(2)}</td>
      <td class="lt">${esc(d.physical ? Object.entries(d.physical).map(([k, v]) => `${k}${v}`).join(' ') : '')}</td>
      <td class="lt">${esc(d.suggestions.join('；'))}</td>
      <td>${esc(d.status)}${d.review ? `<br><span class="sub">${esc(d.review.reviewer)}·${esc(d.decision || '')}</span>` : ''}</td>
    </tr>`).join('');

  return `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">
<title>隧途明鉴 · 隧道病害检测报告</title>
<style>
  body{font-family:"Microsoft YaHei",sans-serif;color:#1a2230;margin:0;padding:28px 36px;}
  h1{font-size:22px;letter-spacing:2px;border-bottom:3px solid #2f5496;padding-bottom:10px;}
  h1 small{font-size:13px;color:#667;font-weight:normal;margin-left:10px;}
  h2{font-size:15px;color:#2f5496;margin:22px 0 8px;border-left:4px solid #2f5496;padding-left:8px;}
  .meta{display:grid;grid-template-columns:repeat(4,1fr);gap:8px;margin:12px 0;}
  .meta div{background:#f2f5fa;border:1px solid #d8e0ec;border-radius:6px;padding:8px 10px;font-size:12px;}
  .meta b{display:block;font-size:18px;color:#2f5496;}
  table{width:100%;border-collapse:collapse;font-size:11px;}
  th{background:#2f5496;color:#fff;padding:6px 5px;text-align:left;}
  td{border-bottom:1px solid #e2e8f0;padding:5px;}
  tr:nth-child(even) td{background:#f7f9fc;}
  .lt{max-width:260px;}
  .sub{color:#889;font-size:10px;}
  .imgs{display:flex;gap:10px;flex-wrap:wrap;}
  .imgbox{text-align:center;}
  .imgbox img{max-width:300px;border:1px solid #ccd;border-radius:6px;display:block;}
  .imgbox span{font-size:11px;color:#667;}
  .note{font-size:11px;color:#556;margin-top:14px;line-height:1.7;}
  .bar{display:inline-block;height:10px;background:#2f5496;border-radius:2px;vertical-align:middle;margin-right:4px;}
  @media print{ .noprint{display:none} body{padding:10mm} }
</style></head><body>
<div class="noprint" style="background:#eef3fb;border:1px solid #c5d5ee;border-radius:8px;padding:10px 14px;margin-bottom:16px;font-size:13px;">
  报告已按打印排版生成：使用浏览器“打印 → 另存为 PDF”即可导出 PDF 文件。若未自动弹出打印对话框，请按 Ctrl+P。<button onclick="window.print()" style="margin-left:10px;padding:5px 14px;background:#2f5496;color:#fff;border:none;border-radius:5px;cursor:pointer">立即打印 / 存为 PDF</button>
</div>
<h1>隧途明鉴 · 隧道病害检测报告<small>基于车载多感融合的隧道病害智能诊析决策系统</small></h1>
<div class="meta">
  <div>病害总数<b>${defects.length}</b></div>
  <div>严重病害(3/4级)<b>${(byLevel['3级-严重'] || 0) + (byLevel['4级-危及安全'] || 0)}</b></div>
  <div>待人工审核<b>${defects.filter((d) => d.status === '待审核').length}</b></div>
  <div>已审核闭环<b>${defects.filter((d) => d.status === '已审核').length}</b></div>
</div>
<p style="font-size:12px;color:#556">检测范围：${esc(tunnel || '全部隧道')}　报告生成时间：${now}　参照标准：《公路隧道养护技术规范》（JTG H12）分级精神</p>

<h2>一、病害标注图</h2>
<div class="imgs">${imgHtml || '<span style="font-size:12px;color:#889">本次报告未附带标注图（可在检测界面生成后导出）</span>'}</div>

<h2>二、统计分析</h2>
<p style="font-size:12px">${Object.entries(byType).map(([t, n]) => `<span style="margin-right:14px"><span class="bar" style="width:${Math.min(60, n * 4)}px"></span>${t}：${n} 处</span>`).join('')}</p>
<p style="font-size:12px">${Object.entries(byLevel).map(([l, n]) => `<span style="margin-right:14px">${l}：${n} 处</span>`).join('')}</p>

<h2>三、病害明细与整治建议</h2>
<table><thead><tr>
  <th>#</th><th>病害ID</th><th>来源</th><th>类型</th><th>等级</th><th>桩号</th><th>方位</th>
  <th>置信度</th><th>量测结果</th><th>整治建议</th><th>审核状态</th>
</tr></thead><tbody>${rows || '<tr><td colspan="11">暂无病害记录</td></tr>'}</tbody></table>

<p class="note">审核规则：评估等级为 1 级（轻微）的病害由系统自动审核闭环；2 级及以上病害进入人工审核队列，由审核员核定等级并敲定处置决策。<br>
本报告由"隧途明鉴"系统自动生成，识别结果供辅助决策参考，最终处置决策以人工审核结论为准。</p>
<script>
// 独立窗口打开时自动唤起打印；页内 iframe 承载时不弹打印（避免阻塞页面）
if (window.self === window.top) window.addEventListener('load', () => setTimeout(() => window.print(), 600));
</script>
</body></html>`;

  function esc(s) {
    return String(s ?? '').replace(/[&<>]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;' }[c]));
  }
}

module.exports = { buildExcelReport, buildPdfHtml, collectData };
