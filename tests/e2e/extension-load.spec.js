const {test,expect}=require("./fixtures");
const {serve}=require("./chatgpt-fixture");
const host="#chatgpt-message-queue-root";
const button=(page,action)=>page.locator(`${host} [data-action="${action}"]${action === "close" ? ":visible" : ""}`);
async function enqueue(page,text){await page.locator("#prompt-textarea").fill(text);await button(page,"add").click();try{await expect(page.locator("#prompt-textarea")).toBeEmpty();}catch(error){console.log('enqueue failure',await page.evaluate(()=>{const s=document.getElementById('chatgpt-message-queue-root')?.shadowRoot;return {usage:s?.querySelector('.usage')?.textContent,status:s?.querySelector('.status')?.textContent,notice:s?.querySelector('.notice')?.textContent};}));throw error;}}
async function snapshot(worker){return worker.evaluate(async()=>{const data=await chrome.storage.local.get(null);return {queues:Object.entries(data).filter(([k])=>k.startsWith('notice:conversation:')).map(([key,value])=>({key,...value})),usage:Object.entries(data).filter(([k])=>k.startsWith('notice:usage:')).map(([,v])=>v),notifications:globalThis.testNotifications||[]};});}
test.beforeEach(async({persistentContext,extensionServiceWorker})=>{
  await serve(persistentContext);
  await extensionServiceWorker.evaluate(async()=>{await chrome.storage.local.clear();globalThis.testNotifications=[];const original=chrome.notifications.create.bind(chrome.notifications);chrome.notifications.create=async(id,options)=>{globalThis.testNotifications.push(id);return original(id,options);};});
});
test("MV3 loads and popup lists only pending conversation queues",async({page,extensionServiceWorker,persistentContext,extensionId})=>{
  expect(await extensionServiceWorker.evaluate(()=>chrome.runtime.getManifest().version)).toBe("0.8.1");
  expect(await extensionServiceWorker.evaluate(()=>chrome.runtime.getManifest().permissions)).toEqual(["notifications","storage","webRequest","declarativeNetRequest"]);
  await page.goto("https://chatgpt.com/c/popup");await expect(button(page,"add")).toBeVisible();await button(page,"queue").click();await button(page,"pause").click();await button(page,"close").first().click();await enqueue(page,"saved");
  const popup=await persistentContext.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  await page.bringToFront();await popup.reload();
  await expect(popup.locator("h1")).toHaveText("gpt-notice");await expect(popup.locator("#permission")).toContainText("浏览器已允许");await expect(popup.locator("#queues a")).toHaveCount(1);
});
test("popup exposes independent sidebar-collapse, Queue, and notification switches",async({page,persistentContext,extensionServiceWorker,extensionId})=>{
  await page.goto("https://chatgpt.com/c/settings");await expect(button(page,"add")).toBeVisible();
  await button(page,"queue").click();await button(page,"pause").click();await button(page,"close").first().click();await enqueue(page,"saved while Queue is later disabled");
  const popup=await persistentContext.newPage();await popup.goto(`chrome-extension://${extensionId}/popup.html`);
  for(const id of ["sidebarCollapse","queue","notifications"])await expect(popup.locator(`#${id}`)).toBeChecked();

  await popup.locator('label.setting:has(#queue)').click();
  await expect(button(page,"queue")).toBeHidden();await expect(button(page,"add")).toBeHidden();
  expect((await snapshot(extensionServiceWorker)).queues[0].items[0].text).toBe("saved while Queue is later disabled");
  await page.evaluate(()=>window.routeTo('/c/notify-with-queue-off'));
  await page.waitForTimeout(1500);
  await page.locator('#prompt-textarea').fill('notification remains independent');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  await popup.locator('label.setting:has(#queue)').click();await expect(button(page,"queue")).toBeVisible();

  await popup.locator('label.setting:has(#sidebarCollapse)').click();
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>(await chrome.storage.local.get("notice:sidebar-collapse-enabled"))["notice:sidebar-collapse-enabled"])).toBe(false);
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>await chrome.declarativeNetRequest.getDynamicRules())).toEqual([]);
  await popup.locator('label.setting:has(#sidebarCollapse)').click();
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>(await chrome.storage.local.get("notice:sidebar-collapse-enabled"))["notice:sidebar-collapse-enabled"])).toBe(true);

  await popup.locator('label.setting:has(#notifications)').click();
  await expect.poll(()=>extensionServiceWorker.evaluate(async()=>(await chrome.storage.local.get("notice:notifications"))["notice:notifications"])).toBe(false);
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
test("new-chat sections start collapsed without hiding the sidebar or blocking native lists",async({page})=>{
  test.setTimeout(25000);
  await page.goto("https://chatgpt.com/?history-poc=1");
  await expect(page.locator('#native-sidebar-toggle')).toHaveAttribute('aria-expanded','true');
  for(const section of ['favorites','projects','chats']) await expect(page.locator(`[data-section="${section}"]`)).toHaveAttribute('aria-expanded','false');
  await expect.poll(()=>page.evaluate(()=>window.historyListResults?.[0]||""),{timeout:5000}).toBe("initial:allowed");

  await page.locator('[data-section="projects"]').click();
  await expect(page.locator('[data-section="projects"]')).toHaveAttribute('aria-expanded','true');
  await expect.poll(()=>page.evaluate(()=>window.historyListResults?.includes("late:allowed")||false),{timeout:12000}).toBe(true);
  await expect(page.locator('[data-section="projects"]')).toHaveAttribute('aria-expanded','true');
});
test("queues restore on SPA navigation and reload; edit and reorder preserve native drafts",async({page})=>{
  await page.goto("https://chatgpt.com/c/a");await expect(button(page,"add")).toBeVisible();
  await button(page,"queue").click();await button(page,"pause").click();await button(page,"close").first().click();
  await enqueue(page,"first");await enqueue(page,"second");await button(page,"queue").click();
  await button(page,"up").nth(1).click();await expect(page.locator(`${host} .preview`).first()).toHaveText("second");
  await button(page,"edit").first().click();await page.locator(`${host} textarea`).fill("edited second");await button(page,"save-edit").click();
  await page.evaluate(()=>window.routeTo('/g/another/c/b'));await expect(page.locator(`${host} .count`)).toHaveText("0");
  await enqueue(page,"other conversation");await page.evaluate(()=>window.routeTo('/c/a'));await expect(page.locator(`${host} .count`)).toHaveText("2");
  await page.reload();await expect(page.locator(`${host} .count`)).toHaveText("2");await button(page,"queue").click();
  await expect(page.locator(`${host} .preview`).first()).toHaveText("edited second");
  await page.locator("#prompt-textarea").fill("private draft");await expect(button(page,"send").first()).toBeDisabled();
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
test("unavailable network probe stays silent until DOM semantic completion",async({page,extensionServiceWorker})=>{
  test.setTimeout(30000);
  await page.route("https://chatgpt.com/backend-api/f/conversation",async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.fulfill({status:200,contentType:"text/event-stream",body:"data: [DONE]\n\n"});});
  await page.goto("https://chatgpt.com/c/background-network");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>{window.autoReply=false;window.model="gpt-5-6-thinking";});
  await page.locator("#prompt-textarea").fill("fixture background notification");await page.locator("#composer-submit-button").click();
  await extensionServiceWorker.evaluate(()=>{const originalGet=chrome.tabs.get.bind(chrome.tabs),originalSend=chrome.tabs.sendMessage.bind(chrome.tabs);globalThis.__restoreFrozenProbe=()=>{chrome.tabs.get=originalGet;chrome.tabs.sendMessage=originalSend;delete globalThis.__restoreFrozenProbe;};chrome.tabs.get=async id=>({...await originalGet(id),frozen:true});chrome.tabs.sendMessage=(id,message,options)=>message?.type==="NOTICE_COMPLETION_PROBE"?new Promise(()=>{}):originalSend(id,message,options);});
  await page.waitForTimeout(2500);
  expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(0);
  await expect.poll(async()=>Boolean((await snapshot(extensionServiceWorker)).queues[0]?.turn),{timeout:3000}).toBe(true);
  let state=await snapshot(extensionServiceWorker);expect(state.queues[0].turn.done).toBe(false);
  await extensionServiceWorker.evaluate(()=>globalThis.__restoreFrozenProbe?.());
  await page.evaluate(()=>window.finish("final background fixture reply"));
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0].turn.done,{timeout:10000}).toBe(true);
  await page.waitForTimeout(500);
  state=await snapshot(extensionServiceWorker);expect(state.notifications).toHaveLength(1);
  const completed=await extensionServiceWorker.evaluate(async()=>Object.values(await chrome.storage.local.get(null)).find(value=>value?.kind==="completed"));
  expect(completed).toBeTruthy();
});
test("switching tabs never turns a still-running reply into a completion notice",async({page,persistentContext,extensionServiceWorker})=>{
  test.setTimeout(30000);
  await page.route("https://chatgpt.com/backend-api/f/conversation",async route=>{await new Promise(resolve=>setTimeout(resolve,1500));await route.fulfill({status:200,contentType:"text/event-stream",body:"data: [DONE]\n\n"});});
  await page.goto("https://chatgpt.com/c/background-running");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>{window.autoReply=false;window.model="gpt-5-6-thinking";});
  await page.locator("#prompt-textarea").fill("keep running after tab switch");await page.locator("#composer-submit-button").click();
  const foreground=await persistentContext.newPage();await foreground.goto("https://chatgpt.com/c/foreground-holder");await foreground.bringToFront();
  await page.waitForTimeout(2500);
  expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(0);
  await expect(page.locator('[data-testid="stop-button"]')).toHaveCount(1);
  await page.evaluate(()=>window.finish("completed after background wait"));
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:10000}).toBe(1);
  await foreground.close();
});
test("transport completion without native final controls never releases Queue",async({page,persistentContext,extensionServiceWorker})=>{
  test.setTimeout(40000);
  await page.route("https://chatgpt.com/backend-api/f/conversation",async route=>{await new Promise(r=>setTimeout(r,1500));await route.fulfill({status:200,contentType:"text/event-stream",body:"data: [DONE]\n\n"});});
  await page.goto("https://chatgpt.com/c/background-queue");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("manual background turn");await page.locator("#composer-submit-button").click();await enqueue(page,"queued after semantic completion");
  const foreground=await persistentContext.newPage();await foreground.goto("https://chatgpt.com/c/foreground-holder");await foreground.bringToFront();
  await page.evaluate(()=>window.finishWithoutActions("intermediate segment without final controls"));await page.waitForTimeout(6000);
  expect(await page.evaluate(()=>window.sent.length)).toBe(1);expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(0);
  expect((await snapshot(extensionServiceWorker)).queues.find(q=>q.key.endsWith(':background-queue')).turn.done).toBe(false);
  await page.evaluate(()=>{window.autoReply=true;window.finish("semantically complete");});
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(2);
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);await foreground.close();
});

