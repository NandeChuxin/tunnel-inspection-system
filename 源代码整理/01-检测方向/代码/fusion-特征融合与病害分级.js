/**
 * fusion.js — 多源异构数据融合病害识别引擎（V2：知识驱动判别模型）
 *
 * 病害知识库（依据《公路隧道养护技术规范》JTG H12 及行业实践归纳）：
 *
 *  ① 衬砌裂缝（纵向/环向/斜向）
 *     影像特征：细长线状结构、走向连续、缝缘平直、非面状；
 *     判别要素：细长比(elongation)大、线状直线性(linearity)高、
 *              边缘密度高但暗色面占比低、纹理随机性低；
 *     分级：按缝宽(mm)与长度(m)，纵向裂缝受力最不利从严一级。
 *
 *  ② 渗漏水（湿渍/渗水/涌水）
 *     影像特征：深色湿渍、边界模糊扩散、内部低纹理、面积大；
 *     判别要素：暗色占比高 + 边缘密度低 + 纹理平滑（区别于剥落的粗糙）；
 *     分级：按面积与部位（拱顶/拱腰渗漏从严），涌水直接危及安全。
 *
 *  ③ 剥落掉块（起皮/剥落/掉块）
 *     影像特征：面状粗糙、凹凸纹理强、边缘不规则、明暗混杂；
 *     判别要素：纹理方差高 + 边缘密度中高 + 填充率中等（非细线非大暗斑）；
 *     分级：按面积与部位，拱部掉块危及行车从严。
 *
 *  ④ 衬砌错台（环向/纵向）
 *     影像特征：线状台阶、光影突变（负色度偏移）；
 *     判别要素：断面差传感器(gapmm)直接证据 + 水平线状边缘；
 *     分级：按错台量 mm。
 *
 *  ⑤ 白华析出（钙质析出）
 *     影像特征：高亮白色粉末/挂帘、沿渗水路径分布、内部纹理平滑；
 *     判别要素：高亮占比高 + 暗色低 + 边缘低；
 *     分级：本身轻微（1~2级），但指示渗水通道，建议溯源处置。
 *
 * 物理标定：视场宽度按隧道断面常见净宽 3.5m 换算 mm/px，
 *          裂缝缝宽/长度、渗漏/剥落面积均按标定换算物理量后分级。
 */

const DEFECT_TYPES = ['裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出'];
const LEVELS = ['1级-轻微', '2级-中等', '3级-严重', '4级-危及安全'];
const VIEW_WIDTH_M = 3.5; // 标定：单帧影像视场宽（m）

const SECTORS = ['拱顶', '左拱腰', '右拱腰', '左边墙', '右边墙', '仰拱'];

