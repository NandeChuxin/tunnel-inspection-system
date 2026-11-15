# -*- coding: utf-8 -*-
"""
tools/build-aic-pdfs.py — 重建 AIC-2026 参赛「其他材料」三册 PDF（版式 1:1 复刻 2026-09-18 版）

三册：源代码 / 模型数据 / 可执行程序
版式逆向自原版 PDF（ReportLab + 微软雅黑）：
  - A4，页眉「AiC 2026」+ 右侧段名 + 黑色 0.45pt 细线，页脚编号 + 页码
  - 封面：居中标题/副标题 + 4 行信息表（浅蓝底、竖分隔线）+ 说明段
  - 文件目录：每页 65 条（续页 68 条），7.5pt，行距 11
  - 文件正文：标题面板（浅蓝底）+ 行号（右对齐 61.0）+ 代码，6.2pt，行距 8.1，
    首页 85 行（y0=745.5118），续页 92 行（y0=793.7008），长行不截断（与原版一致）
  - 模型数据册封面额外：二进制模型文件登记（大小 + SHA-256）

用法：python tools/build-aic-pdfs.py            # 直接覆盖 D 盘目标文件
      python tools/build-aic-pdfs.py --out DIR  # 输出到指定目录
"""
import os
import sys
import hashlib

from reportlab.lib.pagesizes import A4
from reportlab.pdfgen import canvas
from reportlab.pdfbase import pdfmetrics
from reportlab.pdfbase.ttfonts import TTFont
from reportlab.lib.colors import Color

WS = r"D:/隧道检测/tunnel-inspection-system"
OUT_DEFAULT = (r"D:/隧道检测/2026AIC作品方案模板/"
               r"AIC-2026-88299599-AI+学科交叉-隧途明鉴——隧道病害AI识别与分析系统-其他材料/"
               r"AIC-2026-88299599-AI+学科交叉-隧途明鉴——隧道病害AI识别与分析系统-代码与数据")

# ---------------- 版式常量（逆向自原版 PDF） ----------------
PAGE_W, PAGE_H = A4                      # 595.28 x 841.89
ML, MR = 36.85039, 558.4252              # 左边距 / 右缘

ACCENT   = Color(0.039216, 0.298039, 0.537255)   # 页眉 AiC 2026  #0A4C89
NAVY     = Color(0.062745, 0.164706, 0.262745)   # 正文主色      #102A43
GRAY     = Color(0.384314, 0.490196, 0.596078)   # 页脚/标签     #627D98
NUMGRAY  = Color(0.509804, 0.603922, 0.694118)   # 行号          #829AB1
CODEINK  = Color(0.090196, 0.168627, 0.301961)   # 代码          #172B4D
PANEL_F  = Color(0.949020, 0.968627, 0.980392)   # 文件标题面板底 #F2F7FA
BORDER   = Color(0.737255, 0.800000, 0.862745)   # 面板描边       #BCD2DC
KV_F     = Color(0.917647, 0.952941, 0.972549)   # 信息表底色     #EAF3F8

KICK_Y, KICK_SIZE = 810.7087, 13.0        # 页眉 AiC 2026
SECT_Y,  SECT_SIZE = 812.126, 8.0         # 页眉右侧段名
RULE_Y = 805.0394                         # 页眉细线
FOOT_Y, FOOT_SIZE = 22.67717, 7.0         # 页脚

TITLE_Y, TITLE_SIZE = 725.7, 22.0         # 封面主标题
SUB_Y,   SUB_SIZE   = 691.7, 11.0         # 封面副标题
KV_X, KV_W, KV_H = 79.37008, 436.5354, 34.01575
KV_TOP_Y, KV_DIV_X = 609.6142, 184.252    # 首行矩形底 y / 竖分隔线 x
KV_LABEL_X, KV_VALUE_X = 90.7, 195.6
KV_BASE_OFF, KV_SIZE = 16.89, 9.0
DESC_Y0, DESC_PITCH, DESC_SIZE = 476.2, 21.6, 9.5
BIN_HEAD_SIZE = 10.5                      # 二进制登记标题
BIN_ENTRY_X, BIN_ENTRY_SIZE, BIN_PITCH = 48.2, 8.2, 13.0
BIN_HEAD_GAP, BIN_HEAD_TO_ENTRY = 27.4, 17.0