test("Unable to think in an error-only native turn continues existing Queue without retrying the failed message",async({page,extensionServiceWorker})=>{
  test.setTimeout(35000);
  await page.goto("https://chatgpt.com/c/recoverable-error");await expect(button(page,"add")).toBeVisible();
  await page.evaluate(()=>{window.autoReply=false;window.renderAssistant=false;});
  await page.locator("#prompt-textarea").fill("original request");await page.locator("#composer-submit-button").click();await enqueue(page,"different queued task");
  await page.evaluate(()=>{window.fail("无法思考",true);window.autoReply=true;window.renderAssistant=true;});
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:18000}).toBe(2);
  expect(await page.evaluate(()=>window.sent.map(s=>s.text))).toEqual(["original request","different queued task"]);
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0].turn.outcome,{timeout:12000}).toBe("completed");
  expect((await snapshot(extensionServiceWorker)).queues[0].paused).toBe(false);
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length).toBe(1);
});

for(const [name,error] of [["quota","Network error: usage limit reached"],["policy","Policy restriction"],["unknown-error","Unrecognized service failed"]]) {
  test(`${name} pauses pending work and remains blocked after pressing Continue`,async({page,extensionServiceWorker})=>{
    await page.goto(`https://chatgpt.com/c/${name}`);await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
    await page.locator("#prompt-textarea").fill("original");await page.locator("#composer-submit-button").click();await enqueue(page,"must not send");
    await page.evaluate(text=>window.fail(text),error);
    await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0].paused,{timeout:10000}).toBe(true);
    await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length).toBe(1);
    await button(page,"queue").click();await button(page,"pause").click();await page.waitForTimeout(5000);
    expect(await page.evaluate(()=>window.sent.length)).toBe(1);expect((await snapshot(extensionServiceWorker)).queues[0].items).toHaveLength(1);
    await expect(page.locator(`${host} .status`)).toContainText("原生页面仍有阻塞或异常提示");
  });
}

