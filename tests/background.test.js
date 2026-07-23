const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const vm = require("node:vm");
const { webcrypto } = require("node:crypto");

function createEvent() {
  const listeners = [];
  return {
    addListener(fn) { listeners.push(fn); },
    async emit(...args) {
      for (const fn of listeners) await fn(...args);
    },
    listeners
  };
}

const calls = {
  tabsCreate: [],
  tabsUpdate: [],
  tabsRemove: [],
  tabsReload: [],
  tabsGroup: [],
  tabsUngroup: [],
  windowsCreate: [],
  windowsUpdate: [],
  notifications: [],
  alarmsCreate: []
};

const storage = { settings: {}, tasks: {}, meta: {} };
const tabs = new Map();
const windows = new Map();
const groups = new Map();
const alarms = new Map();
let nextTabId = 100;
let nextWindowId = 10;
let nextGroupId = 1;

function addWindow(win) {
  windows.set(win.id, { type: "normal", state: "normal", focused: false, ...win });
}
function addTab(tab) {
  const value = { active: false, mutedInfo: { muted: false }, autoDiscardable: true, groupId: -1, discarded: false, ...tab };
  tabs.set(value.id, value);
  return value;
}
function populateWindow(win) {
  return { ...win, tabs: [...tabs.values()].filter((tab) => tab.windowId === win.id) };
}

const chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: createEvent(),
    getURL(file) { return `chrome-extension://test/${file}`; }
  },
  tabs: {
    onRemoved: createEvent(),
    onUpdated: createEvent(),
    onActivated: createEvent(),
    async get(id) {
      if (!tabs.has(id)) throw new Error("tab not found");
      return { ...tabs.get(id) };
    },
    async query() { return [...tabs.values()].map((tab) => ({ ...tab })); },
    async create(options) {
      calls.tabsCreate.push({ ...options });
      const tab = addTab({
        id: nextTabId++,
        windowId: options.windowId,
        url: options.url,
        active: Boolean(options.active),
        index: options.index ?? 0,
        lastAccessed: Date.now()
      });
      if (tab.active) {
        for (const item of tabs.values()) {
          if (item.windowId === tab.windowId && item.id !== tab.id) item.active = false;
        }
      }
      return { ...tab };
    },
    async update(id, patch) {
      calls.tabsUpdate.push({ id, patch: { ...patch } });
      if (!tabs.has(id)) throw new Error("tab not found");
      const tab = tabs.get(id);
      if (Object.prototype.hasOwnProperty.call(patch, "muted")) tab.mutedInfo = { muted: patch.muted };
      Object.assign(tab, patch);
      if (patch.active) {
        for (const item of tabs.values()) {
          if (item.windowId === tab.windowId && item.id !== id) item.active = false;
        }
      }
      return { ...tab };
    },
    async remove(ids) {
      for (const id of Array.isArray(ids) ? ids : [ids]) {
        calls.tabsRemove.push(id);
        tabs.delete(id);
        for (const [groupId, group] of groups) {
          group.tabIds = group.tabIds.filter((tabId) => tabId !== id);
          if (!group.tabIds.length) groups.delete(groupId);
        }
      }
    },
    async reload(id) {
      calls.tabsReload.push(id);
      if (!tabs.has(id)) throw new Error("tab not found");
      tabs.get(id).discarded = false;
    },
    async group({ tabIds, groupId }) {
      calls.tabsGroup.push({ tabIds: [...tabIds], groupId });
      const id = Number.isInteger(groupId) ? groupId : nextGroupId++;
      if (!groups.has(id)) {
        const first = tabs.get(tabIds[0]);
        groups.set(id, { id, windowId: first.windowId, title: "", color: "grey", collapsed: false, tabIds: [] });
      }
      const group = groups.get(id);
      for (const tabId of tabIds) {
        if (!group.tabIds.includes(tabId)) group.tabIds.push(tabId);
        tabs.get(tabId).groupId = id;
      }
      return id;
    },
    async ungroup(tabIds) {
      calls.tabsUngroup.push([...tabIds]);
      for (const tabId of tabIds) {
        const tab = tabs.get(tabId);
        if (!tab) continue;
        const group = groups.get(tab.groupId);
        if (group) {
          group.tabIds = group.tabIds.filter((id) => id !== tabId);
          if (!group.tabIds.length) groups.delete(group.id);
        }
        tab.groupId = -1;
      }
    },
    async sendMessage(id) {
      const tab = tabs.get(id);
      if (!tab || tab.probeError) throw new Error("no receiver");
      return tab.probe || { ok: true, url: tab.url, latestAssistantHash: "", completed: false };
    }
  },
  windows: {
    onRemoved: createEvent(),
    async get(id) {
      if (!windows.has(id)) throw new Error("window not found");
      return { ...windows.get(id) };
    },
    async getAll(options = {}) {
      const list = [...windows.values()].filter((win) => !options.windowTypes || options.windowTypes.includes(win.type));
      return list.map((win) => options.populate ? populateWindow(win) : { ...win });
    },
    async update(id, patch) {
      calls.windowsUpdate.push({ id, patch: { ...patch } });
      if (!windows.has(id)) throw new Error("window not found");
      Object.assign(windows.get(id), patch);
      return { ...windows.get(id) };
    },
    async create(options) {
      calls.windowsCreate.push({ ...options });
      const win = { id: nextWindowId++, type: options.type || "normal", state: options.state || "normal", focused: Boolean(options.focused) };
      addWindow(win);
      const tab = addTab({ id: nextTabId++, windowId: win.id, url: options.url, active: true });
      return { ...win, tabs: [{ ...tab }] };
    },
    async remove(id) {
      windows.delete(id);
      for (const tab of [...tabs.values()]) if (tab.windowId === id) tabs.delete(tab.id);
    }
  },
  tabGroups: {
    async get(id) {
      if (!groups.has(id)) throw new Error("group not found");
      return { ...groups.get(id) };
    },
    async query({ windowId } = {}) {
      return [...groups.values()].filter((group) => windowId == null || group.windowId === windowId).map((group) => ({ ...group }));
    },
    async update(id, patch) {
      if (!groups.has(id)) throw new Error("group not found");
      Object.assign(groups.get(id), patch);
      return { ...groups.get(id) };
    }
  },
  notifications: {
    onClicked: createEvent(),
    onButtonClicked: createEvent(),
    async create(id, options) { calls.notifications.push({ id, options }); },
    async getPermissionLevel() { return "granted"; }
  },
  storage: {
    onChanged: createEvent(),
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); }
    }
  },
  alarms: {
    onAlarm: createEvent(),
    async get(name) { return alarms.get(name) || null; },
    create(name, options) {
      calls.alarmsCreate.push({ name, options });
      alarms.set(name, { name, ...options });
    }
  }
};

