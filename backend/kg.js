/**
 * kg.js — 隧道病害知识图谱（模块五）
 *
 * 职责：
 *   1) 本体种子：10 类实体 + 13 类关系，播种入 kg_entity / kg_relation（表空才播种，事务）
 *   2) 子图检索：subgraph(type, level)  —— 以病害类型为圆心取 2~3 跳子图，供前端画图谱
 *   3) 闭环推理：explain(defect)        —— 输入一条病害台账记录，输出
 *        等级依据（判据 + 规范条款）/ 特征量化对照 / 成因排序（含证据）/
 *        结构危害 / 维修方案（工艺 + 依据条款）/ 处置动作与复查周期 / 置信度闸
 *   4) 统计：stats() —— 实体与关系计数，供界面显示规模
 *
 * 设计约定（避免两处真值）：
 *   · 措施实体只存"措施名 + 依据条款 + 施工窗口"，**具体处置文案读 knowledge_base**
 *     （教师可在线维护的那张表），图谱不复制处置文案。
 *   · 等级判定不在图谱里重造：等级由检测链路给出；图谱负责给出**依据条款、成因、
 *     危害、措施与修正提示**，并做"阈值复核"（记录等级 vs 阈值命中等级是否一致）。
 *   · 实例层（detection）不落图谱表：explain 返回的实例节点与关系是虚拟节点，
 *     避免每检一次就往图谱里灌数据。
 *
 * 输入输出约定：
 *   subgraph(type, levelNo) -> { nodes:[{id,etype,name,props,source}], edges:[{head,rel,tail,weight,cond,source}] }
 *   explain(defectRecord)   -> { defectId, type, levelNo, features[], levelBasis{}, modifiers[],
 *                                causes[], hazards[], treatments[], action, interval,
 *                                subgraph{}, gate }
 *
 * 依赖：db.js（SQLite）/ kb.js（措施文案与分级依据）/ fusion.js（类型、等级、部位、标定）
 * 运行：由 server.js 启动时 require 并调用 seedIfEmpty()
 */
'use strict';

const db = require('./db');
const kb = require('./kb');
const fusion = require('./fusion');

const TYPES = fusion.DEFECT_TYPES;                 // 5 类病害
const LEVELS = fusion.LEVELS;                      // 1~4 级文案
const SECTORS = fusion.SECTORS;                    // 拱顶/左拱腰/右拱腰/左边墙/右边墙/仰拱
const VIEW_W = fusion.VIEW_WIDTH_M;                // 单帧视场宽（m），用于像素→物理量估算

/* ============================================================================
   一、本体定义（实体）
   ========================================================================== */

/* 风险等级：等级 → JTG 类 / TB 劣化等级 / 处置动作 / 复查周期 */
const LEVEL_DEF = [
  { lv: 1, jtg: '1 类（评分≥85，正常养护）', tb: 'D（轻微，无影响）', action: '正常养护', interval: '按经常检查频率' },
  { lv: 2, jtg: '2~3 类（≥70 / ≥55，保养维修、局部处治）', tb: 'C（中等，影响较少）', action: '保养维修 / 局部处治', interval: '3 个月' },
  { lv: 3, jtg: '4 类（≥40，交通管制并尽快处治）', tb: 'B（较重）～A1（严重）', action: '交通管制 + 尽快处治', interval: '1 个月' },
  { lv: 4, jtg: '5 类（<40 或触发直接判定条款，关闭隧道处治）', tb: 'AA（极严重，立即采取措施）', action: '关闭隧道 + 专项评估后处治', interval: '持续监测 / 即时复查' },
];

/* 结构部位：部位 → JTG 分项归类 + 判级修正提示 */
const PART_DEF = [
  ['拱顶', '衬砌结构', '从严：落物风险与受力关键部位'],
  ['左拱腰', '衬砌结构', '从严：偏压敏感部位'],
  ['右拱腰', '衬砌结构', '从严：偏压敏感部位'],
  ['左边墙', '衬砌结构', '常规'],
  ['右边墙', '衬砌结构', '常规'],
  ['仰拱', '衬砌结构', '常规：注意积水与翻浆'],
];

/* 成因因子：五大类（地质/设计/施工/材料/运营环境） */
const CAUSES = [
  ['裂缝', '围岩偏压或不均匀围岩压力', '地质', 0.75, '纵向裂缝、偏压段'],
  ['裂缝', '衬砌背后空洞或回填不密实', '施工', 0.70, ''],
  ['裂缝', '混凝土干缩与温度收缩', '材料', 0.60, '环向或网状细裂缝'],
  ['裂缝', '冻胀力作用（寒冷地区）', '运营环境', 0.50, '洞口段、寒季扩展'],
  ['裂缝', '钢筋锈蚀膨胀（顺筋裂缝）', '运营环境', 0.50, '沿钢筋走向'],
  ['裂缝', '地基不均匀沉降', '地质', 0.45, ''],
  ['裂缝', '水化热温度应力', '材料', 0.45, ''],
  ['裂缝', '保护层厚度或配筋不足', '设计', 0.40, ''],
  ['渗漏水', '防水板破损或搭接不良', '施工', 0.80, ''],
  ['渗漏水', '施工缝 / 变形缝止水带失效', '施工', 0.75, '呈线性渗漏、沿缝分布'],
  ['渗漏水', '衬砌裂缝形成渗水通道', '材料', 0.70, '渗漏伴随裂缝'],
  ['渗漏水', '排水系统堵塞（盲管、中央排水管）', '运营环境', 0.60, ''],
  ['渗漏水', '地下水位上升或降雨补给', '地质', 0.55, '季节性变化'],
  ['渗漏水', '衬砌混凝土抗渗不足、密实度不够', '材料', 0.50, ''],
  ['剥落掉块', '保护层不足伴钢筋锈蚀膨胀', '材料', 0.75, '剥落处见锈迹'],
  ['剥落掉块', '混凝土碳化与冻融循环', '运营环境', 0.70, ''],
  ['剥落掉块', '施工质量缺陷（蜂窝麻面、振捣不密实）', '施工', 0.60, ''],
  ['剥落掉块', '衬砌受压区压溃（偏压、围岩压力过大）', '地质', 0.50, '拱部碎裂状'],
  ['剥落掉块', '酸碱或硫酸盐侵蚀', '运营环境', 0.40, ''],
  ['剥落掉块', '火灾或高温损伤', '运营环境', 0.20, ''],
  ['衬砌错台', '地基或围岩不均匀沉降', '地质', 0.75, ''],
  ['衬砌错台', '偏压导致衬砌受扭', '地质', 0.60, ''],
  ['衬砌错台', '施工缝 / 沉降缝错位', '施工', 0.55, '错台沿缝分布'],
  ['衬砌错台', '衬砌背后空洞造成受力不均', '施工', 0.50, ''],
  ['衬砌错台', '软弱围岩大变形（蠕变）', '地质', 0.45, '变形持续发展'],
  ['白华析出', '渗漏通道存在（Ca(OH)₂ 溶出生成 CaCO₃）', '材料', 0.85, '析出物呈白色结垢'],
  ['白华析出', '衬砌混凝土孔隙率大、密实度不足', '材料', 0.60, ''],
  ['白华析出', '排水不畅造成长期潮湿环境', '运营环境', 0.50, ''],
  ['白华析出', '环境水侵蚀（含碳酸盐 / 硫酸盐）', '地质', 0.40, ''],
];