test("manual Stop with leftover completion controls neither sends Queue nor announces success",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/explicit-stop");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("stop me");await page.locator("#composer-submit-button").click();await enqueue(page,"must remain queued");
  await page.locator('[data-testid="stop-button"]').click();await page.evaluate(()=>window.finish("partial answer left after stop"));
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0].turn.outcome,{timeout:10000}).toBe("stopped");
  await page.waitForTimeout(4500);expect(await page.evaluate(()=>window.sent.length)).toBe(1);
  expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(0);
});
test("Stop immediately followed by a manual message preserves Queue pause intent",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/fast-stop");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("stop first");await page.locator("#composer-submit-button").click();await enqueue(page,"remain queued");
  await page.locator('[data-testid="stop-button"]').click();
  await page.locator("#prompt-textarea").fill("manual follow-up");await page.locator("#composer-submit-button").click();await page.evaluate(()=>window.finish("manual completion"));
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0]?.turn?.outcome,{timeout:12000}).toBe("completed");
  await page.waitForTimeout(4500);expect(await page.evaluate(()=>window.sent.length)).toBe(2);
  const q=(await snapshot(extensionServiceWorker)).queues[0];expect(q.paused).toBe(true);expect(q.pauseCause).toBe("user");expect(q.items[0].text).toBe("remain queued");
});

test("native approval stays nonterminal and notifies once without auto-approving",async({page,extensionServiceWorker})=>{
  test.setTimeout(35000);
  await page.goto("https://chatgpt.com/c/approval");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("requires approval");await page.locator("#composer-submit-button").click();await enqueue(page,"next after real completion");
  await page.evaluate(()=>{window.approvalClicks=0;const b=document.createElement('button');b.id='native-approval';b.textContent='Allow once';b.onclick=()=>window.approvalClicks++;document.querySelectorAll('[data-message-author-role="assistant"]').item(1).parentElement.append(b);});
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:10000}).toBe(1);
  await page.waitForTimeout(3500);expect(await page.evaluate(()=>window.approvalClicks)).toBe(0);expect(await page.evaluate(()=>window.sent.length)).toBe(1);
  expect((await snapshot(extensionServiceWorker)).queues[0].turn.done).toBe(false);
  await page.evaluate(()=>{document.getElementById('native-approval').remove();window.autoReply=true;window.finish('approved and genuinely completed');});
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(2);
});

