# -*- coding: utf-8 -*-
"""
gen-glyphs.py — 离线路由：把教学图/实验报告中文与 ASCII 字形渲染为位图，打包成
backend/glyphs.js（base64 + zlib，Node 侧零运行时依赖即可还原）。

仅开发期需要 Pillow（本文件不属于运行时链路）；glyphs.js 提交后运行不需要 Python。
用法：
  python tools/gen-glyphs.py [字体路径] [字号]
默认使用 Windows 微软雅黑 msyh.ttc / simhei.ttf，字号 42（生成较大位图，运行时按需缩放到 10~22px）。
"""
import base64
import json
import os
import sys
import zlib

try:
    from PIL import Image, ImageDraw, ImageFont
except Exception:  # pragma: no cover
    sys.exit("需要 Pillow：pip install pillow")

BASE_DIR = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
OUT = os.path.join(BASE_DIR, "glyphs.js")

# ---------------- 字符池 ----------------
# 模块一（可解释教学图）已用字符（勿删，历史导出图依赖）
M1 = (
    "隧途明鉴可解释AI教学展示对比讲解图检测系统平台模块"
    "隧道桩号检出处病害热力图方式引擎融合知识回退自动依据"
    "裂缝渗漏水剥落掉块衬砌错台白华析出环纵向斜向涌湿渍钙质表层"
    "轻微中等严重危及安全级待审核正常未"
    "青云山核桃坪坪涌"
)
# 模块二（虚实结合实训台）：界面文案 / 实验报告正文 / 样本合成器
M2 = (
    "虚实结合实训台参数探究会话实验报告导出下载生成开始结束"
    "创建新建关闭返回监控台学生姓名教师评语自评区留白签字日期"
    "操作轨迹回放快照时间状态进行中已日志编号页条张批次共"
    "滑杆拖动实时刷新结果摘要关键指标检出数量平均置信度推理耗时毫秒"
    "样本合成器缺陷素材库背景裁剪粘贴羽化透视微变换亮度对比度伽"
    "模糊噪声扰动仅用于教学演示与数据增强不得科研实测混用警示"
    "上传图片选择文件支持浏览上一页下一页第每当前显示条记录"
    "用户视图尺寸帧标定每像素毫米宽度像素面积建议整治"
    "请填写本次观察结论阈值降低提高稳定明显上升下降趋势相关随着"
    "参照标准公路养护技术规范分级精神本报告系统自动供辅助决策参考"
    "会话编号使用图像初始快照运行次数预置默认"
    "无未发现正常衬砌区域痕迹雨水浸蚀风化粉化酥碱鼓起开裂"
    "各等级对应处置动作复查周期待人工审核闭环自动通过驳回复核"
)
# 模块文案中可能出现的补充常用字
M3 = (
    "的了在于和与及或并把被以而这对那是就都还也要会可作之其已"
    "我们将把本次该每次所有其他哪些需从后再给最只用按据如下所示注"
    "双击单选全清空重命名应用确定取消提示错误成功失败正在等待处理请稍候"
)
# 学生姓名常用字（百家姓 + 常见名用字，供实验报告“学生姓名”字段渲染）
SURNAMES = (
    "赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜"
    "戚谢邹喻柏水窦章云苏潘葛奚范彭郎鲁韦昌马苗凤花方俞任袁柳酆鲍史唐"
    "费廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于时傅皮卞齐康伍余元卜顾孟平黄和"
    "穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮"
    "蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支"
    "柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑"
    "裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车"
    "侯宓蓬全郗班仰秋仲伊宫宁仇栾暴甘厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟"
    "薄印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬"
    "申扶堵冉宰郦雍郤桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹"
    "习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利"
    "蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空曾毋沙乜养鞠须丰巢关蒯相查"
    "后荆红游竺权逯盖益桓公"
)
GIVEN_COMMON = (
    "伟刚勇毅俊峰强军平保东文辉力明永健世广志义兴良海山仁波宁贵福生龙元"
    "全国胜学祥才发武新利清飞彬富顺信子杰涛昌成康星光天达安岩中茂进林坚"
    "和彪博诚先敬震振壮会思群豪心邦承乐绍功松善厚庆磊民友裕河哲江超浩亮"
    "政谦亨奇固之轮翰朗伯宏言若鸣朋斌梁栋维启克伦翔旭鹏泽晨辰士以建家致"
    "树炎德行时泰盛雄琛钧冠策腾楠榕风航弘凯欣梅雪珊玲洁颖莹静霞慧巧雅淑"
    "贞春莉晶燕梦佳怡倩诗婷媛芳婉茹云玉琴香莉楠萌晴楠"
)
# 可打印 ASCII 全覆盖（数字/百分号/小数点/字母/运算符等）
ASCII_POOL = "".join(chr(c) for c in range(32, 127))
PUNCT_EXTRA = "··—×㎡□（）《》『』【】；：，。、？！：…·／＿　“”‘’〈〉「」〖〗〔〕√±∑Δαβγ①②③④"
POOL = "".join(dict.fromkeys(M1 + M2 + M3 + SURNAMES + GIVEN_COMMON + ASCII_POOL + PUNCT_EXTRA))  # 去重保序


