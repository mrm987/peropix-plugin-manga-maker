"""Offline contract tests. Real host loader, queue, payload compiler and output store; fake paid services."""
import ast
import asyncio
import copy
import io
import json
import sys
import tempfile
import types
import unittest
import uuid
import zipfile
import subprocess
import gzip
from pathlib import Path
from unittest.mock import AsyncMock, patch

ROOT = Path(__file__).resolve().parents[3]
PLUGIN = Path(__file__).resolve().parents[1]
sys.path.insert(0, str(ROOT / "backend"))

import httpx
import plugins
import genqueue
import workspace
import nai
import llm
from fastapi import FastAPI
from pydantic import BaseModel


def load_plugin():
    app = FastAPI()
    info = plugins._load_one(app, PLUGIN)
    assert not info.error, info.error
    server = sys.modules['peropix_plugin_manga_maker']
    core = sys.modules['peropix_plugin_manga_maker.core']
    return app, server, core


app, mod, core = load_plugin()


def host_models():
    tree = ast.parse((ROOT / 'backend/server.py').read_text(encoding='utf-8'))
    classes = [n for n in tree.body if isinstance(n, ast.ClassDef) and n.name in {'GenBody', 'QueueBody'}]
    ns = {'BaseModel': BaseModel}
    exec(compile(ast.Module(body=classes, type_ignores=[]), '<host-models>', 'exec'), ns)
    return ns['GenBody'], ns['QueueBody']


OUTLINE = {
    'title':'잠깐의 두근거림', 'premise':'친구의 집에 놀러 갔다가 잠든 얼굴을 보고 설레는 이야기.',
    'characters':[
        {'id':'marin','name':'마린','kind':'girl','prompt':'kitagawa marin, long blonde hair, pink eyes, white shirt, plaid skirt','uc':''},
        {'id':'gojo','name':'고죠','kind':'boy','prompt':'gojou wakana, short black hair, dark eyes, navy shirt','uc':''}],
    'pages':[{'title':'방문','summary':'잠든 친구에게 다가가 볼을 찌른다.'}, {'title':'들킴','summary':'눈을 마주치고 둘 다 당황한다.'}],
}
PAGE = {'title':'가까워지는 거리','layout':'four-grid','setting':'indoors, living room, afternoon','panels':[
    {'summary':'고죠의 집에 도착한 마린','scene':'Wide shot of a quiet Japanese living room. Marin enters through the doorway.', 'subjects':[{'character':'marin','camera':'full body, from side','action':'Entering the room and looking toward the sofa.','x':.45,'y':.6}],'dialogue':[{'speaker':'marin','text':'おじゃまします。'}]},
    {'summary':'소파에서 잠든 고죠','scene':'Medium shot of a boy asleep on a sofa, afternoon light through the window.', 'subjects':[{'character':'gojo','action':'Sleeping peacefully on the sofa, eyes closed.','x':.5,'y':.6}],'dialogue':[]},
    {'summary':'살며시 볼을 찌른다','scene':'Close two-shot beside the sofa. Her finger gently touches his cheek.', 'subjects':[{'character':'marin','action':'Leaning forward and gently poking his cheek.','x':.25,'y':.45},{'character':'gojo','action':'Still asleep, his cheek touched by her finger.','x':.72,'y':.65}],'dialogue':[]},
    {'summary':'가까운 얼굴에 두근거린다','scene':'Close-up of a girl blushing in the soft afternoon light.', 'subjects':[{'character':'marin','action':'Blushing, eyes widening, hand near her chest.','x':.5,'y':.55}],'dialogue':[{'speaker':'marin','text':'近すぎたかも…'}]},
]}


FREE_PAGE = copy.deepcopy(PAGE)
FREE_PAGE.update(layout='free', composition='A tall dominant panel on the right, two smaller panels down the left, a borderless bottom moment with a small overlapping inset.')
FREE_PAGE['panels'].append({'summary':'창가의 오후','scene':'Quiet window, afternoon light.','subjects':[],'dialogue':[]})
for panel,region in zip(FREE_PAGE['panels'],[
    dict(x=.43,y=0,w=.57,h=.65,frame='rectangle'),
    dict(x=0,y=0,w=.4,h=.25,frame='rectangle'),
    dict(x=0,y=.28,w=.4,h=.37,frame='slant-up'),
    dict(x=0,y=.69,w=1,h=.31,frame='borderless'),
    dict(x=.06,y=.72,w=.25,h=.22,frame='inset'),
]):panel['region']=region


def reference_png(stealth=False):
    from PIL import Image
    from PIL.PngImagePlugin import PngInfo
    data={'prompt':'watercolor, paper texture, 1girl, standing in a park','uc':'bad hands, screentone',
          'steps':31,'scale':6.25,'cfg_rescale':.42,'sampler':'k_dpmpp_2m_sde',
          'width':1344,'height':768,'seed':0,'request_type':'nai-diffusion-5-curated','noise_schedule':'karras'}
    im=Image.new('RGBA',(64,64),'white')
    info=PngInfo()
    if stealth:
        import numpy as np
        content=gzip.compress(json.dumps({'Comment':json.dumps(data)}).encode())
        message=b'stealth_pngcomp'+(len(content)*8).to_bytes(4,'big')+content
        bits=np.unpackbits(np.frombuffer(message,dtype=np.uint8))
        a=np.array(im);alpha=a[:,:,3].T.copy().reshape(-1)
        alpha[:len(bits)]=(alpha[:len(bits)]&254)|bits
        a[:,:,3]=alpha.reshape(64,64).T;im=Image.fromarray(a)
    else:info.add_text('Comment',json.dumps(data))
    buf=io.BytesIO();im.save(buf,format='PNG',pnginfo=info)
    return buf.getvalue()


class Host:
    def __init__(self, root):
        self.GenBody, self.QueueBody = host_models()
        self.store = workspace.Store(root / 'workspaces')
        self.store.dir_of('QA').mkdir(parents=True, exist_ok=True)
        self.Q = genqueue.GenerationQueue()
        self.ACCOUNTS = types.SimpleNamespace(public=lambda:[{'id':'qa','name':'QA (offline)'}], token_of=lambda x:'offline',resolve=lambda x:'qa')
        self.llm_settings = lambda provider='': {'provider':provider or 'openai','model':'offline-fixture','key':'offline-'+(provider or 'openai'),'effort':'high'}
        self.submissions, self.fail_at, self.delay = [], None, .03
        self.worker = None

    async def generate_queue(self, body):
        self.submissions.append(body)
        job = self.Q.add_job(body, 1, 'qa', 'QA')
        return {'job_id':job,'ok':True}

    async def process(self, job):
        await asyncio.sleep(self.delay)
        body = job['request'].base
        if self.fail_at == body.cell_no:
            return
        from PIL import Image
        image=Image.new('RGB',(body.width,body.height),'#dde7ee')
        buf=io.BytesIO(); image.save(buf,format='PNG')
        file=self.store.store_output(body.workspace,body.scene_group,body.cell,body.cell_no,body.tab,False,'png',buf.getvalue())
        record={'workspace':body.workspace,'cell_id':body.cell_id,'file':file,'seed':42,'ts':'2026-09-14'}
        self.store.append_record(body.workspace,record)
        self.Q.add_completed_image({**record,'job_id':job['id']})