TOC_TITLE_SIZE = 16.0
TOC_SIZE, TOC_PITCH = 7.5, 11.0
TOC_Y0_FIRST, TOC_MAX_FIRST = 766.0, 65   # 目录首页：起始 y / 最多条数
TOC_Y0_CONT,  TOC_MAX_CONT  = 793.7008, 68

CODE_SIZE, CODE_PITCH = 6.2, 8.1
CODE_X, NUM_RIGHT_X = 70.86614, 61.0
PANEL_Y, PANEL_W, PANEL_H = 759.685, 521.5748, 36.85039
FILE_TITLE_X, FILE_TITLE_Y, FILE_TITLE_SIZE = 45.35433, 779.5276, 10.0
CODE_Y0_FIRST, CODE_ROWS_FIRST = 745.5118, 86   # 文件首页行位（含折行续行）
CODE_Y0_CONT,  CODE_ROWS_CONT  = 793.7008, 92   # 续页行位
WRAP_CELLS = 142   # 长行折行宽度（字符位：ASCII=1，CJK/全角=2），逆向自原版折行点

WRAP_BIN = 458.0   # 二进制登记行换行宽度（按原版换行点校准）

# ---------------- 收录清单（2026-11-15 更新：刷新代码内容、补入新增源码、换用 6 类 20 轮模型） ----------------
SRC_FILES = [
    "backend/accept-kg.js", "backend/accept-w4.js", "backend/auth.js",
    "backend/composite.js", "backend/dataset/build-index.js", "backend/db.js",
    "backend/db/migrate.js", "backend/db/schema.sql", "backend/dbview.js",
    "backend/detector-quality-test.js", "backend/detector.js",
    "backend/eval-detect.js", "backend/experiment.js", "backend/explain.js",
    "backend/fusion-yolo-test.js", "backend/fusion.js", "backend/glyphs.js",
    "backend/heatmap.js", "backend/infer.js", "backend/intermediate-cache.js",
    "backend/jpeg.js", "backend/kb.js", "backend/kg.js", "backend/mask.js",
    "backend/model.js", "backend/pdf.js", "backend/portal.js",
    "backend/raster-text.js", "backend/render-viz.js", "backend/report.js",
    "backend/research.js", "backend/seed-demo.js", "backend/server.js",
    "backend/simulator.js", "backend/smoke-test.js", "backend/store.js",
    "backend/synthesizer.js", "backend/tools/gen-glyphs.py",
    "backend/train/ablation.js", "backend/train/build-samples.js",
    "backend/train/eval-real.js", "backend/train/export-yolo.js",
    "backend/train/gen-dataset.js", "backend/train/train-mix.js",
    "backend/train/train.js", "backend/verify-base.js", "backend/vision.js",
    "backend/w0-verify.js", "backend/w1-verify.js", "backend/w2-verify.js",
    "backend/w4-verify.js", "backend/xlsx.js", "frontend/app.js",
    "frontend/explain.js", "frontend/index.html", "frontend/legacy-home.html",
    "frontend/portal.js", "frontend/style.css", "frontend/training.js",
    "package.json", "publish-start.cjs", "start-preview.mjs",
    "tools/batch-infer.js", "tools/build-deploy.js",
    "tools/build-dynamic-demo.js", "tools/build-full-demo.js",
    "tools/build-materials.js", "tools/build-source-package.js",
    "tools/build_labview_manual.py", "tools/capture-ui-detail.js",
    "tools/capture-ui-for-deck.js", "tools/capture_window.ps1",
    "tools/capture_window_print.ps1", "tools/cleanup.js",
    "tools/import-full-real-dataset.js", "tools/import-real-batch2.js",
    "tools/import-real-dataset.py", "tools/import-real-to-db.js",
    "tools/list_process_windows.ps1", "tools/make-demo-voice.ps1",
    "tools/math/_js_harness.js", "tools/math/build_insert_doc.py",
    "tools/math/critical_analysis.py", "tools/math/insert_report_images.py",
    "tools/math/level_model.py", "tools/math/make_figs.py",
    "tools/math/make_report_figs.py", "tools/math/repack_submission.py",
    "tools/math/simulate.py", "tools/math/verify_equivalence.py",
    "tools/prepare-batch2.py", "tools/probe-archive.js",
    "tools/probe-dock-above.js", "tools/probe-dock-size.js",
    "tools/probe-kglink.js", "tools/probe-lab2kg.js",
    "tools/probe-review-paging.js", "tools/probe-review-real.js",
    "tools/probe-rvfig.js", "tools/probe-rvrefresh.js", "tools/probe-state.js",
    "tools/push-live-camera.py", "tools/qa_labview_doc.py",
    "tools/record-video.js", "tools/reopen-real-for-review.js",
    "tools/research-report.js", "tools/serve-docs.js",
    "tools/sync-real-batch2-to-ledger.js", "tools/sync-real-to-ledger.js",
    "tools/yolo/build-6class.js", "tools/yolo/eval_real_only.py",
    "tools/yolo/export_onnx.py", "tools/yolo/make_sample_sheet.py",
    "tools/yolo/predict_yolo.py", "tools/yolo/rebuild_dataset.py",
    "tools/yolo/register_upload.py", "tools/yolo/requirements-yolo.txt",
    "tools/yolo/train_yolo.py", "tools/yolo/verify-6class.js",
    "tools/yolo/verify-model.js", "tools/yolo/verify_dataset.py",
    "tools/zip-source-package.js",
]
MODEL_FILES = [
    "backend/data/model_params.json", "backend/data/train-real/eval-real.json",
    "backend/data/train/ablation.json", "backend/data/train/eval-metrics.json",
    "backend/data/train/metrics.json", "backend/train/ablation.js",
    "backend/train/export-yolo.js", "backend/train/train-mix.js",
    "backend/train/train.js", "yolo-workspace/dataset-6class/build-stats.json",
    "yolo-workspace/dataset-6class/data.yaml",
    "yolo-workspace/README-使用说明.md",
    "yolo-workspace/runs/6class-yolov8n/args.yaml",
    "yolo-workspace/runs/6class-yolov8n/metrics.json",
    "yolo-workspace/runs/6class-yolov8n/metrics.real-only.json",
    "yolo-workspace/runs/6class-yolov8n/指标摘要.md",
    "yolo-workspace/上传登记清单.json", "yolo-workspace/核验报告-数据集-6类.md",
    "yolo-workspace/数据集说明-6类目.md",
]
EXEC_FILES = [
    "backend/db.js", "backend/db/migrate.js", "backend/db/schema.sql",
    "backend/server.js", "frontend/index.html", "package.json",
    "start-preview.mjs", "tools/serve-docs.js",
]
BIN_MODELS = [
    "yolo-workspace/runs/6class-yolov8n/weights/best.onnx",
    "yolo-workspace/runs/6class-yolov8n/weights/best.pt",
    "yolo-workspace/weights/yolov8n.pt",
]

