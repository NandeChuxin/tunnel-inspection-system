# -*- coding: utf-8 -*-
"""
临界条件与敏感性分析
====================
回答三个问题：
  Q1  "裂缝/病害在什么参数下由 1 级变 2 级" —— 临界条件闭式解
  Q2  判定的可信边界在哪 —— 分辨率极限 + 测量误差导致的误判概率
  Q3  哪些规则存在结构性退化 —— 阈值/修正算子的退化点

输出：tools/math/out/critical_report.json
"""
import json
import math
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, 'out')
sys.path.insert(0, HERE)
import level_model as M  # noqa: E402

os.makedirs(OUT, exist_ok=True)
IMG_WIDTHS = (320, 640, 1280, 1920)


def boundary_table():
    """Q1：各类病害 1→2 级的物理量阈值 ∩ 像素空间临界值"""
    rows = []
    for sector, tag in (('右边墙', '边墙/仰拱'), ('拱顶', '拱部(从严)')):
        for dtype in M.DEFECT_TYPES:
            if dtype == '裂缝':
                for st in ('斜向裂缝', '环向裂缝', '纵向裂缝'):
                    cc = M.critical_conditions(dtype, sector, st)
                    px = {W: M.critical_px_for_length(cc['critical'], W) for W in IMG_WIDTHS} \
                        if cc['critical'] > 0 else {W: 0.0 for W in IMG_WIDTHS}
                    rows.append({
                        'type': dtype, 'sector': tag, 'subtype': st,
                        'critical_value': cc['critical'], 'unit': cc['unit'],
                        'critical_px': {str(k): v for k, v in px.items()},
                        'note': cc.get('reason'),
                    })
                continue
            cc = M.critical_conditions(dtype, sector)
            px2 = {W: M.critical_px2_for_area(cc['critical'], W) for W in IMG_WIDTHS} \
                if cc['critical'] > 0 else {W: 0.0 for W in IMG_WIDTHS}
            rows.append({
                'type': dtype, 'sector': tag, 'subtype': '—',
                'critical_value': cc['critical'], 'unit': cc['unit'],
                'critical_px2': {str(k): v for k, v in px2.items()},
                'note': cc.get('reason'),
            })
    return rows


def threshold_levels(dtype, sector='右边墙', subtype=None):
    """列出该类型全部等级阈值（用于台阶图/敏感性）"""
    crown = sector in M.CROWN_SECTORS
    if dtype == '裂缝':
        st = subtype or '环向裂缝'
        base = [th for th, _ in M.CRACK_LEN_THRESHOLDS]
        if st == '纵向裂缝':
            return sorted([0.0] + base)          # +1 级从严 → 阈值整体左移一档
        return sorted(base)
    if dtype == '渗漏水':
        return sorted(th for th, _ in M.SEEP_THRESHOLDS['crown' if crown else 'normal'])
    if dtype == '剥落掉块':
        return sorted(th for th, _ in M.SPALL_THRESHOLDS['crown' if crown else 'normal'])
    if dtype == '衬砌错台':
        return sorted(th for th, _ in M.GAP_THRESHOLDS)
    if dtype == '白华析出':
        return sorted(th for th, _ in M.WHITE_THRESHOLDS)
    raise ValueError(dtype)


def sensitivity_analysis():
    """
    Q2-a：把物理量临界阈值换算为像素临界值，并对图像宽度 W 求灵敏度。
        ℓ* 固定时  maxPx* = ℓ*·W/3.5   →  d(maxPx*)/dW = ℓ*/3.5 = 0.3429 [px/px]（线性）
        A* 固定时  (w·l)* = A*·W²/12.25 →  d/dW = 2A*·W/12.25（二次放大）
    """
    res = {}
    crack = 1.2
    res['crack_1to2'] = {
        'threshold_m': crack,
        'd_px_dW': crack / M.VIEW_WIDTH_M,
        'values': {str(W): crack * W / M.VIEW_WIDTH_M for W in IMG_WIDTHS},
        'resolution_mm_per_px': {str(W): M.mm_per_px(W) for W in IMG_WIDTHS},
        'relerr_at_threshold': {str(W): M.mm_per_px(W) / (crack * 1000) for W in IMG_WIDTHS},
    }
    seep = 0.5
    res['seep_1to2'] = {
        'threshold_m2': seep,
        'values': {str(W): seep * W * W / 12.25 for W in IMG_WIDTHS},
        'sqrt_equivalent_px': {str(W): math.sqrt(seep * W * W / 12.25) for W in IMG_WIDTHS},
    }
    return res