// ------------------- 整治建议措施库（类型 × 等级） -------------------
const SUGGESTION_LIB = {
  '裂缝': {
    '1级-轻微': ['表面封闭：沿裂缝涂刷环氧树脂封闭剂，防止水分侵入与钢筋锈蚀'],
    '2级-中等': ['低压注浆：环氧/聚氨酯注浆填充，注浆后贴嘴复查饱满度', '设置裂缝观测标，跟踪缝宽发展速率'],
    '3级-严重': ['凿槽嵌缝：沿缝凿 V 形槽嵌入柔性止水材料，跨缝补强', '查明裂缝成因（偏压/冻胀/收缩），对症处治', '加密监测，缝宽持续发展时升级处治'],
    '4级-危及安全': ['立即限行并上报，防范衬砌失稳', '委托专业机构开展结构安全评估', '按评估结论实施套衬加固或换衬'],
  },
  '渗漏水': {
    '1级-轻微': ['清理湿渍范围，局部涂刷防水涂层并观察'],
    '2级-中等': ['引排结合：埋设半圆排水管导入排水系统', '渗水面注浆封堵（聚氨酯/水泥-水玻璃）'],
    '3级-严重': ['系统堵排：钻孔回填注浆 + 环向排水盲管改造', '排查中央排水管通畅性，必要时更换'],
    '4级-危及安全': ['立即封道排查，防范涌水突泥', '开展水文地质补充勘察，制定专项治水方案'],
  },
  '剥落掉块': {
    '1级-轻微': ['清除松动起皮层，涂刷界面剂修补'],
    '2级-中等': ['凿除空鼓层后聚合物砂浆修补', '修补范围注浆填充密实'],
    '3级-严重': ['挂网喷锚加固', '施作钢拱架临时支撑并纳入变形监测'],
    '4级-危及安全': ['立即限行清障，防范落物伤车', '落实防护措施（防护网/棚）后专项处置'],
  },
  '衬砌错台': {
    '1级-轻微': ['标记观测点，纳入季度变形观测'],
    '2级-中等': ['错台部位注浆回填密实', '设置监测断面按月观测'],
    '3级-严重': ['径向注浆加固围岩-衬砌间隙', '施作钢带锚杆约束错台发展'],
    '4级-危及安全': ['立即限行', '开展限界与结构安全专项评估，实施套衬或换衬'],
  },
  '白华析出': {
    '1级-轻微': ['铲除析出物，涂刷防水剂封闭渗水通道'],
    '2级-中等': ['溯源封堵：沿渗水路径注浆封堵后恢复表面', '纳入渗漏观测点跟踪'],
    '3级-严重': ['系统排查渗水通道并注浆封堵', '检查钢筋锈蚀风险，必要时耐磨防碳化处理'],
    '4级-危及安全': ['按渗漏 4 级流程紧急处置并评估结构安全'],
  },
};

const DETECT_THRESHOLD = 0.55; // 类型置信度阈值
const ARB_TAU = 0.75;          // P3-3 双引擎仲裁：学习引擎置信度 ≥ 此值直接采信，低于则与规则引擎取优

// W4：知识库建议“查表”注入点。运行态（server.js 启动后）由 kb.js 注入 DB 查表函数，
// 使诊断决策层生成建议时读取 knowledge_base 表数据（教师可在线维护），不再读取代码常量；
// 离线单元测试/未注入场景回退内置常量，保证 W0~W3 回归与迁移前行为一致。
let _suggestionResolver = null;
function setSuggestionResolver(fn) { _suggestionResolver = typeof fn === 'function' ? fn : null; }

// —— 可训练分类器注入点（数据驱动训练轮） ——
// 训练脚本产出 backend/data/model_params.json 后，由 server.js 启动时经 setClassifier 注入；
// 未注入时 analyze 走内置知识规则（classifyROI），行为与本轮改造前完全一致（回归安全）。
// 注入函数契约：fn(roiFeatures, sensorEvidence) -> { type, confidence, probs }
//   type=类名（'背景'/null 表示无病害候选），confidence∈[0,1] 作为该 ROI 的判别置信度。
let _classifier = null;
function setClassifier(fn) { _classifier = typeof fn === 'function' ? fn : null; }
function getClassifier() { return _classifier; }

/** 取某类型×等级的建议列表（resolver 注入后以查表结果为准；未注入回退内置常量库） */
function suggestionsOf(type, levelNo) {
  const lv = Math.min(4, Math.max(1, Number(levelNo) || 1));
  if (_suggestionResolver) {
    const r = _suggestionResolver(type, lv);
    return Array.isArray(r) ? r : [];
  }
  const lib = SUGGESTION_LIB[type];
  return (lib && lib[LEVELS[lv - 1]]) || [];
}

// ------------------- 传感器证据 -------------------
function buildSensorEvidence(sensors) {
  const s = sensors || {};
  const hum = s.humidity ?? 60;
  const vib = s.vibration ?? 0;
  const gap = s.gapmm ?? 0;
  return {
    '裂缝': clamp((vib > 0.55 ? 0.2 : 0.04) + (s.temperature < 5 ? 0.1 : 0.02)),
    '渗漏水': clamp(Math.max(0, (hum - 55) / 45) * 0.75),
    '剥落掉块': clamp(vib > 0.6 ? vib * 0.7 : vib * 0.2),
    '衬砌错台': clamp(gap > 3 ? Math.min(0.9, gap / 15) : gap / 40),
    '白华析出': clamp(Math.max(0, (hum - 70) / 30) * 0.3),
  };
}

