# -*- coding: utf-8 -*-
"""
tools/prepare-batch2.py — 第二批实拍样本准备（用户指定的 50 张 train 划分图）

输入：D:/Dataset/images/train/<name>.jpg + D:/Dataset/labels/train/<name>.txt（YOLO 真值）
输出：backend/data/train-real/images/<name>.png      （RGB，最长边 ≤640，与既有 33 张同规格）
      backend/data/train-real/labels-batch2.json     （逐图 GT：像素框 + 中文类别 + 等级）
      backend/data/train-real/manifest-batch2.json   （文件名 ↔ 原图标注对应）

标注口径：数据集仅 3 类（0=Spalling/剥落掉块 1=Crack/裂缝 2=Leakage/渗漏水），
本系统为 5 类体系，故只映射这 3 类（衬砌错台/白华析出 在数据集中无独立标注）。
等级按"目标框占画面比例 + 类别的工程判据"给出保守 1~3 级（供台账展示，非规范定级）。
"""
import json
import os
from PIL import Image

SRC_IMG = r"D:\Dataset\images\train"
SRC_LBL = r"D:\Dataset\labels\train"
OUT = os.path.join(os.path.dirname(__file__), "..", "backend", "data", "train-real")
IMG_OUT = os.path.join(OUT, "images")
MAX_SIDE = 640
CLS = {0: "剥落掉块", 1: "裂缝", 2: "渗漏水"}

FILES = """3_3_021_12 3_3_022_16 3_3_024_7 3_3_031_11 3_3_037_12 0_1_004_10 0_2_004_1
1_1_001_26 1_1_001_40 1_1_002_30 1_1_004_22 1_1_007_22 1_1_011_22 1_1_012_21 1_1_013_33
1_1_016_39 1_1_017_22 1_1_022_31 1_1_029_22 1_1_031_29 1_1_031_31 1_1_032_21 1_1_033_24
1_1_033_30 1_1_034_22 1_1_035_19 1_1_035_22 1_1_036_22 1_1_036_31 1_1_040_14 1_1_040_18
1_1_041_22 1_1_043_18 1_1_045_30 1_1_045_34 1_1_047_28 1_1_049_31 1_1_051_22 1_1_051_39
1_1_052_41 1_1_053_22 1_1_053_23 1_1_053_41 1_1_055_22 1_1_057_4 1_1_059_21 1_1_061_4
1_1_063_21 1_1_064_33 1_1_072_31""".split()


def level_of(cls_name, area_ratio):
    """面积占比 → 保守等级（工程习惯：拱部/大面积从严；此处仅按画面占比估算）"""
    if cls_name == "裂缝":
        return 3 if area_ratio >= 0.25 else (2 if area_ratio >= 0.06 else 1)
    if cls_name == "渗漏水":
        return 3 if area_ratio >= 0.30 else (2 if area_ratio >= 0.08 else 1)
    return 3 if area_ratio >= 0.15 else (2 if area_ratio >= 0.04 else 1)


def main():
    os.makedirs(IMG_OUT, exist_ok=True)
    label_rows, manifest, missing = [], [], []
    for name in FILES:
        src = os.path.join(SRC_IMG, name + ".jpg")
        lbl = os.path.join(SRC_LBL, name + ".txt")
        if not os.path.exists(src):
            missing.append(name)
            continue
        im = Image.open(src).convert("RGB")
        w, h = im.size
        if max(w, h) > MAX_SIDE:
            sc = MAX_SIDE / max(w, h)
            im = im.resize((int(w * sc), int(h * sc)), Image.LANCZOS)
        w2, h2 = im.size
        im.save(os.path.join(IMG_OUT, name + ".png"), "PNG")

        defects = []
        if os.path.exists(lbl):
            for line in open(lbl, encoding="utf-8").read().strip().splitlines():
                p = line.split()
                if len(p) < 5:
                    continue
                c = int(float(p[0]))
                cx, cy, bw, bh = (float(x) for x in p[1:5])
                cls_name = CLS.get(c)
                if not cls_name:
                    continue
                # 归一化 → 像素（用缩放后的尺寸，与 PNG 一致）
                px = [(cx - bw / 2) * w2, (cy - bh / 2) * h2, bw * w2, bh * h2]
                px = [round(max(0.0, min(1.0, v)) if i < 2 else max(0.005, min(1.0, v)), 1) for i, v in enumerate(
                    [px[0] / w2, px[1] / h2, px[2] / w2, px[3] / h2])]
                bbox = [round(px[0] * w2), round(px[1] * h2), round(px[2] * w2), round(px[3] * h2)]
                defects.append({
                    "class_name": cls_name, "level": level_of(cls_name, px[2] * px[3]),
                    "bbox": bbox, "yolo_cls": c,
                })
        label_rows.append({"file": name + ".png", "W": w2, "H": h2, "defects": defects})
        manifest.append({"src": name + ".jpg", "png": name + ".png", "boxes": len(defects)})

    json.dump(label_rows, open(os.path.join(OUT, "labels-batch2.json"), "w", encoding="utf-8"),
              ensure_ascii=False, indent=1)
    json.dump({"count": len(manifest), "items": manifest}, open(os.path.join(OUT, "manifest-batch2.json"), "w",
              encoding="utf-8"), ensure_ascii=False, indent=1)
    nbox = sum(len(r["defects"]) for r in label_rows)
    byc = {}
    for r in label_rows:
        for d in r["defects"]:
            byc[d["class_name"]] = byc.get(d["class_name"], 0) + 1
    print("转换完成:", len(label_rows), "张 · 真值框", nbox, "· 类别分布", byc, "· 缺失", missing)


if __name__ == "__main__":
    main()
