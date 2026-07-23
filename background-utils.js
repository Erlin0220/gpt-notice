async function migrateStoredTasks() {
  await enqueueMutation(async () => {
    const result = await chrome.storage.local.get(STORAGE_KEYS.TASKS);
    const tasks = Object.fromEntries(
      Object.entries(result.tasks || {}).map(([id, task]) => [id, normalizeTask(task)])
    );
    await writeTasks(tasks);
  });
}

async function readState() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TASKS]);
  const tasks = Object.fromEntries(
    Object.entries(result.tasks || {}).map(([id, task]) => [id, normalizeTask(task)])
  );
  return {
    settings: { ...DEFAULT_SETTINGS, ...(result.settings || {}) },
    tasks
  };
}

async function readSettings() {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  return { ...DEFAULT_SETTINGS, ...(settings || {}) };
}

async function writeTasks(tasks) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: tasks });
}

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

function pruneTasks(tasks) {
  const sorted = Object.values(tasks).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = sorted.filter((task, index) => ACTIVE_STATUSES.has(task.status) || index < MAX_TASK_HISTORY);
  return Object.fromEntries(kept.map((task) => [task.id, task]));
}

function normalizeTask(task) {
  const normalized = {
    ...task,
    tabIds: Array.isArray(task?.tabIds) ? [...new Set(task.tabIds.filter(Number.isInteger))] : [],
    tabWindows: task?.tabWindows && typeof task.tabWindows === "object" ? { ...task.tabWindows } : {},
    monitorTabId: Number.isInteger(task?.monitorTabId) ? task.monitorTabId : null,
    monitorWindowId: Number.isInteger(task?.monitorWindowId) ? task.monitorWindowId : null,
    monitorCreating: Boolean(task?.monitorCreating),
    monitorExpected: Boolean(task?.monitorExpected)
  };

  if (Number.isInteger(task?.tabId) && !normalized.tabIds.includes(task.tabId)) {
    normalized.tabIds.push(task.tabId);
    if (Number.isInteger(task.windowId)) normalized.tabWindows[String(task.tabId)] = task.windowId;
  }
  if (task?.isMonitor && Number.isInteger(task?.tabId) && !normalized.monitorTabId) {
    normalized.monitorTabId = task.tabId;
    normalized.monitorWindowId = Number.isInteger(task.windowId) ? task.windowId : null;
  }

  delete normalized.tabId;
  delete normalized.windowId;
  delete normalized.isMonitor;
  normalized.url = sanitizeChatUrl(normalized.url || "https://chatgpt.com/");
  normalized.conversationKey = normalized.conversationKey || getConversationKey(normalized.url);
  return normalized;
}

function bindTaskToTab(task, tab, { isMonitor = false } = {}) {
  if (!Number.isInteger(tab?.id)) return;
  task.tabIds = [...new Set([...(task.tabIds || []), tab.id])];
  task.tabWindows = task.tabWindows || {};
  if (Number.isInteger(tab.windowId)) task.tabWindows[String(tab.id)] = tab.windowId;
  if (isMonitor) {
    task.monitorTabId = tab.id;
    if (Number.isInteger(tab.windowId)) task.monitorWindowId = tab.windowId;
  }
}

function unbindTaskFromTab(task, tabId) {
  task.tabIds = getTaskTabIds(task).filter((id) => id !== tabId);
  if (task.tabWindows) delete task.tabWindows[String(tabId)];
  if (task.monitorTabId === tabId) {
    task.monitorTabId = null;
    task.monitorWindowId = null;
    task.monitorCreating = false;
    task.monitorExpected = false;
  }
}

function getTaskTabIds(task) {
  return Array.isArray(task?.tabIds) ? task.tabIds.filter(Number.isInteger) : [];
}

function findTaskByTab(tasks, tabId, activeOnly = false) {
  return Object.values(tasks).find((item) => {
    if (activeOnly && !ACTIVE_STATUSES.has(item.status)) return false;
    return getTaskTabIds(item).includes(tabId);
  }) || null;
}

function publicTask(task, currentTabId = null) {
  const tabIds = getTaskTabIds(task);
  return {
    id: task.id,
    status: task.status,
    url: task.url,
    title: task.title,
    prompt: task.prompt,
    baselineAssistantHash: task.baselineAssistantHash,
    latestAssistantHash: task.latestAssistantHash,
    isMonitor: Boolean(currentTabId && task.monitorTabId === currentTabId),
    hasMonitor: Boolean(task.monitorTabId),
    attachedTabCount: tabIds.length,
    createdAt: task.createdAt,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt
  };
}

async function getValidBoundTabs(task) {
  const tabs = [];
  for (const tabId of getTaskTabIds(task)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && isChatUrl(tab.url)) tabs.push(tab);
    } catch {
      // Ignore stale tab ids.
    }
  }
  return tabs;
}

function mergeTabs(...groups) {
  const byId = new Map();
  for (const tab of groups.flat()) {
    if (Number.isInteger(tab?.id)) byId.set(tab.id, tab);
  }
  return [...byId.values()];
}

function isChatUrl(value) {
  try {
    return ["chatgpt.com", "chat.openai.com"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

async function queryChatTabs() {
  try {
    return await chrome.tabs.query({ url: CHAT_URL_PATTERNS });
  } catch {
    return [];
  }
}

async function findConversationTabs(url) {
  const tabs = await queryChatTabs();
  return tabs.filter((tab) => tab.url && sameConversation(tab.url, url));
}

function choosePreferredTab(tabs, task) {
  if (!tabs?.length) return null;
  const sorted = [...tabs].sort((a, b) => {
    const aMonitor = a.id === task?.monitorTabId ? 1 : 0;
    const bMonitor = b.id === task?.monitorTabId ? 1 : 0;
    if (aMonitor !== bMonitor) return aMonitor - bMonitor;
    if (Boolean(a.active) !== Boolean(b.active)) return Number(b.active) - Number(a.active);
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  });
  return sorted[0];
}

function parseTaskIdFromNotification(notificationId) {
  const match = /^chatgpt-task:([^:]+):/.exec(notificationId || "");
  return match?.[1] || null;
}

function createTaskId() {
  return `${Date.now().toString(36)}-${crypto.randomUUID().slice(0, 8)}`;
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
    return url.toString();
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
  const leftKey = getConversationKey(a);
  const rightKey = getConversationKey(b);
  return Boolean(leftKey && rightKey && leftKey === rightKey);
}

function samePageUrl(a, b) {
  return sanitizeChatUrl(a) === sanitizeChatUrl(b);
}

function cleanText(value, maxLength) {
  return String(value || "")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, maxLength);
}
