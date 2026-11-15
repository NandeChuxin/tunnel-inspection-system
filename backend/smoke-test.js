/* smoke test: 全流程闭环验证 */
const BASE = 'http://localhost:8787';

async function j(path, opts) {
  const r = await fetch(BASE + path, opts);
  const body = await r.json();
  if (!r.ok) throw new Error(path + ' -> ' + r.status + ' ' + JSON.stringify(body));
  return body;
}

(async () => {
  console.log('== 1. 健康检查 ==');
  console.log(await j('/api/health'));

  console.log('\n== 2. 模拟 8 帧采集（自动巡检一巡） ==');
  let detected = [];
  for (let i = 0; i < 8; i++) {
    const r = await j('/api/simulate', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' });
    console.log(`帧 ${r.frame.id} @ K${Math.floor(r.frame.mileage / 1000)}+${String(r.frame.mileage % 1000).padStart(3, '0')}  检出 ${r.defects.length} 处: ${r.defects.map((d) => `${d.type}·${d.subtype}(${d.level})`).join('、')}`);
    detected.push(...r.defects);
  }

  console.log('\n== 3. 病害台账 ==');
  const list = await j('/api/defects');
  console.log('台账总数:', list.length);
  for (const d of list.slice(0, 5)) console.log(` ${d.id} ${d.tunnel} ${d.type} ${d.level} @${d.position.chainage} ${d.position.sector} conf=${d.confidence} 状态=${d.status}`);

  console.log('\n== 4. 人工审核闭环 ==');
  if (list.length) {
    const target = list[0];
    const rv = await j(`/api/defects/${target.id}/review`, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ reviewer: '张工（隧道养护科）', action: '通过', levelOverride: '2级-中等', decision: '纳入月度整治计划', note: '现场复核缝宽约0.3mm，按2级处置' }),
    });
    console.log(`审核完成: ${rv.id} 状态=${rv.status} 核定等级=${rv.finalLevel} 决策=${rv.decision}`);
  }

  console.log('\n== 5. 统计 ==');
  console.log(JSON.stringify(await j('/api/stats'), null, 1));

  console.log('\n== 6. 异常输入校验 ==');
  const bad = await fetch(BASE + '/api/ingest', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{"foo":1}' });
  console.log('缺字段上传 ->', bad.status, await bad.json());

  console.log('\n全部通过 ✔');
})().catch((e) => { console.error('FAIL:', e.message); process.exit(1); });