/**
 * 知识驱动判别：对单个 ROI 依病害知识逐类打分，门控条件模拟专家判读
 * f: ROI 特征（含形状/走向/亮度等判别特征）
 */
function classifyROI(f, sensorEv) {
  const elong = f.elongation ?? 1;          // 细长比 ≥1
  const lin = f.linearity ?? 0.5;           // 线状直线性 0~1
  const fill = f.fillRatio ?? 0.5;          // 前景填充率 0~1
  const bright = f.brightRatio ?? 0;        // 高亮占比 0~1
  const gap = (f._gapmm ?? 0);

  const lineShape = clamp((elong - 1.6) / 3.5);      // 细长程度归一
  // P0-1：细尺度候选（fromFine）放宽线状门控（2.0/0.6），换取细裂缝召回；无粗尺度佐证时置信度补偿性下调
  const isLine = elong >= (f.fromFine ? 2.0 : 2.5) || lin >= (f.fromFine ? 0.6 : 0.7);
  const isBlob = fill >= 0.45 && elong < 3.5;        // 面状门控

  const scores = {
    // 裂缝：线状 + 高边缘 + 非暗斑 + 纹理不粗糙
    '裂缝': clamp(
      f.edgeDensity * 0.38 + lineShape * 0.32 + lin * 0.15 +
      (1 - f.darkRatio) * 0.10 + (1 - f.textureVar) * 0.05 + sensorEv['裂缝'] * 0.05
    ),
    // 渗漏：暗斑 + 边缘弱 + 纹理平滑（湿渍边界扩散、内部均质）
    '渗漏水': clamp(
      f.darkRatio * 0.52 + (1 - f.edgeDensity) * 0.18 + (1 - f.textureVar) * 0.15 +
      (isBlob ? 0.08 : 0) + sensorEv['渗漏水'] * 0.10
    ),
    // 剥落：强纹理 + 中高边缘 + 明暗混杂 + 面状形态
    '剥落掉块': clamp(
      f.textureVar * 0.55 + f.edgeDensity * 0.20 +
      (f.darkRatio > 0.12 && f.darkRatio < 0.6 ? 0.12 : 0) +
      (f.brightRatio > 0.08 && f.darkRatio > 0.12 ? 0.08 : 0) +
      ((f.fillRatio ?? 0) > 0.45 && (f.elongation ?? 1) < 3.5 ? 0.06 : 0) + sensorEv['剥落掉块'] * 0.10
    ),
    // 错台：断面差直接证据 + 光影突变/水平线状
    '衬砌错台': clamp(
      Math.min(1, gap / 12) * 0.55 + Math.max(0, -f.hueShift) * 0.20 +
      (f.orientation === 'horizontal' ? f.edgeDensity * 0.15 : 0) + sensorEv['衬砌错台'] * 0.10
    ),
    // 白华：高亮 + 非暗 + 边缘弱
    '白华析出': clamp(
      bright * 0.62 + (1 - f.darkRatio) * 0.16 + (1 - f.edgeDensity) * 0.12 +
      sensorEv['白华析出'] * 0.10
    ),
  };

  // 知识门控：不符合病害形态学的候选压制
  if (!isLine) scores['裂缝'] *= 0.4;                        // 非线状几乎不判裂缝
  if (f.darkRatio < 0.45) scores['渗漏水'] *= 0.5;           // 无明显暗斑不判渗漏
  if (f.textureVar < 0.4) scores['剥落掉块'] *= 0.5;         // 表面不粗糙不判剥落
  if (bright < 0.35) scores['白华析出'] *= 0.4;              // 无高亮区不判白华
  if (f.darkRatio > 0.45) scores['白华析出'] *= 0.4;         // 明显暗斑与白华互斥
  if (f.textureVar > 0.5) scores['白华析出'] *= 0.4;         // 白华为平滑粉末附着，与粗糙剥落面互斥
  if (gap < 3 && f.orientation !== 'horizontal') scores['衬砌错台'] *= 0.3;

  let best = null, second = 0;
  for (const t of DEFECT_TYPES) {
    if (!best || scores[t] > scores[best]) { second = scores[best] ?? 0; best = t; }
    else if (scores[t] > second) second = scores[t];
  }
  // 置信度 = 绝对分 × 判别裕度（第一、二名差距）
  const margin = clamp((scores[best] - second) / Math.max(0.15, scores[best]));
  let confidence = clamp(scores[best] * (0.7 + 0.3 * margin));
  if (f.fromFine && !f.multiScaleHit) confidence *= 0.9; // P0-1：细尺度无粗尺度佐证 → 置信度补偿
  return { type: best, score: scores[best], confidence, margin, scores };
}

