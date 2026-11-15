# -*- coding: utf-8 -*-
"""
蒙特卡洛仿真：等级判定的可靠性、抖动抑制与规则优化
==================================================
实验 1  单帧判对率随测量误差 σ 的变化（裂缝 1→2 边界带）
实验 2  裂缝分级的混淆矩阵（σ=3%）
实验 3  迟滞双阈值规则：抖动率 vs 迟滞带宽 δ，求最优 δ*
实验 4  长度—宽度双参数规则：混合系数 α 的优化（对比单参数规则）
实验 5  判定可信度与"需复检比例"（落在 90% 可靠判定带内的样本占比）

输出：tools/math/out/simulation_report.json
"""
import json
import math
import os
import sys

import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
sys.path.insert(0, HERE)
import level_model as M  # noqa: E402

os.makedirs(OUT, exist_ok=True)
RNG = np.random.default_rng(20260916)
N = 40000
W = 640
MU = M.mm_per_px(W)          # 5.46875 mm/px
IMG_PX_MIN = 6.0             # ROI 最小边（bbox 退化下限）


# ------------------------- 种群与观测模型 -------------------------
def population(n=N):
    """
    病害真实尺寸种群：
      · 长度 ℓ ~ LogNormal(ln 2.0, 0.85)，覆盖 1~4 级
      · 缝宽 b 与长度正相关，按"阈值等比"标定：b/0.2 ≈ ℓ/1.2（即 1.2m 缝长 ↔ 0.2mm 缝宽同权），
        再加 15% 相对离散 —— 该标定使"长度代理"与"宽度判据"在严重度上可比，
        否则两判据结构性不一致，无法用于验证代理规则的合理性
    """
    ell = np.exp(RNG.normal(math.log(2.0), 0.85, n))          # m
    ell = np.clip(ell, 0.15, 25.0)
    b = np.clip((0.2 / 1.2) * ell * (1 + RNG.normal(0, 0.15, n)), 0.05, 8.0)   # mm
    return ell, b


def observe(ell, sigma_rel, sigma_b_rel=0.0, b=None, quantize=True):
    """
    观测模型：像素长度含相对误差 ε~N(0,σ²) 与 1px 均匀量化
        L̂_px = max(ROI_min, ℓ·1000/μ·(1+ε) + δq),  ℓ̂ = L̂_px·μ/1000
    """
    base_px = ell * 1000.0 / MU
    eps = RNG.normal(0, sigma_rel, size=ell.shape)
    dq = RNG.uniform(-0.5, 0.5, size=ell.shape) if quantize else 0.0
    px = np.maximum(IMG_PX_MIN, base_px * (1 + eps) + dq)
    ell_hat = px * MU / 1000.0
    b_hat = None
    if b is not None:
        b_hat = np.clip(b * (1 + RNG.normal(0, sigma_b_rel, size=b.shape)), 0.02, None)
    return ell_hat, b_hat


def level_crack(ell):
    """向量化裂缝分级（环向/斜向口径，与 level_model 一致）"""
    lv = np.ones_like(ell, dtype=int)
    lv = np.where(ell >= 1.2, 2, lv)
    lv = np.where(ell >= 4.0, 3, lv)
    lv = np.where(ell >= 8.0, 4, lv)
    return lv


# ------------------------- 实验 1/2 -------------------------
def exp1_2():
    ell, _ = population()
    truth = level_crack(ell)
    out = {'n': int(N), 'sigma': [], 'acc': [], 'acc_adj1': [], 'severe': [], 'cm': {}}
    for s in (0.005, 0.01, 0.02, 0.03, 0.05, 0.08, 0.10):
        eh, _ = observe(ell, s)
        pred = level_crack(eh)
        d = np.abs(pred - truth)
        out['sigma'].append(s)
        out['acc'].append(float((d == 0).mean()))
        out['acc_adj1'].append(float((d <= 1).mean()))
        out['severe'].append(float((d >= 2).mean()))
    # 混淆矩阵（σ=3%）
    eh, _ = observe(ell, 0.03)
    pred = level_crack(eh)
    cm = np.zeros((4, 4), dtype=int)
    for t, p in zip(truth, pred):
        cm[t - 1, p - 1] += 1
    out['cm'] = {'matrix': cm.tolist(), 'sigma': 0.03, 'note': '行为真实等级，列为判定等级'}
    # 边界带（1↔2）内的判对率
    band = np.abs(ell - 1.2) / 1.2 <= 0.15
    eh2, _ = observe(ell[band], 0.03)
    out['boundary_band_1to2'] = {
        'band_def': '|ℓ-1.2|/1.2 ≤ 15%',
        'n': int(band.sum()),
        'acc': float((level_crack(eh2) == truth[band]).mean()),
        'over_rate': float((level_crack(eh2) > truth[band]).mean()),
        'under_rate': float((level_crack(eh2) < truth[band]).mean()),
    }
    return out


