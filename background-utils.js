const STORAGE_KEYS = {
  SETTINGS: "settings",
  TASKS: "tasks",
  META: "meta"
};

const STORAGE_SCHEMA_VERSION = 2;
const WATCHDOG_ALARM = "chatgpt-task-watchdog";
const MONITOR_GROUP_TITLE = "GPT 后台";
const NOTIFICATION_ICON = "icons/chatgpt.png";
const CHAT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];

const ACTIVE_STATUSES = new Set(["running", "waiting_action"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const RESTARTABLE_STATUSES = new Set(["observer_lost", "monitor_stopped"]);
const MAX_TASK_HISTORY = 40;
const HEARTBEAT_STALE_MS = 45_000;
const RECOVERY_WINDOW_MS = 10 * 60_000;
const MAX_RECOVERY_COUNT = 3;
const RECOVERY_BACKOFF_MS = [5_000, 20_000, 60_000];

const DEFAULT_SETTINGS = {
  autoKeepAlive: true,
  backgroundMonitorMode: "tab_group",
  autoRecoverDiscardedTab: true,
  autoRecoverManuallyClosedMonitor: false,
  closeMonitorWhenDone: true,
  completedTabGraceSeconds: 30,
  notifyCompleted: true,
  notifyAttention: true,
  notifyFailed: true,
  notifyWhenFocused: false
};

let mutationQueue = Promise.resolve();

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function readState() {
  const result = await chrome.storage.local.get([
    STORAGE_KEYS.SETTINGS,
    STORAGE_KEYS.TASKS,
    STORAGE_KEYS.META
  ]);
  const tasks = Object.fromEntries(
    Object.entries(result.tasks || {}).map(([id, task]) => [id, normalizeTask({ ...task, id })])
  );
  return {
    settings: { ...DEFAULT_SETTINGS, ...(result.settings || {}) },
    tasks,
    meta: {
      storageSchemaVersion: STORAGE_SCHEMA_VERSION,
      ...(result.meta || {})
    }
  };
}

async function readSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function writeTasks(tasks) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: tasks });
}

async function writeState(state) {
  await chrome.storage.local.set({
    [STORAGE_KEYS.SETTINGS]: state.settings,
    [STORAGE_KEYS.TASKS]: state.tasks,
    [STORAGE_KEYS.META]: {
      ...(state.meta || {}),
      storageSchemaVersion: STORAGE_SCHEMA_VERSION
    }
  });
}

async function migrateStoredState() {
  return enqueueMutation(async () => {
    const state = await readState();
    state.settings = { ...DEFAULT_SETTINGS, ...state.settings };
    state.meta.storageSchemaVersion = STORAGE_SCHEMA_VERSION;
    state.tasks = pruneTasks(state.tasks);
    await writeState(state);
    return state;
  });
}