/** 亚型与物理量标定 */
function mmPerPx(imageW) { return (VIEW_WIDTH_M * 1000) / (imageW || 640); }

function subtypeOf(type, f, ctx) {
  if (type === '裂缝') {
    if (f.orientation === 'horizontal') return '纵向裂缝';
    if (f.orientation === 'vertical') return '环向裂缝';
    return '斜向裂缝';
  }
  if (type === '渗漏水') {
    if ((ctx.sensors?.humidity ?? 0) > 88 && f.darkRatio > 0.8) return '涌水';
    if (f.darkRatio > 0.65) return '渗水';
    return '湿渍';
  }
  if (type === '剥落掉块') {
    const areaM2 = (f.widthPx * ctx.mmPx * f.lengthPx * ctx.mmPx) / 1e6;
    return areaM2 >= 0.2 ? '掉块' : '表层剥落';
  }
  if (type === '衬砌错台') return '环向错台';
  if (type === '白华析出') return '钙质析出';
  return '';
}

/**
 * 加权中位数定级（P1-3 多证据融合）：等级是序数量，取加权平均会出现"3级与4级平均得
 * 3.5级"这类无物理意义的中间值；加权中位数天然落在合法等级集合内，且对单个异常证据不敏感。
 * 权重放大 10 倍取整后按权重展开排序取中位。
 * @param {Array<{name:string, level:number, w:number}>} evidence 证据列表（level∈1..4）
 * @returns {number|null} 融合等级（无有效证据时 null）
 */
function weightedMedianLevel(evidence) {
  const expanded = [];
  for (const ev of evidence || []) {
    if (!ev || ev.level == null) continue;
    const w = Math.max(1, Math.round(ev.w * 10));
    for (let i = 0; i < w; i++) expanded.push(ev.level);
  }
  if (!expanded.length) return null;
  expanded.sort((a, b) => a - b);
  return expanded[expanded.length >> 1];
}

/** 由长度（m）分档（裂缝：1.2 / 4 / 8 m，与规范分级一致） */
function lvByLenM(lenM) { return lenM >= 8 ? 4 : lenM >= 4 ? 3 : lenM >= 1.2 ? 2 : 1; }