# ------------------------- 实验 3：迟滞双阈值 -------------------------
def exp3(n_seq=6000, frames=10, sigma=0.03, deltas=np.arange(0.0, 0.155, 0.005)):
    """
    逐帧独立观测同一病害：单阈值 vs 迟滞双阈值 (θ(1+δ), θ(1-δ))
    指标：状态切换率（抖动）、漏判率（真实 ≥2 级却长时间停留在 1 级）
    """
    theta = 1.2
    ell = np.clip(RNG.normal(theta * 1.05, 0.25, n_seq), 0.3, 3.0)     # 集中在边界附近
    truth2 = level_crack(ell) >= 2
    obs = np.stack([observe(ell, sigma)[0] for _ in range(frames)])     # [frames, n_seq]
    rows = []
    ell0 = ell.copy()
    for delta in deltas:
        hi, lo = theta * (1 + delta), theta * (1 - delta)
        switches, missed = 0, 0
        for i in range(n_seq):
            state = int(ell0[i] >= theta)        # 初始状态：无噪声真值
            for t in range(frames):
                v = obs[t, i]
                if v >= hi:
                    state = 1
                elif v <= lo:
                    state = 0
                if t > 0 and state != int(obs[t - 1, i] >= theta):
                    switches += 1
            if truth2[i] and state == 0:
                missed += 1
        rows.append({'delta': float(delta), 'switch_rate': switches / (n_seq * frames),
                     'miss_rate': missed / n_seq,
                     'cost': switches / (n_seq * frames) + missed / n_seq})
    best = min(rows, key=lambda r: r['cost'])
    return {'n_seq': n_seq, 'frames': frames, 'sigma': sigma, 'theta': theta,
            'rows': rows, 'best_delta': best['delta'], 'best_cost': best['cost'],
            'switch_rate_at_0': rows[0]['switch_rate'],
            'switch_reduction': 1 - best['switch_rate'] / max(rows[0]['switch_rate'], 1e-12)}


# ------------------------- 实验 4：长度—宽度双参数 -------------------------
def exp4(sigma_ell=0.03, sigma_b_list=(0.20, 0.10, 0.05, 0.02),
         alphas=np.arange(0.0, 1.51, 0.025)):
    """
    长度—宽度双参数规则（阈值归一化表述）
    ------------------------------------
    严重度归一：u = ℓ/1.2（长度对 1→2 级阈值），v = b/0.2（缝宽对规范 0.2mm 限值）
    参考等级（规范口径，取主导指标）：S = max(u, v)，L_ref = 1 + #{k∈{1,2,3}: S ≥ k}
    规则 R0（现行，长度单参数）：L = 1 + #{k: u ≥ k}
    规则 R2(α)（双参数）：w = max(u, α·v)，L = 1 + #{k: w ≥ k}；α=1 表示宽度与长度等权
    评价：与 L_ref 的逐样本一致率、RMSE、Spearman 秩相关；
          α* 在"缝宽测量相对误差 σ_b"上做敏感性，回答"缝宽精度到多少才值得引入宽度判据"
    """
    ell, b = population()
    u = ell / 1.2
    v = b / 0.2
    S = np.maximum(u, v)
    L_ref = 1 + (S >= 1).astype(int) + (S >= 2).astype(int) + (S >= 3).astype(int)

    def spearman(x, y):
        rx = np.argsort(np.argsort(x)).astype(float)
        ry = np.argsort(np.argsort(y)).astype(float)
        rx -= rx.mean(); ry -= ry.mean()
        return float((rx * ry).sum() / math.sqrt((rx ** 2).sum() * (ry ** 2).sum()))

    def lv_from(w):
        return 1 + (w >= 1).astype(int) + (w >= 2).astype(int) + (w >= 3).astype(int)

    _, _ = observe(ell, sigma_ell)                      # 保持随机数流一致
    u_hat = observe(ell, sigma_ell)[0] / 1.2

    results = {}
    for sb in sigma_b_list:
        v_hat = np.clip(b * (1 + RNG.normal(0, sb, size=b.shape)), 0.02, None) / 0.2
        rows = []
        for a in alphas:
            w = np.maximum(u_hat, a * v_hat)
            L = lv_from(w)
            rows.append({'alpha': float(a), 'agree': float((L == L_ref).mean()),
                         'rmse': float(np.sqrt(((L - L_ref) ** 2).mean())),
                         'spearman': spearman(L, L_ref)})
        r0 = rows[0]                                     # α=0 即现行长度单参数规则
        best = max(rows, key=lambda r: r['agree'])
        results[f'sigma_b_{sb:.2f}'] = {
            'sigma_b': sb, 'baseline_agree': r0['agree'], 'baseline_rmse': r0['rmse'],
            'best_alpha': best['alpha'], 'best_agree': best['agree'], 'best_rmse': best['rmse'],
            'best_spearman': best['spearman'], 'agree_gain': best['agree'] - r0['agree'],
            'rmse_gain': r0['rmse'] - best['rmse'], 'rows': rows,
        }
    return {'sigma_ell': sigma_ell, 'note': '参考等级由显式假设 S=max(ℓ/1.2, b/0.2) 定义（规范主导指标口径）',
            'by_width_noise': results}


