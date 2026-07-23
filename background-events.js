const STORAGE_KEYS = {
  SETTINGS: "settings",
  TASKS: "tasks"
};

const DEFAULT_SETTINGS = {
  autoKeepAlive: true,
  notifyCompleted: true,
  notifyAttention: true,
  notifyFailed: true,
  notifyWhenFocused: false,
  closeMonitorWhenDone: true
};

const ACTIVE_STATUSES = new Set(["running", "waiting_action"]);
const FINISHED_STATUSES = new Set(["completed", "failed", "cancelled"]);
const MAX_TASK_HISTORY = 30;
const CHAT_URL_PATTERNS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const NOTIFICATION_ICON = "icons/chatgpt.png";
let mutationQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!settings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  await migrateStoredTasks();
});

chrome.runtime.onStartup?.addListener(() => {
  void migrateStoredTasks();
});


chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("[ChatGPT Task Notifier] message error", error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void enqueueMutation(async () => {
    const state = await readState();
    const affected = Object.values(state.tasks).filter((task) => getTaskTabIds(task).includes(tabId));
    if (!affected.length) return;

    for (const task of affected) {
      unbindTaskFromTab(task, tabId);
      task.updatedAt = Date.now();
      state.tasks[task.id] = task;
    }
    await writeTasks(state.tasks);

    for (const task of affected) {
      if (!ACTIVE_STATUSES.has(task.status)) continue;
      const suppressed = task.suppressRespawnUntil && task.suppressRespawnUntil > Date.now();
      if (suppressed || !state.settings.autoKeepAlive) continue;
      await ensureTaskHasObserver(task.id);
    }
  });
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  if (!changeInfo.url) return;
  void enqueueMutation(async () => {
    const state = await readState();
    const tasks = Object.values(state.tasks).filter((item) => getTaskTabIds(item).includes(tabId));
    if (!tasks.length) return;

    const url = sanitizeChatUrl(changeInfo.url);
    for (const task of tasks) {
      task.url = url;
      task.conversationKey = getConversationKey(url);
      task.updatedAt = Date.now();
      if (tab?.windowId != null) task.tabWindows[String(tabId)] = tab.windowId;
      state.tasks[task.id] = task;
    }
    await writeTasks(state.tasks);
  });
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const taskId = parseTaskIdFromNotification(notificationId);
  if (taskId) void openTask(taskId);
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const taskId = parseTaskIdFromNotification(notificationId);
  if (taskId) void openTask(taskId);
});

async function handleMessage(message, sender) {
  switch (message?.type) {
    case "PAGE_READY":
      return handlePageReady(message, sender);
    case "TASK_STARTED":
      return handleTaskStarted(message, sender);
    case "TASK_STATE":
      return handleTaskState(message, sender);
    case "HEARTBEAT":
      return handleHeartbeat(message, sender);
    case "GET_POPUP_STATE":
      return getPopupState();
    case "UPDATE_SETTINGS":
      return updateSettings(message.settings || {});
    case "TEST_NOTIFICATION":
      await showTestNotification();
      return { ok: true };
    case "OPEN_TASK":
      await openTask(message.taskId);
      return { ok: true };
    case "OPEN_CHAT":
      await openChat();
      return { ok: true };
    case "STOP_TASK":
      await stopTask(message.taskId);
      return { ok: true };
    case "CLEAR_HISTORY":
      await clearHistory();
      return { ok: true };
    default:
      return { ok: false, error: "Unknown message type" };
  }
}

async function handlePageReady(message, sender) {
  const tab = sender.tab;
  if (!tab?.id) return { ok: false, error: "Missing tab" };

  return enqueueMutation(async () => {
    const state = await readState();
    const url = sanitizeChatUrl(message.url || tab.url || "");
    let task = findTaskByTab(state.tasks, tab.id);

    if (!task) {
      const candidates = Object.values(state.tasks)
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .filter((item) =>
          sameConversation(item.url, url) ||
          (item.monitorExpected && !item.monitorTabId && samePageUrl(item.url, url))
        )
        .sort((a, b) => b.updatedAt - a.updatedAt);
      task = candidates[0] || null;
    }

    if (task) {
      const pageIsMonitor = task.monitorTabId === tab.id || Boolean(task.monitorExpected && !task.monitorTabId);
      bindTaskToTab(task, tab, { isMonitor: pageIsMonitor });
      task.url = url || task.url;
      task.conversationKey = getConversationKey(task.url);
      task.monitorCreating = false;
      task.monitorExpected = false;
      task.updatedAt = Date.now();
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);

      if (pageIsMonitor) await makeMonitorTabDurable(tab.id);
    }

    return {
      ok: true,
      settings: state.settings,
      task: task ? publicTask(task, tab.id) : null
    };
  });
}