class CompilerTests(unittest.TestCase):
    def test_reference_options_keep_zero_skip_invalid_and_missing(self):
        self.assertEqual(core.reference_generation({}), ({}, []))
        self.assertEqual(core.reference_generation({'request_type':'PromptGenerateRequest'}), ({}, []))
        self.assertEqual(core.reference_generation({'request_type':'PromptGenerateRequest','model':'nai-diffusion-5-full'}), ({'model':'nai-diffusion-5-full'}, []))
        self.assertEqual(core.reference_generation({'scale':0,'cfg_rescale':0,'seed':0}), ({'cfg':0,'cfg_rescale':0,'seed':0}, []))
        values,skipped=core.reference_generation({'scale':float('nan'),'steps':999,'cfg_rescale':2,'sampler':'unknown','width':800,'height':768,'seed':True,'model':'nai-diffusion-4-full'})
        self.assertEqual(values,{})
        self.assertEqual(set(skipped),{'cfg','steps','cfg_rescale','sampler','seed','model'})
        self.assertEqual(core.reference_generation({'width':1344,'height':768}), ({}, []))
        self.assertEqual((core.Options().width,core.Options().height),(832,1216))
        self.assertEqual(core.Options().cfg_rescale,0)
        self.assertEqual(core.Options().sampler,'k_euler_ancestral')

    def test_character_prompt_order_matches_board_numbering(self):
        """캐릭터 프롬프트의 차례 — 콘티·편집창·프롬프트 목록이 이 번호를 함께 쓴다.

        컷 차례대로, 컷 안에서는 인물 → (인물이 없으면 빈 칸 하나) → 내레이션 상자다.
        화면 쪽 `web/app.js` 의 `promptSlots()` 가 같은 차례를 다시 만들므로, 이 차례를
        바꾸면 그쪽도 함께 고쳐야 한다."""
        page = copy.deepcopy(FREE_PAGE)
        page['panels'][0]['dialogue'] = [{'speaker': '', 'text': '그날 오후.'},
                                         {'speaker': 'marin', 'text': 'おじゃまします。'}]
        pg = core.Page.model_validate(page)
        outline = core.Outline.model_validate(OUTLINE)
        result = core.compile_page(pg, outline, core.Options())

        def kind(c):
            if 'narration box' in c['prompt']:
                return 'note'
            return 'empty' if c['prompt'].startswith('no humans') else 'cast'

        expect = []
        for panel in pg.panels:
            expect += ['cast'] * len(panel.subjects)
            if not panel.subjects:
                expect.append('empty')
            expect += ['note'] * sum(1 for d in panel.dialogue if not d.speaker)
        self.assertEqual([kind(c) for c in result['characters']], expect)
        self.assertIn('empty', expect)
        self.assertIn('note', expect)

    def test_every_character_prompt_sits_inside_its_panel(self):
        """번호를 콘티에 찍으려면 좌표가 **그 컷 안**이어야 한다 — 내레이션 상자와 빈 칸도 그렇다."""
        for source in (PAGE, FREE_PAGE):
            page = copy.deepcopy(source)
            page['panels'][0]['dialogue'] = [{'speaker': '', 'text': 'A'}, {'speaker': '', 'text': 'B'}]
            pg = core.Page.model_validate(page)
            outline = core.Outline.model_validate(OUTLINE)
            for direction in ('rtl', 'ltr'):
                result = core.compile_page(pg, outline, core.Options(direction=direction))
                areas = core.regions(pg, direction)
                owners = []
                for panel, region in zip(pg.panels, areas):
                    count = len(panel.subjects) + (0 if panel.subjects else 1)
                    count += sum(1 for d in panel.dialogue if not d.speaker)
                    owners += [region] * count
                self.assertEqual(len(owners), len(result['characters']))
                for region, c in zip(owners, result['characters']):
                    self.assertTrue(region.x - 1e-6 <= c['center']['x'] <= region.x + region.w + 1e-6,
                                    f"{direction} {c['center']} not in {region}")
                    self.assertTrue(region.y - 1e-6 <= c['center']['y'] <= region.y + region.h + 1e-6,
                                    f"{direction} {c['center']} not in {region}")

    def test_coordinates_text_and_real_nai_payload(self):
        pg, outline, opts=core.Page.model_validate(PAGE),core.Outline.model_validate(OUTLINE),core.Options()
        result=core.compile_page(pg,outline,opts)
        self.assertEqual(result['characters'][0]['center'],{'x':.725,'y':.3})
        self.assertEqual(len(result['characters']),5)
        self.assertTrue(all(c['use_coord'] for c in result['characters']))
        result.pop('preview')
        result['characters']=[nai.CharPrompt(**c) for c in result['characters']]
        payload=nai.build_payload(nai.GenRequest(**result,seed=42))
        params=payload['parameters']
        self.assertTrue(params['v4_prompt']['use_coords'])
        self.assertEqual(params['v4_prompt']['caption']['char_captions'][0]['centers'][0],{'x':.725,'y':.3})
        self.assertNotIn('Text:',payload['input']);self.assertEqual(payload['input'].count('teXt:'),1)
        self.assertNotIn('no text',payload['input'])
        for tag in ['screentone','comic','multiple views']:
            self.assertNotIn(tag,params['negative_prompt'])
        # Reference format: tag-only base and slots, framing tags right after the kind.
        self.assertTrue(result['prompt'].startswith('monochrome, screentones, hatching (texture), masterpiece, best quality'))
        self.assertIn('multiple views, comic, manga, dynamic angle',result['prompt'])
        self.assertIn('indoors, living room, afternoon',result['prompt'])
        self.assertNotIn('left-to-right manga',result['prompt']);self.assertNotIn('.',result['prompt'].split('\n')[0].replace('...',''))
        first=result['characters'][0]
        self.assertTrue(first.prompt.startswith('girl, full body, from side, kitagawa marin, long blonde hair'))
        self.assertIn(', speech bubble, "おじゃまします。"',first.prompt)
        self.assertNotIn('Panel',first.prompt);self.assertNotIn(' only',first.prompt)
        # The host builds the block from the quoted lines; the plugin no longer writes its own.
        for line in ['おじゃまします。','近すぎたかも…']:self.assertIn(line,payload['input'].split('teXt:')[1])

    def test_reading_order_and_local_geometry(self):
        outline=core.Outline.model_validate(OUTLINE)
        for name,rectangles in core.LAYOUTS.items():
            pg=core.Page(title='test',layout=name,panels=[PAGE['panels'][0]]*len(rectangles))
            for direction in ['ltr','rtl']:
                opts=core.Options(max_panels=6,direction=direction)
                compiled=core.compile_page(pg,outline,opts)
                for char,(x,y,w,h) in zip(compiled['characters'],core.rects(name,direction)):
                    self.assertTrue(x<char['center']['x']<x+w)
                    self.assertTrue(y<char['center']['y']<y+h)

    def test_validation_and_wordless(self):
        opts=core.Options(dialogue='none')
        result=core.compile_page(core.Page.model_validate(PAGE),core.Outline.model_validate(OUTLINE),opts)
        self.assertNotIn('Text:',result['prompt'])
        bad=copy.deepcopy(PAGE);bad['panels'][0]['subjects'][0]['x']=float('nan')
        with self.assertRaises(ValueError):core.Page.model_validate(bad)
        bad=copy.deepcopy(PAGE);bad['panels'][0]['subjects'][0]['character']='missing'
        with self.assertRaises(ValueError):core.compile_page(core.Page.model_validate(bad),core.Outline.model_validate(OUTLINE),opts)
        with self.assertRaises(ValueError):core.Page.model_validate({**PAGE,'layout':'single'})

    def test_curated_text_budget_includes_separators(self):
        bad=copy.deepcopy(PAGE)
        for panel in bad['panels']:
            panel['dialogue']=[{'speaker':panel['subjects'][0]['character'],'text':'a'*76}]
        with self.assertRaises(ValueError):
            core.compile_page(core.Page.model_validate(bad),core.Outline.model_validate(OUTLINE),core.Options(model='nai-diffusion-5-curated'))

    def test_position_mode_local_speech_and_narration(self):
        page=copy.deepcopy(PAGE)
        page['panels'][1]['dialogue']=[{'speaker':'','text':'静かな午後。'}]
        opts=core.Options(prompt_mode='detailed')  # legacy value: ignored, same output
        result=core.compile_page(core.Page.model_validate(page),core.Outline.model_validate(OUTLINE),opts)
        self.assertIn('1boy, 1girl',result['prompt'])
        self.assertNotIn('bounds x=',result['prompt'])
        self.assertNotIn('Wide shot',result['prompt'])
        self.assertIn('おじゃまします。',result['characters'][0]['prompt'])
        self.assertEqual(len(result['characters']),6)
        narration=next(c for c in result['characters'] if c['prompt'].startswith('no humans, narration box'))
        self.assertEqual(narration['center'],{'x':.25,'y':.075})
        self.assertIn('静かな午後。',narration['prompt'])
        self.assertNotIn('Text:',result['prompt'])
        result.pop('preview')
        result['characters']=[nai.CharPrompt(**c) for c in result['characters']]
        payload=nai.build_payload(nai.GenRequest(**result,seed=42))
        self.assertNotIn('Text:',payload['input']);self.assertEqual(payload['input'].count('teXt:'),1)
        for line in ['おじゃまします。','静かな午後。','近すぎたかも…']:self.assertIn(line,payload['input'].split('teXt:')[1])
        silent=core.compile_page(core.Page.model_validate(page),core.Outline.model_validate(OUTLINE),core.Options(dialogue='none'))
        self.assertEqual(len(silent['characters']),5)
        self.assertNotIn('おじゃまします。',json.dumps(silent,ensure_ascii=False))
        self.assertIn('silent comic, no text',silent['prompt'])
        single=core.compile_page(core.Page(title='t',layout='single',panels=[PAGE['panels'][0]]),core.Outline.model_validate(OUTLINE),core.Options())
        self.assertNotIn('multiple views',single['prompt']);self.assertIn('comic, manga, dynamic angle',single['prompt'])

    def test_position_mode_counts_narration_in_slot_budget(self):
        panel=copy.deepcopy(PAGE['panels'][0])
        panel['subjects']*=3
        panel['dialogue']=[{'speaker':'','text':'A quiet room.'}]
        page=core.Page(title='test',layout='six-grid',panels=[panel]*6)
        with self.assertRaisesRegex(ValueError,'22'):
            core.compile_page(page,core.Outline.model_validate(OUTLINE),core.Options(prompt_mode='position',max_panels=6))

    def test_tall_templates_are_tall_and_read_around_the_tall_cell(self):
        """세로 칸이 있는 템플릿은 그 칸이 실제로 세로이고, 읽는 순서가 그것을 가로지르지 않는다.

        ★`rects` 를 좌표 정렬(y 우선)로 되돌리면 여기서 걸린다 — 세로 칸은 여러 줄에 걸치므로
          y 로 줄을 세우면 옆줄 칸들 **사이에** 끼어든다 (2026-09-19)."""
        for name in ['two-cols','tall-left','tall-right']:
            self.assertTrue(any(h>w for _,_,w,h in core.LAYOUTS[name]),f'{name} 에 세로 칸이 없다')
        # 오른쪽 열을 위에서 아래까지 다 읽고 나서 왼쪽 세로 칸으로 간다 (rtl). ltr 은 거울이다.
        self.assertEqual(core.rects('tall-left','rtl'),[(.5,0,.5,.5),(.5,.5,.5,.5),(0,0,.5,1)])
        self.assertEqual(core.rects('tall-left','ltr'),[(0,0,.5,1),(.5,0,.5,.5),(.5,.5,.5,.5)])
        self.assertEqual(core.rects('tall-right','rtl'),[(.5,0,.5,1),(0,0,.5,.5),(0,.5,.5,.5)])
        self.assertEqual(core.rects('tall-right','ltr'),[(0,0,.5,.5),(0,.5,.5,.5),(.5,0,.5,1)])
        self.assertEqual(core.rects('two-cols','rtl'),[(.5,0,.5,1),(0,0,.5,1)])

    def test_row_templates_keep_their_previous_reading_order(self):
        """가로띠·격자만 있는 옛 여덟은 `rects` 를 바꾸기 전과 순서가 같아야 한다."""
        for name in ['single','two-rows','three-rows','four-grid','four-rows','hero-top','hero-bottom','six-grid']:
            for d in ['rtl','ltr']:
                before=sorted(core.LAYOUTS[name],key=lambda r:(r[1],-r[0] if d=='rtl' else r[0]))
                self.assertEqual(core.rects(name,d),before,f'{name} {d}')

    def test_free_layout_regions_overlap_slants_and_reading_order(self):
        page,outline=core.Page.model_validate(FREE_PAGE),core.Outline.model_validate(OUTLINE)
        for direction in ['rtl','ltr']:
            opts=core.Options(prompt_mode='position',direction=direction)
            core.validate_planned_page(copy.deepcopy(page),outline,opts)  # ltr would re-seat the rtl fixture; keep the original for geometry checks
            result=core.compile_page(page,outline,opts)
            self.assertEqual(len(result['preview']),5)
            self.assertEqual(result['preview'][0]['rect'],[.43,0,.57,.65])
            self.assertEqual(result['characters'][0]['center'],{'x':.6865,'y':.39})
            self.assertEqual(result['preview'][2]['polygon'][0],{'x':0,'y':.3355})
            self.assertEqual(result['preview'][2]['polygon'][1],{'x':.4,'y':.28})
            self.assertEqual(result['characters'][2]['center'],{'x':.1,'y':.4632})
            self.assertNotIn('borderless bottom',result['prompt'])  # composition is a memo, never sent
            self.assertNotIn('distinct black panel borders',result['prompt'])
            self.assertNotIn('4-panel',result['prompt'])
            self.assertEqual('left-to-right manga' in result['prompt'],direction=='ltr')
            self.assertIn('inset panels',result['characters'][-1]['prompt'])
            self.assertNotIn('small panels',result['characters'][0]['prompt'])  # .57 x .65 dominant panel
            self.assertIn('small panels',result['characters'][1]['prompt'])  # .4 x .25 reaction panel
        with self.assertRaises(ValueError):
            core.Region(x=.9,y=0,w=.2,h=.5)
        broken=copy.deepcopy(FREE_PAGE);broken['panels'][0]['region']=None
        with self.assertRaises(ValueError):core.Page.model_validate(broken)
        with self.assertRaises(ValueError):
            core.validate_planned_page(core.Page.model_validate(PAGE),outline,core.Options())
        with self.assertRaises(ValueError):
            core.validate_planned_page(page,outline,core.Options(max_panels=4))

    def test_free_layout_regions_follow_reading_direction(self):
        outline=core.Outline.model_validate(OUTLINE)
        def make(regions):
            page=copy.deepcopy(FREE_PAGE)
            page['panels']=[dict(page['panels'][0],region=dict(x=x,y=y,w=w,h=h,frame='rectangle')) for x,y,w,h in regions]
            return core.Page.model_validate(page)
        # Two rows already right-to-left, last row left-to-right (the reported case): only the last row swaps.
        page=make([(.5,0,.5,.3),(0,0,.5,.3),(.5,.35,.5,.3),(0,.35,.5,.3),(0,.7,.5,.3),(.5,.7,.5,.3)])
        core.validate_planned_page(page,outline,core.Options())
        self.assertEqual([(p.region.x,p.region.y) for p in page.panels],[(.5,0),(0,0),(.5,.35),(0,.35),(.5,.7),(0,.7)])
        # A tall left panel numbered before the stacked right column: the column is read first.
        page=make([(0,0,1,.4),(.5,.45,.5,.25),(0,.45,.5,.55),(.5,.72,.5,.28)])
        core.validate_planned_page(page,outline,core.Options())
        self.assertEqual([(p.region.x,p.region.y) for p in page.panels],[(0,0),(.5,.45),(.5,.72),(0,.45)])
        # ltr keeps left-to-right rows and the fixture page is already in order for rtl.
        page=make([(0,0,.5,.5),(.5,0,.5,.5),(0,.5,1,.5)])
        self.assertFalse(core.settle_reading_order(page,'ltr'))
        self.assertFalse(core.settle_reading_order(core.Page.model_validate(FREE_PAGE),'rtl'))

    def test_parse_json_tolerates_prose_and_reports_empty(self):
        self.assertEqual(core.parse_json('Here is the plan:\n{"a": 1}\nHope this helps.')['a'],1)
        self.assertEqual(core.parse_json('```json\n{"a": [1, {"b": "}"}]}\n```')['a'][1]['b'],'}')
        with self.assertRaisesRegex(ValueError,'빈 응답'):core.parse_json('   ')
        with self.assertRaisesRegex(ValueError,'JSON 객체가 없습니다'):core.parse_json('죄송하지만 그 내용은 도와드릴 수 없습니다.')
        with self.assertRaises(ValueError):core.parse_json('[1,2]')

    def test_auto_can_plan_more_than_six_panels(self):
        page=copy.deepcopy(FREE_PAGE)
        page['panels'] += [copy.deepcopy(page['panels'][-1]) for _ in range(3)]
        pg=core.Page.model_validate(page)
        core.validate_planned_page(pg,core.Outline.model_validate(OUTLINE),core.Options())
        self.assertEqual(len(core.regions(pg,'rtl')),8)


