# -*- coding: utf-8 -*-
"""
把「八、数学建模与参数临界条件分析-技术路线插入版.md」构建为可复制粘贴的 Word 文档
----------------------------------------------------------------------------------
S2（版式）：按 business-modern 设计令牌生成 HTML（与《技术路线》Word 同一套视觉，粘贴后风格原生）
          · 图片 base64 内嵌（复制到 Word 时图片随行带走）
          · LaTeX 公式转为 Unicode 公式行（Word 中为普通文本，便于粘贴与二次编辑）
S3（转换）：调用 html-to-docx 引擎产出 .docx
"""
import base64
import html as html_mod
import os
import re
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
ROOT = os.path.abspath(os.path.join(HERE, '..', '..'))
MD = os.path.join(ROOT, 'docs', '八、数学建模与参数临界条件分析-技术路线插入版.md')
DOCX = os.path.join(ROOT, 'docs', '八-数学建模与参数临界条件分析-插入版.docx')
HTML_OUT = os.path.join(ROOT, 'output', 'math_insert', 'technical-route-math-chapter.html')
PY = r'C:\Users\17355\.workbuddy\binaries\python\envs\htmldocx\Scripts\python.exe'
CONVERTER_CWD = r'C:\Users\17355\.workbuddy\plugins\cache\workbuddy-builtin\tencent-docx\5.5.6-wb.38337834.g5f969292.h4918b5ced607\skills\html-to-docx\scripts'
IMG_DIR = os.path.join(ROOT, 'docs', 'math')

# ---------------- LaTeX → Unicode（供 Word 粘贴后仍可读可编辑） ----------------
CMD = {
    r'\Gamma': 'Γ', r'\tau': 'τ', r'\ell': 'ℓ', r'\mu': 'μ', r'\theta': 'θ', r'\sigma': 'σ',
    r'\pi': 'π', r'\Pi': 'Π', r'\eta': 'η', r'\lambda': 'λ', r'\phi': 'φ', r'\psi': 'ψ',
    r'\varepsilon': 'ε', r'\alpha': 'α', r'\delta': 'δ', r'\rho': 'ρ', r'\Phi': 'Φ',
    r'\mathcal N': 'N', r'\mathcal T': 'T', r'\mathcal W': 'W', r'\mathcal': '',
    r'\ge': '≥', r'\le': '≤', r'\ne': '≠', r'\to': '→', r'\Rightarrow': '⇒', r'\iff': '⇔',
    r'\in': '∈', r'\sim': '∼', r'\max': 'max', r'\min': 'min', r'\sum': 'Σ', r'\partial': '∂',
    r'\times': '×', r'\approx': '≈', r'\cdot': '·', r'\equiv': '≡', r'\sqrt': '√',
    r'\mathrm': '', r'\mathbb': '', r'\mathbf 1': '𝟙', r'\arg\max': 'arg max', r'\qquad': '    ', r'\quad': '  ',
    r'\pm': '±', r'\mp': '∓', r'\infty': '∞', r'\cdots': '⋯', r'\ldots': '…', r'\propto': '∝',
    r'\subset': '⊂', r'\forall': '∀', r'\exists': '∃', r'\neg': '¬', r'\land': '∧', r'\lor': '∨',
    r'\bigl': '', r'\bigr': '', r'\Bigl': '', r'\Bigr': '', r'\big': '', r'\Big': '',
    r'\text': '', r'\left': '', r'\right': '', r'\\': ' ',
}
SUP = str.maketrans('0123456789+-()n', '⁰¹²³⁴⁵⁶⁷⁸⁹⁺⁻⁽⁾ⁿ')
SUB = str.maketrans('0123456789kij', '₀₁₂₃₄₅₆₇₈₉ₖᵢⱼ')


def _balanced(s, i):
    """读取从 s[i]=='{' 起的平衡花括号内容，返回 (内容, 结束位置)"""
    depth, buf = 0, []
    while i < len(s):
        c = s[i]
        if c == '{':
            depth += 1
            if depth > 1:
                buf.append(c)
        elif c == '}':
            depth -= 1
            if depth == 0:
                return ''.join(buf), i + 1
            buf.append(c)
        else:
            buf.append(c)
        i += 1
    return ''.join(buf), i


