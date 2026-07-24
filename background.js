const STORAGE_KEYS = {
  SETTINGS: "settings",
  TASKS: "tasks"
};

const DEFAULT_SETTINGS = {
  notifyCompleted: true,
  notifyAttention: true,
  notifyFailed: true,
  notifyWhenFocused: false
};

const ACTIVE_STATUSES = new Set(["running", "waiting_action"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const ALLOWED_STATUSES = new Set([...ACTIVE_STATUSES, ...FINISHED_STATUSES]);
const NOTIFICATION_ICON = "icons/chatgpt.png";
const MAX_TASK_HISTORY = 40;
const URL_PROMOTION_WINDOW_MS = 60_000;
let mutationQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => void migrateState());
chrome.runtime.onStartup?.addListener(() => void migrateState());
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then(sendResponse)
    .catch((error) => sendResponse({ ok: false, error: error?.message || String(error) }));
  return true;
});
chrome.tabs.onRemoved.addListener((tabId) => void stopTasksForClosedTab(tabId));
chrome.tabs.onUpdated.addListener((tabId, changeInfo) => {
  if (!changeInfo.url) return;
  if (!isChatUrl(changeInfo.url)) void stopTasksForClosedTab(tabId, "页面已离开 ChatGPT，已停止监控");
  else void stopTasksForNavigatedTab(tabId, changeInfo.url);
});
chrome.notifications.onClicked.addListener((notificationId) => {
  const taskId = parseNotificationTaskId(notificationId);
  if (taskId) void openTask(taskId);
});
chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const taskId = parseNotificationTaskId(notificationId);
  if (taskId) void openTask(taskId);
});
void migrateState();

function enqueueMutation(fn) {
  const run = mutationQueue.then(fn, fn);
  mutationQueue = run.catch(() => {});
  return run;
}

async function migrateState() {
  return enqueueMutation(async () => {
    const state = await readState();
    let changed = false;
    for (const task of Object.values(state.tasks)) {
      if (task.monitorTabId || task.monitorGroupId || task.observerMode === "group_tab" || task.observerMode === "lost") {
        task.monitorTabId = null;
        task.monitorGroupId = null;
        task.observerMode = Number.isInteger(task.tabId) ? "current_page" : "none";
        changed = true;
      }
      if (ACTIVE_STATUSES.has(task.status) && !Number.isInteger(task.tabId)) {
        task.status = "cancelled";
        task.finishedAt = Date.now();
        task.stopReason = "升级后已停止旧的后台监控";
        changed = true;
      }
    }
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: state.settings });
    if (changed) await writeTasks(pruneTasks(state.tasks));
  });
}

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "PAGE_READY": return handlePageReady(message, sender);
    case "PAGE_CHANGED": return handlePageChanged(message, sender);
    case "PAGE_PROMOTED": return handlePagePromoted(message, sender);
    case "TASK_STARTED": return handleTaskStarted(message, sender);
    case "TASK_STATE": return handleTaskState(message, sender);
    case "HEARTBEAT": return handleHeartbeat(message, sender);
    case "GET_POPUP_STATE": return getPopupState();
    case "UPDATE_SETTINGS": return updateSettings(message.settings || {});
    case "TEST_NOTIFICATION": await showTestNotification(); return { ok: true };
    case "OPEN_TASK": await openTask(message.taskId); return { ok: true };
    case "OPEN_CHAT": await openChat(); return { ok: true };
    case "STOP_TASK": await stopTask(message.taskId); return { ok: true };
    case "CLEAR_HISTORY": await clearHistory(); return { ok: true };
    default: return { ok: false, error: "Unknown message type" };
  }
}