class HostModuleTests(unittest.TestCase):
    """`host_app()` must hand back the backend that is actually serving.

    The packaged app starts the backend as `python server.py`, so the host module is named `__main__`
    there and a plain `import server` ran the whole backend a second time: its own queue, which nothing
    pumps, so a queued page waited forever and reported no error. Dev runs it under uvicorn as
    `server:app`, where the module is already named `server`, which is why the plain import looked
    correct. Both shapes have to keep working."""
    @staticmethod
    def as_host():
        m=types.ModuleType('__main__');m.generate_queue=lambda *a,**k:None
        return m

    def test_packaged_reuses_the_running_main(self):
        host=self.as_host()
        with patch.dict(sys.modules,{'__main__':host}):
            self.assertIs(mod.host_app(),host)

    def test_dev_falls_back_to_the_named_import(self):
        named=types.ModuleType('server')
        with patch.dict(sys.modules,{'__main__':types.ModuleType('__main__'),'server':named}):
            self.assertIs(mod.host_app(),named)

    def test_packaged_never_reaches_the_import(self):
        # A None entry makes `import server` raise, so reaching it at all fails the test.
        host=self.as_host()
        with patch.dict(sys.modules,{'__main__':host,'server':None}):
            self.assertIs(mod.host_app(),host)


