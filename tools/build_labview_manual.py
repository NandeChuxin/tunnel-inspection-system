from pathlib import Path

from docx import Document
from docx.enum.section import WD_SECTION
from docx.enum.table import WD_CELL_VERTICAL_ALIGNMENT, WD_TABLE_ALIGNMENT
from docx.enum.text import WD_ALIGN_PARAGRAPH, WD_BREAK
from docx.oxml import OxmlElement
from docx.oxml.ns import qn
from docx.shared import Cm, Inches, Pt, RGBColor


ROOT = Path(r"C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system")
LV = ROOT / "labview-integration"
OUT = LV / "基于LabVIEW的隧道病害检测影像系统软件说明书.docx"


def set_cell_shading(cell, fill):
    tc_pr = cell._tc.get_or_add_tcPr()
    shd = tc_pr.find(qn("w:shd"))
    if shd is None:
        shd = OxmlElement("w:shd")
        tc_pr.append(shd)
    shd.set(qn("w:fill"), fill)


def set_cell_margins(cell, top=100, start=120, bottom=100, end=120):
    tc = cell._tc
    tc_pr = tc.get_or_add_tcPr()
    tc_mar = tc_pr.first_child_found_in("w:tcMar")
    if tc_mar is None:
        tc_mar = OxmlElement("w:tcMar")
        tc_pr.append(tc_mar)
    for m, v in (("top", top), ("start", start), ("bottom", bottom), ("end", end)):
        node = tc_mar.find(qn(f"w:{m}"))
        if node is None:
            node = OxmlElement(f"w:{m}")
            tc_mar.append(node)
        node.set(qn("w:w"), str(v))
        node.set(qn("w:type"), "dxa")


def set_table_borders(table, color="D9D9D9", size="6"):
    tbl_pr = table._tbl.tblPr
    borders = tbl_pr.first_child_found_in("w:tblBorders")
    if borders is None:
        borders = OxmlElement("w:tblBorders")
        tbl_pr.append(borders)
    for edge in ("top", "left", "bottom", "right", "insideH", "insideV"):
        tag = borders.find(qn(f"w:{edge}"))
        if tag is None:
            tag = OxmlElement(f"w:{edge}")
            borders.append(tag)
        tag.set(qn("w:val"), "single")
        tag.set(qn("w:sz"), size)
        tag.set(qn("w:color"), color)


def set_repeat_table_header(row):
    tr_pr = row._tr.get_or_add_trPr()
    tbl_header = OxmlElement("w:tblHeader")
    tbl_header.set(qn("w:val"), "true")
    tr_pr.append(tbl_header)


