const {test,expect}=require("./fixtures");
const {serve}=require("./chatgpt-fixture");
const host="#chatgpt-message-queue-root";
const button=(page,action)=>page.locator(`${host} [data-action="${action}"]`);
async function enqueue(page,text){await page.locator("#prompt-textarea").fill(text);await button(page,"add").click();try{await expect(page.locator("#prompt-textarea")).toBeEmpty();}catch(error){console.log('enqueue failure',await page.evaluate(()=>{const s=document.getElementById('chatgpt-message-queue-root')?.shadowRoot;return {usage:s?.querySelector('.usage')?.textContent,status:s?.querySelector('.status')?.textContent,notice:s?.querySelector('.notice')?.textContent};}));throw error;}}
async function snapshot(worker){return worker.evaluate(async()=>{const data=await chrome.storage.local.get(null);return {queues:Object.entries(data).filter(([k])=>k.startsWith('notice:conversation:')).map(([key,value])=>({key,...value})),usage:Object.entries(data).filter(([k])=>k.startsWith('notice:usage:')).map(([,v])=>v),notifications:globalThis.testNotifications||[]};});}
test.beforeEach(async({persistentContext,extensionServiceWorker})=>{
  await serve(persistentContext);
  await extensionServiceWorker.evaluate(async()=>{await chrome.storage.local.clear();globalThis.testNotifications=[];const original=chrome.notifications.create.bind(chrome.notifications);chrome.notifications.create=async(id,options)=>{globalThis.testNotifications.push(id);return original(id,options);};});
});
test("MV3 loads and popup lists only pending conversation queues",async({page,extensionServiceWorker,persistentContext,extensionId})=>{
  expect(await extensionServiceWorker.evaluate(()=>chrome.runtime.getManifest().version)).toBe("0.8.0");
  await page.goto("https://chatgpt.com/c/popup");await expect(button(page,"add")).toBeVisible();await enqueue(page,"saved");
  const popup=await persistentContext.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await expect(popup.locator("h1")).toHaveText("ChatGPT Queue");await expect(popup.locator("#queues a")).toHaveCount(1);
});
test("home and project first sends change modes without replacing the UI root",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/");await expect(button(page,"usage")).toBeVisible();await expect(button(page,"queue")).toBeHidden();
  await page.evaluate(()=>window.originalRoot=document.getElementById('chatgpt-message-queue-root'));
  await page.locator("#prompt-textarea").fill("home first");await page.locator("#composer-submit-button").click();
  await expect(page).toHaveURL(/\/c\/home-first/);await expect(button(page,"queue")).toBeVisible();
  await page.evaluate(()=>window.routeTo('/g/g-p-regression/project'));await expect(button(page,"queue")).toBeHidden();
  await page.locator("#prompt-textarea").fill("project first");await page.locator("#composer-submit-button").click();
  await expect(page).toHaveURL(/\/g\/g-p-regression\/c\/project-first/);await expect(button(page,"queue")).toBeVisible();
  expect(await page.evaluate(()=>window.originalRoot===document.getElementById('chatgpt-message-queue-root'))).toBe(true);
  const data=await snapshot(extensionServiceWorker);expect(data.queues.every(q=>!q.key.includes('WEB:'))).toBe(true);
});
test("queues restore on SPA navigation and reload; edit and reorder preserve native drafts",async({page})=>{
  await page.goto("https://chatgpt.com/c/a");await expect(button(page,"add")).toBeVisible();
  await enqueue(page,"first");await enqueue(page,"second");await button(page,"queue").click();
  await button(page,"up").nth(1).click();await expect(page.locator(`${host} .preview`).first()).toHaveText("second");
  await button(page,"edit").first().click();await page.locator(`${host} textarea`).fill("edited second");await button(page,"save-edit").click();
  await page.evaluate(()=>window.routeTo('/g/another/c/b'));await expect(page.locator(`${host} .count`)).toHaveText("0");
  await enqueue(page,"other conversation");await page.evaluate(()=>window.routeTo('/c/a'));await expect(page.locator(`${host} .count`)).toHaveText("2");
  await page.reload();await expect(page.locator(`${host} .count`)).toHaveText("2");await button(page,"queue").click();
  await expect(page.locator(`${host} .preview`).first()).toHaveText("edited second");
  await page.locator("#prompt-textarea").fill("private draft");await button(page,"send").first().click();
  await expect(page.locator("#prompt-textarea")).toHaveText("private draft");expect(await page.evaluate(()=>window.sent.length)).toBe(0);
});
test("native manual completion continues queue and only its final completion notifies",async({page,extensionServiceWorker})=>{
  test.setTimeout(60000);
  await page.goto("https://chatgpt.com/c/sequence");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>window.autoReply=false);await page.locator("#prompt-textarea").fill("manual");await page.locator("#composer-submit-button").click();
  await enqueue(page,"queued one");await enqueue(page,"queued two");
  await page.evaluate(()=>{window.autoReply=true;window.finish('manual finished');});
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:35000}).toBe(3);
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  expect((await snapshot(extensionServiceWorker)).queues[0].items).toHaveLength(0);
  await page.reload();await page.waitForTimeout(4500);expect((await snapshot(extensionServiceWorker)).notifications.length).toBe(1);
});
test("manual native sends still complete when the rendered user turn contains attachment metadata",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/manual-attachment");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>{const original=window.addMessage;window.addMessage=(role,id,text,model)=>original(role,id,role==='user'?`${text}\nattachment.pdf`:text,model);const chip=document.createElement('div');chip.dataset.testid='attachment-preview';document.querySelector('form').append(chip);});
  await page.locator("#prompt-textarea").fill("manual with attachment");await page.locator("#composer-submit-button").click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  expect(await page.evaluate(()=>window.sent.length)).toBe(1);
});
test("draft protection waits without replacing text, then uses native Send",async({page})=>{
  await page.goto("https://chatgpt.com/c/draft");await expect(button(page,"add")).toBeVisible();await enqueue(page,"queued");
  await page.locator("#prompt-textarea").fill("do not touch");await button(page,"queue").click();await button(page,"pause").click();
  await page.waitForTimeout(5500);await expect(page.locator("#prompt-textarea")).toHaveText("do not touch");expect(await page.evaluate(()=>window.sent.length)).toBe(0);
  await page.locator("#prompt-textarea").fill("");await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(1);
  expect(await page.evaluate(()=>window.sent[0].text)).toBe("queued");
});
test("two tabs never claim the same message; ambiguous send is quarantined after reload",async({page,persistentContext,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/multi");await expect(button(page,"add")).toBeVisible();await enqueue(page,"only once");
  const second=await persistentContext.newPage();await second.goto("https://chatgpt.com/c/multi");await expect(button(second,"queue")).toBeVisible();
  await button(page,"queue").click();await button(page,"pause").click();
  await expect.poll(async()=>await page.evaluate(()=>window.sent.length)+await second.evaluate(()=>window.sent.length),{timeout:20000}).toBe(1);
  await page.waitForTimeout(5000);expect(await page.evaluate(()=>window.sent.length)+await second.evaluate(()=>window.sent.length)).toBe(1);
  await second.close();await page.goto("https://chatgpt.com/c/unknown");await expect(button(page,"add")).toBeVisible();
  await enqueue(page,"ambiguous");await page.evaluate(()=>window.clickDrops=true);await button(page,"queue").click();await button(page,"pause").click();
  await expect.poll(()=>page.evaluate(()=>window.clickCount),{timeout:15000}).toBe(1);
  await extensionServiceWorker.evaluate(async()=>{const data=await chrome.storage.local.get(null);for(const [key,q] of Object.entries(data)){if(key.endsWith(':unknown')){q.items[0].expiresAt=Date.now()-1;await chrome.storage.local.set({[key]:q});}}});
  await page.reload();await expect(page.locator(`${host} .count`)).toHaveText("1");await button(page,"queue").click();
  await expect(page.locator(`${host} .state`)).toContainText("未知");await button(page,"pause").click();
  await page.waitForTimeout(5000);expect(await page.evaluate(()=>window.sent.length)).toBe(0);
});
test("streaming and composer replacement keep plugin buttons mounted and clickable",async({page},testInfo)=>{
  await page.goto("https://chatgpt.com/c/performance");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>{window.hostBefore=document.getElementById('chatgpt-message-queue-root');window.buttonBefore=window.hostBefore.shadowRoot.querySelector('[data-action="queue"]');window.mutations=0;window.interval=setInterval(()=>{document.querySelector('[data-message-author-role="assistant"]').textContent='token '+(++window.mutations);},8);});
  await page.locator("#prompt-textarea").pressSequentially("持续输入，Queue 按钮仍可点击。",{delay:40});
  await button(page,"queue").click();await expect(page.locator(`${host} .queue-panel`)).toBeVisible();
  await page.evaluate(()=>{const old=document.getElementById('prompt-textarea');const next=old.cloneNode(true);old.replaceWith(next);});
  await button(page,"close").first().click();await button(page,"queue").click();
  expect(await page.evaluate(()=>window.hostBefore===document.getElementById('chatgpt-message-queue-root')&&window.buttonBefore===window.hostBefore.shadowRoot.querySelector('[data-action="queue"]'))).toBe(true);
  await expect(page.locator("#prompt-textarea")).toHaveText("持续输入，Queue 按钮仍可点击。");
  await page.screenshot({path:testInfo.outputPath('stable-ui.png')});await page.evaluate(()=>clearInterval(window.interval));
});
test("usage counts only observed shared Pro models, allows correction, and does not recount reload",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/");await expect(button(page,"usage")).toBeVisible();await page.evaluate(()=>window.model='gpt-6-pro');
  await page.locator("#prompt-textarea").fill("pro manual");await page.locator("#composer-submit-button").click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0]?.entries.length,{timeout:12000}).toBe(1);
  await page.waitForTimeout(4500);await page.reload();await expect(button(page,"usage")).toContainText("GPT-6 · 1 / 50 · 刷新未知");
  await button(page,"usage").click();await page.locator(`${host} [name="total"]`).fill("12");await page.locator(`${host} [name="cycleDays"]`).fill("3");
  const reset=await page.evaluate(()=>{const d=new Date(Date.now()+2*86400000);d.setSeconds(0,0);const local=new Date(d.getTime()-d.getTimezoneOffset()*60000).toISOString().slice(0,16);return {local,month:String(d.getMonth()+1).padStart(2,'0'),day:String(d.getDate()).padStart(2,'0'),hour:String(d.getHours()).padStart(2,'0'),minute:String(d.getMinutes()).padStart(2,'0')};});
  await page.locator(`${host} [name="resetAt"]`).fill(reset.local);await button(page,"save-usage").click();
  await expect(button(page,"usage")).toContainText(`GPT-6 · 12 / 50 · ${reset.month}-${reset.day} ${reset.hour}:${reset.minute} 刷新`);
  await expect(button(page,"usage")).not.toContainText(/校正|记录|计算|推算/);
  const usage=(await snapshot(extensionServiceWorker)).usage[0];expect(usage.cycleDays).toBe(3);expect(usage.resetAt).toBeGreaterThan(Date.now());
});
test("usage persistence failure never blocks completion notification",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/usage-failure");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.model='gpt-6-pro');
  await extensionServiceWorker.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async values=>{if(Object.keys(values).some(k=>k.startsWith('notice:usage:')))throw new Error('simulated usage storage failure');return original(values);};});
  await page.locator("#prompt-textarea").fill("completion must still work");await page.locator("#composer-submit-button").click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  expect(await page.evaluate(()=>window.sent.length)).toBe(1);
});
test("transient WEB route keeps usage and first-send notification without allocating a temporary queue",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/");await expect(button(page,"usage")).toBeVisible();
  await page.evaluate(()=>{window.rootBefore=document.getElementById('chatgpt-message-queue-root');document.getElementById('native-form').addEventListener('submit',()=>{history.replaceState({},'','/c/WEB:transient');setTimeout(()=>history.replaceState({},'','/c/home-first'),1800);});});
  await page.locator('#prompt-textarea').fill('through temporary route');await page.locator('#composer-submit-button').click();
  await expect(page).toHaveURL(/WEB:transient/);await expect(button(page,'queue')).toBeHidden();await expect(button(page,'usage')).toBeVisible();
  await expect(page).toHaveURL(/\/c\/home-first/);await expect(button(page,'queue')).toBeVisible();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:12000}).toBe(1);
  expect((await snapshot(extensionServiceWorker)).queues.some(q=>q.key.includes('WEB:'))).toBe(false);
  expect(await page.evaluate(()=>window.rootBefore===document.getElementById('chatgpt-message-queue-root'))).toBe(true);
});
test("enqueue storage delay preserves a newer native draft without saving it twice",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/delayed");await expect(button(page,'add')).toBeVisible();
  await extensionServiceWorker.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async values=>{if(Object.values(values).some(v=>v?.items?.length))await new Promise(r=>setTimeout(r,900));return original(values);};});
  await page.locator('#prompt-textarea').fill('original queued text');await button(page,'add').click();
  await page.locator('#prompt-textarea').fill('newer draft must survive');
  await expect(page.locator(`${host} .count`)).toHaveText('1');await expect(page.locator('#prompt-textarea')).toHaveText('newer draft must survive');
  expect((await snapshot(extensionServiceWorker)).queues[0].items[0].text).toBe('original queued text');
});
test("attachments and unavailable Send fail closed without a click",async({page})=>{
  await page.goto("https://chatgpt.com/c/attachments");await expect(button(page,'add')).toBeVisible();await enqueue(page,'queued safely');
  await page.evaluate(()=>{const attachment=document.createElement('div');attachment.dataset.testid='file-preview';document.querySelector('form').append(attachment);});
  await expect(button(page,'add')).toBeDisabled();await expect(page.locator(`${host} .status`)).toContainText(/图片|附件/);
  await button(page,'queue').click();await button(page,'pause').click();await page.waitForTimeout(4500);
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
  await page.evaluate(()=>{document.querySelector('[data-testid="file-preview"]').remove();document.addEventListener('input',()=>document.getElementById('composer-submit-button').disabled=true);});
  await expect(page.locator('#prompt-textarea')).toHaveText('queued safely',{timeout:12000});
  await expect(page.locator(`${host} .status`)).toContainText(/草稿|停止|暂停/,{timeout:6000});
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
});
test("usage panel stays inside a narrow viewport",async({page})=>{
  await page.setViewportSize({width:420,height:740});await page.goto('https://chatgpt.com/');
  await page.evaluate(()=>{const form=document.querySelector('form');form.style.left='12px';form.style.width='396px';form.style.top='280px';form.style.bottom='auto';});
  await expect(button(page,'usage')).toBeVisible();await button(page,'usage').click();
  const box=await page.locator(`${host} .usage-panel`).boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(421);
});
test("native composer popovers hide overlapping extension chrome and restore it on close",async({page})=>{
  await page.goto('https://chatgpt.com/c/native-popover');await expect(button(page,'queue')).toBeVisible();
  const box=await page.locator(host).boundingBox();
  await page.evaluate(({x,y,width,height})=>{const stack=document.createElement('div');stack.id='native-stack';stack.style.cssText='position:fixed;inset:0;z-index:0;pointer-events:none';const overlay=document.createElement('div');overlay.id='native-popover';overlay.className='popover';overlay.style.cssText=`position:fixed;z-index:50;left:${x}px;top:${y}px;width:${width}px;height:${height}px;background:#fff;pointer-events:auto`;stack.append(overlay);document.body.append(stack);document.dispatchEvent(new MouseEvent('click',{bubbles:true}));},box);
  await expect(page.locator(host)).toHaveAttribute('data-native-overlay','');await expect(button(page,'queue')).toBeHidden();
  await page.evaluate(()=>{document.getElementById('native-stack')?.remove();document.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}));});
  await expect(page.locator(host)).not.toHaveAttribute('data-native-overlay','');await expect(button(page,'queue')).toBeVisible();
});
test("stale content script after extension reload asks for a page refresh instead of throwing sendMessage TypeError",async({page,extensionServiceWorker})=>{
  test.setTimeout(30000);
  await page.goto('https://chatgpt.com/c/reload-required');await expect(button(page,'add')).toBeVisible();await enqueue(page,'saved before extension reload');
  await button(page,'queue').click();await expect(page.locator(`${host} .queue-panel`)).toBeVisible();
  await extensionServiceWorker.evaluate(()=>chrome.runtime.reload());
  await page.waitForTimeout(500);
  await button(page,'remove').click();
  await expect(page.locator(`${host} .notice`)).toContainText('扩展已更新，请刷新当前页面后再操作');
  await expect(page.locator(`${host} .count`)).toHaveText('1');
});
test("native Send preempting the queue click cannot return a delivered item to pending",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/preempt');await expect(button(page,'add')).toBeVisible();await enqueue(page,'preempted queue text');
  await page.evaluate(()=>{let used=false;document.addEventListener('input',()=>{if(!used&&document.getElementById('prompt-textarea').innerText==='preempted queue text'){used=true;setTimeout(()=>document.getElementById('composer-submit-button').click(),0);}});});
  await button(page,'queue').click();await button(page,'pause').click();
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(1);
  await expect(page.locator(`${host} .count`)).toHaveText('0',{timeout:10000});
  expect((await snapshot(extensionServiceWorker)).queues[0].receipts).toHaveLength(1);
  await page.waitForTimeout(6000);expect(await page.evaluate(()=>window.sent.length)).toBe(1);
});
test("attachments added during enqueue persistence preserve the associated native text",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/attach-race');await expect(button(page,'add')).toBeVisible();
  await extensionServiceWorker.evaluate(()=>{const original=chrome.storage.local.set.bind(chrome.storage.local);chrome.storage.local.set=async values=>{if(Object.values(values).some(v=>v?.items?.length))await new Promise(r=>setTimeout(r,900));return original(values);};});
  await page.locator('#prompt-textarea').fill('text associated with attachment');await button(page,'add').click();
  await page.evaluate(()=>{const node=document.createElement('div');node.dataset.testid='attachment-preview';document.querySelector('form').append(node);});
  await expect(page.locator(`${host} .count`)).toHaveText('1');await expect(page.locator('#prompt-textarea')).toHaveText('text associated with attachment');
});
test("regeneration counts and notifies independently without duplicate observations",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/regenerate');await expect(button(page,'add')).toBeVisible();await page.evaluate(()=>window.model='gpt-6-pro');
  await page.locator('#prompt-textarea').fill('first response');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  await page.evaluate(()=>{const retry=document.createElement('button');retry.textContent='Retry';retry.id='native-retry';retry.onclick=()=>{const id=crypto.randomUUID();addMessage('assistant',id,'regenerating',window.model);const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='停止';document.querySelector('form').append(stop);setTimeout(()=>window.finish('regenerated'),400);};document.querySelector('main').append(retry);});
  await page.locator('#native-retry').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(2);
  expect((await snapshot(extensionServiceWorker)).usage[0].entries).toHaveLength(2);
  await page.waitForTimeout(3000);expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(2);
});
test("an old error and a stopped previous reply do not poison a successful follow-up",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/old-error');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{const error=document.createElement('div');error.setAttribute('role','alert');error.textContent='Historical error: request failed';document.querySelector('[data-message-author-role="assistant"]').parentElement.append(error);window.autoReply=false;});
  await page.locator('#prompt-textarea').fill('will stop');await page.locator('#composer-submit-button').click();await page.waitForTimeout(1100);
  await page.locator('[data-testid="stop-button"]').click();await page.evaluate(()=>window.autoReply=true);
  await page.locator('#prompt-textarea').fill('successful follow up');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  expect((await snapshot(extensionServiceWorker)).queues[0].paused).toBe(false);
});
test("a large historical transcript keeps tail detection and button identity stable",async({page})=>{
  await page.goto('https://chatgpt.com/c/large');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{window.originalQueueButton=document.getElementById('chatgpt-message-queue-root').shadowRoot.querySelector('[data-action="queue"]');const fragment=document.createDocumentFragment();for(let i=0;i<1500;i++){const turn=document.createElement('section');turn.dataset.testid='conversation-turn-history-'+i;const message=document.createElement('div');message.dataset.messageAuthorRole=i%2?'assistant':'user';message.dataset.messageId='history-'+i;message.textContent='historical text '.repeat(20);turn.append(message);fragment.append(turn);}document.getElementById('messages').prepend(fragment);});
  await enqueue(page,'tail still works');await button(page,'queue').click();await expect(page.locator(`${host} .preview`)).toHaveText('tail still works');
  expect(await page.evaluate(()=>window.originalQueueButton===document.getElementById('chatgpt-message-queue-root').shadowRoot.querySelector('[data-action="queue"]'))).toBe(true);
});
