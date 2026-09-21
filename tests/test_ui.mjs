// DOM integration tests, not a browser renderer. Uses only the offline fixture server.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { JSDOM } from '../../../_tmp/manga-maker-test-tools/node_modules/jsdom/lib/api.js';

const url='http://127.0.0.1:8779/k/qa/plug/manga-maker/web/';
const html=await fs.readFile(new URL('../web/index.html',import.meta.url),'utf8');
const i18n=await fs.readFile(new URL('../web/i18n.js',import.meta.url),'utf8');
const css=await fs.readFile(new URL('../web/style.css',import.meta.url),'utf8');
/* ★사용자 지적 2026-09-20: 컷이 길어져 스크롤이 생기면 콘티 너비가 5.66px 줄었다. 구르는 칸
   안에 콘티와 편집창이 같이 있어 스크롤바 10px 이 둘에 나뉜 것이다. jsdom 은 배치를 셈하지
   않으므로 규칙이 살아 있는지만 본다. */
assert.match(css,/\.work \{[^}]*scrollbar-gutter: stable/, '구르는 칸은 스크롤바 자리를 늘 비워 둔다');
const script=(await fs.readFile(new URL('../web/app.js',import.meta.url),'utf8'))
  .replace('init().catch(error);','window.qaReady=init().catch(error);');
/** 앱 창구 대역 — 확인창은 앱이 그리므로(`peropix.ask`) 여기서는 「확인」으로 답한다.
 *  ★`inApp:false` 다: 언어·워크스페이스를 앱에 묻는 길은 이 시험에서 타지 않는다. */
