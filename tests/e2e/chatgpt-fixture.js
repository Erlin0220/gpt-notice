// Controlled native-composer fixture. These are real Chromium + MV3 integration
// tests, not claims about the live ChatGPT service; live verification is separate.
const html = `<!doctype html><html><head><meta charset="utf-8"><title>Queue regression</title><style>
body{margin:0;font:16px system-ui}nav{position:fixed;inset:0 auto 0 0;width:220px;overflow:auto}main{max-width:760px;margin:30px auto}form{position:fixed;bottom:32px;left:calc(50% - 360px);width:720px;padding:12px;background:#eee;border-radius:16px}#prompt-textarea{min-height:50px;white-space:pre-wrap;outline:none}#messages{padding-bottom:220px}button{padding:8px}</style></head><body>
<script id="client-bootstrap" type="application/json">{"user":{"id":"regression-user"},"session":{"account":{"id":"regression-workspace"}}}</script>
<svg aria-hidden="true" width="0" height="0"><use href="/cdn/assets/sprites-shell-test.svg#compose"></use><use href="/cdn/assets/sprites-core-test.svg#1af12c"></use></svg>
<nav aria-label="侧边栏"><button id="native-sidebar-toggle" data-testid="close-sidebar-button" aria-label="关闭侧边栏" aria-expanded="true">侧边栏</button><div id="native-sections"></div></nav>
<main><div id="messages"></div><form id="native-form"><div id="prompt-textarea" contenteditable="true" role="textbox" data-virtualkeyboard="true"></div><button id="composer-submit-button" data-testid="send-button" aria-label="发送提示" type="submit" disabled>发送</button></form></main>
<script>
localStorage.setItem('_account',JSON.stringify('regression-workspace'));
document.getElementById('native-sidebar-toggle').addEventListener('click',event=>{const open=event.currentTarget.getAttribute('aria-expanded')==='true';event.currentTarget.setAttribute('aria-expanded',String(!open));event.currentTarget.setAttribute('aria-label',open?'打开侧边栏':'关闭侧边栏');});
for(const [name,key] of [['置顶','favorites'],['项目','projects'],['聊天','chats']]){
  const section=document.createElement('section');section.dataset.nativeSection=key;
  const button=document.createElement('button');button.dataset.section=key;button.innerHTML='<h2>'+name+'</h2>';
  const body=document.createElement('div');body.dataset.sectionBody=key;body.style.minHeight=key==='projects'?'96px':'56px';if(key!=='projects')body.textContent='原生分区内容';
  let prefs={sectionStates:{}};try{prefs=JSON.parse(decodeURIComponent(document.cookie.split('; ').find(c=>c.startsWith('oai-sidebar-sections='))?.split('=')[1]||''));}catch{}
  button.setAttribute('aria-expanded',String(prefs.sectionStates[key]!==false));
  body.hidden=button.getAttribute('aria-expanded')!=='true';
  button.addEventListener('click',()=>{const expanded=button.getAttribute('aria-expanded')!=='true';button.setAttribute('aria-expanded',String(expanded));body.hidden=!expanded;if(key==='projects'&&expanded)window.renderNativeProjects?.();prefs.sectionStates[key]=expanded;document.cookie='oai-sidebar-sections='+encodeURIComponent(JSON.stringify(prefs))+'; Path=/; SameSite=Lax';});
  section.append(button,body);document.getElementById('native-sections').append(section);
}
window.renderNativeProjects=()=>{
  const body=document.querySelector('[data-section-body="projects"]');if(!body)return;
  const entry=Object.entries(localStorage).find(([key])=>key.includes('snorlax-history'));let data;try{data=entry&&JSON.parse(entry[1]);}catch{}
  const items=(data?.value?.pages||[]).flatMap(page=>page.items||[]).map(item=>item?.gizmo?.gizmo).filter(Boolean);
  const icons={terminal:'1af12c',books:'135e8f',book:'135e8f',heart:'a1bba7',function:'e6a16c','graduation-cap':'86811d',kettlebell:'490370',brain:'7a5aca',customize:'8ea31d'};
  const colors={'#3A83F7':'rgb(83, 154, 248)','#FA423E':'rgb(255, 103, 100)','#53B559':'rgb(107, 198, 127)','#8952EE':'rgb(166, 125, 242)'};
  const active=/^\\/g\\/(g-p-[a-f0-9]{32})/.exec(location.pathname)?.[1];const list=document.createElement('ul');
  for(const gizmo of items){const li=document.createElement('li'),row=document.createElement('div'),main=document.createElement('div');row.className='group/project-unfurl-row relative';main.className='group __menu-item hoverable';main.tabIndex=0;main.role='button';main.dataset.sidebarItem='true';if(gizmo.id===active)main.dataset.active='';
    const icon=document.createElement('div');icon.className='relative flex items-center justify-center icon';const holder=document.createElement('div');holder.dataset.testid='project-folder-icon';if(colors[gizmo.display?.theme])holder.style.color=colors[gizmo.display.theme];const svg=document.createElementNS('http://www.w3.org/2000/svg','svg');svg.setAttribute('width','20');svg.setAttribute('height','20');svg.setAttribute('class','icon');const use=document.createElementNS('http://www.w3.org/2000/svg','use');const symbol=icons[gizmo.display?.emoji];use.setAttribute('href',symbol?'/cdn/assets/sprites-core-test.svg#'+symbol:'/cdn/assets/sprites-shell-test.svg#folder');use.setAttribute('fill','currentColor');svg.append(use);holder.append(svg);icon.append(holder);
    const name=document.createElement('span');name.dataset.marqueeText='true';name.textContent=gizmo.display?.name||'';main.append(icon,name);row.append(main);li.append(row);list.append(li);}
  body.replaceChildren(list);
};
window.renderNativeProjects();
if(new URLSearchParams(location.search).has('history-poc'))sessionStorage.setItem('history-poc','1');
if(sessionStorage.getItem('history-poc')==='1'){
  window.historyListResults=[];
  const probe=label=>fetch('/backend-api/conversations?offset=0&limit=28&order=updated').then(()=>window.historyListResults.push(label+':allowed'),()=>window.historyListResults.push(label+':blocked'));
  void probe('initial');setTimeout(()=>void probe('late'),6500);
}
window.sent=[];window.autoReply=true;window.renderAssistant=true;window.model='gpt-5-6-thinking';window.clickDrops=false;window.clickCount=0;window.conversationId=()=>{const marker='/c/';const index=location.pathname.indexOf(marker);return index>=0?location.pathname.slice(index+marker.length).split('/')[0]:null;};
if(new URLSearchParams(location.search).has('sidebar-poc'))sessionStorage.setItem('sidebar-poc','1');
if(sessionStorage.getItem('sidebar-poc')==='1'){
  window.sidebarResults=[];
  window.loadSidebar=()=>Promise.all(['/backend-api/conversations?offset=0&limit=28','/backend-api/conversations?offset=0&hide_snorlax=true'].map(url=>fetch(url).then(r=>window.sidebarResults.push({url,status:r.status}),()=>window.sidebarResults.push({url,status:'blocked'}))));void window.loadSidebar();
  if(window.conversationId())void fetch('/backend-api/conversations/'+window.conversationId()).then(r=>{window.bodyStatus=r.status;});
  const match=/^\\/g\\/(g-p-[a-f0-9]{32})(?:-[a-zA-Z0-9_-]+)?\\/project$/.exec(location.pathname);
  if(match){
    const title=document.createElement('h1');const button=document.createElement('button');button.name='project-title';button.textContent='Current project';title.append(button);document.querySelector('main').prepend(title);
    const list=document.createElement('div');list.id='native-project-recents';title.after(list);
    void fetch('/backend-api/gizmos/'+match[1]+'/conversations?cursor=0').then(r=>r.json()).then(data=>{list.textContent=data.items?.map(item=>item.title).join(', ')||'';});
  }
}
const messages=document.getElementById('messages');
window.addMessage=(role,id,text,model)=>{const turn=document.createElement('section');turn.dataset.testid='conversation-turn-'+id;const node=document.createElement('div');node.dataset.messageAuthorRole=role;node.dataset.messageId=id;if(model)node.dataset.messageModelSlug=model;node.textContent=text;turn.append(node);messages.append(turn);return node;};
window.finish=(text='Done')=>{document.querySelector('[data-testid="stop-button"]')?.remove();const node=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);if(!node)return;node.textContent=text;const b=document.createElement('button');b.dataset.testid='copy-turn-action-button';b.textContent='复制回复';node.parentElement.append(b);};
window.finishWithoutActions=function(text){text=text||"Done";document.querySelector('[data-testid="stop-button"]')?.remove();const nodes=[...document.querySelectorAll('[data-message-author-role="assistant"]')];const node=nodes.at(-1);if(!node)return;node.textContent=text;};
window.fail=(text='Unable to think',standalone=false)=>{document.querySelector('[data-testid="stop-button"]')?.remove();let target=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1)?.parentElement;if(standalone||!target){target=document.createElement('section');target.dataset.testid='conversation-turn-error-'+crypto.randomUUID();messages.append(target);}target.querySelectorAll('[data-testid="copy-turn-action-button"]').forEach(n=>n.remove());const alert=document.createElement('div');alert.setAttribute('role','alert');alert.textContent=text;target.append(alert);};
window.routeTo=(path)=>{history.pushState({},'',path);messages.replaceChildren();if(path.includes('/c/')){addMessage('user','baseline-'+path,'baseline');addMessage('assistant','answer-'+path,'old response',window.model);finish('old response');}document.getElementById('prompt-textarea').textContent='';};
routeTo(location.pathname);
document.addEventListener('input',()=>{document.getElementById('composer-submit-button').disabled=!document.getElementById('prompt-textarea').innerText.trim();});
document.getElementById('native-form').addEventListener('submit',event=>{event.preventDefault();window.clickCount++;if(window.clickDrops)return;const input=document.getElementById('prompt-textarea');const text=input.innerText;if(!text.trim())return;const id=crypto.randomUUID();window.sent.push({id,text,model:window.model});void fetch('/backend-api/f/conversation',{method:'POST',headers:{'content-type':'application/json'},body:JSON.stringify({action:'next',messages:[{id,author:{role:'user'},content:{content_type:'text',parts:[text]}}],conversation_id:window.conversationId(),model:window.model})}).catch(()=>{});input.textContent='';document.getElementById('composer-submit-button').disabled=true;if(!location.pathname.includes('/c/')){const project=location.pathname.startsWith('/g/')&&location.pathname.endsWith('/project')?location.pathname.split('/')[2]:'';if(project&&window.projectFirstIntermediate){history.pushState({},'','/c/project-first');setTimeout(()=>history.pushState({},'','/g/'+project+'/c/project-first'),1600);}else history.pushState({},'',project?'/g/'+project+'/c/project-first':'/c/home-first');}addMessage('user',id,text);if(window.renderAssistant)addMessage('assistant','answer-'+id,'thinking',window.model);if(!document.querySelector('[data-testid="stop-button"]')){const b=document.createElement('button');b.dataset.testid='stop-button';b.type='button';b.textContent='停止';b.onclick=()=>b.remove();document.getElementById('native-form').append(b);}if(window.autoReply&&window.renderAssistant)setTimeout(()=>window.finish('Done '+id),400);});
</script></body></html>`;
async function serve(context) { await context.route("https://chatgpt.com/**", route => route.fulfill({status:200,contentType:"text/html; charset=utf-8",body:html})); }
module.exports={serve};