/** 规范化分级（按标定物理量 + 部位修正；P1-3 起支持掩码实测证据的多证据加权中位数融合） */
function gradeDefect(type, f, ctx) {
  const crown = ['拱顶', '左拱腰', '右拱腰'].includes(ctx.sector); // 拱部从严
  const mmPx = ctx.mmPx;
  const areaM2 = (f.widthPx * mmPx * f.lengthPx * mmPx) / 1e6;
  const m = ctx.maskEvid || null; // P1-3：掩码实测证据 {length_mm, area_mm2, consistency, instances}
  let lv = 1;
  switch (type) {
    case '裂缝': {
      // 单帧影像分辨率下缝宽不可靠，以裂缝长度为主要分级依据（长度与缝宽正相关）
      const lenM = (Math.max(f.widthPx, f.lengthPx) * mmPx) / 1000;
      const evidence = [{ name: 'bbox长度', level: lvByLenM(lenM), w: 1.0 }];
      let lenMUse = lenM;
      if (m && m.length_mm > 0) {
        // 掩码凸包直径反映断续裂缝整体延展，比 bbox 更可靠 → 权重更高（1.5）
        const maskLenM = m.length_mm / 1000;
        evidence.push({ name: '掩码凸包长度', level: lvByLenM(maskLenM), w: 1.5 });
        lenMUse = Math.max(lenM, maskLenM);
      }
      lv = weightedMedianLevel(evidence) ?? 1;
      ctx.fusionEvidence = evidence; // 供可解释性输出（infer 端回填 basis）
      if (ctx.subtype === '纵向裂缝' && lv < 4) lv += 1; // 纵向（轴向受力最不利）从严一级
      ctx.physical = { 长度: `${lenMUse.toFixed(1)}m`, 走向: ctx.subtype };
      if (m && m.length_mm > 0) ctx.physical.掩码实测长度 = `${(m.length_mm / 1000).toFixed(1)}m`;
      break;
    }
    case '渗漏水': {
      if (ctx.subtype === '涌水') { lv = 4; break; }
      const evidence = [{ name: 'bbox面积', level: areaM2 >= 2 ? 3 : areaM2 >= 0.5 ? 2 : 1, w: 1.0 }];
      let areaUse = areaM2;
      if (m && m.area_mm2 > 0) {
        const maskA2 = m.area_mm2 / 1e6;
        evidence.push({ name: '掩码面积', level: maskA2 >= 2 ? 3 : maskA2 >= 0.5 ? 2 : 1, w: 1.2 });
        areaUse = Math.max(areaM2, maskA2);
      }
      lv = weightedMedianLevel(evidence) ?? 1;
      // 拱部从严阈值独立复核（bbox/掩码取大后统一判定）
      if (crown && areaUse >= 0.8) lv = Math.max(lv, 3);
      else if (crown && areaUse >= 0.2) lv = Math.max(lv, 2);
      ctx.fusionEvidence = evidence;
      ctx.physical = { 面积: `${areaUse.toFixed(2)}m²`, 部位: crown ? '拱部(从严)' : '边墙/仰拱' };
      break;
    }
    case '剥落掉块': {
      const evidence = [{ name: 'bbox面积', level: areaM2 >= 1.5 ? 4 : areaM2 >= 0.5 ? 3 : areaM2 >= 0.1 ? 2 : 1, w: 1.0 }];
      let areaUse = areaM2;
      if (m && m.area_mm2 > 0) {
        const maskA2 = m.area_mm2 / 1e6;
        evidence.push({ name: '掩码面积', level: maskA2 >= 1.5 ? 4 : maskA2 >= 0.5 ? 3 : maskA2 >= 0.1 ? 2 : 1, w: 1.2 });
        areaUse = Math.max(areaM2, maskA2);
      }
      lv = weightedMedianLevel(evidence) ?? 1;
      if (crown && areaUse >= 0.5) lv = Math.max(lv, 4);
      else if (crown && areaUse >= 0.15) lv = Math.max(lv, 3);
      else if (crown) lv = Math.max(lv, 2);
      ctx.fusionEvidence = evidence;
      ctx.physical = { 面积: `${areaUse.toFixed(2)}m²`, 部位: crown ? '拱部(从严)' : '边墙/仰拱' };
      break;
    }
    case '衬砌错台': {
      // 断面差以传感器实测为权威证据（图像内断面差估计当前无独立测量，暂不引入 0.8 权证据）
      const gap = f._gapmm ?? 0;
      lv = gap >= 15 ? 4 : gap >= 8 ? 3 : gap >= 3 ? 2 : 1;
      ctx.physical = { 错台量: `${gap}mm` };
      break;
    }
    case '白华析出': {
      const evidence = [{ name: 'bbox面积', level: areaM2 >= 1 ? 2 : 1, w: 1.0 }];
      if (m && m.area_mm2 > 0) {
        evidence.push({ name: '掩码面积', level: m.area_mm2 / 1e6 >= 1 ? 2 : 1, w: 1.2 });
      }
      lv = weightedMedianLevel(evidence) ?? 1;
      ctx.fusionEvidence = evidence;
      ctx.physical = { 面积: `${areaM2.toFixed(2)}m²` };
      break;
    }
  }
  return Math.min(4, lv);
}

