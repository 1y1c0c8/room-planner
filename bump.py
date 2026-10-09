#!/usr/bin/env python3
"""更新版本號：把所有本地 JS 模組的網址加上 ?v=版本，讓瀏覽器在每次發佈後重新下載（避開 GitHub Pages 的快取）。
用法：python3 bump.py 0.6.2"""
import re, sys, pathlib

ver = sys.argv[1]
root = pathlib.Path(__file__).parent
pat = re.compile(r"""(['"])(\./[\w-]+\.js|js/main\.js)(\?v=[^'"]*)?\1""")
for f in [root / 'index.html', *sorted((root / 'js').glob('*.js'))]:
    s = f.read_text()
    n = pat.sub(lambda m: f"{m[1]}{m[2]}?v={ver}{m[1]}", s)
    n = re.sub(r'<p class="mute small">v[\d.]+・', f'<p class="mute small">v{ver}・', n)
    n = re.sub(r"const APP_VERSION = '[^']*';", f"const APP_VERSION = '{ver}';", n)
    if n != s:
        f.write_text(n)
        print('updated', f.name)
(root / 'version.json').write_text(f'{{"v": "{ver}"}}\n')
print('version.json ->', ver)
