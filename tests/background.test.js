const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function createEvent() {
  const listeners = [];
  return {
    listeners,
    addListener(fn) { listeners.push(fn); },
    emit(...args) { return Promise.all(listeners.map((fn) => fn(...args))); }
  };
}

const storage = { settings: {}, tasks: {} };
const calls = { tabsCreate: [], tabsUpdate: [], windowsUpdate: [], notifications: [] };
const tabs = new Map([[7, { id: 7, windowId: 3, active: false, url: "https://chatgpt.com/c/test" }]]);
const windows = new Map([[3, { id: 3, focused: false }]]);
const runtimeMessages = createEvent();
const tabRemoved = createEvent();
const tabUpdated = createEvent();

const chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: runtimeMessages,
    getURL(value) { return `chrome-extension://test/${value}`; }
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); }
    }
  },
  tabs: {
    onRemoved: tabRemoved,
    onUpdated: tabUpdated,
    async get(id) {
      if (!tabs.has(id)) throw new Error("tab not found");
      return { ...tabs.get(id) };
    },
    async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
    async update(id, patch) {
      calls.tabsUpdate.push({ id, patch });
      Object.assign(tabs.get(id), patch);
      return { ...tabs.get(id) };
    },
    async create(options) {
      calls.tabsCreate.push(options);
      return { id: 99, windowId: 3, ...options };
    }
  },
  windows: {
    async get(id) {
      if (!windows.has(id)) throw new Error("window not found");
      return { ...windows.get(id) };
    },
    async update(id, patch) {
      calls.windowsUpdate.push({ id, patch });
      Object.assign(windows.get(id), patch);
      return { ...windows.get(id) };
    }
  },
  notifications: {
    onClicked: createEvent(),
    onButtonClicked: createEvent(),
    async create(id, options) { calls.notifications.push({ id, options }); },
    async getPermissionLevel() { return "granted"; }
  }
};

const context = vm.createContext({ chrome, console, crypto: webcrypto, URL, Date, Math, setTimeout, clearTimeout, Promise });
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "background.js"), "utf8"), context, { filename: "background.js" });

async function send(message, tab = tabs.get(7)) {
  return new Promise((resolve, reject) => {
    const listener = runtimeMessages.listeners[0];
    const returned = listener(message, { tab }, (response) => response?.ok === false ? reject(new Error(response.error)) : resolve(response));
    if (returned !== true) reject(new Error("listener must keep response channel open"));
  });
}

(async () => {
  await new Promise((resolve) => setTimeout(resolve, 5));
  const started = await send({
    type: "TASK_STARTED",
    url: "https://chatgpt.com/c/test",
    prompt: "测试任务",
    questionTitle: "测试任务"
  });
  assert.equal(started.task.status, "running");
  assert.equal(started.task.observerMode, "current_page");
  assert.equal(calls.tabsCreate.length, 0, "starting a task must not create a monitor tab");

  await send({
    type: "TASK_STATE",
    taskId: started.task.id,
    status: "completed",
    assistantFirstLine: "执行完成",
    thinkingTimeText: "思考了 3s"
  });
  assert.equal(calls.notifications.length, 1);
  assert.equal(calls.tabsCreate.length, 0, "completion must not create a tab");

  const second = await send({ type: "TASK_STARTED", url: "https://chatgpt.com/c/test", prompt: "关闭测试" });
  tabs.delete(7);
  await tabRemoved.emit(7, { windowId: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(storage.tasks[second.task.id].status, "cancelled");
  assert.equal(storage.tasks[second.task.id].observerMode, "none");
  assert.match(storage.tasks[second.task.id].stopReason, /页面已关闭/);
  assert.equal(calls.tabsCreate.length, 0, "closing a task tab must never recreate it");

  console.log("background v0.6.0 tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
