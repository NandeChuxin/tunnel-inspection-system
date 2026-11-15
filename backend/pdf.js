/**
 * pdf.js — 极简 PDF 生成器（零第三方依赖；模块二：实训实验报告 .pdf 输出）
 *
 * 原理：每页内容预先渲染为 RGB 位图（中文用 glyphs 位图字体光栅化，见 raster-text.js），
 *       位图经内置 jpeg.encodeJpeg 压缩后作为 Image XObject（DCTDecode）嵌入页面，
 *       整页铺满绘制。中文不依赖字体嵌入，任何 PDF 阅读器可见。
 *
 * 对外函数：
 *   buildPdf(pages)  pages = [{ wPt, hPt, pxW, pxH, rgb(Uint8Array/Buffer RGB) }]
 *                    → Buffer（完整 PDF 文件）
 *
 * 校验：产出已被 PDF 阅读器/Pillow(pypdf) 打开验证（多页、尺寸、中文渲染）。
 */
const jpeg = require('./jpeg');

/** PDF 转义（文本串用；本生成器文本仅限 ASCII 关键字，中文走位图） */
function escStr(s) { return String(s).replace(/([\\()])/g, '\\$1'); }

/**
 * 组装多页 PDF
 * @param {Array<{wPt:number,hPt:number,pxW:number,pxH:number,rgb:Uint8Array|Buffer}>} pages
 * @returns {Buffer}
 */
function buildPdf(pages) {
  if (!Array.isArray(pages) || !pages.length) throw new Error('pages 为空');
  const objects = new Map(); // objNum -> Buffer（不含 "n 0 obj" 头尾）
  let next = 1;
  const catalogNum = next++;
  const pagesNum = next++;
  const pageNums = [];
  const kids = [];

  for (const pg of pages) {
    const pageObj = next++;
    const contentObj = next++;
    const imageObj = next++;
    pageNums.push(pageObj);
    // 图像 XObject：JPEG 直嵌（DCTDecode）
    const jpg = jpeg.encodeJpeg(pg.pxW, pg.pxH, pg.rgb, 88);
    objects.set(imageObj, Buffer.concat([
      Buffer.from(`<< /Type /XObject /Subtype /Image /Width ${pg.pxW} /Height ${pg.pxH} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${jpg.length} >>\nstream\n`),
      jpg,
      Buffer.from('\nendstream'),
    ]));
    // 内容流：整页铺图
    const cs = `q\n${pg.wPt.toFixed(2)} 0 0 ${pg.hPt.toFixed(2)} 0 0 cm\n/Im${imageObj} Do\nQ\n`;
    objects.set(contentObj, Buffer.from(`<< /Length ${cs.length} >>\nstream\n${cs}endstream`));
    // 页对象
    objects.set(pageObj, Buffer.from(
      `<< /Type /Page /Parent ${pagesNum} 0 R /MediaBox [0 0 ${pg.wPt.toFixed(2)} ${pg.hPt.toFixed(2)}] ` +
      `/Resources << /XObject << /Im${imageObj} ${imageObj} 0 R >> >> /Contents ${contentObj} 0 R >>`
    ));
    kids.push(`${pageObj} 0 R`);
  }

  objects.set(pagesNum, Buffer.from(`<< /Type /Pages /Count ${pageNums.length} /Kids [${kids.join(' ')}] >>`));
  objects.set(catalogNum, Buffer.from(`<< /Type /Catalog /Pages ${pagesNum} 0 R >>`));

  // 串接（按对象号升序）
  const maxNum = Math.max(...objects.keys());
  const chunks = [Buffer.from('%PDF-1.4\n%\xE2\xE3\xCF\xD3\n')];
  const offsets = new Map();
  for (let n = 1; n <= maxNum; n++) {
    const body = objects.get(n);
    if (!body) continue;
    offsets.set(n, Buffer.concat(chunks).length);
    chunks.push(Buffer.from(`${n} 0 obj\n`), body, Buffer.from('\nendobj\n'));
  }
  const xrefStart = Buffer.concat(chunks).length;
  const xref = [`xref\n0 ${maxNum + 1}\n0000000000 65535 f `];
  for (let n = 1; n <= maxNum; n++) {
    const off = offsets.get(n);
    xref.push(off === undefined ? '0000000000 65535 f ' : `${String(off).padStart(10, '0')} 00000 n `);
  }
  chunks.push(Buffer.from(xref.join('\n') + '\n'));
  chunks.push(Buffer.from(`trailer\n<< /Size ${maxNum + 1} /Root ${catalogNum} 0 R >>\nstartxref\n${xrefStart}\n%%EOF\n`));
  return Buffer.concat(chunks);
}

module.exports = { buildPdf };
