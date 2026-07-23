async function queryChatTabs() {
  const windows = await getNormalWindows({ populate: true });
  return windows
    .flatMap((win) => win.tabs || [])
    .filter((tab) => {
      try {
        const hostname = new URL(tab.url || "").hostname;
        return hostname === "chatgpt.com" || hostname === "chat.openai.com";
      } catch {
        return false;
      }
    });
}

async function getValidTaskTabs(task) {
  const tabs = [];
  for (const tabId of getTaskTabIds(task)) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && (sameConversation(tab.url, task.url) || samePageUrl(tab.url, task.url))) {
        tabs.push(tab);
      }
    } catch {
      // Stale bindings are removed by reconcileTaskBindings.
    }
  }
  return tabs;
}

async function findConversationTabs(url) {
  const tabs = await queryChatTabs();
  const key = getConversationKey(url);
  return tabs.filter((tab) => {
    if (!tab.url) return false;
    return key ? sameConversation(tab.url, url) : samePageUrl(tab.url, url);
  });
}

function mergeTabs(...lists) {
  const byId = new Map();
  for (const list of lists) {
    for (const tab of list || []) {
      if (Number.isInteger(tab?.id)) byId.set(tab.id, tab);
    }
  }
  return [...byId.values()];
}

function choosePreferredTab(tabs, task) {
  if (!tabs?.length) return null;
  return [...tabs].sort((a, b) => {
    const aMonitor = a.id === task?.monitorTabId ? 1 : 0;
    const bMonitor = b.id === task?.monitorTabId ? 1 : 0;
    if (aMonitor !== bMonitor) return aMonitor - bMonitor;
    if (Boolean(a.active) !== Boolean(b.active)) return Number(b.active) - Number(a.active);
    return (b.lastAccessed || 0) - (a.lastAccessed || 0);
  })[0];
}

async function makeMonitorTabDurable(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.update(tabId, {
      active: false,
      muted: true,
      autoDiscardable: false
    });
  } catch {
    // The tab may have been closed during setup.
  }
}

async function reconcileTaskBindings(task) {
  const validNormalIds = [];
  for (const tabId of task.normalTabIds || []) {
    try {
      const tab = await chrome.tabs.get(tabId);
      if (tab?.url && (sameConversation(tab.url, task.url) || samePageUrl(tab.url, task.url))) {
        validNormalIds.push(tabId);
        if (Number.isInteger(tab.windowId)) task.lastKnownWindowId = tab.windowId;
      }
    } catch {
      // Remove stale binding.
    }
  }
  task.normalTabIds = validNormalIds;

  if (Number.isInteger(task.monitorTabId)) {
    try {
      const tab = await chrome.tabs.get(task.monitorTabId);
      if (!tab?.url || !(sameConversation(tab.url, task.url) || samePageUrl(tab.url, task.url))) {
        task.monitorTabId = null;
        task.monitorGroupId = null;
        task.monitorWindowId = null;
      } else {
        task.monitorWindowId = tab.windowId;
        task.lastKnownWindowId = tab.windowId;
      }
    } catch {
      task.monitorTabId = null;
      task.monitorGroupId = null;
      task.monitorWindowId = null;
    }
  }

  if (task.normalTabIds.length) task.observerMode = "normal_tab";
  else if (task.monitorTabId) task.observerMode = "group_tab";
  else if (ACTIVE_STATUSES.has(task.status)) task.observerMode = "lost";
  else task.observerMode = "none";
  return task;
}

async function createMonitorTabForTask(state, task, preferredWindowId = null) {
  if (!ACTIVE_STATUSES.has(task.status)) return null;
  if (!state.settings.autoKeepAlive || state.settings.backgroundMonitorMode !== "tab_group") {
    task.observerMode = "lost";
    task.observerLostReason = "已关闭后台标签组监控";
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return null;
  }
  if (task.monitorCreating) return null;

  await reconcileTaskBindings(task);
  if (task.normalTabIds.length) {
    task.observerMode = "normal_tab";
    resetRecovery(task);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return chrome.tabs.get(task.normalTabIds[0]).catch(() => null);
  }

  if (Number.isInteger(task.monitorTabId)) {
    try {
      const tab = await chrome.tabs.get(task.monitorTabId);
      await makeMonitorTabDurable(tab.id);
      const groupId = await getOrCreateMonitorGroup(tab.windowId, tab.id, task.monitorGroupId);
      bindMonitorTab(task, tab, groupId);
      resetRecovery(task);
      task.updatedAt = Date.now();
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);
      return tab;
    } catch {
      task.monitorTabId = null;
      task.monitorGroupId = null;
      task.monitorWindowId = null;
    }
  }

  const existing = choosePreferredTab(await findConversationTabs(task.url), task);
  if (existing) {
    bindNormalTab(task, existing);
    resetRecovery(task);
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return existing;
  }

  const targetWindow = await chooseMonitorWindow(preferredWindowId ?? task.lastKnownWindowId);
  if (!targetWindow?.id) {
    task.status = "observer_lost";
    task.observerMode = "lost";
    task.observerLostReason = "没有可用于后台监控的普通 Chrome 窗口";
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    await maybeNotify(task, state.settings);
    return null;
  }

  task.monitorCreating = true;
  task.monitorExpected = true;
  task.lastKnownWindowId = targetWindow.id;
  task.observerMode = "lost";
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);

  let tab = null;
  try {
    tab = await chrome.tabs.create({
      windowId: targetWindow.id,
      url: task.url || "https://chatgpt.com/",
      active: false,
      index: 999
    });
    await makeMonitorTabDurable(tab.id);
    const groupId = await getOrCreateMonitorGroup(targetWindow.id, tab.id, task.monitorGroupId);
    bindMonitorTab(task, tab, groupId);
    task.updatedAt = Date.now();
    task.lastHeartbeatAt = 0;
    resetRecovery(task);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    await collapseMonitorGroup(groupId);
    return tab;
  } catch (error) {
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
    task.monitorCreating = false;
    task.monitorExpected = false;
    task.monitorTabId = null;
    task.monitorGroupId = null;
    task.monitorWindowId = null;
    task.status = "observer_lost";
    task.observerMode = "lost";
    task.observerLostReason = cleanText(`后台标签创建失败：${error?.message || error}`, 160);
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    await maybeNotify(task, state.settings);
    return null;
  }
}

