"""Offline visual QA server. Never imports the running host or reads its credentials."""
import asyncio
import copy
import json
import uuid
from pathlib import Path

from fastapi import FastAPI, HTTPException
from fastapi.responses import FileResponse
from fastapi.staticfiles import StaticFiles

from test_manga import app as inner, mod, core, Host, ROOT, llm, OUTLINE, PAGE, FREE_PAGE, genqueue, reference_png

root = ROOT / '_tmp' / 'manga-maker-qa-llm'
root.mkdir(parents=True, exist_ok=True)
(root/'style-reference.png').write_bytes(reference_png(True))
host = Host(root)
host.llm_settings = lambda provider='': {'provider':provider or 'openai','model':'offline-fixture','key':''}
mod.DATA = root / 'projects'
mod.host_app = lambda: host


async def fake_chat(settings, system, messages, *args):
    await asyncio.sleep(1)
    req = json.loads(messages[0]['content'])
    if req['task']=='Extract reusable visual style only.':
        return {'text':json.dumps({'style_prompt':'watercolor, paper texture'})}
    if req['task']=='Translate existing manga dialogue.':
        return {'text':json.dumps({'panels':[{'lines':['Hello.' for _ in panel['lines']]} for panel in req['panels']]})}
    if 'Continue the story' in req['task']:
        return {'text': json.dumps({'pages': (OUTLINE['pages']*4)[:req['requested_pages'] or 2]}, ensure_ascii=False)}
    if 'Create a complete story' in req['task']:
        outline = copy.deepcopy(OUTLINE)
        n = req['options']['pages'] or 2
        outline['pages'] = (outline['pages'] * 4)[:n]
        return {'text': json.dumps(outline, ensure_ascii=False)}
    page=copy.deepcopy(FREE_PAGE if req['options'].get('layout_mode')=='free' else PAGE)
    if 'Re-storyboard' in req['task']:
        page['panels'] += [copy.deepcopy(page['panels'][-1]) for _ in range(2)]
        return {'text': json.dumps(page, ensure_ascii=False)}
    # 콘티는 남은 페이지를 한 번에 받는다.
    if 'Storyboard every remaining page' in req['task']:
        return {'text': json.dumps({'pages':[copy.deepcopy(page) for _ in range(req['page_count'])]}, ensure_ascii=False)}
    return {'text': json.dumps(page, ensure_ascii=False)}


llm.chat = fake_chat


async def fake_models(settings):
    # OpenRouter style: rows carry their reasoning levels, and the host also returns a note.
    if settings.get('provider') == 'openrouter':
        return {'models': [{'id': 'openai/gpt-5.5', 'label': 'GPT', 'in': 1.25},
                           {'id': 'x-ai/grok-4.6', 'label': 'Grok', 'in': 0.5, 'efforts': ['low', 'medium', 'high'], 'effortDefault': 'medium'}],
                'curated': True, 'total': 2, 'missing': ['foo/bar'], 'error': '추천 목록에 없는 모델: foo/bar'}
    return {'models': []}


llm.models = fake_models
import cliagent
from peropix_plugin_manga_maker import cli_llm
cliagent.detect = lambda: [{'id':'codex','label':'Codex CLI','installed':True,'drivable':True,
                           'path':'offline-codex.exe','models':['fixture-codex']}]
cli_llm.chat = fake_chat
inner.mount('/plug/_app', StaticFiles(directory=ROOT/'plug-app'))


@inner.get('/api/file/{ws}/{rel:path}')
async def image_file(ws: str, rel: str):
    path = host.store.file_path(ws, rel)
    if not path or not path.is_file():
        raise HTTPException(404)
    return FileResponse(path)


# Exercise shared scripts and output URLs under the same keyed prefix as the real app.
app = FastAPI()
app.mount('/k/qa', inner)


@app.on_event('startup')
async def start():
    host.worker = asyncio.create_task(genqueue.run_loop(host.Q, host.process))


@app.on_event('shutdown')
async def stop():
    host.worker.cancel()
