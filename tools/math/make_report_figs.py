# -*- coding: utf-8 -*-
"""
生成 AIC 技术报告专用插图 → docs/report_figs/
  1. fig-arch.png        五层总体架构图
  2. fig-pipeline.png    检测—分析—审核—报告 全流程闭环
  3. fig-dataset.png     真实隧道病害数据集样例（含 YOLO 标注框，按类别上色）
  4. fig-synthetic.png   病害样本合成器产出网格（合成样本，标注类型/等级）
  5. fig-yolo-val.png    YOLO 验证集 真值标注 vs 模型预测 对比
"""
import glob
import os
import random

import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager
from matplotlib.patches import FancyBboxPatch, FancyArrowPatch
from PIL import Image

ROOT = os.path.abspath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', '..'))
OUT = os.path.join(ROOT, 'docs', 'report_figs')
os.makedirs(OUT, exist_ok=True)

for cand in ('Microsoft YaHei', 'SimHei', 'Noto Sans CJK SC'):
    try:
        font_manager.findfont(cand, fallback_to_default=False)
        plt.rcParams['font.sans-serif'] = [cand]
        break
    except Exception:
        continue
plt.rcParams['axes.unicode_minus'] = False

C_DEEP, C_MAIN, C_CYAN, C_GOLD, C_GREEN, C_TEXT = '#0A1B45', '#1F4E79', '#0E9CD4', '#C08A3E', '#2F7A55', '#1A202C'
CLASS_COLORS = {0: '#C0453C', 1: '#C08A3E', 2: '#2F7A55'}          # Spalling / Crack / Leakage
CLASS_NAMES = {0: '剥落 Spalling', 1: '裂缝 Crack', 2: '渗漏 Leakage'}


def box(ax, x, y, w, h, title, items, fc, tc='white', fs=13, wrap=999):
    import textwrap
    ax.add_patch(FancyBboxPatch((x, y), w, h, boxstyle='round,pad=0.010,rounding_size=0.02',
                                linewidth=1.4, edgecolor='#FFFFFF', facecolor=fc, alpha=0.95))
    ax.text(x + w / 2, y + h - 0.030, title, ha='center', va='top', fontsize=fs, color=tc, fontweight='bold')
    if items:
        # 长文本按「 · 」在中间断成两行，避免贴边
        if '\n' not in items and len(items) > 46:
            parts = items.split(' · ')
            best, cut = None, None
            for k in range(1, len(parts)):
                a = ' · '.join(parts[:k]); b = ' · '.join(parts[k:])
                d = abs(len(a) - len(b))
                if best is None or d < best:
                    best, cut = d, (a, b)
            if cut:
                items = cut[0] + '\n' + cut[1]
        items = items.replace('\n', '\n')
        ax.text(x + w / 2, y + h - 0.082, items, ha='center', va='top', fontsize=8.6,
                color=tc, linespacing=1.5)


def fig_arch():
    fig, ax = plt.subplots(figsize=(12.0, 6.8))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0, 0), 1, 1, boxstyle='round,pad=0.006',
                                facecolor=C_DEEP, edgecolor='none'))
    ax.text(0.5, 0.965, '「隧途明鉴」五层总体架构', ha='center', va='top', fontsize=17,
            color='white', fontweight='bold')
    layers = [
        ('展示层　原生 HTML / CSS / JavaScript，零 CDN 依赖',
         '六轨工位：检测工作台 · 视图 · 病害档案 · 人工复核\n统计报告 · 知识图谱（3D 知识球）', C_MAIN),
        ('应用层　Node.js HTTP 服务（零第三方依赖）',
         '可解释 AI 教学 · 虚实实训台 · 开放学习入口 · 知识图谱\n科研工作流 · 审核闭环 · 报告导出（40+ API、Bearer 角色权限）', '#27607F'),
        ('算法层　预处理 → 融合判别 → 规范分级 → 量测',
         'CLAHE/高斯/Canny/Otsu 流水线 · 15 维特征融合（softmax / YOLOv8n 双引擎）\ngradeDefect 规范分级 · 实例掩码 mm 级量测 · Eigen-CAM 可解释热力图', C_CYAN),
        ('知识层　分级知识库 + 领域知识图谱',
         'knowledge_base 5 类×4 级处置方案 · 图谱 10 类实体 / 13 类关系\n123 实体 / 211 关系 · 8 部规范条款逐条溯源', C_GOLD),
        ('数据层　JSON 台账 + SQLite（node:sqlite，schema v5）',
         '10 张表：tunnel / image / detection / experiment_session / experiment_log\nsynthetic_sample / knowledge_base / users / kg_entity / kg_relation', C_GREEN),
    ]
    h, gap, y = 0.147, 0.015, 0.850
    for title, items, fc in layers:
        box(ax, 0.055, y - h, 0.89, h, title, items, fc)
        y -= (h + gap)
    ax.text(0.5, 0.030, '数据自下而上流动：采集帧 → 特征与量测 → 规则/学习判别 → 知识溯源 → 界面呈现',
            ha='center', va='center', fontsize=9.5, color='#9FB3D1')
    fig.savefig(os.path.join(OUT, 'fig-arch.png'), dpi=170, bbox_inches='tight', facecolor=C_DEEP)
    plt.close(fig)