class CliAdapterTests(unittest.TestCase):
    @staticmethod
    def process(stdout='',stderr='',code=0):
        return types.SimpleNamespace(returncode=code,poll=lambda:code,communicate=lambda **kwargs:(stdout,stderr))

    def test_codex_final_file_and_stdin_transport(self):
        from peropix_plugin_manga_maker import cli_llm
        def fake(args, **kwargs):
            self.assertIn('--model',args)
            self.assertEqual(args[args.index('--model')+1],'chosen-model')
            self.assertEqual(args[args.index('-c',args.index('--model'))+1],'model_reasoning_effort="medium"')
            self.assertEqual(args[-1],'-')
            self.assertFalse(kwargs.get('shell',False))
            Path(args[args.index('-o')+1]).write_text('{"ok":true}',encoding='utf-8')
            proc=self.process('events')
            def communicate(**kwargs):
                self.assertIn('한글 "스토리"',kwargs['input'])
                return 'events',''
            proc.communicate=communicate
            return proc
        with tempfile.TemporaryDirectory() as root, patch.object(cli_llm.subprocess,'Popen',side_effect=fake):
            result=cli_llm.run({'agent':'codex','exe':'codex.exe','model':'chosen-model','effort':'medium'},'한글 "스토리"',[],Path(root))
            self.assertEqual(json.loads(result['text']),{'ok':True})

    def test_claude_result_and_structured_output(self):
        from peropix_plugin_manga_maker import cli_llm
        for payload in [{'result':'{"ok":true}'},{'structured_output':{'ok':True}}]:
            with tempfile.TemporaryDirectory() as root, patch.object(cli_llm.subprocess,'Popen',return_value=self.process(json.dumps(payload))) as run:
                r=cli_llm.run({'agent':'claude-code','exe':'claude.exe','model':'opus','effort':'low'},'test',[],Path(root))
                self.assertEqual(json.loads(r['text']),{'ok':True})
                args=run.call_args.args[0]
                self.assertEqual(args[args.index('--tools')+1],'')
                self.assertEqual(args[args.index('--setting-sources')+1],'')
                self.assertEqual(args[args.index('--effort')+1],'low')
                self.assertNotIn('--bare',args)

    def test_cli_failure_timeout_and_wrapper(self):
        from peropix_plugin_manga_maker import cli_llm
        with tempfile.TemporaryDirectory() as root:
            settings={'agent':'codex','exe':'codex.exe','model':''}
            with patch.object(cli_llm.subprocess,'Popen',return_value=self.process(stderr='Login required',code=1)):
                self.assertIn('Login required',cli_llm.run(settings,'test',[],Path(root))['error'])
            with patch.object(cli_llm.subprocess,'Popen',return_value=self.process()):
                with self.assertRaisesRegex(ValueError,'10분'):cli_llm.run(settings,'test',[],Path(root),timeout=0)
            with self.assertRaisesRegex(ValueError,'실제 실행 파일'):
                cli_llm.command({**settings,'exe':'codex.cmd'},Path(root)/'result.txt')


class CliCancellationTests(unittest.IsolatedAsyncioTestCase):
    async def test_cancel_terminates_process_and_child(self):
        from peropix_plugin_manga_maker import cli_llm
        with tempfile.TemporaryDirectory() as name:
            root=Path(name);heartbeat=root/'heartbeat.txt'
            child_code=f"import time;from pathlib import Path;p=Path({str(heartbeat)!r});\nwhile True:\n p.write_text(str(time.time()));time.sleep(.04)"
            parent_code=f"import subprocess,sys,time;subprocess.Popen([sys.executable,'-c',{child_code!r}]);time.sleep(30)"
            real_popen=subprocess.Popen;processes=[]
            def launch(*args,**kwargs):
                proc=real_popen(*args,**kwargs)
                if args[0][0]==sys.executable:processes.append(proc)
                return proc
            with patch.object(cli_llm,'command',return_value=[sys.executable,'-c',parent_code]),patch.object(cli_llm.subprocess,'Popen',side_effect=launch):
                task=asyncio.create_task(cli_llm.chat({'agent':'claude-code'},'test',[],root))
                try:
                    for _ in range(200):
                        if heartbeat.exists():break
                        await asyncio.sleep(.02)
                    self.assertTrue(heartbeat.exists(),'Local test process started')
                    task.cancel()
                    with self.assertRaises(asyncio.CancelledError):await asyncio.wait_for(task,.2)
                    for _ in range(200):
                        if processes and processes[0].poll() is not None:break
                        await asyncio.sleep(.02)
                    self.assertIsNotNone(processes[0].poll(),'Cancelled CLI exited')
                    await asyncio.sleep(.2)
                    before=heartbeat.read_text()
                    await asyncio.sleep(.2)
                    self.assertEqual(heartbeat.read_text(),before,'CLI child stopped too')
                finally:
                    task.cancel()
                    await asyncio.gather(task,return_exceptions=True)
                    for proc in processes:
                        if proc.poll() is None:await asyncio.to_thread(cli_llm.terminate,proc)


