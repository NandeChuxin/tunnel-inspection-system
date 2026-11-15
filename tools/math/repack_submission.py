# -*- coding: utf-8 -*-
"""
重建参赛交付压缩包
==================
1) 参赛材料/02-源代码与模型/source-code.zip
   · 文件清单 = 旧 zip 清单 ∩ 当前仓库（自动带上全部修复）
   · 剔除 5 个已废弃 prototype（唯一正式方案 prototype-holo-core.html）
   · 新增：backend/seed-demo.js、backend/data/train/eval-metrics.json、运行说明-README.txt
2) 同步 参赛材料/01-技术方案素材/技术方案-隧途明鉴.md ← docs 版
3) 源代码整理/：刷新 train-train.js 摘录注释，重建 源码包-当前版本.zip
"""
import os
import shutil
import zipfile

ROOT = r'C:\Users\17355\.zcode\workspace\default\tunnel-inspection-system'
SRC_ZIP = os.path.join(ROOT, '参赛材料', '02-源代码与模型', 'source-code.zip')
SRC_EXCERPT_DIR = os.path.join(ROOT, '源代码整理')
SRC_EXCERPT_ZIP = os.path.join(SRC_EXCERPT_DIR, '源码包-当前版本.zip')
TECH_DOC = os.path.join(ROOT, 'docs', '技术方案-隧途明鉴.md')
TECH_COPY = os.path.join(ROOT, '参赛材料', '01-技术方案素材', '技术方案-隧途明鉴.md')
DEPRECATED = {f'docs/prototype-{n}.html' for n in
              ('glass-tailwind', 'industrial-console', 'review-console', 'tunnel-board', 'tunnel-hud')}
ADD_FILES = {
    'backend/seed-demo.js',
    'backend/data/train/eval-metrics.json',
}
RUN_NOTE = """【隧途明鉴 · 源代码运行说明】（2026-09-16 重建包）

一、运行要求
  · Node.js >= 22.5（使用内置 node:sqlite，零第三方依赖，无需 npm install）
  · 操作系统：Windows / macOS / Linux 均可

二、一键运行
  1. 解压本包，进入包根目录
  2. 运行：node backend/server.js
  3. 浏览器打开 http://localhost:8787 （前端页面即由本服务托管）

三、首次启动自动完成（开箱即用）
  · 建表：SQLite 10 张公共表（tunnel/image/detection/.../kg_entity/kg_relation）
  · 播种：分级知识库 5 类×4 级（20 套处置方案）+ 演示账号 admin/teacher/student（口令 123456）
          + 知识图谱本体（123 实体 / 211 关系，8 部规范条款溯源）
  · 演示数据：库为空时自动用内置合成样本走真实推理链路入库（来源标记「演示播种」，可整批删除），
    病害档案 / 样本库 / 统计 / 人工复核 开箱即有数据

四、模型权重与数据（如实说明）
  · backend/data/model_params.json —— 自研 softmax 学习引擎权重（15 维 ROI 特征，
    端到端病害 F1 85.8%），服务启动自动注入；未注入时自动回退规则引擎
  · backend/data/train/metrics.json / eval-metrics.json —— 训练与端到端评测指标
  · YOLOv8n 权重不在本包内：其训练/评测在独立 Ultralytics 环境完成（330 组外部数据集，
    见 yolo-workspace/），当前冒烟权重未收敛，不作成果提交；正式权重经 detector.js（ONNX）接入
  · 训练数据可一键再生：node backend/train/gen-dataset.js --count 480 --seed 2026

五、诚实性边界（评审请重点核对）
  · 生产判定链路 = 规则引擎（知识驱动）+ 自研 softmax 学习模型（非 CNN）
  · YOLOv8n 未接入生产推理（detector.js 为占位接入点，见文件头声明）
  · 热力图默认 Eigen-CAM（无梯度依赖）；Grad-CAM 形态为接口预留
  · 等级定级以规范物理量分级为准（等级子模型 36.6% 仅作参考，见 metrics.json）
"""