def fig_pipeline():
    fig, ax = plt.subplots(figsize=(12.4, 3.4))
    ax.set_xlim(0, 1); ax.set_ylim(0, 1); ax.axis('off')
    ax.add_patch(FancyBboxPatch((0, 0), 1, 1, boxstyle='round,pad=0.006', facecolor='#F5F7FA', edgecolor='none'))
    steps = [
        ('① 采集', '车载摄像头 / 视频流\n桩号 + 角度 + 传感器', C_MAIN),
        ('② 预处理', 'CLAHE 弱光增强\n高斯 · Canny · Otsu', C_CYAN),
        ('③ 特征融合', '15 维 ROI 特征\n多源异构融合判别', C_CYAN),
        ('④ 类型识别', 'softmax 分类器\nYOLOv8n 可注入', C_GREEN),
        ('⑤ 量测与分级', '掩码量测 mm 级\ngradeDefect 规范分级', C_GREEN),
        ('⑥ 人工复核', '1 级自动闭环\n≥2 级人工敲定', C_GOLD),
        ('⑦ 报告与图谱', 'Excel / PDF 导出\n图谱闭环推理', C_GOLD),
    ]
    n = len(steps)
    w, gap = 0.118, 0.021
    x = 0.022
    for i, (t, d, c) in enumerate(steps):
        ax.add_patch(FancyBboxPatch((x, 0.30), w, 0.46, boxstyle='round,pad=0.01,rounding_size=0.03',
                                    facecolor=c, edgecolor='white', linewidth=1.3))
        ax.text(x + w / 2, 0.70, t, ha='center', va='center', fontsize=11, color='white', fontweight='bold')
        ax.text(x + w / 2, 0.48, d, ha='center', va='center', fontsize=8.4, color='white', linespacing=1.5)
        if i < n - 1:
            ax.add_patch(FancyArrowPatch((x + w + 0.002, 0.53), (x + w + gap - 0.002, 0.53),
                                         arrowstyle='-|>', mutation_scale=13, color='#7A8698', linewidth=1.6))
        x += w + gap
    ax.text(0.5, 0.16, '自动化巡检 → 智能分析 → 辅助决策：每一条建议都挂规范条款，全程留痕、可溯源',
            ha='center', va='center', fontsize=10.5, color=C_TEXT)
    ax.text(0.5, 0.87, '「隧途明鉴」检测—分析—审核—报告 全流程闭环', ha='center', va='center',
            fontsize=14, color=C_MAIN, fontweight='bold')
    fig.savefig(os.path.join(OUT, 'fig-pipeline.png'), dpi=170, bbox_inches='tight', facecolor='#F5F7FA')
    plt.close(fig)


def _read_yolo_label(p):
    out = []
    if not os.path.exists(p):
        return out
    with open(p, encoding='utf-8') as f:
        for line in f:
            v = line.split()
            if len(v) >= 5:
                out.append((int(float(v[0])), *[float(x) for x in v[1:5]]))
    return out


