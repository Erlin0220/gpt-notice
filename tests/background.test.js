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
  let listener, clicked, failWrite = false, failNotify = false;
  const clone = value => structuredClone(value);
  const chrome = {
    runtime: { onMessage: { addListener(fn) { listener = fn; } }, getURL: p => p },
    storage: { local: { async get(keys) { if (keys === null) return clone(storage); const names = Array.isArray(keys) ? keys : [keys]; return Object.fromEntries(names.filter(k => k in storage).map(k => [k,clone(storage[k])])); }, async set(values) { if (failWrite) throw new Error("disk full"); Object.assign(storage,clone(values)); }, async remove(keys) { for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key]; } } },
    notifications: { onClicked: { addListener(fn) { clicked = fn; } }, onButtonClicked: { addListener() {} }, onClosed: { addListener() {} }, async create(id, value) { if (failNotify) throw new Error("OS denied"); created.push({id,...value}); }, async clear() {} },
    tabs: { async get(id) { return tabs.get(id); }, async query() { return [...tabs.values()]; }, async update(id) { focused.push(id); }, async create(value) { focused.push(value.url); } },
    windows: { async update() {} }
  };
  vm.runInNewContext(fs.readFileSync(path.join(__dirname,"../background.js"),"utf8"), { chrome, importScripts() {}, ChatGPTQueueCore: Q, ChatGPTUsage: U, Date, console });
  const send = (command, tabId = 1) => new Promise(resolve => listener({type:"NOTICE",scope,url:"https://chatgpt.com/c/a",instance:`instance-${tabId}`,command}, {tab:tabs.get(tabId),documentId:`doc-${tabId}`}, resolve));
  return { send, storage, tabs, created, focused, click: id => clicked(id), writeFailure: v => {failWrite=v;}, notifyFailure: v=>{failNotify=v;} };
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
test("disabled notifications do not create routing records; clicked records are removed", async () => {
  const h=harness({"notice:notifications":false});await h.send({op:"start",userId:"silent"});await h.send({op:"settle",userId:"silent"});
  assert.equal(Object.keys(h.storage).filter(k=>k.startsWith('notice:notification:')).length,0);
  const active=harness();await active.send({op:"start",userId:"normal"});await active.send({op:"settle",userId:"normal"});active.click(active.created[0].id);await new Promise(r=>setTimeout(r,10));
  assert.equal(Object.keys(active.storage).filter(k=>k.startsWith('notice:notification:')).length,0);
});
