chrome.runtime.onInstalled.addListener(() => {
  void initializeExtension({ migrateLegacy: true });
});

chrome.runtime.onStartup?.addListener(() => {
  void initializeExtension({ migrateLegacy: true });
});

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleRuntimeMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      console.error("[ChatGPT Task Notifier] message error", error);
      sendResponse({ ok: false, error: error?.message || String(error) });
    });
  return true;
});

chrome.tabs.onRemoved.addListener((tabId, removeInfo) => {
  void handleTabRemoved(tabId, removeInfo);
});

chrome.tabs.onUpdated.addListener((tabId, changeInfo, tab) => {
  void handleTabUpdated(tabId, changeInfo, tab);
});

chrome.tabs.onActivated.addListener((activeInfo) => {
  void handleTabActivated(activeInfo.tabId);
});

chrome.windows.onRemoved.addListener(() => {
  setTimeout(() => void reconcileAllObservers(), 300);
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === WATCHDOG_ALARM) void runWatchdog();
});

chrome.notifications.onClicked.addListener((notificationId) => {
  const taskId = parseTaskIdFromNotification(notificationId);
  if (taskId) void openTask(taskId);
});

chrome.notifications.onButtonClicked.addListener((notificationId) => {
  const taskId = parseTaskIdFromNotification(notificationId);
  if (taskId) void openTask(taskId);
});

void initializeExtension({ migrateLegacy: false });

async function initializeExtension({ migrateLegacy }) {
  await migrateStoredState();
  await ensureWatchdogAlarm();
  if (migrateLegacy) await migrateLegacyObservers();
  await reconcileAllObservers();
}

async function handleRuntimeMessage(message, sender) {
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
    case "PROMOTE_TASK":
      await promoteMonitorTab(message.taskId, { focus: true });
      return { ok: true };
    case "STOP_TASK":
      await stopTask(message.taskId);
      return { ok: true };
    case "RESUME_TASK":
      await resumeTask(message.taskId);
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
      task = Object.values(state.tasks)
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .filter((item) => {
          return sameConversation(item.url, url) ||
            (item.monitorExpected && !item.monitorTabId && samePageUrl(item.url, url));
        })
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    }

    if (task) {
      const isExpectedMonitor = task.monitorTabId === tab.id || Boolean(task.monitorExpected && !task.monitorTabId);
      if (isExpectedMonitor) {
        let groupId = Number.isInteger(tab.groupId) && tab.groupId >= 0 ? tab.groupId : null;
        if (!groupId && Number.isInteger(tab.windowId)) {
          try { groupId = await getOrCreateMonitorGroup(tab.windowId, tab.id, task.monitorGroupId); } catch {}
        }
        bindMonitorTab(task, tab, groupId);
        await makeMonitorTabDurable(tab.id);
        await collapseMonitorGroup(groupId);
      } else {
        bindNormalTab(task, tab);
      }
      task.url = url || task.url;
      task.conversationKey = getConversationKey(task.url);
      task.lastHeartbeatAt = Date.now();
      task.updatedAt = Date.now();
      resetRecovery(task);
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);
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
    const prompt = cleanText(message.prompt || "ChatGPT 任务", 160);
    const questionTitle = cleanText(message.questionTitle || prompt || "ChatGPT 任务", 80);
    let task = message.taskId ? state.tasks[message.taskId] : null;

    if (!task) task = findTaskByTab(state.tasks, tab.id, true);
    if (!task) {
      task = Object.values(state.tasks)
        .filter((item) => ACTIVE_STATUSES.has(item.status))
        .filter((item) => sameConversation(item.url, url))
        .filter((item) => !prompt || !item.prompt || item.prompt === prompt || now - item.startedAt < 15_000)
        .sort((a, b) => b.updatedAt - a.updatedAt)[0] || null;
    }

    if (!task) {
      task = normalizeTask({
        id: createTaskId(),
        status: "running",
        createdAt: now,
        startedAt: now,
        url,
        prompt,
        title: questionTitle
      });
    }

    task.status = "running";
    bindNormalTab(task, tab);
    task.url = url;
    task.conversationKey = getConversationKey(url);
    task.title = questionTitle;
    task.prompt = prompt;
    task.baselineAssistantHash = message.baselineAssistantHash || task.baselineAssistantHash || "";
    task.latestAssistantHash = message.latestAssistantHash || task.latestAssistantHash || "";
    task.startedAt = task.finishedAt ? now : task.startedAt || now;
    task.finishedAt = null;
    task.cleanupAt = 0;
    task.manualMonitorClosed = false;
    task.lastHeartbeatAt = now;
    task.lastContentChangeAt = now;
    task.updatedAt = now;
    resetRecovery(task);

    state.tasks[task.id] = task;
    state.tasks = pruneTasks(state.tasks);
    await writeTasks(state.tasks);
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
    const now = Date.now();
    task.status = message.status || task.status;
    task.url = sanitizeChatUrl(message.url || sender.tab?.url || task.url);
    task.conversationKey = getConversationKey(task.url);
    task.prompt = cleanText(message.prompt || task.prompt || "ChatGPT 任务", 160);
    task.title = cleanText(message.questionTitle || task.title || task.prompt || "ChatGPT 任务", 80);
    task.assistantFirstLine = cleanText(message.assistantFirstLine || task.assistantFirstLine || "", 240);
    task.thinkingTimeText = cleanText(message.thinkingTimeText || task.thinkingTimeText || "", 60);
    task.latestAssistantHash = message.latestAssistantHash || task.latestAssistantHash || "";
    task.lastHeartbeatAt = now;
    task.lastContentChangeAt = Number(message.lastContentChangeAt || now);
    task.updatedAt = now;
    if (sender.tab?.id) {
      if (task.monitorTabId === sender.tab.id) bindMonitorTab(task, sender.tab, task.monitorGroupId);
      else bindNormalTab(task, sender.tab);
    }

    if (FINISHED_STATUSES.has(task.status)) {
      task.finishedAt = now;
      if (!task.thinkingTimeText) task.thinkingTimeText = formatElapsed(now - task.startedAt);
    }
    resetRecovery(task);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);

    if (previousStatus !== task.status) await maybeNotify(task, state.settings);
    if (task.status === "completed") {
      await scheduleMonitorCleanup(state, task, state.settings.completedTabGraceSeconds * 1000);
    } else if (task.status === "failed") {
      await scheduleMonitorCleanup(state, task, 5_000);
    }

    state.tasks = pruneTasks(state.tasks);
    await writeTasks(state.tasks);
    return { ok: true, task: publicTask(task, sender.tab?.id) };
  });
}