async function handlePageReady(message, sender) {
  const tab = sender.tab;
  if (!Number.isInteger(tab?.id)) return { ok: false, error: "Missing tab" };
  return enqueueMutation(async () => {
    const state = await readState();
    const nextUrl = sanitizeChatUrl(message.url || tab.url || "https://chatgpt.com/");
    let task = Object.values(state.tasks)
      .filter((item) => ACTIVE_STATUSES.has(item.status) && item.tabId === tab.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    if (task && !samePage(task.url, nextUrl)) {
      if (canPromoteTaskUrl(task, nextUrl)) {
        promoteTaskUrl(task, nextUrl, tab);
        state.tasks[task.id] = task;
        await writeTasks(state.tasks);
      } else {
        cancelTaskRecord(task, "页面已导航到其他 ChatGPT 会话，旧任务监控已停止");
        state.tasks[task.id] = task;
        await writeTasks(pruneTasks(state.tasks));
        task = null;
      }
    } else if (task) {
      task.url = nextUrl;
      task.windowId = tab.windowId;
      task.observerMode = "current_page";
      task.updatedAt = Date.now();
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);
    }
    return { ok: true, settings: state.settings, task: task ? publicTask(task) : null };
  });
}

async function handlePagePromoted(message, sender) {
  const tab = sender.tab;
  if (!Number.isInteger(tab?.id)) return { ok: false, error: "Missing tab" };
  return enqueueMutation(async () => {
    const state = await readState();
    const nextUrl = sanitizeChatUrl(message.url || tab.url || "https://chatgpt.com/");
    const task = Object.values(state.tasks)
      .filter((item) => ACTIVE_STATUSES.has(item.status) && item.tabId === tab.id)
      .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    if (!task) return { ok: true, task: null };
    if (!samePage(task.url, nextUrl) && !canPromoteTaskUrl(task, nextUrl)) {
      cancelTaskRecord(task, "页面已导航到其他 ChatGPT 会话，旧任务监控已停止");
      state.tasks[task.id] = task;
      await writeTasks(pruneTasks(state.tasks));
      return { ok: true, task: null };
    }
    promoteTaskUrl(task, nextUrl, tab);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return { ok: true, task: publicTask(task) };
  });
}

async function handlePageChanged(message, sender) {
  const tab = sender.tab;
  if (!Number.isInteger(tab?.id)) return { ok: false, error: "Missing tab" };
  await cancelActiveTasksForTab(tab.id, cleanText(message.reason || "已切换到其他 ChatGPT 会话，旧任务监控已停止", 160));
  return { ok: true };
}

async function handleTaskStarted(message, sender) {
  const tab = sender.tab;
  if (!Number.isInteger(tab?.id)) return { ok: false, error: "Missing tab" };
  return enqueueMutation(async () => {
    const state = await readState();
    const now = Date.now();
    let task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task || task.tabId !== tab.id) {
      task = Object.values(state.tasks).find((item) => item.tabId === tab.id && ACTIVE_STATUSES.has(item.status)) || null;
    }
    const nextUrl = sanitizeChatUrl(message.url || tab.url || "https://chatgpt.com/");
    if (task && !samePage(task.url, nextUrl)) {
      if (canPromoteTaskUrl(task, nextUrl, now)) {
        promoteTaskUrl(task, nextUrl, tab);
      } else {
        cancelTaskRecord(task, "页面已导航到其他 ChatGPT 会话，旧任务监控已停止");
        state.tasks[task.id] = task;
        task = null;
      }
    }
    if (!task) task = normalizeTask({ id: createTaskId(), createdAt: now, startedAt: now });
    task.status = "running";
    task.tabId = tab.id;
    task.windowId = tab.windowId;
    task.url = nextUrl;
    task.urlPromotionExpiresAt = isDraftChatUrl(nextUrl) ? now + URL_PROMOTION_WINDOW_MS : 0;
    task.title = cleanText(message.questionTitle || message.prompt || "ChatGPT 任务", 80);
    task.prompt = cleanText(message.prompt || task.title, 240);
    task.baselineAssistantHash = String(message.baselineAssistantHash || "");
    task.latestAssistantHash = String(message.latestAssistantHash || task.latestAssistantHash || "");
    task.lastHeartbeatAt = now;
    task.startedAt = task.finishedAt ? now : task.startedAt || now;
    task.finishedAt = null;
    task.updatedAt = now;
    task.observerMode = "current_page";
    task.stopReason = "";
    state.tasks[task.id] = task;
    await writeTasks(pruneTasks(state.tasks));
    return { ok: true, task: publicTask(task) };
  });
}

