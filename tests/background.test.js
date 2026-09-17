const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Q = require("../queue-core");
const U = require("../usage-core");
const P = require("../projects-core");
const scope = "a".repeat(64);
function harness(storage = {}, session = {}, created = []) {
  const notificationCalls = [], focused = [], tabs = new Map([[1,{id:1,windowId:1,url:"https://chatgpt.com/c/a",frozen:false,discarded:false}],[2,{id:2,windowId:1,url:"https://chatgpt.com/c/a",frozen:false,discarded:false}]]);
  const scopes = new Map([[1, scope], [2, scope]]), documents = new Map([[1, "doc-1"], [2, "doc-2"]]), probes = new Map(), probeCalls = [];
  let sessionRules = [{id:910001}], dynamicRules = [{id:910001,action:{type:"block"},condition:{}}];
  const webEvents = {}, registrations = {};
  let listener, clicked, closed, removed, failWrite = false, failNotify = false, permission = "granted", sequence = 0, tabQueries = 0;
  let offset = 0, writeFilter = () => false;
  class Clock extends Date { static now() { return Date.now() + offset; } }
  const event = name => ({ addListener(fn, filter, options) { webEvents[name] = fn; registrations[name] = { filter, options }; } });
  const clone = value => structuredClone(value);
  const store = target => ({
    async get(keys) { if (keys === null) return clone(target); const names = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(names.filter(k => k in target).map(k => [k,clone(target[k])])); },
    async set(values) { Object.assign(target,clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete target[key]; }
  });
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, getURL: p => p },
    storage: { local: { ...store(storage), async set(values) { if (failWrite || writeFilter(values)) throw new Error("disk full"); Object.assign(storage,clone(values)); } }, session: store(session) },
    declarativeNetRequest: {
      async getDynamicRules() { return clone(dynamicRules); },
      async updateDynamicRules({ removeRuleIds = [], addRules = [] }) {
        dynamicRules = dynamicRules.filter(rule => !removeRuleIds.includes(rule.id)); dynamicRules.push(...clone(addRules));
      },
      async getSessionRules() { return clone(sessionRules); },
      async updateSessionRules({ removeRuleIds = [], addRules = [] }) {
        sessionRules = sessionRules.filter(rule => !removeRuleIds.includes(rule.id));
        sessionRules.push(...clone(addRules));
      }
    },
    webRequest: Object.fromEntries(["onBeforeRequest", "onSendHeaders", "onCompleted", "onErrorOccurred"].map(name => [name, event(name)])),
    notifications: {
      onClicked: { addListener(fn) { clicked = fn; } }, onButtonClicked: { addListener() {} }, onClosed: { addListener(fn) { closed = fn; } },
      async getPermissionLevel() { return permission; },
      async create(id, value) { notificationCalls.push({op:"create",id,...value}); if (failNotify) throw new Error("OS denied"); const index = created.findIndex(item => item.id === id); if (index < 0) created.push({id,...value}); else created[index] = {id,...value}; return id; },
      async update(id, value) { notificationCalls.push({op:"update",id,...value}); if (failNotify) throw new Error("OS denied"); const index = created.findIndex(item => item.id === id); if (index < 0) return false; created[index] = { id, ...value }; return true; },
      async clear(id) { closed?.(id, false); return true; }
    },
    tabs: { onRemoved: { addListener(fn) { removed = fn; } }, async get(id) { return tabs.get(id); }, async query(query = {}) { tabQueries += 1; return [...tabs.values()].filter(tab => !query.active || tab.id === 1); },
      async sendMessage(id, message, options) {
        if (!tabs.has(id) || options.documentId && options.documentId !== documents.get(id)) throw new Error("No matching document");
        if (message?.type === "NOTICE_COMPLETION_PROBE") { probeCalls.push({ id, message, options }); return probes.get(id) || { scope: scopes.get(id), url: tabs.get(id).url, state:"running", hidden:false, generationId:message.turnId, prompt:"", response:"" }; }
        return { scope: scopes.get(id), url: tabs.get(id).url };
      },
      async update(id) { focused.push(id); }, async create(value) { focused.push(value.url); } },
    windows: { async update() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../background.js"),"utf8"), { chrome, importScripts() {}, ChatGPTQueueCore: Q, ChatGPTUsage: U, ChatGPTProjects: P, URL, Date:Clock, TextDecoder, console, setTimeout, clearTimeout });
  const sender = tabId => ({tab:tabs.get(tabId),url:tabs.get(tabId)?.url,documentId:`doc-${tabId}`,frameId:0});
  const send = (command, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,command}, sender(tabId), resolve));
  const sendUsage = (usage, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,usage}, sender(tabId), resolve));
  const sendProjects = (projects, tabId = 1, requestedScope = scope) => new Promise(resolve => listener({type:"NOTICE",scope:requestedScope,url:tabs.get(tabId).url,projects}, sender(tabId), resolve));
  const setting = (feature, enabled) => new Promise(resolve => listener({type:"NOTICE_FEATURE_SETTING",feature,enabled}, {url:"popup.html"}, resolve));
  const drain = () => new Promise(resolve => setTimeout(resolve, 50));
  const emit = async (name, details) => { webEvents[name](details); await drain(); };
  const before = async (body, overrides = {}) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body)).buffer;
    const details = { tabId:1, frameId:0, documentId:"doc-1", requestId:String(++sequence), initiator:"https://chatgpt.com", method:"POST", url:"https://chatgpt.com/backend-api/f/conversation", requestBody:{raw:[{bytes}]}, timeStamp:Date.now(), ...overrides };
    await emit("onBeforeRequest", details);
    return details;
  };
  const observe = async (body, tabId = 1) => {
    const details = await before(body, { tabId, documentId:`doc-${tabId}` });
    await emit("onSendHeaders", details);
  };
  const popup = () => new Promise(resolve => listener({ type:"NOTICE_POPUP" }, { url:"popup.html" }, resolve));
  return { send, sendUsage, sendProjects, setting, observe, before, emit, popup, storage, session, tabs, scopes, documents, probes, probeCalls, registrations, created, focused, notificationCalls, advance:ms=>{offset+=ms;}, failWrites:fn=>{writeFilter=fn;}, rules:()=>clone(dynamicRules), click: id => clicked(id), closeNotice: (id, byUser) => closed?.(id, byUser), dropNotification: id => { const index = created.findIndex(item => item.id === id); if (index >= 0) created.splice(index,1); }, closeTab: id => {tabs.delete(id); removed?.(id);}, writeFailure: v => {failWrite=v;}, notifyFailure: v=>{failNotify=v;}, permission: v=>{permission=v;}, tabQueryCount: ()=>tabQueries };
}
test("startup removes the legacy sidebar blocker and never installs another request rule", async () => {
  const h = harness();
  await h.popup();
  assert.deepEqual(h.rules(), []);
});
test("popup feature switches persist independently without changing network behavior", async () => {
  const h = harness();
  let popup = await h.popup();
  assert.deepEqual({ ...popup.settings }, { sidebarCollapse:true, queue:true, notifications:true });
  assert.equal(h.rules().length, 0);

  let result = await h.setting("sidebarCollapse", false);
  assert.equal(result.ok, true);
  assert.equal(result.settings.sidebarCollapse, false);
  assert.equal(h.storage["notice:sidebar-collapse-enabled"], false);
  assert.equal(h.rules().length, 0);

  result = await h.setting("queue", false);
  assert.equal(result.settings.queue, false);
  assert.equal(h.storage["notice:queue-enabled"], false);
  result = await h.setting("notifications", false);
  assert.equal(result.settings.notifications, false);
  assert.equal(h.storage["notice:notifications"], false);

  result = await h.setting("sidebarCollapse", true);
  assert.equal(result.settings.sidebarCollapse, true);
  assert.equal(h.rules().length, 0);
  popup = await h.popup();
  assert.deepEqual({ ...popup.settings }, { sidebarCollapse:true, queue:false, notifications:false });
});
test("sidebar setting storage failure leaves its previous value unchanged", async () => {
  const h = harness(); await h.popup();
  h.writeFailure(true);
  assert.equal((await h.setting("sidebarCollapse", false)).ok, false);
  assert.equal((await h.popup()).settings.sidebarCollapse, true);
  assert.equal(h.rules().length, 0);
});
test("projects persist with account isolation, no deletion on partial observations and no raw payload storage", async () => {
  const h = harness(), id = `g-p-${"a".repeat(32)}`;
  let reply = await h.sendProjects([{projectId:id,shortUrl:`${id}-alpha`,name:"Alpha",instructions:"SECRET",files:["SECRET"]}]);
  assert.equal(reply.ok, true); assert.equal(reply.projects.items.length, 1);
  assert.equal(JSON.stringify(h.storage).includes("SECRET"), false);
  const restart = harness(h.storage);
  assert.equal((await restart.sendProjects([])).projects.items[0].name, "Alpha");
  reply = await restart.sendProjects([{projectId:id,shortUrl:`${id}-renamed`,name:"Renamed"}]);
  assert.equal(reply.projects.items.length, 1); assert.equal(reply.projects.items[0].shortUrl, `${id}-renamed`);
  restart.scopes.set(1, "b".repeat(64));
  assert.equal((await restart.sendProjects([])).ok, false);
  assert.deepEqual((await restart.sendProjects([], 1, "b".repeat(64))).projects.items, []);
});
test("service worker serializes concurrent claims and persists intent", async () => {
  const h = harness();
  await h.send({op:"add",id:"queue-item",text:"queue"});
  const results = await Promise.all([h.send({op:"claim",baseline:"user"},1),h.send({op:"claim",baseline:"user"},2)]);
  assert.equal(results.filter(r=>r.ok).length,1);
  const sender = results[0].ok ? 1 : 2, item = results.find(r=>r.ok).item;
  assert.equal((await h.send({op:"intent",id:item.id,claim:item.claim},sender)).ok,true);
  assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].items[0].phase,"submitting");
});
test("storage failure does not acknowledge enqueue", async () => {
  const h=harness(); h.writeFailure(true);
  assert.equal((await h.send({op:"add",id:"queue-item",text:"keep draft"})).ok,false);
  assert.equal(Object.keys(h.storage).length,0);
});
test("completion is queue-aware, persisted, and at-most-once across worker restarts", async () => {
  const h=harness();
  await h.send({op:"start",userId:"user-a"});
  await Promise.all([h.send({op:"settle",userId:"user-a"}),h.send({op:"settle",userId:"user-a"},2)]);
  assert.equal(h.created.length,1);
  const restarted=harness(h.storage);
  await restarted.send({op:"settle",userId:"user-a"});
  assert.equal(restarted.created.length,0);
  await restarted.send({op:"add",id:"pending-item",text:"next"});
  await restarted.send({op:"start",userId:"user-b"});
  await restarted.send({op:"settle",userId:"user-b"});
  assert.equal(restarted.created.length,0);
});
test("rich completion notice uses prompt title, elapsed time, and reply preview without persisting the preview", async () => {
  const h = harness();
  await h.send({op:"start",userId:"user-rich"});
  await h.send({op:"settle",userId:"user-rich",notice:{
    prompt:"  审核 gpt-notice \n 的通知体验  ",
    response:"```js\nconst noisy = true;\n```\n\n## 已修复通知层级\n支持 **摘要** 和 [打开对话](https://example.com)\n\n第二段不应抢占通知",
    elapsedMs:125_000
  }});
  assert.equal(h.created.length,1);
  assert.equal(h.created[0].title,"回复已完成 · 审核 gpt-notice 的通知体验");
  assert.equal(h.created[0].message,"已修复通知层级 支持 摘要 和 打开对话");
  assert.equal(h.created[0].contextMessage,"gpt-notice · 本轮用时 2 分 5 秒");
  assert.equal(h.created[0].buttons,undefined);
  assert.equal(JSON.stringify(h.storage).includes("已修复通知层级"),false);
});
test("hidden running request stays silent until semantic completion", async () => {
  const h = harness();
  await h.send({op:"start",userId:"network-user"});
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"running",hidden:true,generationId:"network-user",prompt:"后台问题",response:""});
  const request = await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"network-user",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);
  await h.emit("onCompleted",{...request,statusCode:200});
  assert.equal(h.created.length,0);
  assert.equal(Object.keys(h.session).some(key=>key.startsWith("notice:request:")),false);
  await h.send({op:"settle",userId:"network-user",notice:{prompt:"后台问题",response:"最终摘要",elapsedMs:2200}});
  assert.equal(h.created.length,1);
  assert.match(h.created[0].message,/最终摘要/);
  assert.equal(Object.values(h.storage).find(value=>value?.kind==="completed")?.kind,"completed");
});
test("hidden semantic completion publishes only a generic notice without reply preview", async () => {
  const h = harness();
  await h.send({op:"start",userId:"hidden-semantic"});
  await h.send({op:"settle",userId:"hidden-semantic",notice:{prompt:"后台问题",response:"private final reply",elapsedMs:3200,hidden:true}});
  assert.equal(h.created.length,1);
  assert.equal(h.created[0].title,"回复已完成 · 后台问题");
  assert.match(h.created[0].message,/点击查看对话/);
  assert.equal(h.created[0].message.includes("private final reply"),false);
  assert.equal(Object.values(h.storage).find(value=>value?.kind)?.kind,"generic");
});
test("visible running request stays silent until semantic completion", async () => {
  const h = harness();
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"running",hidden:false,generationId:"visible-user",prompt:"前台问题",response:""});
  const request = await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"visible-user",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);
  await h.emit("onCompleted",{...request,statusCode:200});
  assert.equal(h.created.length,0);
});
test("probe timeout alone stays silent instead of guessing completion", async () => {
  const h = harness();
  const request = await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"frozen-user",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);
  h.tabs.get(1).frozen = true;
  h.probes.set(1,new Promise(()=>{}));
  await h.emit("onCompleted",{...request,statusCode:200});
  await new Promise(resolve=>setTimeout(resolve,750));
  assert.equal(h.probeCalls.length,1);
  assert.equal(h.created.length,0);
});
test("pending Queue work suppresses interim network notifications", async () => {
  const h = harness();
  await h.send({op:"add",id:"pending-work",text:"next queued message"});
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:true,generationId:"manual-user",prompt:"manual",response:"done"});
  const request = await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"manual-user",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);
  await h.emit("onCompleted",{...request,statusCode:200});
  assert.equal(h.created.length,0);
  assert.equal(h.probeCalls.length,1);
});
test("request-time Queue provenance prevents an older request from borrowing a later final item", async () => {
  const h=harness();
  await h.send({op:"add",id:"queue-one",text:"one"});await h.send({op:"add",id:"queue-two",text:"two"});
  const first=(await h.send({op:"claim",baseline:"baseline-user"})).item;await h.send({op:"intent",id:first.id,claim:first.claim});
  const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"sent-one",author:{role:"user"}}]});await h.emit("onSendHeaders",request);
  const captured=Object.values(h.session).find(value=>value?.requestId===request.requestId);assert.equal(captured.finalQueueRequest,undefined);
  await h.send({op:"receipt",id:first.id,claim:first.claim,userId:"sent-one",text:"one"});await h.send({op:"settle",userId:"sent-one"});
  const second=(await h.send({op:"claim",baseline:"sent-one"})).item;await h.send({op:"intent",id:second.id,claim:second.claim});
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:true,generationId:"sent-one",prompt:"old",response:"done"});
  await h.emit("onCompleted",{...request,statusCode:200});assert.equal(h.created.length,0);
});
test("a responsive scope mismatch is stale and never falls back to a generic notice", async () => {
  const h = harness();
  h.probes.set(1,{scope:"b".repeat(64),url:"https://chatgpt.com/c/a",state:"running",hidden:true,generationId:"wrong-scope"});
  const request = await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"wrong-scope",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);
  await h.emit("onCompleted",{...request,statusCode:200});
  assert.equal(h.created.length,0);
});
test("a late network completion cannot announce a stopped or superseded generation", async () => {
  for (const superseded of [false,true]) {
    const h=harness();await h.send({op:"start",userId:"original"});
    const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"original",author:{role:"user"}}]});await h.emit("onSendHeaders",request);
    if(superseded)await h.send({op:"start",userId:"newer",previousUserId:"original"});else await h.send({op:"stop",userId:"original"});
    h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:false,generationId:"original",response:"must not notify"});
    await h.emit("onCompleted",{...request,statusCode:200});assert.equal(h.created.length,0);
  }
});
test("an old native request cannot borrow the same user message's later regeneration", async () => {
  const h=harness();await h.send({op:"start",userId:"original"});
  const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"original",author:{role:"user"}}]});await h.emit("onSendHeaders",request);
  await h.send({op:"start",userId:"original",generationId:"original:retry",retryOf:"original"});
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:false,generationId:"original:retry"});
  await h.emit("onCompleted",{...request,statusCode:200});assert.equal(h.created.length,0);
});
test("attention and blocking errors notify even with pending work, without success wording or persisted preview", async () => {
  for(const outcome of ["attention","blocked","failed"]) {
    const h=harness();await h.send({op:"add",id:"pending-work",text:"next"});await h.send({op:"start",userId:"original"});
    await h.send({op:outcome==="attention"?"attention":"settle",userId:"original",outcome,notice:{prompt:"fixture",response:"private prose",hidden:true}});
    assert.equal(h.created.length,1);assert.doesNotMatch(h.created[0].message,/回复已完成|private prose/);
    assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].turn.done,outcome!=="attention");
    assert.equal(JSON.stringify(h.storage).includes("private prose"),false);
  }
});
test("notification click does not focus a tab reused for another conversation", async () => {
  const h=harness(); await h.send({op:"start",userId:"user-a"}); await h.send({op:"settle",userId:"user-a"});
  h.tabs.set(1,{id:1,windowId:1,url:"https://chatgpt.com/c/other"});
  h.click(h.created[0].id);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(h.focused,[2]);
});
test("notification failures never mark delivery and a later semantic completion can retry", async () => {
  const h=harness();h.notifyFailure(true);
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:true,generationId:"user-a",prompt:"retry notice",response:"hidden result"});
  const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"user-a",author:{role:"user"}}]});
  await h.emit("onSendHeaders",request);await h.emit("onCompleted",{...request,statusCode:200});
  assert.equal(Object.values(h.storage).some(value=>value?.kind),false);
  h.advance(11000);
  h.notifyFailure(false);await h.send({op:"start",userId:"user-a"});const r=await h.send({op:"settle",userId:"user-a",notice:{prompt:"retry notice",response:"done",elapsedMs:1000}});
  assert.equal(r.notificationError,"");assert.equal(h.created.length,1);assert.equal(Object.values(h.storage).some(value=>value?.kind==="completed"),true);
});
test("three manual results have distinct notices; three queued results publish only the final notice", async () => {
  const manual=harness();
  for (const id of ["manual-1","manual-2","manual-3"]) {
    await manual.send({op:"start",userId:id}); await manual.send({op:"settle",userId:id});
    await manual.send({op:"settle",userId:id},2);
  }
  assert.equal(new Set(manual.created.map(n=>n.id)).size,3);
  const queued=harness();
  for (const id of ["queued-1","queued-2","queued-3"]) await queued.send({op:"add",id,text:id});
  let baseline="before";
  for (let i=1;i<=3;i++) {
    const item=(await queued.send({op:"claim",baseline})).item;
    await queued.send({op:"intent",id:item.id,claim:item.claim});
    const userId=`queue-user-${i}`;
    await queued.send({op:"receipt",id:item.id,claim:item.claim,userId,text:item.text});
    await queued.send({op:"settle",userId}); baseline=userId;
    assert.equal(queued.created.length,i===3?1:0);
  }
  assert.match(queued.created[0].title,/队列已完成/);
});
test("dismissing an approval never suppresses the later hidden completion or blocking error", async () => {
  for (const outcome of ["completed","blocked"]) for (const dismiss of ["close","click"]) {
    const h=harness();await h.send({op:"start",userId:"approval"});await h.send({op:"attention",userId:"approval"});
    const approvalId=h.created[0].id;
    if(dismiss==="close")h.closeNotice(approvalId,true);else h.click(approvalId);
    await new Promise(r=>setTimeout(r,20));
    await h.send({op:"attention",userId:"approval"});assert.equal(h.created.length,1);
    await h.send({op:"settle",userId:"approval",outcome,notice:{hidden:true}});
    assert.equal(h.created.length,2);assert.notEqual(h.created[1].id,approvalId);
    assert.match(h.created[1].title,outcome==="completed"?/回复已完成/:/需要处理/);
    await h.send({op:"settle",userId:"approval",outcome});assert.equal(h.created.length,2);
  }
});
test("settle notification failure survives the completed turn and retries without a second settle", async () => {
  const h=harness();await h.send({op:"start",userId:"failure"});h.notifyFailure(true);
  const reply=await h.send({op:"settle",userId:"failure",notice:{prompt:"private prompt",response:"private response"}});
  assert.equal(reply.queue.turn.done,true);assert.ok(reply.notificationError);
  const pending=Object.values(h.storage).find(n=>n?.pendingKind);assert.equal(pending.pendingKind,"completed");
  assert.equal(JSON.stringify(h.storage).includes("private"),false);
  const calls=h.notificationCalls.length;
  await h.send({op:"get"});assert.equal(h.notificationCalls.length,calls);
  h.notifyFailure(false);h.advance(11000);
  assert.equal((await h.send({op:"get"})).notificationError,"");assert.equal(h.created.length,1);
  assert.equal(Object.values(h.storage).some(n=>n?.pendingKind),false);
  await h.send({op:"get"});assert.equal(h.created.length,1);
});
test("completion and notification intent share one storage write", async () => {
  const h=harness();await h.send({op:"start",userId:"atomic"});
  h.failWrites(values=>Object.values(values).some(n=>n?.pendingKind));
  assert.equal((await h.send({op:"settle",userId:"atomic"})).ok,false);
  assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].turn.done,false);
  assert.equal(h.created.length,0);
  h.failWrites(()=>false);await h.send({op:"settle",userId:"atomic"});assert.equal(h.created.length,1);
});
test("worker wake recovers an unacknowledged OS success by silent update, not a second create", async () => {
  const h=harness();await h.send({op:"start",userId:"crash-gap"});
  h.failWrites(values=>Object.values(values).some(n=>n?.kind&&!n.pendingKind));
  const reply=await h.send({op:"settle",userId:"crash-gap"});assert.ok(reply.notificationError);
  assert.equal(h.created.length,1);
  const record=Object.values(h.storage).find(n=>n?.pendingKind);record.retryAt=0;
  const restarted=harness(h.storage,h.session,h.created);await restarted.popup();
  assert.equal(restarted.notificationCalls.filter(c=>c.op==="create").length,0);
  assert.equal(restarted.notificationCalls.filter(c=>c.op==="update").length,1);
  assert.equal(restarted.notificationCalls[0].silent,true);
  assert.equal(Object.values(restarted.storage).some(n=>n?.pendingKind),false);
});
test("pending approval survives worker restart and does not auto-approve or finish the turn", async () => {
  const h=harness();await h.send({op:"start",userId:"pending-approval"});h.notifyFailure(true);
  await h.send({op:"attention",userId:"pending-approval"});
  Object.values(h.storage).find(n=>n?.pendingKind).retryAt=0;
  const restarted=harness(h.storage,h.session);await restarted.popup();
  assert.equal(restarted.created.length,1);assert.match(restarted.created[0].title,/需要你确认/);
  assert.equal(restarted.storage[Q.key(scope,"https://chatgpt.com/c/a")].turn.done,false);
  await restarted.send({op:"attention",userId:"pending-approval"});assert.equal(restarted.created.length,1);
});
test("an explicit Stop cancels an undelivered approval instead of retrying a stale request for approval", async () => {
  const h=harness();await h.send({op:"start",userId:"stop-pending"});h.notifyFailure(true);
  await h.send({op:"attention",userId:"stop-pending"});await h.send({op:"stop",userId:"stop-pending"});
  h.notifyFailure(false);h.advance(11000);await h.send({op:"get"});await h.send({op:"settle",userId:"stop-pending"});
  assert.equal(h.created.length,0);assert.equal(Object.values(h.storage).some(n=>n?.pendingKind),false);
});
test("Queue disabled preserves queued text but no longer suppresses independent manual completion", async () => {
  const h=harness();await h.send({op:"add",id:"pending-work",text:"saved"});await h.setting("queue",false);
  await h.send({op:"start",userId:"manual-with-disabled-queue"});await h.send({op:"settle",userId:"manual-with-disabled-queue"});
  assert.equal(h.created.length,1);assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].items.length,1);
});
test("paused queue does not mute an independent manual reply or falsely claim the whole queue completed", async () => {
  const h=harness();await h.send({op:"add",id:"paused-item",text:"saved"});await h.send({op:"pause",paused:true});
  await h.send({op:"start",userId:"independent"});await h.send({op:"settle",userId:"independent"});
  assert.equal(h.created.length,1);assert.match(h.created[0].title,/回复已完成/);assert.doesNotMatch(h.created[0].title,/队列已完成/);
  assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].paused,true);
});
test("resolved attention pending delivery is cancelled when the terminal result commits", async () => {
  const h=harness();await h.send({op:"start",userId:"attention-resolved"});h.notifyFailure(true);
  await h.send({op:"attention",userId:"attention-resolved"});h.notifyFailure(false);
  await h.send({op:"settle",userId:"attention-resolved"});h.advance(11000);await h.send({op:"get"});
  assert.equal(h.created.length,1);assert.match(h.created[0].title,/回复已完成/);
  assert.equal(Object.values(h.storage).some(n=>n?.pendingKind),false);
});
test("disabled notifications discard pending delivery; denied permission is visible and retryable", async () => {
  const h=harness();h.permission("denied");await h.send({op:"start",userId:"denied"});await h.send({op:"settle",userId:"denied"});
  assert.equal(h.created.length,0);assert.equal((await h.popup()).notification.pending,1);
  h.permission("granted");h.advance(11000);await h.send({op:"get"});assert.equal(h.created.length,1);
  h.notifyFailure(true);await h.send({op:"start",userId:"disabled"});await h.send({op:"settle",userId:"disabled"});
  await h.setting("notifications",false);assert.equal(Object.values(h.storage).some(n=>n?.pendingKind),false);
  h.notifyFailure(false);h.advance(11000);await h.setting("notifications",true);await h.send({op:"get"});assert.equal(h.created.length,1);
});
test("stale page mutations are rejected after SPA navigation", async () => {
  const h=harness(); h.tabs.set(1,{id:1,windowId:1,url:"https://chatgpt.com/c/other"});
  assert.equal((await h.send({op:"add",id:"pending-item",text:"wrong conversation"})).ok,false);
});
test("normal start does not scan all ChatGPT tabs outside the legacy recovery path", async () => {
  const h=harness();const result=await h.send({op:"start",userId:"fresh-user"});assert.equal(result.ok,true);assert.equal(h.tabQueryCount(),0);
});
test("single-tab start repairs a legacy false concurrency pause", async () => {
  const key = Q.key(scope, "https://chatgpt.com/c/a");
  const legacy = Q.fresh();
  delete legacy.pauseCause;
  legacy.paused = true;
  legacy.reason = Q.CONFLICT_REASON;
  legacy.holdUntil = Date.now();
  legacy.turn = { id: "old-user", userId: "old-user", at: Date.now() - 1000, done: false };
  const h = harness({ [key]: legacy });
  h.tabs.delete(2);
  const result = await h.send({ op: "start", userId: "new-user" }, 1);
  assert.equal(result.ok, true);
  assert.equal(result.conflict, undefined);
  assert.equal(h.storage[key].turn.id, "new-user");
  assert.equal(h.storage[key].turn.source, "1");
  assert.equal(h.storage[key].paused, false);
  assert.equal(h.storage[key].holdUntil, 0);
});
test("unknown usage schema never blocks Queue state and is not overwritten", async () => {
  const usageKey=U.PREFIX+scope, unknown={version:2,revision:9,entries:[],futureField:"keep"};const h=harness({[usageKey]:structuredClone(unknown)});
  assert.equal((await h.send({op:"start",userId:"queue-safe"})).ok,true);assert.equal((await h.send({op:"settle",userId:"queue-safe"})).ok,true);
  assert.deepEqual(h.storage[usageKey],unknown);assert.equal(h.storage[Q.key(scope,"https://chatgpt.com/c/a")].turn.done,true);
});
test("eligible Pro usage is recorded from the native outgoing request before completion and deduplicates the later DOM observation", async () => {
  const h = harness();
  await h.send({ op:"get" });
  await h.observe({ action:"next", model:"gpt-6-pro", messages:[{ id:"user-send-1", author:{ role:"user" } }] });
  const usageKey = U.PREFIX + scope;
  assert.equal(U.count(h.storage[usageKey]), 1);
  assert.equal(h.storage[usageKey].entries[0].id, "user-send-1");
  await h.sendUsage({ op:"record", turnId:"user-send-1", model:"gpt-6-pro", at:Date.now() });
  assert.equal(U.count(h.storage[usageKey]), 1);
  await h.observe({ action:"next", model:"gpt-5-6-thinking", messages:[{ id:"user-send-2", author:{ role:"user" } }] });
  assert.equal(U.count(h.storage[usageKey]), 1);
  await h.observe({ action:"next", model:"gpt-5-6-pro", messages:[{ id:"user-send-3", author:{ role:"user" } }] });
  assert.equal(U.count(h.storage[usageKey]), 2);
});
test("system closes do not suppress enrichment, but explicit user closes do", async () => {
  const h=harness();await h.send({op:"start",userId:"normal"});
  h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:true,generationId:"normal",prompt:"q",response:"hidden result"});
  const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"normal",author:{role:"user"}}]});await h.emit("onSendHeaders",request);await h.emit("onCompleted",{...request,statusCode:200});
  const id=h.created[0].id;h.closeNotice(id,false);await new Promise(r=>setTimeout(r,20));
  assert.equal(Object.values(h.storage).some(value=>value?.dismissedAt),false);
  await h.send({op:"settle",userId:"normal",notice:{prompt:"q",response:"rich",elapsedMs:1000}});assert.match(h.created[0].message,/rich/);
  h.closeNotice(id,true);await new Promise(r=>setTimeout(r,20));assert.equal(Object.values(h.storage).some(value=>value?.dismissedAt),true);
});

