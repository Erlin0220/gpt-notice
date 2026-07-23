const assert = require("node:assert/strict");
const fs = require("node:fs");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function event() {
  return { addListener() {} };
}

const calls = {
  tabsCreate: 0,
  tabsUpdate: [],
  windowsUpdate: []
};

const storage = { settings: {}, tasks: {} };
const tabs = new Map();
const windows = new Map();

const chrome = {
  runtime: {
    onInstalled: event(),
    onStartup: event(),
    onMessage: event()
  },
  tabs: {
    onRemoved: event(),
    onUpdated: event(),
    async query() { return [...tabs.values()]; },
    async get(id) {
      if (!tabs.has(id)) throw new Error("tab not found");
      return tabs.get(id);
    },
    async update(id, patch) {
      calls.tabsUpdate.push({ id, patch });
      const tab = { ...tabs.get(id), ...patch };
      tabs.set(id, tab);
      return tab;
    },
    async create(options) {
      calls.tabsCreate += 1;
      const tab = { id: 999, windowId: options.windowId || 1, url: options.url, active: options.active };
      tabs.set(tab.id, tab);
      return tab;
    },
    async remove(id) { tabs.delete(id); }
  },
  windows: {
    async get(id) {
      if (!windows.has(id)) throw new Error("window not found");
      return windows.get(id);
    },
    async getAll() { return [...windows.values()]; },
    async update(id, patch) {
      calls.windowsUpdate.push({ id, patch });
      const win = { ...windows.get(id), ...patch };
      windows.set(id, win);
      return win;
    },
    async create(options) {
      const win = { id: 2, type: options.type || "normal", state: options.state || "normal", focused: options.focused };
      const tab = { id: 200, windowId: 2, url: options.url, active: true };
      tabs.set(tab.id, tab);
      windows.set(win.id, win);
      return { ...win, tabs: [tab] };
    },
    async remove(id) { windows.delete(id); }
  },
  notifications: {
    onClicked: event(),
    onButtonClicked: event(),
    async create() {},
    async getPermissionLevel() { return "granted"; }
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
  }
};

const context = vm.createContext({
  chrome,
  console,
  crypto: webcrypto,
  URL,
  setTimeout: (fn) => { fn(); return 1; },
  clearTimeout() {}
});
for (const file of ["../background-events.js", "../background-actions.js", "../background-utils.js"]) {
  vm.runInContext(fs.readFileSync(require.resolve(file), "utf8"), context);
}

assert.equal(
  context.sanitizeChatUrl("https://chat.openai.com/c/abc?utm_source=x#hash"),
  "https://chatgpt.com/c/abc"
);
assert.equal(context.getConversationKey("https://chatgpt.com/g/g-test/c/abc"), "c:abc");
assert.equal(context.sameConversation("https://chatgpt.com/c/abc", "https://chat.openai.com/c/abc"), true);
assert.equal(context.sameConversation("https://chatgpt.com/", "https://chatgpt.com/"), false);
assert.equal(context.samePageUrl("https://chatgpt.com/", "https://chat.openai.com/"), true);

const migrated = context.normalizeTask({ tabId: 5, windowId: 8, isMonitor: true, url: "https://chatgpt.com/c/a" });
assert.deepEqual([...migrated.tabIds], [5]);
assert.equal(migrated.monitorTabId, 5);
assert.equal(migrated.monitorWindowId, 8);

const task = context.normalizeTask({ id: "t1", tabIds: [1, 2], monitorTabId: 2, url: "https://chatgpt.com/c/a" });
const preferred = context.choosePreferredTab([
  { id: 2, active: true, lastAccessed: 20 },
  { id: 1, active: false, lastAccessed: 10 }
], task);
assert.equal(preferred.id, 1, "normal tab should be preferred over monitor tab");

(async () => {
  windows.set(10, { id: 10, type: "normal", state: "normal", focused: false });
  tabs.set(101, { id: 101, windowId: 10, url: "https://chatgpt.com/c/reuse", active: false, lastAccessed: 100 });
  storage.tasks = {
    reuse: context.normalizeTask({
      id: "reuse",
      status: "running",
      url: "https://chatgpt.com/c/reuse",
      tabIds: [101],
      createdAt: 1,
      updatedAt: 1
    })
  };

  await context.openTask("reuse");
  assert.equal(calls.tabsCreate, 0, "opening a task must reuse an existing conversation tab");
  assert.equal(calls.tabsUpdate.at(-1).id, 101);
  assert.equal(calls.windowsUpdate.at(-1).id, 10);
  console.log("background tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