/**
 * P1-3 证据融合重定级：掩码实测完成后，用「bbox + 掩码」多证据加权中位数复核等级。
 * 由 infer.detectImage 在 maskSeg.extract 之后调用；等级变化时同步回填 physical 并留痕。
 * @param {object} det fusion 检测对象（{type, subtype, levelNo, level, position:{bbox,sector}}）
 * @param {{mask:object, mmPx:number, imageW:number, imageH:number}} opt
 * @returns {object} 原 det（可能已更新 levelNo/level/physical/evidenceFusion）
 */
function regradeWithEvidence(det, opt) {
  if (!det || !opt || !opt.mask || !det.position || !det.position.bbox) return det;
  const bb = det.position.bbox;
  const wPx = Math.min(bb[2] * (opt.imageW || 640), bb[3] * (opt.imageH || 640));
  const lPx = Math.max(bb[2] * (opt.imageW || 640), bb[3] * (opt.imageH || 640));
  const f = { widthPx: wPx, lengthPx: lPx };
  const ctx = { sector: det.position.sector, subtype: det.subtype, mmPx: opt.mmPx, maskEvid: opt.mask };
  const lv = gradeDefect(det.type, f, ctx);
  det.evidenceFusion = ctx.fusionEvidence || null;
  if (lv !== det.levelNo) {
    det._regraded = { from: det.levelNo, to: lv, method: 'mask-evidence-fusion' };
    det.levelNo = lv;
    det.level = LEVELS[lv - 1];
    det.physical = ctx.physical;
    // 等级变化 → 处置建议按新等级重查（与 knowledge_base 查表层保持一致）
    det.suggestions = suggestionsOf(det.type, lv);
  } else if (ctx.physical) {
    det.physical = { ...det.physical, ...ctx.physical };
  }
  return det;
}

/** 判定依据（可解释性输出） */
function explain(type, f) {
  const elong = (f.elongation ?? 1).toFixed(1);
  const items = [];
  if (type === '裂缝') {
    items.push(`细长线状结构（长宽比 ${elong}、直线性 ${(f.linearity ?? 0.5).toFixed(2)}）`);
    items.push(`边缘梯度显著而暗色面占比低（边缘 ${f.edgeDensity.toFixed(2)} / 暗色 ${f.darkRatio.toFixed(2)}）`);
  } else if (type === '渗漏水') {
    items.push(`深色湿渍区域（暗色占比 ${f.darkRatio.toFixed(2)}）`);
    items.push(`边界扩散、内部纹理平滑（边缘 ${f.edgeDensity.toFixed(2)} / 纹理 ${f.textureVar.toFixed(2)}）`);
  } else if (type === '剥落掉块') {
    items.push(`面状粗糙、凹凸纹理强（纹理方差 ${f.textureVar.toFixed(2)}）`);
    items.push(`明暗混杂、边缘不规则（边缘 ${f.edgeDensity.toFixed(2)}、暗色 ${f.darkRatio.toFixed(2)}）`);
  } else if (type === '衬砌错台') {
    items.push(`断面差传感器实测 ${f._gapmm}mm`);
    items.push(`光影突变（色度偏移 ${f.hueShift.toFixed(2)}）`);
  } else if (type === '白华析出') {
    items.push(`高亮白色析出物（高亮占比 ${(f.brightRatio ?? 0).toFixed(2)}）`);
    items.push('沿渗水路径分布特征');
  }
  return items;
}