test("missing OS notification is recreated when a richer result arrives", async () => {
  const h=harness();h.probes.set(1,{scope,url:"https://chatgpt.com/c/a",state:"completed",hidden:true,generationId:"upgrade",prompt:"q",response:"hidden result"});
  const request=await h.before({action:"next",model:"gpt-5-6-thinking",messages:[{id:"upgrade",author:{role:"user"}}]});await h.emit("onSendHeaders",request);await h.emit("onCompleted",{...request,statusCode:200});
  const id=h.created[0].id;h.dropNotification(id);await h.send({op:"start",userId:"upgrade"});await h.send({op:"settle",userId:"upgrade",notice:{prompt:"q",response:"rich",elapsedMs:1000}});
  assert.equal(h.created.length,1);assert.equal(h.created[0].id,id);assert.match(h.created[0].message,/rich/);
});

test("disabled notifications create no records; clicked notices remain only as dismissed dedupe markers", async () => {
  const h=harness({"notice:notifications":false});await h.send({op:"start",userId:"silent"});await h.send({op:"settle",userId:"silent"});
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('notice:notification:')).length,0);
  const active=harness();await active.send({op:"start",userId:"normal"});await active.send({op:"settle",userId:"normal"});active.click(active.created[0].id);await new Promise(r=>setTimeout(r,20));
  const records=Object.values(active.storage).filter(value=>value?.dismissedAt);
  assert.equal(records.length,1);
});

