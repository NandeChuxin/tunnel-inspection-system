# -*- coding: utf-8 -*-
"""
tools/import-real-dataset.py — 真实隧道病害样本集准备（零第三方框架，仅用 PIL 做格式转换）

输入：D:/Dataset/images/test/*.jpg（33 张，文件名不参与标注，类别由人工目视标注给出）
输出：backend/data/train-real/images/*.png      （RGB，最长边 ≤640，供 vision.analyzeImage 直接消费）
      backend/data/train-real/labels.json       （逐图 GT：{file,W,H,defects:[{class_name,level,bbox 像素}]}）
      backend/data/train-real/manifest.json     （原始文件名 ↔ PNG 映射，供 API 导入用）

标注约定（人工目视逐图给出，归一化坐标 [x,y,w,h]，脚本按实际尺寸换算为像素）：
  类别 = 系统五类之一：裂缝 / 渗漏水 / 剥落掉块 / 衬砌错台 / 白华析出
  等级 = 1轻微 2中等 3严重（按缝宽/湿润范围/剥落面积目视分级）
"""
import json
import os
from PIL import Image

SRC = r"D:\Dataset\images\test"
OUT = os.path.join(os.path.dirname(__file__), "..", "backend", "data", "train-real")
IMG_OUT = os.path.join(OUT, "images")
MAX_SIDE = 640

# 逐图人工标注：文件名 → [(类别, 等级, [nx, ny, nw, nh] 归一化), ...]
# 依据：目视每张图内容判读（施工缝伴生裂缝归裂缝；锈胀湿渍归渗漏水；
# 麻面/露骨归剥落掉块；接缝白色析出物归白华析出；金属变形缝装置本身不算病害，只框裂缝）
ANNOT = {
    "1_1_008_22.jpg": [("裂缝", 2, [0.30, 0.02, 0.16, 0.85]),   # 竖向施工缝伴生裂缝
                       ("裂缝", 2, [0.02, 0.83, 0.54, 0.15])],  # 底部横向缝开裂
    "1_1_065_22.jpg": [("裂缝", 2, [0.00, 0.03, 0.13, 0.96])],  # 左侧竖向蜿蜒裂缝
    "1_1_068_18.jpg": [("裂缝", 1, [0.11, 0.20, 0.36, 0.18])],  # 变形缝装置旁横向裂缝（装置本身非病害）
    "1_3_011_31.jpg": [("渗漏水", 2, [0.70, 0.00, 0.30, 0.33])],# 预埋件周边锈染渗水
    "1_3_015_11.jpg": [("裂缝", 2, [0.00, 0.00, 0.22, 1.00])],  # 竖向裂缝带剥边
    "1_3_020_12.jpg": [("裂缝", 2, [0.20, 0.20, 0.32, 0.52])],  # 管片拼缝处蜿蜒裂缝
    "1_3_039_12.jpg": [("裂缝", 2, [0.54, 0.00, 0.26, 1.00])],  # 竖向暗缝开裂
    "1_3_040_5.jpg":  [("裂缝", 1, [0.53, 0.18, 0.42, 0.28])],  # 金属条旁横向发丝裂缝
    "1_3_046_16.jpg": [("渗漏水", 2, [0.50, 0.06, 0.50, 0.72])],# 螺栓孔锈胀渗水
    "1_3_057_18.jpg": [("渗漏水", 2, [0.50, 0.00, 0.30, 0.80])],# 湿渍竖缝
    "2_1_007_10.jpg": [("渗漏水", 1, [0.04, 0.38, 0.74, 0.50])],# 缆线间混凝土面湿渍
    "2_1_017_26.jpg": [("渗漏水", 1, [0.66, 0.00, 0.30, 1.00])],# 右侧湿润条带
    "2_1_018_2.jpg":  [("渗漏水", 1, [0.50, 0.00, 0.34, 0.60])],# 中部湿渍
    "2_1_031_32.jpg": [("渗漏水", 2, [0.24, 0.03, 0.42, 0.92])],# 湿润反光条带
    "2_1_052_21.jpg": [("渗漏水", 2, [0.23, 0.00, 0.24, 0.48])],# 管线处湿渍下淌
    "2_1_056_30.jpg": [("渗漏水", 2, [0.44, 0.00, 0.56, 1.00])],# 大面积渗漏污渍面
    "2_1_067_31.jpg": [("渗漏水", 2, [0.50, 0.26, 0.48, 0.74])],# 右下湿渍带锈染
    "2_2_003.jpg":    [("渗漏水", 2, [0.38, 0.00, 0.24, 1.00])],# 竖缝渗水带白色析出
    "2_2_012.jpg":    [("渗漏水", 1, [0.00, 0.02, 1.00, 0.30])],# 环缝顶部湿渍
    "2_2_025_2.jpg":  [("渗漏水", 1, [0.08, 0.04, 0.88, 0.92])],# 大面积湿渍（失焦）
    "2_2_035.jpg":    [("裂缝", 1, [0.50, 0.00, 0.22, 1.00])],  # 竖向暗缝（拼缝）
    "2_2_050_9.jpg":  [("渗漏水", 2, [0.26, 0.00, 0.32, 1.00])],# 竖向湿渍带
    "2_2_070_10.jpg": [("渗漏水", 2, [0.41, 0.20, 0.24, 0.40])],# 拱顶滴淌水渍
    "2_3_036_4.jpg":  [("渗漏水", 3, [0.26, 0.10, 0.52, 0.90])],# 大面积涌湿+污染
    "2_3_044_23.jpg": [("渗漏水", 2, [0.50, 0.32, 0.30, 0.62])],# 预埋件锈水下淌
    "2_3_055_16.jpg": [("渗漏水", 2, [0.00, 0.00, 0.40, 0.68])],# 左上湿渍锈染
    "2_3_081_12.jpg": [("渗漏水", 2, [0.50, 0.00, 0.40, 1.00])],# 右侧湿润带
    "2_3_083_7.jpg":  [("渗漏水", 1, [0.30, 0.00, 0.40, 0.42])],# 上部污渍湿痕
    "3_1_012_22.jpg": [("剥落掉块", 2, [0.38, 0.24, 0.26, 0.26])], # 拱顶色斑剥蚀
    "3_2_064.jpg":    [("剥落掉块", 3, [0.34, 0.26, 0.30, 0.24])], # 拱部露骨掉块
    "3_3_018_11.jpg": [("剥落掉块", 1, [0.12, 0.06, 0.84, 0.90])],# 麻面剥蚀
    "3_3_018_12.jpg": [("白华析出", 2, [0.66, 0.00, 0.34, 1.00])],# 竖缝白色析出物
    "3_3_033_26.jpg": [("剥落掉块", 2, [0.00, 0.00, 0.30, 0.80])],# 阴角剥落露骨
}