/**
 * 主入口：对一帧多源数据执行完整识别管线
 *
 * 输入：
 *   frame  - 帧数据包 { id?, tunnel?, mileage?, sensors?, timestamp?, image:{widthPx?, rois:[]} }
 *   opts   - （可选）推理参数。W0 起支持参数化：
 *            { threshold: 类型置信度阈值(0~1) }，缺省沿用模块常量 DETECT_THRESHOLD(=0.55)，
 *            保证旧调用（不传 opts）行为与改造前完全一致。
 *            IoU/NMS 与图像预处理（CLAHE/高斯/Canny/Otsu）参数在 infer.js/vision.js 层处理，
 *            本模块聚焦特征→融合→分级，保持单一职责。
 * 输出：
 *   { frameId, analyzedAt, threshold, detections }（返回结构不变，threshold 随参数或默认值）
 */
function analyze(frame, opts) {
  const threshold = opts && typeof opts.threshold === 'number' ? opts.threshold : DETECT_THRESHOLD;
  const imgFeat = frame.image.rois || [];
  const sensorEv = buildSensorEvidence(frame.sensors);
  const mmPx = mmPerPx(frame.image.widthPx);

  const detections = [];
  for (const raw of imgFeat) {
    // 特征兜底：客户端/车载端漏传特征字段时不崩（500→按缺省特征低分丢弃），合法输入不受影响
    const f = normalizeFeatures(raw);
    const roiCtx = { ...f, _gapmm: frame.sensors?.gapmm ?? 0 };
    // 分类（P3-3 双引擎置信度仲裁）：注入训练模型时学习引擎优先。
    //   ① 学习置信度 ≥ ARB_TAU → 直接采信；
    //   ② 学习判为病害但落入模糊带（< ARB_TAU）→ 允许规则引擎在**病害类型之间**改判
    //      （规则分更高时），修正暗斑/裂缝相邻等混合形态的类型混淆；
    //   ③ 学习判为背景 → 不复活（保留学习引擎的误报抑制能力，规则 FP 不回潮）。
    let cand;
    if (_classifier) {
      const learned = learnedCand(roiCtx, sensorEv);
      if (learned.score >= ARB_TAU) {
        cand = learned;
      } else if (learned.type && learned.score > 0) {
        const ruled = classifyROI(roiCtx, sensorEv);
        cand = ruled.score > learned.score ? ruled : learned;
      } else {
        cand = learned; // 背景：保持抑制
      }
    } else {
      cand = classifyROI(roiCtx, sensorEv);
    }
    if (cand.score < threshold) continue;

    const meter = (frame.mileage ?? 0) + (f.bbox[0] * 2);
    const sector = sectorOf(f.angle);
    const subtype = subtypeOf(cand.type, f, { sensors: frame.sensors, mmPx });
    const gctx = { sensors: frame.sensors, mmPx, sector, subtype };
    // 等级：训练模型带等级子模型输出时用之，否则按规范物理量分级（gradeDefect）
    // 注意：必须传 roiCtx（含 _gapmm 断面差）。传 f 会丢失传感器错台量 → 错台等级恒为 1 级。
    const lvRule = gradeDefect(cand.type, roiCtx, gctx);
    const lv = cand.level >= 1 && cand.level <= 4 ? Math.round(cand.level) : lvRule;

    detections.push({
      type: cand.type,
      subtype,
      level: LEVELS[lv - 1],
      levelNo: lv,
      confidence: round2(cand.confidence),
      position: {
        chainage: chainage(meter),
        mileageM: Math.round(meter),
        sector,
        angleDeg: Math.round(f.angle),
        bbox: f.bbox,
      },
      physical: gctx.physical || {},
      basis: explain(cand.type, f),
      evidence: {
        image: round2(Math.max(f.edgeDensity ?? 0, f.darkRatio ?? 0, f.textureVar ?? 0)),
        sensor: round2(sensorEv[cand.type]),
        fused: round2(cand.confidence),
      },
      suggestions: SUGGESTION_LIB[cand.type][LEVELS[lv - 1]],
      status: '待审核',
      detectedAt: frame.timestamp || new Date().toISOString(),
      tunnel: frame.tunnel || '默认隧道',
      imageRef: frame.image.frameUrl || null,
    });
  }

  return {
    frameId: frame.id || null,
    analyzedAt: new Date().toISOString(),
    threshold,
    detections,
  };
}

