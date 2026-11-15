# -*- coding: utf-8 -*-
"""
向 aic_report/隧途明鉴-AIC技术报告.docx 批量插入插图
----------------------------------------------------
· 严格自下而上（idx 由大到小）插入，保证先前算好的偏移不被后续插入破坏
· 每个插入点：doc_insert_image → doc_insert_paragraph（补段落分隔符）→ 图注段落
· 所有调用经 tencent-local-office-edit 的 edsdk.py（本地 editor_sdk MCP）
"""
import json
import os
import subprocess
import sys

EDSDK_DIR = r'D:\LenovoSoftstore\Install\WorkBuddy\resources\app.asar.unpacked\resources\plugins\workbuddy-builtin\skills\tencent-local-office-edit'
EDS = os.path.join(EDSDK_DIR, 'edsdk.py')
ROOT = r'C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system'
FILE_ID = '2fab26ec-dc9d-45f6-87e7-2a7463cbe3ce'

A = os.path.join(ROOT, 'docs', 'report_figs')
D = os.path.join(ROOT, 'docs')
U = os.path.join(ROOT, 'output', 'ppt_projects', '隧途明鉴-技术路线汇报', 'assets')

# (idx, 图片绝对路径, 宽度px, 图注)  —— 按 idx 降序执行
SITES = [
    (17844, os.path.join(D, '消融实验.png'), 560,
     '图 7-1　特征组消融实验：逐组留一重训对比（去除边缘纹理组 F1 下降 5.1 个百分点），验证特征设计的有效性'),
    (6400, os.path.join(D, '界面-检测工作台-展开.png'), 600,
     '图 3-8　检测工作台（真实界面）：六轨工位全流程闭环，检出框、等级、置信度与整治建议同步呈现'),
    (6260, os.path.join(A, 'fig-dataset.png'), 600,
     '图 3-7　真实隧道病害数据集样例（330 组，含 YOLO 真值标注，框色对应类别）'),
    (5787, os.path.join(D, 'arc-08-lab2kg-wide.png'), 600,
     '图 3-6　隧道病害知识图谱：3D 知识球与「识别→定级→成因→危害→方案」闭环推理（123 实体 / 211 关系，8 部规范条款溯源）'),
    (5374, os.path.join(A, 'fig-synthetic.png'), 600,
     '图 3-5　病害样本合成器产出：裁剪羽化 + 透视/光度扰动 + 噪声，单次批量 20~50 张，全链路标注 synthetic 并与实测数据隔离'),
    (5108, os.path.join(D, '界面-病害档案-展开(玻璃透视).png'), 600,
     '图 3-4　可解释 AI 教学展示（真实界面）：分步 CV 中间图 + 判定依据热力图 + 检测框与等级标注'),
    (4591, os.path.join(A, 'fig-pipeline.png'), 620,
     '图 3-3　检测—分析—审核—报告 全流程闭环：采集 → 预处理 → 特征融合 → 类型识别 → 量测分级 → 人工复核 → 报告与图谱'),
    (3557, os.path.join(A, 'fig-arch.png'), 600,
     '图 3-1　系统五层总体架构（展示层 / 应用层 / 算法层 / 知识层 / 数据层）'),
    (3557, os.path.join(D, '界面-正圆轨道.png'), 600,
     '图 3-2　六轨工位视图（真实界面）：检测工作台、视图、病害档案、人工复核、统计报告、知识图谱'),
    (505, os.path.join(U, 'tunnel_hero.png'), 600,
     '图 1-1　公路隧道运营场景：存量 28,724 处、养护里程超 6.3 万公里，人工巡检难以为继，数字化检测需求迫切'),
]


def call(tool, args):
    """经 edsdk.py 调用工具，参数走临时 JSON 文件避免中文/引号转义问题"""
    tmp = os.path.join(EDSDK_DIR, '_args_tmp.json')
    with open(tmp, 'w', encoding='utf-8') as f:
        json.dump(args, f, ensure_ascii=False)
    r = subprocess.run([sys.executable, EDS, 'call', tool, '--json-file', tmp],
                       capture_output=True, text=True, encoding='utf-8', cwd=EDSDK_DIR)
    out = (r.stdout or '').strip().splitlines()
    try:
        return json.loads(out[-1]) if out else {}
    except Exception:
        return {'raw': r.stdout, 'err': r.stderr}


def insert_site(idx, img, w, caption):
    res = call('doc_insert_image', {'file_id': FILE_ID, 'idx': idx, 'image_path': img, 'w': w})
    if 'image_url' not in res:
        print('  ✗ image failed:', res)
        return False
    p = res.get('last_edit_index') or res.get('position')
    br = call('doc_insert_paragraph', {'file_id': FILE_ID, 'idx': p})
    n = br.get('next_index', p)
    cap = call('doc_insert_paragraph_with_text', {'file_id': FILE_ID, 'idx': n, 'text': caption})
    ok = bool(cap.get('next_index') or cap.get('position'))
    print(f"  {'✓' if ok else '✗'} idx={idx} w={w} → {os.path.basename(img)}　|　{caption[:34]}…")
    return ok


def main():
    total = 0
    for idx, img, w, caption in SITES:
        if not os.path.exists(img):
            print('  ! missing file:', img); continue
        if insert_site(idx, img, w, caption):
            total += 1
    print(f'\n插入完成：{total}/{len(SITES)} 处')


if __name__ == '__main__':
    main()