/* 结构危害：三大类（承载安全 / 耐久性 / 运营安全） */
const HAZARDS = [
  ['衬砌有效厚度与刚度下降', '承载安全'],
  ['衬砌失稳（结构性裂缝贯穿）', '承载安全'],
  ['局部压溃', '承载安全'],
  ['限界侵入', '承载安全'],
  ['钢筋锈蚀', '耐久性'],
  ['混凝土劣化（碳化 / 冻融 / 侵蚀）', '耐久性'],
  ['防水层失效加剧劣化', '耐久性'],
  ['落物伤车', '运营安全'],
  ['路面或道床积水结冰', '运营安全'],
  ['基床翻浆冒泥', '运营安全'],
  ['洞内潮湿影响机电与视线', '运营安全'],
  ['涌水突泥', '运营安全'],
];

/* 规范条款（溯源凭据；引用时以正式出版文本为准） */
const CLAUSES = [
  ['CL-JTG-H12-4.5', 'JTG H12-2015 §4.5 土建结构技术状况评定',
    '土建结构技术状况按 1~5 类评定：技术状况评分 ≥85 为一类、≥70 为二类、≥55 为三类、≥40 为四类、<40 为五类。'],
  ['CL-JTG-H12-4.5.4', 'JTG H12-2015 §4.5.4 分项控制指标',
    '洞口、洞门、衬砌、路面、吊顶及预埋件等分项评定状况值达 3 或 4 时，土建结构技术状况直接评为 4 类或 5 类。'],
  ['CL-JTG-H12-4.5.5', 'JTG H12-2015 §4.5.5 五类隧道直接判定',
    '拱部衬砌大范围开裂、结构性裂缝贯穿衬砌混凝土；衬砌明显永久变形且有危及结构安全趋势；地下水大规模涌流喷射等情形，直接评为 5 类。'],
  ['CL-JTG-H12-6', 'JTG H12-2015 第 6 章 按技术状况分类养护',
    '1 类正常养护；2 类按需保养维修；3 类对局部实施病害处治；4 类交通管制并尽快处治；5 类及时关闭隧道后处治。'],
  ['CL-JTG-H12-B', 'JTG H12-2015 附录 B 土建结构技术状况评定表',
    '隧道土建结构分项（洞口、洞门、衬砌、路面、检修道、排水设施、吊顶及预埋件、内装饰、交通标志标线）评定与权重取值表。'],
  ['CL-TBT2820-3', 'TB/T 2820.2-1997 §3 隧道劣化等级划分',
    '劣化等级分 AA（极严重，立即采取措施）、A1（严重，尽快采取措施）、B（较重，加强监视）、C（中等，加强检查正常维修）、D（轻微，正常保养巡检）。'],
  ['CL-TBT2820-4.1', 'TB/T 2820.2-1997 §4.1 衬砌裂损类型',
    '衬砌裂损包括衬砌变形、衬砌移动与衬砌开裂；开裂分张裂（受拉）、压溃（受压碎裂剥落）、错台（剪切错动）三种状态。'],
  ['CL-TBT2820-4.2', 'TB/T 2820.2-1997 §4.2 衬砌裂损劣化评定',
    '按开裂 / 错台长度 L、宽度与变形发展定级：L>10m 且宽度≥5mm 且变形继续发展属极严重；开裂错台宽度≥5mm 属严重；变形速率 V>10mm/年属严重、3~10mm/年属较重、<3mm/年属中等。'],
  ['CL-TBT2820-5', 'TB/T 2820.2-1997 渗漏水危害评定',
    'AA：水突然涌入隧道淹没轨面或拱部漏水直传接触网；A：隧底冒水、拱部滴水成线，造成翻浆冒泥、道床下沉；B：滴水淌水引起局部翻浆冒泥；C：漏水使基床恶化、钢轨腐蚀；D：有漏水但无威胁。'],
  ['CL-TBT2820-6', 'TB/T 2820.2-1997 衬砌材料劣化评定',
    '衬砌材料劣化按腐蚀深度、劣化面积与有效厚度评定：腐蚀深度约 10mm、面积约 0.3m²、有效厚度降至设计值 2/3 左右属严重；衬砌剥落减薄属较重；起毛、麻面蜂窝属轻微。'],
  ['CL-JGJ212-1.0.3', 'JGJ/T 212-2010 §1.0.3 渗漏治理原则',
    '地下工程渗漏治理应遵循"以堵为主，堵排结合，因地制宜，多道设防，综合治理"的原则。'],
  ['CL-JGJ212-4', 'JGJ/T 212-2010 第 4 章 现浇混凝土结构渗漏治理',
    '按渗漏形式选择注浆止水（钻孔注浆、埋管注浆、贴嘴注浆）、防水抹面等工艺，注浆参数根据渗漏量动态调整。'],
  ['CL-JGJ212-5', 'JGJ/T 212-2010 第 5 章 预制衬砌隧道渗漏治理',
    '预制衬砌隧道渗漏治理应结合接缝、螺栓孔、注浆孔等部位特征确定方案。'],
  ['CL-GB50108', 'GB 50108-2008 地下工程防水技术规范',
    '地下工程防水等级划分与设防要求（构造防水、止水带、注浆防水层等）。'],
  ['CL-GB50367', 'GB 50367-2013 混凝土结构加固设计规范',
    '混凝土结构加固方法（增大截面、粘贴钢板、外包型钢等）及其设计规定，用于结构性病害的加固设计。'],
  ['CL-GBT50476', 'GB/T 50476-2019 混凝土结构耐久性设计标准',
    '碳化、冻融、氯盐等环境作用下的耐久性要求与保护层厚度规定。'],
  ['CL-TB10003', 'TB 10003-2016 铁路隧道设计规范',
    '隧道衬砌构造、防排水与支护设计要求，是判断衬砌质量缺陷成因的依据。'],
  ['CL-JTGT3660', 'JTG/T 3660-2020 公路隧道施工技术规范',
    '衬砌浇筑、背后回填注浆、防排水施工的质量要求，是施工类成因的判断依据。'],
  ['CL-TBT2820-0', 'TB/T 2820.2-1997 编制依据',
    '本标准以《铁路技术管理规程》《铁路桥隧建筑物大修维修规则》等规章及有关标准为依据编制，养护作业与周期按其规定执行。'],
];