async function handleTaskState(message, sender) {
  return enqueueMutation(async () => {
    const state = await readState();
    let task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task && Number.isInteger(sender.tab?.id)) {
      task = Object.values(state.tasks).find((item) => item.tabId === sender.tab.id && ACTIVE_STATUSES.has(item.status)) || null;
    }
    if (!task) return { ok: false, error: "Task not found" };
    const previousStatus = task.status;
    const now = Date.now();
    const nextStatus = String(message.status || task.status);
    if (!ALLOWED_STATUSES.has(nextStatus)) return { ok: false, error: "Invalid task status" };
    const nextUrl = sanitizeChatUrl(message.url || sender.tab?.url || task.url);
    if (!samePage(task.url, nextUrl)) {
      if (canPromoteTaskUrl(task, nextUrl, now)) promoteTaskUrl(task, nextUrl, sender.tab);
      else {
        cancelTaskRecord(task, "任务状态来自其他 ChatGPT 会话，旧任务监控已停止");
        state.tasks[task.id] = task;
        await writeTasks(pruneTasks(state.tasks));
        return { ok: true, task: null, cancelled: true };
      }
    }
    task.status = nextStatus;
    task.url = nextUrl;
    task.title = cleanText(message.questionTitle || task.title || task.prompt || "ChatGPT 任务", 80);
    task.prompt = cleanText(message.prompt || task.prompt || task.title, 240);
    task.assistantFirstLine = cleanText(message.assistantFirstLine || task.assistantFirstLine || "", 240);
    task.thinkingTimeText = cleanText(message.thinkingTimeText || task.thinkingTimeText || "", 60);
    task.latestAssistantHash = String(message.latestAssistantHash || task.latestAssistantHash || "");
    task.stopReason = cleanText(message.stopReason || task.stopReason || "", 160);
    task.lastHeartbeatAt = now;
    task.updatedAt = now;
    if (Number.isInteger(sender.tab?.id)) {
      task.tabId = sender.tab.id;
      task.windowId = sender.tab.windowId;
      task.observerMode = "current_page";
    }
    if (FINISHED_STATUSES.has(task.status)) {
      task.finishedAt = now;
      task.urlPromotionExpiresAt = 0;
      if (!task.thinkingTimeText) task.thinkingTimeText = formatElapsed(now - task.startedAt);
    }
    state.tasks[task.id] = task;
    await writeTasks(pruneTasks(state.tasks));
    if (previousStatus !== task.status) await maybeNotify(task, state.settings);
    return { ok: true, task: publicTask(task) };
  });
}

async function handleHeartbeat(message, sender) {
  return enqueueMutation(async () => {
    const state = await readState();
    const task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task || !ACTIVE_STATUSES.has(task.status)) return { ok: true, task: null };
    if (!Number.isInteger(sender.tab?.id) || sender.tab.id !== task.tabId) return { ok: true, task: null };
    const nextUrl = sanitizeChatUrl(message.url || sender.tab.url || task.url);
    if (!samePage(task.url, nextUrl)) {
      if (canPromoteTaskUrl(task, nextUrl)) promoteTaskUrl(task, nextUrl, sender.tab);
      else {
        cancelTaskRecord(task, "心跳来自其他 ChatGPT 会话，旧任务监控已停止");
        state.tasks[task.id] = task;
        await writeTasks(pruneTasks(state.tasks));
        return { ok: true, task: null, cancelled: true };
      }
    }
    task.url = nextUrl;
    task.windowId = sender.tab.windowId;
    task.latestAssistantHash = String(message.latestAssistantHash || task.latestAssistantHash || "");
    task.lastHeartbeatAt = Date.now();
    task.updatedAt = task.lastHeartbeatAt;
    task.observerMode = "current_page";
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return { ok: true, task: publicTask(task) };
  });
}

