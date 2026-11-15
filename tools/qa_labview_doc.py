from pathlib import Path
import base64,html,math,subprocess,sys,time
from docx import Document
from docx.oxml.ns import qn
from PIL import Image,ImageDraw
src,out=Path(sys.argv[1]),Path(sys.argv[2]);out.mkdir(parents=True,exist_ok=True);d=Document(src);b=[]
for p in d.paragraphs:
 tag={'Heading 1':'h1','Heading 2':'h2','Heading 3':'h3','Heading 4':'h4'}.get(p.style.name if p.style else '','p')
 for x in p._p.xpath('.//a:blip'):
  q=d.part.related_parts[x.get(qn('r:embed'))];b.append(f'<div class="f"><img src="data:{q.content_type};base64,{base64.b64encode(q.blob).decode()}"></div>')
 if p.text:b.append(f'<{tag}>{html.escape(p.text)}</{tag}>')
css="@page{size:A4;margin:25.4mm}body{font:10.5pt/1.55 SimSun,'Microsoft YaHei',sans-serif}p{margin:0 0 6pt;text-align:justify}h1{text-align:center;font-size:22pt}h2{font-size:16pt}h3{font-size:14pt}h4{font-size:12pt}h1,h2,h3,h4{break-after:avoid}.f{text-align:center;margin:9pt 0 3pt;break-inside:avoid}.f img{width:100%;max-width:154.94mm;height:auto}.f+p{text-align:center;break-before:avoid;margin-bottom:9pt}"
h=out/'qa.html';pdf=out/'qa.pdf';h.write_text(f'<meta charset=utf-8><style>{css}</style>{"".join(b)}',encoding='utf-8')
edge=Path(r'C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe');subprocess.run([edge,'--headless=new','--disable-gpu',f'--user-data-dir={out/"profile"}','--no-pdf-header-footer',f'--print-to-pdf={pdf}',h.as_uri()])
for _ in range(20):
 if pdf.exists() and pdf.stat().st_size:break
 time.sleep(.5)
pop=Path(r'C:\Users\17355\.cache\codex-runtimes\codex-primary-runtime\dependencies\native\poppler\Library\bin\pdftoppm.exe');subprocess.run([pop,'-png','-r','90',pdf,out/'page'])
fs=sorted(out.glob('page-*.png'));ts=[]
for i,f in enumerate(fs,1):
 im=Image.open(f).convert('RGB');w=300;hh=round(im.height*w/im.width);im=im.resize((w,hh));c=Image.new('RGB',(w,hh+22),'white');c.paste(im,(0,22));ImageDraw.Draw(c).text((6,4),f'Page {i}',fill='black');ts.append(c)
ch=max(x.height for x in ts);s=Image.new('RGB',(900,math.ceil(len(ts)/3)*ch),'#ddd')
for i,x in enumerate(ts):s.paste(x,((i%3)*300,(i//3)*ch))
s.save(out/'contact.png');print(len(fs))
