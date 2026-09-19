// Real Chromium layout QA against the offline fixture only. Start Chrome on port 9335 with a disposable profile.
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
const origin='http://127.0.0.1:8779/k/qa';
const tabs=await (await fetch('http://127.0.0.1:9335/json/list')).json();
const ws=new WebSocket(tabs.find(t=>t.type==='page').webSocketDebuggerUrl);
await new Promise((resolve,reject)=>{ws.onopen=resolve;ws.onerror=reject;});
let sequence=0,loaded;const pending=new Map();
ws.onmessage=e=>{const r=JSON.parse(e.data);if(r.method==='Page.loadEventFired')loaded?.();if(r.id){const task=pending.get(r.id);pending.delete(r.id);r.error?task.reject(new Error(JSON.stringify(r.error))):task.resolve(r.result);}};
function cdp(method,params={}){return new Promise((resolve,reject)=>{const id=++sequence;pending.set(id,{resolve,reject});ws.send(JSON.stringify({id,method,params}));});}
async function navigate(method,params={}){let timer;const ready=new Promise((resolve,reject)=>{loaded=resolve;timer=setTimeout(()=>reject(new Error('Navigation timeout')),10000);});try{await cdp(method,params);await ready;}finally{clearTimeout(timer);loaded=null;}}
async function evaluate(expression){const r=await cdp('Runtime.evaluate',{expression,awaitPromise:true,returnByValue:true});if(r.exceptionDetails)throw new Error(JSON.stringify(r.exceptionDetails));return r.result.value;}
const pause=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(expression){for(let i=0;i<100;i++){if(await evaluate(expression))return;await pause(100);}throw new Error(`Timeout: ${expression}`);}
async function screenshot(name){const r=await cdp('Page.captureScreenshot',{format:'png'});await fs.writeFile(new URL(`../../../_tmp/manga-maker-qa-llm/${name}.png`,import.meta.url),Buffer.from(r.data,'base64'));}
const items=(await (await fetch(origin+'/plug/manga-maker/api/projects')).json()).items;
let pid;
for(const item of items){const p=await (await fetch(origin+'/plug/manga-maker/api/projects/'+item.id)).json();if(p.pages[0]?.images.length&&!['planning','generating','stopping'].includes(p.status)){pid=p.id;break;}}
assert.ok(pid,'Run test_ui.mjs first to create an offline project with images');
try{
  await cdp('Page.enable');await cdp('Runtime.enable');
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await navigate('Page.navigate',{url:origin+'/plug/manga-maker/web/'});
  await wait(`document.getElementById('projects')?.options.length>1`);
  await evaluate(`localStorage.setItem('manga-maker-current',${JSON.stringify(pid)});localStorage.removeItem('manga-maker-view')`);
  await navigate('Page.reload');
  await wait(`document.getElementById('content')&&!document.getElementById('content').hidden`);
  await evaluate(`document.getElementById('imageMode').click()`);
  await wait(`document.querySelector('#result img')?.complete`);
  const large=await evaluate(`document.querySelector('#result img').getBoundingClientRect().width`);
  assert.ok(large>1000,`Large image preview: ${large}`);
  await screenshot('preview-wide');
  await evaluate(`document.getElementById('previewWidth').value=600;document.getElementById('previewWidth').dispatchEvent(new Event('input',{bubbles:true}))`);
  await pause(100);
  const small=await evaluate(`document.querySelector('.stage').getBoundingClientRect().width`);
  assert.equal(Math.round(small),600);
  await evaluate(`document.getElementById('fitPreview').click();document.getElementById('toggleSetup').click();document.getElementById('toggleEditor').click()`);
  await pause(100);
  assert.ok(await evaluate(`document.querySelector('#result img').getBoundingClientRect().width`)>large);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('editorPane')).display`),'none');
  await screenshot('preview-focus');
  await evaluate(`document.getElementById('toggleSetup').click();document.getElementById('toggleEditor').click();document.querySelector('.tabitem[data-tab="generation"]').click()`);
  await wait(`document.querySelector('[data-pane="generation"]').hidden===false`);
  await pause(100);await navigate('Page.reload');
  await wait(`document.getElementById('content')&&!document.getElementById('content').hidden`);
  assert.equal(await evaluate(`document.querySelector('[data-pane="generation"]').hidden`),false);
  // Real browser upload exercises the visible spinner while the fake LLM waits.
  const dom=await cdp('DOM.getDocument');
  const node=await cdp('DOM.querySelector',{nodeId:dom.root.nodeId,selector:'#styleImage'});
  await cdp('DOM.setFileInputFiles',{nodeId:node.nodeId,files:[fileURLToPath(new URL('../../../_tmp/manga-maker-qa-llm/style-reference.png',import.meta.url))]});
  await wait(`!document.getElementById('referenceActivity').hidden`);
  assert.equal(await evaluate(`getComputedStyle(document.getElementById('activitySpinner')).animationName`),'activity-spin');
  await screenshot('reference-working');
  assert.ok(await evaluate(`document.querySelector('#board svg').getBoundingClientRect().width > document.querySelector('.stage').getBoundingClientRect().width-40`),'Board also fills its preview area');
  await wait(`document.getElementById('referenceActivity').hidden&&!document.getElementById('plan').disabled`);
  assert.ok(await evaluate(`document.getElementById('stylePickerLabel').textContent`),'Reference extraction selects the saved style');
  await evaluate(`document.querySelector('.tabitem[data-tab="style"]').click();window.scrollTo(0,0);document.querySelector('.setup').scrollTop=0`);
  await pause(100);
  // 보이는 컨트롤만 본다 — 화풍 목록은 펼치기 전에는 폭이 0이다.
  const fits=`(()=>{const card=document.querySelector('.style-library').getBoundingClientRect();return [...document.querySelectorAll('.style-library input,.style-library select,.style-library button')].filter(el=>el.getBoundingClientRect().width>0).every(el=>{const r=el.getBoundingClientRect();return r.left>=card.left&&r.right<=card.right;});})()`;
  assert.equal(await evaluate(fits),true,'Library controls fit the sidebar');
  await evaluate(`document.getElementById('stylePicker').click()`);
  await pause(150);
  assert.equal(await evaluate(fits),true,'Opened style list fits the sidebar');
  await evaluate(`document.getElementById('stylePicker').click()`);
  await screenshot('style-library');
  await evaluate(`document.getElementById('stylePicker').click();document.querySelector('[data-rename]').click()`);
  await evaluate(`const el=document.querySelector('.style-rename-input');el.value='따뜻한 수채화';document.querySelector('[data-rename-ok]').click()`);
  await wait(`document.getElementById('styleLibraryStatus').textContent.includes('이름 변경됨')&&!document.getElementById('stylePicker').disabled`);
  await evaluate(`document.getElementById('stylePicker').click();document.querySelector('[data-pick]').click()`);
  await wait(`document.getElementById('styleLibraryStatus').textContent.includes('적용됨')&&!document.getElementById('stylePicker').disabled`);
  await screenshot('style-library-applied');
  for(const width of [1000,680]){
    await cdp('Emulation.setDeviceMetricsOverride',{width,height:900,deviceScaleFactor:1,mobile:false});
    await evaluate(`document.getElementById('imageMode').click();if(document.getElementById('toggleSetup').getAttribute('aria-expanded')==='true')document.getElementById('toggleSetup').click()`);
    await pause(150);
    assert.equal(await evaluate(`document.documentElement.scrollWidth>innerWidth`),false,`No horizontal overflow at ${width}`);
    await screenshot('preview-'+width);
    const shown=await evaluate(`document.querySelector('#result img').getBoundingClientRect().width`);
    assert.ok(shown>width-150,`${width}px viewport shows ${shown}px image`);
  }
  await cdp('Emulation.setDeviceMetricsOverride',{width:1440,height:1000,deviceScaleFactor:1,mobile:false});
  await evaluate(`document.getElementById('boardMode').click();if(document.getElementById('toggleSetup').getAttribute('aria-expanded')==='false')document.getElementById('toggleSetup').click();window.scrollTo(0,0)`);
  assert.equal(await evaluate(`document.getElementById('story').disabled`),false);
  await evaluate(`document.getElementById('replanInstructions').value='마지막 장면을 크게 구성하고 대사를 줄여 줘.';document.getElementById('replanInstructions').dispatchEvent(new Event('input',{bubbles:true}))`);
  await screenshot('replan-controls');
  await evaluate(`document.getElementById('replanPage').click()`);
  await wait(`!document.getElementById('stop').hidden`);
  await evaluate(`document.getElementById('stop').click()`);
  await wait(`document.getElementById('status').textContent.includes('즉시 중단')&&!document.getElementById('plan').disabled`);
  assert.equal(await evaluate(`document.getElementById('activitySpinner').hidden`),true);
  await screenshot('replan-stopped');
  console.log(`PASS: Chromium layout, ${Math.round(large)}px preview, width/collapse controls, upload spinner, responsive views, editable story, replan instructions and immediate stop.`);
}finally{ws.close();}