async function stopTasksForNavigatedTab(tabId, nextUrl) {
  return enqueueMutation(async () => {
    const state = await readState();
    const current = Object.values(state.tasks).find((task) => task.tabId === tabId && ACTIVE_STATUSES.has(task.status));
    if (!current || samePage(current.url, nextUrl)) return;
    if (canPromoteTaskUrl(current, nextUrl)) {
      promoteTaskUrl(current, nextUrl);
      state.tasks[current.id] = current;
      await writeTasks(state.tasks);
      return;
    }
    cancelTaskRecord(current, "已切换到其他 ChatGPT 会话，旧任务监控已停止");
    state.tasks[current.id] = current;
    await writeTasks(pruneTasks(state.tasks));
  });
}

async function cancelActiveTasksForTab(tabId, reason) {
  return enqueueMutation(async () => {
    const state = await readState();
    let changed = false;
    const now = Date.now();
    for (const task of Object.values(state.tasks)) {
      if (task.tabId !== tabId || !ACTIVE_STATUSES.has(task.status)) continue;
      task.status = "cancelled";
      task.finishedAt = now;
      task.updatedAt = now;
      task.observerMode = "none";
      task.tabId = null;
      task.windowId = null;
      task.stopReason = cleanText(reason || "任务监控已停止", 160);
      changed = true;
    }
    if (changed) await writeTasks(pruneTasks(state.tasks));
  });
}

async function stopTasksForClosedTab(tabId, reason = "页面已关闭，已停止监控") {
  return enqueueMutation(async () => {
    const state = await readState();
    let changed = false;
    for (const task of Object.values(state.tasks)) {
      if (task.tabId !== tabId || !ACTIVE_STATUSES.has(task.status)) continue;
      task.status = "cancelled";
      task.finishedAt = Date.now();
      task.updatedAt = Date.now();
      task.observerMode = "none";
      task.tabId = null;
      task.windowId = null;
      task.stopReason = reason;
      changed = true;
    }
    if (changed) await writeTasks(pruneTasks(state.tasks));
  });
}

async function stopTask(taskId) {
  return enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task) return;
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.updatedAt = Date.now();
    task.observerMode = "none";
    task.stopReason = "用户已停止监控";
    state.tasks[task.id] = task;
    await writeTasks(pruneTasks(state.tasks));
  });
}

