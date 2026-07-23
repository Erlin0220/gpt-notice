async function maybeNotify(task, settings) {
  const title = cleanText(task.title || task.prompt || "ChatGPT 任务", 80);
  const completedMessage = [
    task.thinkingTimeText || formatElapsed((task.finishedAt || Date.now()) - task.startedAt),
    task.assistantFirstLine
  ].filter(Boolean).join("，") || "任务已完成。";

  const config = {
    completed: {
      enabled: settings.notifyCompleted,
      message: completedMessage,
      priority: 1,
      requireInteraction: false,
      contextMessage: "点击查看完整回复"
    },
    waiting_action: {
      enabled: settings.notifyAttention,
      message: "等待确认、授权或继续操作。",
      priority: 2,
      requireInteraction: true,
      contextMessage: "点击打开对应会话"
    },
    failed: {
      enabled: settings.notifyFailed,
      message: "任务可能失败或遇到错误。",
      priority: 2,
      requireInteraction: true,
      contextMessage: "点击打开对应会话"
    },
    observer_lost: {
      enabled: settings.notifyFailed,
      message: task.observerLostReason || "后台监控连接已丢失，请打开会话重新接管。",
      priority: 2,
      requireInteraction: true,
      contextMessage: "点击重新打开会话"
    },
    monitor_stopped: {
      enabled: false,
      message: "后台监控已停止。",
      priority: 1,
      requireInteraction: false,
      contextMessage: ""
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
    contextMessage: config.contextMessage,
    priority: config.priority,
    requireInteraction: config.requireInteraction,
    buttons: [{ title: "打开会话" }]
  });
}

async function showTestNotification() {
  await chrome.notifications.create(`chatgpt-test:${Date.now()}`, {
    type: "basic",
    iconUrl: chrome.runtime.getURL(NOTIFICATION_ICON),
    title: "测试问题标题",
    message: "思考了 1m 23s，后台标签组通知测试成功。",
    priority: 1
  });
}

async function isAnyTaskTabFocused(task) {
  for (const tabId of getTaskTabIds(task)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      const win = await chrome.windows.get(tab.windowId);
      if (tab.active && win.focused) return true;
    } catch {
      // Ignore stale bindings.
    }
  }
  return false;
}

async function scheduleMonitorCleanup(state, task, delayMs) {
  if (!task.monitorTabId || !state.settings.closeMonitorWhenDone) return;
  if (task.normalTabIds.length) {
    await closeMonitorTabForTask(state, task, "normal-tab-exists");
    return;
  }
  task.cleanupAt = Date.now() + Math.max(0, Number(delayMs || 0));
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);
}

async function focusExistingTab(tab) {
  if (!tab?.id || !Number.isInteger(tab.windowId)) return;
  try {
    const win = await chrome.windows.get(tab.windowId);
    const patch = { focused: true };
    if (win.state === "minimized") patch.state = "normal";
    await chrome.windows.update(tab.windowId, patch);
    await chrome.tabs.update(tab.id, { active: true });
  } catch {
    // The tab may have disappeared between lookup and focus.
  }
}

async function createNormalTab(url, preferredWindowId = null) {
  const target = await chooseMonitorWindow(preferredWindowId);
  if (target?.id) {
    const tab = await chrome.tabs.create({
      windowId: target.id,
      url: sanitizeChatUrl(url),
      active: true
    });
    await chrome.windows.update(target.id, { focused: true });
    return tab;
  }
  const createdWindow = await chrome.windows.create({
    type: "normal",
    url: sanitizeChatUrl(url),
    focused: true
  });
  return createdWindow?.tabs?.[0] || null;
}

async function openTask(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task) return;

  await reconcileTaskBindings(task);
  const normalTabs = [];
  for (const tabId of task.normalTabIds) {
    try { normalTabs.push(await chrome.tabs.get(tabId)); } catch {}
  }
  const matchingNormal = choosePreferredTab(
    mergeTabs(normalTabs, (await findConversationTabs(task.url)).filter((tab) => tab.id !== task.monitorTabId)),
    task
  );
  if (matchingNormal) {
    await focusExistingTab(matchingNormal);
    return;
  }

  if (task.monitorTabId) {
    const promoted = await promoteMonitorTab(task.id, { focus: true });
    if (promoted) return;
  }

  const created = await createNormalTab(task.url, task.lastKnownWindowId);
  if (created?.id && ACTIVE_STATUSES.has(task.status)) {
    await enqueueMutation(async () => {
      const fresh = await readState();
      const current = fresh.tasks[task.id];
      if (!current) return;
      bindNormalTab(current, created);
      current.updatedAt = Date.now();
      fresh.tasks[current.id] = current;
      await writeTasks(fresh.tasks);
    });
  }
}

async function openChat() {
  const tabs = await queryChatTabs();
  if (tabs.length) {
    const tab = tabs.find((item) => item.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    await focusExistingTab(tab);
    return;
  }
  await createNormalTab("https://chatgpt.com/");
}

async function stopTask(taskId) {
  return enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task) return;
    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.manualMonitorClosed = true;
    task.observerLostReason = "用户停止监控";
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    if (task.monitorTabId) await closeMonitorTabForTask(state, task, "user-stop");
  });
}

async function resumeTask(taskId) {
  let shouldRecover = false;
  let preferredWindowId = null;
  await enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task) return;
    task.status = "running";
    task.finishedAt = null;
    task.manualMonitorClosed = false;
    task.observerLostReason = "";
    task.cleanupAt = 0;
    resetRecovery(task);
    task.updatedAt = Date.now();
    shouldRecover = !task.normalTabIds.length && !task.monitorTabId;
    preferredWindowId = task.lastKnownWindowId;
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
  });
  if (shouldRecover) await ensureTaskObserver(taskId, preferredWindowId);
}

async function getPopupState() {
  const state = await readState();
  for (const task of Object.values(state.tasks)) await reconcileTaskBindings(task);
  await writeTasks(state.tasks);
  const tasks = Object.values(state.tasks)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 16)
    .map((task) => publicTask(task));
  return {
    ok: true,
    settings: state.settings,
    tasks,
    permissionLevel: await chrome.notifications.getPermissionLevel()
  };
}

async function updateSettings(partialSettings) {
  const current = await readSettings();
  const settings = { ...current, ...partialSettings };
  settings.completedTabGraceSeconds = Math.max(0, Math.min(300, Number(settings.completedTabGraceSeconds || 30)));
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });

  if (!settings.autoKeepAlive || settings.backgroundMonitorMode === "disabled") {
    await enqueueMutation(async () => {
      const state = await readState();
      for (const task of Object.values(state.tasks)) {
        if (!task.monitorTabId) continue;
        if (ACTIVE_STATUSES.has(task.status) && !task.normalTabIds.length) {
          task.status = "monitor_stopped";
          task.observerMode = "lost";
          task.observerLostReason = "后台标签组监控已关闭";
        }
        await closeMonitorTabForTask(state, task, "settings-disabled");
      }
      await writeTasks(state.tasks);
    });
  }
  return { ok: true, settings };
}

async function clearHistory() {
  return enqueueMutation(async () => {
    const state = await readState();
    state.tasks = Object.fromEntries(
      Object.entries(state.tasks).filter(([, task]) => {
        return ACTIVE_STATUSES.has(task.status) || RESTARTABLE_STATUSES.has(task.status);
      })
    );
    await writeTasks(state.tasks);
  });
}
