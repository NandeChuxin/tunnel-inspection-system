# -*- coding: utf-8 -*-
"""
数学分析图表生成（仿真结果可视化）
输出：docs/math/*.png
"""
import json
import math
import os
import sys

import numpy as np
import matplotlib
matplotlib.use('Agg')
import matplotlib.pyplot as plt
from matplotlib import font_manager

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
DOCS = os.path.abspath(os.path.join(HERE, '..', '..', 'docs', 'math'))
sys.path.insert(0, HERE)
import level_model as M  # noqa: E402

os.makedirs(DOCS, exist_ok=True)

# 中文字体
for cand in ('Microsoft YaHei', 'SimHei', 'Noto Sans CJK SC', 'SimSun'):
    try:
        font_manager.findfont(cand, fallback_to_default=False)
        plt.rcParams['font.sans-serif'] = [cand]
        break
    except Exception:
        continue
plt.rcParams['axes.unicode_minus'] = False
plt.rcParams.update({'figure.dpi': 160, 'savefig.bbox': 'tight', 'font.size': 10.5,
                     'axes.grid': True, 'grid.alpha': 0.28, 'grid.linestyle': '--',
                     'axes.edgecolor': '#4A5568', 'axes.labelcolor': '#1A202C',
                     'text.color': '#1A202C', 'xtick.color': '#4A5568', 'ytick.color': '#4A5568'})

C_MAIN, C_GOLD, C_GREEN, C_RED, C_GRAY = '#1F4E79', '#C08A3E', '#2F7A55', '#B23A2F', '#7A8698'


def load(name):
    with open(os.path.join(OUT, name), encoding='utf-8') as f:
        return json.load(f)


def fig1_level_function():
    """等级阶梯函数 L(ℓ) 与平滑危险指数 D(ℓ)"""
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    ell = np.linspace(0.05, 10, 2000)
    L = np.array([M.level_of('裂缝', sector='右边墙', subtype='斜向裂缝', length_m=x)[0] for x in ell])
    D = np.array([M.severity_index(x, M.CRACK_LEN_THRESHOLDS, s=0.35) for x in ell])
    ax.step(ell, L, where='post', color=C_MAIN, lw=2.6, label='等级函数 L(ℓ)（分段常值）')
    ax.plot(ell, D, color=C_GOLD, lw=2.2, ls='-', label='平滑危险指数 D(ℓ)（s=0.35 m）')
    for th, lv in M.CRACK_LEN_THRESHOLDS:
        ax.axvline(th, color=C_GRAY, lw=1, ls=':', alpha=0.9)
        ax.text(th, 4.35, f'θ={th:g} m', ha='center', va='bottom', fontsize=9, color=C_GRAY)
    ax.axvspan(0, 1.2, color=C_GREEN, alpha=0.08)
    ax.annotate('1 级 → 2 级 临界\nℓ* = 1.2 m', xy=(1.2, 1.5), xytext=(2.55, 1.15),
                arrowprops=dict(arrowstyle='->', color=C_RED, lw=1.6), color=C_RED, fontsize=10)
    ax.set_xlabel('裂缝长度 ℓ（m，W=640 px 标定下 ℓ = max(w,l)·5.46875/1000）')
    ax.set_ylabel('等级 / 危险指数')
    ax.set_ylim(0.7, 5.0); ax.set_xlim(0, 10)
    ax.set_title('图 1  裂缝等级函数的阶梯性与连续化替代', fontsize=11.5, color=C_MAIN, pad=10)
    ax.legend(loc='lower right', frameon=False, fontsize=9.5)
    fig.savefig(os.path.join(DOCS, 'fig1-等级函数与平滑指数.png'))
    plt.close(fig)


