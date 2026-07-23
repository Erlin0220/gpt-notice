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
const NOTIFICATION_ICON = "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAEPUlEQVR4nO2cS3LbMBBER6rs45PGu/gM9s4+qXUCZ5Gii6JFEv/pQffb2SVREPphABKkLtaB33//fPU4Lju3t49L62M2OaAC96GFEFUHUPAY1IhQ9EYFj0mJCFlvUPAxyBHhmvpChR+HnKySBFD48UjN7FQAhR+XlOwOBVD48TnLcFcAhT8PR1k+FEDhz8depj8EUPjz8ijb5NNAMSd3Amj0z882Y1UAcr4F0OjnYZ21KgA5VzONfkaWzFUByJEA5EgAci6a/7lRBSDnl3cDRvH5+p71+qeX504twWLaKSA38DNmFWIqAVqHvsdMMkwhwKjgt8wgQmgBvILfElmEsGcBKOGbYbUll3AVAL2zo1WDUBUAPXyzGG1cE0aASB0bqa0hpoBWHZpankd/nifwAtSGURuC9+f3BlqA0s7v1elo7WkBrAAlnT2qo5HblgvkIhC9g0s+C3VhGH430GtkLZ+LGmwqcBUgp0MRympOGxBlgRIgWvgLkSWAEiAVpPAXENuUAowAaCOjJ0jfFUaAVJBHGnLb9oAQIHVEIHbwtu2jLzfXAiFAVJYQUcIswV2AqKN/2+7135GqgLsAEdkLDiHQXEIIgDb6j/h8fbfP1/cwbXYVIOKISW1z69f1Ar4CII0k77B6AC8ACug7lKVIgARmDd/MeTs4wpZqr/BRBIG9IwiBGW8B26IpoDGRwjeTALvMPO+vkQAPYAnfTAL8gCl8MwlwB1v4ZhMKULpyZwzfbDIBSvfnka9D9Ga4AL06+2h/vgdoj5+V4nIlsPQ2qtTjrf9/dmzv0u9dfSCeDKoR4qwDjyTwCN878C1Dp4DWX75mz9175KMQdhFYs9BDD39klYCYAtakdPTIUz2zOUf+QsgKEDkQtLaHFMBsXEeiBdaasAKY9Q9n9vDNBgrQa2HTKySG8M2CV4CF1mGxhG8GJkBNx7cKjSl8MzABaqkNDyn8UdcCphLADCvECEwngFmZBOg/M9eLIQJ4bIDkdDJSIKOZsgIsRHpAwwsYAXqfz2+P//TyTB++GeBmUA/2JBBAFUD4MOTZQLS7YCLRu2p1rwAKHxtNAeRIAHIkADkSgBwJQE53AXTxpZwRfTekAkiCfEb1mX4kihytAcih2Azasnd1knGqoqsAR5emGS9bUwmQEjCbBDQC5ATLJAGFACWBskhAIYDYRwKQIwHIkQDkUAiA/qSQJxQCmOlJoT1oBDDTk0KPoBLA7DhgtvDNtB1MD10FEPdcb28fF+9GCB9ubx8XVQByJAA5EoCcq9n/ucC7IWIsS+aqAOR8C6AqwMM6a1UAcu4EUBWYn23GqgDk/BBAVWBeHmX7sAJIgvnYy3R3CpAE83CU5eEaQBLE5yzD00WgJIhLSnZJZwGSIB6pmSWfBkqCOORkVRSqbiPDpGSQVo1qiYBBTXVuUtYlgg8tpuUu87qE6EOPddg/sMW+V/bxT20AAAAASUVORK5CYII=";
let mutationQueue = Promise.resolve();

chrome.runtime.onInstalled.addListener(async () => {
  const { settings } = await chrome.storage.local.get(STORAGE_KEYS.SETTINGS);
  if (!settings) {
    await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: DEFAULT_SETTINGS });
  }
  await migrateStoredTasks();
  await applyActionIcon();
});

chrome.runtime.onStartup?.addListener(() => {
  void migrateStoredTasks();
  void applyActionIcon();
});

void applyActionIcon();

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
    task.title = cleanText(message.title || tab.title || "ChatGPT 会话", 80);
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
  const config = {
    completed: {
      enabled: settings.notifyCompleted,
      title: "ChatGPT 任务已完成",
      message: `${task.prompt || "当前任务"} 已生成结果。`,
      priority: 1
    },
    waiting_action: {
      enabled: settings.notifyAttention,
      title: "ChatGPT 等待你的操作",
      message: `${task.prompt || "当前任务"} 需要确认、授权或继续操作。`,
      priority: 2
    },
    failed: {
      enabled: settings.notifyFailed,
      title: "ChatGPT 任务中断",
      message: `${task.prompt || "当前任务"} 可能失败或遇到错误。`,
      priority: 2
    }
  }[task.status];

  if (!config?.enabled) return;
  if (!settings.notifyWhenFocused && (await isAnyTaskTabFocused(task))) return;

  const notificationId = `chatgpt-task:${task.id}:${task.status}`;
  await chrome.notifications.create(notificationId, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title: config.title,
    message: config.message,
    contextMessage: "点击打开对应会话",
    priority: config.priority,
    requireInteraction: task.status !== "completed",
    buttons: [{ title: "打开会话" }]
  });
}

async function applyActionIcon() {
  if (!chrome.action?.setIcon || typeof fetch !== "function" || typeof OffscreenCanvas === "undefined") {
    return;
  }

  try {
    const response = await fetch(NOTIFICATION_ICON);
    const bitmap = await createImageBitmap(await response.blob());
    const imageData = {};
    for (const size of [16, 32, 48, 128]) {
      const canvas = new OffscreenCanvas(size, size);
      const context = canvas.getContext("2d");
      context.drawImage(bitmap, 0, 0, size, size);
      imageData[size] = context.getImageData(0, 0, size, size);
    }
    await chrome.action.setIcon({ imageData });
  } catch (error) {
    console.debug("[ChatGPT Task Notifier] unable to apply generated action icon", error);
  }
}

async function showTestNotification() {
  await chrome.notifications.create(`chatgpt-test:${Date.now()}`, {
    type: "basic",
    iconUrl: NOTIFICATION_ICON,
    title: "ChatGPT 提醒测试成功",
    message: "Windows 通知能够正常显示。",
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

