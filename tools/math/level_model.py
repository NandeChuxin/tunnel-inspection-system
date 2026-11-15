# -*- coding: utf-8 -*-
"""
隧途明鉴 · 病害危险等级数学模型
=================================
本模块把 backend/fusion.js 的 `gradeDefect`（规范物理量分级）与标定映射 `mmPerPx`
抽象为可分析的数学对象，供临界条件推导、敏感性分析与蒙特卡洛仿真使用。

对应关系（与系统实现 1:1，逐行对齐）：
    fusion.js:185   mmPerPx(imageW)      ->  mm_per_px(W)
    fusion.js:187   subtypeOf(...)       ->  crack_subtype(orientation)
    fusion.js:208   gradeDefect(...)     ->  level_of(...)
    fusion.js:76    DETECT_THRESHOLD     ->  DETECT_THRESHOLD
    fusion.js:27    VIEW_WIDTH_M = 3.5   ->  VIEW_WIDTH_M

符号约定：
    W   图像宽度（像素），默认 640
    μ(W) 标定系数 mm/px，μ = 3500 / W
    ℓ   裂缝长度（m）      A   面状病害面积（m²）      g  错台量（mm）
    L   危险等级 ∈ {1,2,3,4}
"""

import math

# ------------------------- 系统常数（取自真实代码） -------------------------
VIEW_WIDTH_M = 3.5              # fusion.js:27  单帧视场宽度 3.5 m
DETECT_THRESHOLD = 0.55         # fusion.js:76  类型置信度阈值
CROWN_SECTORS = ('拱顶', '左拱腰', '右拱腰')   # fusion.js:209 拱部从严

# 分级阈值表（fusion.js:214-248 逐条抽取）
CRACK_LEN_THRESHOLDS = ((8.0, 4), (4.0, 3), (1.2, 2))          # (长度 m, 等级)
SEEP_THRESHOLDS = {                                            # (面积 m², 等级)
    'crown':  ((0.8, 3), (0.2, 2)),
    'normal': ((2.0, 3), (0.5, 2)),
}
SPALL_THRESHOLDS = {
    'crown':  ((0.5, 4), (0.15, 3), (0.0, 2)),                 # 拱部：任意面积即 ≥2 级
    'normal': ((1.5, 4), (0.5, 3), (0.1, 2)),
}
GAP_THRESHOLDS = ((15.0, 4), (8.0, 3), (3.0, 2))               # mm
WHITE_THRESHOLDS = ((1.0, 2),)                                 # 白华：最多 2 级

LEVEL_TEXT = {1: '1级-轻微', 2: '2级-中等', 3: '3级-严重', 4: '4级-危及安全'}
DEFECT_TYPES = ('裂缝', '渗漏水', '剥落掉块', '衬砌错台', '白华析出')


# ------------------------- 1. 标定与量测泛函 -------------------------
def mm_per_px(image_w=640):
    """标定系数 μ(W) = VIEW_WIDTH_M·1000 / W  [mm/px]"""
    w = image_w or 640
    return VIEW_WIDTH_M * 1000.0 / w


def crack_subtype(orientation):
    """fusion.js:187 走向→亚型（horizontal=纵向裂缝 沿轴向；vertical=环向裂缝）"""
    if orientation == 'horizontal':
        return '纵向裂缝'
    if orientation == 'vertical':
        return '环向裂缝'
    return '斜向裂缝'


def crack_length_m(width_px, length_px, image_w=640):
    """裂缝长度泛函 ℓ = max(w_px, l_px)·μ(W)/1000  [m]"""
    return max(width_px, length_px) * mm_per_px(image_w) / 1000.0


def area_m2(width_px, length_px, image_w=640):
    """面状病害面积泛函 A = w_px·l_px·μ(W)²/10⁶  [m²]"""
    mu = mm_per_px(image_w)
    return width_px * length_px * mu * mu / 1e6


# ------------------------- 2. 等级函数 L（分段常值） -------------------------
def _step_lookup(q, table):
    """右连续阶梯查表：返回满足 q ≥ θ_k 的最大等级（无命中则 1）"""
    lv = 1
    for theta, level in sorted(table, key=lambda t: -t[0]):
        if q >= theta:
            lv = max(lv, level)
            break
    return lv