test("consecutive recoverable failures pause before draining the rest of Queue",async({page,extensionServiceWorker})=>{
  test.setTimeout(35000);
  await page.goto("https://chatgpt.com/c/error-streak");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("first");await page.locator("#composer-submit-button").click();await enqueue(page,"one permitted follow-up");await enqueue(page,"keep this queued");
  await page.evaluate(()=>window.fail("Unable to think"));await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:18000}).toBe(2);
  await page.evaluate(()=>window.fail("Network error"));await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0].paused,{timeout:10000}).toBe(true);
  await page.waitForTimeout(4500);expect(await page.evaluate(()=>window.sent.length)).toBe(2);
  const q=(await snapshot(extensionServiceWorker)).queues[0];expect(q.items[0].text).toBe("keep this queued");expect(q.failureStreak).toBe(2);
});

test("error and quota words inside assistant prose never control Queue",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/prose");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.autoReply=false);
  await page.locator("#prompt-textarea").fill("explain failures");await page.locator("#composer-submit-button").click();
  await page.evaluate(()=>{window.finish('normal prose');const a=[...document.querySelectorAll('[data-message-author-role="assistant"]')].at(-1);a.innerHTML='<div class="markdown"><div role="alert">Unable to think; quota exceeded; policy; error</div></div>';});
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0]?.turn?.outcome,{timeout:12000}).toBe("completed");
  expect((await snapshot(extensionServiceWorker)).queues[0].paused).toBe(false);
});
test("draft protection waits without replacing text, then uses native Send",async({page})=>{
  await page.goto("https://chatgpt.com/c/draft");await expect(button(page,"add")).toBeVisible();await enqueue(page,"queued");
  await page.locator("#prompt-textarea").fill("do not touch");
  await page.waitForTimeout(5500);await expect(page.locator("#prompt-textarea")).toHaveText("do not touch");expect(await page.evaluate(()=>window.sent.length)).toBe(0);
  await page.locator("#prompt-textarea").fill("");await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(1);
  expect(await page.evaluate(()=>window.sent[0].text)).toBe("queued");
});
test("idle queued messages auto-run without requiring Continue",async({page,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/idle-auto");await expect(button(page,"add")).toBeVisible();await page.evaluate(()=>window.model='gpt-6-pro');await enqueue(page,"auto queued");
  await expect.poll(async()=>Boolean((await snapshot(extensionServiceWorker)).queues[0]?.paused),{timeout:3000}).toBe(false);
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:15000}).toBe(1);
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0]?.entries.length,{timeout:5000}).toBe(1);
  expect(await page.evaluate(()=>window.sent[0].text)).toBe("auto queued");
  await expect(page.locator(`${host} .count`)).toHaveText("0",{timeout:10000});
});
test("two tabs never claim the same message; ambiguous send is quarantined after reload",async({page,persistentContext,extensionServiceWorker})=>{
  await page.goto("https://chatgpt.com/c/multi");await expect(button(page,"add")).toBeVisible();await button(page,"queue").click();await button(page,"pause").click();await button(page,"close").first().click();await enqueue(page,"only once");
  const second=await persistentContext.newPage();await second.goto("https://chatgpt.com/c/multi");await expect(button(second,"queue")).toBeVisible();
  await button(page,"queue").click();await button(page,"pause").click();
  await expect.poll(async()=>await page.evaluate(()=>window.sent.length)+await second.evaluate(()=>window.sent.length),{timeout:20000}).toBe(1);
  await page.waitForTimeout(5000);expect(await page.evaluate(()=>window.sent.length)+await second.evaluate(()=>window.sent.length)).toBe(1);
  await second.close();await page.goto("https://chatgpt.com/c/unknown");await expect(button(page,"add")).toBeVisible();
  await button(page,"queue").click();await button(page,"pause").click();await button(page,"close").first().click();await enqueue(page,"ambiguous");await page.evaluate(()=>window.clickDrops=true);await button(page,"queue").click();await button(page,"pause").click();
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
  await page.goto("https://chatgpt.com/");await expect(button(page,"usage")).toBeVisible();await page.evaluate(()=>{window.model='gpt-6-pro';window.autoReply=false;});
  await page.locator("#prompt-textarea").fill("pro manual");await page.locator("#composer-submit-button").click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0]?.entries.length,{timeout:12000}).toBe(1);
  await expect(button(page,"usage")).toContainText("GPT-6 · 1 / 50");
  expect(await page.locator('button[data-testid="copy-turn-action-button"]').count()).toBe(0);
  await page.evaluate(()=>window.finish('manual pro finished'));
  await page.waitForTimeout(4500);await page.reload();await expect(button(page,"usage")).toContainText("GPT-6 · 1 / 50 · 刷新未知");
  await button(page,"usage").click();await button(page,"usage-settings").click();await page.locator(`${host} [name="total"]`).fill("12");await page.locator(`${host} [name="cycleDays"]`).fill("3");
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
  await page.goto("https://chatgpt.com/c/attachments");await expect(button(page,'add')).toBeVisible();await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'queued safely');
  await page.evaluate(()=>{const attachment=document.createElement('div');attachment.dataset.testid='file-preview';document.querySelector('form').append(attachment);});
  await expect(button(page,'add')).toBeDisabled();await expect(page.locator(`${host} .status`)).toContainText(/图片|附件/);
  await button(page,'queue').click();await button(page,'pause').click();await page.waitForTimeout(4500);
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
  await page.evaluate(()=>{document.querySelector('[data-testid="file-preview"]').remove();document.addEventListener('input',()=>document.getElementById('composer-submit-button').disabled=true);});
  await expect(page.locator('#prompt-textarea')).toHaveText('queued safely',{timeout:12000});
  await expect(page.locator(`${host} .status`)).toContainText(/草稿|停止|暂停/,{timeout:6000});
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
});
test("usage popover stays anchored inside a narrow viewport",async({page})=>{
  await page.setViewportSize({width:420,height:740});await page.goto('https://chatgpt.com/');
  await page.evaluate(()=>{const form=document.querySelector('form');form.style.left='12px';form.style.width='396px';form.style.top='280px';form.style.bottom='auto';});
  await expect(button(page,'usage')).toBeVisible();await button(page,'usage').click();
  const box=await page.locator(`${host} .usage-popover`).boundingBox();expect(box.y).toBeGreaterThanOrEqual(0);expect(box.x).toBeGreaterThanOrEqual(0);expect(box.x+box.width).toBeLessThanOrEqual(421);
  await button(page,'usage-settings').click();const dialog=await page.locator(`${host} .usage-settings`).boundingBox();expect(dialog.x).toBeGreaterThanOrEqual(0);expect(dialog.y).toBeGreaterThanOrEqual(0);expect(dialog.x+dialog.width).toBeLessThanOrEqual(421);expect(dialog.y+dialog.height).toBeLessThanOrEqual(741);
});
test("home usage-only toolbar stays compact and aligns with the composer left edge",async({page})=>{
  await page.goto('https://chatgpt.com/');await expect(button(page,'usage')).toBeVisible();
  const home=await page.locator(host).evaluate(node=>{const bar=node.shadowRoot.querySelector('.bar'),h=node.getBoundingClientRect(),b=bar.getBoundingClientRect();return{mode:node.dataset.mode,host:h.width,width:b.width,left:b.left-h.left};});
  expect(home.mode).toBe('usage');expect(home.width).toBeLessThan(home.host*.7);expect(Math.abs(home.left)).toBeLessThan(2);
});
test("conversation toolbar stays compact and aligns with the composer right edge",async({page})=>{
  await page.goto('https://chatgpt.com/c/toolbar-compact');await expect(button(page,'queue')).toBeVisible();
  const conversation=await page.locator(host).evaluate(node=>{const bar=node.shadowRoot.querySelector('.bar'),h=node.getBoundingClientRect(),b=bar.getBoundingClientRect();return{mode:node.dataset.mode,host:h.width,width:b.width,right:h.right-b.right,count:node.shadowRoot.querySelector('.count').textContent};});
  expect(conversation.mode).toBe('conversation');expect(conversation.width).toBeLessThan(conversation.host*.8);expect(Math.abs(conversation.right)).toBeLessThan(2);expect(conversation.count).toBe('0');
});
test("status notice follows the compact toolbar instead of the composer left edge",async({page})=>{
  await page.goto('https://chatgpt.com/');await expect(button(page,'usage')).toBeVisible();
  const usage=await page.locator(host).evaluate(node=>{const s=node.shadowRoot,notice=s.querySelector('.notice'),bar=s.querySelector('.bar');notice.textContent='扩展已更新，请刷新当前页面后再操作';notice.hidden=false;const n=notice.getBoundingClientRect(),b=bar.getBoundingClientRect();return{left:n.left-b.left};});
  expect(Math.abs(usage.left)).toBeLessThan(2);
  await page.evaluate(()=>window.routeTo('/c/notice-position'));await expect(button(page,'queue')).toBeVisible();
  const conversation=await page.locator(host).evaluate(node=>{const s=node.shadowRoot,notice=s.querySelector('.notice'),bar=s.querySelector('.bar');notice.textContent='扩展已更新，请刷新当前页面后再操作';notice.hidden=false;const n=notice.getBoundingClientRect(),b=bar.getBoundingClientRect();return{right:b.right-n.right};});
  expect(Math.abs(conversation.right)).toBeLessThan(2);
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
  await page.goto('https://chatgpt.com/c/reload-required');await expect(button(page,'add')).toBeVisible();await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'saved before extension reload');
  await button(page,'queue').click();await expect(page.locator(`${host} .queue-panel`)).toBeVisible();
  await page.locator('#prompt-textarea').fill('draft survives extension reload');
  await page.evaluate(()=>{const chip=document.createElement('button');chip.type='button';chip.id='reload-attachment';chip.setAttribute('aria-label','删除图片');chip.textContent='image';document.querySelector('form').append(chip);});
  await extensionServiceWorker.evaluate(()=>chrome.runtime.reload());
  await page.waitForTimeout(1500);
  await expect(button(page,'remove')).toBeDisabled();
  await expect(page.locator(`${host} .notice`)).toContainText('扩展已更新，请刷新当前页面后再操作');
  await expect(page.locator(`${host} .count`)).toHaveText('1');
  await expect(page.locator('#prompt-textarea')).toHaveText('draft survives extension reload');
  await expect(page.locator('#reload-attachment')).toBeVisible();
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
});
test("native Send preempting the queue click cannot return a delivered item to pending",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/preempt');await expect(button(page,'add')).toBeVisible();await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'preempted queue text');
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
test("a legacy false-concurrency pause recovers on a single conversation tab and continues the queue",async({page,extensionServiceWorker})=>{
  test.setTimeout(30000);
  await page.goto('https://chatgpt.com/c/recover-conflict');await expect(button(page,'add')).toBeVisible();
  await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues.length,{timeout:5000}).toBe(1);
  await extensionServiceWorker.evaluate(async()=>{const all=await chrome.storage.local.get(null);const [key,q]=Object.entries(all).find(([k])=>k.startsWith('notice:conversation:')&&k.endsWith(':recover-conflict'));delete q.pauseCause;q.paused=true;q.reason='检测到同一对话存在并发生成；Queue 已暂停，请确认对话后继续';q.holdUntil=Date.now();q.turn={id:'stale-user',userId:'stale-user',at:Date.now()-5000,done:false};q.items=[{id:'recover-item',text:'recover queued',state:'pending',createdAt:Date.now()}];await chrome.storage.local.set({[key]:q});});
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).queues[0]?.paused,{timeout:12000}).toBe(false);
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:20000}).toBe(1);
  expect(await page.evaluate(()=>window.sent[0].text)).toBe('recover queued');
});
test("regeneration notifies independently but never invents another native user usage ID",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/regenerate');await expect(button(page,'add')).toBeVisible();await page.evaluate(()=>window.model='gpt-6-pro');
  await page.locator('#prompt-textarea').fill('first response');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  await page.evaluate(()=>{const retry=document.createElement('button');retry.textContent='Retry';retry.id='native-retry';retry.onclick=()=>{const id=crypto.randomUUID();addMessage('assistant',id,'regenerating',window.model);const stop=document.createElement('button');stop.dataset.testid='stop-button';stop.textContent='停止';document.querySelector('form').append(stop);setTimeout(()=>window.finish('regenerated'),400);};document.querySelector('main').append(retry);});
  await page.locator('#native-retry').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(2);
  expect((await snapshot(extensionServiceWorker)).usage[0].entries).toHaveLength(1);
  await page.waitForTimeout(3000);expect((await snapshot(extensionServiceWorker)).notifications).toHaveLength(2);
});
test("historical errors do not poison a successful manual follow-up, while Stop pause survives",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/old-error');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{const error=document.createElement('div');error.setAttribute('role','alert');error.textContent='Historical error: request failed';document.querySelector('[data-message-author-role="assistant"]').parentElement.append(error);window.autoReply=false;});
  await page.locator('#prompt-textarea').fill('will stop');await page.locator('#composer-submit-button').click();await page.waitForTimeout(1100);
  await page.locator('[data-testid="stop-button"]').click();await page.evaluate(()=>window.autoReply=true);
  await page.locator('#prompt-textarea').fill('successful follow up');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).notifications.length,{timeout:15000}).toBe(1);
  const q=(await snapshot(extensionServiceWorker)).queues[0];
  expect(q.turn.outcome).toBe("completed");expect(q.paused).toBe(true);expect(q.pauseCause).toBe("user");
});
test("a large historical transcript keeps tail detection and button identity stable",async({page})=>{
  await page.goto('https://chatgpt.com/c/large');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{window.originalQueueButton=document.getElementById('chatgpt-message-queue-root').shadowRoot.querySelector('[data-action="queue"]');const fragment=document.createDocumentFragment();for(let i=0;i<1500;i++){const turn=document.createElement('section');turn.dataset.testid='conversation-turn-history-'+i;const message=document.createElement('div');message.dataset.messageAuthorRole=i%2?'assistant':'user';message.dataset.messageId='history-'+i;message.textContent='historical text '.repeat(20);turn.append(message);fragment.append(turn);}document.getElementById('messages').prepend(fragment);});
  await enqueue(page,'tail still works');await button(page,'queue').click();await expect(page.locator(`${host} .preview`)).toHaveText('tail still works');
  expect(await page.evaluate(()=>window.originalQueueButton===document.getElementById('chatgpt-message-queue-root').shadowRoot.querySelector('[data-action="queue"]'))).toBe(true);
});