async function handleHeartbeat(message, sender) {
  return enqueueMutation(async () => {
    const state = await readState();
    let task = message.taskId ? state.tasks[message.taskId] : null;
    if (!task && sender.tab?.id) task = findTaskByTab(state.tasks, sender.tab.id, true);
    if (!task) return { ok: true, task: null };

    const now = Date.now();
    task.url = sanitizeChatUrl(message.url || sender.tab?.url || task.url);
    task.conversationKey = getConversationKey(task.url);
    if (message.latestAssistantHash && message.latestAssistantHash !== task.latestAssistantHash) {
      task.latestAssistantHash = message.latestAssistantHash;
      task.lastContentChangeAt = now;
    }
    task.lastHeartbeatAt = now;
    task.updatedAt = now;
    if (sender.tab?.id) {
      if (task.monitorTabId === sender.tab.id) bindMonitorTab(task, sender.tab, task.monitorGroupId);
      else bindNormalTab(task, sender.tab);
    }
    resetRecovery(task);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return { ok: true, task: publicTask(task, sender.tab?.id) };
  });
}

async function handleTabRemoved(tabId, removeInfo) {
  let recovery = null;
  await enqueueMutation(async () => {
    const state = await readState();
    const affected = Object.values(state.tasks).filter((task) => getTaskTabIds(task).includes(tabId));
    if (!affected.length) return;

    for (const task of affected) {
      const wasMonitor = task.monitorTabId === tabId;
      const suppressed = task.suppressRemovalUntil > Date.now();
      unbindTab(task, tabId);
      task.lastKnownWindowId = Number.isInteger(removeInfo?.windowId) ? removeInfo.windowId : task.lastKnownWindowId;
      task.updatedAt = Date.now();

      if (wasMonitor && ACTIVE_STATUSES.has(task.status) && !suppressed) {
        if (task.normalTabIds.length) {
          task.observerMode = "normal_tab";
        } else {
          task.manualMonitorClosed = true;
          task.status = "monitor_stopped";
          task.observerMode = "lost";
          task.observerLostReason = "后台标签已被手动关闭";
        }
      } else if (!wasMonitor && ACTIVE_STATUSES.has(task.status) && !task.normalTabIds.length && !task.monitorTabId) {
        recovery = { taskId: task.id, windowId: removeInfo?.windowId ?? task.lastKnownWindowId };
      }
      state.tasks[task.id] = task;
    }
    await writeTasks(state.tasks);
  });

  if (recovery) await ensureTaskObserver(recovery.taskId, recovery.windowId);
}

async function handleTabUpdated(tabId, changeInfo, tab) {
  if (!changeInfo.url && typeof changeInfo.discarded === "undefined") return;
  await enqueueMutation(async () => {
    const state = await readState();
    const tasks = Object.values(state.tasks).filter((task) => getTaskTabIds(task).includes(tabId));
    for (const task of tasks) {
      if (changeInfo.url) {
        task.url = sanitizeChatUrl(changeInfo.url);
        task.conversationKey = getConversationKey(task.url);
      }
      if (changeInfo.discarded === true && task.monitorTabId === tabId) {
        task.lastHeartbeatAt = 0;
      }
      if (Number.isInteger(tab?.windowId)) task.lastKnownWindowId = tab.windowId;
      task.updatedAt = Date.now();
      state.tasks[task.id] = task;
    }
    if (tasks.length) await writeTasks(state.tasks);
  });
}

async function handleTabActivated(tabId) {
  const state = await readState();
  const task = Object.values(state.tasks).find((item) => item.monitorTabId === tabId);
  if (task) await promoteMonitorTab(task.id, { focus: false });
}

function parseTaskIdFromNotification(notificationId) {
  const match = /^chatgpt-task:([^:]+):/.exec(notificationId || "");
  return match?.[1] || null;
}