def fig2_pixel_boundary():
    """像素临界曲线：maxPx* = θ·W/3.5"""
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    W = np.linspace(240, 2000, 400)
    for th, color, lv in ((1.2, C_GREEN, '1→2 级'), (4.0, C_GOLD, '2→3 级'), (8.0, C_RED, '3→4 级')):
        ax.plot(W, th * W / M.VIEW_WIDTH_M, color=color, lw=2.4,
                label=f'ℓ*={th:g} m（{lv}）:  maxPx* = {th/M.VIEW_WIDTH_M:.3f}·W')
    for ref, c in ((640, C_MAIN), (1280, C_GRAY)):
        ax.axvline(ref, color=c, lw=1.1, ls='--', alpha=0.8)
        y = 1.2 * ref / M.VIEW_WIDTH_M
        ax.plot([ref], [y], 'o', color=C_GREEN, ms=6)
        ax.annotate(f'W={ref}px → {y:.1f}px', xy=(ref, y), xytext=(ref + 40, y - 65),
                    color=c, fontsize=9.5, arrowprops=dict(arrowstyle='-', color=c, lw=1))
    ax.set_xlabel('图像宽度 W（px）')
    ax.set_ylabel('临界像素长度 max(w_px, l_px)*')
    ax.set_title('图 2  1→2 级临界的像素表达随分辨率线性移动（d maxPx*/dW = ℓ*/3.5）',
                 fontsize=11, color=C_MAIN, pad=10)
    ax.legend(frameon=False, fontsize=9.5)
    fig.savefig(os.path.join(DOCS, 'fig2-像素临界曲线.png'))
    plt.close(fig)


def fig3_band():
    """90% 可靠判定带宽 vs 测量相对误差"""
    rep = load('critical_report.json')['q2b_noise']['reliability_band_z1.645']
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9.6, 3.8))
    for name, c, col in (('裂缝(1→2)', C_MAIN, C_MAIN), ('渗漏水(1→2)', C_GRAY, C_GREEN),
                         ('衬砌错台(1→2)', C_GOLD, C_GOLD)):
        if name not in rep:
            continue
        d = rep[name]
        ax1.plot([s * 100 for s in d['sigma']], [w / d['theta'] * 100 for w in d['band_width_abs']],
                 'o-', color=col, lw=2.2, ms=5, label=f'{name}（θ={d["theta"]:g}{d["unit"]}）')
    ax1.set_xlabel('物理量测量相对误差 σ（%）'); ax1.set_ylabel('90% 可靠判定带宽 / θ（%）')
    ax1.set_title('(a) 判定不确定带宽随 σ 线性增长', fontsize=10.5, color=C_MAIN)
    ax1.legend(frameon=False, fontsize=9)
    d = rep['裂缝(1→2)']
    ax2.fill_between([s * 100 for s in d['sigma']], d['band90_low'], d['band90_high'],
                     color=C_MAIN, alpha=0.18, label='90% 可靠判定带')
    ax2.plot([s * 100 for s in d['sigma']], d['band90_low'], color=C_MAIN, lw=2)
    ax2.plot([s * 100 for s in d['sigma']], d['band90_high'], color=C_MAIN, lw=2)
    ax2.axhline(1.2, color=C_RED, lw=2, ls='--', label='θ = 1.2 m（1→2 级阈值）')
    ax2.set_xlabel('长度测量相对误差 σ（%）'); ax2.set_ylabel('裂缝长度 ℓ（m）')
    ax2.set_title('(b) 裂缝 1.2 m 判定的可靠带宽度', fontsize=10.5, color=C_MAIN)
    ax2.legend(frameon=False, fontsize=9)
    fig.suptitle('图 3  测量误差如何侵蚀等级判定的可信边界', fontsize=11.5, color=C_MAIN, y=1.03)
    fig.savefig(os.path.join(DOCS, 'fig3-判定可靠带.png'))
    plt.close(fig)