test("native network send increments Pro usage without any assistant model DOM",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/network-only');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{window.model='gpt-6-pro';window.autoReply=false;window.renderAssistant=false;document.querySelectorAll('[data-message-model-slug]').forEach(n=>n.removeAttribute('data-message-model-slug'));});
  await page.locator('#prompt-textarea').fill('fixture-only network observation');await page.locator('#composer-submit-button').click();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0]?.entries.length,{timeout:5000}).toBe(1);
  const id=await page.evaluate(()=>window.sent[0].id);
  expect((await snapshot(extensionServiceWorker)).usage[0].entries[0].id).toBe(id);
  expect(await page.locator('[data-message-model-slug]').count()).toBe(0);
});

test("cancelled native request before send headers does not count or create a second send",async({page,persistentContext,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/cancelled-network');await expect(button(page,'add')).toBeVisible();
  const cdp=await persistentContext.newCDPSession(page);
  await cdp.send('Network.enable');
  await cdp.send('Network.setBlockedURLs',{urls:['*://chatgpt.com/backend-api/f/conversation']});
  await page.evaluate(()=>{window.model='gpt-6-pro';window.autoReply=false;window.renderAssistant=true;});
  await page.locator('#prompt-textarea').fill('cancelled fixture request');await page.locator('#composer-submit-button').click();
  await page.waitForTimeout(2500);
  expect((await snapshot(extensionServiceWorker)).usage[0]?.entries.length||0).toBe(0);
  await expect(page.locator('[data-message-model-slug="gpt-6-pro"]')).toHaveCount(1);
  expect(await page.evaluate(()=>window.clickCount)).toBe(1);
  await cdp.detach();
});

test("Chinese image removal controls and secondary file inputs protect composer attachments",async({page})=>{
  await page.goto('https://chatgpt.com/c/chinese-attachments');await expect(button(page,'add')).toBeVisible();
  await page.evaluate(()=>{const form=document.querySelector('form');const remove=document.createElement('button');remove.type='button';remove.id='remove-image';remove.setAttribute('aria-label','移除图片');remove.textContent='X';form.append(remove);});
  await page.locator('#prompt-textarea').fill('text stays with image');
  await expect(button(page,'add')).toBeDisabled();
  await expect(page.locator('#prompt-textarea')).toHaveText('text stays with image');
  await page.evaluate(()=>{document.getElementById('remove-image').remove();const form=document.querySelector('form');for(let i=0;i<2;i++){const input=document.createElement('input');input.type='file';input.hidden=true;input.id='upload-'+i;form.append(input);}const transfer=new DataTransfer();transfer.items.add(new File(['fixture'],'local-image.png',{type:'image/png'}));document.getElementById('upload-1').files=transfer.files;});
  await expect(button(page,'add')).toBeDisabled();
  await page.evaluate(()=>{document.querySelectorAll('input[type=file]').forEach(n=>n.value='');});
  await expect(button(page,'add')).toBeEnabled();
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
});

test("native overlay intersecting only an open editor yields without losing its text",async({page},testInfo)=>{
  await page.goto('https://chatgpt.com/c/panel-overlay');await expect(button(page,'add')).toBeVisible();
  await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'saved editor text');
  await button(page,'queue').click();await button(page,'edit').click();await page.locator(`${host} textarea`).fill('unsaved editor draft');
  const panel=await page.locator(`${host} .edit-panel`).boundingBox();
  const bar=await page.locator(host).boundingBox();expect(panel.y+panel.height).toBeLessThan(bar.y);
  await page.evaluate(({x,y})=>{const overlay=document.createElement('div');overlay.id='only-panel-menu';overlay.setAttribute('popover','manual');overlay.style.cssText=`position:fixed;inset:auto;margin:0;left:${x+10}px;top:${y+10}px;width:100px;height:35px;background:white`;overlay.textContent='Native menu';document.body.append(overlay);overlay.showPopover();},panel);
  await expect(page.locator(host)).toHaveAttribute('data-native-overlay','');
  await expect(page.locator(`${host} .edit-panel`)).toBeHidden();
  await page.evaluate(()=>{document.getElementById('only-panel-menu').hidePopover();document.getElementById('only-panel-menu').remove();});
  await expect(page.locator(host)).not.toHaveAttribute('data-native-overlay','');
  await expect(page.locator(`${host} textarea`)).toHaveValue('unsaved editor draft');
  await page.screenshot({path:testInfo.outputPath('editor-survives-native-popover.png')});
});