COVER_DESC = {
    "源代码": ["本册按工程路径完整收录前端、后端、数据库、训练、评测及辅助工具的文本源代码。",
               "代码文件保持原始名称和内容；每个文件独立起页，左侧附原始行号。"],
    "模型数据": ["本册直接收录模型参数、训练与评测指标、YOLO 数据配置、训练记录及训练脚本。",
                 "ONNX/PT 权重属于二进制文件，无法以可读代码形式排版，故在封面登记文件大小和 SHA-256 校验值。"],
    "可执行程序": ["本册直接收录程序启动入口、运行配置、服务端入口、数据库初始化脚本和前端主页面代码。",
                   "在线体验网址：https://tunnel-defect-ai.app.workbuddy.host/；本地启动命令：node start-preview.mjs。"],
}


def register_fonts():
    pdfmetrics.registerFont(TTFont("YH", "C:/Windows/Fonts/msyh.ttc", subfontIndex=0))
    pdfmetrics.registerFont(TTFont("YHB", "C:/Windows/Fonts/msyhbd.ttc", subfontIndex=0))


def read_lines(rel):
    with open(os.path.join(WS, rel), "rb") as f:
        return f.read().decode("utf-8", "replace").replace("\r\n", "\n").splitlines()


def wrap_by_width(text, font, size, max_w):
    """按真实字宽贪心换行（可在任意字符处断行，与原版一致）"""
    out, cur, cur_w = [], "", 0.0
    for ch in text:
        w = pdfmetrics.stringWidth(ch, font, size)
        if cur and cur_w + w > max_w:
            out.append(cur)
            cur, cur_w = ch, w
        else:
            cur += ch
            cur_w += w
    if cur:
        out.append(cur)
    return out