def _is_cjk(ch):
    return "\u4e00" <= ch <= "\u9fff"


def harvest_sources():
    """自动收割工程内所有源码/文档出现的中文，避免模板文案漏字。

    覆盖 backend/*.js（不含 glyphs.js 本体）、frontend/*、docs/*.md、README.md；
    报告正文/合成器提示等静态文案若改动，重新生成字形即可自动补齐。
    """
    base = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))  # backend/
    root = os.path.dirname(base)                                        # 工程根
    cands = []
    for d in (base, os.path.join(root, "frontend"), os.path.join(root, "docs")):
        for f in os.listdir(d):
            if f == "glyphs.js":
                continue
            p = os.path.join(d, f)
            if f.endswith((".md", ".js", ".html", ".css")):
                cands.append(p)
    p = os.path.join(root, "README.md")
    if os.path.exists(p):
        cands.append(p)
    out = []
    for p in cands:
        try:
            with open(p, encoding="utf-8", errors="ignore") as fh:
                txt = fh.read()
        except Exception:
            continue
        for ch in txt:
            if _is_cjk(ch) and ch not in out:
                out.append(ch)
    return out


def main():
    font_path = sys.argv[1] if len(sys.argv) > 1 else r"C:\Windows\Fonts\msyh.ttc"
    size = int(sys.argv[2]) if len(sys.argv) > 2 else 42
    if not os.path.exists(font_path):
        sys.exit("字体不存在: %s" % font_path)

    font = ImageFont.truetype(font_path, size)
    asc = font.getmetrics()[0]
    desc = font.getmetrics()[1]
    cell_h = asc + desc + 6                      # 统一字高（含上下留白，保证对齐）
    baseline = asc + 3

    # 基础池 + 工程文案自动收割（动态姓名/自评等常用字）
    pool = "".join(dict.fromkeys(POOL + "".join(harvest_sources())))

    glyphs = {}
    missing = []
    for ch in pool:
        try:
            w = int(font.getlength(ch)) + 4     # 宽含侧边距
        except Exception:
            missing.append(ch)
            continue
        img = Image.new("L", (w, cell_h), 0)
        dr = ImageDraw.Draw(img)
        dr.text((2, baseline), ch, font=font, fill=255, anchor="ls")
        raw = img.tobytes()                      # w*cell_h 灰度字节
        glyphs[ch] = {
            "w": w,
            "d": base64.b64encode(zlib.compress(raw, 9)).decode("ascii"),
        }

    body = (
        "/* glyphs.js — 教学图/实验报告标注字形位图（由 tools/gen-glyphs.py 生成，勿手改）\n"
        " * 每个字形：{ w: 格宽px, d: base64(zlib(灰度 w*CELL_H)) }，CELL_H 恒定保证行对齐。\n"
        " * FONT_SIZE 为生成时的 em 字号；运行时缩放比例 = 目标字号 / FONT_SIZE。\n"
        " * 重新生成：python tools/gen-glyphs.py [字体路径] [字号]\n"
        " */\n"
        "module.exports = { CELL_H: %d, FONT_SIZE: %d, font: %s, count: %d, GLYPHS: %s };\n"
        % (cell_h, size, json.dumps(os.path.basename(font_path)), len(glyphs),
           json.dumps(glyphs, ensure_ascii=False, separators=(",", ":")))
    )
    with open(OUT, "w", encoding="utf-8") as f:
        f.write(body)
    print("已生成 %s：%d 字（字高 %dpx，字体 %s）" % (OUT, len(glyphs), cell_h, os.path.basename(font_path)))
    if missing:
        print("缺失字符（已跳过）: %s" % "".join(missing))


if __name__ == "__main__":
    main()
