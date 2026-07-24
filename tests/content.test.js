const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor({ text = "", attrs = {}, tag = "div" } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.value = text;
    this.attrs = { ...attrs };
    this.tag = tag;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { width: 100, height: 30 }; }
  closest(selector) { return selector === "button" && this.tag === "button" ? this : null; }
  matches(selector) { return selector.includes("textarea") && this.tag === "textarea"; }
  querySelector() { return null; }
  querySelectorAll() { return []; }
}

const listeners = new Map();
const intervals = [];
const userMessages = [];
const assistantMessages = [];
const composer = new FakeElement({ text: "测试发送", tag: "textarea" });
const sendButton = new FakeElement({ tag: "button", attrs: { "data-testid": "send-button" } });
const document = {
  readyState: "complete",
  documentElement: new FakeElement(),
  addEventListener(type, fn) { if (!listeners.has(type)) listeners.set(type, []); listeners.get(type).push(fn); },
  querySelector(selector) {
    if (selector === "#prompt-textarea" || selector === "textarea[placeholder]") return composer;
    return null;
  },
  querySelectorAll(selector) {
    if (selector.includes('data-message-author-role="user"')) return userMessages;
    if (selector.includes('data-message-author-role="assistant"')) return assistantMessages;
    if (selector === "main button") return [];
    return [];
  }
};
const calls = [];
let taskCounter = 0;
const chrome = {
  runtime: {
    onMessage: { addListener() {} },
    async sendMessage(message) {
      calls.push(message);
      if (message.type === "PAGE_READY") return { ok: true, task: null };
      if (message.type === "TASK_STARTED") return { ok: true, task: { id: `task-${++taskCounter}`, status: "running", startedAt: Date.now(), baselineAssistantHash: message.baselineAssistantHash } };
      if (message.type === "PAGE_CHANGED" || message.type === "PAGE_PROMOTED") return { ok: true, task: null };
      return { ok: true, task: { status: message.status || "running" } };
    }
  }
};
const location = { href: "https://chatgpt.com/", origin: "https://chatgpt.com" };
class MutationObserver { observe() {} }
const context = vm.createContext({
  window: {}, globalThis: null, document, chrome, location, console, URL, Date, Math, Promise,
  Element: FakeElement, MutationObserver,
  getComputedStyle() { return { display: "block", visibility: "visible", opacity: "1" }; },
  setTimeout, clearTimeout,
  setInterval(fn) { intervals.push(fn); return intervals.length; }
});
context.window = context;
context.globalThis = context;
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "content.js"), "utf8"), context, { filename: "content.js" });

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 30));
  const click = listeners.get("click")[0];
  click({ target: sendButton, defaultPrevented: false });
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "TASK_STARTED").length, 0, "click intent alone must not create a task");

  userMessages.push(new FakeElement({ text: "测试发送" }));
  location.href = "https://chatgpt.com/c/new-thread";
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "PAGE_CHANGED").length, 0, "root-to-conversation promotion must not cancel the pending task");
  assert.equal(calls.filter((call) => call.type === "TASK_STARTED").length, 1, "the first task must start after ChatGPT assigns a conversation URL");
  assert.match(calls.find((call) => call.type === "TASK_STARTED").url, /\/c\/new-thread/);

  location.href = "https://chatgpt.com/c/two";
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "PAGE_CHANGED").length, 1, "switching between established conversations must cancel the previous task");

  console.log("content v0.6.2 lifecycle tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