function normalizeTask(task = {}) {
  const now = Date.now();
  const legacyMonitorTabId = Number.isInteger(task.monitorTabId)
    ? task.monitorTabId
    : task.isMonitor && Number.isInteger(task.tabId)
      ? task.tabId
      : null;

  const normalTabIds = new Set(
    Array.isArray(task.normalTabIds)
      ? task.normalTabIds.filter(Number.isInteger)
      : []
  );

  for (const tabId of Array.isArray(task.tabIds) ? task.tabIds : []) {
    if (Number.isInteger(tabId) && tabId !== legacyMonitorTabId) normalTabIds.add(tabId);
  }
  if (Number.isInteger(task.tabId) && task.tabId !== legacyMonitorTabId) normalTabIds.add(task.tabId);

  const url = sanitizeChatUrl(task.url || "https://chatgpt.com/");
  const status = task.status || "cancelled";
  const monitorTabId = legacyMonitorTabId;
  const derivedObserverMode = monitorTabId
    ? "group_tab"
    : normalTabIds.size
      ? "normal_tab"
      : ACTIVE_STATUSES.has(status)
        ? "lost"
        : "none";

  const normalized = {
    id: task.id || createTaskId(),
    status,
    url,
    conversationKey: task.conversationKey || getConversationKey(url),
    title: cleanText(task.title || task.prompt || "ChatGPT 任务", 80),
    prompt: cleanText(task.prompt || "ChatGPT 任务", 160),
    baselineAssistantHash: task.baselineAssistantHash || "",
    latestAssistantHash: task.latestAssistantHash || "",
    assistantFirstLine: cleanText(task.assistantFirstLine || "", 240),
    thinkingTimeText: cleanText(task.thinkingTimeText || "", 60),
    normalTabIds: [...normalTabIds],
    monitorTabId,
    monitorGroupId: Number.isInteger(task.monitorGroupId) ? task.monitorGroupId : null,
    monitorWindowId: Number.isInteger(task.monitorWindowId)
      ? task.monitorWindowId
      : task.isMonitor && Number.isInteger(task.windowId)
        ? task.windowId
        : null,
    lastKnownWindowId: Number.isInteger(task.lastKnownWindowId)
      ? task.lastKnownWindowId
      : Number.isInteger(task.windowId)
        ? task.windowId
        : Number.isInteger(task.monitorWindowId)
          ? task.monitorWindowId
          : null,
    observerMode: task.observerMode || derivedObserverMode,
    monitorCreating: Boolean(task.monitorCreating),
    monitorExpected: Boolean(task.monitorExpected),
    manualMonitorClosed: Boolean(task.manualMonitorClosed),
    observerLostReason: cleanText(task.observerLostReason || "", 160),
    createdAt: Number(task.createdAt || now),
    startedAt: Number(task.startedAt || task.createdAt || now),
    updatedAt: Number(task.updatedAt || now),
    finishedAt: task.finishedAt ? Number(task.finishedAt) : null,
    lastHeartbeatAt: Number(task.lastHeartbeatAt || task.updatedAt || 0),
    lastProbeAt: Number(task.lastProbeAt || 0),
    lastContentChangeAt: Number(task.lastContentChangeAt || task.updatedAt || 0),
    recoveryCount: Number(task.recoveryCount || 0),
    recoveryWindowStartedAt: Number(task.recoveryWindowStartedAt || 0),
    nextRecoveryAt: Number(task.nextRecoveryAt || 0),
    cleanupAt: Number(task.cleanupAt || 0),
    suppressRemovalUntil: Number(task.suppressRemovalUntil || task.suppressRespawnUntil || 0),
    notifications: task.notifications && typeof task.notifications === "object" ? { ...task.notifications } : {}
  };

  return normalized;
}

function pruneTasks(tasks) {
  const sorted = Object.values(tasks).map(normalizeTask).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.filter((task, index) => {
    return ACTIVE_STATUSES.has(task.status) || RESTARTABLE_STATUSES.has(task.status) || index < MAX_TASK_HISTORY;
  });
  return Object.fromEntries(kept.map((task) => [task.id, task]));
}

function bindNormalTab(task, tab) {
  if (!Number.isInteger(tab?.id)) return;
  task.normalTabIds = [...new Set([...(task.normalTabIds || []), tab.id])];
  if (task.monitorTabId === tab.id) {
    task.monitorTabId = null;
    task.monitorGroupId = null;
    task.monitorWindowId = null;
  }
  if (Number.isInteger(tab.windowId)) task.lastKnownWindowId = tab.windowId;
  task.observerMode = "normal_tab";
  task.manualMonitorClosed = false;
}

function bindMonitorTab(task, tab, groupId = null) {
  if (!Number.isInteger(tab?.id)) return;
  task.normalTabIds = (task.normalTabIds || []).filter((id) => id !== tab.id);
  task.monitorTabId = tab.id;
  task.monitorWindowId = Number.isInteger(tab.windowId) ? tab.windowId : task.monitorWindowId;
  task.lastKnownWindowId = Number.isInteger(tab.windowId) ? tab.windowId : task.lastKnownWindowId;
  task.monitorGroupId = Number.isInteger(groupId) ? groupId : task.monitorGroupId;
  task.observerMode = "group_tab";
  task.monitorCreating = false;
  task.monitorExpected = false;
  task.manualMonitorClosed = false;
}

function unbindTab(task, tabId) {
  task.normalTabIds = (task.normalTabIds || []).filter((id) => id !== tabId);
  if (task.monitorTabId === tabId) {
    task.monitorTabId = null;
    task.monitorGroupId = null;
    task.monitorWindowId = null;
    task.monitorCreating = false;
    task.monitorExpected = false;
  }
  if (task.normalTabIds.length) task.observerMode = "normal_tab";
  else if (task.monitorTabId) task.observerMode = "group_tab";
  else if (ACTIVE_STATUSES.has(task.status)) task.observerMode = "lost";
  else task.observerMode = "none";
}

