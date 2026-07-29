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
const tabs = new Map([[7, { id: 7, windowId: 3, active: false, url: "https://chatgpt.com/" }]]);
const windows = new Map([[3, { id: 3, focused: false }]]);
const runtimeMessages = createEvent();
const tabRemoved = createEvent();
const tabUpdated = createEvent();

const chrome = {
  runtime: {
    onInstalled: createEvent(),
    onStartup: createEvent(),
    onMessage: runtimeMessages,
    getURL(value) { return `chrome-extension://test/${value}`; },
    getManifest() { return { version: "0.7.0", manifest_version: 3 }; }
  },
  storage: {
    local: {
      async get(keys) {
        if (typeof keys === "string") return { [keys]: storage[keys] };
        if (Array.isArray(keys)) return Object.fromEntries(keys.map((key) => [key, storage[key]]));
        return { ...storage };
      },
      async set(values) { Object.assign(storage, values); },
      async remove(keys) {
        for (const key of Array.isArray(keys) ? keys : [keys]) delete storage[key];
      }
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
    async sendMessage(id, message) {
      if (!tabs.has(id)) throw new Error("tab not found");
      if (message.type === "GET_PAGE_SNAPSHOT") return {
        ok: true,
        snapshot: {
          schemaVersion: 1,
          observedAt: Date.now(),
          pageReady: true,
          supportStatus: "supported",
          routeType: "conversation",
          compatibility: "healthy",
          reasonCodes: [],
          capabilities: { canTrackTask: true, canDetectCompletion: true, canAdmitQueue: true, canDispatchQueue: true, canWriteComposer: true, canClickSend: true },
          composer: { exists: true, ready: true, empty: true, textLengthBucket: "empty", visibleCount: 1, ambiguous: false },
          controls: { send: { exists: true, enabled: true }, stopVisible: false, waitingAction: false, busy: false },
          error: { visible: false },
          messages: { userCount: 1, assistantCount: 1, latestAssistantHasCopyAction: true, copyActionCount: 1 }
        }
      };
      return null;
    },
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

const context = vm.createContext({
  chrome, console, crypto: webcrypto, URL, Date, Math, setTimeout, clearTimeout, Promise,
  TextEncoder, navigator: { userAgent: "Mozilla/5.0 Chrome/150.0.0.0", platform: "Win32" }
});
vm.runInContext(fs.readFileSync(path.join(__dirname, "..", "diagnostics.js"), "utf8"), context, { filename: "diagnostics.js" });
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

  const tabContext = await send({ type: "GET_TAB_CONTEXT" });
  assert.equal(tabContext.tabId, 7);
  assert.equal(tabContext.windowId, 3);

  const diagnosticEvent = await send({
    type: "DIAGNOSTIC_EVENT",
    event: { type: "page.compatibility_changed", result: "ok", reasonCode: "healthy", sessionKey: "c:secret", summary: "https://chatgpt.com/c/secret" }
  });
  assert.equal(diagnosticEvent.ok, true);
  assert.equal(storage.diagnosticEventsV1.length, 1);
  assert.ok(!JSON.stringify(storage.diagnosticEventsV1).includes("c:secret"));
  const diagnosticReport = await send({ type: "GET_DIAGNOSTIC_REPORT" });
  assert.equal(diagnosticReport.ok, true);
  assert.equal(diagnosticReport.report.extension.version, "0.7.0");
  assert.equal(diagnosticReport.report.currentPage.compatibility, "healthy");
  assert.ok(!JSON.stringify(diagnosticReport.report).includes("secret"));

  const promotedStart = await send({
    type: "TASK_STARTED",
    url: "https://chatgpt.com/",
    prompt: "新建会话首条任务",
    questionTitle: "新建会话首条任务"
  });
  assert.equal(promotedStart.task.status, "running");
  tabs.get(7).url = "https://chatgpt.com/c/new-thread";
  await tabUpdated.emit(7, { url: tabs.get(7).url }, tabs.get(7));
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(storage.tasks[promotedStart.task.id].status, "running", "draft-to-conversation navigation must keep the active task");
  assert.match(storage.tasks[promotedStart.task.id].url, /\/c\/new-thread/);

  await send({
    type: "TASK_STATE",
    taskId: promotedStart.task.id,
    status: "completed",
    assistantFirstLine: "执行完成",
    thinkingTimeText: "思考了 3s"
  });
  assert.equal(calls.notifications.length, 1);

  tabs.get(7).url = "https://chatgpt.com/c/WEB:4fc9b63f-709a-4831-9b4b-0075d7aa4a1a";
  const provisionalTask = await send({ type: "TASK_STARTED", url: tabs.get(7).url, prompt: "临时 WEB 会话" });
  assert.equal(storage.tasks[provisionalTask.task.id].status, "running");
  assert.ok(storage.tasks[provisionalTask.task.id].urlPromotionExpiresAt > Date.now(), "a provisional WEB route must retain its promotion window");
  tabs.get(7).url = "https://chatgpt.com/c/6a644987-cb58-83ee-a60c-3f34b6cca532";
  const promotedWebReady = await send({ type: "PAGE_READY", url: tabs.get(7).url });
  assert.equal(promotedWebReady.task.id, provisionalTask.task.id, "WEB provisional id promotion must keep the active task");
  assert.equal(storage.tasks[provisionalTask.task.id].status, "running");
  assert.match(storage.tasks[provisionalTask.task.id].url, /6a644987-cb58-83ee-a60c-3f34b6cca532/);
  await send({ type: "TASK_STATE", taskId: provisionalTask.task.id, status: "completed", url: tabs.get(7).url, assistantFirstLine: "WEB 提升完成" });
  assert.equal(calls.tabsCreate.length, 0, "completion must not create a tab");

  tabs.get(7).url = "https://chatgpt.com/c/same-thread";
  const sameTask = await send({ type: "TASK_STARTED", url: tabs.get(7).url, prompt: "同一会话路径变化", baselineCopyActionCount: 4 });
  tabs.get(7).url = "https://chatgpt.com/g/g-p-demo/c/same-thread";
  const sameReady = await send({ type: "PAGE_READY", url: tabs.get(7).url });
  assert.equal(sameReady.task.id, sameTask.task.id, "project path wrappers with the same conversation id must keep monitoring");
  assert.equal(storage.tasks[sameTask.task.id].status, "running");
  assert.equal(storage.tasks[sameTask.task.id].baselineCopyActionCount, 4);
  const transientReady = await send({ type: "PAGE_READY", url: "https://chatgpt.com/" });
  assert.equal(transientReady.task.id, sameTask.task.id, "temporary root routes during tab restoration must not immediately cancel monitoring");
  const transientHeartbeat = await send({ type: "HEARTBEAT", taskId: sameTask.task.id, url: "https://chatgpt.com/" });
  assert.equal(transientHeartbeat.task.id, sameTask.task.id, "a heartbeat from a temporary route must retain the original conversation binding");
  assert.match(storage.tasks[sameTask.task.id].url, /same-thread/);
  await send({ type: "TASK_STATE", taskId: sameTask.task.id, status: "completed", url: tabs.get(7).url, assistantFirstLine: "完成" });

  tabs.get(7).url = "https://chatgpt.com/c/old";
  const oldTask = await send({ type: "TASK_STARTED", url: tabs.get(7).url, prompt: "旧会话" });
  tabs.get(7).url = "https://chatgpt.com/c/new";
  const readyOnDifferentConversation = await send({ type: "PAGE_READY", url: tabs.get(7).url });
  assert.equal(readyOnDifferentConversation.task, null, "PAGE_READY must not rebind an old task to a different conversation");
  assert.equal(storage.tasks[oldTask.task.id].status, "cancelled");
  assert.match(storage.tasks[oldTask.task.id].stopReason, /其他 ChatGPT 会话/);

  const navigationTask = await send({ type: "TASK_STARTED", url: "https://chatgpt.com/c/new", prompt: "切换会话" });
  await send({ type: "PAGE_CHANGED", url: "https://chatgpt.com/c/next", reason: "切换会话" });
  assert.equal(storage.tasks[navigationTask.task.id].status, "cancelled");
  assert.match(storage.tasks[navigationTask.task.id].stopReason, /切换会话/);

  await assert.rejects(() => send({ type: "TASK_STATE", taskId: navigationTask.task.id, status: "unknown" }), /Invalid task status|Task not found/);

  tabs.get(7).url = "https://chatgpt.com/c/close";
  const second = await send({ type: "TASK_STARTED", url: tabs.get(7).url, prompt: "关闭测试" });
  storage.messageQueueIndexV3 = {
    "tab:7:page-7:c:close": { ownerTabId: 7, items: [{ id: "queued-close" }] },
    "tab:8:page-8:c:close": { ownerTabId: 8, items: [{ id: "queued-other" }] }
  };
  storage["messageQueueItemV3:queued-close"] = "close me";
  storage["messageQueueItemV3:queued-other"] = "keep me";
  storage.messageQueueConversationLeasesV1 = {
    "c:close": { ownerTabId: 7, ownerInstanceId: "page-7", ownerQueueKey: "tab:7:page-7:c:close", expiresAt: Date.now() + 60_000 },
    "c:other": { ownerTabId: 8, ownerInstanceId: "page-8", ownerQueueKey: "tab:8:page-8:c:other", expiresAt: Date.now() + 60_000 }
  };
  tabs.delete(7);
  await tabRemoved.emit(7, { windowId: 3 });
  await new Promise((resolve) => setTimeout(resolve, 5));
  assert.equal(storage.tasks[second.task.id].status, "cancelled");
  assert.equal(storage.tasks[second.task.id].observerMode, "none");
  assert.match(storage.tasks[second.task.id].stopReason, /页面已关闭/);
  assert.equal(calls.tabsCreate.length, 0, "closing a task tab must never recreate it");
  assert.equal(storage.messageQueueIndexV3["tab:7:page-7:c:close"], undefined, "closed tab queue metadata must be removed");
  assert.ok(storage.messageQueueIndexV3["tab:8:page-8:c:close"], "another tab queue must remain intact");
  assert.equal(storage["messageQueueItemV3:queued-close"], undefined, "closed tab queue text must be removed");
  assert.equal(storage["messageQueueItemV3:queued-other"], "keep me");
  assert.equal(storage.messageQueueConversationLeasesV1["c:close"], undefined, "closed tab lease must be released");
  assert.ok(storage.messageQueueConversationLeasesV1["c:other"]);

  console.log("background v0.7.0 tests passed");
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