/* 维修方案：措施名 → 施工窗口（是否需限行）、依据条款、工艺要点简述 */
const MEASURES = [
  ['表面封闭', '不限行', 'CL-TBT2820-4.2', '沿裂缝涂刷环氧树脂等封闭材料，防止水分侵入。'],
  ['低压注浆填充', '短时限行', 'CL-JGJ212-4', '环氧 / 聚氨酯浆液低压慢注填充裂缝，注后复查饱满度。'],
  ['裂缝观测标 + 跟踪监测', '不限行', 'CL-TBT2820-4.2', '设置观测标，跟踪缝宽发展速率，作为升降级依据。'],
  ['凿槽嵌缝 + 跨缝补强', '短时限行', 'CL-TBT2820-4.2', '沿缝凿 V 形槽嵌入柔性止水材料并跨缝补强。'],
  ['加密监测 + 查明成因', '不限行', 'CL-TBT2820-4.2', '结合偏压 / 冻胀 / 收缩等成因排查，对症处治。'],
  ['结构安全评估（专业机构）', '需交通管制', 'CL-JTG-H12-4.5.5', '委托专业机构开展结构安全专项评估。'],
  ['套衬加固或换衬', '需交通管制', 'CL-GB50367', '按评估结论实施套衬加固或换衬，属结构性加固范畴。'],
  ['限行 + 上报应急预案', '需交通管制', 'CL-JTG-H12-6', '立即限行并上报，防范衬砌失稳与落物风险。'],
  ['防水涂层封闭', '不限行', 'CL-GB50108', '清理湿渍范围后局部涂刷防水涂层并观察。'],
  ['引排结合（半圆排水管）', '短时限行', 'CL-JGJ212-1.0.3', '埋设半圆排水管将渗水导入排水系统，体现"堵排结合"。'],
  ['渗水面注浆封堵', '短时限行', 'CL-JGJ212-4', '聚氨酯 / 水泥-水玻璃浆液封堵渗水通道。'],
  ['系统堵排（回填注浆 + 盲管改造）', '需交通管制', 'CL-JGJ212-5', '钻孔回填注浆配合环向排水盲管改造，系统治水。'],
  ['排水系统疏通 / 更换', '短时限行', 'CL-JGJ212-1.0.3', '排查中央排水管通畅性，必要时更换。'],
  ['水文地质补充勘察 + 专项治水', '需交通管制', 'CL-TBT2820-5', '补充勘察地下水位与补给条件，制定专项治水方案。'],
  ['清除松动层 + 界面剂修补', '短时限行', 'CL-GBT50476', '清除起皮松动层后涂界面剂修补。'],
  ['凿除空鼓层 + 聚合物砂浆修补', '短时限行', 'CL-GB50367', '凿除空鼓层后用聚合物砂浆修补密实。'],
  ['注浆填充密实', '短时限行', 'CL-JGJ212-4', '对修补范围注浆填充，消除空腔。'],
  ['挂网喷锚加固', '需交通管制', 'CL-GB50367', '清除劣化层后挂网喷锚，恢复整体性。'],
  ['钢拱架临时支撑', '需交通管制', 'CL-JTG-H12-6', '施作临时支撑并纳入变形监测。'],
  ['防护网 / 防护棚', '需交通管制', 'CL-JTG-H12-4.5.5', '落实落物防护措施后专项处置。'],
  ['变形观测点 + 周期观测', '不限行', 'CL-TBT2820-4.2', '标记观测点，纳入周期变形观测。'],
  ['径向注浆加固', '需交通管制', 'CL-GB50367', '径向注浆加固围岩与衬砌间隙。'],
  ['钢带锚杆约束', '需交通管制', 'CL-GB50367', '施作钢带与锚杆约束错台发展。'],
  ['限界与结构安全专项评估', '需交通管制', 'CL-JTG-H12-4.5.5', '开展限界与结构安全专项评估后确定处治方案。'],
  ['铲除析出物 + 涂防水剂', '不限行', 'CL-GB50108', '铲除白华析出物并涂刷防水剂封闭渗水通道。'],
  ['溯源注浆封堵', '短时限行', 'CL-JGJ212-4', '沿渗水路径溯源注浆封堵后恢复表面。'],
  ['渗漏观测点 + 跟踪', '不限行', 'CL-TBT2820-5', '纳入渗漏观测点，跟踪析出与渗漏发展。'],
  ['耐磨防碳化处理', '短时限行', 'CL-GBT50476', '检查钢筋锈蚀风险后作耐磨防碳化处理。'],
];

/* 类型 × 等级 → 措施（与 knowledge_base.repair_plan 的措辞对齐，等级门槛见 cond.level） */
const TYPE_LEVEL_MEASURES = {
  '裂缝': { 1: ['表面封闭'], 2: ['低压注浆填充', '裂缝观测标 + 跟踪监测'], 3: ['凿槽嵌缝 + 跨缝补强', '加密监测 + 查明成因'], 4: ['限行 + 上报应急预案', '结构安全评估（专业机构）', '套衬加固或换衬'] },
  '渗漏水': { 1: ['防水涂层封闭'], 2: ['引排结合（半圆排水管）', '渗水面注浆封堵'], 3: ['系统堵排（回填注浆 + 盲管改造）', '排水系统疏通 / 更换'], 4: ['限行 + 上报应急预案', '水文地质补充勘察 + 专项治水'] },
  '剥落掉块': { 1: ['清除松动层 + 界面剂修补'], 2: ['凿除空鼓层 + 聚合物砂浆修补', '注浆填充密实'], 3: ['挂网喷锚加固', '钢拱架临时支撑'], 4: ['限行 + 上报应急预案', '防护网 / 防护棚', '结构安全评估（专业机构）'] },
  '衬砌错台': { 1: ['变形观测点 + 周期观测'], 2: ['注浆填充密实'], 3: ['径向注浆加固', '钢带锚杆约束'], 4: ['限行 + 上报应急预案', '限界与结构安全专项评估'] },
  '白华析出': { 1: ['铲除析出物 + 涂防水剂'], 2: ['溯源注浆封堵', '渗漏观测点 + 跟踪'], 3: ['系统堵排（回填注浆 + 盲管改造）', '耐磨防碳化处理'], 4: ['限行 + 上报应急预案', '水文地质补充勘察 + 专项治水'] },
};