def level_of(dtype, *, sector='右边墙', subtype=None, length_m=None,
             area=None, gap_mm=0.0, width_px=None, length_px=None, image_w=640):
    """
    规范物理量分级（fusion.js:208 的 Python 等价实现）

    返回 (L, 说明字典)；L ∈ {1,2,3,4}
    """
    crown = sector in CROWN_SECTORS
    info = {'sector': sector, 'crown': crown}

    if dtype == '裂缝':
        if length_m is None:
            length_m = crack_length_m(width_px, length_px, image_w)
        lv = _step_lookup(length_m, CRACK_LEN_THRESHOLDS)
        st = subtype or '环向裂缝'
        if st == '纵向裂缝' and lv < 4:
            lv += 1                       # 纵向裂缝：轴向受力最不利，从严一级
            info['strict_shift'] = +1
        info.update({'measure': '长度', 'value': length_m, 'unit': 'm', 'subtype': st})
    elif dtype == '渗漏水':
        st = subtype or '渗水'
        if st == '涌水':
            info.update({'measure': '面积', 'value': area, 'unit': 'm²', 'subtype': st})
            return 4, info
        lv = _step_lookup(area, SEEP_THRESHOLDS['crown' if crown else 'normal'])
        info.update({'measure': '面积', 'value': area, 'unit': 'm²', 'subtype': st})
    elif dtype == '剥落掉块':
        lv = _step_lookup(area, SPALL_THRESHOLDS['crown' if crown else 'normal'])
        info.update({'measure': '面积', 'value': area, 'unit': 'm²', 'subtype': '掉块' if (area or 0) >= 0.2 else '表层剥落'})
    elif dtype == '衬砌错台':
        lv = _step_lookup(gap_mm, GAP_THRESHOLDS)
        info.update({'measure': '错台量', 'value': gap_mm, 'unit': 'mm', 'subtype': '环向错台'})
    elif dtype == '白华析出':
        lv = _step_lookup(area, WHITE_THRESHOLDS)
        info.update({'measure': '面积', 'value': area, 'unit': 'm²', 'subtype': '钙质析出'})
    else:
        raise ValueError(f'未知病害类型: {dtype}')

    return min(4, lv), info


# ------------------------- 3. 连续化危险指数（平滑替代） -------------------------
def logistic(x):
    return 1.0 / (1.0 + math.exp(-x))


def severity_index(q, thresholds, s=0.05, base=1.0):
    """
    连续危险指数 D(q) = base + Σ_k σ((q-θ_k)/s)
    - 当 s→0 时 D(q) → L(q)（阶梯函数的平滑逼近）
    - Lipschitz 常数上界 L_c = n / (4s)（n 为阈值个数）
    """
    return base + sum(logistic((q - th) / s) for th, _ in thresholds)


def severity_derivative(q, thresholds, s=0.05):
    """D'(q) = Σ σ'((q-θ_k)/s)/s = Σ σ(·)(1-σ(·))/s"""
    total = 0.0
    for th, _ in thresholds:
        z = logistic((q - th) / s)
        total += z * (1 - z) / s
    return total


# ------------------------- 4. 测量不确定性模型 -------------------------
def normal_cdf(x):
    return 0.5 * (1.0 + math.erf(x / math.sqrt(2.0)))


def threshold_cross_prob(q, theta, sigma_rel):
    """
    相对误差模型 q̂ = q(1+ε), ε~N(0,σ²) 时，观测值跨越阈值 θ 的概率
        P(q̂ ≥ θ) = Φ( (q-θ) / (σ·q) )
    """
    if q <= 0 or sigma_rel <= 0:
        return 1.0 if q >= theta else 0.0
    return normal_cdf((q - theta) / (sigma_rel * q))


def misgrade_prob_at_boundary(q, theta, sigma_rel):
    """单阈值处的"取错侧"概率（0.5 为最坏，出现在 q=θ 处）"""
    p = threshold_cross_prob(q, theta, sigma_rel)
    return min(p, 1.0 - p)


def uncertainty_band(theta, sigma_rel, k=3.0):
    """kσ 判定不确定带 [(1-kσ)θ, (1+kσ)θ]：带内单帧判定不可靠"""
    return theta * (1 - k * sigma_rel), theta * (1 + k * sigma_rel)


# ------------------------- 5. 临界条件闭式解 -------------------------
def critical_px_for_length(length_m, image_w=640):
    """给定目标长度阈值 ℓ*，反解所需像素长度 max(w_px,l_px)* = ℓ*·W / 3.5"""
    return length_m * image_w / VIEW_WIDTH_M


def critical_px2_for_area(area_m2_val, image_w=640):
    """给定面积阈值 A*，反解所需像素面积积 w_px·l_px ≥ A*·10⁶/μ²"""
    mu = mm_per_px(image_w)
    return area_m2_val * 1e6 / (mu * mu)


def critical_conditions(dtype, sector='右边墙', subtype=None):
    """输出某病害"1 级 → 2 级"的临界条件（闭式）"""
    crown = sector in CROWN_SECTORS
    if dtype == '裂缝':
        st = subtype or '环向裂缝'
        if st == '纵向裂缝':
            return {'critical': 0.0, 'unit': 'm', 'reason': '纵向裂缝 +1 级从严 → 1 级不可达'}
        return {'critical': 1.2, 'unit': 'm'}
    if dtype == '渗漏水':
        return {'critical': 0.2 if crown else 0.5, 'unit': 'm²'}
    if dtype == '剥落掉块':
        return {'critical': 0.0 if crown else 0.1, 'unit': 'm²',
                'reason': '拱部任意面积即 ≥2 级' if crown else None}
    if dtype == '衬砌错台':
        return {'critical': 3.0, 'unit': 'mm'}
    if dtype == '白华析出':
        return {'critical': 1.0, 'unit': 'm²', 'reason': '白华最高仅 2 级'}
    raise ValueError(dtype)