def noise_analysis(sigmas=(0.01, 0.02, 0.03, 0.05, 0.08, 0.10, 0.15)):
    """
    Q2-b：相对测量误差 σ 下的判定可靠性
      · 阈值点 q=θ：P(跨阈)=0.5（最坏情形，与 σ 无关）
      · 90% 可靠判定带：q 落在 [θ(1-z·σ), θ(1+z·σ)]（z=1.645）内时，
        单帧判定的"取错侧"概率 > 5% —— 带宽随 σ 线性增长，是调参的直接依据
      · 偏离阈值时的误判概率：随 σ 急剧变化（给出比值表）
    """
    z = 1.645      # 90% 置信（双侧各 5%）
    curves = {}
    for dtype, theta, unit in (('裂缝(1→2)', 1.2, 'm'), ('渗漏水(1→2)', 0.5, 'm²'),
                               ('剥落掉块(1→2)', 0.1, 'm²'), ('衬砌错台(1→2)', 3.0, 'mm'),
                               ('裂缝(2→3)', 4.0, 'm')):
        curves[dtype] = {
            'theta': theta, 'unit': unit,
            'sigma': list(sigmas),
            'p_mis_at_theta': [M.misgrade_prob_at_boundary(theta, theta, s) for s in sigmas],
            'band90_low': [theta / (1 + z * s) for s in sigmas],
            'band90_high': [theta / (1 - z * s) for s in sigmas],
            'band_width_abs': [theta / (1 - z * s) - theta / (1 + z * s) for s in sigmas],
            'band_width_rel': [(theta / (1 - z * s) - theta / (1 + z * s)) / theta for s in sigmas],
        }
    # σ=3% 时，q/θ 取不同比值的误判概率（"偏离多少才安全"）
    rel = {}
    for ratio in (0.85, 0.90, 0.95, 0.99, 1.0, 1.01, 1.05, 1.10, 1.15):
        rel[f'{ratio:.2f}'] = {str(s): M.misgrade_prob_at_boundary(1.2 * ratio, 1.2, s)
                               for s in (0.02, 0.03, 0.05, 0.10)}
    return {'reliability_band_z1.645': curves, 'by_ratio_theta_1.2m': rel}


def degeneracy_analysis():
    """Q3：结构性退化清单（阈值/修正算子导致的等级不可达或强制升级）"""
    return [
        {'item': '裂缝 · 纵向裂缝', 'property': 'L ≥ 2 恒成立',
         'cause': 'lv < 4 时 +1 级从严，而 lv ≥ 1 → 1 级被"抬出"可达域',
         'risk': '纵向裂缝无法表达"轻微（1 级）"，1→2 级临界退化为 ℓ* = 0',
         'suggest': '从严算子改为"仅在 lv≥2 时 +1"或对纵向单独下调长度阈值（等效阈值平移）'},
        {'item': '剥落掉块 · 拱部', 'property': 'L ≥ 2 恒成立（阈值 θ = 0）',
         'cause': '判据 `else if (areaM2 >= 0.1 || crown) lv = 2` 中 crown 为真即升级',
         'risk': '拱部剥落无法表达 1 级；且面积阈值在 0 处不连续，测量噪声直接触发升级',
         'suggest': '给拱部设最小面积阈（如 0.02 m²）以留出 1 级可达域'},
        {'item': '白华析出', 'property': 'L ∈ {1,2}，最高 2 级',
         'cause': '判据仅一条阈值 1.0 m²（指示性病害，不单独定重级）',
         'risk': '与知识图谱"白华指示渗水通道"的口径一致，属有意设计；需在报告模板中说明',
         'suggest': '维持，但在监测中把白华作为"渗漏子证据"参与其他类型的等级证据链'},
        {'item': '面积型判据的浮点敏感性', 'property': '阈值处对浮点结合序敏感',
         'cause': 'JS 实现为 (w·μ)·(l·μ)/1e6，Python 复核为 (w·l)·(μ²)/1e6，末位不同',
         'risk': '面积恰为 θ 时可能出现 1 级/2 级不一致（实测 1.0 m² 白华即命中）',
         'suggest': '阈值比较引入相对容差 1e-9（或统一按物理量毫米整数比较）'},
    ]