def frame(c, section, page_no):
    """页眉（AiC 2026 + 段名 + 细线）与页脚"""
    c.setFillColor(ACCENT)
    c.setFont("YHB", KICK_SIZE)
    c.drawString(ML, KICK_Y, "AiC 2026")
    c.setFillColor(NAVY)
    c.setFont("YH", SECT_SIZE)
    c.drawRightString(MR, SECT_Y, "AI+学科交叉 · " + section)
    c.setStrokeColor(Color(0, 0, 0))
    c.setLineWidth(0.45)
    c.line(ML, RULE_Y, MR, RULE_Y)
    c.setFillColor(GRAY)
    c.setFont("YH", FOOT_SIZE)
    c.drawString(ML, FOOT_Y, "AIC-2026-88299599 · 隧途明鉴")
    c.drawRightString(MR, FOOT_Y, "第 %d 页" % page_no)


def draw_cover(c, section, files, lines_of, page_no):
    frame(c, section, page_no)
    title = "AI+学科交叉 - " + section
    c.setFillColor(NAVY)
    c.setFont("YHB", TITLE_SIZE)
    c.drawCentredString(PAGE_W / 2.0, TITLE_Y, title)
    c.setFillColor(GRAY)
    c.setFont("YH", SUB_SIZE)
    c.drawCentredString(PAGE_W / 2.0, SUB_Y, "隧途明鉴——隧道病害识别与分析系统")

    total_lines = sum(len(v) for v in lines_of.values())
    rows = [
        ("作品编号", "AIC-2026-88299599"),
        ("收录文件", "%d 个文本文件" % len(files)),
        ("代码行数", "%s 行（按原始文本统计）" % format(total_lines, ",")),
        ("排版方式", "文件路径 + 行号 + 原始内容"),
    ]
    y = KV_TOP_Y
    for label, value in rows:
        c.setFillColor(KV_F)
        c.setStrokeColor(BORDER)
        c.setLineWidth(0.45)
        c.rect(KV_X, y, KV_W, KV_H, fill=1, stroke=1)
        c.line(KV_DIV_X, y, KV_DIV_X, y + KV_H)
        base = y + KV_BASE_OFF
        c.setFillColor(GRAY)
        c.setFont("YH", KV_SIZE)
        c.drawString(KV_LABEL_X, base, label)
        c.setFillColor(NAVY)
        c.drawString(KV_VALUE_X, base, value)
        y -= KV_H

    y = DESC_Y0
    c.setFillColor(NAVY)
    c.setFont("YH", DESC_SIZE)
    for ln in COVER_DESC[section]:
        c.drawString(ML, y, ln)
        y -= DESC_PITCH

    if section == "模型数据":
        y -= BIN_HEAD_GAP - DESC_PITCH  # 说明段最后一行之后空 27.4
        c.setFillColor(NAVY)
        c.setFont("YH", BIN_HEAD_SIZE)
        c.drawString(ML, y, "二进制模型文件登记（PDF 不嵌入二进制字节）：")
        y -= BIN_HEAD_TO_ENTRY
        c.setFont("YH", BIN_ENTRY_SIZE)
        for rel in BIN_MODELS:
            fp = os.path.join(WS, rel)
            data = open(fp, "rb").read()
            mb = len(data) / 1048576.0
            sha = hashlib.sha256(data).hexdigest()
            text = "· %s；%.2f MB；SHA-256 %s" % (rel, mb, sha)
            for piece in wrap_by_width(text, "YH", BIN_ENTRY_SIZE, WRAP_BIN):
                c.setFillColor(NAVY)
                c.drawString(BIN_ENTRY_X, y, piece)
                y -= BIN_PITCH