async function maybeNotify(task, settings) {
  if (task.status === "completed" && !settings.notifyCompleted) return;
  if (task.status === "waiting_action" && !settings.notifyAttention) return;
  if (task.status === "failed" && !settings.notifyFailed) return;
  if (!['completed', 'waiting_action', 'failed'].includes(task.status)) return;
  if (!settings.notifyWhenFocused && await isTaskTabFocused(task)) return;
  const title = task.title || task.prompt || "ChatGPT 任务";
  let message = "";
  if (task.status === "completed") message = `${task.thinkingTimeText || formatElapsed(Date.now() - task.startedAt)}，${task.assistantFirstLine || "计划已执行完成"}`;
  else if (task.status === "waiting_action") message = "任务正在等待你确认或继续操作";
  else message = task.assistantFirstLine || "任务执行失败，请打开页面查看";
  const notificationId = `chatgpt-task:${task.id}:${task.status}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title,
    message,
    priority: task.status === "waiting_action" ? 2 : 1,
    buttons: [{ title: "打开任务" }]
  });
}

async function isTaskTabFocused(task) {
  if (!Number.isInteger(task.tabId) || !Number.isInteger(task.windowId)) return false;
  try {
    const [tab, win] = await Promise.all([chrome.tabs.get(task.tabId), chrome.windows.get(task.windowId)]);
    return Boolean(tab.active && win.focused);
  } catch {
    return false;
  }
}

async function openTask(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task) return;
  if (Number.isInteger(task.tabId)) {
    try {
      const tab = await chrome.tabs.get(task.tabId);
      await chrome.windows.update(tab.windowId, { focused: true });
      await chrome.tabs.update(tab.id, { active: true });
      return;
    } catch {}
  }
  if (task.url) await chrome.tabs.create({ url: task.url, active: true });
}

async function openChat() {
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  const tab = tabs.find((item) => item.active) || tabs[0];
  if (tab?.id) {
    await chrome.windows.update(tab.windowId, { focused: true });
    await chrome.tabs.update(tab.id, { active: true });
  } else {
    await chrome.tabs.create({ url: "https://chatgpt.com/", active: true });
  }
}

async function getPopupState() {
  const state = await readState();
  const permissionLevel = await chrome.notifications.getPermissionLevel();
  return {
    ok: true,
    settings: state.settings,
    permissionLevel,
    tasks: Object.values(state.tasks).sort((a, b) => b.updatedAt - a.updatedAt).map(publicTask)
  };
}

async function updateSettings(patch) {
  const state = await readState();
  state.settings = { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries({ ...state.settings, ...patch }).filter(([key]) => key in DEFAULT_SETTINGS)) };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: state.settings });
  return { ok: true, settings: state.settings };
}

async function clearHistory() {
  const state = await readState();
  state.tasks = Object.fromEntries(Object.entries(state.tasks).filter(([, task]) => ACTIVE_STATUSES.has(task.status)));
  await writeTasks(state.tasks);
}

async function showTestNotification() {
  await chrome.notifications.create(`chatgpt-test:${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: "ChatGPT 任务提醒测试",
    message: "通知功能正常。关闭 ChatGPT 页面后不会继续监控。"
  });
}

async function readState() {
  const result = await chrome.storage.local.get([STORAGE_KEYS.SETTINGS, STORAGE_KEYS.TASKS]);
  return {
    settings: { ...DEFAULT_SETTINGS, ...Object.fromEntries(Object.entries(result.settings || {}).filter(([key]) => key in DEFAULT_SETTINGS)) },
    tasks: Object.fromEntries(Object.entries(result.tasks || {}).map(([id, task]) => [id, normalizeTask({ ...task, id })]))
  };
}

async function writeTasks(tasks) {
  await chrome.storage.local.set({ [STORAGE_KEYS.TASKS]: tasks });
}

function normalizeTask(task = {}) {
  const now = Date.now();
  return {
    id: task.id || createTaskId(),
    status: task.status || "cancelled",
    tabId: Number.isInteger(task.tabId) ? task.tabId : null,
    windowId: Number.isInteger(task.windowId) ? task.windowId : null,
    observerMode: Number.isInteger(task.tabId) ? "current_page" : "none",
    url: sanitizeChatUrl(task.url || "https://chatgpt.com/"),
    urlPromotionExpiresAt: Math.max(0, Number(task.urlPromotionExpiresAt || 0)),
    title: cleanText(task.title || task.prompt || "ChatGPT 任务", 80),
    prompt: cleanText(task.prompt || "ChatGPT 任务", 240),
    baselineAssistantHash: String(task.baselineAssistantHash || ""),
    latestAssistantHash: String(task.latestAssistantHash || ""),
    lastHeartbeatAt: Number(task.lastHeartbeatAt || 0),
    assistantFirstLine: cleanText(task.assistantFirstLine || "", 240),
    thinkingTimeText: cleanText(task.thinkingTimeText || "", 60),
    stopReason: cleanText(task.stopReason || task.observerLostReason || "", 160),
    createdAt: Number(task.createdAt || now),
    startedAt: Number(task.startedAt || task.createdAt || now),
    updatedAt: Number(task.updatedAt || now),
    finishedAt: task.finishedAt ? Number(task.finishedAt) : null
  };
}