async function ensureTaskObserver(taskId, preferredWindowId = null) {
  return enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task || !ACTIVE_STATUSES.has(task.status)) return null;
    return createMonitorTabForTask(state, task, preferredWindowId);
  });
}

async function promoteMonitorTab(taskId, { focus = true } = {}) {
  return enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task?.monitorTabId) return null;

    let tab;
    try {
      tab = await chrome.tabs.get(task.monitorTabId);
    } catch {
      unbindTab(task, task.monitorTabId);
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);
      return null;
    }

    await ungroupMonitorTab(tab.id);
    try {
      await chrome.tabs.update(tab.id, {
        muted: false,
        autoDiscardable: true,
        active: Boolean(focus)
      });
    } catch {}

    bindNormalTab(task, tab);
    task.cleanupAt = 0;
    task.updatedAt = Date.now();
    resetRecovery(task);
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);

    if (focus) {
      try {
        const win = await chrome.windows.get(tab.windowId);
        const patch = { focused: true };
        if (win.state === "minimized") patch.state = "normal";
        await chrome.windows.update(tab.windowId, patch);
        await chrome.tabs.update(tab.id, { active: true });
      } catch {}
    }
    return tab;
  });
}

async function closeMonitorTabForTask(state, task, reason = "cleanup") {
  const tabId = task.monitorTabId;
  if (!Number.isInteger(tabId)) return;
  task.suppressRemovalUntil = Date.now() + 15_000;
  task.monitorTabId = null;
  task.monitorGroupId = null;
  task.monitorWindowId = null;
  task.cleanupAt = 0;
  task.observerMode = task.normalTabIds.length
    ? "normal_tab"
    : ACTIVE_STATUSES.has(task.status)
      ? "lost"
      : "none";
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);
  try {
    await chrome.tabs.remove(tabId);
  } catch {
    // Already closed.
  }
}

async function migrateLegacyObservers() {
  return enqueueMutation(async () => {
    const state = await readState();
    await removeStaleMonitorGroupReferences(state.tasks);

    for (const task of Object.values(state.tasks)) {
      await reconcileTaskBindings(task);
      if (!ACTIVE_STATUSES.has(task.status) || !task.monitorTabId) continue;

      let monitorWindow = null;
      try {
        monitorWindow = await chrome.windows.get(task.monitorWindowId || (await chrome.tabs.get(task.monitorTabId)).windowId);
      } catch {}
      if (!monitorWindow || monitorWindow.type === "normal") continue;

      const legacyTabId = task.monitorTabId;
      const legacyWindowId = monitorWindow.id;
      task.monitorTabId = null;
      task.monitorGroupId = null;
      task.monitorWindowId = null;
      task.monitorCreating = false;
      task.monitorExpected = false;
      state.tasks[task.id] = task;
      await writeTasks(state.tasks);

      const newTab = await createMonitorTabForTask(state, task, task.lastKnownWindowId);
      if (newTab?.id) {
        try { await chrome.windows.remove(legacyWindowId); } catch {
          try { await chrome.tabs.remove(legacyTabId); } catch {}
        }
      } else {
        task.monitorTabId = legacyTabId;
        task.monitorWindowId = legacyWindowId;
        task.observerMode = "group_tab";
        state.tasks[task.id] = task;
        await writeTasks(state.tasks);
      }
    }

    state.meta.storageSchemaVersion = STORAGE_SCHEMA_VERSION;
    await writeState(state);
  });
}

async function reconcileAllObservers() {
  return enqueueMutation(async () => {
    const state = await readState();
    await removeStaleMonitorGroupReferences(state.tasks);
    const toRecover = [];
    for (const task of Object.values(state.tasks)) {
      await reconcileTaskBindings(task);
      if (ACTIVE_STATUSES.has(task.status) && !task.normalTabIds.length && !task.monitorTabId) {
        if (task.manualMonitorClosed && !state.settings.autoRecoverManuallyClosedMonitor) {
          task.status = "monitor_stopped";
          task.observerMode = "lost";
          task.observerLostReason = "后台标签已被手动关闭";
        } else {
          toRecover.push({ taskId: task.id, windowId: task.lastKnownWindowId });
        }
      }
      state.tasks[task.id] = task;
    }
    await writeTasks(state.tasks);
    for (const item of toRecover) {
      await createMonitorTabForTask(state, state.tasks[item.taskId], item.windowId);
    }
  });
}