const proBody = (id = "native-user", model = "gpt-6-pro") => ({ action:"next", model, messages:[{ id, author:{role:"user"}, content:{parts:["private prompt must never be persisted"]} }] });
test("usage waits for send headers and discards a cancelled pre-send request", async () => {
  const h = harness();
  const cancelled = await h.before(proBody("cancelled"));
  assert.equal(h.storage[U.PREFIX + scope], undefined);
  assert.equal(JSON.stringify(h.session).includes("private prompt"), false);
  await h.emit("onErrorOccurred", cancelled);
  assert.equal(Object.keys(h.session).some(k => k.startsWith("notice:request:")), false);
  const sent = await h.before(proBody("sent"));
  await h.emit("onSendHeaders", sent);
  await h.emit("onSendHeaders", sent);
  await h.observe(proBody("sent"));
  await h.sendUsage({op:"record",turnId:"sent",model:"gpt-6-pro",at:Date.now()});
  assert.equal(U.count(h.storage[U.PREFIX + scope]), 1);
  assert.deepEqual([...h.registrations.onBeforeRequest.options], ["requestBody"]);
  assert.equal(h.registrations.onSendHeaders.options, undefined);
});
test("minimal pending usage survives worker restart but never a document or workspace change", async () => {
  const first = harness();
  const request = await first.before(proBody("restart"));
  const restarted = harness(first.storage, first.session);
  await restarted.emit("onSendHeaders", request);
  assert.equal(U.count(restarted.storage[U.PREFIX + scope]), 1);
  const changed = await restarted.before(proBody("wrong-account"));
  restarted.scopes.set(1, "b".repeat(64));
  await restarted.emit("onSendHeaders", changed);
  assert.equal(U.count(restarted.storage[U.PREFIX + scope]), 1);
  assert.equal(restarted.storage[U.PREFIX + "b".repeat(64)], undefined);
  restarted.scopes.set(1, scope);
  const navigated = await restarted.before(proBody("wrong-document"));
  restarted.documents.set(1, "new-document");
  await restarted.emit("onSendHeaders", navigated);
  assert.equal(U.count(restarted.storage[U.PREFIX + scope]), 1);
  assert.equal((await restarted.send({op:"add",id:"stale-item",text:"not stored"})).ok, false);
});
test("request allowlist rejects speculative, unsupported and non-page traffic", async () => {
  const h = harness();
  for (const overrides of [
    {method:"GET"}, {frameId:2}, {tabId:-1}, {documentId:""}, {initiator:"https://untrusted.example"},
    {url:"https://chatgpt.com/backend-api/f/conversation/prepare"},
    {requestBody:{raw:[{file:"private-file"}]}}, {requestBody:{raw:[{bytes:new Uint8Array([255]).buffer}]}}
  ]) {
    const request = await h.before(proBody(), overrides);
    await h.emit("onSendHeaders", request);
  }
  for (const body of [{...proBody(),action:"variant"},proBody("work","gpt-6-astra-wm"),proBody("thinking","gpt-5-6-thinking")]) await h.observe(body);
  assert.equal(h.storage[U.PREFIX + scope], undefined);
  h.scopes.set(1, "");
  await h.observe(proBody());
  assert.equal(h.storage[U.PREFIX + scope], undefined);
});
test("UTF-8 request chunks are decoded as one stream without retaining body text", async () => {
  const h = harness();
  const body = proBody("utf8");
  body.messages[0].content.parts = ["中文"];
  const bytes = new TextEncoder().encode(JSON.stringify(body));
  const split = bytes.indexOf(0xe4) + 1;
  const details = await h.before(body, { requestBody:{ raw:[{bytes:bytes.slice(0,split).buffer},{bytes:bytes.slice(split).buffer}] } });
  await h.emit("onSendHeaders", details);
  assert.equal(U.count(h.storage[U.PREFIX + scope]), 1);
  assert.equal(JSON.stringify([h.storage,h.session]).includes("中文"), false);
});
test("popup and notifications are isolated to the live account and workspace", async () => {
  const a = Q.apply(undefined,{op:"add",id:"account-a-item",text:"A"},"1",Date.now()).state;
  const b = Q.apply(undefined,{op:"add",id:"account-b-item",text:"B"},"1",Date.now()).state;
  a.url = b.url = "https://chatgpt.com/c/a";
  const other = "b".repeat(64);
  const h = harness({ [Q.key(scope,a.url)]:a, [Q.key(other,b.url)]:b });
  let popup = await h.popup();
  assert.equal(popup.permission,"granted");
  assert.equal(popup.queues.length,1);
  assert.equal(popup.queues[0].key, Q.key(scope,a.url));
  h.scopes.set(1, other);
  popup = await h.popup();
  assert.equal(popup.queues.length,1);
  assert.equal(popup.queues[0].key,Q.key(other,b.url));
  h.scopes.set(1, "");
  assert.equal((await h.popup()).queues.length,0);
  const notice = harness();
  await notice.send({op:"start",userId:"done"});
  await notice.send({op:"settle",userId:"done"});
  notice.scopes.set(1,other); notice.scopes.set(2,other);
  notice.click(notice.created[0].id);
  await new Promise(resolve=>setTimeout(resolve,20));
  assert.equal(notice.focused.length,0);
});
test("maintenance removes only old empty idle bookkeeping, preserving all user and safety state", async () => {
  const old = Date.now() - 40 * 86400_000;
  const state = (extra = {}) => ({ ...Q.fresh(), updatedAt:old, ...extra });
  const key = name => Q.key(scope, `https://chatgpt.com/c/${name}`);
  const storage = {
    [key("expired")]:state({turn:{id:"done",done:true}}),
    [key("paused")]:state({paused:true}), [key("held")]:state({holdUntil:old}),
    [key("active")]:state({turn:{id:"active",done:false}}),
    [key("pending")]:state({items:[{id:"pending",text:"keep",state:"pending"}]}),
    [key("unknown")]:state({items:[{id:"unknown",text:"keep",state:"unknown"}]}),
    [key("a")]:state(), [key("corrupt")]:{version:8}, legacyQueue:{text:"keep legacy"}
  };
  const h = harness(storage, {"notice:request:old":{at:old},"notice:request:recent":{at:Date.now()}});
  await h.send({op:"get"});
  assert.equal(storage[key("expired")],undefined);
  for (const name of ["paused","held","active","pending","unknown","a","corrupt"]) assert.ok(storage[key(name)],name);
  assert.ok(storage.legacyQueue);
  assert.equal(h.session["notice:request:old"],undefined);
  assert.ok(h.session["notice:request:recent"]);
});