def main():
    os.makedirs(IMG_OUT, exist_ok=True)
    files = sorted(f for f in os.listdir(SRC) if f.lower().endswith(".jpg"))
    missing = [f for f in ANNOT if f not in files]
    unlabeled = [f for f in files if f not in ANNOT]
    if missing or unlabeled:
        print("!! 标注与文件不匹配 missing=%s unlabeled=%s" % (missing, unlabeled))
        raise SystemExit(1)

    items, manifest = [], []
    for name in files:
        im = Image.open(os.path.join(SRC, name)).convert("RGB")
        w0, h0 = im.size
        scale = MAX_SIDE / max(w0, h0)
        if scale < 1:
            im = im.resize((round(w0 * scale), round(h0 * scale)), Image.LANCZOS)
        w, h = im.size
        png_name = os.path.splitext(name)[0] + ".png"
        im.save(os.path.join(IMG_OUT, png_name), "PNG", optimize=True)

        defects = []
        for cls, level, (nx, ny, nw, nh) in ANNOT[name]:
            defects.append({
                "class_name": cls, "level": level,
                "bbox": [round(nx * w), round(ny * h), round(nw * w), round(nh * h)],
            })
        items.append({"file": png_name, "W": w, "H": h, "defects": defects,
                      "source_file": name, "real": True})
        manifest.append({"source": name, "png": png_name, "W": w, "H": h,
                         "path": os.path.abspath(os.path.join(IMG_OUT, png_name))})

    with open(os.path.join(OUT, "labels.json"), "w", encoding="utf-8") as f:
        json.dump({"items": items, "note": "真实样本·人工目视标注"}, f, ensure_ascii=False)
    with open(os.path.join(OUT, "manifest.json"), "w", encoding="utf-8") as f:
        json.dump(manifest, f, ensure_ascii=False, indent=1)

    by_type = {}
    for it in items:
        for d in it["defects"]:
            by_type[d["class_name"]] = by_type.get(d["class_name"], 0) + 1
    print("OK images=%d gt_boxes=%d byType=%s" % (len(items), sum(by_type.values()), json.dumps(by_type, ensure_ascii=False)))

if __name__ == "__main__":
    main()