def fig_dataset():
    """真实隧道病害数据集样例（images/train 抽样，叠加 YOLO 真值框）"""
    imgs = sorted(glob.glob(os.path.join(ROOT, 'yolo-workspace', 'dataset', 'images', 'train', '*.jpg')))
    random.seed(7)
    random.shuffle(imgs)
    picked, seen = [], set()
    for p in imgs:
        lab = p.replace(os.sep + 'images' + os.sep, os.sep + 'labels' + os.sep).rsplit('.', 1)[0] + '.txt'
        boxes = _read_yolo_label(lab)
        if not boxes:
            continue
        cls = boxes[0][0]
        if cls in seen and len(seen) < 3:
            continue
        picked.append((p, boxes)); seen.add(cls)
        if len(picked) == 6:
            break
    fig, axes = plt.subplots(2, 3, figsize=(11.6, 7.6))
    for ax, (p, boxes) in zip(axes.ravel(), picked):
        im = Image.open(p).convert('RGB')
        W, H = im.size
        ax.imshow(im)
        ax.set_xticks([]); ax.set_yticks([])
        for c, cx, cy, bw, bh in boxes:
            x0, y0 = (cx - bw / 2) * W, (cy - bh / 2) * H
            ax.add_patch(plt.Rectangle((x0, y0), bw * W, bh * H, fill=False,
                                       edgecolor=CLASS_COLORS.get(c, '#FFFFFF'), linewidth=2.2))
            ax.text(x0 + 3, max(12, y0 - 5), CLASS_NAMES.get(c, str(c)), fontsize=8.5,
                    color='white', bbox=dict(facecolor=CLASS_COLORS.get(c, '#333333'), alpha=0.85,
                                             pad=1.6, edgecolor='none'))
        ax.set_title(os.path.basename(p), fontsize=8.6, color=C_TEXT)
    fig.suptitle('真实隧道病害数据集样例（330 组，含 YOLO 真值标注；框色对应类别）',
                 fontsize=13.5, color=C_MAIN, fontweight='bold')
    fig.tight_layout(rect=(0, 0, 1, 0.965))
    fig.savefig(os.path.join(OUT, 'fig-dataset.png'), dpi=165, bbox_inches='tight')
    plt.close(fig)


def fig_synthetic():
    """样本合成器产出网格（类型 / 等级取自文件名）"""
    files = sorted(glob.glob(os.path.join(ROOT, 'backend', 'data', 'synthetic', '*.jpg')))
    by = {}
    for f in files:
        name = os.path.basename(f)
        parts = name.rsplit('.', 1)[0].split('_')
        if len(parts) >= 4:
            by.setdefault(parts[2], []).append((f, parts[3]))
    random.seed(11)
    picked = []
    for t in ('裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出'):
        lst = by.get(t, [])
        if lst:
            picked += random.sample(lst, min(1, len(lst)))
    picked += random.sample([x for v in by.values() for x in v], max(0, 6 - len(picked)))
    fig, axes = plt.subplots(2, 3, figsize=(11.6, 7.4))
    for ax, (p, lv) in zip(axes.ravel(), picked[:6]):
        ax.imshow(Image.open(p).convert('RGB'))
        ax.set_xticks([]); ax.set_yticks([])
        t = os.path.basename(p).rsplit('.', 1)[0].split('_')
        ax.set_title(f'{t[2]} · {lv} 级　（合成样本）', fontsize=9.5, color=C_TEXT)
    fig.suptitle('病害样本合成器产出（裁剪羽化 + 透视/光度扰动 + 噪声，单次批量 20~50 张；\n'
                 '全链路标注 synthetic，与科研实测数据严格隔离）', fontsize=12.5, color=C_MAIN, fontweight='bold')
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(os.path.join(OUT, 'fig-synthetic.png'), dpi=165, bbox_inches='tight')
    plt.close(fig)


def fig_yolo_val():
    """真值标注 vs 模型预测（YOLO 验证集批次图）"""
    lab = os.path.join(ROOT, 'runs', 'detect', 'val', 'val_batch0_labels.jpg')
    pred = os.path.join(ROOT, 'runs', 'detect', 'val', 'val_batch0_pred.jpg')
    if not (os.path.exists(lab) and os.path.exists(pred)):
        print('skip fig-yolo-val: val batch images not found')
        return
    a = Image.open(lab).convert('RGB').crop((0, 0, 960, 960)).resize((880, 880))
    b = Image.open(pred).convert('RGB').crop((0, 0, 960, 960)).resize((880, 880))
    fig, axes = plt.subplots(1, 2, figsize=(12.4, 6.6))
    for ax, im, t, c in ((axes[0], a, '验证集真值标注（Ground Truth）', C_MAIN),
                         (axes[1], b, '模型预测结果（Prediction）', C_GREEN)):
        ax.imshow(im); ax.set_xticks([]); ax.set_yticks([])
        ax.set_title(t, fontsize=12.5, color=c, fontweight='bold')
    fig.suptitle('YOLOv8n 验证集对比：真值 vs 预测（330 组外部数据集，nc=3）', fontsize=13.5,
                 color=C_TEXT, fontweight='bold')
    fig.tight_layout(rect=(0, 0, 1, 0.94))
    fig.savefig(os.path.join(OUT, 'fig-yolo-val.png'), dpi=165, bbox_inches='tight')
    plt.close(fig)


if __name__ == '__main__':
    fig_arch(); fig_pipeline(); fig_dataset(); fig_synthetic(); fig_yolo_val()
    for f in sorted(os.listdir(OUT)):
        print('  docs/report_figs/' + f, round(os.path.getsize(os.path.join(OUT, f)) / 1024), 'KB')