/* 类型 → 高发部位（权重 = 先验常见度，非实测） */
const TYPE_PARTS = {
  '裂缝': [['拱顶', 0.9], ['左拱腰', 0.75], ['右拱腰', 0.75], ['左边墙', 0.5], ['右边墙', 0.5]],
  '渗漏水': [['拱顶', 0.85], ['左拱腰', 0.7], ['右拱腰', 0.7], ['仰拱', 0.55]],
  '剥落掉块': [['拱顶', 0.9], ['左拱腰', 0.6], ['右拱腰', 0.6]],
  '衬砌错台': [['左拱腰', 0.7], ['右拱腰', 0.7], ['拱顶', 0.55], ['仰拱', 0.5]],
  '白华析出': [['拱顶', 0.7], ['左拱腰', 0.6], ['右拱腰', 0.6], ['仰拱', 0.5]],
};

/* 类型 → 特征（是否主判据） */
const TYPE_FEATURES = {
  '裂缝': [['缝宽', 1], ['缝长', 1], ['裂缝走向', 0], ['裂缝形态（张裂 / 压溃 / 错台）', 0]],
  '渗漏水': [['渗水面积', 1], ['渗漏形态（湿渍 / 滴水 / 成线 / 涌水）', 1], ['渗漏部位', 0]],
  '剥落掉块': [['剥落面积', 1], ['是否位于拱部', 1], ['剥落深度 / 是否露筋', 0]],
  '衬砌错台': [['错台量', 1], ['错台发展速率', 1], ['错台沿缝分布', 0]],
  '白华析出': [['析出面积', 1], ['是否伴随渗漏', 1], ['析出物颜色与形态', 0]],
};

/* 类型 → 危害 */
const TYPE_HAZARDS = {
  '裂缝': ['衬砌有效厚度与刚度下降', '钢筋锈蚀', '衬砌失稳（结构性裂缝贯穿）'],
  '渗漏水': ['钢筋锈蚀', '基床翻浆冒泥', '路面或道床积水结冰', '洞内潮湿影响机电与视线', '涌水突泥'],
  '剥落掉块': ['落物伤车', '衬砌有效厚度与刚度下降', '限界侵入'],
  '衬砌错台': ['限界侵入', '局部压溃', '衬砌失稳（结构性裂缝贯穿）'],
  '白华析出': ['钢筋锈蚀', '混凝土劣化（碳化 / 冻融 / 侵蚀）', '防水层失效加剧劣化'],
};

