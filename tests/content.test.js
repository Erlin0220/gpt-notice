const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");

class FakeElement {
  constructor({ text = "", attrs = {}, tag = "div", copyAction = false } = {}) {
    this.innerText = text;
    this.textContent = text;
    this.value = text;
    this.attrs = { ...attrs };
    this.tag = tag;
    this.disabled = false;
    this.hidden = false;
    this.title = "";
    this.copyAction = copyAction;
    this.parentElement = null;
  }
  getAttribute(name) { return this.attrs[name] ?? null; }
  getBoundingClientRect() { return { width: 100, height: 30 }; }
  closest(selector) {
    if (selector === "button" && this.tag === "button") return this;
    if ((selector.includes("article") || selector.includes("conversation-turn")) && this.tag === "article") return this;
    return null;
  }
  matches(selector) { return selector.includes("textarea") && this.tag === "textarea"; }
  querySelector(selector) {
    if (selector.includes("copy-turn-action-button") && this.copyAction) return new FakeElement({ tag: "button", attrs: { "data-testid": "copy-turn-action-button" } });
    return null;
  }
  querySelectorAll() { return []; }
}

const listeners = new Map();
const intervals = [];
const userMessages = [];
const assistantMessages = [];
const composer = new FakeElement({ text: "测试发送", tag: "textarea" });
const sendButton = new FakeElement({ tag: "button", attrs: { id: "composer-submit-button" } });
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
    if (selector.includes('copy-turn-action-button')) return assistantMessages.filter((item) => item.copyAction).map(() => new FakeElement({ tag: "button" }));
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
      if (message.type === "TASK_STARTED") return { ok: true, task: { id: `task-${++taskCounter}`, status: "running", startedAt: Date.now() - 3_000, baselineAssistantHash: message.baselineAssistantHash, baselineCopyActionCount: message.baselineCopyActionCount } };
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

  location.href = "https://chatgpt.com/g/g-p-demo/c/new-thread";
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "PAGE_CHANGED").length, 0, "same conversation id inside a project path must not stop monitoring");

  location.href = "https://chatgpt.com/";
  await intervals[0]();
  location.href = "https://chatgpt.com/g/g-p-demo/c/new-thread";
  await intervals[0]();
  assert.equal(calls.filter((call) => call.type === "PAGE_CHANGED").length, 0, "a short temporary route during tab restoration must be ignored");

  assistantMessages.push(new FakeElement({ text: "复制按钮完成信号", tag: "article", copyAction: true }));
  await intervals[0]();
  assert.equal(calls.filter((call) => call.type === "TASK_STATE" && call.status === "completed").length, 0, "copy action must settle briefly before completion");
  await new Promise((resolve) => setTimeout(resolve, 650));
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "TASK_STATE" && call.status === "completed").length, 1, "a new reply copy action is a high-confidence completion signal");

  composer.value = "第二次发送";
  composer.innerText = "第二次发送";
  composer.textContent = "第二次发送";
  click({ target: sendButton, defaultPrevented: false });
  userMessages.push(new FakeElement({ text: "第二次发送" }));
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "TASK_STARTED").length, 2, "the second message must be confirmed before testing conversation switching");

  location.href = "https://chatgpt.com/c/two";
  await intervals[0]();
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(calls.filter((call) => call.type === "PAGE_CHANGED").length, 1, "switching between established conversations must cancel the previous task");

  console.log("content v0.6.4 lifecycle tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
