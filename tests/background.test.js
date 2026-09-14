const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Q = require("../queue-core");
const U = require("../usage-core");
const scope = "a".repeat(64);
function harness(storage = {}, session = {}) {
  const created = [], focused = [], tabs = new Map([[1,{id:1,windowId:1,url:"https://chatgpt.com/c/a"}],[2,{id:2,windowId:1,url:"https://chatgpt.com/c/a"}]]);
  const scopes = new Map([[1, scope], [2, scope]]), documents = new Map([[1, "doc-1"], [2, "doc-2"]]);
  const webEvents = {}, registrations = {};
  let listener, clicked, removed, failWrite = false, failNotify = false, sequence = 0;
  const event = name => ({ addListener(fn, filter, options) { webEvents[name] = fn; registrations[name] = { filter, options }; } });
  const clone = value => structuredClone(value);
  const store = target => ({
    async get(keys) { if (keys === null) return clone(target); const names = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(names.filter(k => k in target).map(k => [k,clone(target[k])])); },
    async set(values) { Object.assign(target,clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete target[key]; }
  });
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, getURL: p => p },
    storage: { local: { ...store(storage), async set(values) { if (failWrite) throw new Error("disk full"); Object.assign(storage,clone(values)); } }, session: store(session) },
    webRequest: Object.fromEntries(["onBeforeRequest", "onSendHeaders", "onCompleted", "onErrorOccurred"].map(name => [name, event(name)])),
    notifications: { onClicked: { addListener(fn) { clicked = fn; } }, onButtonClicked: { addListener() {} }, onClosed: { addListener() {} }, async create(id, value) { if (failNotify) throw new Error("OS denied"); created.push({id,...value}); }, async clear() {} },
    tabs: { onRemoved: { addListener(fn) { removed = fn; } }, async get(id) { return tabs.get(id); }, async query(query = {}) { return [...tabs.values()].filter(tab => !query.active || tab.id === 1); },
      async sendMessage(id, message, options) { if (!tabs.has(id) || options.documentId && options.documentId !== documents.get(id)) throw new Error("No matching document"); return { scope: scopes.get(id), url: tabs.get(id).url }; },
      async update(id) { focused.push(id); }, async create(value) { focused.push(value.url); } },
    windows: { async update() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../background.js"),"utf8"), { chrome, importScripts() {}, ChatGPTQueueCore: Q, ChatGPTUsage: U, Date, TextDecoder, console, setTimeout, clearTimeout });
  const send = (command, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,command}, {tab:tabs.get(tabId),documentId:`doc-${tabId}`,frameId:0}, resolve));
  const sendUsage = (usage, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,usage}, {tab:tabs.get(tabId),documentId:`doc-${tabId}`,frameId:0}, resolve));
  const drain = () => new Promise(resolve => setTimeout(resolve, 10));
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
  return { send, sendUsage, observe, before, emit, popup, storage, session, tabs, scopes, documents, registrations, created, focused, click: id => clicked(id), closeTab: id => {tabs.delete(id); removed?.(id);}, writeFailure: v => {failWrite=v;}, notifyFailure: v=>{failNotify=v;} };
}
test("service worker serializes concurrent claims and persists intent", async () => {
  const h = harness();
  await h.send({op:"add",id:"queue-item",text:"queue",running:true});
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
  await restarted.send({op:"add",id:"pending-item",text:"next",running:true});
  await restarted.send({op:"start",userId:"user-b"});
  await restarted.send({op:"settle",userId:"user-b"});
  assert.equal(restarted.created.length,0);
});
test("notification click does not focus a tab reused for another conversation", async () => {
  const h=harness(); await h.send({op:"start",userId:"user-a"}); await h.send({op:"settle",userId:"user-a"});
  h.tabs.set(1,{id:1,windowId:1,url:"https://chatgpt.com/c/other"});
  h.click(h.created[0].id);
  await new Promise(resolve=>setTimeout(resolve,10));
  assert.deepEqual(h.focused,[2]);
});
test("notification OS failure remains deduplicated rather than producing repeats", async () => {
  const h=harness();h.notifyFailure(true);
  await h.send({op:"start",userId:"user-a"});
  const r=await h.send({op:"settle",userId:"user-a"}); assert.equal(r.notificationError,"OS denied");
  h.notifyFailure(false); await h.send({op:"settle",userId:"user-a"}); assert.equal(h.created.length,0);
});
test("stale page mutations are rejected after SPA navigation", async () => {
  const h=harness(); h.tabs.set(1,{id:1,windowId:1,url:"https://chatgpt.com/c/other"});
  assert.equal((await h.send({op:"add",id:"pending-item",text:"wrong conversation"})).ok,false);
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
test("disabled notifications do not create routing records; clicked records are removed", async () => {
  const h=harness({"notice:notifications":false});await h.send({op:"start",userId:"silent"});await h.send({op:"settle",userId:"silent"});
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('notice:notification:')).length,0);
  const active=harness();await active.send({op:"start",userId:"normal"});await active.send({op:"settle",userId:"normal"});active.click(active.created[0].id);await new Promise(r=>setTimeout(r,10));
  assert.equal(Object.keys(active.storage).filter(k=>k.startsWith('notice:notification:')).length,0);
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