const hostStub = 'window.peropix={inApp:false,ask:async()=>true,toast(){},onLocale(){},state:async()=>({})};';
const calls=[];
let staleReferenceResponse=false;
await fetch(new URL('../api/llm',url),{method:'PUT',headers:{'Content-Type':'application/json'},body:JSON.stringify({provider:'',model:''})});
const dom=new JSDOM(html,{url,runScripts:'outside-only'});
const w=dom.window, $=id=>w.document.getElementById(id);
w.FormData=globalThis.FormData;
w.fetch=async (url,opts)=>{
  calls.push([String(url),opts]);const response=await fetch(String(url),opts);
  if(staleReferenceResponse&&String(url).endsWith('/style-reference')&&response.ok){
    const data=await response.json();data.generation_options={...data.generation_options,width:1344,height:768};
    return new Response(JSON.stringify(data),{headers:{'Content-Type':'application/json'}});
  }
  return response;
};
w.eval(hostStub+i18n+script+'\nwindow.qa = {get:()=>doc, persist, render, options};');
async function wait(test,label) {
  const deadline=Date.now()+15000;
  while(Date.now()<deadline){if(test())return;await new Promise(r=>setTimeout(r,50));}
  throw new Error(`Timed out: ${label}; alert=${$('alert').textContent}; status=${$('status').textContent}`);
}
function input(el,value,event='input'){el.value=value;el.dispatchEvent(new w.Event(event,{bubbles:true}));}
// 화풍 목록: 고르면 곧 적용되고, 이름 변경·삭제는 항목 안의 버튼이다.
function openStyles(){ if($('styleList').hidden)$('stylePicker').click(); }
function styleRow(id,what){ openStyles(); return w.document.querySelector(`[data-${what}="${id}"]`); }
const currentStyle=()=>w.document.querySelector('[data-pick][aria-selected="true"]')?.dataset.pick || '';
const styleNames=()=>[...w.document.querySelectorAll('[data-pick]')].map(el=>el.textContent);
try {
  await w.qaReady;
  await wait(()=>$('llm').textContent.includes('offline-fixture'),'config');
  for(const tag of w.document.querySelectorAll('script[src],link[href]')){
    const target=new URL(tag.getAttribute('src')||tag.getAttribute('href'),url);
    const r=await fetch(target);assert.equal(r.status,200,target.href);
  }
  // 콘티가 없을 때 — 안내 줄은 없고, 칸은 이번에 그릴 내용을 받는다
  assert.equal($('composeHint').hidden,true,'콘티가 없으면 버튼 아래에 줄이 없다');
  assert.equal($('story').placeholder,'무엇을 그릴지 적습니다');
  $('plan').click();await wait(()=>!$('alert').hidden,'empty story validation');
  assert.equal(calls.filter(([u,o])=>u.endsWith('/projects')&&o?.method==='POST').length,0);
  assert.ok([...$('llmProvider').options].some(o=>o.value==='cli:codex'&&!o.disabled));
  // API: the model list loads by itself even when the host attaches a note, and the effort
  // dropdown shows the picked model's levels the way the app settings screen does.
  input($('llmProvider'),'openrouter','change');
  await wait(()=>[...$('llmModel').options].some(o=>o.value==='x-ai/grok-4.6'),'OpenRouter models load automatically');
  assert.ok($('llm').textContent.includes('추천 목록에 없는 모델'),'host note is shown, not treated as failure');
  input($('llmModel'),'openai/gpt-5.5','change');assert.equal($('llmEffort').hidden,true);
  input($('llmModel'),'x-ai/grok-4.6','change');assert.equal($('llmEffort').hidden,false);
  assert.deepEqual([...$('llmEffort').options].map(o=>[o.value,o.textContent]),[['','모델 기본값  ·  medium'],['low','low'],['medium','medium'],['high','high'],['none','끄기']]);
  input($('llmProvider'),'cli:codex','change');
  assert.equal($('llmModel').disabled,false);
  assert.ok([...$('llmModel').options].some(o=>o.value==='fixture-codex'),'CLI models fill the model dropdown by themselves');
  input($('llmModel'),'fixture-codex','change');
  assert.deepEqual([...$('llmEffort').options].map(o=>o.value),['max','xhigh','high','medium','low']);
  assert.equal($('llmEffort').value,'high');assert.equal($('llmEffort').hidden,false);
  // 저장 버튼 없이 고르는 즉시 저장된다.
  await wait(()=>$('llm').textContent.includes('Codex CLI · fixture-codex · high'),'save CLI selection');
  $('llmRefresh').click();await wait(()=>$('llm').textContent.includes('모델 1개'),'CLI model list');
  assert.equal($('layoutMode').value,'free');
  assert.equal($('maxPanels').value,'0');
  assert.equal($('dialogue').value,'ko');
  const ref=await fs.readFile(new URL('../../../_tmp/manga-maker-qa-llm/style-reference.png',import.meta.url));
  Object.defineProperty($('styleImage'),'files',{value:[new File([ref],'ref.png',{type:'image/png'})],configurable:true});
  $('styleImage').dispatchEvent(new w.Event('change',{bubbles:true}));
  await wait(()=>!$('referenceActivity').hidden,'visible reference activity');
  assert.equal($('activityCard').getAttribute('aria-busy'),'true');
  assert.equal($('activitySpinner').hidden,false);
  assert.ok($('activityBadge').textContent.includes('참고 이미지'));
  await wait(()=>$('stylePrompt').value==='watercolor, paper texture'&&!$('plan').disabled,'import reference style');
  assert.equal($('style').value,'custom','화풍을 가져오면 「내 화풍」으로 바뀐다');
  assert.equal($('stylePrompt').value,'watercolor, paper texture');
  assert.equal($('negativePrompt').value,'bad hands, screentone');
  assert.equal($('referenceActivity').hidden,true);
  assert.equal($('cfg').value,'6.25');assert.equal($('cfgRescale').value,'0.42');assert.equal($('steps').value,'31');
  assert.equal($('sampler').value,'k_dpmpp_2m_sde');assert.equal($('seed').value,'0');
  assert.equal($('size').value,'832,1216');assert.equal($('width').value,'832');assert.equal($('height').value,'1216');
  assert.ok($('importedOptions').textContent.includes('리스케일 0.42'));
  openStyles();
  const savedStyleId=currentStyle();
  assert.ok(savedStyleId,'Extraction automatically saves and selects the style');
  assert.equal($('stylePickerLabel').textContent,'ref');
  assert.ok($('styleLibraryStatus').textContent.includes('자동 저장'));
  styleRow(savedStyleId,'rename').click();
  input(w.document.querySelector('.style-rename-input'),'부드러운 수채화 <내 화풍>');
  w.document.querySelector('[data-rename-ok]').click();
  await wait(()=>$('styleLibraryStatus').textContent.includes('이름 변경됨')&&!$('stylePicker').disabled,'rename saved style');
  assert.equal($('stylePickerLabel').textContent,'부드러운 수채화 <내 화풍>');
  openStyles();
  assert.ok(styleNames().includes('부드러운 수채화 <내 화풍>'));
  assert.equal(w.document.querySelector('[data-pick]').querySelector('내'),null,'style names must be escaped');
  const extractionCount=()=>calls.filter(([u])=>u.endsWith('/style-reference')).length;
  const beforeReuse=extractionCount();
  input($('size'),'1024,1536','change');input($('cfg'),'1','change');input($('negativePrompt'),'manual negative','change');
  styleRow(savedStyleId,'pick').click();
  await wait(()=>$('styleLibraryStatus').textContent.includes('적용됨')&&!$('stylePicker').disabled,'reuse saved style');
  assert.equal($('styleList').hidden,true,'목록은 고른 뒤 닫힌다');
  assert.equal(w.document.querySelector('[data-pane="generation"]').hidden,true,'화풍을 골라도 생성 탭으로 넘어가지 않는다');
  assert.equal($('negativePrompt').value,'bad hands, screentone');assert.equal($('cfg').value,'6.25');
  assert.equal($('width').value,'1024');assert.equal($('height').value,'1536');
  assert.equal(extractionCount(),beforeReuse,'Applying a saved style must not extract again');
  input($('size'),'832,1216','change');
  $('workspace').value='QA';$('example').click();const exampleStory=$('story').value;$('plan').click();$('plan').click();
  await wait(()=>w.qa.get()?.status==='planning','planning activity');
  assert.equal($('activitySpinner').hidden,false);
  await wait(()=>w.qa.get()?.status==='ready','plan');
  assert.equal($('activitySpinner').hidden,true);
  assert.equal(calls.filter(([u,o])=>u.endsWith('/projects')&&o?.method==='POST').length,1,'double click must not create duplicate paid tasks');
  assert.equal(w.document.querySelectorAll('[data-cut]').length,5,'컷마다 번호 칩 하나');
  assert.equal(w.document.querySelectorAll('.panel-card').length,1,'컷은 한 번에 하나만 편다');
  assert.equal(w.document.querySelectorAll('[data-marker]').length,5);
  assert.equal($('story').disabled,false);
  assert.equal($('pageCount').disabled,false);
  // ★사용자 지시 2026-09-20: 콘티를 만들어도 적어 둔 글은 남는다. 그리고 그 뒤로는 이어서 그리는 칸이다.
  assert.equal($('story').value,exampleStory,'콘티를 만들어도 적어 둔 글은 남는다');
  assert.equal($('story').placeholder,'이어서 그릴 내용 (비워도 됩니다)');
  assert.equal($('composeHint').hidden,false);
  assert.equal($('composeHint').textContent,'지금 이야기 뒤에 이어서 그려집니다.','콘티가 있으면 뒤에 이어 그린다고 알린다');
  const pid=w.qa.get().id;
  assert.equal(w.qa.get().llm.provider,'cli:codex');
  assert.equal(w.qa.get().llm.model,'fixture-codex');
  assert.equal(w.qa.get().pages[0].plan.layout,'free');
  assert.equal(w.qa.get().options.reference_name,'ref.png');
  assert.equal(w.qa.get().options.reference_style,true,'화풍 프롬프트가 있으면 기본 태그를 대신한다');
  assert.equal(w.qa.get().compiled[0].negative_prompt,'bad hands, screentone');
  assert.ok(!w.qa.get().compiled[0].prompt.includes('ink lineart'));
  assert.deepEqual([...$('style').options].map(o=>o.value),['mono','color','custom']);
  input($('style'),'mono','change');
  input($('stylePrompt'),'pencil drawing','change');
  assert.equal($('style').value,'custom','화풍을 적으면 「내 화풍」으로 바뀐다');
  await w.qa.persist();
  assert.ok(w.qa.get().compiled[0].prompt.includes('pencil drawing'));
  input($('size'),'1024,1536','change');await w.qa.persist();
  staleReferenceResponse=true;
  $('styleImage').dispatchEvent(new w.Event('change',{bubbles:true}));
  await wait(()=>w.qa.get().compiled[0].prompt.includes('watercolor')&&!$('plan').disabled,'replace style on existing project');
  staleReferenceResponse=false;
  assert.equal($('size').value,'1024,1536');assert.equal($('width').value,'1024');assert.equal($('height').value,'1536');
  assert.equal(w.qa.get().options.width,1024);assert.equal(w.qa.get().options.height,1536);
  assert.ok(!$('importedOptions').textContent.includes('1344'),'Ignore resolution even from an older server response');
  input($('cfg'),'0','change');input($('negativePrompt'),'','change');
  $('saveStyle').click();
  assert.equal($('styleNameRow').hidden,false,'이름은 제자리 입력칸으로 받는다');
  input($('styleName'),'수정한 화풍');
  $('styleNameOk').click();await wait(()=>$('styleLibraryStatus').textContent.includes('새 화풍으로 저장됨')&&!$('saveStyle').disabled,'save current settings as new style');
  assert.equal($('styleNameRow').hidden,true,'저장하면 입력칸이 닫힌다');
  const customStyleId=currentStyle();
  assert.notEqual(customStyleId,savedStyleId);
  const stored=await (await fetch(new URL(`../api/styles/${customStyleId}`,url))).json();
  assert.equal(stored.negative_prompt,'');assert.equal(stored.generation_options.cfg,0);
  assert.equal(stored.generation_options.seed,0);
  assert.ok(!('width' in stored.generation_options));assert.ok(!('height' in stored.generation_options));
  styleRow(savedStyleId,'pick').click();
  await wait(()=>w.qa.get().compiled[0].negative_prompt==='bad hands, screentone'&&!$('stylePicker').disabled,'apply saved style to existing project');
  assert.equal(w.qa.get().options.cfg,6.25);assert.equal(w.qa.get().options.width,1024);assert.equal(w.qa.get().options.height,1536);
  assert.equal(extractionCount(),beforeReuse+1);
  assert.equal(w.document.querySelectorAll('[data-panel-shape]').length,5);
  assert.equal(w.document.querySelector('[data-panel-shape]').dataset.panelShape,'3','borderless artwork stays behind insets regardless of narrative order');
  assert.equal(w.document.querySelector('[data-panel-shape="3"]').getAttribute('stroke'),'none');
  assert.ok(!w.qa.get().compiled[0].prompt.includes('bounds x='));
  assert.ok(w.qa.get().compiled[0].prompt.includes('multiple views, comic, manga, dynamic angle'),'reference tag base');
  assert.ok(w.document.querySelector('[data-page-field="setting"]'),'page setting tags field');
  assert.ok(w.document.querySelector('[data-panel="0"] [data-subject-field="camera"]'),'camera tags field');
  /* ★컷 안 위치는 콘티에서 끌어서만 정한다 (사용자 지시 2026-09-20) — 숫자칸이 없다.
     끌기는 jsdom 에서 못 하므로 값만 옮기고, 편집창을 거쳐 저장 표시를 세운다. */
  assert.equal(w.document.querySelector('[data-panel="0"] [data-subject-field="x"]'),null,'컷 안 위치 숫자칸이 없다');
  w.qa.get().pages[0].plan.panels[0].subjects[0].x=.8;
  input(w.document.querySelector('[data-panel="0"] [data-panel-field="summary"]'),w.qa.get().pages[0].plan.panels[0].summary);
  await w.qa.persist();
  assert.equal(w.qa.get().compiled[0].characters[0].center.x,.886);
  input($('direction'),'ltr','change');await w.qa.persist();
  assert.equal(w.qa.get().compiled[0].characters[0].center.x,.886,'free layout preserves explicit regions and narrative order');
  // 좌표 칸은 「영역」을 눌러야 펼쳐진다.
  assert.equal(w.document.querySelector('[data-panel="0"] [data-region-field="w"]'),null);
  w.document.querySelector('[data-panel="0"] [data-region-toggle]').click();
  assert.equal(w.document.querySelector('[data-panel="0"] [data-region-toggle]').getAttribute('aria-expanded'),'true');
  input(w.document.querySelector('[data-panel="0"] [data-region-field="w"]'),'.5');await w.qa.persist();
  assert.equal(w.qa.get().compiled[0].characters[0].center.x,.83);
  input(w.document.querySelector('[data-panel="0"] [data-region-field="frame"]'),'slant-down');await w.qa.persist();
  assert.equal(w.qa.get().compiled[0].characters[0].center.y,.4095);
  /* ★★콘티의 번호와 자리가 **실제로 NAI 에 실리는 캐릭터 프롬프트**와 맞는가.
     화면은 끌기에 바로 따라가려고 자리를 제 손으로 셈하므로(`promptSlots`·`boxes`), 서버의
     `compile_page` 와 어긋날 수 있다. 어긋나면 번호를 보여 주는 뜻이 없어지므로 여기서 맞댄다. */
  {
    const chars=w.qa.get().compiled[0].characters;
    const H=500*(+$('height').value)/(+$('width').value);
    const marks=[...$('board').querySelectorAll('g[transform]')].map(g=>({
      n:+g.querySelector('text').textContent,
      at:/translate\(([-\d.]+),([-\d.]+)\)/.exec(g.getAttribute('transform')),
    })).filter(m=>m.at&&Number.isInteger(m.n));
    assert.equal(marks.length,chars.length,'캐릭터 프롬프트마다 표식 하나');
    assert.deepEqual(marks.map(m=>m.n).sort((a,b)=>a-b),chars.map((_,i)=>i+1),'번호는 1..n');
    for(const m of marks){
      const c=chars[m.n-1];
      assert.ok(Math.abs(+m.at[1]-c.center.x*500)<.6,`표식 ${m.n} 의 가로 자리`);
      assert.ok(Math.abs(+m.at[2]-c.center.y*H)<.6,`표식 ${m.n} 의 세로 자리`);
    }
  }
  /* ★인물 대사는 그 인물 블록 안에 들어가 **같은 번호**에 묶이고, 내레이션은 자기 블록으로 선다.
     번호는 「실제 NAI 프롬프트」의 차례와 같아야 뜻이 있다 (`slotNumbers`). */
  {
    const panel0=()=>w.document.querySelector('[data-panel="0"]');
    const badge=block=>+block.querySelector('.slot-badge').textContent;
    const notes=()=>[...panel0().querySelectorAll('.slot-block')].filter(b=>b.dataset.line!==undefined);
    const walk=[];
    for (let i=0;i<w.qa.get().pages[0].plan.panels.length;i++) {
      w.document.querySelector(`[data-cut="${i}"]`).click();
      walk.push(...[...w.document.querySelectorAll('.slot-block')].map(badge));
    }
    assert.deepEqual(walk,walk.map((_,i)=>i+1),'컷을 차례로 펴면 편집창 번호가 콘티와 같은 1..n 이다');
    w.document.querySelector('[data-cut="0"]').click();
    const said=panel0().querySelector('.slot-block[data-subject] .dialogue-row');
    assert.ok(said,'인물 대사는 그 인물 블록 안에 있다');
    const block=said.closest('.slot-block');
    assert.equal(block.dataset.subject,'0','대사가 화자의 블록에 묶인다');
    assert.ok([...said.querySelector('[data-line-field="speaker"]').options].every(o=>o.value),
              '화자 목록에 내레이션이 없다 — 내레이션은 따로 추가한다');
    assert.ok(w.qa.get().compiled[0].characters[badge(block)-1].prompt.includes('speech bubble'),
              '블록의 번호가 그 대사를 담은 캐릭터 프롬프트다');
    assert.equal(notes().length,0);
    const plan=()=>w.qa.get().pages[0].plan.panels[0];
    const adder=block.querySelector('[data-add-line]');
    assert.ok(adder,'「대사 추가」는 인물 블록 안에 있다');
    assert.equal(adder.dataset.addFor,'0','누른 인물의 대사로 붙는다');
    adder.click();
    assert.equal(plan().dialogue.at(-1).speaker,plan().subjects[0].character);
    plan().dialogue.pop(); w.qa.render();

    panel0().querySelector('[data-add-note]').click();
    assert.equal(notes().length,1,'내레이션은 대사 줄이 아니라 자기 블록으로 추가된다');
    assert.equal(panel0().querySelectorAll('.dialogue-row').length,1,'내레이션이 대사 줄로 늘지 않는다');
    panel0().querySelector('[data-add-subject]').click();
    assert.equal(plan().subjects.length,2,'인물 추가가 컷의 인물을 늘린다');
    assert.equal(plan().subjects[1].action,'','새 인물의 동작 태그는 비어 있다');
    await w.qa.persist();
    assert.equal(notes().length,1);
    const at=badge(notes()[0]);
    assert.ok(w.qa.get().compiled[0].characters[at-1].prompt.startsWith('no humans, narration box'),
              '내레이션 블록의 번호가 실제 내레이션 프롬프트다');
    assert.ok(!w.qa.get().compiled[0].characters[1].prompt.includes('undefined'),'빈 동작 태그는 프롬프트에서 빠진다');
    assert.ok([...$('board').querySelectorAll('[data-marker]')].some(g=>g.dataset.marker.includes(',note,')),
              '내레이션 표식도 잡아서 옮길 수 있다');
    /* ★하나 더 넣어도 이미 놓인 내레이션은 제자리에 있어야 한다. 자리를 안 들고 있으면 개수로
       나눠 놓으므로, 굳혀 두지 않으면 있던 것이 밀린다 (`core.compile_page`). */
    const was={...w.qa.get().compiled[0].characters[at-1].center};
    panel0().querySelector('[data-add-note]').click();
    await w.qa.persist();
    assert.equal(notes().length,2);
    assert.deepEqual({...w.qa.get().compiled[0].characters[at-1].center},was,'내레이션을 더해도 있던 것은 안 움직인다');
    /* `persist` 는 저장 표시(`dirty`)가 섰을 때만 보낸다. 끌기는 이 시험에서 못 하므로 자리만
       손으로 옮기고, 편집창에 같은 값을 다시 써 넣어 표시를 세운다. */
    const touch=()=>input(w.document.querySelector('[data-panel="0"] [data-panel-field="summary"]'),plan().summary);
    plan().dialogue.find(d=>!d.speaker).x=.9;
    touch(); await w.qa.persist();
    assert.notDeepEqual({...w.qa.get().compiled[0].characters[at-1].center},was,'옮겨 놓은 자리가 그대로 실린다');
    // 뒤의 판정이 원래 페이지를 보도록 시험이 넣은 것을 도로 뺀다.
    plan().subjects.pop();
    plan().dialogue=plan().dialogue.filter(d=>d.speaker);
    w.qa.render(); touch();
    await w.qa.persist();
  }
  /* ★컷 칩으로 고른 컷은 콘티에서도 강조된다 (사용자 지시 2026-09-20). 색을 못 박지 않고
     「하나만 다르다」로 본다 — 무엇이 강조인지는 색이 아니라 갈린다는 사실이다. */
  {
    const fills=()=>Object.fromEntries([...$('board').querySelectorAll('[data-panel-shape]')]
      .map(s=>[s.dataset.panelShape,s.getAttribute('fill')]));
    let f=fills();
    assert.equal(new Set(Object.values(f)).size,2,'고른 컷 하나만 바탕이 다르다');
    assert.notEqual(f['0'],f['1'],'처음에는 첫 컷이 강조된다');
    w.document.querySelector('[data-cut="2"]').click();
    f=fills();
    assert.notEqual(f['2'],f['1'],'칩을 누르면 그 컷이 강조된다');
    assert.equal(f['0'],f['1'],'앞서 고른 컷은 평범해진다');
    w.document.querySelector('[data-cut="0"]').click();
  }
  input(w.document.querySelector('[data-panel-field="summary"]'),'<img src=x onerror=alert(1)>');await w.qa.persist();
  assert.equal($('board').querySelector('img'),null,'story text must be escaped');
  $('generatePage').click();
  await wait(()=>w.qa.get()?.status==='complete','single page generation');
  assert.equal(w.qa.get().pages[0].images.length,1);
  assert.equal(w.qa.get().pages[1].images.length,0);
  $('imageMode').click();
  assert.ok(w.document.querySelector('.editing').classList.contains('image-view'));
  input($('previewWidth'),'760');
  assert.equal(w.document.documentElement.style.getPropertyValue('--preview-width'),'760px');
  assert.ok($('previewWidthValue').textContent.includes('760'));
  $('fitPreview').click();assert.equal(w.document.documentElement.style.getPropertyValue('--preview-width'),'100%');
  input($('previewWidth'),'900');
  $('toggleSetup').click();assert.equal($('setupBody').hidden,true);assert.equal($('toggleSetup').getAttribute('aria-expanded'),'false');
  $('toggleSetup').click();assert.equal($('setupBody').hidden,false);
  $('toggleEditor').click();assert.equal($('editorPane').hidden,true);
  $('toggleEditor').click();assert.equal($('editorPane').hidden,false);
  w.document.querySelector('.tabitem[data-tab="generation"]').click();
  await new Promise(r=>setTimeout(r,50));
  assert.equal(JSON.parse(w.localStorage.getItem('manga-maker-view')).tab,'generation');
  assert.equal(w.document.querySelector('[data-pane="generation"]').hidden,false);
  assert.equal(w.document.querySelector('[data-pane="story"]').hidden,true);
  assert.equal(w.document.querySelector('.tabitem[data-tab="generation"]').getAttribute('aria-selected'),'true');
  const image=$('result').querySelector('img');
  assert.ok(image.src.startsWith('http://127.0.0.1:8779/k/qa/api/file/'));
  assert.equal((await fetch(image.src)).status,200,'output URL works under keyed prefix');
  $('generateAll').click();await wait(()=>w.qa.get()?.status==='complete'&&w.qa.get().pages[1].images.length===1,'remaining pages');
  assert.equal($('generateAll').disabled,true);
  $('generatePage').click();await wait(()=>w.qa.get()?.status==='complete'&&w.qa.get().pages[0].images.length===2,'regeneration');
  assert.equal($('version').options.length,2,'old generated images remain selectable');
  input($('replanInstructions'),'마지막 장면은 큰 컷으로, 대사는 짧게.');
  $('replanPage').click();
  await wait(()=>w.qa.get()?.status==='ready'&&w.qa.get().pages[0].plan.panels.length===7,'free replan changes panel count');
  assert.equal(w.qa.get().pages[0].images.length,2);
  assert.equal(w.qa.get().pages[0].plan_history[0].plan.panels.length,5);
  assert.equal(w.document.querySelectorAll('[data-cut]').length,7,'다시 기획하면 칩도 그만큼 선다');
  assert.equal(JSON.parse(calls.findLast(([u,o])=>u.endsWith('/replan')&&o?.method==='POST')[1].body).instructions,'마지막 장면은 큰 컷으로, 대사는 짧게.');
  const beforeStop=JSON.stringify(w.qa.get().pages);
  $('replanPage').click();await wait(()=>!$('stop').hidden,'replan stop available');
  $('stop').click();await wait(()=>w.qa.get()?.status==='paused'&&!$('plan').disabled,'immediate replan stop');
  assert.equal(JSON.stringify(w.qa.get().pages),beforeStop);
  assert.equal($('activitySpinner').hidden,true);
  assert.equal($('story').disabled,false);
  assert.equal($('dialogue').disabled,false);
  input($('dialogue'),'none','change');await w.qa.persist();
  assert.equal(w.document.querySelectorAll('[data-line-field="text"]').length,0);
  assert.ok(w.qa.get().pages[0].plan.panels[0].dialogue.length);
  input($('dialogue'),'en','change');await w.qa.persist();
  $('translateDialogue').click();
  await wait(()=>w.qa.get()?.status==='ready'&&w.qa.get().pages[0].plan.panels[0].dialogue[0].text==='Hello.','translate existing dialogue');
  assert.equal(w.qa.get().pages[0].plan.panels.length,7);
  assert.equal(w.qa.get().pages[0].images.length,2);
  const r=await fetch(new URL(`../api/projects/${pid}/export`,url));assert.equal(r.status,200);
  const reload=new JSDOM(html,{url,runScripts:'outside-only'});
  reload.window.fetch=fetch;
  reload.window.localStorage.setItem('manga-maker-current',pid);
  reload.window.localStorage.setItem('manga-maker-view',w.localStorage.getItem('manga-maker-view'));
  reload.window.eval(hostStub+i18n+script+'\nwindow.qa = {get:()=>doc};');
  await reload.window.qaReady;
  reload.window.document.getElementById('stylePicker').click();
  assert.ok([...reload.window.document.querySelectorAll('[data-pick]')].some(el=>el.dataset.pick===savedStyleId&&el.textContent==='부드러운 수채화 <내 화풍>'));
  assert.ok([...reload.window.document.querySelectorAll('[data-pick]')].some(el=>el.dataset.pick===customStyleId));
  await wait(()=>reload.window.qa.get()?.id===pid,'reopen');
  assert.equal(reload.window.qa.get().pages[0].images.length,2);
  assert.equal(reload.window.document.getElementById('llmProvider').value,'cli:codex');
  assert.equal(reload.window.document.getElementById('llmModel').value,'fixture-codex');
  assert.equal(reload.window.qa.get().pages[0].plan.panels.length,7);
  assert.ok(reload.window.document.getElementById('stylePrompt').value,'화풍 프롬프트가 복원된다');
  assert.equal(reload.window.document.getElementById('negativePrompt').value,'bad hands, screentone');
  assert.equal(reload.window.document.getElementById('dialogue').value,'en');
  assert.equal(reload.window.document.getElementById('cfgRescale').value,'0.42');
  assert.equal(reload.window.document.getElementById('width').value,'1024');
  assert.equal(reload.window.document.getElementById('height').value,'1536');
  const beforeDelete=JSON.stringify(w.qa.options());
  // 삭제는 되돌릴 수 없어 확인을 거친다 — 확인창은 앱이 그린다 (`peropix.ask`, 위의 대역이 「확인」으로 답한다)
  styleRow(customStyleId,'delete').click();
  await wait(()=>$('styleLibraryStatus').textContent.includes('삭제됨')&&!$('saveStyle').disabled,'delete saved style');
  openStyles();
  assert.ok(![...w.document.querySelectorAll('[data-pick]')].some(el=>el.dataset.pick===customStyleId));
  assert.ok([...w.document.querySelectorAll('[data-pick]')].some(el=>el.dataset.pick===savedStyleId));
  assert.equal(JSON.stringify(w.qa.options()),beforeDelete);
  assert.equal((await fetch(new URL(`../api/styles/${customStyleId}`,url))).status,404);
  assert.equal(reload.window.document.getElementById('previewWidth').value,'900');
  assert.equal(reload.window.document.querySelector('[data-pane="generation"]').hidden,false,'선택한 탭이 기억된다');
  reload.window.close();
  // Deleting a page drops its plan and beat; the previous page becomes selected.
  const pagesBefore=w.qa.get().pages.length;assert.ok(pagesBefore>=2,'fixture project has pages to delete');
  w.document.querySelector('[data-page="1"]').click();
  $('deletePage').click();await wait(()=>w.qa.get().pages.length===pagesBefore-1,'delete page');
  assert.equal(w.qa.get().outline.pages.length,pagesBefore-1);
  assert.ok($('status').textContent.includes('지웠습니다'),'delete message');
  // 같은 칸·같은 버튼이 이어서 그리기를 받는다 (전체 재기획 버튼은 없앴다).
  const pagesNow=w.qa.get().pages.length;
  input($('story'),'둘이 바닷가에서 잃어버린 모자를 찾는다.');
  input($('pageCount'),'1','change');
  $('plan').click();await wait(()=>w.qa.get()?.status==='ready'&&w.qa.get().pages.length===pagesNow+1,'one box continues the story');
  const sent=JSON.parse(calls.findLast(([u,o])=>u.endsWith('/continue')&&o?.method==='POST')[1].body);
  assert.equal(sent.instructions,'둘이 바닷가에서 잃어버린 모자를 찾는다.');assert.equal(sent.pages,1);
  assert.equal(w.qa.get().id,pid);
  assert.equal($('story').value,'둘이 바닷가에서 잃어버린 모자를 찾는다.','보낸 뒤에도 적어 둔 글은 남는다');
  assert.equal($('pageCount').value,'0');
  assert.equal(w.qa.get().pages[pagesNow].images.length,0);
  $('new').click();await wait(()=>!w.qa.get(),'new project');
  assert.equal($('story').value,'','「새 만화」는 칸을 비운다');
  assert.equal($('composeHint').hidden,true);
  assert.equal($('story').disabled,false);
  assert.equal($('content').hidden,true);
  assert.equal($('alert').hidden,true);
  assert.equal($('dialogue').value,'ko');
  assert.equal($('maxPanels').value,'0');
  assert.equal($('layoutMode').value,'free');
  // 출력이 끊겨 콘티가 모자라면, 못 받은 페이지가 「출력 중단」으로 서고 거기서 지울 수 있다
  input($('story'),'출력끊김 시험용 이야기.');
  $('plan').click();await wait(()=>w.qa.get()?.status==='paused','cut storyboard');
  const missing=[...w.document.querySelectorAll('.page-tab.is-missing')];
  assert.equal(missing.length,1,'못 받은 페이지가 한 장 선다');
  assert.ok(missing[0].textContent.includes('출력 중단'),missing[0].textContent);
  assert.ok($('status').textContent.includes('출력이 중간에 끊겼습니다'),$('status').textContent);
  const beats=w.qa.get().outline.pages.length;
  missing[0].querySelector('[data-missing-remove]').click();
  await wait(()=>w.qa.get().outline.pages.length===beats-1,'못 받은 페이지를 지운다');
  assert.equal(w.document.querySelectorAll('.page-tab.is-missing').length,0);

  console.log('PASS: persistent style library, rename/apply/save/delete, no re-extraction, preserved resolution, CLI/model choice, free layouts, editing, generation/history, replan instructions, immediate stop/rollback, archived originals, reopen.');
} finally {dom.window.close();}