def fig4_noise_prob():
    rep = load('critical_report.json')['q2b_noise']['by_ratio_theta_1.2m']
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    ratios = [float(k) for k in rep]
    for s, col in (('0.02', C_GREEN), ('0.03', C_MAIN), ('0.05', C_GOLD), ('0.1', C_RED)):
        y = [rep[f'{r:.2f}'][s] * 100 for r in ratios]
        ax.plot([r * 100 for r in ratios], y, 'o-', color=col, lw=2.1, ms=4.5,
                label=f'σ = {float(s)*100:.0f}%')
    ax.axvline(100, color=C_GRAY, ls='--', lw=1.2)
    ax.text(100, ax.get_ylim()[1] * 0.92, ' 阈值点（误判概率恒 50%）', color=C_GRAY, fontsize=9)
    ax.set_xlabel('观测值 / 阈值  q/θ（%，θ = 1.2 m）')
    ax.set_ylabel('跨阈值误判概率 P_err（%）')
    ax.set_title('图 4  必须在阈值之外留出多大裕度，判定才可靠', fontsize=11, color=C_MAIN, pad=10)
    ax.legend(frameon=False, fontsize=9.5)
    fig.savefig(os.path.join(DOCS, 'fig4-误判概率曲线.png'))
    plt.close(fig)


def fig5_mc():
    rep = load('simulation_report.json')
    e = rep['exp1_2_single_frame']
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9.8, 3.9))
    x = [s * 100 for s in e['sigma']]
    ax1.plot(x, [a * 100 for a in e['acc']], 'o-', color=C_MAIN, lw=2.4, ms=5, label='严格判对率')
    ax1.plot(x, [a * 100 for a in e['acc_adj1']], 's--', color=C_GREEN, lw=2, ms=5, label='误差 ≤1 级比例')
    ax1.set_ylim(88, 101)
    ax1.set_xlabel('长度测量相对误差 σ（%）'); ax1.set_ylabel('比例（%）')
    ax1.set_title('(a) 单帧等级判对率（蒙特卡洛 n=40000）', fontsize=10.5, color=C_MAIN)
    ax1.legend(frameon=False, fontsize=9.5)
    cm = np.array(e['cm']['matrix'], dtype=float)
    cmn = cm / cm.sum(axis=1, keepdims=True) * 100
    im = ax2.imshow(cmn, cmap='Blues', vmin=0, vmax=100)
    for i in range(4):
        for j in range(4):
            if cm[i, j] > 0:
                ax2.text(j, i, f'{cmn[i,j]:.1f}%\n({int(cm[i,j])})', ha='center', va='center',
                         fontsize=8.5, color='white' if cmn[i, j] > 55 else '#1A202C')
    ax2.set_xticks(range(4), ['1级', '2级', '3级', '4级'])
    ax2.set_yticks(range(4), ['1级', '2级', '3级', '4级'])
    ax2.set_xlabel('判定等级'); ax2.set_ylabel('真实等级')
    ax2.grid(False)
    ax2.set_title('(b) 混淆矩阵（σ=3%，行归一）', fontsize=10.5, color=C_MAIN)
    fig.colorbar(im, ax=ax2, fraction=0.046, pad=0.03, label='行内占比（%）')
    fig.suptitle('图 5  裂缝分级的蒙特卡洛仿真结果', fontsize=11.5, color=C_MAIN, y=1.03)
    fig.savefig(os.path.join(DOCS, 'fig5-蒙特卡洛判对率与混淆矩阵.png'))
    plt.close(fig)