# ------------------------- 实验 5：可信度与复检比例 -------------------------
def exp5(sigma=0.03, z=1.645):
    """落在 90% 可靠判定带（任一阈值 ±zσ）内的样本 = 建议进入人工复检的集合"""
    ell, _ = population()
    thresholds = [1.2, 4.0, 8.0]
    near = np.zeros_like(ell, dtype=bool)
    for th in thresholds:
        lo, hi = th / (1 + z * sigma), th / (1 - z * sigma)
        near |= (ell >= lo) & (ell <= hi)
    return {'sigma': sigma, 'z': z, 'thresholds': thresholds,
            'review_rate': float(near.mean()),
            'band_examples': {str(th): [th / (1 + z * sigma), th / (1 - z * sigma)] for th in thresholds},
            'note': '该比例即"若严格按 95% 单帧可信度执行，需转人工复检的样本占比"；'
                    '系统现行策略（1 级自动闭环、≥2 级必审）等效地把复检率提到 100%，属更保守设定'}


def main():
    report = {'meta': {'n_mc': N, 'image_width': W, 'mm_per_px': MU, 'seed': 20260916,
                       'source': 'tools/math/level_model.py（与 backend/fusion.js 对拍通过）'}}
    report['exp1_2_single_frame'] = exp1_2()
    report['exp3_hysteresis'] = exp3()
    report['exp4_dual_param'] = exp4()
    report['exp5_review_rate'] = exp5()
    with open(os.path.join(OUT, 'simulation_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    e = report['exp1_2_single_frame']
    print('=== 实验 1 单帧判对率（裂缝，n=%d）===' % e['n'])
    print('   σ     判对率   误差≤1级   严重错判(≥2级)')
    for s, a, a1, sv in zip(e['sigma'], e['acc'], e['acc_adj1'], e['severe']):
        print(f'  {s:>5.1%}  {a:>7.2%}  {a1:>8.2%}   {sv:>8.2%}')
    print('=== 实验 2 混淆矩阵（σ=3%，行=真实，列=判定）===')
    for i, row in enumerate(e['cm']['matrix']):
        print(f'  {i+1}级 ' + ' '.join(f'{v:>6d}' for v in row))
    bb = e['boundary_band_1to2']
    print(f"  1↔2 边界带（{bb['band_def']}，n={bb['n']}）：判对 {bb['acc']:.2%}，误升 {bb['over_rate']:.2%}，误降 {bb['under_rate']:.2%}")
    h = report['exp3_hysteresis']
    print('=== 实验 3 迟滞双阈值 ===')
    print(f"  单阈值抖动率 {h['switch_rate_at_0']:.2%} → 最优 δ*={h['best_delta']:.3f} 时 "
          f"{h['rows'][[r['delta'] for r in h['rows']].index(h['best_delta'])]['switch_rate']:.2%}"
          f"（降幅 {h['switch_reduction']:.1%}），漏判率 {h['rows'][[r['delta'] for r in h['rows']].index(h['best_delta'])]['miss_rate']:.2%}")
    d = report['exp4_dual_param']
    print('=== 实验 4 长度—宽度双参数规则（α=1 表示宽度与长度等权）===')
    for key, r in d['by_width_noise'].items():
        print(f"  缝宽相对误差 σ_b={r['sigma_b']:>4.0%} → α*={r['best_alpha']:.3f}，"
              f"一致率 {r['baseline_agree']:.2%} → {r['best_agree']:.2%}（{r['agree_gain']:+.2%}），"
              f"RMSE {r['baseline_rmse']:.4f} → {r['best_rmse']:.4f}（{r['rmse_gain']:+.4f}），"
              f"秩相关 {r['best_spearman']:.4f}")
    v = report['exp5_review_rate']
    print('=== 实验 5 复检比例 ===')
    print(f"  严格 95% 可信度下需复检样本占比 {v['review_rate']:.2%}（σ=3%）")
    return report


if __name__ == '__main__':
    main()