class WorkflowTests(unittest.IsolatedAsyncioTestCase):
    async def asyncSetUp(self):
        self.temp=tempfile.TemporaryDirectory(prefix='manga-test-')
        self.host=Host(Path(self.temp.name))
        mod.DATA=Path(self.temp.name)/'projects';mod.TASKS.clear()
        self.hostpatch=patch.object(mod,'host_app',return_value=self.host);self.hostpatch.start()
        self.llmpatch=patch.object(llm,'chat',new=AsyncMock(side_effect=self.chat));self.llmpatch.start()
        import cliagent
        self.clipatch=patch.object(cliagent,'detect',return_value=[{'id':'codex','label':'Codex CLI','installed':True,'drivable':True,'path':'codex.exe','models':['fixture-codex']}]);self.clipatch.start()
        self.host.worker=asyncio.create_task(genqueue.run_loop(self.host.Q,self.host.process))
        self.client=httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test')
        self.llm_delay,self.continuations=0,[]

    async def chat(self,settings,system,messages,*args):
        await asyncio.sleep(self.llm_delay)
        request=json.loads(messages[0]['content'])
        page=FREE_PAGE if request.get('options',{}).get('layout_mode')=='free' else PAGE
        outline=copy.deepcopy(OUTLINE)
        n=request.get('options',{}).get('pages') or 2
        outline['pages']=(outline['pages']*4)[:n]
        if 'Continue the story' in request['task']:
            self.continuations.append({'requested':request['requested_pages'],'instructions':request['continuation_instructions'],'existing':len(request['existing_pages'])})
            return {'text':json.dumps({'pages':(OUTLINE['pages']*4)[:request['requested_pages'] or 2]},ensure_ascii=False)}
        if 'Create a complete story' in request['task']:
            return {'text':json.dumps(outline,ensure_ascii=False)}
        # 콘티는 남은 페이지를 한 번에 받는다. 재기획(Re-storyboard)만 여전히 한 장이다.
        if 'Storyboard every remaining page' in request['task']:
            return {'text':json.dumps({'pages':[copy.deepcopy(page) for _ in range(request['page_count'])]},ensure_ascii=False)}
        return {'text':json.dumps(page,ensure_ascii=False)}

    async def accepting(self,pid):
        """기획 작업이 「이미 나온 페이지는 지금 생성해도 된다」를 켜 둔 순간까지 기다린다."""
        for _ in range(400):
            p=(await self.client.get(f'/plug/manga-maker/api/projects/{pid}')).json()
            if p.get('accepting') or p['status'] not in ('planning','generating'):return p
            await asyncio.sleep(.02)
        return p

    async def planned(self,pid,count):
        for _ in range(200):
            p=(await self.client.get(f'/plug/manga-maker/api/projects/{pid}')).json()
            if len(p['pages'])>=count or p['status'] not in ('planning','generating'):return p
            await asyncio.sleep(.05)
        self.fail('planning did not reach the requested page')

    async def test_generate_planned_pages_while_planning_continues(self):
        # ★콘티를 남은 페이지 한 번에 받게 되면서(2026-09-21) 「짜는 동안 이미 나온 페이지를 생성」이
        #   살아 있는 자리는 이어 그리기다. 앞 페이지가 이미 있는 채로 뒤 페이지를 짜기 때문이다.
        #   처음 기획은 페이지가 한꺼번에 나오므로 겹치는 구간이 없다.
        self.llm_delay=.4
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual(len(p['pages']),2)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision'],'pages':2})
        self.assertEqual(r.status_code,200,r.text)
        p=await self.accepting(pid)
        self.assertEqual((p['status'],p['accepting'],len(p['pages'])),('planning',True,2))
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':3})
        self.assertEqual(r.status_code,400,'아직 짜이지 않은 페이지는 걸 수 없다')
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':0})
        self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['gen_requests'],[0])
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':0,'page':0})
        self.assertEqual(r.status_code,400)
        p=await self.finish(pid)
        self.assertEqual((p['status'],len(p['pages']),len(p['pages'][0]['images'])),('ready',4,1))
        self.assertFalse(p['accepting']);self.assertEqual(p['gen_requests'],[]);self.assertIsNone(p['generation'])
        self.assertEqual(len(self.host.submissions),1)
        # "남은 페이지 생성" during planning follows every page that has no image yet.
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision'],'pages':2})
        self.assertEqual(r.status_code,200,r.text)
        p=await self.accepting(pid)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision']})
        self.assertEqual(r.status_code,200,r.text);self.assertTrue(r.json()['gen_follow'])
        p=await self.finish(pid)
        self.assertEqual((p['status'],[len(x['images']) for x in p['pages']]),('complete',[1]*6))

    async def test_delete_page_keeps_files_and_allows_continuation(self):
        pid=await self.create();p=await self.finish(pid)
        await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':1});p=await self.finish(pid)
        file=p['pages'][1]['images'][0]['file'];first=p['pages'][0]['plan']['title']
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/pages/1/delete',json={'revision':0})
        self.assertEqual(r.status_code,409)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/pages/1/delete',json={'revision':p['revision']})
        self.assertEqual(r.status_code,200,r.text);p=r.json()
        self.assertEqual((len(p['pages']),len(p['outline']['pages']),p['status'],p['pages'][0]['plan']['title']),(1,1,'ready',first))
        self.assertIn('2페이지를 지웠습니다',p['message'])
        self.assertTrue(self.host.store.file_path('QA',file).is_file())  # generated file untouched
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/pages/0/delete',json={'revision':p['revision']})
        self.assertEqual(r.status_code,400)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision'],'pages':1})
        self.assertEqual(r.status_code,200,r.text);p=await self.finish(pid)
        self.assertEqual((len(p['pages']),len(p['outline']['pages']),p['status']),(2,2,'ready'))

    async def test_continue_story_appends_pages_and_generates_only_new(self):
        pid=await self.create();p=await self.finish(pid)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':0})
        self.assertEqual(r.status_code,200,r.text);p=await self.finish(pid)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision'],'pages':2,'instructions':'둘이 해변으로 간다.'})
        self.assertEqual(r.status_code,200,r.text);self.assertEqual(r.json()['status'],'planning')
        p=await self.finish(pid)
        self.assertEqual((p['status'],len(p['outline']['pages']),len(p['pages'])),('ready',4,4))
        self.assertEqual(self.continuations,[{'requested':2,'instructions':'둘이 해변으로 간다.','existing':2}])
        self.assertEqual(p['continuations'][0]['from'],2);self.assertEqual(p['story'],'잠든 친구를 깨우려다 들킨다.')
        # Automatic continuation with an automatic page count generates only pages without images.
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision'],'pages':0,'automatic':True})
        self.assertEqual(r.status_code,200,r.text);p=await self.finish(pid)
        self.assertEqual((p['status'],len(p['pages']),[len(x['images']) for x in p['pages']]),('complete',6,[1]*6))
        self.assertEqual(self.continuations[1]['requested'],0)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':5})
        self.assertEqual(r.status_code,200,r.text);p=await self.finish(pid);self.assertEqual(len(p['pages'][5]['images']),2)
        # Continuing an unfinished plan is refused.
        p['pages'].pop();mod.save(p)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/continue',json={'revision':p['revision']})
        self.assertEqual(r.status_code,400)

    async def asyncTearDown(self):
        for task in list(mod.TASKS.values()):task.cancel()
        await asyncio.gather(*mod.TASKS.values(),return_exceptions=True)
        self.host.worker.cancel()
        await asyncio.gather(self.host.worker,return_exceptions=True)
        self.hostpatch.stop();self.llmpatch.stop();self.clipatch.stop();await self.client.aclose();self.temp.cleanup()

    async def test_llm_selection_saved_and_passed_to_every_api_call(self):
        # The plugin effort is its own setting: empty sends no effort (model default), like the app screen.
        r=await self.client.put('/plug/manga-maker/api/llm',json={'provider':'google','model':'my-model','effort':'bogus'})
        self.assertEqual(r.status_code,400)
        r=await self.client.put('/plug/manga-maker/api/llm',json={'provider':'google','model':'my-model','effort':''})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(mod.resolve_llm()['effort'],'')
        r=await self.client.put('/plug/manga-maker/api/llm',json={'provider':'google','model':'my-model','effort':'Low'})
        self.assertEqual(r.status_code,200,r.text)
        self.assertNotIn('offline-google',r.text)
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual(p['llm'],{'provider':'google','model':'my-model','effort':'low'})
        for call in llm.chat.await_args_list:
            self.assertEqual(call.args[0]['model'],'my-model')
            self.assertEqual(call.args[0]['key'],'offline-google')
            self.assertEqual(call.args[0]['effort'],'low')
        self.assertEqual(self.host.llm_settings()['provider'],'openai')
        r=await self.client.get('/plug/manga-maker/api/llm')
        self.assertEqual(r.json()['choice'],{'provider':'google','model':'my-model','effort':'low'})

    async def test_cli_is_ready_without_api_key_and_uses_cli_adapter(self):
        self.host.llm_settings=lambda provider='': {'provider':provider or 'openai','model':'','key':''}
        r=await self.client.put('/plug/manga-maker/api/llm',json={'provider':'cli:codex','model':'fixture-codex','effort':'bogus'})
        self.assertEqual(r.status_code,400)
        r=await self.client.put('/plug/manga-maker/api/llm',json={'provider':'cli:codex','model':'fixture-codex','effort':'Medium'})
        self.assertTrue(r.json()['ready'],r.text)
        self.assertEqual(r.json()['choice']['effort'],'medium')
        self.assertIn('medium',next(p for p in r.json()['providers'] if p['id']=='cli:codex')['efforts'])
        from peropix_plugin_manga_maker import cli_llm
        with patch.object(cli_llm,'chat',new=AsyncMock(side_effect=self.chat)) as run:
            pid=await self.create();p=await self.finish(pid)
            self.assertEqual(p['status'],'ready',p['message'])
            self.assertEqual(run.await_count,2)   # 밑그림 한 번 + 콘티 한 번 (두 페이지를 한 요청으로)
            self.assertEqual(run.await_args.args[0]['agent'],'codex')
            self.assertEqual(run.await_args.args[0]['model'],'fixture-codex')
            self.assertEqual(run.await_args.args[0]['effort'],'medium')
            self.assertEqual(p['llm']['effort'],'medium')
        llm.chat.assert_not_awaited()
        models=await self.client.get('/plug/manga-maker/api/llm/models?provider=cli:codex')
        self.assertEqual(models.json()['models'],[{'id':'fixture-codex'}])

    async def create(self,automatic=False):
        r=await self.client.post('/plug/manga-maker/api/projects',json={'story':'잠든 친구를 깨우려다 들킨다.','options':{'workspace':'QA','account':'qa','layout_mode':'template'},'automatic':automatic})
        self.assertEqual(r.status_code,200,r.text)
        return r.json()['id']

    async def finish(self,pid):
        if pid in mod.TASKS:await asyncio.wait_for(asyncio.shield(mod.TASKS[pid]),10)
        return mod.load(pid)

    async def test_full_pipeline_save_reopen_export(self):
        pid=await self.create(True);p=await self.finish(pid)
        self.assertEqual(p['status'],'complete',p['message'])
        self.assertEqual(len(self.host.submissions),2)
        self.assertTrue(all(len(x['images'])==1 for x in p['pages']))
        r=await self.client.get(f'/plug/manga-maker/api/projects/{pid}')
        self.assertEqual(len(r.json()['compiled']),2)
        exported=await self.client.get(f'/plug/manga-maker/api/projects/{pid}/export')
        with zipfile.ZipFile(io.BytesIO(exported.content)) as z:
            self.assertIn('page-01-v01.png',z.namelist());self.assertIn('page-02-v01.png',z.namelist());self.assertIn('project.json',z.namelist())

    async def test_replan_free_layout_preserves_images_history_and_failure(self):
        pid=await self.create(True);p=await self.finish(pid)
        old_plan=copy.deepcopy(p['pages'][0]['plan']);old_images=copy.deepcopy(p['pages'][0]['images'])
        p['options'].update(layout_mode='free',max_panels=0)
        mod.save(p)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/replan',json={'revision':p['revision'],'page':0})
        self.assertEqual(r.status_code,200,r.text)
        p=await self.finish(pid)
        self.assertEqual(p['status'],'ready',p['message'])
        self.assertEqual(len(p['pages'][0]['plan']['panels']),5)
        self.assertEqual(p['pages'][0]['images'],old_images)
        self.assertEqual(p['pages'][0]['plan_history'][0]['plan'],old_plan)
        self.assertEqual(p['pages'][1]['plan']['layout'],'four-grid')
        self.assertTrue(self.host.store.file_path('QA',old_images[0]['file']).exists())
        stale=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/replan',json={'revision':1,'page':0})
        self.assertEqual(stale.status_code,409)
        with patch.object(llm,'chat',new=AsyncMock(return_value={'error':'test failure'})):
            await self.client.post(f'/plug/manga-maker/api/projects/{pid}/replan',json={'revision':p['revision'],'page':0})
            failed=await self.finish(pid)
        self.assertEqual(failed['pages'],p['pages'])
        self.assertEqual(failed['status'],'error')

    async def test_style_reference_reads_plain_and_stealth_metadata(self):
        for stealth in [False,True]:
            with patch.object(llm,'chat',new=AsyncMock(return_value={'text':'{"style_prompt":"watercolor, paper texture"}'})) as call:
                r=await self.client.post('/plug/manga-maker/api/style-reference',files={'file':('ref.png',reference_png(stealth),'image/png')})
                self.assertEqual(r.status_code,200,r.text)
                self.assertEqual(r.json()['negative_prompt'],'bad hands, screentone')
                self.assertEqual(r.json()['generation_options'],{'cfg':6.25,'cfg_rescale':.42,'steps':31,'sampler':'k_dpmpp_2m_sde','seed':0,'model':'nai-diffusion-5-curated'})
                self.assertEqual(r.json()['skipped_options'],[])
                self.assertIn('watercolor',call.await_args.args[2][0]['content'])
        bad=await self.client.post('/plug/manga-maker/api/style-reference',files={'file':('bad.png',b'invalid','image/png')})
        self.assertEqual(bad.status_code,400)
        opts=core.Options(reference_style=True,style_prompt='watercolor, paper texture',negative_prompt='bad hands, screentone')
        compiled=core.compile_page(core.Page.model_validate(PAGE),core.Outline.model_validate(OUTLINE),opts)
        self.assertIn('watercolor, paper texture',compiled['prompt'])
        self.assertNotIn('ink lineart',compiled['prompt'])
        self.assertNotIn('very aesthetic',compiled['prompt'])
        self.assertEqual(compiled['negative_prompt'],'bad hands, screentone')
        self.assertEqual(core.Options().dialogue,'ko')

    async def test_extracted_styles_are_saved_and_reusable_without_llm(self):
        endpoint='/plug/manga-maker/api/styles'
        for _ in range(2):
            with patch.object(llm,'chat',new=AsyncMock(return_value={'text':'{"style_prompt":"watercolor, paper texture"}'})):
                response=await self.client.post('/plug/manga-maker/api/style-reference',files={'file':('ref.png',reference_png(True),'image/png')})
            self.assertEqual(response.status_code,200,response.text)
            extracted=response.json()
        llm.chat.reset_mock()
        items=(await self.client.get(endpoint)).json()['items']
        self.assertEqual(len(items),2)
        self.assertNotEqual(items[0]['id'],items[1]['id'],'Repeated names must not overwrite earlier styles')
        saved=(await self.client.get(f"{endpoint}/{extracted['id']}")).json()
        self.assertEqual(saved['name'],'ref')
        for key in ['style_prompt','negative_prompt','generation_options','reference_name']:
            self.assertEqual(saved[key],extracted[key])
        disk=json.loads((mod.DATA.parent/'styles.json').read_text(encoding='utf-8'))
        self.assertEqual(disk['items'],items)
        # A new API client reads the persisted library, independent of browser storage.
        async with httpx.AsyncClient(transport=httpx.ASGITransport(app=app),base_url='http://test') as reopened:
            self.assertEqual((await reopened.get(endpoint)).json(),disk)
        llm.chat.assert_not_awaited()

    async def test_style_library_rename_delete_preserve_settings_and_projects(self):
        endpoint='/plug/manga-maker/api/styles'
        pid=await self.create();await self.finish(pid)
        body={'name':'  수채화  ','style_prompt':'{{watercolor}}, paper texture','negative_prompt':'',
              'reference_name':'ref.png','generation_options':{'cfg':0,'cfg_rescale':0,'steps':31,'seed':0}}
        first=await self.client.post(endpoint,json=body)
        self.assertEqual(first.status_code,200,first.text)
        first=first.json()
        self.assertEqual(first['name'],'수채화')
        self.assertEqual(first['negative_prompt'],'')
        self.assertEqual(first['generation_options'],body['generation_options'])
        second=(await self.client.post(endpoint,json={**body,'name':'다른 화풍'})).json()
        project=mod.load(pid)
        project['options'].update(style_prompt=first['style_prompt'],negative_prompt='',reference_style=True,**first['generation_options'])
        mod.save(project)
        before=copy.deepcopy(mod.load(pid))
        llm.chat.reset_mock()
        renamed=await self.client.patch(f"{endpoint}/{first['id']}",json={'name':'  내 수채화  '})
        self.assertEqual(renamed.status_code,200,renamed.text)
        self.assertEqual(renamed.json()['name'],'내 수채화')
        for key in ['id','created','style_prompt','negative_prompt','generation_options','reference_name']:
            self.assertEqual(renamed.json()[key],first[key])
        deleted=await self.client.delete(f"{endpoint}/{first['id']}")
        self.assertEqual(deleted.status_code,200)
        self.assertEqual((await self.client.get(endpoint)).json()['items'],[second])
        self.assertEqual((await self.client.get(f"{endpoint}/{first['id']}")).status_code,404)
        self.assertEqual((await self.client.patch(f"{endpoint}/{first['id']}",json={'name':'new'})).status_code,404)
        self.assertEqual((await self.client.delete(f"{endpoint}/{first['id']}")).status_code,404)
        self.assertEqual(mod.load(pid),before)
        llm.chat.assert_not_awaited()

    async def test_invalid_style_data_and_failed_extraction_leave_library_intact(self):
        endpoint='/plug/manga-maker/api/styles'
        valid={'name':'original','style_prompt':'watercolor','negative_prompt':'bad hands'}
        await self.client.post(endpoint,json=valid)
        before=(mod.DATA.parent/'styles.json').read_bytes()
        for changed in [{'name':'   '},{'name':'x'*121},{'style_prompt':' '},
                        {'generation_options':{'width':1344,'height':768}},
                        {'generation_options':{'cfg':True}},{'generation_options':{'steps':0}},
                        {'generation_options':{'seed':-2}},{'generation_options':{'cfg_rescale':1.1}},
                        {'generation_options':{'model':'unsupported'}}]:
            response=await self.client.post(endpoint,json={**valid,**changed})
            self.assertEqual(response.status_code,422,response.text)
        for result in [{'error':'offline failure'},{'text':'{"style_prompt":""}'}]:
            with patch.object(llm,'chat',new=AsyncMock(return_value=result)):
                response=await self.client.post('/plug/manga-maker/api/style-reference',files={'file':('ref.png',reference_png(),'image/png')})
            self.assertEqual(response.status_code,400,response.text)
        self.assertEqual((mod.DATA.parent/'styles.json').read_bytes(),before)

    async def test_imported_generation_options_reach_queue_and_nai_payload(self):
        with patch.object(llm,'chat',new=AsyncMock(return_value={'text':'{"style_prompt":"watercolor"}'})):
            ref=await self.client.post('/plug/manga-maker/api/style-reference',files={'file':('ref.png',reference_png(True),'image/png')})
        r=await self.client.post('/plug/manga-maker/api/projects',json={'story':'A friend visits.','options':{**ref.json()['generation_options'],'workspace':'QA'},'automatic':True})
        self.assertEqual(r.status_code,200,r.text)
        pid=r.json()['id'];p=await self.finish(pid)
        self.assertEqual(p['status'],'complete',p['message'])
        self.assertEqual(p['progress']['completed'],2)
        for i,submission in enumerate(self.host.submissions):
            body=submission.base
            self.assertEqual((body.cfg,body.cfg_rescale,body.steps,body.sampler,body.width,body.height,body.seed),(6.25,.42,31,'k_dpmpp_2m_sde',832,1216,0))  # fixed seed stays fixed
            req=nai.GenRequest(model=body.model,width=body.width,height=body.height,steps=body.steps,cfg=body.cfg,cfg_rescale=body.cfg_rescale,sampler=body.sampler,seed=body.seed)
            params=nai.build_payload(req)['parameters']
            self.assertEqual((params['scale'],params['cfg_rescale'],params['steps'],params['sampler']),(6.25,.42,31,'k_dpmpp_2m_sde'))
            self.assertEqual(params['noise_schedule'],'karras')
        p['options'].update(width=1024,height=1536);mod.save(p)
        changed=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':0})
        self.assertEqual(changed.status_code,200,changed.text)
        await self.finish(pid)
        manual=self.host.submissions[-1].base
        self.assertEqual((manual.width,manual.height),(1024,1536))

    async def test_translation_preserves_layout_speakers_and_images(self):
        pid=await self.create(True);p=await self.finish(pid)
        old=copy.deepcopy(p['pages'])
        def translated(settings,system,messages):
            data=json.loads(messages[0]['content'])
            self.assertEqual(data['language'],'ko')
            return {'text':json.dumps({'panels':[{'lines':['안녕하세요.' for _ in panel['lines']]} for panel in data['panels']]})}
        with patch.object(llm,'chat',new=AsyncMock(side_effect=translated)):
            r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/translate',json={'revision':p['revision']})
            self.assertEqual(r.status_code,200,r.text)
            p=await self.finish(pid)
        self.assertEqual(p['status'],'ready',p['message'])
        for page,before in zip(p['pages'],old):
            expected=copy.deepcopy(before['plan'])
            for panel in expected['panels']:
                for line in panel['dialogue']:line['text']='안녕하세요.'
            self.assertEqual(page['plan'],expected)
            self.assertEqual(page['images'],before['images'])
            self.assertEqual(page['plan_history'][0]['plan'],before['plan'])

    async def test_translation_failure_keeps_all_pages_and_none_preserves_text(self):
        pid=await self.create();p=await self.finish(pid);old=copy.deepcopy(p['pages'])
        first={'text':json.dumps({'panels':[{'lines':['번역됨' for _ in panel['dialogue']]} for panel in old[0]['plan']['panels']]})}
        with patch.object(llm,'chat',new=AsyncMock(side_effect=[first,{'error':'second page failed'}])):
            await self.client.post(f'/plug/manga-maker/api/projects/{pid}/translate',json={'revision':p['revision']})
            p=await self.finish(pid)
        self.assertEqual(p['status'],'error')
        self.assertEqual(p['pages'],old)
        p['options']['dialogue']='none';mod.save(p)
        r=await self.client.get(f'/plug/manga-maker/api/projects/{pid}')
        self.assertNotIn('Text:',r.json()['compiled'][0]['prompt'])
        self.assertEqual(r.json()['pages'],old)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/translate',json={'revision':p['revision']})
        self.assertEqual(r.status_code,400)

    async def test_failure_resume_and_regeneration_preserve_images(self):
        self.host.fail_at=2
        pid=await self.create(True);p=await self.finish(pid)
        self.assertEqual(p['status'],'error');self.assertEqual(len(p['pages'][0]['images']),1)
        self.host.fail_at=None
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision']})
        self.assertEqual(r.status_code,200,r.text)
        p=await self.finish(pid)
        self.assertEqual([x.base.cell_no for x in self.host.submissions],[1,2,2])
        first=p['pages'][0]['images'][0]['file']
        await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':0})
        p=await self.finish(pid)
        self.assertEqual(len(p['pages'][0]['images']),2)
        self.assertTrue(self.host.store.file_path('QA',first).exists())

    async def test_stop_rolls_back_partial_initial_plan(self):
        # 콘티를 한 번에 받으므로 멈출 수 있는 중간 지점은 「밑그림은 나왔고 콘티는 아직」이다.
        waiting=asyncio.Event();calls=0
        async def partial(settings,system,messages,*args):
            nonlocal calls
            calls+=1
            if calls==2:
                waiting.set();await asyncio.Event().wait()
            return await self.chat(settings,system,messages,*args)
        with patch.object(llm,'chat',new=AsyncMock(side_effect=partial)):
            pid=await self.create();await asyncio.wait_for(waiting.wait(),2)
            saved=mod.load(pid)
            self.assertEqual(len(saved['pages']),0);self.assertIsNotNone(saved['outline'])
            old_task=mod.TASKS[pid]
            r=await asyncio.wait_for(self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={}),.2)
            self.assertEqual(r.json()['pages'],[])
            self.assertIsNone(r.json()['outline'])
            self.assertNotIn('checkpoint',r.json())
            await asyncio.gather(old_task,return_exceptions=True)
            self.assertEqual(mod.load(pid)['pages'],[])

    async def test_cancelled_late_replan_cannot_overwrite_new_run(self):
        pid=await self.create();p=await self.finish(pid);before=copy.deepcopy(p['pages'])
        waiting=asyncio.Event();release=asyncio.Event()
        async def late(*args):
            waiting.set()
            try:await asyncio.Event().wait()
            except asyncio.CancelledError:await release.wait()
            return {'text':json.dumps({**PAGE,'title':'Discarded late response'})}
        with patch.object(llm,'chat',new=AsyncMock(side_effect=late)):
            await self.client.post(f'/plug/manga-maker/api/projects/{pid}/replan',json={'revision':p['revision'],'page':0})
            await asyncio.wait_for(waiting.wait(),2);old_task=mod.TASKS[pid]
            stopped=await asyncio.wait_for(self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={}),.2)
        self.assertEqual(stopped.json()['pages'],before)
        try:
            with patch.object(llm,'chat',new=AsyncMock(return_value={'text':json.dumps({**PAGE,'title':'New approved plan'})})) as call:
                r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/replan',json={'revision':stopped.json()['revision'],'page':0,'instructions':'Make the last panel larger.'})
                self.assertEqual(r.status_code,200,r.text)
                newer=await self.finish(pid)
                self.assertEqual(json.loads(call.await_args.args[2][0]['content'])['revision_instructions'],'Make the last panel larger.')
            release.set();await asyncio.gather(old_task,return_exceptions=True)
            self.assertEqual(mod.load(pid),newer)
        finally:release.set();await asyncio.gather(old_task,return_exceptions=True)

    async def test_restart_replaces_story_and_keeps_previous_images_accessible(self):
        pid=await self.create(True);p=await self.finish(pid)
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/restart',json={'revision':p['revision'],'story':'A new story at the beach.','options':{**p['options'],'pages':1,'layout_mode':'free'}})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['pages'],[])
        newer=await self.finish(pid)
        self.assertEqual(newer['status'],'ready',newer['message'])
        self.assertEqual(newer['story'],'A new story at the beach.')
        self.assertEqual(len(newer['pages']),1)
        self.assertEqual(newer['pages'][0]['plan']['layout'],'free')
        self.assertEqual(newer['pages'][0]['images'],[])
        projects=(await self.client.get('/plug/manga-maker/api/projects')).json()['items']
        archive=next(mod.load(x['id']) for x in projects if x['id']!=pid)
        self.assertEqual(archive['pages'],p['pages'])
        self.assertEqual(archive['story'],p['story'])
        exported=await self.client.get(f"/plug/manga-maker/api/projects/{archive['id']}/export")
        with zipfile.ZipFile(io.BytesIO(exported.content)) as z:self.assertIn('page-01-v01.png',z.namelist())

    async def test_restart_stop_and_failure_restore_previous_story_and_images(self):
        pid=await self.create(True);before=await self.finish(pid)
        waiting=asyncio.Event()
        async def blocked(*args):waiting.set();await asyncio.Event().wait()
        for outcome in ['stop','failure','crash']:
            waiting.clear()
            p=mod.load(pid)
            responder=AsyncMock(side_effect=blocked) if outcome!='failure' else AsyncMock(return_value={'error':'fixture failure'})
            with patch.object(llm,'chat',new=responder):
                await self.client.post(f'/plug/manga-maker/api/projects/{pid}/restart',json={'revision':p['revision'],'story':'Replacement story','options':{**p['options'],'pages':1}})
                if outcome!='failure':
                    await asyncio.wait_for(waiting.wait(),2);task=mod.TASKS[pid]
                    if outcome=='stop':
                        await self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={})
                    else:
                        mod.TASKS.pop(pid);task.cancel()
                    await asyncio.gather(task,return_exceptions=True)
                    if outcome=='crash':await self.client.get(f'/plug/manga-maker/api/projects/{pid}')
                else:await self.finish(pid)
            restored=mod.load(pid)
            for field in ['story','options','outline','pages']:self.assertEqual(restored[field],before[field])
        self.assertEqual(len(list(mod.DATA.glob('*.json'))),1)

    async def test_translation_stop_discards_buffered_pages(self):
        pid=await self.create(True);before=await self.finish(pid);waiting=asyncio.Event();calls=0
        async def translate(settings,system,messages):
            nonlocal calls
            calls+=1
            if calls==2:waiting.set();await asyncio.Event().wait()
            req=json.loads(messages[0]['content'])
            return {'text':json.dumps({'panels':[{'lines':['Changed' for _ in panel['lines']]} for panel in req['panels']]})}
        with patch.object(llm,'chat',new=AsyncMock(side_effect=translate)):
            await self.client.post(f'/plug/manga-maker/api/projects/{pid}/translate',json={'revision':before['revision']})
            await asyncio.wait_for(waiting.wait(),2);task=mod.TASKS[pid]
            stopped=await asyncio.wait_for(self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={}),.2)
            await asyncio.gather(task,return_exceptions=True)
        self.assertEqual(stopped.json()['pages'],before['pages'])

    async def test_stop_removes_only_own_queued_job_during_enqueue(self):
        pid=await self.create();p=await self.finish(pid)
        self.host.worker.cancel();await asyncio.gather(self.host.worker,return_exceptions=True)
        other=self.host.Q.add_job(self.host.QueueBody(base=self.host.GenBody(cell_id='unrelated')),1,'qa')
        queued=asyncio.Event();original=self.host.generate_queue
        async def delayed(body):
            await original(body);queued.set();await asyncio.Event().wait()
        self.host.generate_queue=delayed
        await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json={'revision':p['revision'],'page':0})
        await asyncio.wait_for(queued.wait(),2);task=mod.TASKS[pid]
        self.assertNotIn('job_id',mod.load(pid)['pending'])
        await self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={})
        await asyncio.gather(task,return_exceptions=True)
        self.assertEqual([j['id'] for j in self.host.Q.all_jobs()],[other])
        self.assertEqual(self.host.Q.lane('qa').total_images,1)
        self.assertEqual(mod.load(pid)['pages'],p['pages'])

    async def test_stop_discards_inflight_result_without_deleting_output(self):
        self.host.delay=.6
        pid=await self.create(True)
        for _ in range(100):
            if self.host.Q.lane('qa').current_job:break
            await asyncio.sleep(.01)
        current=(await self.client.get(f'/plug/manga-maker/api/projects/{pid}')).json()
        self.assertEqual(current['progress']['phase'],'generate')
        self.assertEqual((current['progress']['completed'],current['progress']['total']),(0,2))
        self.assertIn(current['queue_state'],['waiting','running'])
        stopped=await asyncio.wait_for(self.client.post(f'/plug/manga-maker/api/projects/{pid}/stop',json={}),.2)
        self.assertEqual(stopped.status_code,200,stopped.text)
        self.assertFalse(mod.running(pid))
        p=await self.finish(pid)
        self.assertEqual(p['status'],'paused');self.assertEqual(len(self.host.submissions),1)
        self.assertEqual(len(p['pages'][0]['images']),0)
        while self.host.Q.all_jobs():await asyncio.sleep(.02)
        self.assertEqual(mod.load(pid)['pages'],p['pages'])
        self.assertEqual(len(self.host.store.records('QA')),1)
        record=self.host.store.records('QA')[0]
        self.assertTrue(self.host.store.file_path('QA',record['file']).is_file())

    async def test_edits_conflicts_and_duplicate_generation(self):
        pid=await self.create();p=await self.finish(pid)
        edit={'revision':p['revision'],'options':p['options'],'outline':p['outline'],'pages':[x['plan'] for x in p['pages']]}
        edit['pages'][0]['panels'][0]['subjects'][0]['x']=.8
        r=await self.client.put(f'/plug/manga-maker/api/projects/{pid}',json=edit)
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual(r.json()['compiled'][0]['characters'][0]['center']['x'],.9)
        stale=await self.client.put(f'/plug/manga-maker/api/projects/{pid}',json=edit)
        self.assertEqual(stale.status_code,409)
        request={'revision':r.json()['revision']}
        r1=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json=request)
        r2=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/generate',json=request)
        self.assertEqual(r1.status_code,200);self.assertEqual(r2.status_code,409)
        await self.finish(pid)

    async def test_restart_reconciles_saved_inflight_result(self):
        pid=await self.create(True);p=await self.finish(pid)
        record=p['pages'][1]['images'].pop()
        p['pending']={'page':1,'cell_id':record['cell_id'],'workspace':'QA'};p['status']='generating';mod.save(p)
        await asyncio.sleep(0)
        r=await self.client.get(f'/plug/manga-maker/api/projects/{pid}')
        self.assertEqual(r.json()['status'],'paused');self.assertEqual(len(r.json()['pages'][1]['images']),1)
        self.assertEqual(len(self.host.submissions),2)

    async def test_short_and_cut_storyboards_keep_what_arrived(self):
        # ★★온 만큼은 받는다 (사용자 지시 2026-09-21). 다시 묻는 것은 처음부터 다시 출력시키는 일이라,
        #   덜 왔다고 버리면 이미 만들어 둔 페이지까지 함께 날아간다.
        llm.chat.side_effect=[{'text':json.dumps(OUTLINE)},{'text':json.dumps({'pages':[PAGE]})}]
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual((p['status'],len(p['pages']),len(p['outline']['pages'])),('paused',1,2),p['message'])
        self.assertIn('출력이 중간에 끊겼습니다',p['message'])
        self.assertEqual(llm.chat.await_count,2,'덜 왔다고 고쳐 묻지 않는다')
        # ★콘티 요청에만 출력 상한을 싣는다 — 앤트로픽 직결의 기본 32,000이면 8페이지가 잘린다.
        board=next(c for c in llm.chat.await_args_list if 'Storyboard every remaining page' in json.loads(c.args[2][0]['content'])['task'])
        self.assertEqual(board.args[4],mod.PLAN_TOKENS)
        self.assertEqual(len(llm.chat.await_args_list[0].args),3,'밑그림 요청에는 상한을 안 싣는다')
        # 끝이 잘려 통째로는 못 읽는 응답에서도 완결된 페이지는 건진다.
        llm.chat.reset_mock()
        llm.chat.side_effect=[{'text':json.dumps(OUTLINE)},{'text':json.dumps({'pages':[PAGE,PAGE]})[:-30]}]
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual((p['status'],len(p['pages'])),('paused',1),p['message'])
        self.assertEqual(llm.chat.await_count,2,'건질 것이 있으면 고쳐 묻지 않는다')
        # 못 받은 페이지는 밑그림에서 지운다 — 지울 컷도 이미지도 없다.
        r=await self.client.post(f'/plug/manga-maker/api/projects/{pid}/pages/1/delete',json={'revision':p['revision']})
        self.assertEqual(r.status_code,200,r.text)
        self.assertEqual((r.json()['status'],len(r.json()['pages']),len(r.json()['outline']['pages'])),('ready',1,1))

    async def test_bad_llm_json_correction_and_missing_destination(self):
        # 밑그림이 한 번 깨져 고쳐 묻고, 콘티 두 장은 한 번의 요청으로 받는다.
        llm.chat.side_effect=[{'text':'not json'},{'text':json.dumps(OUTLINE)},{'text':json.dumps({'pages':[PAGE,PAGE]})}]
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual(p['status'],'ready');self.assertEqual(llm.chat.await_count,3)
        # A prose refusal twice in a row: the error shows the model's own words.
        llm.chat.side_effect=[{'text':'죄송하지만 그 내용은 도와드릴 수 없습니다.'},{'text':'죄송하지만 그 내용은 도와드릴 수 없습니다.'}]
        pid=await self.create();p=await self.finish(pid)
        self.assertEqual(p['status'],'error');self.assertIn('기획 형식',p['message']);self.assertIn('죄송하지만 그 내용은 도와드릴 수 없습니다.',p['message'])
        r=await self.client.post('/plug/manga-maker/api/projects',json={'story':'test','automatic':True})
        self.assertEqual(r.status_code,400)


if __name__=='__main__':unittest.main(verbosity=2)