const context = vm.createContext({
  chrome,
  console,
  crypto: webcrypto,
  URL,
  Date,
  Math,
  setTimeout,
  clearTimeout,
  setInterval,
  clearInterval
});

for (const file of [
  "background-utils.js",
  "background-tab-groups.js",
  "background-monitor-tabs.js",
  "background-watchdog.js",
  "background-actions.js",
  "background-queue.js",
  "background-events.js"
]) {
  vm.runInContext(fs.readFileSync(path.join(__dirname, "..", file), "utf8"), context, { filename: file });
}

const DEFAULT_SETTINGS = vm.runInContext("DEFAULT_SETTINGS", context);
const STORAGE_SCHEMA_VERSION = vm.runInContext("STORAGE_SCHEMA_VERSION", context);

function resetRuntimeState() {
  storage.settings = { ...DEFAULT_SETTINGS };
  storage.tasks = {};
  storage.meta = {};
  storage.messageQueues = {};
  storage.queueObserverTabs = {};
  tabs.clear();
  windows.clear();
  groups.clear();
  alarms.clear();
  nextTabId = 100;
  nextWindowId = 10;
  nextGroupId = 1;
  for (const key of Object.keys(calls)) calls[key].length = 0;
  addWindow({ id: 1, focused: true });
}

async function flush() {
  await new Promise((resolve) => setTimeout(resolve, 10));
}