test("same-node account bootstrap updates and workspace switches never mix pending queues",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/scope-switch');await expect(button(page,'add')).toBeVisible();
  await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'account A saved');
  await page.locator('#prompt-textarea').fill('native draft remains');
  await page.evaluate(()=>{const node=document.getElementById('client-bootstrap');const value=JSON.parse(node.textContent);value.user.id='another-user';node.textContent=JSON.stringify(value);});
  await expect(page.locator(`${host} .count`)).toHaveText('0');
  await expect(page.locator('#prompt-textarea')).toHaveText('native draft remains');
  await page.evaluate(()=>{const node=document.getElementById('client-bootstrap');const value=JSON.parse(node.textContent);value.user.id='regression-user';node.textContent=JSON.stringify(value);});
  await expect(page.locator(`${host} .count`)).toHaveText('1');
  await page.evaluate(()=>localStorage.setItem('_account','another-workspace'));
  await expect(page.locator(`${host} .count`)).toHaveText('0');
  expect((await snapshot(extensionServiceWorker)).queues.filter(q=>q.items.length).length).toBe(1);
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
});

test("homepage persists a configured refresh boundary without entering a conversation",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/');await expect(button(page,'usage')).toBeVisible();
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage.length).toBe(1);
  await extensionServiceWorker.evaluate(async()=>{const all=await chrome.storage.local.get(null);const [key,value]=Object.entries(all).find(([k])=>k.startsWith('notice:usage:'));value.resetAt=Date.now()-1000;value.correction=12;value.baselineKnown=true;value.revision++;await chrome.storage.local.set({[key]:value});});
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0].resetAt).toBeGreaterThan(Date.now());
  expect((await snapshot(extensionServiceWorker)).usage[0].correction).toBe(0);
  await expect(button(page,'queue')).toBeHidden();
});