def main():
    report = {
        'meta': {
            'view_width_m': M.VIEW_WIDTH_M, 'detect_threshold': M.DETECT_THRESHOLD,
            'image_widths': list(IMG_WIDTHS),
            'source': 'backend/fusion.js gradeDefect / mmPerPx（常数与阈值逐行抽取）',
        },
        'q1_boundary_table': boundary_table(),
        'q2a_sensitivity': sensitivity_analysis(),
        'q2b_noise': noise_analysis(),
        'q3_degeneracy': degeneracy_analysis(),
    }
    with open(os.path.join(OUT, 'critical_report.json'), 'w', encoding='utf-8') as f:
        json.dump(report, f, ensure_ascii=False, indent=1)

    print('=== Q1 1→2 级临界条件 ===')
    for r in report['q1_boundary_table']:
        if r['critical_value'] == 0:
            print(f"  {r['type']:6s} {r['sector']:10s} {r['subtype']:6s} → 临界 0（{r['note']}）")
        elif 'critical_px' in r:
            px = r['critical_px']['640']
            print(f"  {r['type']:6s} {r['sector']:10s} {r['subtype']:6s} → 临界 {r['critical_value']}{r['unit']}"
                  f"，W=640 时 {px:.1f}px")
        else:
            print(f"  {r['type']:6s} {r['sector']:10s} → 临界 {r['critical_value']}{r['unit']}"
                  f"，W=640 时像素积 {r['critical_px2']['640']:.0f}px²（等效边长 {math.sqrt(r['critical_px2']['640']):.0f}px）")
    print('=== Q2a 灵敏度（裂缝 1.2 m 临界像素长度）===')
    for W, v in report['q2a_sensitivity']['crack_1to2']['values'].items():
        re_ = report['q2a_sensitivity']['crack_1to2']['relerr_at_threshold'][W]
        print(f"  W={W:>4}px → 临界 {v:.1f}px，标定 {M.mm_per_px(int(W)):.3f} mm/px，1px 量化引入相对不确定度 {re_*100:.3f}%")
    print('=== Q2b 判定可靠性（σ = 物理量测量的相对误差）===')
    for name, c in report['q2b_noise']['reliability_band_z1.645'].items():
        print(f"  {name}（θ={c['theta']}{c['unit']}）")
        for s, w, wr in zip(c['sigma'], c['band_width_abs'], c['band_width_rel']):
            print(f"      σ={s:>4.0%} → 90% 可靠判定带宽 {w:.4g}{c['unit']}（相对 θ 的 {wr:.1%}）")
    print('  —— 偏离阈值时的误判概率（θ=1.2m）——')
    for ratio, d in report['q2b_noise']['by_ratio_theta_1.2m'].items():
        print(f"      q/θ={ratio}: " + ' '.join(f"σ={k}:{v:.1%}" for k, v in d.items()))
    print('=== Q3 结构性退化 ===')
    for d in report['q3_degeneracy']:
        print(f"  · {d['item']}：{d['property']} —— {d['cause']}")
    return report


if __name__ == '__main__':
    main()