function getTaskTabIds(task) {
  return [...new Set([...(task.normalTabIds || []), task.monitorTabId].filter(Number.isInteger))];
}

function findTaskByTab(tasks, tabId, activeOnly = false) {
  return Object.values(tasks).find((task) => {
    if (activeOnly && !ACTIVE_STATUSES.has(task.status)) return false;
    return getTaskTabIds(task).includes(tabId);
  }) || null;
}

function publicTask(task, currentTabId = null) {
  return {
    id: task.id,
    status: task.status,
    url: task.url,
    conversationKey: task.conversationKey,
    title: task.title,
    prompt: task.prompt,
    observerMode: task.observerMode,
    observerLostReason: task.observerLostReason,
    normalTabCount: (task.normalTabIds || []).length,
    hasMonitor: Number.isInteger(task.monitorTabId),
    isMonitor: Number.isInteger(currentTabId) && task.monitorTabId === currentTabId,
    monitorTabId: task.monitorTabId,
    monitorGroupId: task.monitorGroupId,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    cleanupAt: task.cleanupAt,
    recoveryCount: task.recoveryCount,
    assistantFirstLine: task.assistantFirstLine,
    thinkingTimeText: task.thinkingTimeText
  };
}

function sanitizeChatUrl(value) {
  try {
    const url = new URL(value || "https://chatgpt.com/");
    if (!["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return "https://chatgpt.com/";
    url.protocol = "https:";
    url.hostname = "chatgpt.com";
    url.hash = "";
    for (const key of [...url.searchParams.keys()]) {
      if (key.startsWith("utm_") || key === "temporary-chat") url.searchParams.delete(key);
    }
    const normalized = url.toString();
    return normalized.endsWith("/") && url.pathname !== "/" ? normalized.slice(0, -1) : normalized;
  } catch {
    return "https://chatgpt.com/";
  }
}

function getConversationKey(value) {
  try {
    const url = new URL(sanitizeChatUrl(value));
    const conversationMatch = url.pathname.match(/(?:^|\/)c\/([^/]+)/);
    if (conversationMatch) return `c:${conversationMatch[1]}`;
    const shareMatch = url.pathname.match(/(?:^|\/)share\/([^/]+)/);
    if (shareMatch) return `share:${shareMatch[1]}`;
    const trimmedPath = url.pathname.replace(/\/+$/, "") || "/";
    if (trimmedPath !== "/") return `path:${trimmedPath}`;
    return "";
  } catch {
    return "";
  }
}

function sameConversation(a, b) {
  const left = getConversationKey(a);
  const right = getConversationKey(b);
  return Boolean(left && right && left === right);
}

function samePageUrl(a, b) {
  try {
    const left = new URL(sanitizeChatUrl(a));
    const right = new URL(sanitizeChatUrl(b));
    return left.hostname === right.hostname && left.pathname === right.pathname;
  } catch {
    return false;
  }
}

function cleanText(value, maxLength = 200) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}

function createTaskId() {
  const random = typeof crypto?.randomUUID === "function"
    ? crypto.randomUUID().slice(0, 8)
    : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function resetRecovery(task) {
  task.recoveryCount = 0;
  task.recoveryWindowStartedAt = 0;
  task.nextRecoveryAt = 0;
  task.observerLostReason = "";
}

function registerRecoveryAttempt(task, now = Date.now()) {
  if (!task.recoveryWindowStartedAt || now - task.recoveryWindowStartedAt > RECOVERY_WINDOW_MS) {
    task.recoveryWindowStartedAt = now;
    task.recoveryCount = 0;
  }
  task.recoveryCount += 1;
  const backoff = RECOVERY_BACKOFF_MS[Math.min(task.recoveryCount - 1, RECOVERY_BACKOFF_MS.length - 1)];
  task.nextRecoveryAt = now + backoff;
  return task.recoveryCount <= MAX_RECOVERY_COUNT;
}

function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(1, Math.round(Number(elapsedMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `思考了 ${minutes ? `${minutes}m${seconds ? ` ${seconds}s` : ""}` : `${seconds}s`}`;
}