test("a stale tab showing an older answer cannot finish a newer regeneration",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/stale-regeneration');await expect(button(page,'add')).toBeVisible();
  await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'must wait for actual regeneration');
  await extensionServiceWorker.evaluate(async()=>{const all=await chrome.storage.local.get(null);const [key,q]=Object.entries(all).find(([k])=>k.startsWith('notice:conversation:'));const user='baseline-/c/stale-regeneration';q.turn={id:user+':new-regeneration',userId:user,source:'other-tab',at:Date.now(),done:false};q.paused=false;q.pauseCause='';q.reason='';q.revision++;await chrome.storage.local.set({[key]:q});});
  await page.waitForTimeout(6500);
  expect((await snapshot(extensionServiceWorker)).queues[0].turn.done).toBe(false);
  expect(await page.evaluate(()=>window.clickCount)).toBe(0);
  expect((await snapshot(extensionServiceWorker)).notifications.length).toBe(0);
});

test("a terminated MV3 worker wakes from a queue action with durable state intact",async({page,persistentContext,extensionServiceWorker,extensionId})=>{
  await page.goto('https://chatgpt.com/c/worker-restart');await expect(button(page,'add')).toBeVisible();
  await button(page,'queue').click();await button(page,'pause').click();await button(page,'close').first().click();await enqueue(page,'exactly once after worker restart');
  await extensionServiceWorker.evaluate(()=>{globalThis.ephemeralRestartProbe=true;});
  const cdp=await persistentContext.newCDPSession(page);
  const {targetInfos}=await cdp.send('Target.getTargets');
  const target=targetInfos.find(t=>t.type==='service_worker'&&t.url.startsWith(`chrome-extension://${extensionId}/`));
  expect(target).toBeTruthy();
  await cdp.send('Target.closeTarget',{targetId:target.targetId});
  await button(page,'queue').click();await button(page,'pause').click();
  await expect.poll(()=>page.evaluate(()=>window.sent.length),{timeout:18000}).toBe(1);
  const worker=persistentContext.serviceWorkers().find(w=>w.url().startsWith(`chrome-extension://${extensionId}/`));
  expect(await worker.evaluate(()=>globalThis.ephemeralRestartProbe)).toBeUndefined();
  await expect(page.locator(`${host} .count`)).toHaveText('0');
  await page.waitForTimeout(4500);expect(await page.evaluate(()=>window.sent.length)).toBe(1);
  await cdp.detach();
});

test("DOM fallback waits for a confirmed reply and uses the native user ID",async({page,extensionServiceWorker})=>{
  await page.goto('https://chatgpt.com/c/dom-fallback');await expect(button(page,'add')).toBeVisible();
  // Fault-inject native request accounting in this isolated fixture worker; native UI
  // and its intercepted request still run, so only the DOM fallback can record usage.
  await extensionServiceWorker.evaluate(()=>{recordSubmittedUsage=async()=>{};});
  await page.evaluate(()=>{window.model='gpt-6-pro';window.autoReply=false;});
  await page.locator('#prompt-textarea').fill('fixture DOM fallback');await page.locator('#composer-submit-button').click();
  await page.waitForTimeout(2000);
  expect((await snapshot(extensionServiceWorker)).usage[0]?.entries.length||0).toBe(0);
  await page.evaluate(()=>window.finish('completed fixture reply'));
  await expect.poll(async()=>(await snapshot(extensionServiceWorker)).usage[0]?.entries.length,{timeout:10000}).toBe(1);
  expect((await snapshot(extensionServiceWorker)).usage[0].entries[0].id).toBe(await page.evaluate(()=>window.sent[0].id));
});