(async () => {
  await flush();
  resetRuntimeState();

  assert.equal(context.sanitizeChatUrl("https://chat.openai.com/c/abc?utm_source=x#hash"), "https://chatgpt.com/c/abc");
  assert.equal(context.sameConversation("https://chatgpt.com/c/abc", "https://chat.openai.com/c/abc"), true);

  const migrated = context.normalizeTask({
    id: "legacy",
    status: "running",
    tabId: 5,
    windowId: 8,
    isMonitor: true,
    url: "https://chatgpt.com/c/a"
  });
  assert.equal(migrated.monitorTabId, 5);
  assert.equal(migrated.monitorWindowId, 8);
  assert.equal(migrated.observerMode, "group_tab");

  storage.tasks = {
    create: context.normalizeTask({
      id: "create",
      status: "running",
      url: "https://chatgpt.com/c/create",
      startedAt: Date.now()
    })
  };
  await context.ensureTaskObserver("create", 1);
  const createdTask = storage.tasks.create;
  assert.equal(calls.tabsCreate.length, 1);
  assert.equal(calls.tabsCreate[0].active, false, "monitor tab must never steal focus");
  assert.equal(calls.windowsCreate.length, 0, "monitoring must not create a new window");
  assert.ok(createdTask.monitorTabId);
  assert.ok(createdTask.monitorGroupId);
  assert.equal(groups.get(createdTask.monitorGroupId).collapsed, true);
  assert.equal(groups.get(createdTask.monitorGroupId).title, "GPT 后台");
  const monitorTab = tabs.get(createdTask.monitorTabId);
  assert.equal(monitorTab.mutedInfo.muted, true);
  assert.equal(monitorTab.autoDiscardable, false);

  storage.tasks.second = context.normalizeTask({
    id: "second",
    status: "running",
    url: "https://chatgpt.com/c/second",
    startedAt: Date.now()
  });
  await context.ensureTaskObserver("second", 1);
  assert.equal(groups.size, 1, "multiple tasks in one window must reuse one group");

  resetRuntimeState();
  const normal = addTab({ id: 10, windowId: 1, url: "https://chatgpt.com/c/reuse", active: false, lastAccessed: 10 });
  storage.tasks.reuse = context.normalizeTask({
    id: "reuse",
    status: "running",
    url: normal.url,
    startedAt: Date.now()
  });
  await context.ensureTaskObserver("reuse", 1);
  assert.equal(calls.tabsCreate.length, 0, "existing conversation tab must be reused");
  assert.deepEqual([...storage.tasks.reuse.normalTabIds], [10]);

  const preferred = context.choosePreferredTab([
    { id: 20, active: true, lastAccessed: 20 },
    { id: 10, active: false, lastAccessed: 10 }
  ], context.normalizeTask({ id: "p", monitorTabId: 20, normalTabIds: [10] }));
  assert.equal(preferred.id, 10, "normal tab must be preferred over monitor tab");

  resetRuntimeState();
  const groupedTab = addTab({ id: 30, windowId: 1, url: "https://chatgpt.com/c/promote", groupId: 3 });
  groups.set(3, { id: 3, windowId: 1, title: "GPT 后台", color: "grey", collapsed: true, tabIds: [30] });
  storage.tasks.promote = context.normalizeTask({
    id: "promote",
    status: "running",
    url: groupedTab.url,
    monitorTabId: 30,
    monitorGroupId: 3,
    monitorWindowId: 1,
    cleanupAt: Date.now() + 30_000
  });
  await context.promoteMonitorTab("promote", { focus: false });
  assert.equal(storage.tasks.promote.monitorTabId, null);
  assert.deepEqual([...storage.tasks.promote.normalTabIds], [30]);
  assert.equal(storage.tasks.promote.cleanupAt, 0);
  assert.equal(tabs.get(30).groupId, -1);
  assert.equal(tabs.get(30).mutedInfo.muted, false);

  resetRuntimeState();
  const cleanupTab = addTab({ id: 40, windowId: 1, url: "https://chatgpt.com/c/cleanup" });
  storage.tasks.cleanup = context.normalizeTask({
    id: "cleanup",
    status: "completed",
    url: cleanupTab.url,
    monitorTabId: 40,
    monitorWindowId: 1,
    finishedAt: Date.now()
  });
  let state = await context.readState();
  await context.scheduleMonitorCleanup(state, state.tasks.cleanup, 30_000);
  assert.ok(storage.tasks.cleanup.cleanupAt > Date.now());
  storage.tasks.cleanup.cleanupAt = Date.now() - 1;
  await context.runWatchdog();
  assert.equal(tabs.has(40), false, "expired completed monitor tab must be removed");

  resetRuntimeState();
  const notifyTab = addTab({ id: 50, windowId: 1, url: "https://chatgpt.com/c/notify" });
  storage.tasks.notify = context.normalizeTask({
    id: "notify",
    status: "completed",
    title: "执行全部开发计划",
    prompt: "执行全部开发计划",
    url: notifyTab.url,
    thinkingTimeText: "思考了 37m 51s",
    assistantFirstLine: "计划已执行完成，v0.4.0 已推送到 GitHub。",
    finishedAt: Date.now()
  });
  await context.maybeNotify(storage.tasks.notify, storage.settings);
  const notification = calls.notifications.at(-1).options;
  assert.equal(notification.title, "执行全部开发计划");
  assert.equal(notification.message, "思考了 37m 51s，计划已执行完成，v0.4.0 已推送到 GitHub。");

  resetRuntimeState();
  const existingTab = addTab({ id: 60, windowId: 1, url: "https://chatgpt.com/c/open", active: false });
  storage.tasks.open = context.normalizeTask({
    id: "open",
    status: "running",
    url: existingTab.url,
    normalTabIds: [60]
  });
  await context.openTask("open");
  assert.equal(calls.tabsCreate.length, 0);
  assert.equal(calls.tabsUpdate.at(-1).id, 60);

  resetRuntimeState();
  const discarded = addTab({ id: 70, windowId: 1, url: "https://chatgpt.com/c/discarded", discarded: true, active: false, probeError: true });
  storage.tasks.discarded = context.normalizeTask({
    id: "discarded",
    status: "running",
    url: discarded.url,
    monitorTabId: 70,
    monitorWindowId: 1,
    lastHeartbeatAt: Date.now() - 60_000
  });
  await context.runWatchdog();
  assert.deepEqual(calls.tabsReload, [70], "discarded monitor tab should be reloaded by watchdog");

  resetRuntimeState();
  storage.tasks.lost = context.normalizeTask({
    id: "lost",
    status: "running",
    url: "https://chatgpt.com/c/lost",
    recoveryCount: 3,
    recoveryWindowStartedAt: Date.now(),
    lastHeartbeatAt: 0
  });
  const lostState = await context.readState();
  await context.recoverTaskObserver(lostState, lostState.tasks.lost, null);
  assert.equal(storage.tasks.lost.status, "observer_lost");

  resetRuntimeState();
  await context.ensureWatchdogAlarm();
  assert.equal(calls.alarmsCreate.length, 1);
  assert.equal(calls.alarmsCreate[0].options.periodInMinutes, 0.5);

  resetRuntimeState();
  const manual = addTab({ id: 80, windowId: 1, url: "https://chatgpt.com/c/manual" });
  storage.tasks.manual = context.normalizeTask({
    id: "manual",
    status: "running",
    url: manual.url,
    monitorTabId: 80,
    monitorWindowId: 1
  });
  tabs.delete(80);
  await context.handleTabRemoved(80, { windowId: 1, isWindowClosing: false });
  assert.equal(storage.tasks.manual.status, "monitor_stopped");
  assert.equal(calls.tabsCreate.length, 0, "manually closed monitor must not immediately respawn");

  resetRuntimeState();
  const autoPromote = addTab({ id: 90, windowId: 1, url: "https://chatgpt.com/c/activate", groupId: 9 });
  groups.set(9, { id: 9, windowId: 1, title: "GPT 后台", color: "grey", collapsed: true, tabIds: [90] });
  storage.tasks.activate = context.normalizeTask({
    id: "activate",
    status: "running",
    url: autoPromote.url,
    monitorTabId: 90,
    monitorGroupId: 9,
    monitorWindowId: 1
  });
  await context.handleTabActivated(90);
  assert.equal(storage.tasks.activate.observerMode, "normal_tab", "activating a monitor tab should promote it");

  resetRuntimeState();
  storage.messageQueues = {
    "c:queue-handoff": {
      conversationUrl: "https://chatgpt.com/g/g-p-demo/c/queue-handoff",
      paused: false,
      activeItemId: null,
      items: [{ id: "queued-1", text: "next prompt", status: "pending" }]
    }
  };
  await context.reconcileQueueObservers();
  const queueObserver = storage.queueObserverTabs["c:queue-handoff"];
  assert.ok(queueObserver?.tabId, "an unfinished queue must create a background observer after navigation");
  assert.equal(calls.tabsCreate.length, 1);
  assert.equal(calls.tabsCreate[0].url, "https://chatgpt.com/g/g-p-demo/c/queue-handoff");
  assert.equal(calls.tabsCreate[0].active, false, "queue observer must not steal focus");
  assert.equal(tabs.get(queueObserver.tabId).autoDiscardable, false);
  assert.equal(tabs.get(queueObserver.tabId).mutedInfo.muted, true);

  storage.messageQueues["c:queue-handoff"].items[0].status = "completed";
  await context.reconcileQueueObservers();
  assert.ok(storage.queueObserverTabs["c:queue-handoff"].cleanupAt > Date.now());
  storage.queueObserverTabs["c:queue-handoff"].cleanupAt = Date.now() - 1;
  await context.reconcileQueueObservers();
  assert.equal(tabs.has(queueObserver.tabId), false, "completed queue observer must be removed after the grace period");

  resetRuntimeState();
  addTab({
    id: 95,
    windowId: 1,
    url: "https://chatgpt.com/g/g-p-demo/c/project-chat",
    active: false,
    lastAccessed: Date.now()
  });
  storage.messageQueues = {
    "c:project-chat": {
      conversationUrl: "https://chatgpt.com/g/g-p-demo/c/project-chat",
      paused: false,
      activeItemId: null,
      items: [{ id: "queued-project", text: "project next", status: "pending" }]
    }
  };
  await context.reconcileQueueObservers();
  assert.equal(calls.tabsCreate.length, 0, "an existing project conversation tab must be reused");
  const existingObserver = storage.queueObserverTabs["c:project-chat"];
  assert.equal(existingObserver.managed, false, "a user tab must be tracked without becoming an extension-managed tab");
  assert.equal(tabs.get(95).autoDiscardable, false, "a reused tab must be protected from Memory Saver while the queue is active");
  assert.equal(tabs.get(95).mutedInfo.muted, false, "a reused user tab must not be muted");

  storage.messageQueues["c:project-chat"].items[0].status = "completed";
  await context.reconcileQueueObservers();
  storage.queueObserverTabs["c:project-chat"].cleanupAt = Date.now() - 1;
  await context.reconcileQueueObservers();
  assert.equal(tabs.has(95), true, "a reused user tab must never be closed by queue cleanup");
  assert.equal(tabs.get(95).autoDiscardable, true, "a reused tab must return to the browser default after queue cleanup");

  resetRuntimeState();
  addTab({
    id: 96,
    windowId: 1,
    url: "https://chatgpt.com/c/discarded-queue-tab",
    active: false,
    discarded: true,
    lastAccessed: Date.now()
  });
  storage.messageQueues = {
    "c:discarded-queue-tab": {
      conversationUrl: "https://chatgpt.com/c/discarded-queue-tab",
      paused: false,
      activeItemId: null,
      items: [{ id: "queued-discarded", text: "resume", status: "pending" }]
    }
  };
  await context.reconcileQueueObservers();
  assert.deepEqual(calls.tabsReload, [96], "a discarded reused tab must be reloaded so its queue can continue");
  assert.equal(calls.tabsCreate.length, 0);

  resetRuntimeState();
  const promotedQueueTab = addTab({
    id: 97,
    windowId: 1,
    url: "https://chatgpt.com/c/promoted-queue-tab",
    active: false,
    groupId: 11
  });
  groups.set(11, { id: 11, windowId: 1, title: "GPT 后台", color: "grey", collapsed: true, tabIds: [97] });
  storage.queueObserverTabs = {
    "c:promoted-queue-tab": {
      tabId: 97,
      windowId: 1,
      groupId: 11,
      url: promotedQueueTab.url,
      createdAt: Date.now(),
      cleanupAt: 0,
      managed: true
    }
  };
  await context.promoteQueueObserverTab(97);
  assert.equal(storage.queueObserverTabs["c:promoted-queue-tab"].managed, false);
  assert.equal(tabs.get(97).groupId, -1, "an activated queue observer must become a normal tab");
  assert.equal(tabs.get(97).mutedInfo.muted, false);
  assert.equal(tabs.get(97).autoDiscardable, false, "a promoted tab remains protected while its queue may still be active");

  resetRuntimeState();
  storage.messageQueues = {
    "c:paused": {
      conversationUrl: "https://chatgpt.com/c/paused",
      paused: true,
      activeItemId: null,
      items: [{ id: "queued-paused", text: "paused next", status: "pending" }]
    }
  };
  await context.reconcileQueueObservers();
  assert.equal(calls.tabsCreate.length, 0, "a paused pending queue must not create a background observer");
  assert.equal(STORAGE_SCHEMA_VERSION, 2);
  console.log("background and queue observer tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
