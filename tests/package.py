"""Create a source-only plugin ZIP; never include projects, keys or QA fixtures."""
import hashlib
import json
import zipfile
from pathlib import Path

plugin = Path(__file__).resolve().parents[1]
root = plugin.parents[1]
version = json.loads((plugin / 'plugin.json').read_text(encoding='utf-8'))['version']
target = root / '_dist' / f'peropix-plugin-manga-maker-{version}.zip'
target.parent.mkdir(parents=True, exist_ok=True)
files = ['plugin.json', 'server.py', 'core.py', 'cli_llm.py', 'README.md', '.gitignore',
         'web/index.html', 'web/style.css', 'web/app.js', 'docs/nai-v5-manga.md', 'docs/reference-prompt-analysis.md']
with zipfile.ZipFile(target, 'w', zipfile.ZIP_DEFLATED) as archive:
    for name in files:
        archive.write(plugin / name, f'manga-maker/{name}')
with zipfile.ZipFile(target) as archive:
    assert archive.testzip() is None
print(target)
print(f'{target.stat().st_size:,} bytes')
print('SHA256 ' + hashlib.sha256(target.read_bytes()).hexdigest())
