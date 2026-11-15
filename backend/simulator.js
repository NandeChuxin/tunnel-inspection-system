/**
 * simulator.js — 车载巡检采集模拟器
 * 模拟巡检车采集：光电相机 ROI 候选 + 温湿度/振动/断面差传感器读数。
 * ROI 特征字段与前端 detectRois 输出一致（含形态判别特征）。
 * 生产环境中该模块由真实车载终端数据包（MQTT/4G/5G 上传）替代。
 */
const IMG_W = 640;

function rand(a, b) { return a + Math.random() * (b - a); }
function pick(arr) { return arr[(Math.random() * arr.length) | 0]; }

/** 按病害类型生成符合其影像特征的 ROI（用于联调/演示） */
function makeRoi(kind) {
  const base = {
    bbox: [+(rand(0.05, 0.75)).toFixed(3), +(rand(0.05, 0.75)).toFixed(3), 0, 0],
    angle: Math.round(rand(0, 360)),
    hueShift: +rand(-0.1, 0.1).toFixed(2),
  };
  const L = rand(60, 300), S = rand(20, 90); // 长边/短边 px
  switch (kind) {
    case 'crack':
      return { ...base, edgeDensity: +rand(0.55, 0.85).toFixed(2), darkRatio: +rand(0.2, 0.4).toFixed(2), brightRatio: 0, textureVar: +rand(0.1, 0.3).toFixed(2), lengthPx: Math.round(L), widthPx: Math.round(rand(12, 26)), elongation: +rand(4, 9).toFixed(2), fillRatio: +rand(0.25, 0.4).toFixed(2), linearity: +rand(0.68, 0.9).toFixed(2), orientation: pick(['vertical', 'horizontal', 'diagonal']) };
    case 'leak':
      return { ...base, edgeDensity: +rand(0.1, 0.25).toFixed(2), darkRatio: +rand(0.75, 0.98).toFixed(2), brightRatio: 0, textureVar: +rand(0.05, 0.2).toFixed(2), lengthPx: Math.round(L), widthPx: Math.round(L * rand(0.6, 0.95)), elongation: +rand(1.1, 1.8).toFixed(2), fillRatio: +rand(0.55, 0.85).toFixed(2), linearity: +rand(0.5, 0.6).toFixed(2), orientation: pick(['vertical', 'horizontal']) };
    case 'spall':
      return { ...base, edgeDensity: +rand(0.4, 0.65).toFixed(2), darkRatio: +rand(0.2, 0.5).toFixed(2), brightRatio: +rand(0.05, 0.2).toFixed(2), textureVar: +rand(0.55, 0.9).toFixed(2), lengthPx: Math.round(L), widthPx: Math.round(L * rand(0.6, 0.95)), elongation: +rand(1.1, 1.9).toFixed(2), fillRatio: +rand(0.5, 0.8).toFixed(2), linearity: +rand(0.5, 0.62).toFixed(2), orientation: pick(['vertical', 'horizontal']) };
    case 'effl':
      return { ...base, edgeDensity: +rand(0.08, 0.2).toFixed(2), darkRatio: 0, brightRatio: +rand(0.5, 0.85).toFixed(2), textureVar: +rand(0.08, 0.25).toFixed(2), lengthPx: Math.round(L), widthPx: Math.round(L * rand(0.5, 0.9)), elongation: +rand(1.1, 2).toFixed(2), fillRatio: +rand(0.5, 0.8).toFixed(2), linearity: +rand(0.5, 0.62).toFixed(2), orientation: 'horizontal' };
    case 'disl':
      return { ...base, edgeDensity: +rand(0.45, 0.7).toFixed(2), darkRatio: +rand(0.25, 0.45).toFixed(2), brightRatio: 0, textureVar: +rand(0.35, 0.6).toFixed(2), hueShift: +rand(-0.55, -0.3).toFixed(2), lengthPx: Math.round(L * 1.6), widthPx: Math.round(rand(14, 30)), elongation: +rand(3, 6).toFixed(2), fillRatio: +rand(0.3, 0.45).toFixed(2), linearity: +rand(0.65, 0.85).toFixed(2), orientation: 'horizontal' };
    default: // 正常衬砌
      return { ...base, edgeDensity: +rand(0.03, 0.2).toFixed(2), darkRatio: +rand(0.02, 0.2).toFixed(2), brightRatio: +rand(0, 0.1).toFixed(2), textureVar: +rand(0.03, 0.2).toFixed(2), lengthPx: Math.round(S), widthPx: Math.round(S * 0.8), elongation: +rand(1, 2).toFixed(2), fillRatio: +rand(0.2, 0.6).toFixed(2), linearity: +rand(0.5, 0.6).toFixed(2), orientation: 'vertical' };
  }
}

/** 生成一帧模拟数据包（与真实车载终端上报格式一致） */
function makeFrame(opt = {}) {
  const humidity = rand(55, 96);
  const gapmm = opt.gapmm ?? (Math.random() < 0.15 ? rand(4, 22) : rand(0.2, 2.5));
  const kinds = ['crack', 'leak', 'spall', 'effl', 'normal', 'normal'];
  const rois = [];
  for (let i = 0; i < 6; i++) {
    const r = makeRoi(kinds[(Math.random() * kinds.length) | 0]);
    r.bbox[2] = +(r.widthPx / IMG_W).toFixed(3);
    r.bbox[3] = +(r.lengthPx / 420).toFixed(3);
    rois.push(r);
  }
  return {
    tunnel: opt.tunnel || '青云山隧道',
    mileage: opt.mileage ?? Math.round(rand(12000, 18000)),
    speed: +rand(3, 6).toFixed(1),
    source: opt.source || '巡检模拟',
    device: 'TCV-01',
    timestamp: new Date().toISOString(),
    sensors: {
      humidity: Math.round(humidity * 10) / 10,
      temperature: Math.round(rand(6, 24) * 10) / 10,
      vibration: Math.round(rand(0.05, 0.9) * 100) / 100,
      gapmm: Math.round(gapmm * 10) / 10,
    },
    image: { widthPx: IMG_W, frameUrl: null, rois },
  };
}

module.exports = { makeFrame };
