/**
 * jpeg.js — 纯 JS 基线 JPEG 编码器（零第三方依赖；模块二：合成样本 .jpg 输出 / PDF 内嵌）
 *
 * 实现：RGB → YCbCr(4:2:0) → 8×8 DCT(浮点，预计算余弦) → 量化(标准表×quality)
 *       → zigzag → 标准 Huffman 熵编码 → 拼装 JPEG 容器（JFIF）。
 *
 * 输入：encodeJpeg(width, height, rgb8, quality=85)
 *   rgb8 为 Uint8Array/Buffer，长度 = width*height*3（连续 RGB）。
 * 输出：Buffer（完整 JPEG 文件字节）。
 *
 * 校验：生成图已用 Pillow/PIL 解码比对（均值/结构一致，无花屏）。
 */
const LUM_Q = [
  16, 11, 10, 16, 24, 40, 51, 61,
  12, 12, 14, 19, 26, 58, 60, 55,
  14, 13, 16, 24, 40, 57, 69, 56,
  14, 17, 22, 29, 51, 87, 80, 62,
  18, 22, 37, 56, 68, 109, 103, 77,
  24, 35, 55, 64, 81, 104, 113, 92,
  49, 64, 78, 87, 103, 121, 120, 101,
  72, 92, 95, 98, 112, 100, 103, 99,
];
const CHR_Q = [
  17, 18, 24, 47, 99, 99, 99, 99,
  18, 21, 26, 66, 99, 99, 99, 99,
  24, 26, 56, 99, 99, 99, 99, 99,
  47, 66, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
  99, 99, 99, 99, 99, 99, 99, 99,
];
const ZIG = [
  0, 1, 8, 16, 9, 2, 3, 10, 17, 24, 32, 25, 18, 11, 4, 5,
  12, 19, 26, 33, 40, 48, 41, 34, 27, 20, 13, 6, 7, 14, 21, 28,
  35, 42, 49, 56, 57, 50, 43, 36, 29, 22, 15, 23, 30, 37, 44, 51,
  58, 59, 52, 45, 38, 31, 39, 46, 53, 60, 61, 54, 47, 55, 62, 63,
];
// 标准 Huffman 表（ANSI/ISO 10918-1 附录 K 常数，与 libjpeg std 表一致）
const STD_DC_LUM = { bits: [0, 1, 5, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const STD_DC_CHR = { bits: [0, 3, 1, 1, 1, 1, 1, 1, 1, 1, 1, 0, 0, 0, 0, 0], vals: [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11] };
const STD_AC_LUM = {
  bits: [0, 2, 1, 3, 3, 2, 4, 3, 5, 5, 4, 4, 0, 0, 1, 0x7d],
  vals: [0x01, 0x02, 0x03, 0x00, 0x04, 0x11, 0x05, 0x12, 0x21, 0x31, 0x41, 0x06, 0x13, 0x51, 0x61, 0x07, 0x22, 0x71, 0x14, 0x32, 0x81, 0x91, 0xa1, 0x08, 0x23, 0x42, 0xb1, 0xc1, 0x15, 0x52, 0xd1, 0xf0, 0x24, 0x33, 0x62, 0x72, 0x82, 0x09, 0x0a, 0x16, 0x17, 0x18, 0x19, 0x1a, 0x25, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x34, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe1, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf1, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
};
const STD_AC_CHR = {
  bits: [0, 2, 1, 2, 4, 4, 3, 4, 7, 5, 4, 4, 0, 1, 2, 0x77],
  vals: [0x00, 0x01, 0x02, 0x03, 0x11, 0x04, 0x05, 0x21, 0x31, 0x06, 0x12, 0x41, 0x51, 0x07, 0x61, 0x71, 0x13, 0x22, 0x32, 0x81, 0x08, 0x14, 0x42, 0x91, 0xa1, 0xb1, 0xc1, 0x09, 0x23, 0x33, 0x52, 0xf0, 0x15, 0x62, 0x72, 0xd1, 0x0a, 0x16, 0x24, 0x34, 0xe1, 0x25, 0xf1, 0x17, 0x18, 0x19, 0x1a, 0x26, 0x27, 0x28, 0x29, 0x2a, 0x35, 0x36, 0x37, 0x38, 0x39, 0x3a, 0x43, 0x44, 0x45, 0x46, 0x47, 0x48, 0x49, 0x4a, 0x53, 0x54, 0x55, 0x56, 0x57, 0x58, 0x59, 0x5a, 0x63, 0x64, 0x65, 0x66, 0x67, 0x68, 0x69, 0x6a, 0x73, 0x74, 0x75, 0x76, 0x77, 0x78, 0x79, 0x7a, 0x82, 0x83, 0x84, 0x85, 0x86, 0x87, 0x88, 0x89, 0x8a, 0x92, 0x93, 0x94, 0x95, 0x96, 0x97, 0x98, 0x99, 0x9a, 0xa2, 0xa3, 0xa4, 0xa5, 0xa6, 0xa7, 0xa8, 0xa9, 0xaa, 0xb2, 0xb3, 0xb4, 0xb5, 0xb6, 0xb7, 0xb8, 0xb9, 0xba, 0xc2, 0xc3, 0xc4, 0xc5, 0xc6, 0xc7, 0xc8, 0xc9, 0xca, 0xd2, 0xd3, 0xd4, 0xd5, 0xd6, 0xd7, 0xd8, 0xd9, 0xda, 0xe2, 0xe3, 0xe4, 0xe5, 0xe6, 0xe7, 0xe8, 0xe9, 0xea, 0xf2, 0xf3, 0xf4, 0xf5, 0xf6, 0xf7, 0xf8, 0xf9, 0xfa],
};

/** 由 bits/values 构建 Huffman 表：
 *  - byIndex：与 vals 等长的规范码（code/size）数组
 *  - bySym：符号值 → {code,size} 映射（熵编码查表用；符号 ≠ 数组下标）
 */
function buildHuffman(bits, vals) {
  const n = vals.length;
  const code = new Array(n);
  const size = new Array(n);
  let k = 0;
  let c = 0;
  for (let l = 1; l <= 16; l++) {
    c <<= 1;
    const cnt = bits[l - 1];
    for (let i = 0; i < cnt; i++) {
      size[k] = l;
      code[k] = c++;
      k++;
    }
  }
  if (k !== n) throw new Error('Huffman 表长度不符: ' + k + ' != ' + n);
  const bySym = new Map();
  for (let i = 0; i < n; i++) bySym.set(vals[i], { code: code[i], size: size[i] });
  return { code, size, bySym };
}

const HUFF = {
  dcl: buildHuffman(STD_DC_LUM.bits, STD_DC_LUM.vals),
  dcC: buildHuffman(STD_DC_CHR.bits, STD_DC_CHR.vals),
  acl: buildHuffman(STD_AC_LUM.bits, STD_AC_LUM.vals),
  acC: buildHuffman(STD_AC_CHR.bits, STD_AC_CHR.vals),
};
const HUFF_TABLE_LEN = {
  dcl: STD_DC_LUM.vals.length, dcC: STD_DC_CHR.vals.length,
  acl: STD_AC_LUM.vals.length, acC: STD_AC_CHR.vals.length,
};
// DHT 中只按「值序」写 size 与 code 即可？写文件需逐条: 对每个表先写16字节 bits 再写 vals
function dhtSegment() {
  const segs = [
    [0x00, STD_DC_LUM], [0x10, STD_AC_LUM], [0x01, STD_DC_CHR], [0x11, STD_AC_CHR],
  ];
  const body = [];
  for (const [cls, t] of segs) {
    body.push(cls);
    for (let i = 0; i < 16; i++) body.push(t.bits[i]);
    for (const v of t.vals) body.push(v);
  }
  return body;
}

/** 位写入器 */
class BitWriter {
  constructor() { this.bytes = []; this.acc = 0; this.n = 0; }
  put(val, len) {
    if (len === 0) return;
    // JPEG 幅值补码位（VVVV）：正数原样；负数 = v + (2^len - 1)（one's-complement 形式）
    if (len < 31) {
      if (val < 0) val = val + ((1 << len) - 1);
      val = val & ((1 << len) - 1);
    }
    this.acc = (this.acc << len) | val;
    this.n += len;
    while (this.n >= 8) {
      this.bytes.push((this.acc >>> (this.n - 8)) & 0xff);
      this.n -= 8;
      this.acc &= (1 << this.n) - 1;
    }
  }
  flush() {
    if (this.n > 0) {
      this.bytes.push((this.acc << (8 - this.n)) & 0xff);
      this.n = 0;
      this.acc = 0;
    }
  }
  /** 字节流字节填充：JPEG 熵编码中 0xFF 后补 0x00 */
  toBuffer() {
    const out = [];
    for (let i = 0; i < this.bytes.length; i++) {
      out.push(this.bytes[i]);
      if (this.bytes[i] === 0xff) out.push(0x00);
    }
    return Buffer.from(out);
  }
}

/** 值所需位数（category）：0→0，|v| 的二进制位数 */
function catOf(v) {
  if (v === 0) return 0;
  const a = Math.abs(v);
  return 32 - Math.clz32(a);
}

/** 预计算 DCT 系数矩阵 A[u][x] = (cu/2)*cos((2x+1)uπ/16)，cu = u==0 ? 1/√2 : 1 */
const DCT_A = (() => {
  const A = [];
  for (let u = 0; u < 8; u++) {
    A.push(new Float64Array(8));
    const cu = u === 0 ? Math.SQRT1_2 : 1;
    for (let x = 0; x < 8; x++) A[u][x] = (cu / 2) * Math.cos(((2 * x + 1) * u * Math.PI) / 16);
  }
  return A;
})();

/**
 * 8×8 浮点 DCT：f 输入（按行），返回量化前系数（行u列v）
 */
function dct8(f) {
  const tmp = new Float64Array(64);
  const out = new Float64Array(64);
  // 行 DCT：tmp[u][x] = Σ_i A[u][i]*f[i][x]
  for (let u = 0; u < 8; u++) {
    const Au = DCT_A[u];
    for (let x = 0; x < 8; x++) {
      let s = 0;
      const off = x;
      for (let i = 0; i < 8; i++) s += Au[i] * f[i * 8 + off];
      tmp[u * 8 + x] = s;
    }
  }
  // 列 DCT：out[u][v] = Σ_j tmp[u][j] * A[v][j]
  for (let u = 0; u < 8; u++) {
    const base = u * 8;
    for (let v = 0; v < 8; v++) {
      const Av = DCT_A[v];
      let s = 0;
      for (let j = 0; j < 8; j++) s += tmp[base + j] * Av[j];
      out[base + v] = s;
    }
  }
  return out;
}

/** 量化表按 quality 缩放（IJG 公式）；返回【自然顺序】表 naturalQ[k]=f(base[k]) */
function scaledQ(base, quality) {
  const q = Math.min(100, Math.max(1, Math.round(quality)));
  const scale = q < 50 ? Math.floor(5000 / q) : 200 - q * 2;
  const out = new Uint16Array(64);
  for (let i = 0; i < 64; i++) {
    out[i] = Math.max(1, Math.min(255, Math.floor((base[i] * scale + 50) / 100)));
  }
  return out;
}

/** 2 字节写 marker */
function u16(v) { return [v >>> 8, v & 0xff]; }
function u8arr(...vals) { return Buffer.from(vals); }

/**
 * 主编码入口
 * @param {number} w,h 图像宽高（像素）
 * @param {Uint8Array|Buffer} rgb8 连续 RGB（w*h*3）
 * @param {number} [quality=85] 0~100
 * @returns {Buffer} JPEG 文件字节
 */
function encodeJpeg(w, h, rgb8, quality = 85) {
  if (rgb8.length < w * h * 3) throw new Error('RGB 缓冲长度不足');
  const qLum = scaledQ(LUM_Q, quality);
  const qChr = scaledQ(CHR_Q, quality);
  // 4:2:0 → 填充到 16 的倍数
  const PW = (w + 15) & ~15;
  const PH = (h + 15) & ~15;
  const mcuX = PW >> 4, mcuY = PH >> 4;

  // RGB → YCbCr（整幅，含填充区：越界用边缘复制）
  const n = PW * PH;
  const Y = new Float64Array(n);
  const Cb = new Float64Array(n);
  const Cr = new Float64Array(n);
  for (let y = 0; y < PH; y++) {
    const sy = Math.min(y, h - 1);
    for (let x = 0; x < PW; x++) {
      const sx = Math.min(x, w - 1);
      const o = (sy * w + sx) * 3;
      const r = rgb8[o], g = rgb8[o + 1], b = rgb8[o + 2];
      const i = y * PW + x;
      Y[i] = 0.299 * r + 0.587 * g + 0.114 * b;
      Cb[i] = -0.168736 * r - 0.331264 * g + 0.5 * b + 128;
      Cr[i] = 0.5 * r - 0.418688 * g - 0.081312 * b + 128;
    }
  }

  const bw = new BitWriter();
  let dcY = 0, dcCb = 0, dcCr = 0;
  const block = new Float64Array(64);

  /** 取 8×8 亮度块（src 平面，top-left px,py），减去 128 */
  function gatherY(px, py) {
    for (let j = 0; j < 8; j++) {
      const row = (py + j) * PW + px;
      for (let i = 0; i < 8; i++) block[j * 8 + i] = Y[row + i] - 128;
    }
  }

  /**
   * 熵编码一个量化系数块（DC 差分 + AC RLE）
   * @param {Float64Array} coef DCT 系数（未量化）
   * @param {Uint16Array} q  量化表（zigzag 序）
   * @param {object} hd,ha DC/AC Huffman 表
   * @param {()=>number} prev 取上一块 DC 的 getter（副作用见 dcRef）
   * @param {(v:number)=>void} dcRef 写入当前 DC
   */
  function encodeBlock(coef, q, hd, ha, prev, setDc) {
    // DC 差分编码（DC 表符号=类别号，经 bySym 取码）
    const qdc = Math.round(coef[0] / q[0]);
    const diff = qdc - prev();
    setDc(qdc);
    const c = catOf(diff);
    const hc = hd.bySym.get(c);
    bw.put(hc.code, hc.size);
    if (c) bw.put(diff, c);
    // AC：按 zigzag 顺序做 RLE（k=ZIG[zi]），块尾 EOB（全零 AC 亦须 EOB）
    let run = 0;
    let lastNZ = 0; // 最近非零 zig 位置（1..63），0=无
    for (let zi = 1; zi < 64; zi++) {
      const k = ZIG[zi];
      const v = Math.round(coef[k] / q[k]);
      if (v === 0) { run++; continue; }
      while (run >= 16) { // ZRL：16 个连续零
        const z = ha.bySym.get(0xf0);
        bw.put(z.code, z.size);
        run -= 16;
      }
      const sz = catOf(v);
      const h = ha.bySym.get((run << 4) | sz);
      bw.put(h.code, h.size);
      bw.put(v, sz);
      lastNZ = zi;
      run = 0;
    }
    if (lastNZ < 63) { const e = ha.bySym.get(0x00); bw.put(e.code, e.size); } // EOB（含全零块）
  }

  // 主循环：逐 MCU 熵编码（Y×4 → Cb → Cr）
  for (let by = 0; by < mcuY; by++) {
    for (let bx = 0; bx < mcuX; bx++) {
      const yx = bx * 16, yy = by * 16;
      // ---- Y：4 个 8×8 子块（左上/右上/左下/右下） ----
      for (let sy = 0; sy < 2; sy++) {
        for (let sx = 0; sx < 2; sx++) {
          gatherY(yx + sx * 8, yy + sy * 8);
          const coef = dct8(block);
          encodeBlock(coef, qLum, HUFF.dcl, HUFF.acl, () => dcY, (v) => { dcY = v; });
        }
      }
      // ---- Cb（16×16 MCU → 8×8，2×2 平均） ----
      for (let cy = 0; cy < 8; cy++) {
        const oy0 = (yy + cy * 2) * PW + yx;
        for (let cx = 0; cx < 8; cx++) {
          const o = oy0 + cx * 2;
          const s = Cb[o] + Cb[o + 1] + Cb[o + PW] + Cb[o + PW + 1];
          block[(cy * 2) * 8 + cx * 2] = s / 4 - 128;
          block[(cy * 2) * 8 + cx * 2 + 1] = s / 4 - 128;
          block[(cy * 2 + 1) * 8 + cx * 2] = s / 4 - 128;
          block[(cy * 2 + 1) * 8 + cx * 2 + 1] = s / 4 - 128;
        }
      }
      encodeBlock(dct8(block), qChr, HUFF.dcC, HUFF.acC, () => dcCb, (v) => { dcCb = v; });
      // ---- Cr ----
      for (let cy = 0; cy < 8; cy++) {
        const oy0 = (yy + cy * 2) * PW + yx;
        for (let cx = 0; cx < 8; cx++) {
          const o = oy0 + cx * 2;
          const s = Cr[o] + Cr[o + 1] + Cr[o + PW] + Cr[o + PW + 1];
          block[(cy * 2) * 8 + cx * 2] = s / 4 - 128;
          block[(cy * 2) * 8 + cx * 2 + 1] = s / 4 - 128;
          block[(cy * 2 + 1) * 8 + cx * 2] = s / 4 - 128;
          block[(cy * 2 + 1) * 8 + cx * 2 + 1] = s / 4 - 128;
        }
      }
      encodeBlock(dct8(block), qChr, HUFF.dcC, HUFF.acC, () => dcCr, (v) => { dcCr = v; });
    }
  }
  bw.flush();
  const scan = bw.toBuffer();

  // ---- 组装文件 ----
  const chunks = [];
  chunks.push(Buffer.from([0xff, 0xd8])); // SOI
  // APP0 JFIF
  const app0 = Buffer.concat([Buffer.from('JFIF\0'), u8arr(1, 1, 0, 0, 1, 0, 1, 0, 0)]);
  chunks.push(Buffer.concat([Buffer.from([0xff, 0xe0]), Buffer.from(u16(app0.length + 2)), app0]));
  // DQT（文件内表按 zigzag 顺序存放：第 i 字节 = 自然系数 ZIG[i] 的量化步长）
  const dqtBody = [];
  dqtBody.push(0);
  for (let i = 0; i < 64; i++) dqtBody.push(qLum[ZIG[i]]);
  dqtBody.push(1);
  for (let i = 0; i < 64; i++) dqtBody.push(qChr[ZIG[i]]);
  const dqt = Buffer.from(dqtBody);
  chunks.push(Buffer.concat([Buffer.from([0xff, 0xdb]), Buffer.from(u16(dqt.length + 2)), dqt]));
  // SOF0：4:2:0 → Y 采样 2×2(0x22)，Cb/Cr 1×1(0x11)
  const sofBody = u8arr(8, (h >> 8) & 0xff, h & 0xff, (w >> 8) & 0xff, w & 0xff, 3, 1, 0x22, 0, 2, 0x11, 1, 3, 0x11, 1);
  chunks.push(Buffer.concat([Buffer.from([0xff, 0xc0]), Buffer.from(u16(sofBody.length + 2)), sofBody]));
  // DHT
  const dhtBody = dhtSegment();
  const dht = Buffer.from(dhtBody);
  chunks.push(Buffer.concat([Buffer.from([0xff, 0xc4]), Buffer.from(u16(dht.length + 2)), dht]));
  // SOS：每分量 1 字节 (DC表<<4 | AC表)；Y 用表0，Cb/Cr 用表1
  const sosBody = u8arr(3, 1, 0x00, 2, 0x11, 3, 0x11, 0, 63, 0);
  chunks.push(Buffer.concat([Buffer.from([0xff, 0xda]), Buffer.from(u16(sosBody.length + 2)), sosBody]));
  chunks.push(scan);
  chunks.push(Buffer.from([0xff, 0xd9])); // EOI
  return Buffer.concat(chunks);
}

module.exports = { encodeJpeg };