def set_run_font(run, name="Microsoft YaHei", size=10.5, bold=None, color="000000"):
    run.font.name = name
    run._element.get_or_add_rPr().rFonts.set(qn("w:eastAsia"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:ascii"), name)
    run._element.get_or_add_rPr().rFonts.set(qn("w:hAnsi"), name)
    run.font.size = Pt(size)
    run.font.color.rgb = RGBColor.from_string(color)
    if bold is not None:
        run.bold = bold


def add_page_number(paragraph):
    paragraph.alignment = WD_ALIGN_PARAGRAPH.RIGHT
    run = paragraph.add_run("第 ")
    set_run_font(run, size=9, color="666666")
    fld_char1 = OxmlElement("w:fldChar")
    fld_char1.set(qn("w:fldCharType"), "begin")
    instr_text = OxmlElement("w:instrText")
    instr_text.set(qn("xml:space"), "preserve")
    instr_text.text = "PAGE"
    fld_char2 = OxmlElement("w:fldChar")
    fld_char2.set(qn("w:fldCharType"), "end")
    run._r.append(fld_char1)
    run._r.append(instr_text)
    run._r.append(fld_char2)
    tail = paragraph.add_run(" 页")
    set_run_font(tail, size=9, color="666666")


def add_para(doc, text="", style=None, bold_lead=None, align=None, space_after=5):
    p = doc.add_paragraph(style=style)
    if align is not None:
        p.alignment = align
    p.paragraph_format.space_after = Pt(space_after)
    p.paragraph_format.line_spacing = 1.45
    if bold_lead and text.startswith(bold_lead):
        r1 = p.add_run(bold_lead)
        set_run_font(r1, bold=True)
        r2 = p.add_run(text[len(bold_lead):])
        set_run_font(r2)
    else:
        r = p.add_run(text)
        set_run_font(r)
    return p


def add_bullets(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Bullet")
        p.paragraph_format.space_after = Pt(3)
        p.paragraph_format.line_spacing = 1.35
        set_run_font(p.add_run(item))


def add_steps(doc, items):
    for item in items:
        p = doc.add_paragraph(style="List Number")
        p.paragraph_format.space_after = Pt(4)
        p.paragraph_format.line_spacing = 1.4
        set_run_font(p.add_run(item))


def add_table(doc, headers, rows, widths=None):
    table = doc.add_table(rows=1, cols=len(headers))
    table.alignment = WD_TABLE_ALIGNMENT.CENTER
    table.autofit = False
    set_table_borders(table)
    for i, h in enumerate(headers):
        cell = table.rows[0].cells[i]
        cell.text = ""
        set_cell_shading(cell, "1F4E78")
        set_cell_margins(cell)
        cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
        p = cell.paragraphs[0]
        p.alignment = WD_ALIGN_PARAGRAPH.CENTER
        set_run_font(p.add_run(h), size=9.5, bold=True, color="FFFFFF")
        if widths:
            cell.width = Cm(widths[i])
    set_repeat_table_header(table.rows[0])
    for ridx, row in enumerate(rows):
        cells = table.add_row().cells
        for i, value in enumerate(row):
            cell = cells[i]
            cell.text = ""
            set_cell_margins(cell)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            if ridx % 2 == 1:
                set_cell_shading(cell, "F4F8FB")
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if i == 0 else WD_ALIGN_PARAGRAPH.LEFT
            p.paragraph_format.line_spacing = 1.2
            set_run_font(p.add_run(str(value)), size=9)
            if widths:
                cell.width = Cm(widths[i])
    doc.add_paragraph().paragraph_format.space_after = Pt(1)
    return table


def add_figure(doc, path, caption, width=6.4):
    p = doc.add_paragraph()
    p.alignment = WD_ALIGN_PARAGRAPH.CENTER
    p.paragraph_format.keep_with_next = True
    picture = p.add_run().add_picture(str(path), width=Inches(width))
    picture._inline.docPr.set("descr", caption)
    picture._inline.docPr.set("title", caption)
    cap = doc.add_paragraph()
    cap.alignment = WD_ALIGN_PARAGRAPH.CENTER
    cap.paragraph_format.space_after = Pt(8)
    set_run_font(cap.add_run(caption), size=9, color="555555")


def heading(doc, text, level=1):
    p = doc.add_paragraph(style=f"Heading {level}")
    p.paragraph_format.keep_with_next = True
    p.paragraph_format.space_before = Pt(12 if level == 1 else 8)
    p.paragraph_format.space_after = Pt(6)
    r = p.add_run(text)
    set_run_font(r, size=16 if level == 1 else 13, bold=True)
    return p


def page_break(doc):
    doc.add_paragraph().add_run().add_break(WD_BREAK.PAGE)


def build():
    doc = Document()
    sec = doc.sections[0]
    sec.top_margin = Cm(2.3)
    sec.bottom_margin = Cm(2.1)
    sec.left_margin = Cm(2.5)
    sec.right_margin = Cm(2.3)
    sec.header_distance = Cm(1.1)
    sec.footer_distance = Cm(1.1)

    styles = doc.styles
    normal = styles["Normal"]
    normal.font.name = "Microsoft YaHei"
    normal._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
    normal.font.size = Pt(10.5)
    for style_name in ("Title", "Heading 1", "Heading 2", "Heading 3"):
        st = styles[style_name]
        st.font.name = "Microsoft YaHei"
        st._element.rPr.rFonts.set(qn("w:eastAsia"), "Microsoft YaHei")
        st.font.color.rgb = RGBColor(0, 0, 0)
    styles["Title"].font.size = Pt(26)
    styles["Heading 1"].font.size = Pt(16)
    styles["Heading 2"].font.size = Pt(13)

    # Footer
    footer = sec.footer
    p = footer.paragraphs[0]
    add_page_number(p)

    # Cover
    doc.add_paragraph().paragraph_format.space_after = Pt(66)
    title = doc.add_paragraph(style="Title")
    title.alignment = WD_ALIGN_PARAGRAPH.CENTER
    title.paragraph_format.space_after = Pt(20)
    set_run_font(title.add_run("基于LabVIEW的隧道病害检测影像系统"), size=25, bold=True)
    sub = doc.add_paragraph()
    sub.alignment = WD_ALIGN_PARAGRAPH.CENTER
    set_run_font(sub.add_run("软件说明书"), size=22, bold=True)
    doc.add_paragraph().paragraph_format.space_after = Pt(42)
    box = doc.add_table(rows=5, cols=2)
    box.alignment = WD_TABLE_ALIGNMENT.CENTER
    box.autofit = False
    set_table_borders(box, color="A6A6A6", size="8")
    set_repeat_table_header(box.rows[0])
    cover_rows = [
        ("软件名称", "基于LabVIEW的隧道病害检测影像系统"),
        ("软件版本", "V1.0"),
        ("运行平台", "Windows 10/11，LabVIEW 2025"),
        ("编制日期", "2026年9月"),
        ("文档状态", "正式版"),
    ]
    for r, vals in enumerate(cover_rows):
        for c, val in enumerate(vals):
            cell = box.rows[r].cells[c]
            cell.text = ""
            cell.width = Cm(4.2 if c == 0 else 10.2)
            cell.vertical_alignment = WD_CELL_VERTICAL_ALIGNMENT.CENTER
            set_cell_margins(cell, top=150, bottom=150)
            if c == 0:
                set_cell_shading(cell, "D9EAF7")
            p = cell.paragraphs[0]
            p.alignment = WD_ALIGN_PARAGRAPH.CENTER if c == 0 else WD_ALIGN_PARAGRAPH.LEFT
            set_run_font(p.add_run(val), size=10.5, bold=(c == 0))
    doc.add_paragraph().paragraph_format.space_after = Pt(34)
    note = doc.add_paragraph()
    note.alignment = WD_ALIGN_PARAGRAPH.CENTER
    note.paragraph_format.line_spacing = 1.5
    set_run_font(note.add_run("LabVIEW上位机界面与本机智能检测服务集成实现"), size=11, color="555555")

    page_break(doc)
    heading(doc, "文档说明", 1)
    add_para(doc, "本说明书面向系统使用人员、演示人员和维护人员，说明软件的功能组成、运行环境、LabVIEW工程结构、基本界面、操作流程、接口及常见故障处理方法。系统采用LabVIEW作为上位机工程入口，通过本机HTTP接口调用既有的隧道影像检测、数据管理、人工复核和报告服务。")
    add_table(doc, ["版本", "日期", "修订内容"], [["V1.0", "2026-09", "建立系统软件说明书，纳入LabVIEW工程与检测工作台操作流程"]], [2.2, 3.0, 10.0])
    heading(doc, "目录", 1)
    toc = [
        "1 系统概述", "2 总体架构", "3 运行环境与文件组成", "4 安装与启动", "5 LabVIEW基本界面",
        "6 检测工作台功能界面", "7 典型操作流程", "8 数据与接口说明", "9 异常处理", "10 测试与验收", "11 维护说明", "附录 A 快速操作卡"
    ]
    for i, t in enumerate(toc, 1):
        p = doc.add_paragraph()
        p.paragraph_format.left_indent = Cm(0.5)
        p.paragraph_format.space_after = Pt(4)
        set_run_font(p.add_run(t), size=10.5)

    page_break(doc)
    heading(doc, "1 系统概述", 1)
    heading(doc, "1.1 建设目标", 2)
    add_para(doc, "本系统用于隧道衬砌影像的采集、病害识别、等级评估、位置标注、人工复核、统计分析和报告输出。软件以LabVIEW工程统一管理启动入口和运行状态，以本机检测服务完成图像处理、模型推理、数据存储与报告生成，从而形成从影像接入到复核归档的闭环流程。")
    heading(doc, "1.2 主要功能", 2)
    add_bullets(doc, [
        "影像接入：支持JPG、PNG图像以及视频文件、实时摄像头画面等数据源。",
        "病害检测：识别裂缝、渗漏水、剥落掉块、衬砌错台和白华析出等病害。",
        "结果表达：在原始影像上显示检测框、病害类型、等级和置信度。",
        "人工复核：对待审核结果执行通过、驳回、等级核定和处置决策。",
        "统计报告：汇总病害数量、类型和等级，导出Excel或PDF报告。",
        "知识辅助：按病害类型和等级查询成因、危害与处置建议。",
    ])
    heading(doc, "1.3 用户角色", 2)
    add_table(doc, ["角色", "主要职责", "典型权限"], [
        ["管理员", "维护系统与用户", "系统配置、数据管理、知识库维护"],
        ["检测人员", "导入影像并运行检测", "采集、检测、查看结果和导出报告"],
        ["复核人员", "核验病害与处置建议", "通过、驳回、等级核定和填写意见"],
        ["浏览人员", "查看归档结果", "台账、统计和报告查看"],
    ], [2.6, 6.4, 6.4])

    heading(doc, "2 总体架构", 1)
    add_para(doc, "系统由LabVIEW上位机层、Web检测工作台、本机算法服务和数据存储层组成。LabVIEW的Main.vi接收工作台URL并调用系统默认浏览器；工作台通过HTTP接口访问本机服务；服务完成检测、入库、复核和报告生成。")
    add_table(doc, ["层次", "组成", "职责"], [
        ["上位机层", "LabVIEW工程、Main.vi", "工程入口、URL配置、运行错误输出"],
        ["交互层", "检测工作台页面", "图像上传、结果显示、台账、复核、统计"],
        ["服务层", "Node.js本机API", "预处理、检测、融合、报告和知识图谱"],
        ["数据层", "SQLite及本地文件", "病害记录、帧数据、模型参数和导出文件"],
    ], [2.8, 5.2, 7.4])
    add_para(doc, "数据流：用户在LabVIEW工程启动Main.vi → Main.vi打开检测工作台 → 工作台向127.0.0.1本机接口提交影像与参数 → 服务返回检测结果 → 结果进入病害台账 → 人工复核后形成报告。")

    page_break(doc)
    heading(doc, "3 运行环境与文件组成", 1)
    heading(doc, "3.1 推荐环境", 2)
    add_table(doc, ["项目", "要求"], [
        ["操作系统", "Windows 10或Windows 11，64位"],
        ["LabVIEW", "LabVIEW 2025或兼容版本"],
        ["Node.js", "22.5及以上"],
        ["浏览器", "Microsoft Edge、Google Chrome或系统默认浏览器"],
        ["存储空间", "建议至少2 GB可用空间；视频与模型文件另计"],
        ["网络", "核心功能使用本机回环地址，不要求公网"],
    ], [4.0, 11.4])
    heading(doc, "3.2 LabVIEW集成目录", 2)
    add_table(doc, ["文件", "用途"], [
        ["隧道检测.lvproj", "LabVIEW工程文件"],
        ["Main.vi", "主入口VI，打开检测工作台"],
        ["config.json", "系统根目录、端口、健康检查与工作台地址"],
        ["检查系统.ps1", "检查环境、端口和API健康状态"],
        ["启动隧道检测.ps1", "启动后端与Web工作台"],
        ["停止隧道检测.ps1", "停止本集成版启动的服务进程"],
        ["运行LabVIEW主程序.vbs", "加载并运行Main.vi"],
        ["API接口清单.md", "原生LabVIEW HTTP扩展参考"],
    ], [5.1, 10.3])

    heading(doc, "4 安装与启动", 1)
    heading(doc, "4.1 启动前检查", 2)
    add_steps(doc, [
        "确认LabVIEW 2025已安装且能够正常打开VI。",
        "确认Node.js版本不低于22.5，并确认项目文件未被移动或删除。",
        "运行“检查系统.ps1”，检查源系统目录、8787端口、8899端口和健康接口。",
        "若端口被占用，应先关闭冲突程序，或同步修改配置和启动脚本中的端口。",
    ])
    heading(doc, "4.2 正常启动", 2)
    add_steps(doc, [
        "运行“启动隧道检测.ps1”，等待命令窗口提示后端与Web工作台已启动。",
        "双击“运行LabVIEW主程序.vbs”，LabVIEW将载入Main.vi并执行。",
        "Main.vi读取或接收工作台URL，通过默认浏览器打开完整检测界面。",
        "确认工作台右上角显示运行状态，随后进入检测工作台进行操作。",
    ])
    heading(doc, "4.3 正常退出", 2)
    add_steps(doc, [
        "保存或导出当前需要保留的检测结果。",
        "关闭检测工作台浏览器页面和LabVIEW VI。",
        "运行“停止隧道检测.ps1”，仅停止由本集成版启动的本机服务。",
    ])

    page_break(doc)
    heading(doc, "5 LabVIEW基本界面", 1)
    heading(doc, "5.1 项目浏览器", 2)
    add_figure(doc, LV / "screenshots" / "LabVIEW-项目浏览器.png", "图5-1 LabVIEW项目浏览器", width=5.7)
    add_para(doc, "项目浏览器集中显示Main.vi、配置文件、启动脚本和说明文档。首次使用时应从项目文件“隧道检测.lvproj”进入，以避免VI与配置文件的相对路径失效。若Main.vi旁出现文件移动警告，应在工程中重新指定当前目录下的Main.vi。")
    heading(doc, "5.2 Main.vi前面板", 2)
    add_figure(doc, LV / "screenshots" / "LabVIEW-MainVI-真实前面板.png", "图5-2 Main.vi前面板", width=6.45)
    add_table(doc, ["控件", "类型", "说明"], [
        ["URL", "字符串输入", "检测工作台地址，默认应为http://127.0.0.1:8899/prototype-holo-core.html"],
        ["URL输出", "字符串显示", "显示经过空格替换和规范化后的URL"],
        ["错误输入", "错误簇", "向VI传入前序错误状态"],
        ["错误输出", "错误簇", "显示打开浏览器过程的错误代码与来源"],
    ], [3.0, 3.0, 9.4])
    heading(doc, "5.3 Main.vi程序框图", 2)
    add_figure(doc, LV / "screenshots" / "LabVIEW-MainVI-程序框图.png", "图5-3 Main.vi程序框图", width=5.2)
    add_para(doc, "程序框图先将URL中的空格替换为“%20”，再调用“在默认浏览器中打开URL”节点。错误簇沿数据流贯穿该节点，便于定位URL无效、默认浏览器不可用或系统调用失败等问题。")

    page_break(doc)
    heading(doc, "6 检测工作台功能界面", 1)
    add_figure(doc, ROOT / ".workbuddy" / "_frame12.png", "图6-1 隧道病害检测工作台总览", width=6.55)
    add_para(doc, "检测工作台是系统的主要业务界面。中心区域显示全局检测状态，周围按功能分为检测工作台、病害识别、病害台账、检测历史、人工复核、统计与报告等模块。底部功能栏用于切换业务页面。")
    heading(doc, "6.1 检测工作台", 2)
    add_bullets(doc, [
        "上传图像：选择或拖入JPG、PNG影像，系统自动执行预处理和病害检测。",
        "视频分析：导入视频或接入摄像头后，系统按时间间隔抽帧检测。",
        "参数调节：可调整置信度、IoU、CLAHE、高斯滤波、Canny和Otsu等参数。",
        "结果叠加：在原图上显示检测框、类型、等级、置信度和量测值。",
    ])
    heading(doc, "6.2 病害台账与检测历史", 2)
    add_para(doc, "病害台账按状态、类型、等级和隧道名称筛选记录；检测历史按时间展示影像任务及检出数量。选中记录后可查看原始影像、检测框、证据链、物理量和建议。")
    heading(doc, "6.3 人工复核", 2)
    add_para(doc, "2级及以上或未达到自动闭环条件的病害进入待复核队列。复核人员核对影像与证据，选择通过或驳回，可修订病害等级、填写意见并确定处置方案。复核结果写入台账并保留状态。")
    heading(doc, "6.4 统计与报告", 2)
    add_para(doc, "统计模块汇总台账总数、待审核数量、已审核数量、危急病害数量以及类型和等级分布。报告模块支持导出Excel明细或PDF打印报告，导出前应确认筛选条件和复核状态。")

    page_break(doc)
    heading(doc, "7 典型操作流程", 1)
    heading(doc, "7.1 单张影像检测", 2)
    add_steps(doc, [
        "启动系统并进入检测工作台。",
        "选择“上传图像”，导入清晰的隧道衬砌影像。",
        "按需要填写隧道名称、桩号、环向位置和标定比例。",
        "使用默认参数开始检测；必要时再调整置信度或预处理参数。",
        "查看检测框、病害类型、等级、置信度和整治建议。",
        "将结果保存到台账；需要人工确认的记录进入复核队列。",
    ])
    heading(doc, "7.2 视频影像检测", 2)
    add_steps(doc, [
        "选择视频文件或摄像头数据源，确认画面方向和清晰度。",
        "设置抽帧间隔和起始桩号，启动逐帧分析。",
        "观察当前帧标注和检出卡片；发现误检时可暂停并调整参数。",
        "停止分析后检查检测历史，合并重复记录并进入人工复核。",
    ])
    heading(doc, "7.3 人工复核与报告", 2)
    add_steps(doc, [
        "在人工复核页面打开待复核记录。",
        "核对原图、检测框、量测信息、置信度和证据链。",
        "修订等级或处置建议，填写复核意见。",
        "选择“通过”完成归档，或选择“驳回”返回复检。",
        "进入统计与报告页面，选择数据范围并导出Excel或PDF。",
    ])

    heading(doc, "8 数据与接口说明", 1)
    heading(doc, "8.1 核心接口", 2)
    add_table(doc, ["功能", "方法", "路径", "用途"], [
        ["健康检查", "GET", "/api/health", "运行状态灯与服务时间"],
        ["模型信息", "GET", "/api/model/info", "显示推理引擎和质量信息"],
        ["图像检测", "POST", "/api/detect/image", "提交影像、ROI和检测参数"],
        ["检测结果", "GET", "/api/detect/result/{taskId}", "读取检测框和中间产物"],
        ["病害台账", "GET", "/api/defects", "查询和筛选病害记录"],
        ["人工复核", "POST", "/api/defects/{id}/review", "提交通过、驳回与核定等级"],
        ["统计", "GET", "/api/stats", "读取汇总指标"],
        ["报告", "POST", "/api/report/excel 或 /api/report/pdf", "生成报告文件"],
    ], [2.7, 2.0, 6.0, 5.0])
    heading(doc, "8.2 LabVIEW原生面板扩展建议", 2)
    add_para(doc, "如需把工作台进一步改造成完全原生的LabVIEW面板，可按Main.vi事件循环、API子VI、数据类型定义和UI子VI四层组织。HTTP Client节点负责GET/POST，JSON函数负责序列化与反序列化；所有调用设置超时，并将HTTP状态码、响应正文和调用阶段写入错误簇。建议优先实现健康状态、影像选择、开始检测、结果图、病害表格和复核按钮六类基本控件。")

    page_break(doc)
    heading(doc, "9 异常处理", 1)
    add_table(doc, ["现象", "可能原因", "处理方法"], [
        ["Main.vi运行后无页面", "URL为空或默认浏览器不可用", "检查URL输入和URL输出；确认系统默认浏览器可正常打开网页"],
        ["页面显示无法连接", "本机服务未启动或端口被占用", "运行检查脚本；重新启动服务；核对8787和8899端口"],
        ["健康状态异常", "后端启动失败或项目路径错误", "查看.runtime日志；检查config.json中的systemRoot"],
        ["图像无法检测", "格式、大小或数据编码不符合要求", "改用JPG/PNG；降低图像分辨率；重新导入"],
        ["检测结果为空", "阈值过高、图像模糊或目标过小", "降低置信度；增强照明；重新取景或调整预处理参数"],
        ["报告导出失败", "目录不可写或数据为空", "更换导出目录；确认台账中存在符合筛选条件的数据"],
        ["工程提示Main.vi被移动", "项目保存的VI路径与当前路径不一致", "在项目中移除失效项，并重新添加当前目录下的Main.vi"],
    ], [4.0, 5.3, 6.4])
    heading(doc, "9.1 日志位置", 2)
    add_para(doc, "运行日志位于labview-integration/.runtime目录。backend.out.log记录后端标准输出，backend.err.log记录后端错误，web.out.log和web.err.log记录工作台静态服务状态。排查时应先确认日志时间与当前故障一致。")

    heading(doc, "10 测试与验收", 1)
    add_table(doc, ["编号", "验收项", "通过条件"], [
        ["T01", "工程打开", "隧道检测.lvproj可打开，Main.vi可定位"],
        ["T02", "服务启动", "健康接口返回正常，8787与8899端口可访问"],
        ["T03", "页面启动", "运行Main.vi后默认浏览器打开检测工作台"],
        ["T04", "图像检测", "导入JPG/PNG后返回任务号、检测框和类别"],
        ["T05", "结果入库", "检测记录可在病害台账中检索"],
        ["T06", "人工复核", "通过或驳回后状态与意见正确保存"],
        ["T07", "统计刷新", "统计总数与台账筛选结果一致"],
        ["T08", "报告导出", "Excel或PDF可生成并正常打开"],
        ["T09", "正常退出", "停止脚本执行后相关本机服务退出"],
    ], [2.0, 5.5, 8.2])

    heading(doc, "11 维护说明", 1)
    add_bullets(doc, [
        "移动项目目录后，应同步修改config.json中的systemRoot，并在LabVIEW项目中重新确认Main.vi路径。",
        "修改端口时，应同时更新config.json、启动脚本、工作台URL和相关接口调用。",
        "数据库和模型文件升级前应备份；运行中的数据库不建议直接复制覆盖。",
        "检测参数或模型更新后，应重新执行图像检测、复核、统计和报告导出回归测试。",
        "真实工程使用前，应以现场标注影像重新评估模型，不应将演示数据指标直接作为工程验收依据。",
    ])

    page_break(doc)
    heading(doc, "附录 A 快速操作卡", 1)
    add_table(doc, ["阶段", "操作"], [
        ["检查", "运行检查系统.ps1，确认环境、目录、端口和健康接口"],
        ["启动", "运行启动隧道检测.ps1"],
        ["进入", "双击运行LabVIEW主程序.vbs，等待Main.vi打开工作台"],
        ["检测", "上传图像或视频，确认参数后开始检测"],
        ["复核", "在人工复核页核定等级、意见和处置决策"],
        ["导出", "在统计与报告页选择范围，导出Excel或PDF"],
        ["退出", "关闭页面和VI，运行停止隧道检测.ps1"],
    ], [3.0, 12.4])
    heading(doc, "附录 B 使用边界", 1)
    add_para(doc, "当前LabVIEW工程承担上位机入口和集成管理职责，核心影像算法仍运行在本机检测服务中。Main.vi不是完整的原生LabVIEW检测算法框图。系统可在现有HTTP接口基础上逐步扩展原生LabVIEW控件与子VI，但扩展前应保持接口数据结构和错误处理约定一致。")

    doc.core_properties.title = "基于LabVIEW的隧道病害检测影像系统软件说明书"
    doc.core_properties.subject = "隧道病害检测影像系统的软件功能、界面与操作说明"
    doc.core_properties.author = "项目组"
    OUT.parent.mkdir(parents=True, exist_ok=True)
    doc.save(OUT)
    print(OUT)


if __name__ == "__main__":
    build()