def rebuild_source_zip():
    old = zipfile.ZipFile(SRC_ZIP)
    names = [n for n in old.namelist() if n not in DEPRECATED and not n.endswith('/')]
    old.close()
    items, missing = [], []
    for n in names:
        fp = os.path.join(ROOT, n.replace('/', os.sep))
        if os.path.isfile(fp):
            items.append((n, fp))
        else:
            missing.append(n)
    for n in ADD_FILES:
        fp = os.path.join(ROOT, n.replace('/', os.sep))
        if os.path.isfile(fp):
            items.append((n, fp))
        else:
            missing.append(n)
    tmp = SRC_ZIP + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        z.writestr('运行说明-README.txt', RUN_NOTE)
        for n, fp in sorted(items):
            z.write(fp, n)
    os.replace(tmp, SRC_ZIP)
    return len(items) + 1, missing


def sync_tech_doc():
    shutil.copyfile(TECH_DOC, TECH_COPY)
    return os.path.getsize(TECH_COPY)


def refresh_excerpt_zip():
    """源代码整理/01-检测方向/代码/train-train.js 摘录与当前 train.js 对齐（仅注释段已变）"""
    import re
    excerpt = os.path.join(SRC_EXCERPT_DIR, '01-检测方向', '代码', 'train-train.js')
    real = os.path.join(ROOT, 'backend', 'train', 'train.js')
    if os.path.exists(excerpt) and os.path.exists(real):
        cur = open(real, encoding='utf-8').read()
        m = re.search(r'// 等级子模型不注入运行态：.*?供后续改进。', cur, re.S)
        if m:
            ex = open(excerpt, encoding='utf-8').read()
            ex2 = re.sub(r'// 等级子模型不注入运行态：.*?供后续改进。', m.group(0), ex, flags=re.S)
            open(excerpt, 'w', encoding='utf-8').write(ex2)
    # 重建 zip（排除 zip 本身）
    tmp = SRC_EXCERPT_ZIP + '.tmp'
    with zipfile.ZipFile(tmp, 'w', zipfile.ZIP_DEFLATED) as z:
        for root, dirs, files in os.walk(SRC_EXCERPT_DIR):
            dirs[:] = [d for d in dirs if d != '__pycache__']
            for f in files:
                fp = os.path.join(root, f)
                arc = os.path.relpath(fp, SRC_EXCERPT_DIR).replace(os.sep, '/')
                if arc == '源码包-当前版本.zip':
                    continue
                z.write(fp, arc)
    os.replace(tmp, SRC_EXCERPT_ZIP)
    return sum(1 for _ in zipfile.ZipFile(SRC_EXCERPT_ZIP).namelist())


def main():
    n, missing = rebuild_source_zip()
    print(f'source-code.zip 重建：{n} 文件', ('| 缺失: ' + ', '.join(missing)) if missing else '| 无缺失')
    print('技术方案副本同步:', sync_tech_doc(), 'bytes')
    print('源码包-当前版本.zip:', refresh_excerpt_zip(), 'files')
    z = zipfile.ZipFile(SRC_ZIP)
    assert 'backend/seed-demo.js' in z.namelist() and 'backend/data/model_params.json' in z.namelist()
    head = z.read('backend/train/train.js').decode('utf-8')
    assert '36.6%' in head and '~20%' not in head, 'train.js 旧口径仍在包内'
    proto = z.read('docs/prototype-holo-core.html').decode('utf-8')
    assert 'Modules.openLib' in proto and 'setMask' in proto and '/api/report/excel' in proto
    assert 'docs/prototype-glass-tailwind.html' not in z.namelist()
    print('包内抽检：seed-demo/权重/新口径 train.js/原型三修复/废弃原型剔除 —— 全部到位')
    print('source-code.zip:', round(os.path.getsize(SRC_ZIP) / 1024), 'KB |',
          '源码包-当前版本.zip:', round(os.path.getsize(SRC_EXCERPT_ZIP) / 1024), 'KB')


if __name__ == '__main__':
    main()