def _frac_to_parens(s):
    """支持嵌套花括号的 \\frac / \\dfrac → (num)/(den)"""
    for _ in range(4):
        m = re.search(r'\\(?:d?frac)\s*\{', s)
        if not m:
            break
        start = m.start()
        num, i = _balanced(s, m.end() - 1)
        while i < len(s) and s[i] == ' ':
            i += 1
        if i < len(s) and s[i] == '{':
            den, j = _balanced(s, i)
        else:
            den, j = '', i
        s = s[:start] + f'({num})/({den})' + s[j:]
    return s


def latex_to_text(s):
    s = s.strip()
    # 转义花括号 / 细空格等标点
    s = s.replace(r'\{', '').replace(r'\}', '')
    s = re.sub(r'\\[,;:!]', ' ', s).replace(r'\ ', ' ')
    # 帽号：\hat q → q̂
    s = re.sub(r'\\hat\s*([A-Za-z]|q)', lambda m: m.group(1) + '\u0302', s)
    # \frac / \dfrac{a}{b} → (a)/(b)（支持嵌套）
    s = _frac_to_parens(s)
    for k in sorted(CMD, key=len, reverse=True):
        s = s.replace(k, CMD[k])
    # 上标 / 下标（^* / ^{*} 退化为 *）
    s = re.sub(r'\^\{\*\}|\^\*', '*', s)
    s = re.sub(r'\^\{?([0-9+\-()]{1,3})\}?', lambda m: m.group(1).translate(SUP), s)
    s = re.sub(r'_\{?([0-9kij]{1,2})\}?', lambda m: m.group(1).translate(SUB), s)
    s = s.replace('{', '').replace('}', '').replace('$', '')
    s = re.sub(r'\\([A-Za-z]+)', r'\1', s)
    s = re.sub(r'\\(?![A-Za-z])', '', s)          # 残余转义（\%、\le 残留等）
    return re.sub(r'\s{3,}', '    ', s).strip()


# ---------------- Markdown → HTML ----------------
def inline(t):
    t = html_mod.escape(t, quote=False)
    t = re.sub(r'\*\*(.+?)\*\*', r'<strong>\1</strong>', t)
    t = re.sub(r'`(.+?)`', r'<code>\1</code>', t)
    t = re.sub(r'\$([^$]+)\$', lambda m: latex_to_text(html_mod.unescape(m.group(1))), t)
    t = re.sub(r'\*([^*]+)\*', r'<strong>\1</strong>', t)      # 单星强调（如 *证明*）
    return t


def img_tag(path):
    """只输出图片本体，说明文字由紧随其后的斜体行（figcaption）承担，避免 alt 与图注重复"""
    fp = os.path.join(IMG_DIR, os.path.basename(path))
    ext = os.path.splitext(fp)[1].lstrip('.').lower()
    mime = 'image/png' if ext == 'png' else 'image/jpeg'
    with open(fp, 'rb') as f:
        b64 = base64.b64encode(f.read()).decode('ascii')
    return (f'<figure><img src="data:{mime};base64,{b64}" alt="" '
            f'style="width:100%;max-width:var(--page-content-width)"/></figure>')


