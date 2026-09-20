const $ = (id) => document.getElementById(id);
const esc = (v) => String(v ?? '').replace(/[&<>"']/g, c => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
const base = new URL('../api/', location.href);
const hostBase = new URL('../../../', location.href);
const busyStates = ['planning', 'generating', 'stopping'];
const layoutNames = {'free':'자유 배치', 'single':'한 컷', 'two-rows':'위아래 두 컷', 'three-rows':'세 줄', 'four-grid':'2 × 2', 'four-rows':'네 줄', 'hero-top':'큰 컷 위', 'hero-bottom':'큰 컷 아래', 'six-grid':'2 × 3', 'two-cols':'좌우 두 컷', 'tall-left':'세로 컷 왼쪽', 'tall-right':'세로 컷 오른쪽'};
const frameNames = {'rectangle':'사각 컷','slant-up':'오른쪽 위로 사선','slant-down':'오른쪽 아래로 사선','borderless':'테두리 없음','inset':'겹치는 작은 컷'};
let config, doc = null, selected = 0, mode = 'board', dirty = false, saving = null, saveTimer, requesting = false;
let referenceName='', referencePreviewUrl='';
let savedStyles=[], stylesReady=false, modelRows=[], modelsBy={};
let selectedStyle='', renamingStyle='';   // 목록에서 고른 화풍, 이름을 고치는 중인 화풍
let activeOperation=null;
const replanDirections=new Map();
const regionOpen=new Set();   // 「영역」을 펼쳐 둔 컷 (프로젝트:페이지:컷)
const panelOpen=new Map();    // 펴 둔 컷의 번호 (프로젝트:페이지 → 0부터)
/** 지금 펴 둔 컷 — 편집창과 콘티가 이 한 자리를 함께 읽는다 (콘티가 그 컷을 강조한다) */
function openCut(plan){ return Math.min(panelOpen.get(`${doc.id}:${selected}`) ?? 0, plan.panels.length-1); }
let viewPrefs={width:1200, fit:true, setupOpen:true, editorOpen:true, tab:'story'};
try { viewPrefs={...viewPrefs,...JSON.parse(localStorage.getItem('manga-maker-view') || '{}')}; } catch {}
const generationFields={model:'model',steps:'steps',cfg:'cfg',cfg_rescale:'cfgRescale',sampler:'sampler',seed:'seed'};
const generationLabels={model:'모델',steps:'스텝',cfg:'CFG',cfg_rescale:'리스케일',sampler:'샘플러',seed:'시드'};
const busy = () => requesting || (doc && busyStates.includes(doc.status));
const optionIds = ['maxPanels','layoutMode','style','direction','dialogue','size','width','height','stylePrompt','negativePrompt','model','steps','cfg','cfgRescale','sampler','seed','workspace','account'];

function saveView(){try{localStorage.setItem('manga-maker-view',JSON.stringify(viewPrefs));}catch{}}
function updateWidthLabel(){
  const actual=Math.round(document.querySelector('.stage').getBoundingClientRect().width);
  $('previewWidthValue').textContent=viewPrefs.fit ? T('화면 너비')+(actual ? ` · ${actual} px` : '') : T('{n} px',{n:viewPrefs.width})+(actual && actual<viewPrefs.width ? ` (${T('표시 {n} px',{n:actual})})` : '');
}
function applyView(){
  document.querySelector('main').classList.toggle('setup-collapsed',!viewPrefs.setupOpen);
  $('setupBody').hidden=!viewPrefs.setupOpen;
  $('toggleSetup').setAttribute('aria-expanded',viewPrefs.setupOpen);
  $('toggleSetup').title=T(viewPrefs.setupOpen?'설정 접기':'설정 펼치기');
  $('toggleSetup').classList.toggle('flip',!viewPrefs.setupOpen);
  $('editorPane').hidden=!viewPrefs.editorOpen;
  $('toggleEditor').setAttribute('aria-expanded',viewPrefs.editorOpen);
  $('toggleEditor').title=T(viewPrefs.editorOpen?'편집창 접기':'편집창 펼치기');
  $('toggleEditor').classList.toggle('flip',!viewPrefs.editorOpen);
  document.querySelector('.editing').classList.toggle('editor-collapsed',!viewPrefs.editorOpen);
  viewPrefs.width=Math.max(320,Math.min(2000,Number(viewPrefs.width)||1200));
  $('previewWidth').value=viewPrefs.width;
  document.documentElement.style.setProperty('--preview-width',viewPrefs.fit?'100%':`${viewPrefs.width}px`);
  $('fitPreview').setAttribute('aria-pressed',viewPrefs.fit);
  updateWidthLabel();
}
function syncSize(){
  const value=`${$('width').value},${$('height').value}`;
  $('size').value=[...$('size').options].some(o=>o.value===value)?value:'custom';
}
function updateActivity(){
  const working=!!busy(), p=doc?.progress || {}, local=activeOperation;
  $('activityCard').classList.toggle('is-working',working);
  $('activityCard').setAttribute('aria-busy',working);
  $('activitySpinner').hidden=!working;
  const labels={outline:'스토리 기획',storyboard:'컷 구성',generate:'이미지 생성',replan:'페이지 재기획',translate:'대사 번역'};
  $('activityBadge').textContent=working ? (local?.label || T(labels[p.phase] || '작업 중')) : T({error:'확인 필요',paused:'멈춤',ready:'기획 완료',complete:'생성 완료'}[doc?.status] || '준비');
  // ★안내 문구를 기본값으로 깔지 않는다 — 화면에 남는 줄은 지금 상태를 말하는 것뿐이다
  $('status').textContent=local ? T('{label} 중입니다.',{label:local.label}) : msg(doc?.message);
  $('activityDetail').hidden=!working;
  const total=!local && p.total, completed=p.completed || 0;
  const g=doc?.generation, waiting=(doc?.gen_requests || []).length;
  const side=doc?.status==='planning' && (g?.page!=null || waiting || doc.gen_follow) ? ` · ${g?.page!=null ? T('{n}페이지 생성 중',{n:g.page+1}) : doc.gen_follow ? T('기획되는 대로 생성') : T('생성 대기')}${waiting ? ` (${T('대기 {n}',{n:waiting})})` : ''}${doc.queue_state==='waiting'?' · '+T('NAI 큐 대기'):''}` : '';
  $('activityCount').textContent=(total ? T('{done} / {total}페이지 완료',{done:completed,total})+`${p.page!=null ? ` · ${T('현재 {n}페이지',{n:p.page+1})}` : ''}${!side && doc.queue_state==='waiting'?' · '+T('NAI 큐 대기'):''}` : T('응답을 기다리고 있습니다'))+side;
  if(total){$('activityProgress').max=total;$('activityProgress').value=completed;}else{$('activityProgress').removeAttribute('value');}
  const seconds=Math.max(0,Math.floor(Date.now()/1000-(local?.started_at || p.started_at || doc?.updated || Date.now()/1000)));
  $('elapsed').textContent=T('{m}분 {s}초 경과',{m:Math.floor(seconds/60),s:String(seconds%60).padStart(2,'0')});
  $('referenceActivity').hidden=local?.target!=='styleImage';
  $('styleRefDrop').classList.toggle('is-working',local?.target==='styleImage');
  document.querySelectorAll('button.is-working').forEach(el=>el.classList.remove('is-working'));
  if(local?.target && $(local.target)?.tagName==='BUTTON')$(local.target).classList.add('is-working');
  document.querySelectorAll('[data-page]').forEach(el=>el.classList.toggle('is-working',working&&!local&&p.page===+el.dataset.page));
  $('generationSummary').textContent=T('CFG {cfg} · {steps}스텝',{cfg:$('cfg').value,steps:$('steps').value});
  $('stop').disabled=requesting;
}

/* ★★**백엔드가 준 상태 글도 옮긴다.** 그 글은 한국어로 오고 `_data` 에 그대로 저장되므로,
     본을 맞춰 화면에서 옮긴다. 아는 본이 없으면(오류 원문 등) 그대로 보여 준다. */
const SERVER_MSGS=[
  [/^(\d+)\/(\d+)페이지 컷과 캐릭터 프롬프트 구성 중$/,'{n}/{total}페이지 컷과 캐릭터 프롬프트 구성 중'],
  [/^(\d+)\/(\d+)페이지 생성 중$/,'{n}/{total}페이지 생성 중'],
  [/^(\d+)\/(\d+)페이지 대사 번역 중$/,'{n}/{total}페이지 대사 번역 중'],
  [/^(\d+)페이지를 다시 기획했습니다\. 이전 콘티와 이미지는 보관되어 있습니다\.$/,'{n}페이지를 다시 기획했습니다. 이전 콘티와 이미지는 보관되어 있습니다.'],
  [/^(\d+)페이지의 컷 수와 구성을 다시 기획합니다\.$/,'{n}페이지의 컷 수와 구성을 다시 기획합니다.'],
  [/^(\d+)페이지를 지웠습니다\.$/,'{n}페이지를 지웠습니다.'],
];
/** 확인창 — **앱이 그린다** (`peropix.ask`).
 *  ★`peropix.ask` 는 PeroPix 3.3.3 부터다. 그 앞 판에서는 브라우저 것으로 떨어진다 — 모양은
 *    앱과 다르지만, 없다고 묻지 않고 지워 버리는 것보다 낫다. */
function confirmAsk(o){
  if(window.peropix?.ask)return peropix.ask(o);
  return Promise.resolve(window.confirm(o.body ? `${o.title}

${o.body}` : o.title));
}

function msg(text){
  if(!text)return '';
  for(const [re,key] of SERVER_MSGS){const m=re.exec(text);if(m)return T(key,{n:m[1],total:m[2]});}
  return T(text);
}

async function api(path, method = 'GET', body) {
  const r = await fetch(new URL(path, base), {method, headers: {'Content-Type':'application/json'}, ...(body === undefined ? {} : {body: JSON.stringify(body)})});
  const data = await r.json();
  if (!r.ok || data.error) {
    const detail = data.detail || data.error || T('요청 실패 ({status})',{status:r.status});
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}
function error(e) { $('alert').hidden = false; $('alert').textContent = e.message || String(e); }
function clearError() { $('alert').hidden = true; }
function renderLlm() {
  const data = config.llm;
  const group = engine => data.providers.filter(p=>p.engine===engine).map(p=>`<option value="${esc(p.id)}" ${p.available?'':'disabled'}>${esc(p.label)}${p.engine==='cli'&&!p.available ? ` (${T(p.installed?'미지원':'설치 안됨')})` : ''}</option>`).join('');
  $('llmProvider').innerHTML = `<option value="">${T('앱 API 설정 따르기')}</option><optgroup label="CLI">`+group('cli')+'</optgroup><optgroup label="API">'+group('api')+'</optgroup>';
  $('llmProvider').value = data.choice.provider;
  const selectedProvider = data.providers.find(p=>p.id===data.choice.provider);
  modelRows = modelsBy[data.choice.provider]?.models || [];
  renderModels(data.choice.provider ? data.choice.model : data.model || '');
  renderEffort(data.choice.effort);
  // 값은 위의 세 선택칸에 이미 보인다 — 여기는 저장된 것과 준비 상태만 한 줄로 적는다.
  const effort = data.choice.effort || T(selectedProvider?.engine==='cli' ? 'CLI 기본' : '모델 기본값');
  $('llm').textContent = `${selectedProvider?.label || data.provider} · ${data.model || T('CLI 기본 모델')} · ${effort}`
    + (data.ready ? '' : ' · '+T('설정 필요'));
  controls();
  if (selectedProvider && selectedProvider.engine!=='cli' && !modelsBy[selectedProvider.id]) void loadModels(selectedProvider.id);
}
// Same dropdowns as the app's own LLM settings: the model list loads by itself and the effort
// select shows only the levels that model reports (CLI: the fixed CLI levels, default high).
function renderModels(value) {
  const provider = config.llm.providers.find(p=>p.id===$('llmProvider').value);
  const cli = provider?.engine==='cli';
  const list = cli ? (provider.models || []).map(id=>({id})) : modelRows;
  const loading = !!provider && !cli && !modelsBy[provider.id];
  const options = [];
  if (value && !list.some(m=>m.id===value)) options.push(`<option value="${esc(value)}">${esc(value)}</option>`);
  if (cli || !value) options.push(`<option value="">${T(cli ? 'CLI 기본 모델' : loading ? '불러오는 중' : list.length ? '모델을 고르세요' : (modelsBy[provider?.id]?.err ? '목록을 못 받았습니다' : '모델 없음'))}</option>`);
  for (const m of list) options.push(`<option value="${esc(m.id)}">${esc(m.id)}${m.new ? '  ·  '+T('새 모델') : ''}${m.in ? `  ·  $${esc(m.in)}/M` : ''}${m.vision ? '  ·  vision' : ''}</option>`);
  $('llmModel').innerHTML = options.join('');
  $('llmModel').value = value || '';
}
function renderEffort(value) {
  const provider = config.llm.providers.find(p=>p.id===$('llmProvider').value);
  const cli = provider?.engine==='cli';
  const picked = modelRows.find(m=>m.id===$('llmModel').value);
  const levels = cli ? (provider.efforts || []) : (picked?.efforts || []);
  $('llmEffort').hidden = !provider || !levels.length;
  if (cli) {
    $('llmEffort').innerHTML = levels.map(e=>`<option value="${esc(e)}">${esc(e)}</option>`).join('');
    $('llmEffort').value = levels.includes(value) ? value : (levels.includes('high') ? 'high' : levels[0] || '');
    return;
  }
  const options = [`<option value="">${T('모델 기본값')}${picked?.effortDefault ? `  ·  ${esc(picked.effortDefault)}` : ''}</option>`];
  for (const e of levels.filter(v=>v!=='none')) options.push(`<option value="${esc(e)}">${esc(e)}</option>`);
  if (!picked?.reasoningLocked) options.push(`<option value="none">${T('끄기')}</option>`);
  $('llmEffort').innerHTML = options.join('');
  $('llmEffort').value = [...$('llmEffort').options].some(o=>o.value===value) ? value : '';
}
async function loadModels(provider, force) {
  if (!provider) return;
  if (modelsBy[provider] && !force) { modelRows = modelsBy[provider].models; return; }
  let entry;
  // Not api(): the host returns models together with a non-fatal error text (a curated model
  // missing upstream, a fixed list), and api() would throw that away with the whole list.
  try {
    const r = await fetch(new URL('llm/models?provider='+encodeURIComponent(provider), base));
    const data = await r.json();
    if (!r.ok) throw new Error(data.detail || data.error || T('요청 실패 ({status})',{status:r.status}));
    entry = {models: data.models || [], err: data.error || ''};
  } catch (e) { entry = {models: [], err: e.message || String(e)}; }
  modelsBy[provider] = entry;
  if ($('llmProvider').value !== provider) return;
  modelRows = entry.models;
  renderModels($('llmModel').value);
  renderEffort($('llmEffort').value);
  $('llm').textContent = entry.err ? T('모델 목록: {e}',{e:entry.err}) : T('모델 {n}개를 불러왔습니다.',{n:entry.models.length});
  controls();
}
async function saveLlm() {
  config.llm = await api('llm', 'PUT', {provider:$('llmProvider').value,model:$('llmModel').value.trim(),effort:$('llmEffort').value});
  renderLlm();
}
function options() {
  const width=+$('width').value, height=+$('height').value;
  // pages 는 새 만화를 만들 때만 쓴다 — 기존 프로젝트의 값은 그대로 둔다 (이어서 그리기는 따로 보낸다).
  return {pages: doc ? (doc.options?.pages ?? 0) : +$('pageCount').value, max_panels: +$('maxPanels').value, layout_mode:$('layoutMode').value, direction: $('direction').value,
    dialogue: $('dialogue').value, style: $('style').value, style_prompt: $('stylePrompt').value,
    // ★「화풍 선택」이 흑백·컬러·내 화풍을 한 칸에서 정한다 (사용자 지시 2026-09-15).
    //   reference_style 은 1.1.1 까지의 이름이라 같은 뜻으로 함께 보낸다.
    reference_style:$('style').value==='custom',reference_name:referenceName,negative_prompt:$('negativePrompt').value,
    model: $('model').value, width, height, steps: +$('steps').value, cfg: +$('cfg').value,
    cfg_rescale:+$('cfgRescale').value,sampler:$('sampler').value,
    seed: +$('seed').value, workspace: $('workspace').value, account: $('account').value};
}
function putOptions(o) {
  referenceName=o.reference_name || '';
  $('styleRefName').textContent=referenceName ? T('참고 이미지: {name}',{name:referenceName}) : '';
  $('styleRefPreview').hidden=true;
  const values = {maxPanels:o.max_panels, layoutMode:o.layout_mode || 'free', direction:o.direction, dialogue:o.dialogue,
    style:o.reference_style ? 'custom' : (o.style || 'mono'), stylePrompt:o.style_prompt, model:o.model, width:o.width, height:o.height,
    negativePrompt:o.negative_prompt ?? config.default_negative,
    steps:o.steps, cfg:o.cfg, cfgRescale:o.cfg_rescale ?? 0, sampler:o.sampler || 'k_euler_ancestral', seed:o.seed, workspace:o.workspace, account:o.account};
  for (const [id, value] of Object.entries(values)) if (value !== undefined) $(id).value = value;
  syncSize();
}
function draft() { try { localStorage.setItem('manga-maker-draft', JSON.stringify({story:$('story').value, options:options()})); } catch {} }
function markDirty() {
  if (!doc?.outline || busy()) return;
  dirty = true;
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => persist().catch(error), 900);
}
async function persist() {
  clearTimeout(saveTimer);
  if (saving) await saving;
  if (!dirty || !doc?.outline) return;
  const current = doc, payload = {revision:doc.revision, options:options(), outline:doc.outline, pages:doc.pages.map(p => p.plan)};
  dirty = false;
  saving = api(`projects/${doc.id}`, 'PUT', payload).then(result => {
    if (doc === current) {
      doc.revision = result.revision;
      doc.options = result.options;
      doc.compiled = result.compiled;
      renderPrompts();
    }
  }).catch(e => {dirty = true; throw e;}).finally(() => {saving = null;});
  await saving;
  if (dirty) await persist();
}
async function listProjects() {
  const result = await api('projects');
  $('projects').innerHTML = `<option value="">${T('새 만화')}</option>` + result.items.map(p => `<option value="${esc(p.id)}">${esc(p.title)}</option>`).join('');
  $('projects').value = doc?.id || '';
}
function adopt(p) {
  const switched = doc?.id !== p.id;
  if(switched){$('importedOptions').hidden=true;$('story').value='';$('pageCount').value='0';}
  if(doc?.id===p.id && (p.pages[selected]?.images.length || 0)>(doc.pages[selected]?.images.length || 0))mode='image';
  doc = p; dirty = false; selected = Math.min(selected, Math.max(0, p.pages.length-1));
  putOptions(p.options);
  try { localStorage.setItem('manga-maker-current', p.id); } catch {}
  render();
}
function controls() {
  const b = !!busy();
  for (const id of optionIds) $(id).disabled = b;
  for (const id of ['llmProvider','llmRefresh']) $(id).disabled = b || !config;
  $('llmModel').disabled = b || !$('llmProvider').value;
  $('llmEffort').disabled = b || !$('llmProvider').value;
  $('styleImage').disabled=b || !config;
  $('stylePicker').disabled=b || !stylesReady;
  $('refreshStyles').disabled=b || !config;
  for(const el of $('styleList').querySelectorAll('button,input'))el.disabled=b;
  $('saveStyle').disabled=b || !stylesReady || !$('stylePrompt').value.trim();
  $('translateDialogue').disabled=b || !doc?.pages.length || $('dialogue').value==='none';
  for (const id of ['story','pageCount','plan','automatic','example']) $(id).disabled = b || !config;
  $('new').disabled = requesting;
  $('projects').disabled = requesting;
  $('stop').hidden = !b || requesting;
  $('export').disabled = !doc || requesting;
  const done = doc?.outline && doc.pages.length === doc.outline.pages.length;
  // While planning still runs, already storyboarded pages can be queued for generation.
  const planning = !!doc?.accepting && doc.status==='planning' && !requesting;
  const queued = doc?.gen_requests || [], generating = doc?.generation?.page;
  $('generatePage').disabled = planning ? (!doc.pages[selected] || queued.includes(selected) || generating===selected) : (b || !doc?.pages.length || !done);
  $('generateAll').disabled = planning ? !!doc.gen_follow : (b || !doc?.pages.length || !done || doc.pages.every(p => p.images.length));
  $('generateAll').textContent = planning ? T(doc.gen_follow ? '기획되는 대로 생성 중' : '기획되는 대로 생성') : T('남은 {n}페이지 생성',{n:doc?.pages.filter(p => !p.images.length).length || 0});
  // 40페이지가 차면 더 이어서 그릴 수 없다 (서버 상한과 같은 값).
  if (doc?.outline && doc.outline.pages.length >= 40) for (const id of ['plan','automatic']) $(id).disabled = true;
  for (const input of document.querySelectorAll('.editor input,.editor textarea,.editor select,.editor button')) input.disabled = b;
  if (doc?.pages.length) {
    // ★한도는 여기서만 건다 — 바로 위 줄이 편집창의 `disabled` 를 통째로 다시 칠한다.
    const panels=doc.pages[selected].plan.panels;
    for (const button of document.querySelectorAll('[data-add-line]')) button.disabled ||= panels[+button.dataset.addLine].dialogue.length >= 3;
    for (const button of document.querySelectorAll('[data-add-note]')) button.disabled ||= panels[+button.dataset.addNote].dialogue.length >= 3;
    for (const button of document.querySelectorAll('[data-add-subject]')) {
      const panel=panels[+button.dataset.addSubject];
      button.disabled ||= panel.subjects.length >= 4 || panel.subjects.length >= doc.outline.characters.length;
    }
  }
  if ($('deletePage')) $('deletePage').disabled = b || !doc || doc.outline.pages.length <= 1;
  updateActivity();
}
function render() {
  $('projectTitle').textContent = doc?.outline?.title || (doc ? T('새 이야기 기획 중') : T('새 만화'));
  const queuedPages=doc?.gen_requests || [], generatingPage=doc?.generation?.page;
  $('pageNav').innerHTML = (doc?.pages || []).map((p,i) => `<button class="page-tab" data-page="${i}" aria-current="${i === selected}"><b>${String(i+1).padStart(2,'0')}</b><span>${esc(p.plan.title)}<small>${T('{n}컷',{n:p.plan.panels.length})} · ${p.error ? T('확인 필요') : generatingPage===i ? T('생성 중') : queuedPages.includes(i) ? T('생성 대기') : p.images.length ? T('생성 {n}장',{n:p.images.length}) : T('기획 완료')}</small></span></button>`).join('');
  const has = !!doc?.pages.length;
  $('empty').hidden = has; $('content').hidden = !has;
  if (has) { renderEditor(); renderBible(); renderBoard(); renderResult(); renderPrompts(); }
  setMode(mode);
  controls();
}
function setMode(value) {
  mode = value; $('boardMode').setAttribute('aria-pressed', mode === 'board'); $('imageMode').setAttribute('aria-pressed', mode === 'image');
  $('board').hidden = mode !== 'board'; $('result').hidden = mode !== 'image';
  document.querySelector('.editing').classList.toggle('image-view',mode==='image');
  applyView();
}
const textarea = (attrs, value, rows=3) => `<textarea ${attrs} rows="${rows}">${esc(value)}</textarea>`;
function renderEditor() {
  const pg = doc.pages[selected], p = pg.plan;
  const choices = [['free',null],...Object.entries(config.layouts).filter(([,boxes]) => boxes.length === p.panels.length)];
  const free = p.layout === 'free', numbers = slotNumbers(promptSlots()), talk = options().dialogue !== 'none';
  const trash = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg>';
  const cross = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>';
  $('pageEditor').innerHTML =
    `<div class="ed-row"><label class="ed-label">${T('페이지')}</label><input data-page-field="title" aria-label="페이지 제목" value="${esc(p.title)}"><select data-page-field="layout" aria-label="컷 배치">${choices.map(([name])=>`<option value="${name}" ${name===p.layout?'selected':''}>${T(layoutNames[name])}</option>`).join('')}</select><button id="deletePage" class="icon-btn" title="${T('이 페이지 삭제')}" aria-label="${T('이 페이지 삭제')}">${trash}</button></div>`
    + `<div class="ed-row"><label class="ed-label">${T('재기획')}</label><input id="replanInstructions" maxlength="4000" placeholder="${T('이 페이지를 어떻게 고칠지 (비우면 현재 설정으로)')}" value="${esc(replanDirections.get(`${doc.id}:${selected}`) || '')}"><button id="replanPage">${T('다시 기획')}</button></div>`
    + `<div class="ed-row"><label class="ed-label">${T('장면 태그')}</label><input data-page-field="setting" value="${esc(p.setting || '')}" placeholder="${T('장소, 시간, 조명 태그')}"></div>`
    + (pg.error ? `<p class="page-error">${esc(pg.error)}</p>` : '');

  /* ★★컷은 **한 번에 하나만** 편다 (사용자 지시 2026-09-20). 컷을 세로로 쌓으면 하나를 고치는
     동안 나머지가 화면을 다 차지한다. 번호 칩으로 고르고 그 컷만 낸다. */
  const cut = openCut(p);
  panelOpen.set(`${doc.id}:${selected}`, cut);
  const card = (panel,i) => {
      const r = panel.region, regionShown = regionOpen.has(`${doc.id}:${selected}:${i}`);
      const head = free && r
        ? `<span class="cut-frame">${T(frameNames[r.frame])}</span><span class="cut-box">${r.x.toFixed(2)}, ${r.y.toFixed(2)} · ${r.w.toFixed(2)} × ${r.h.toFixed(2)}</span><button data-region-toggle="${i}" aria-expanded="${regionShown}">${T('영역')}</button>`
        : '<span class="cut-box"></span>';
      const num = key => numbers.get(`${i}:${key}`) || 0;
      const named = id => doc.outline.characters.find(c=>c.id===id)?.name || '';
      // 한 컷에 같은 인물을 두 번 넣지 않는다 — 대사가 화자 id 로 붙으므로 두 프롬프트에 함께 실린다.
      const taken = new Set(panel.subjects.map(s=>s.character));
      const whoPick = id => `<select data-subject-field="character" aria-label="인물">${doc.outline.characters.filter(c=>c.id===id || !taken.has(c.id)).map(c=>`<option value="${esc(c.id)}" ${c.id===id?'selected':''}>${esc(c.name)}</option>`).join('')}</select>`;
      const lineRow = (d,k) => `<div class="dialogue-row" data-line="${k}"><select data-line-field="speaker" aria-label="화자">${panel.subjects.map(s=>`<option value="${esc(s.character)}" ${d.speaker===s.character?'selected':''}>${esc(named(s.character))}</option>`).join('')}</select>${textarea('data-line-field="text" aria-label="대사"',d.text,2)}<button data-remove-line="${k}" class="icon-btn" aria-label="대사 삭제">${cross}</button></div>`;
      // ★블록 하나가 캐릭터 프롬프트 하나다. 인물의 대사는 그 인물 블록 안에 들어가 같은 번호에 묶인다.
      const cast = panel.subjects.map((s,j) => `<div class="slot-block" data-subject="${j}" style="--slot-color:${castColor(s.character)}">`
          + `<div class="slot-head">${slotBadge(num(j),'cast',s.character)}${whoPick(s.character)}<button data-remove-subject="${j}" class="icon-btn" title="${T('이 컷에서 빼기')}" aria-label="${T('이 컷에서 빼기')}">${trash}</button></div>`
          + `<div class="ed-row"><label class="ed-label">${T('카메라')}</label><input data-subject-field="camera" value="${esc(s.camera || '')}" placeholder="full body, from side"></div>`
          + `<div class="ed-row"><label class="ed-label">${T('동작·표정')}</label>${textarea('data-subject-field="action"',s.action,2)}</div>`
          /* ★★컷 안 위치는 **콘티에서 끌어서만** 정한다 (사용자 지시 2026-09-20). 숫자 둘을 손으로
             맞추는 것보다 표식을 끄는 것이 빠르고, 내레이션도 이미 끌기뿐이라 방법이 하나로 모인다. */
          + (talk ? panel.dialogue.map((d,k)=>d.speaker===s.character ? lineRow(d,k) : '').join('')
                    + `<button class="ghost" data-add-line="${i}" data-add-for="${j}">${T('대사 추가')}</button>` : '')
          + '</div>').join('');
      // 인물이 없는 컷에도 배경만 그리는 캐릭터 프롬프트가 하나 생긴다 (`core.compile_page`). 번호를 차지하므로 함께 보인다.
      const blank = panel.subjects.length ? ''
        : `<div class="slot-block" style="--slot-color:${CAST_NEUTRAL}"><div class="slot-head">${slotBadge(num('empty'),'empty')}<span class="ed-note">${T('인물 없음')}</span></div></div>`;
      const notes = !talk ? '' : panel.dialogue.map((d,k)=>({d,k})).filter(({d})=>!d.speaker).map(({d,k}) =>
          `<div class="slot-block" data-line="${k}" style="--slot-color:${CAST_NEUTRAL}">`
          + `<div class="slot-head">${slotBadge(num(`note:${k}`),'note')}<span class="ed-note">${T('내레이션')}</span><button data-remove-line="${k}" class="icon-btn" title="${T('내레이션 삭제')}" aria-label="${T('내레이션 삭제')}">${trash}</button></div>`
          + textarea('data-line-field="text" aria-label="내레이션"',d.text,2)
          + '</div>').join('');
      return `<article class="panel-card" data-panel="${i}"><div class="cut-head"><span class="chip">${T('{n}번 컷',{n:i+1})}</span>${head}</div>`
        + (free && r && regionShown ? regionEditor(r) : '')
        + `<div class="ed-row"><label class="ed-label">${T('장면 요약')}</label>${textarea('data-panel-field="summary"',panel.summary,2)}</div>`
        + `<div class="ed-row"><label class="ed-label">${T('컷 태그')}</label>${textarea(`data-panel-field="scene" placeholder="${T('이 컷에만 있는 장면 태그')}"`,panel.scene || '',2)}</div>`
        + cast + blank + notes
        + `<div class="slot-add"><button class="ghost" data-add-subject="${i}">${T('인물 추가')}</button>`
        + (talk ? `<button class="ghost" data-add-note="${i}">${T('내레이션 추가')}</button>` : '')
        + '</div></article>';
  };
  // ★칩에는 번호만 적는다 — 이름은 컷마다 없고, 짧아야 한 줄에 다 선다
  $('panelList').innerHTML =
    `<div class="cut-tabs">${p.panels.map((_,i)=>`<button class="cut-tab" data-cut="${i}" aria-pressed="${i===cut}" title="${T('{n}번 컷',{n:i+1})}">${i+1}</button>`).join('')}</div>`
    + card(p.panels[cut], cut);
}
function regionEditor(r) {
  const cell = (key,label) => `<label>${label}<input data-region-field="${key}" type="number" min="${key==='w'||key==='h' ? '.05':'0'}" max="1" step=".01" value="${r[key]}"></label>`;
  return `<div class="region-grid">${cell('x',T('페이지 가로'))}${cell('y',T('페이지 세로'))}${cell('w',T('너비'))}${cell('h',T('높이'))}</div>`
    + `<div class="ed-row"><label class="ed-label">${T('컷 테두리')}</label><select data-region-field="frame">${Object.entries(frameNames).map(([key,label])=>`<option value="${key}" ${r.frame===key?'selected':''}>${T(label)}</option>`).join('')}</select></div>`;
}
function renderBible() {
  $('characters').innerHTML = doc.outline.characters.map((c,i)=>`<div class="bible-char" data-character="${i}"><strong>${esc(c.name)}</strong><label>${T('모든 컷에 공유할 외형·의상')}${textarea('data-char-field="prompt"',c.prompt,4)}</label><label>${T('캐릭터 네거티브')}${textarea('data-char-field="uc"',c.uc,2)}</label></div>`).join('');
}
/** 읽는 순서 — **`core.reading_order` 와 같은 규칙**이다 (그쪽을 고치면 여기도 맞춘다).
 *  ★예전에는 `y` 로 줄을 세워 정렬했는데, 세로로 긴 칸은 여러 줄에 걸치므로 그 방식이 그 칸을
 *    다른 칸들 사이에 끼워 넣는다 — 콘티가 보여 주는 자리와 실제로 생성되는 자리가 어긋났다. */
function readingOrder(rects, direction) {
  const eps=.02;
  const before=(a,b)=>{
    if(a[1]+a[3]<=b[1]+eps)return true;
    if(b[1]+b[3]<=a[1]+eps)return false;
    const ax=a[0]+a[2]/2, bx=b[0]+b[2]/2;
    return direction==='rtl' ? ax>bx : ax<bx;
  };
  const key=i=>[rects[i][1], direction==='rtl' ? -rects[i][0] : rects[i][0]];
  const remaining=rects.map((_,i)=>i), order=[];
  while(remaining.length){
    const ready=remaining.filter(i=>!remaining.some(j=>j!==i&&before(rects[j],rects[i])));
    const pool=ready.length?ready:remaining;
    const pick=pool.reduce((best,i)=>{const a=key(i),b=key(best);return (a[0]<b[0]||(a[0]===b[0]&&a[1]<b[1]))?i:best;});
    order.push(pick);remaining.splice(remaining.indexOf(pick),1);
  }
  return order;
}
function boxes() {
  const pg=doc.pages[selected].plan;
  if (pg.layout==='free') return pg.panels.map(p=>[p.region.x,p.region.y,p.region.w,p.region.h]);
  const rects=config.layouts[pg.layout];
  return readingOrder(rects,options().direction).map(i=>rects[i]);
}

/** 캐릭터 프롬프트 색 — **같은 인물은 어느 컷에서나 같은 색**이다.
 *  ★콘티는 흰 지면을 그리는 자리라 앱 토큰이 아니라 고정 색을 쓴다 (테마를 따라 바뀌면 안 된다). */
const CAST_COLORS=['#3b7bac','#c77d43','#4d8f5b','#a4508b','#b4514a','#3f7f86','#8a7a3f','#6d6aa8'];
/** 인물이 아닌 칸(내레이션 상자·인물 없는 컷) — 중립색 */
const CAST_NEUTRAL='#78859a';
function castColor(id){
  const i=doc?.outline?.characters.findIndex(c=>c.id===id) ?? -1;
  return i<0 ? CAST_NEUTRAL : CAST_COLORS[i%CAST_COLORS.length];
}

/** 이 페이지의 **캐릭터 프롬프트**를 NAI 에 실리는 차례 그대로 돌려준다.
 *
 *  ★★차례는 `core.compile_page` 가 정한다 — 컷 차례대로, 컷 안에서는 인물 → (인물이 없으면
 *    빈 칸 하나) → 내레이션 상자. 콘티의 번호·편집창의 번호·「실제 NAI 프롬프트」 목록이
 *    **같은 번호**를 쓰려면 이 차례가 그쪽과 같아야 한다.
 *  ★`u`·`v` 는 컷 안의 비율이다 (`core.page_point` 에 넣는 값과 같다). */
function promptSlots(){
  const pg=doc?.pages[selected]?.plan;
  if(!pg)return [];
  const withText=options().dialogue!=='none', rtl=options().direction==='rtl', out=[];
  pg.panels.forEach((panel,i)=>{
    panel.subjects.forEach((s,j)=>out.push({panel:i,kind:'cast',subject:j,character:s.character,u:s.x,v:s.y}));
    if(!panel.subjects.length)out.push({panel:i,kind:'empty',u:.5,v:.5});
    const narration=withText?panel.dialogue.map((l,k)=>({l,k})).filter(({l})=>!l.speaker):[];
    narration.forEach(({l,k},j)=>{
      const u=(j+.5)/narration.length;
      out.push({panel:i,kind:'note',line:k,u:l.x==null?(rtl?1-u:u):l.x,v:l.y==null?.15:l.y,text:l.text});
    });
  });
  return out;
}
/** 번호를 붙여 돌려준다 — 컷 안의 자리로 찾을 수 있게.
 *  `0:1` = 첫 컷의 둘째 인물 · `0:note:2` = 첫 컷의 셋째 대사 줄인 내레이션 · `0:empty` = 인물이 없는 첫 컷 */
function slotNumbers(slots){
  const map=new Map();
  slots.forEach((s,n)=>{
    if(s.kind==='cast')map.set(`${s.panel}:${s.subject}`,n+1);
    else if(s.kind==='note')map.set(`${s.panel}:note:${s.line}`,n+1);
    else map.set(`${s.panel}:empty`,n+1);
  });
  return map;
}
/** 콘티 표식과 같은 모양의 번호 배지 — 인물은 그 인물 색 동그라미, 나머지는 중립색 둥근 사각형.
 *
 *  ★모양과 색의 기준은 `renderBoard` 의 표식이다. 한쪽만 고치면 콘티와 편집창이 갈린다.
 *  ★`kind` 가 비면 무엇인지 모르는 것이다 (「실제 NAI 프롬프트」가 마지막 저장분이라 화면과
 *    개수가 어긋난 동안). 그때는 색을 칠하지 않고 테두리만 그린다. */
function slotBadge(n,kind,character){
  const cast=kind==='cast';
  const paint=kind ? ` style="background:${cast?castColor(character):CAST_NEUTRAL}"` : '';
  return `<span class="slot-badge${cast?'':' flat'}${kind?'':' blank'}"${paint} title="${T('캐릭터 프롬프트 {n}',{n})}">${n}</span>`;
}
function pointInRegion(box,frame,u,v) {
  if(frame==='slant-up')v=.15*(1-u)+.85*v;
  if(frame==='slant-down')v=.15*u+.85*v;
  return [box[0]+box[2]*u,box[1]+box[3]*v];
}
function renderBoard() {
  if (!doc?.pages.length) return;
  const opts = options(), H = 500 * opts.height / opts.width, pg = doc.pages[selected].plan;
  const layer=i=>pg.layout==='free' ? ({borderless:0,inset:2}[pg.panels[i].region.frame] ?? 1) : 1;
  const drawing=boxes().map((box,i)=>({box,i})).sort((a,b)=>layer(a.i)-layer(b.i));
  // ★번호는 NAI 에 실리는 차례 그대로다 — 「실제 NAI 프롬프트」 목록의 번호와 같다
  const slots=promptSlots();
  /* ★컷 칩으로 고른 컷을 여기서도 강조한다 (사용자 지시 2026-09-20) — 편집창에서 고치고 있는 것이
     지면의 어디인지 바로 보이게. 색은 앱 토큰이 아니라 고정값이다 (콘티는 흰 지면을 그리는 자리다). */
  const cut=openCut(pg);
  $('board').innerHTML = `<svg viewBox="0 0 500 ${H}" aria-label="페이지 콘티와 인물 위치"><rect width="500" height="${H}" fill="#fff"/>` + drawing.map(({box:[x,y,w,h],i})=>{
    const panel = pg.panels[i], frame=pg.layout==='free' ? panel.region.frame : 'rectangle', px=x*500+7, py=y*H+7, pw=w*500-14, ph=h*H-14;
    const polygon=[[0,0],[1,0],[1,1],[0,1]].map(([u,v])=>{const [a,b]=pointInRegion([x,y,w,h],frame,u,v);return `${a*500},${b*H}`;}).join(' ');
    const summary = Array.from(panel.summary).slice(0,Math.floor(pw/13)*2).join('');
    const rows = summary.match(new RegExp(`.{1,${Math.max(1,Math.floor(pw/13)-1)}}`,'gu')) || [];
    const on=i===cut;
    return `<g><polygon data-panel-shape="${i}" points="${polygon}" fill="${on?'#e6f0fa':'#f8fafc'}" stroke="${frame==='borderless'?'none':on?'#2f6fa8':'#263749'}" stroke-width="${(frame==='inset'?4:2)*(on?1.5:1)}"/>`
      /* ★테두리 없는 컷은 선을 안 그리므로 옅은 바탕만으로는 고른 티가 안 난다. 그 컷만 점선으로
         두른다 — 만화에는 없는 선이고 고르는 동안의 표시라는 뜻이 점선에 담긴다. */
      + (on && frame==='borderless' ? `<polygon points="${polygon}" fill="none" stroke="#2f6fa8" stroke-width="2" stroke-dasharray="7 5"/>` : '')
      + `<text x="${px+10}" y="${py+22}" fill="${on?'#2f6fa8':'#526980'}" font-size="14" font-weight="600">${i+1}</text>${rows.map((row,k)=>`<text x="${px+10}" y="${py+43+k*16}" font-size="12" fill="#526980">${esc(row)}</text>`).join('')}${slots.map((s,n)=>({s,n})).filter(({s})=>s.panel===i).map(({s,n})=>{
      const [a,b]=pointInRegion([x,y,w,h],frame,s.u,s.v);
      const cx=a*500, cy=b*H;
      if(s.kind==='cast'){
        const name=doc.outline.characters.find(c=>c.id===s.character)?.name || '';
        return `<g class="marker" data-marker="${i},${s.subject}" transform="translate(${cx},${cy})"><circle r="15" fill="${castColor(s.character)}" stroke="#fff" stroke-width="2"/><text text-anchor="middle" y="5" font-size="12" fill="#fff">${n+1}</text><text text-anchor="middle" y="31" fill="#263749" font-size="12" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(name)}</text></g>`;
      }
      // 인물 없는 컷의 칸만 못 끈다 — 자리를 코드가 정한다 (`core.compile_page`)
      const label=s.kind==='note' ? T('내레이션') : T('인물 없음');
      const grab=s.kind==='note' ? ` class="marker" data-marker="${i},note,${s.line}"` : '';
      return `<g${grab} transform="translate(${cx},${cy})"><rect x="-11" y="-11" width="22" height="22" rx="6" fill="${CAST_NEUTRAL}" stroke="#fff" stroke-width="2"/><text text-anchor="middle" y="4" font-size="11" fill="#fff">${n+1}</text><text text-anchor="middle" y="26" fill="#526980" font-size="11" paint-order="stroke" stroke="#fff" stroke-width="3">${esc(label)}</text></g>`;
    }).join('')}</g>`;
  }).join('')+'</svg>';
}
function imageUrl(image) { return new URL('api/file/'+encodeURIComponent(image.workspace)+'/'+image.file.split('/').map(encodeURIComponent).join('/'), hostBase).href; }
function renderResult(version) {
  if (!doc?.pages.length) return;
  const images = doc.pages[selected].images;
  if (!images.length) { $('result').innerHTML = `<p class="hint">${T('아직 생성된 이미지가 없습니다.')}</p>`; return; }
  const at = version ?? images.length-1, image = images[at], url = imageUrl(image);
  $('result').innerHTML = `<select id="version" aria-label="생성 버전">${images.map((im,i)=>`<option value="${i}" ${i===at?'selected':''}>${T('생성 {n} · 시드 {seed}',{n:i+1,seed:esc(im.seed)})}</option>`).join('')}</select><a href="${esc(url)}" target="_blank" rel="noreferrer"><img src="${esc(url)}" alt="${selected+1}페이지 생성 결과"></a><p class="hint">${esc(image.file)}</p>`;
  $('version').onchange = e => renderResult(+e.target.value);
}
function renderPrompts() {
  const p = doc?.compiled?.[selected];
  if (!p) return;
  /* ★`compiled` 는 마지막으로 저장한 판이고 `slots` 는 지금 화면이다. 개수가 다르면(고친 직후)
     이름표를 붙이지 않는다 — 엉뚱한 이름을 붙이는 것보다 낫다. */
  const slots=promptSlots(), fresh=slots.length===p.characters.length;
  $('prompts').innerHTML = `<p class="hint">${T('베이스 프롬프트')}</p><pre>${esc(p.prompt)}</pre><p class="hint">${T('네거티브 프롬프트')}</p><pre>${esc(p.negative_prompt)}</pre>` + p.characters.map((c,i)=>{
    const s=fresh?slots[i]:null;
    const name=!s ? '' : s.kind==='cast' ? (doc.outline.characters.find(x=>x.id===s.character)?.name || '') : s.kind==='note' ? T('내레이션') : T('인물 없음');
    return `<p class="hint">${slotBadge(i+1,s?s.kind:'',s?s.character:'')}${T('캐릭터 프롬프트 ({x}, {y})',{x:c.center.x,y:c.center.y})}${name?` · ${esc(name)}`:''}</p><pre>${esc(c.prompt)}</pre>`;
  }).join('');
}

document.querySelector('.editor').addEventListener('input', e => {
  const el=e.target;
  if (busy()) return;
  if(el.id==='replanInstructions'){replanDirections.set(`${doc.id}:${selected}`,el.value);return;}
  const panelIndex = Number(el.closest('[data-panel]')?.dataset.panel), pg = doc.pages[selected].plan;
  if (el.dataset.pageField) {
    if(el.dataset.pageField==='layout' && el.value==='free' && pg.layout!=='free') {
      boxes().forEach(([x,y,w,h],i)=>pg.panels[i].region={x,y,w,h,frame:'rectangle'});
    }
    pg[el.dataset.pageField] = el.value;
    if(el.dataset.pageField==='layout'){renderEditor();controls();}
  }
  else if(el.dataset.regionField) {
    const r=pg.panels[panelIndex].region, key=el.dataset.regionField;
    if(key==='frame') r.frame=el.value;
    else {
      const v=Number(el.value);
      if(!Number.isFinite(v))return;
      r[key]=Math.max(key==='w'||key==='h'?.05:0,Math.min(key==='x'||key==='y'?.95:1,v));
      if(key==='x'||key==='w') r.w=Math.min(r.w,1-r.x);
      if(key==='y'||key==='h') r.h=Math.min(r.h,1-r.y);
    }
  }
  else if (el.dataset.panelField) pg.panels[panelIndex][el.dataset.panelField] = el.value;
  else if (el.dataset.subjectField) {
    const field=el.dataset.subjectField, subject=pg.panels[panelIndex].subjects[+el.closest('[data-subject]').dataset.subject];
    if (field==='character') {
      // 대사는 화자 id 로 인물에 붙는다 — 인물을 바꾸면 그 대사도 따라가야 `validate_page` 를 지난다.
      const was=subject.character;
      subject.character=el.value;
      pg.panels[panelIndex].dialogue.forEach(d=>{ if(d.speaker===was) d.speaker=el.value; });
      markDirty(); renderEditor(); renderBoard(); controls(); return;
    }
    // 남은 것은 카메라와 동작뿐이다 — 자리(x·y)는 콘티의 끌기가 정한다
    subject[field] = el.value;
  } else if (el.dataset.lineField) {
    pg.panels[panelIndex].dialogue[+el.closest('[data-line]').dataset.line][el.dataset.lineField] = el.value;
    // 화자를 바꾸면 그 대사가 다른 인물 블록으로 옮겨 간다.
    if (el.dataset.lineField==='speaker') { markDirty(); renderEditor(); renderBoard(); controls(); return; }
  }
  else if (el.dataset.charField) doc.outline.characters[+el.closest('[data-character]').dataset.character][el.dataset.charField] = el.value;
  markDirty(); renderBoard();
});
document.querySelector('.editor').addEventListener('click', e => {
  if(e.target.closest('#replanPage')) {
    const instructions=$('replanInstructions').value;
    perform(async()=>{await saveLlm();adopt(await api(`projects/${doc.id}/replan`,'POST',{revision:doc.revision,page:selected,instructions}));},'페이지 재기획 준비','replanPage');
    return;
  }
  if(e.target.closest('#deletePage')) {
    if(busy()) return;
    const page=selected;
    // ★확인은 **앱이 그린다** (`peropix.ask`) — 브라우저 `confirm` 은 앱 밖 OS 대화상자라 쓰지 않는다
    void (async()=>{
      if(!await confirmAsk({title:T('{n}페이지를 지울까요?',{n:page+1}),body:T('콘티와 이미지 목록이 지워지고, 생성된 파일은 워크스페이스에 남습니다.'),ok:T('삭제'),danger:true}))return;
      perform(async()=>{const next=await api(`projects/${doc.id}/pages/${page}/delete`,'POST',{revision:doc.revision});selected=Math.max(0,page-1);adopt(next);},'페이지 삭제','deletePage');
    })();
    return;
  }
  const cut=e.target.closest('[data-cut]');
  if (cut && !busy()) {
    panelOpen.set(`${doc.id}:${selected}`,+cut.dataset.cut);
    renderEditor(); renderBoard(); controls(); return;
  }
  const region=e.target.closest('[data-region-toggle]');
  if (region && !busy()) {
    const key=`${doc.id}:${selected}:${region.dataset.regionToggle}`;
    regionOpen.has(key) ? regionOpen.delete(key) : regionOpen.add(key);
    renderEditor(); controls(); return;
  }
  const dropSubject=e.target.closest('[data-remove-subject]');
  if (dropSubject && !busy()) {
    const panel=doc.pages[selected].plan.panels[+dropSubject.closest('[data-panel]').dataset.panel], at=+dropSubject.dataset.removeSubject;
    const who=panel.subjects[at].character, spoken=panel.dialogue.filter(d=>d.speaker===who).length;
    void (async()=>{
      // 대사를 잃는 삭제만 묻는다 — 빈 인물까지 물으면 확인창이 잡음이 된다.
      if (spoken && !await confirmAsk({title:T('{name}, 이 컷에서 뺄까요?',{name:doc.outline.characters.find(c=>c.id===who)?.name || ''}),
                                       body:T('이 인물의 대사 {n}줄도 함께 사라집니다.',{n:spoken}),ok:T('삭제'),danger:true})) return;
      panel.dialogue=panel.dialogue.filter(d=>d.speaker!==who);
      panel.subjects.splice(at,1);
      markDirty(); renderEditor(); renderBoard(); controls();
    })();
    return;
  }
  const addSubject=e.target.closest('[data-add-subject]'), add=e.target.closest('[data-add-line]');
  const addNote=e.target.closest('[data-add-note]'), remove=e.target.closest('[data-remove-line]');
  if (busy() || (!addSubject && !add && !addNote && !remove)) return;
  if (addSubject) {
    const panel=doc.pages[selected].plan.panels[+addSubject.dataset.addSubject], taken=new Set(panel.subjects.map(s=>s.character));
    const spare=doc.outline.characters.find(c=>!taken.has(c.id));
    // 동작 태그는 비운 채로 둔다 — 넣지 않은 태그가 그림에 끼어들지 않게. `tags()` 가 빈 값을 버린다.
    // 자리는 앞서 넣은 인물과 겹치지 않게 벌려 둔다 (컷당 넷까지다).
    const SPOTS=[.5,.7,.3,.85];
    if (panel.subjects.length<4 && spare) panel.subjects.push({character:spare.id,camera:'',action:'',x:SPOTS[panel.subjects.length],y:.55});
  }
  if (add) {
    const panel=doc.pages[selected].plan.panels[+add.dataset.addLine], who=panel.subjects[+add.dataset.addFor];
    if (panel.dialogue.length<3 && who) panel.dialogue.push({speaker:who.character,text:'...'});
  }
  if (addNote) {
    const panel=doc.pages[selected].plan.panels[+addNote.dataset.addNote];
    if (panel.dialogue.length<3) {
      // ★있던 내레이션의 자리를 먼저 굳힌다 — 자리를 안 들고 있으면 개수로 나눠 놓으므로, 하나 더
      //   넣을 때 이미 놓인 것들이 밀린다 (`core.compile_page` 도 같은 규칙이다).
      const rtl=options().direction==='rtl', notes=panel.dialogue.filter(l=>!l.speaker);
      notes.forEach((l,j)=>{
        if(l.x==null){ const u=(j+.5)/notes.length; l.x=Math.round((rtl?1-u:u)*100)/100; }
        if(l.y==null) l.y=.15;
      });
      panel.dialogue.push({speaker:'',text:'...'});
    }
  }
  if (remove) doc.pages[selected].plan.panels[+remove.closest('[data-panel]').dataset.panel].dialogue.splice(+remove.dataset.removeLine,1);
  markDirty(); renderEditor(); renderBoard(); controls();
});
document.querySelector('.editor').addEventListener('change',e=>{
  if(e.target.dataset.regionField && !busy()){renderEditor();renderBoard();controls();}
});
$('board').addEventListener('pointerdown', e => {
  const marker=e.target.closest('[data-marker]');
  if (!marker || busy()) return;
  e.preventDefault();
  const [pi,kind,at]=marker.dataset.marker.split(','), svg=marker.ownerSVGElement;
  const [x,y,w,h]=boxes()[+pi], panel=doc.pages[selected].plan.panels[+pi], frame=doc.pages[selected].plan.layout==='free'?panel.region.frame:'rectangle';
  // 인물은 `subjects[n]`, 내레이션은 `dialogue[n]` 이다. 둘 다 컷 안의 비율을 제 자리로 들고 있다.
  const subject=kind==='note' ? panel.dialogue[+at] : panel.subjects[+kind];
  const move = event => {
    const point=new DOMPoint(event.clientX,event.clientY).matrixTransform(svg.getScreenCTM().inverse());
    subject.x = Math.round(Math.max(.05,Math.min(.95,(point.x/500-x)/w))*100)/100;
    let v=(point.y/svg.viewBox.baseVal.height-y)/h;
    if(frame==='slant-up')v=(v-.15*(1-subject.x))/.85;
    if(frame==='slant-down')v=(v-.15*subject.x)/.85;
    subject.y = Math.round(Math.max(.05,Math.min(.95,v))*100)/100;
    const [a,b]=pointInRegion([x,y,w,h],frame,subject.x,subject.y);
    marker.setAttribute('transform',`translate(${a*500},${b*svg.viewBox.baseVal.height})`);
  };
  const end = () => {svg.removeEventListener('pointermove',move);svg.removeEventListener('pointerup',end);svg.removeEventListener('pointercancel',end);markDirty();renderEditor();renderBoard();controls();};
  svg.setPointerCapture(e.pointerId);svg.addEventListener('pointermove',move);svg.addEventListener('pointerup',end);svg.addEventListener('pointercancel',end);
});
$('pageNav').onclick = async e => { const tab=e.target.closest('[data-page]');if (!tab)return;try{await persist();selected=+tab.dataset.page;render();}catch(e){error(e);} };
$('boardMode').onclick=()=>setMode('board');$('imageMode').onclick=()=>setMode('image');
for (const id of optionIds) $(id).addEventListener('change',()=>{
  if(id==='size' && $('size').value!=='custom'){const [w,h]=$('size').value.split(',');$('width').value=w;$('height').value=h;}
  if(id==='width'||id==='height')syncSize();
  draft();markDirty();if(id==='dialogue'&&doc?.pages.length)renderEditor();renderBoard();controls();
});
$('story').addEventListener('input',draft);
$('example').onclick=()=>{$('story').value=T('키타가와 마린이 고죠네 집에 놀러 갔다. 고죠가 소파에서 자고 있길래 몰래 다가가 볼을 콕 찌른다. 가까이서 얼굴을 보다가 두근거려 당황하는 순간 고죠가 눈을 뜨고, 둘 다 얼굴이 빨개진다. 귀엽고 설레는 일상 로맨스.');draft();};
async function perform(fn,label='요청 처리',target='') {
  if (requesting) return;
  requesting=true;
  // ★부르는 쪽은 한국어 이름을 그대로 넘긴다 — 옮기는 것은 여기 한 자리다
  activeOperation={label:T(label),target,started_at:Date.now()/1000};
  clearError();
  try {controls();await persist();await fn();}
  catch(e){error(e);}
  finally{requesting=false;activeOperation=null;controls();}
}
/** 새 만화 · 남은 기획 잇기 · 이어서 그리기를 한 창구가 받는다 (사용자 지시 2026-09-15:
 *  *"최초 생성이나 이어서 생성이나 똑같은 창구를 써도 상관없지 않나? 두개가 있으니까 오히려 헷갈림"*).
 *  ★처음부터 다시 만드는 길은 상단 「새 만화」 하나다 — 전체 재기획 버튼을 없앴다. */
async function start(automatic) {
  await perform(async()=>{
    const text=$('story').value.trim(), pages=+$('pageCount').value;
    if (!doc && !text) throw new Error(T('무엇을 그릴지 적어 주세요.'));
    await saveLlm();
    if (!config.llm.ready) throw new Error(T('선택한 CLI의 설치 상태 또는 API 공급자의 키 설정을 확인해 주세요.'));
    if (!doc) {
      selected=0;mode='board';
      adopt(await api('projects','POST',{story:text,options:{...options(),pages},automatic}));
    } else if (!doc.outline || doc.pages.length < doc.outline.pages.length) {
      adopt(await api(`projects/${doc.id}/plan`,'POST',{automatic}));
    } else {
      adopt(await api(`projects/${doc.id}/continue`,'POST',{revision:doc.revision,pages,instructions:text,automatic}));
    }
    $('story').value='';$('pageCount').value='0';draft();
    await listProjects();
  },'기획 요청 준비',automatic?'automatic':'plan');
}
$('plan').onclick=()=>start(false);$('automatic').onclick=()=>start(true);
const generate = page => perform(async()=>{adopt(await api(`projects/${doc.id}/generate`,'POST',{revision:doc.revision,...(page===undefined?{}:{page})}));},'생성 요청 준비',page===undefined?'generateAll':'generatePage');
$('generatePage').onclick=()=>generate(selected);$('generateAll').onclick=()=>generate();
$('stop').onclick=()=>perform(async()=>{adopt(await api(`projects/${doc.id}/stop`,'POST',{}));await listProjects();},'즉시 중단','stop');
function resetComposition(){ $('layoutMode').value='free';$('maxPanels').value='0';$('dialogue').value='ko'; }
$('new').onclick=()=>perform(async()=>{doc=null;selected=0;dirty=false;try{localStorage.removeItem('manga-maker-current');}catch{}$('story').value='';$('projects').value='';resetComposition();draft();render();});
$('projects').onchange=()=>perform(async()=>{const id=$('projects').value;if(id){selected=0;adopt(await api(`projects/${id}`));}else{doc=null;selected=0;$('story').value='';try{localStorage.removeItem('manga-maker-current');}catch{}render();}});
$('export').onclick=()=>perform(async()=>{
  const response=await fetch(new URL(`projects/${doc.id}/export`,base));
  if(!response.ok)throw new Error(T('ZIP을 저장하지 못했습니다.'));
  const url=URL.createObjectURL(await response.blob()),a=document.createElement('a');
  a.href=url;a.download=`${T('만화')}-${doc.outline?.title || doc.id}.zip`;a.click();setTimeout(()=>URL.revokeObjectURL(url),30000);
});

async function init() {
  /* ★★앱 언어를 따라간다 (카메라 구도·태그 굴리기와 같은 방식). 앱 설정에서 바꾸면 `onLocale`
       로 알림이 와서 정적 문구와 지금 그린 것을 함께 다시 채운다. */
  if (window.peropix?.inApp) {
    try { setMangaLang(await peropix.locale()); } catch {}
    peropix.onLocale(l=>{ setMangaLang(l); if(config)render(); if(config)renderLlm(); renderStyles(); });
  }
  config=await api('config');
  $('negativePrompt').value=config.default_negative;
  $('workspace').innerHTML=`<option value="">${T('워크스페이스 선택')}</option>`+config.workspaces.map(w=>`<option value="${esc(w)}">${esc(w)}</option>`).join('');
  $('account').innerHTML=config.accounts.map(a=>`<option value="${esc(a.id)}">${esc(a.name)}</option>`).join('');
  renderLlm();
  try {
    const saved=JSON.parse(localStorage.getItem('manga-maker-draft') || 'null');
    if(saved){$('story').value=saved.story;putOptions(saved.options);$('pageCount').value=saved.options.pages ?? 0;if(!saved.options.layout_mode)resetComposition();}
    const current=localStorage.getItem('manga-maker-current');
    if(current)adopt(await api(`projects/${current}`));
  }catch(e){error(e);}
  if (!doc && window.peropix?.inApp) {
    try {const state=await peropix.state();if(config.workspaces.includes(state.workspace))$('workspace').value=state.workspace;}catch{}
  }
  await listProjects();render();
  try{await listStyles();}catch(e){error(e);$('refreshStyles').disabled=false;}
  setInterval(async()=>{
    if (!doc || !busyStates.includes(doc.status) || requesting || saving || dirty) return;
    const id=doc.id;
    try{const next=await api(`projects/${id}`);if(doc?.id!==id)return;if(next.revision>doc.revision){adopt(next);if(!busyStates.includes(next.status))await listProjects();}else if(next.revision===doc.revision){doc.queue_state=next.queue_state;updateActivity();}}
    catch(e){error(e);}
  },1500);
}
window.addEventListener('beforeunload',e=>{if(dirty || saving){e.preventDefault();e.returnValue='';}});
$('llmProvider').onchange=()=>{
  const provider=$('llmProvider').value, p=config.llm.providers.find(x=>x.id===provider);
  modelRows=modelsBy[provider]?.models || [];
  renderModels(p?.model || '');
  renderEffort('');
  $('llm').textContent=T('모델을 고르면 저장됩니다.');
  controls();
  if(p && p.engine!=='cli' && !modelsBy[provider]) void loadModels(provider);
};
// ★모델·강도는 고르는 즉시 저장한다. perform 을 쓰지 않는다 — 저장이 도는 동안 화면이 잠겨
//   바로 다음 선택이 막혔다 (2026-09-15).
let llmSaveChain=Promise.resolve();
// ★한 줄로 이어 붙인다 — 공급자와 모델을 잇따라 바꾸면 먼저 보낸 저장이 늦게 끝나
//   앞선 선택으로 되돌아갔다 (2026-09-15).
const autoSaveLlm=()=>{llmSaveChain=llmSaveChain.then(saveLlm).catch(error);};
$('llmModel').onchange=()=>{renderEffort('');autoSaveLlm();};
$('llmEffort').onchange=autoSaveLlm;
$('llmRefresh').onclick=()=>perform(async()=>{config.llm=await api('llm');renderLlm();await loadModels($('llmProvider').value,true);},'LLM 설정 확인','llmRefresh');
// ★목록에서 고르면 그대로 적용된다 — 「선택한 화풍 적용」 버튼을 없앴고, 이름 변경·삭제는
//   목록 항목 안의 버튼이 맡는다 (사용자 지시 2026-09-15).
const styleIcons={
  pencil:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.5 2.5 13.5 4.5 5.5 12.5 3 13l.5-2.5z"/></svg>',
  trash:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M3 4.5h10M6.5 4.5V3h3v1.5M5 4.5l.6 8.5h4.8l.6-8.5"/></svg>',
  check:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m3.5 8.5 3 3 6-7"/></svg>',
  cross:'<svg viewBox="0 0 16 16" aria-hidden="true"><path d="m4 4 8 8M12 4l-8 8"/></svg>',
};
function renderStyles(){
  const current=savedStyles.find(s=>s.id===selectedStyle);
  $('stylePickerLabel').textContent=current?.name || T(savedStyles.length?'저장된 화풍 선택':'저장된 화풍 없음');
  $('styleList').innerHTML = savedStyles.length ? savedStyles.map(s=>s.id===renamingStyle
    ? `<div class="style-row" data-style="${esc(s.id)}"><input class="style-rename-input" maxlength="120" aria-label="화풍 이름" value="${esc(s.name)}"><button class="icon-btn" data-rename-ok="${esc(s.id)}" aria-label="${T('저장')}" title="${T('저장')}">${styleIcons.check}</button><button class="icon-btn" data-rename-cancel="1" aria-label="${T('취소')}" title="${T('취소')}">${styleIcons.cross}</button></div>`
    : `<div class="style-row" data-style="${esc(s.id)}"><button class="style-pick" role="option" aria-selected="${s.id===selectedStyle}" data-pick="${esc(s.id)}">${esc(s.name)}</button><button class="icon-btn" data-rename="${esc(s.id)}" aria-label="${T('이름 변경')}" title="${T('이름 변경')}">${styleIcons.pencil}</button><button class="icon-btn" data-delete="${esc(s.id)}" aria-label="${T('삭제')}" title="${T('삭제')}">${styleIcons.trash}</button></div>`).join('')
    : `<p class="style-empty">${T('저장된 화풍이 없습니다.')}</p>`;
  controls();
}
function openStyleList(open){
  $('styleList').hidden=!open;
  $('stylePicker').setAttribute('aria-expanded',String(open));
  if(!open)renamingStyle='';
  renderStyles();
}
async function listStyles(id=selectedStyle){
  const data=await api('styles');
  savedStyles=data.items;stylesReady=true;
  selectedStyle=savedStyles.some(s=>s.id===id)?id:'';
  renamingStyle='';
  renderStyles();
}
function rememberStyle(item){
  savedStyles=[item,...savedStyles.filter(s=>s.id!==item.id)];
  stylesReady=true;selectedStyle=item.id;renamingStyle='';
  renderStyles();
}
async function applyStyleData(data){
  $('stylePrompt').value=data.style_prompt;
  $('style').value=data.style_prompt.trim() ? 'custom' : $('style').value;
  $('negativePrompt').value=data.negative_prompt;
  for(const [key,value] of Object.entries(data.generation_options || {}))if(generationFields[key])$(generationFields[key]).value=value;
  syncSize();
  const imported=Object.entries(data.generation_options || {}).filter(([key])=>generationFields[key]).map(([key,value])=>`${T(generationLabels[key])} ${value}`);
  $('importedOptions').hidden=false;
  $('importedOptions').textContent=(imported.length ? T('가져옴: {list}',{list:imported.join(' · ')}) : T('기록된 생성 옵션이 없어 현재 설정을 유지합니다.')) + (data.skipped_options?.length ? ' · '+T('적용할 수 없는 값: {list}',{list:data.skipped_options.map(k=>T(generationLabels[k] || k)).join(', ')}) : '');
  referenceName=data.reference_name || '';
  $('styleRefName').textContent=referenceName ? T('참고 이미지: {name}',{name:referenceName}) : '';
  $('styleRefPreview').hidden=true;
  if(referencePreviewUrl){URL.revokeObjectURL(referencePreviewUrl);referencePreviewUrl='';}
  draft();if(doc?.outline){dirty=true;await persist();renderBoard();}
}
$('stylePicker').onclick=()=>{if(!busy()&&stylesReady)openStyleList($('styleList').hidden);};
// ★`isConnected` 를 먼저 본다 — 목록을 다시 그리면 눌린 버튼이 문서에서 떨어져 나가고,
//   그 상태의 closest() 는 언제나 null 이라 방금 연 목록이 그대로 닫혔다 (2026-09-15).
document.addEventListener('click',e=>{if(!$('styleList').hidden&&e.target.isConnected&&!e.target.closest('.style-picker'))openStyleList(false);});
document.addEventListener('keydown',e=>{if(e.key==='Escape'&&!$('styleList').hidden)openStyleList(false);});
$('styleList').addEventListener('keydown',e=>{
  if(!e.target.classList.contains('style-rename-input'))return;
  if(e.key==='Enter'){e.preventDefault();$('styleList').querySelector('[data-rename-ok]')?.click();}
  if(e.key==='Escape'){e.stopPropagation();renamingStyle='';renderStyles();}
});
$('styleList').addEventListener('click',e=>{
  if(busy())return;
  const pick=e.target.closest('[data-pick]'), rename=e.target.closest('[data-rename]'),
        ok=e.target.closest('[data-rename-ok]'), cancel=e.target.closest('[data-rename-cancel]'),
        remove=e.target.closest('[data-delete]');
  if(pick)perform(async()=>{
    const item=await api(`styles/${pick.dataset.pick}`);
    rememberStyle(item);openStyleList(false);await applyStyleData(item);
    $('styleLibraryStatus').textContent=T('「{name}」 적용됨',{name:item.name});
  },'저장된 화풍 적용','stylePicker');
  else if(rename){renamingStyle=rename.dataset.rename;renderStyles();$('styleList').querySelector('.style-rename-input')?.focus();}
  else if(cancel){renamingStyle='';renderStyles();}
  else if(ok)perform(async()=>{
    const name=($('styleList').querySelector('.style-rename-input')?.value || '').trim();
    if(!name)throw new Error(T('화풍 이름을 입력해 주세요.'));
    const item=await api(`styles/${ok.dataset.renameOk}`,'PATCH',{name});
    rememberStyle(item);$('styleLibraryStatus').textContent=T('「{name}」 이름 변경됨',{name:item.name});
  },'화풍 이름 변경','stylePicker');
  else if(remove){
    const id=remove.dataset.delete, name=savedStyles.find(s=>s.id===id)?.name || '';
    void (async()=>{
      if(!await confirmAsk({title:T('「{name}」 화풍을 지울까요?',{name}),body:T('이미 적용된 설정과 프로젝트는 그대로 남습니다.'),ok:T('삭제'),danger:true}))return;
      perform(async()=>{
        await api(`styles/${id}`,'DELETE');
        if(selectedStyle===id)selectedStyle='';
        await listStyles();
        $('styleLibraryStatus').textContent=T('「{name}」 삭제됨',{name});
      },'화풍 삭제','stylePicker');
    })();
  }
});
$('refreshStyles').onclick=()=>perform(async()=>{await listStyles();$('styleLibraryStatus').textContent=T('저장된 화풍 {n}개',{n:savedStyles.length});} ,'화풍 목록 불러오기','refreshStyles');
/* ★이름은 **제자리 입력칸**으로 받는다 (사용자 결정 2026-09-20). `window.prompt` 는 앱 밖
     OS 대화상자라 앱의 글꼴·테마·언어와 따로 놀고, 목록 안의 이름 변경과도 모양이 달랐다. */
function openStyleName(open){
  $('styleNameRow').hidden=!open;
  $('saveStyle').hidden=open;
  if(open){
    $('styleName').value=referenceName ? referenceName.replace(/\.[^.]+$/,'') : T('화풍 {n}',{n:savedStyles.length+1});
    $('styleName').focus();$('styleName').select();
  }
}
$('styleNameOk').innerHTML=styleIcons.check;$('styleNameCancel').innerHTML=styleIcons.cross;
$('saveStyle').onclick=()=>{if(!busy())openStyleName(true);};
$('styleNameCancel').onclick=()=>openStyleName(false);
$('styleName').addEventListener('keydown',e=>{
  if(e.key==='Enter'){e.preventDefault();$('styleNameOk').click();}
  if(e.key==='Escape'){e.stopPropagation();openStyleName(false);}
});
$('styleNameOk').onclick=()=>perform(async()=>{
  const o=options(), name=$('styleName').value.trim();
  if(!name)throw new Error(T('화풍 이름을 입력해 주세요.'));
  const item=await api('styles','POST',{name,style_prompt:o.style_prompt,negative_prompt:o.negative_prompt,reference_name:referenceName,
    generation_options:Object.fromEntries(Object.keys(generationFields).map(key=>[key,o[key]]))});
  openStyleName(false);
  rememberStyle(item);$('styleLibraryStatus').textContent=T('「{name}」 새 화풍으로 저장됨',{name:item.name});
},'화풍 저장','saveStyle');
for(const event of ['input','change'])$('stylePrompt').addEventListener(event,()=>{
  if($('stylePrompt').value.trim()&&$('style').value!=='custom')$('style').value='custom';   // 적는 순간 내 화풍으로
  controls();
});
async function importStyle(file) {
  if(!file || busy())return;
  await perform(async()=>{
    await saveLlm();
    $('styleRefName').textContent=T('원본 프롬프트에서 화풍 추출 중…');
    const body=new FormData();body.append('file',file);
    try {
      const response=await fetch(new URL('style-reference',base),{method:'POST',body});
      const data=await response.json();
      if(!response.ok)throw new Error(typeof data.detail==='string'?data.detail:T('참고 이미지 화풍 추출에 실패했습니다.'));
      rememberStyle(data);
      $('styleLibraryStatus').textContent=T('「{name}」 추출 후 자동 저장됨',{name:data.name});
      await applyStyleData(data);
      if(URL.createObjectURL){
        referencePreviewUrl=URL.createObjectURL(file);
        $('styleRefPreview').src=referencePreviewUrl;$('styleRefPreview').hidden=false;
      }
    } finally {
      $('styleRefName').textContent=referenceName ? T('참고 이미지: {name}',{name:referenceName}) : T('참고 이미지 없음');
      $('styleImage').value='';
    }
  },'참고 이미지 가져오기','styleImage');
}
$('styleImage').onchange=e=>importStyle(e.target.files[0]);
$('styleRefDrop').ondragover=e=>{e.preventDefault();};
$('styleRefDrop').ondrop=e=>{e.preventDefault();importStyle(e.dataTransfer.files[0]);};
$('translateDialogue').onclick=()=>perform(async()=>{await saveLlm();adopt(await api(`projects/${doc.id}/translate`,'POST',{revision:doc.revision}));},'대사 번역 준비','translateDialogue');
$('previewWidth').oninput=()=>{viewPrefs.width=+$('previewWidth').value;viewPrefs.fit=false;applyView();saveView();};
$('fitPreview').onclick=()=>{viewPrefs.fit=true;applyView();saveView();};
$('toggleSetup').onclick=()=>{viewPrefs.setupOpen=!viewPrefs.setupOpen;applyView();saveView();};
$('toggleEditor').onclick=()=>{viewPrefs.editorOpen=!viewPrefs.editorOpen;applyView();saveView();};
function showTab(name){
  viewPrefs.tab=name;
  for(const el of document.querySelectorAll('.tabitem'))el.setAttribute('aria-selected',String(el.dataset.tab===name));
  for(const el of document.querySelectorAll('.tabpane'))el.hidden=el.dataset.pane!==name;
}
for(const el of document.querySelectorAll('.tabitem'))el.onclick=()=>{showTab(el.dataset.tab);saveView();};
showTab(document.querySelector(`.tabitem[data-tab="${viewPrefs.tab}"]`) ? viewPrefs.tab : 'story');
if(window.ResizeObserver)new ResizeObserver(updateWidthLabel).observe(document.querySelector('.stage'));
applyView();setInterval(updateActivity,1000);
init().catch(error);