def draw_toc(c, section, files, lines_of, page_no):
    idx = 0
    first = True
    while idx < len(files):
        frame(c, section, page_no)
        y = TOC_Y0_FIRST if first else TOC_Y0_CONT
        c.setFillColor(NAVY)
        c.setFont("YHB", TOC_TITLE_SIZE)
        if first:
            c.drawString(ML, 793.7, "文件目录")
            y -= TOC_PITCH  # 标题下留一行
        c.setFont("YH", TOC_SIZE)
        limit = TOC_MAX_FIRST if first else TOC_MAX_CONT
        for _ in range(limit):
            if idx >= len(files):
                break
            rel = files[idx]
            c.setFillColor(NAVY)
            c.drawString(ML, y, "%03d  %s  (%d 行)" % (idx + 1, rel, len(lines_of[rel])))
            y -= TOC_PITCH
            idx += 1
        c.showPage()
        page_no += 1
        first = False
    return page_no


def wrap_cells(text, limit=WRAP_CELLS):
    """按显示宽度折行：ASCII=1 个字符位，CJK/全角=2 个字符位（与原版折行点一致）"""
    chunks, cur, cw = [], "", 0
    for ch in text:
        w = 2 if ord(ch) > 0x2E80 else 1
        if cw + w > limit:
            chunks.append(cur)
            cur, cw = ch, w
        else:
            cur += ch
            cw += w
    chunks.append(cur)
    return chunks


def draw_code_pages(c, section, rel, lines, page_no):
    """每个文件独立起页；长行折行为多行位（续行不带行号）；
    首页 86 行位、续页 92 行位（与原版分页一致）"""
    # 展开成行位序列：(行号或 None, 文本)
    rows = []
    for i, ln in enumerate(lines):
        chunks = wrap_cells(ln)
        for j, chunk in enumerate(chunks):
            rows.append((i + 1 if j == 0 else None, chunk))
    first = True
    pos = 0
    total = len(rows)
    while pos < total or first:
        frame(c, section, page_no)
        if first:
            c.setFillColor(PANEL_F)
            c.setStrokeColor(BORDER)
            c.setLineWidth(0.45)
            c.rect(ML, PANEL_Y, PANEL_W, PANEL_H, fill=1, stroke=1)
            c.setFillColor(NAVY)
            c.setFont("YHB", FILE_TITLE_SIZE)
            c.drawString(FILE_TITLE_X, FILE_TITLE_Y, rel)
            y = CODE_Y0_FIRST
            limit = CODE_ROWS_FIRST
        else:
            y = CODE_Y0_CONT
            limit = CODE_ROWS_CONT
        for num, text in rows[pos:pos + limit]:
            if num is not None:
                c.setFillColor(NUMGRAY)
                c.setFont("YH", CODE_SIZE)
                c.drawRightString(NUM_RIGHT_X, y, str(num))
            if text:
                c.setFillColor(CODEINK)
                c.setFont("YH", CODE_SIZE)
                c.drawString(CODE_X, y, text)
            y -= CODE_PITCH
        pos += limit
        first = False
        c.showPage()
        page_no += 1
    return page_no


def build(section, files, out_dir, with_toc=True):
    lines_of = {}
    for rel in files:
        lines_of[rel] = read_lines(rel)
    out = os.path.join(out_dir,
        "AIC-2026-88299599-AI+学科交叉-隧途明鉴——隧道病害AI识别与分析系统-%s.pdf" % section)
    c = canvas.Canvas(out, pagesize=A4)
    c.setTitle("隧途明鉴 - " + section)
    c.setAuthor("隧途明鉴项目组")
    c.setSubject("unspecified")
    c.setCreator("anonymous")

    page_no = 1
    draw_cover(c, section, files, lines_of, page_no)
    c.showPage()
    page_no = 2
    page_no = draw_toc(c, section, files, lines_of, page_no)
    for rel in files:
        page_no = draw_code_pages(c, section, rel, lines_of[rel], page_no)
    c.save()
    total = sum(len(v) for v in lines_of.values())
    print("OK %-6s %3d 文件 %7s 行 -> %s" % (section, len(files), format(total, ","), out))
    return out


def main():
    register_fonts()
    out_dir = sys.argv[sys.argv.index("--out") + 1] if "--out" in sys.argv else OUT_DEFAULT
    os.makedirs(out_dir, exist_ok=True)
    build("源代码", SRC_FILES, out_dir)
    build("模型数据", MODEL_FILES, out_dir)
    build("可执行程序", EXEC_FILES, out_dir)


if __name__ == "__main__":
    main()