def md_to_html(md):
    out, lines, i = [], md.split('\n'), 0
    while i < len(lines):
        ln = lines[i]
        s = ln.strip()
        # 公式块
        if s.startswith('$$'):
            buf = [s[2:]]
            if s.count('$$') < 2:
                i += 1
                while i < len(lines) and '$$' not in lines[i]:
                    buf.append(lines[i]); i += 1
                if i < len(lines):
                    buf.append(lines[i].split('$$')[0])
            else:
                buf = [s.split('$$')[1]]
            body_txt = ' '.join(x.strip() for x in buf if x.strip())
            out.append('<p class="formula">' + html_mod.escape(latex_to_text(body_txt), quote=False) + '</p>')
            i += 1; continue
        # 代码块
        if s.startswith('```'):
            i += 1; buf = []
            while i < len(lines) and not lines[i].strip().startswith('```'):
                buf.append(lines[i]); i += 1
            out.append('<pre>' + html_mod.escape('\n'.join(buf)) + '</pre>')
            i += 1; continue
        # 图片
        m = re.match(r'!\[(.*?)\]\((.*?)\)', s)
        if m:
            out.append(img_tag(m.group(2))); i += 1; continue
        # 表格
        if s.startswith('|') and i + 1 < len(lines) and re.match(r'^\|[\s:|-]+\|$', lines[i + 1].strip()):
            head = [c.strip() for c in s.strip('|').split('|')]
            i += 2; rows = []
            while i < len(lines) and lines[i].strip().startswith('|'):
                rows.append([c.strip() for c in lines[i].strip().strip('|').split('|')]); i += 1
            th = ''.join(f'<th>{inline(c)}</th>' for c in head)
            trs = ''.join('<tr>' + ''.join(f'<td>{inline(c)}</td>' for c in r) + '</tr>' for r in rows)
            out.append(f'<table><thead><tr>{th}</tr></thead><tbody>{trs}</tbody></table>'); continue
        # 标题
        if s.startswith('# '):
            out.append(f'<h1>{inline(s[2:])}</h1>'); i += 1; continue
        if s.startswith('## '):
            out.append(f'<h2>{inline(s[3:])}</h2>'); i += 1; continue
        if s.startswith('### '):
            out.append(f'<h3>{inline(s[4:])}</h3>'); i += 1; continue
        # 引用 → note
        if s.startswith('> '):
            buf = []
            while i < len(lines) and lines[i].strip().startswith('>'):
                buf.append(lines[i].strip()[1:].strip()); i += 1
            out.append('<p class="note">&nbsp;&nbsp;' + inline(' '.join(buf)) + '</p>'); continue
        # 列表
        if re.match(r'^([-*]|\d+\.)\s+', s):
            ordered = bool(re.match(r'^\d+\.\s+', s))
            tag = 'ol' if ordered else 'ul'
            buf = []
            while i < len(lines) and re.match(r'^([-*]|\d+\.)\s+', lines[i].strip()):
                buf.append(re.sub(r'^([-*]|\d+\.)\s+', '', lines[i].strip())); i += 1
            out.append(f'<{tag}>' + ''.join(f'<li>{inline(x)}</li>' for x in buf) + f'</{tag}>'); continue
        # 图注（斜体独占一行）
        if re.match(r'^\*[^*].*\*$', s):
            out.append(f'<p class="figcap">{inline(s.strip("*"))}</p>'); i += 1; continue
        # 分隔线
        if s in ('---', '***'):
            i += 1; continue
        # 空行
        if not s:
            i += 1; continue
        out.append(f'<p>{inline(s)}</p>'); i += 1
    return '\n'.join(out)