def fig6_hysteresis():
    h = load('simulation_report.json')['exp3_hysteresis']
    d = [r['delta'] * 100 for r in h['rows']]
    sw = [r['switch_rate'] * 100 for r in h['rows']]
    ms = [r['miss_rate'] * 100 for r in h['rows']]
    fig, ax = plt.subplots(figsize=(7.2, 3.9))
    ax.plot(d, sw, 'o-', color=C_MAIN, lw=2.4, ms=5, label='等级状态抖动率（逐帧）')
    ax.plot(d, ms, 's-', color=C_RED, lw=2.1, ms=4.5, label='漏判率（真实≥2级却停在1级）')
    i = [r['delta'] for r in h['rows']].index(h['best_delta'])
    ax.axvline(h['best_delta'] * 100, color=C_GREEN, ls='--', lw=1.6)
    ax.annotate(f'δ* = {h["best_delta"]:.3f}\n抖动率 {sw[i]:.2f}%（↓{h["switch_reduction"]:.0%}）',
                xy=(h['best_delta'] * 100, sw[i]), xytext=(h['best_delta'] * 100 + 1.6, sw[i] + 1.4),
                color=C_GREEN, fontsize=9.5, arrowprops=dict(arrowstyle='->', color=C_GREEN, lw=1.5))
    ax.set_xlabel('迟滞半带宽 δ（阈值带 θ(1±δ)）')
    ax.set_ylabel('比例（%）')
    ax.set_title('图 6  迟滞双阈值对等级抖动的抑制（σ=3%，每病害 10 帧）', fontsize=11, color=C_MAIN, pad=10)
    ax.legend(frameon=False, fontsize=9.5)
    fig.savefig(os.path.join(DOCS, 'fig6-迟滞双阈值.png'))
    plt.close(fig)


def fig7_dual():
    rep = load('simulation_report.json')['exp4_dual_param']['by_width_noise']
    fig, (ax1, ax2) = plt.subplots(1, 2, figsize=(9.8, 3.9))
    cols = (C_RED, C_GOLD, C_MAIN, C_GREEN)
    for (key, r), col in zip(rep.items(), cols):
        a = [row['alpha'] for row in r['rows']]
        ag = [row['agree'] * 100 for row in r['rows']]
        ax1.plot(a, ag, color=col, lw=2.1, label=f"σ_b={r['sigma_b']:.0%}")
        ax1.plot([r['best_alpha']], [r['best_agree'] * 100], 'o', color=col, ms=6)
    ax1.axvline(0, color=C_GRAY, ls=':', lw=1.2)
    ax1.text(0.02, ax1.get_ylim()[0] + 0.6, ' α=0：现行长度单参数规则', color=C_GRAY, fontsize=8.5)
    ax1.set_xlabel('宽度证据权重 α（w = max(u, α·v)，α=1 等权）')
    ax1.set_ylabel('与规范主导指标口径的一致率（%）')
    ax1.set_title('(a) 双参数规则的收益随缝宽测量精度变化', fontsize=10.5, color=C_MAIN)
    ax1.legend(frameon=False, fontsize=9)
    sb = [r['sigma_b'] * 100 for r in rep.values()]
    gain = [r['agree_gain'] * 100 for r in rep.values()]
    ax2.bar(range(len(sb)), gain, color=[C_RED, C_GOLD, C_MAIN, C_GREEN], width=0.55)
    for i, (v, al) in enumerate(zip(gain, [r['best_alpha'] for r in rep.values()])):
        ax2.text(i, v + 0.12, f'+{v:.2f}%\nα*={al:.2f}', ha='center', fontsize=9, color='#1A202C')
    ax2.set_xticks(range(len(sb)), [f'{s:.0f}%' for s in sb])
    ax2.set_xlabel('缝宽测量相对误差 σ_b'); ax2.set_ylabel('一致率提升（百分点）')
    ax2.set_ylim(0, max(gain) * 1.45)
    ax2.set_title('(b) 引入宽度判据的净收益与最优权重', fontsize=10.5, color=C_MAIN)
    fig.suptitle('图 7  "长度为主"设计是否合理：宽度证据的边际价值分析',
                 fontsize=11.5, color=C_MAIN, y=1.03)
    fig.savefig(os.path.join(DOCS, 'fig7-双参数规则优化.png'))
    plt.close(fig)


def main():
    fig1_level_function(); fig2_pixel_boundary(); fig3_band()
    fig4_noise_prob(); fig5_mc(); fig6_hysteresis(); fig7_dual()
    files = sorted(f for f in os.listdir(DOCS) if f.endswith('.png'))
    print('生成图表：')
    for f in files:
        print('  docs/math/' + f)


if __name__ == '__main__':
    main()