async function handleTaskStarted(message, sender) {
  const tab = sender.tab;
  if (!tab?.id) return { ok: false, error: "Missing tab" };

  return enqueueMutation(async () => {
    const state = await readState();
    const now = Date.now();
    const url = sanitizeChatUrl(message.url || tab.url || "https://chatgpt.com/");
    const prompt = cleanText(message.prompt || "ChatGPT 任务", 100);
    const questionTitle = cleanText(message.questionTitle || prompt || "ChatGPT 任务", 80);
    let task = message.taskId ? state.tasks[message.taskId] : null;

    if (!task) task = findTaskByTab(state.tasks, tab.id, true);

    if (!task) {
      task = Object.values(state.tasks)
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .filter((item) => sameConversation(item.url, url))
        .filter((item) => !prompt || !item.prompt || item.prompt === prompt || now - item.startedAt < 15000)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    }

    if (!task) {
      const id = createTaskId();
      task = normalizeTask({
        id,
        createdAt: now,
        notifications: {}
      });
    }

    task.status = "running";
    bindTaskToTab(task, tab, { isMonitor: task.monitorTabId === tab.id });
    task.url = url;
    task.conversationKey = getConversationKey(url);
    task.title = questionTitle || task.title || "ChatGPT 任务";
    task.prompt = prompt || task.prompt || "ChatGPT 任务";
    task.baselineAssistantHash = message.baselineAssistantHash || task.baselineAssistantHash || "";
    task.latestAssistantHash = message.latestAssistantHash || task.latestAssistantHash || "";
    task.updatedAt = now;
    task.startedAt = task.startedAt || now;
    task.finishedAt = null;
    task.suppressRespawnUntil = 0;

    state.tasks[task.id] = task;
    await writeTasks(pruneTasks(state.tasks));
    return { ok: true, task: publicTask(task, tab.id) };
  });
}

async function handleTaskState(message, sender) {
  return enqueueMutation(async () => {
    const state = await readState();
    let task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task && sender.tab?.id) task = findTaskByTab(state.tasks, sender.tab.id, true);
    if (!task) return { ok: false, error: "Task not found" };

    const previousStatus = task.status;
    task.status = message.status || task.status;
    task.url = sanitizeChatUrl(message.url || sender.tab?.url || task.url);
    task.conversationKey = getConversationKey(task.url);
    task.prompt = cleanText(message.prompt || task.prompt || "ChatGPT 任务", 100);
    task.title = cleanText(message.questionTitle || task.title || task.prompt || "ChatGPT 任务", 80);
    task.assistantFirstLine = cleanText(message.assistantFirstLine || task.assistantFirstLine || "", 240);
    task.thinkingTimeText = cleanText(message.thinkingTimeText || task.thinkingTimeText || "", 60);
    task.latestAssistantHash = message.latestAssistantHash || task.latestAssistantHash || "";
    task.updatedAt = Date.now();
    if (sender.tab?.id) bindTaskToTab(task, sender.tab, { isMonitor: task.monitorTabId === sender.tab.id });

    if (FINISHED_STATUSES.has(task.status)) task.finishedAt = Date.now();

    state.tasks[task.id] = task;
    await writeTasks(pruneTasks(state.tasks));

    if (previousStatus !== task.status) await maybeNotify(task, state.settings);

    if (
      ["completed", "failed"].includes(task.status) &&
      task.monitorTabId &&
      state.settings.closeMonitorWhenDone
    ) {
      await closeMonitorTask(task.id);
    }

    return { ok: true, task: publicTask(task, sender.tab?.id) };
  });
}

async function handleHeartbeat(message, sender) {
  return enqueueMutation(async () => {
    const state = await readState();
    let task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task && sender.tab?.id) task = findTaskByTab(state.tasks, sender.tab.id, true);
    if (!task) return { ok: true, task: null };

    task.url = sanitizeChatUrl(message.url || sender.tab?.url || task.url);
    task.conversationKey = getConversationKey(task.url);
    task.latestAssistantHash = message.latestAssistantHash || task.latestAssistantHash || "";
    task.updatedAt = Date.now();
    if (sender.tab?.id) bindTaskToTab(task, sender.tab, { isMonitor: task.monitorTabId === sender.tab.id });
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return { ok: true, task: publicTask(task, sender.tab?.id) };
  });
}

async function maybeNotify(task, settings) {
  const title = cleanText(task.title || task.prompt || "ChatGPT 任务", 80);
  const completedMessage = [task.thinkingTimeText, task.assistantFirstLine]
    .filter(Boolean)
    .join("，") || "任务已完成。";

  const config = {
    completed: {
      enabled: settings.notifyCompleted,
      message: completedMessage,
      priority: 1
    },
    waiting_action: {
      enabled: settings.notifyAttention,
      message: "等待确认、授权或继续操作。",
      priority: 2
    },
    failed: {
      enabled: settings.notifyFailed,
      message: "任务可能失败或遇到错误。",
      priority: 2
    }
  }[task.status];

  if (!config?.enabled) return;
  if (!settings.notifyWhenFocused && (await isAnyTaskTabFocused(task))) return;

  const notificationId = `chatgpt-task:${task.id}:${task.status}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title,
    message: config.message,
    contextMessage: task.status === "completed" ? "点击查看完整回复" : "点击打开对应会话",
    priority: config.priority,
    requireInteraction: task.status !== "completed",
    buttons: [{ title: "打开会话" }]
  });
}

async function showTestNotification() {
  await chrome.notifications.create(`chatgpt-test:${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: "测试问题标题",
    message: "思考了 1m 23s，Windows 通知能够正常显示。",
    priority: 1
  });
}

async function isAnyTaskTabFocused(task) {
  const ids = getTaskTabIds(task);
  for (const tabId of ids) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      if (tab.active && win.focused) return true;
    } catch {
      // Stale tab bindings are cleaned when the task changes again.
    }
  }
  return false;
}

async function ensureTaskHasObserver(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task || !ACTIVE_STATUSES.has(task.status) || !state.settings.autoKeepAlive) return;

  const boundTabs = await getValidBoundTabs(task);
  const matchingTabs = mergeTabs(boundTabs, await findConversationTabs(task.url));
  if (matchingTabs.length) {
    const preferred = choosePreferredTab(matchingTabs, task);
    bindTaskToTab(task, preferred, { isMonitor: preferred.id === task.monitorTabId });
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return;
  }

  await createMonitorWindow(taskId);
}