CSS = """
@page { @bottom-center { content: "第 " counter(page) " 页"; } }
:root {
  --typography-fontFamily-heading: "微软雅黑","Microsoft YaHei","PingFang SC",sans-serif;
  --typography-fontFamily-body: "微软雅黑","Microsoft YaHei","PingFang SC",sans-serif;
  --typography-fontFamily-mono: Consolas,"Source Code Pro",monospace;
  --typography-fontSize-h1: 20pt;
  --typography-fontSize-h2: 13pt;
  --typography-fontSize-h3: 11pt;
  --typography-fontSize-body: 9.5pt;
  --typography-fontSize-small: 8.5pt;
  --typography-lineHeight-body: 1.7;
  --color-primary: #1565C0;
  --color-heading: #1A237E;
  --color-accent: #00897B;
  --color-text: #212121;
  --color-textSecondary: #616161;
  --color-divider: #E0E0E0;
  --color-surface: #F5F7FA;
  --sp-1: 0.30em; --sp-2: 0.55em; --sp-3: 0.9em; --sp-4: 1.4em;
  --page-content-width: 15.6cm;
  /* alias */
  --fs-h1: var(--typography-fontSize-h1);
  --fs-h2: var(--typography-fontSize-h2);
  --fs-h3: var(--typography-fontSize-h3);
  --fs-body: var(--typography-fontSize-body);
  --fs-small: var(--typography-fontSize-small);
  --ff-heading: var(--typography-fontFamily-heading);
  --ff-body: var(--typography-fontFamily-body);
  --ff-mono: var(--typography-fontFamily-mono);
  --lh-body: var(--typography-lineHeight-body);
  --color-muted: var(--color-textSecondary);
  --color-border: var(--color-divider);
}
* { box-sizing: border-box; margin: 0; padding: 0; }
body { font-family: var(--ff-body); font-size: var(--fs-body); line-height: var(--lh-body);
       color: var(--color-text); max-width: var(--page-content-width); margin-left: auto; margin-right: auto; }
h1 { font-family: var(--ff-heading); font-size: var(--fs-h1); font-weight: bold; color: var(--color-heading);
     text-align: left; margin-bottom: var(--sp-1); border-left: 4px solid var(--color-primary); padding-left: var(--sp-2); }
h2 { font-family: var(--ff-heading); font-size: var(--fs-h2); font-weight: bold; color: var(--color-heading);
     text-align: left; margin-top: var(--sp-4); margin-bottom: var(--sp-2); }
h3 { font-family: var(--ff-heading); font-size: var(--fs-h3); font-weight: bold; color: var(--color-primary);
     text-align: left; margin-top: var(--sp-3); margin-bottom: var(--sp-1); }
p { font-size: var(--fs-body); line-height: var(--lh-body); text-align: justify; margin-bottom: var(--sp-2); }
ul, ol { margin-bottom: var(--sp-2); padding-left: var(--sp-4); }
li { font-size: var(--fs-body); line-height: var(--lh-body); text-align: justify; margin-bottom: var(--sp-1); }
strong { font-weight: bold; }
code { font-family: var(--ff-mono); font-size: var(--fs-small); }
.formula { font-family: var(--ff-mono); font-size: var(--fs-body); text-align: center;
           background: var(--color-surface); padding: var(--sp-2); margin-bottom: var(--sp-2); }
.note { border-left: 3px solid var(--color-accent); background: var(--color-surface); padding: var(--sp-2);
        font-size: var(--fs-small); text-align: justify; margin-bottom: var(--sp-2); }
.figcap { font-size: var(--fs-small); color: var(--color-muted); text-align: left; margin-bottom: var(--sp-4); }
pre { font-family: var(--ff-mono); font-size: var(--fs-small); background: var(--color-surface);
      padding: var(--sp-2); margin-bottom: var(--sp-2); text-align: left; }
table { width: 100%; border-collapse: collapse; margin-bottom: var(--sp-3); font-size: var(--fs-small); }
th, td { border: 1px solid var(--color-border); padding: var(--sp-1) var(--sp-2); text-align: left;
         vertical-align: top; font-size: var(--fs-small); }
th { background: var(--color-surface); font-family: var(--ff-heading); font-weight: bold; color: var(--color-heading); }
figure { margin-bottom: var(--sp-1); text-align: center; }
img { max-width: 100%; }
"""


def main():
    with open(MD, encoding='utf-8') as f:
        md = f.read()
    body = md_to_html(md)
    html = ('<!DOCTYPE html>\n<html lang="zh-CN">\n<head>\n<meta charset="UTF-8">\n'
            '<meta name="docx-page-size" content="A4">\n'
            '<title>八、数学建模与参数临界条件分析</title>\n'
            f'<style>{CSS}</style>\n</head>\n<body>\n'
            '<section role="body" data-page-restart="1">\n' + body + '\n</section>\n</body>\n</html>\n')
    os.makedirs(os.path.dirname(HTML_OUT), exist_ok=True)
    with open(HTML_OUT, 'w', encoding='utf-8') as f:
        f.write(html)
    print('HTML:', HTML_OUT, round(len(html) / 1024), 'KB')

    r = subprocess.run([PY, '-m', 'html_to_docx', 'convert', HTML_OUT, '-o', DOCX,
                        '--page-size', 'A4', '--orientation', 'portrait',
                        '--margin-top', '2.5', '--margin-bottom', '2.0',
                        '--margin-left', '2.5', '--margin-right', '2.5'],
                       capture_output=True, text=True, encoding='utf-8', cwd=CONVERTER_CWD)
    print('convert stdout:', r.stdout.strip()[:300])
    if r.returncode != 0:
        print('convert stderr:', r.stderr.strip()[-500:])
        return 1
    print('DOCX:', DOCX, round(os.path.getsize(DOCX) / 1024), 'KB')
    return 0


if __name__ == '__main__':
    sys.exit(main())