function publicTask(task) {
  return {
    id: task.id,
    status: task.status,
    url: task.url,
    title: task.title,
    prompt: task.prompt,
    observerMode: task.observerMode,
    stopReason: task.stopReason,
    startedAt: task.startedAt,
    updatedAt: task.updatedAt,
    finishedAt: task.finishedAt,
    baselineAssistantHash: task.baselineAssistantHash,
    latestAssistantHash: task.latestAssistantHash,
    lastHeartbeatAt: task.lastHeartbeatAt,
    assistantFirstLine: task.assistantFirstLine,
    thinkingTimeText: task.thinkingTimeText
  };
}

function pruneTasks(tasks) {
  const values = Object.values(tasks).map(normalizeTask).sort((a, b) => b.updatedAt - a.updatedAt);
  const kept = values.filter((task, index) => ACTIVE_STATUSES.has(task.status) || index < MAX_TASK_HISTORY);
  return Object.fromEntries(kept.map((task) => [task.id, task]));
}

function parseNotificationTaskId(value) {
  const match = String(value || "").match(/^chatgpt-task:([^:]+):/);
  return match?.[1] || "";
}

function sanitizeChatUrl(value) {
  try {
    const url = new URL(value || "https://chatgpt.com/");
    if (!["chatgpt.com", "chat.openai.com"].includes(url.hostname)) return "https://chatgpt.com/";
    url.protocol = "https:";
    url.hostname = "chatgpt.com";
    url.hash = "";
    return url.toString();
  } catch {
    return "https://chatgpt.com/";
  }
}

function isChatUrl(value) {
  try {
    return ["chatgpt.com", "chat.openai.com"].includes(new URL(value).hostname);
  } catch {
    return false;
  }
}

function samePage(left, right) {
  try {
    const a = new URL(sanitizeChatUrl(left));
    const b = new URL(sanitizeChatUrl(right));
    return a.pathname.replace(/\/+$/, "") === b.pathname.replace(/\/+$/, "");
  } catch {
    return false;
  }
}

function cancelTaskRecord(task, reason) {
  const now = Date.now();
  task.status = "cancelled";
  task.finishedAt = now;
  task.updatedAt = now;
  task.observerMode = "none";
  task.tabId = null;
  task.windowId = null;
  task.urlPromotionExpiresAt = 0;
  task.stopReason = cleanText(reason || "任务监控已停止", 160);
  return task;
}

function promoteTaskUrl(task, nextUrl, tab = null) {
  task.url = sanitizeChatUrl(nextUrl || task.url);
  task.urlPromotionExpiresAt = 0;
  if (Number.isInteger(tab?.id)) task.tabId = tab.id;
  if (Number.isInteger(tab?.windowId)) task.windowId = tab.windowId;
  task.observerMode = "current_page";
  task.updatedAt = Date.now();
  return task;
}

function canPromoteTaskUrl(task, nextUrl, now = Date.now()) {
  if (!task || !ACTIVE_STATUSES.has(task.status)) return false;
  if (!isDraftChatUrl(task.url) || !getConversationId(nextUrl)) return false;
  return Number(task.urlPromotionExpiresAt || 0) >= now;
}

function getConversationId(value) {
  try {
    return new URL(value || "https://chatgpt.com/").pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1] || "";
  } catch {
    return "";
  }
}

function isDraftChatUrl(value) {
  try {
    const pathname = new URL(sanitizeChatUrl(value)).pathname.replace(/\/+$/, "") || "/";
    return !getConversationId(value) && (pathname === "/" || /(?:^|\/)g\/g-p-[^/]+\/project$/.test(pathname));
  } catch {
    return false;
  }
}

function createTaskId() {
  const random = typeof crypto?.randomUUID === "function" ? crypto.randomUUID().slice(0, 8) : Math.random().toString(36).slice(2, 10);
  return `${Date.now().toString(36)}-${random}`;
}

function cleanText(value, maxLength = 200) {
  return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
}

function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(1, Math.round(Number(elapsedMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `思考了 ${minutes}m ${seconds}s` : `思考了 ${seconds}s`;
}