// ------------------- 工具 -------------------
/**
 * ROI 特征兜底归一：缺失/非法的数值特征补缺省值，bbox/angle 非法时给中性值。
 * 输入：ROI 对象（bbox + 特征字段，契约见 detector.js 文件头）
 * 输出：字段齐全的 ROI 副本（合法输入逐字段原样保留，行为不变）
 */
const FEATURE_DEFAULTS = {
  edgeDensity: 0.5, darkRatio: 0.5, brightRatio: 0, textureVar: 0.5,
  hueShift: 0, lengthPx: 0, widthPx: 0, elongation: 1, fillRatio: 0.5,
  linearity: 0.5, orientation: 'diagonal', angle: 0,
};
function normalizeFeatures(roi) {
  const r = (roi && typeof roi === 'object') ? roi : {};
  const out = { ...r };
  for (const [k, d] of Object.entries(FEATURE_DEFAULTS)) {
    const v = out[k];
    if (k === 'orientation') { if (typeof v !== 'string' || !v) out[k] = d; continue; }
    if (typeof v !== 'number' || !isFinite(v)) out[k] = d;
  }
  if (!Array.isArray(out.bbox) || out.bbox.length !== 4
    || out.bbox.some((x) => typeof x !== 'number' || !isFinite(x))) out.bbox = [0, 0, 0.1, 0.1];
  return out;
}
function clamp(x) { return Math.max(0, Math.min(1, x)); }
function clampNum(x, a, b) { return Math.max(a, Math.min(b, x)); }

/**
 * 训练模型候选结果包装：把注入分类器的输出对齐为 classifyROI 同构返回
 * { type, score, confidence, margin, scores }；type 为空/背景时 score=0（被阈值丢弃）
 */
function learnedCand(f, sensorEv) {
  let r = null;
  try { r = _classifier(f, sensorEv); } catch (e) { r = null; }
  if (!r || !r.type || r.type === '背景') return { type: null, score: 0, confidence: 0, margin: 0, scores: {} };
  const conf = clamp(Number(r.confidence) || 0);
  return { type: r.type, score: conf, confidence: conf, margin: 0, scores: r.probs || {}, level: r.level };
}
function round2(x) { return Math.round(x * 100) / 100; }
function chainage(meter) {
  const km = Math.floor(meter / 1000);
  const m = Math.round(meter % 1000);
  return `K${km}+${String(m).padStart(3, '0')}`;
}
function sectorOf(angle) {
  const a = ((angle % 360) + 360) % 360;
  if (a < 30 || a >= 330) return '拱顶';
  if (a < 90) return '右拱腰';
  if (a < 150) return '右边墙';
  if (a < 210) return '仰拱';
  if (a < 270) return '左边墙';
  return '左拱腰';
}

module.exports = {
  analyze, DEFECT_TYPES, LEVELS, SUGGESTION_LIB, DETECT_THRESHOLD,
  SECTORS, VIEW_WIDTH_M,                                    // 供知识图谱模块（模块五）复用部位与标定
  setSuggestionResolver, suggestionsOf,
  setClassifier, getClassifier, classifyROI,
  gradeDefect, regradeWithEvidence, weightedMedianLevel,    // P1-3 多证据融合定级
};