/* 成因 → 危害（导致） */
const CAUSE_HAZARDS = {
  '围岩偏压或不均匀围岩压力': ['衬砌失稳（结构性裂缝贯穿）', '局部压溃'],
  '衬砌背后空洞或回填不密实': ['局部压溃', '衬砌有效厚度与刚度下降'],
  '混凝土干缩与温度收缩': ['防水层失效加剧劣化'],
  '冻胀力作用（寒冷地区）': ['混凝土劣化（碳化 / 冻融 / 侵蚀）', '限界侵入'],
  '钢筋锈蚀膨胀（顺筋裂缝）': ['钢筋锈蚀', '混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '地基不均匀沉降': ['衬砌失稳（结构性裂缝贯穿）', '限界侵入'],
  '水化热温度应力': ['防水层失效加剧劣化'],
  '保护层厚度或配筋不足': ['钢筋锈蚀'],
  '防水板破损或搭接不良': ['钢筋锈蚀', '洞内潮湿影响机电与视线'],
  '施工缝 / 变形缝止水带失效': ['钢筋锈蚀', '洞内潮湿影响机电与视线'],
  '衬砌裂缝形成渗水通道': ['钢筋锈蚀'],
  '排水系统堵塞（盲管、中央排水管）': ['基床翻浆冒泥', '路面或道床积水结冰'],
  '地下水位上升或降雨补给': ['涌水突泥'],
  '衬砌混凝土抗渗不足、密实度不够': ['防水层失效加剧劣化'],
  '保护层不足伴钢筋锈蚀膨胀': ['落物伤车', '钢筋锈蚀'],
  '混凝土碳化与冻融循环': ['混凝土劣化（碳化 / 冻融 / 侵蚀）', '落物伤车'],
  '施工质量缺陷（蜂窝麻面、振捣不密实）': ['混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '衬砌受压区压溃（偏压、围岩压力过大）': ['局部压溃', '落物伤车'],
  '酸碱或硫酸盐侵蚀': ['混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '火灾或高温损伤': ['混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '偏压导致衬砌受扭': ['衬砌失稳（结构性裂缝贯穿）'],
  '施工缝 / 沉降缝错位': ['限界侵入'],
  '衬砌背后空洞造成受力不均': ['局部压溃'],
  '软弱围岩大变形（蠕变）': ['限界侵入', '衬砌失稳（结构性裂缝贯穿）'],
  '渗漏通道存在（Ca(OH)₂ 溶出生成 CaCO₃）': ['钢筋锈蚀', '混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '衬砌混凝土孔隙率大、密实度不足': ['混凝土劣化（碳化 / 冻融 / 侵蚀）'],
  '排水不畅造成长期潮湿环境': ['钢筋锈蚀'],
  '环境水侵蚀（含碳酸盐 / 硫酸盐）': ['混凝土劣化（碳化 / 冻融 / 侵蚀）'],
};

/* 等级 → 判定依据条款 / 等级映射条款 / 处置动作 */
const LEVEL_CLAUSES = {
  1: ['CL-TBT2820-3'],
  2: ['CL-TBT2820-3'],
  3: ['CL-TBT2820-4.2', 'CL-TBT2820-5'],
  4: ['CL-JTG-H12-4.5.5', 'CL-TBT2820-3'],
};
const LEVEL_MAP_CLAUSES = {
  1: ['CL-JTG-H12-4.5', 'CL-JTG-H12-6'],
  2: ['CL-JTG-H12-4.5', 'CL-JTG-H12-6'],
  3: ['CL-JTG-H12-4.5.4', 'CL-JTG-H12-6'],
  4: ['CL-JTG-H12-4.5.5', 'CL-JTG-H12-6'],
};

/* ============================================================================
   二、阈值判据（用于特征量化对照与等级复核；阈值均来自上列条款）
   ========================================================================== */

/* 每类病害的可量化特征规则：
   get(record) → 数值 | null；bands 由小到大；levelFrom 用于复核判定 */
const AREA_OF = (rec) => {
  const t = rec && rec.physical && rec.physical['面积'];
  const m = String(t || '').match(/([\d.]+)\s*m/);
  return m ? Number(m[1]) : null;
};
const BBOX_OF = (rec) => (rec && rec.position && Array.isArray(rec.position.bbox) ? rec.position.bbox : null);

const FEATURE_RULES = {
  '裂缝': [
    { name: '缝长（估算）', unit: 'm', get: (r) => { const b = BBOX_OF(r); return b ? +(Math.max(b[2], b[3]) * VIEW_W).toFixed(2) : null; },
      bands: [{ lt: 1.2, lv: 1, text: '长度 <1.2m' }, { lt: 4, lv: 2, text: '长度 ≥1.2m' }, { lt: 8, lv: 3, text: '长度 ≥4m' }, { lv: 4, text: '长度 ≥8m 或纵向裂缝升级' }],
      clause: 'CL-TBT2820-4.2' },
    { name: '缝宽', unit: 'mm', get: () => null,
      bands: [{ lt: 5, lv: 2, text: '缝宽 <5mm' }, { lv: 3, text: '缝宽 ≥5mm' }],
      clause: 'CL-TBT2820-4.2', needField: true },
  ],
  '渗漏水': [
    { name: '渗水面积', unit: 'm²', get: AREA_OF,
      bands: [{ lt: 0.5, lv: 1, text: '面积 <0.5m²' }, { lt: 2, lv: 2, text: '面积 0.5~2m²' }, { lv: 3, text: '面积 ≥2m²' }],
      clause: 'CL-TBT2820-5' },
  ],
  '剥落掉块': [
    { name: '剥落面积', unit: 'm²', get: AREA_OF,
      bands: [{ lt: 0.1, lv: 1, text: '面积 <0.1m² 且非拱部' }, { lt: 0.5, lv: 2, text: '面积 ≥0.1m² 或拱部剥落' }, { lt: 1.5, lv: 3, text: '面积 ≥0.5m²' }, { lv: 4, text: '面积 ≥1.5m² 或拱部 ≥0.5m²' }],
      clause: 'CL-TBT2820-6' },
  ],
  '衬砌错台': [
    { name: '错台量', unit: 'mm', get: () => null,
      bands: [{ lt: 3, lv: 1, text: '断面差 <3mm' }, { lt: 8, lv: 2, text: '3~8mm' }, { lt: 15, lv: 3, text: '8~15mm' }, { lv: 4, text: '≥15mm 或发展迅速' }],
      clause: 'CL-TBT2820-4.2', needField: true },
  ],
  '白华析出': [
    { name: '析出面积', unit: 'm²', get: AREA_OF,
      bands: [{ lt: 1, lv: 1, text: '面积 <1m²' }, { lv: 2, text: '面积 ≥1m²，需溯源处置' }],
      clause: 'CL-TBT2820-5' },
  ],
};

/* 特征命中等级（bands 由小到大，取第一个满足的档） */
function bandLevel(rule, val) {
  if (val == null) return null;
  for (const b of rule.bands) {
    if (b.lt != null) { if (val < b.lt) return b; }
    else return b;
  }
  return rule.bands[rule.bands.length - 1];
}

/* ============================================================================
   三、播种（表空才播种；与 kb.migrateLib 同口径，删后重启不补回）
   ========================================================================== */

function countEntities() { return (db.get('SELECT COUNT(*) AS c FROM kg_entity') || { c: 0 }).c; }
function countRelations() { return (db.get('SELECT COUNT(*) AS c FROM kg_relation') || { c: 0 }).c; }

const D = (x) => JSON.stringify(x);   // props / cond 统一 JSON

function seedIfEmpty() {
  if (countEntities() > 0) {
    return { seeded: false, entities: countEntities(), relations: countRelations(), reason: '非空（优先保留既有图谱，不重复播种）' };
  }
  const ents = [];
  const rels = [];
  const E = (id, etype, name, props, source) => ents.push({ entity_id: id, etype, name, props: props ? D(props) : null, source: source || '', updated_at: new Date().toISOString() });
  const R = (head, rel, tail, weight, cond, source) => rels.push({ head_id: head, rel, tail_id: tail, weight: weight == null ? 1.0 : weight, cond: cond ? D(cond) : null, source: source || '' });

  /* —— 实体 —— */
  TYPES.forEach((t) => E('DT-' + t, 'DefectType', t, { structural: t === '裂缝' || t === '衬砌错台' || t === '剥落掉块' }, 'YOLO 类别对齐'));
  LEVEL_DEF.forEach((l) => E('LV-' + l.lv, 'RiskLevel', l.lv + '级-' + LEVELS[l.lv - 1].split('-')[1],
    { levelText: LEVELS[l.lv - 1], jtg: l.jtg, tb: l.tb, action: l.action, interval: l.interval }, 'JTG H12-2015 / TB/T 2820.2-1997'));
  PART_DEF.forEach((p) => E('SP-' + p[0], 'StructurePart', p[0], { jtgItem: p[1], modifier: p[2] }, 'JTG H12-2015 分项'));
  /* 特征节点（按名称去重） */
  const featSeen = new Set();
  Object.keys(TYPE_FEATURES).forEach((ty) => TYPE_FEATURES[ty].forEach((f) => {
    if (featSeen.has(f[0])) return;
    featSeen.add(f[0]);
    E('FT-' + f[0], 'DefectFeature', f[0], { primary: !!f[1] }, '影像可测 / 现场可测');
  }));
  CAUSES.forEach((c) => E('CS-' + c[1], 'CauseFactor', c[1], { category: c[2], prior: c[3] }, '工程成因分类（教材 / 规范）'));
  HAZARDS.forEach((h) => E('HZ-' + h[0], 'Hazard', h[0], { category: h[1] }, '结构影响分析'));
  MEASURES.forEach((m) => E('RM-' + m[0], 'RepairMeasure', m[0], { window: m[1], brief: m[3] }, m[2]));
  CLAUSES.forEach((c) => E(c[0], 'Clause', c[1], { text: c[2] }, c[1].split(' ')[0]));
  LEVEL_DEF.forEach((l) => E('AC-' + l.action, 'Action', l.action, { interval: l.interval }, 'JTG H12-2015 第 6 章'));

  /* —— 关系：R1 发生于 —— */
  Object.keys(TYPE_PARTS).forEach((ty) => TYPE_PARTS[ty].forEach((p) => R('DT-' + ty, '发生于', 'SP-' + p[0], p[1], null, 'JTG H12-2015 分项')));
  /* R2 典型特征 + R3 判据依据 */
  Object.keys(TYPE_FEATURES).forEach((ty) => TYPE_FEATURES[ty].forEach((f) => {
    R('DT-' + ty, '典型特征', 'FT-' + f[0], f[1] ? 1.0 : 0.4, null, '影像特征');
    const rule = (FEATURE_RULES[ty] || []).find((r) => r.name.replace('（估算）', '') === f[0]);
    if (rule) R('FT-' + f[0], '判据依据', rule.clause, 1.0, { bands: rule.bands.map((b) => b.text) }, rule.clause);
  }));
  /* R4 成因 */
  CAUSES.forEach((c) => R('DT-' + c[0], '成因', 'CS-' + c[1], c[3], c[4] ? { hint: c[4] } : null, '工程成因分析'));
  /* R5 成因 → 危害 */
  Object.keys(CAUSE_HAZARDS).forEach((c) => CAUSE_HAZARDS[c].forEach((h) => R('CS-' + c, '导致', 'HZ-' + h, 1.0, null, '结构影响分析')));
  /* R6 危害 */
  Object.keys(TYPE_HAZARDS).forEach((ty) => TYPE_HAZARDS[ty].forEach((h) => R('DT-' + ty, '危害', 'HZ-' + h, 1.0, null, '结构影响分析')));
  /* R7 等级判定依据 + R11 等级映射 + R10 处置动作 */
  LEVEL_DEF.forEach((l) => {
    (LEVEL_CLAUSES[l.lv] || []).forEach((c) => R('LV-' + l.lv, '判定依据', c, 1.0, null, c));
    (LEVEL_MAP_CLAUSES[l.lv] || []).forEach((c) => R('LV-' + l.lv, '等级映射', c, 1.0, null, c));
    R('LV-' + l.lv, '对应动作', 'AC-' + l.action, 1.0, { interval: l.interval }, 'JTG H12-2015 第 6 章');
  });
  /* R8 对应措施（head=病害类型，cond.level 标明等级门槛）+ R9 引用规范 */
  Object.keys(TYPE_LEVEL_MEASURES).forEach((ty) => Object.keys(TYPE_LEVEL_MEASURES[ty]).forEach((lv) => {
    TYPE_LEVEL_MEASURES[ty][lv].forEach((m) => {
      R('DT-' + ty, '对应措施', 'RM-' + m, 1.0, { level: Number(lv) }, '知识库分级处置');
    });
  }));
  MEASURES.forEach((m) => R('RM-' + m[0], '引用规范', m[2], 1.0, null, m[2]));

  db.run('BEGIN');
  try {
    ents.forEach((e) => db.insert('kg_entity', e));
    rels.forEach((r) => db.insert('kg_relation', r));
    db.run('COMMIT');
  } catch (e) {
    db.run('ROLLBACK');
    throw e;
  }
  return { seeded: true, entities: ents.length, relations: rels.length };
}

/* ============================================================================
   四、查询：实体 / 关系 / 子图 / 统计
   ========================================================================== */

const ALL_ENTITIES = () => db.all('SELECT * FROM kg_entity');
const ALL_RELATIONS = () => db.all('SELECT * FROM kg_relation');

function nodesByIds(ids) {
  const uniq = [...new Set(ids)].filter(Boolean);
  if (!uniq.length) return [];
  const marks = uniq.map(() => '?').join(',');
  return db.all(`SELECT * FROM kg_entity WHERE entity_id IN (${marks})`, ...uniq);
}

/** 关系查询：按头实体（可限定关系名） */
function outEdges(headId, rel) {
  return rel
    ? db.all('SELECT * FROM kg_relation WHERE head_id=? AND rel=?', headId, rel)
    : db.all('SELECT * FROM kg_relation WHERE head_id=?', headId);
}

function parseJson(s, dflt) { try { return s ? JSON.parse(s) : dflt; } catch (e) { return dflt; } }

/**
 * 子图检索：以「病害类型（+等级）」为中心取 2~3 跳子图
 * @param {string} type 病害类型（如 '裂缝'）
 * @param {number} [levelNo] 等级 1~4（缺省则取该类型全部等级的措施）
 * @returns {{nodes:Array, edges:Array, center:string}}
 */
function subgraph(type, levelNo) {
  const edges = [];
  /* 一跳：类型 → 部位/特征/成因/危害/措施。措施先按等级过滤（必须在二跳之前，
     否则其他等级的措施会从"引用规范"这条边二次混入子图）。 */
  outEdges('DT-' + type).forEach((e) => {
    if (e.rel === '对应措施' && levelNo) {
      const c = parseJson(e.cond, {});
      if (c.level && Number(c.level) !== Number(levelNo)) return;
    }
    edges.push(e);
  });
  if (levelNo) outEdges('LV-' + levelNo).forEach((e) => edges.push(e));

  /* 二跳：特征 → 判据条款；成因 → 危害；措施 → 引用规范 */
  const second = [];
  edges.forEach((e) => {
    if (e.rel === '典型特征') second.push(...outEdges(e.tail_id, '判据依据'));
    if (e.rel === '成因') second.push(...outEdges(e.tail_id, '导致'));
    if (e.rel === '对应措施') second.push(...outEdges(e.tail_id, '引用规范'));
  });
  second.forEach((e) => edges.push(e));

  /* 节点集由保留下来的边重建，避免悬空节点 */
  const used = new Set(['DT-' + type]);
  edges.forEach((e) => { used.add(e.head_id); used.add(e.tail_id); });

  return { center: 'DT-' + type, nodes: nodesByIds([...used]), edges: dedupeEdges(edges) };
}

function dedupeEdges(list) {
  const seen = new Set();
  return list.filter((e) => {
    const k = e.head_id + '|' + e.rel + '|' + e.tail_id;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

function stats() {
  const byType = db.all('SELECT etype, COUNT(*) AS n FROM kg_entity GROUP BY etype ORDER BY n DESC');
  const byRel = db.all('SELECT rel, COUNT(*) AS n FROM kg_relation GROUP BY rel ORDER BY n DESC');
  return {
    entities: countEntities(), relations: countRelations(),
    byType: byType.map((r) => ({ etype: r.etype, n: r.n })),
    byRel: byRel.map((r) => ({ rel: r.rel, n: r.n })),
    defectTypes: TYPES, levels: LEVELS,
  };
}

/**
 * 整图：一次取回全部实体与关系（供"全图谱界面"渲染）
 * 规模量级：本图谱 ~120 实体 / ~210 关系，一次传输 <60KB，无需分页。
 * @returns {{nodes:Array, edges:Array, stats:object}}
 */
function fullGraph() {
  const nodes = ALL_ENTITIES().map((e) => ({
    entity_id: e.entity_id, etype: e.etype, name: e.name,
    props: parseJson(e.props, null), source: e.source || '',
  }));
  const edges = ALL_RELATIONS().map((e) => ({
    head_id: e.head_id, rel: e.rel, tail_id: e.tail_id,
    weight: e.weight, cond: parseJson(e.cond, null), source: e.source || '',
  }));
  /* 度数：前端按度数定节点半径（枢纽一眼可见） */
  const deg = {};
  edges.forEach((e) => { deg[e.head_id] = (deg[e.head_id] || 0) + 1; deg[e.tail_id] = (deg[e.tail_id] || 0) + 1; });
  nodes.forEach((n) => { n.degree = deg[n.entity_id] || 0; });
  return { nodes, edges, stats: { entities: nodes.length, relations: edges.length, types: TYPES, levels: LEVELS } };
}

/* ============================================================================
   五、闭环推理：一条病害记录 → 等级依据 / 成因 / 危害 / 措施
   ========================================================================== */

/* 部位修正：拱顶与拱腰从严（与规范"拱部从严"的工程习惯一致，属可解释的先验规则） */
function partModifier(rec) {
  const sector = (rec.position && rec.position.sector) || '';
  const out = [];
  if (/拱顶/.test(sector)) out.push({ text: '拱顶部位从严：落物风险与受力关键', delta: 0 });
  else if (/拱腰/.test(sector)) out.push({ text: '拱腰部位从严：偏压敏感', delta: 0 });
  if (rec.subtype && /涌水|成线|滴水/.test(String(rec.subtype))) out.push({ text: '渗漏形态偏重（滴水/涌水）', delta: 1 });
  return out;
}

/* 成因证据：用可得的记录字段给出"为什么怀疑这个成因" */
function causeEvidence(causeName, rec, type) {
  const sector = (rec.position && rec.position.sector) || '';
  const b = BBOX_OF(rec);
  const aspect = b && b[3] > 0 ? +(b[2] / b[3]).toFixed(2) : null;
  const vertical = aspect != null && aspect < 0.5;      // 细长且竖向 → 纵向裂缝
  const map = {
    '围岩偏压或不均匀围岩压力': vertical ? `纵向裂缝（长宽比 ${aspect}）多与偏压或不均匀围岩压力有关` : '纵向裂缝、偏压段常见',
    '衬砌背后空洞或回填不密实': '衬砌背后空洞可由雷达检测确认，浇筑回填不实为常见成因',
    '混凝土干缩与温度收缩': '环向或网状细裂缝、非受力方向发展者常见',
    '冻胀力作用（寒冷地区）': '洞口段、寒季扩展的裂缝多与冻胀有关',
    '钢筋锈蚀膨胀（顺筋裂缝）': '顺钢筋走向的裂缝、缝侧见锈迹',
    '地基不均匀沉降': '沉降缝两侧错动、洞身纵向不均匀变形',
    '防水板破损或搭接不良': '渗漏呈面状而非线性分布时优先怀疑防水板',
    '施工缝 / 变形缝止水带失效': '沿施工缝呈线性渗漏、分布规律性强',
    '衬砌裂缝形成渗水通道': '渗漏位置与既有裂缝位置重合',
    '排水系统堵塞（盲管、中央排水管）': '洞内潮湿、边墙下部渗水，伴排水沟水量异常',
    '地下水位上升或降雨补给': '渗漏量随季节/降雨变化',
    '衬砌混凝土抗渗不足、密实度不够': '渗漏呈大面积慢渗、无明确通道',
    '保护层不足伴钢筋锈蚀膨胀': '剥落处见锈迹或露筋',
    '混凝土碳化与冻融循环': '表层起皮剥落、部位处于潮湿或冻融区间',
    '施工质量缺陷（蜂窝麻面、振捣不密实）': '剥落处可见蜂窝麻面等原始缺陷',
    '衬砌受压区压溃（偏压、围岩压力过大）': '拱部碎裂状剥落并伴压溃特征',
    '地基或围岩不均匀沉降': '错台多出现在沉降缝、衬砌接头位置',
    '偏压导致衬砌受扭': '错台伴衬砌转动、单侧受力迹象',
    '施工缝 / 沉降缝错位': '错台沿缝分布、两侧衬砌面平行错动',
    '渗漏通道存在（Ca(OH)₂ 溶出生成 CaCO₃）': '白色结垢析出即为渗漏通道的直接表征',
    '衬砌混凝土孔隙率大、密实度不足': '析出范围分散、衬砌表面孔隙明显',
  };
  return map[causeName] || (sector ? `记录位置：${sector}；部位与成因相关性由现场复核确认` : '需现场复核确认');
}

/**
 * 闭环推理
 * @param {object} rec 病害台账记录（store.getDefect 返回结构）
 * @returns {object} 结构化结论（见文件头注释）
 */
function explain(rec) {
  const type = rec && rec.type;
  if (!type || TYPES.indexOf(type) < 0) {
    const e = new Error('未知病害类型：' + type + '（图谱仅覆盖 ' + TYPES.join('/') + '）');
    e.status = 400;
    throw e;
  }
  const levelNo = rec.levelNo || (String(rec.level || '').match(/^(\d)/) ? Number(RegExp.$1) : 0) || 1;
  const sector = (rec.position && rec.position.sector) || '';

  /* ① 特征量化对照（阈值来自条款；记录里没有的量标 needField，不硬凑数值） */
  const features = (FEATURE_RULES[type] || []).map((r) => {
    const val = r.get(rec);
    const hit = bandLevel(r, val);
    return {
      name: r.name, unit: r.unit, value: val,
      estimated: val != null && /估算/.test(r.name),
      threshold: hit ? hit.text : r.bands.map((b) => b.text).join(' / '),
      levelByThreshold: hit ? hit.lv : null,
      clause: r.clause,
      needField: !!r.needField && val == null,
    };
  });

  /* ② 等级依据（本条记录的判据文本 + 条款）+ 阈值复核 */
  const kbRow = kb.getRow(type, levelNo) || {};
  const byThreshold = features.filter((f) => f.levelByThreshold).map((f) => f.levelByThreshold);
  const ruleLevel = byThreshold.length ? Math.max(...byThreshold) : null;
  const levelBasis = {
    level: levelNo, text: LEVELS[levelNo - 1],
    jtg: (LEVEL_DEF[levelNo - 1] || {}).jtg, tb: (LEVEL_DEF[levelNo - 1] || {}).tb,
    criterion: kbRow.standard_basis || '',
    clauses: (LEVEL_CLAUSES[levelNo] || []).concat(kbRow.standard_basis ? [] : []),
    thresholdReview: ruleLevel == null ? { status: 'unknown', note: '本条记录缺少可量化特征，定级依据来自检测链路' }
      : { status: ruleLevel === levelNo ? 'consistent' : 'differs', ruleLevel, note: ruleLevel === levelNo ? '与阈值命中等级一致' : '阈值命中等级为 ' + ruleLevel + ' 级，建议人工复核' },
  };

  /* ③ 成因排序（图谱先验权重 × 证据可得性） */
  const causes = outEdges('DT-' + type, '成因')
    .map((e) => {
      const n = db.get('SELECT name, props FROM kg_entity WHERE entity_id=?', e.tail_id) || {};
      const props = parseJson(n.props, {});
      return {
        name: n.name || e.tail_id.replace(/^CS-/, ''), category: props.category || '', prior: e.weight,
        evidence: causeEvidence(n.name || '', rec, type),
        hint: (parseJson(e.cond, {}) || {}).hint || '',
        source: e.source || '',
      };
    })
    .sort((a, b) => b.prior - a.prior)
    .slice(0, 3);

  /* ④ 结构危害 */
  const hazards = outEdges('DT-' + type, '危害').map((e) => {
    const n = db.get('SELECT name, props FROM kg_entity WHERE entity_id=?', e.tail_id) || {};
    return { name: n.name || e.tail_id.replace(/^HZ-/, ''), category: parseJson(n.props, {}).category || '' };
  });

  /* ⑤ 维修方案：图谱给措施与依据条款，处置文案读知识库（避免两处真值） */
  const planList = Array.isArray(kbRow.planList) ? kbRow.planList : String(kbRow.repair_plan || '').split('；').filter(Boolean);
  const treatments = outEdges('DT-' + type, '对应措施')
    .filter((e) => { const c = parseJson(e.cond, {}); return !c.level || Number(c.level) === Number(levelNo); })
    .map((e, i) => {
      const n = db.get('SELECT name, props, source FROM kg_entity WHERE entity_id=?', e.tail_id) || {};
      const props = parseJson(n.props, {});
      const cl = outEdges(e.tail_id, '引用规范').map((x) => x.tail_id);
      return {
        name: n.name || e.tail_id.replace(/^RM-/, ''), window: props.window || '', brief: props.brief || '',
        plan: planList[i] || planList[0] || '', clause: cl[0] || n.source || '',
      };
    });

  /* ⑥ 置信度闸：低置信只给"疑似 + 人工复核" */
  const conf = typeof rec.confidence === 'number' ? rec.confidence : null;
  const gate = conf != null && conf < fusion.DETECT_THRESHOLD
    ? { status: 'review', note: '置信度 ' + conf.toFixed(2) + ' 低于阈值 ' + fusion.DETECT_THRESHOLD + '，建议人工复核后再定级' }
    : { status: 'pass', note: '' };

  /* ⑦ 实例层虚拟节点 + 子图（供前端画图，不落库） */
  const sg = subgraph(type, levelNo);
  const instId = 'IN-' + (rec.id || 'current');
  sg.nodes.push({
    entity_id: instId, etype: 'Detection', name: '本条检测实例',
    props: D({ confidence: conf, chainage: (rec.position && rec.position.chainage) || '', sector, source: rec.source || '' }),
    source: 'detection 实例层',
  });
  sg.edges.push({ head_id: instId, rel: '识别为', tail_id: 'DT-' + type, weight: conf == null ? 1 : conf, cond: null, source: 'YOLO 输出' });
  sg.edges.push({ head_id: instId, rel: '定级为', tail_id: 'LV-' + levelNo, weight: 1, cond: null, source: '检测链路 + 阈值复核' });
  if (sector && SECTORS.indexOf(sector) >= 0) {
    sg.edges.push({ head_id: instId, rel: '属于', tail_id: 'SP-' + sector, weight: 1, cond: null, source: '检测位置' });
  }

  return {
    defectId: rec.id, type, subtype: rec.subtype || '', levelNo, levelText: LEVELS[levelNo - 1],
    position: rec.position || {}, confidence: conf,
    features, levelBasis, modifiers: partModifier(rec),
    causes, hazards, treatments,
    action: kbRow.action || (LEVEL_DEF[levelNo - 1] || {}).action || '',
    interval: kbRow.interval || (LEVEL_DEF[levelNo - 1] || {}).interval || '',
    decision: rec.decision || '', review: rec.review || null, status: rec.status || '',
    gate, subgraph: sg,
    note: '等级由检测链路给出；图谱负责依据条款、成因、危害、措施与阈值复核，不改写等级',
  };
}

/**
 * 标准溯源数据（前端「规范依据显性化」数据源）：
 *   clauses       —— 规范条款库（id/名称/条款原文摘要），供悬浮徽章取摘要
 *   levelMap      —— 系统等级 → JTG H12 技术状况类别 / TB 劣化等级 / 处置动作 / 复查周期
 *   levelClauses  —— 系统等级 → 判级依据条款 id（判级口径，TB/T 2820.2 系列）
 *   levelMapClauses —— 系统等级 → 等级映射条款 id（JTG H12 §4.5 / §4.5.4 / §4.5.5 / 第 6 章）
 */
function standards() {
  return {
    clauses: CLAUSES.map(([id, name, summary]) => ({ id, name, summary })),
    levelMap: LEVEL_DEF.map((l) => ({ lv: l.lv, levelText: LEVELS[l.lv - 1], jtg: l.jtg, tb: l.tb, action: l.action, interval: l.interval })),
    levelClauses: LEVEL_CLAUSES,
    levelMapClauses: LEVEL_MAP_CLAUSES,
  };
}

module.exports = {
  seedIfEmpty, subgraph, explain, stats, fullGraph,
  countEntities, countRelations, standards,
  ALL_ENTITIES, ALL_RELATIONS,
  TYPES, LEVELS, CAUSES, CLAUSES, MEASURES,
};
