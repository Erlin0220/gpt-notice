const { test } = require("node:test");
const assert = require("node:assert/strict");
const vm = require("node:vm");
const fs = require("node:fs");
const path = require("node:path");
const Q = require("../queue-core");
const U = require("../usage-core");
const scope = "a".repeat(64);
function harness(storage = {}) {
  const created = [], focused = [], tabs = new Map([[1,{id:1,windowId:1,url:"https://chatgpt.com/c/a"}],[2,{id:2,windowId:1,url:"https://chatgpt.com/c/a"}]]);
  const session = {};
  let listener, clicked, webListener, removed, failWrite = false, failNotify = false;
  const clone = value => structuredClone(value);
  const store = target => ({
    async get(keys) { if (keys === null) return clone(target); const names = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(names.filter(k => k in target).map(k => [k,clone(target[k])])); },
    async set(values) { Object.assign(target,clone(values)); },
    async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete target[key]; }
  });
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, getURL: p => p },
    storage: { local: { ...store(storage), async set(values) { if (failWrite) throw new Error("disk full"); Object.assign(storage,clone(values)); } }, session: store(session) },
    webRequest: { onBeforeRequest: { addListener(fn) { webListener = fn; } } },
    notifications: { onClicked: { addListener(fn) { clicked = fn; } }, onButtonClicked: { addListener() {} }, onClosed: { addListener() {} }, async create(id, value) { if (failNotify) throw new Error("OS denied"); created.push({id,...value}); }, async clear() {} },
    tabs: { onRemoved: { addListener(fn) { removed = fn; } }, async get(id) { return tabs.get(id); }, async query() { return [...tabs.values()]; }, async update(id) { focused.push(id); }, async create(value) { focused.push(value.url); } },
    windows: { async update() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../background.js"),"utf8"), { chrome, importScripts() {}, ChatGPTQueueCore: Q, ChatGPTUsage: U, Date, TextDecoder, console });
  const send = (command, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,command}, {tab:tabs.get(tabId),documentId:`doc-${tabId}`}, resolve));
  const sendUsage = (usage, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,usage}, {tab:tabs.get(tabId),documentId:`doc-${tabId}`}, resolve));
  const observe = async (body, tabId = 1) => {
    const bytes = new TextEncoder().encode(JSON.stringify(body)).buffer;
    webListener({ tabId, method:"POST", url:"https://chatgpt.com/backend-api/f/conversation", requestBody:{raw:[{bytes}]}, timeStamp:Date.now() });
    await new Promise(resolve => setTimeout(resolve, 5));
  };
  return { send, sendUsage, observe, storage, session, tabs, created, focused, click: id => clicked(id), closeTab: id => {tabs.delete(id); removed?.(id);}, writeFailure: v => {failWrite=v;}, notifyFailure: v=>{failNotify=v;} };
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
