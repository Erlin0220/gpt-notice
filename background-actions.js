async function createMonitorWindow(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task || !ACTIVE_STATUSES.has(task.status) || !state.settings.autoKeepAlive) return;
  if (task.monitorCreating) return;

  const boundTabs = await getValidBoundTabs(task);
  const existingTabs = mergeTabs(boundTabs, await findConversationTabs(task.url));
  if (existingTabs.length) {
    const existing = choosePreferredTab(existingTabs, task);
    bindTaskToTab(task, existing, { isMonitor: existing.id === task.monitorTabId });
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);
    return;
  }

  task.monitorCreating = true;
  task.monitorExpected = true;
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);

  try {
    const createdWindow = await chrome.windows.create({
      url: task.url || "https://chatgpt.com/",
      type: "popup",
      state: "minimized",
      focused: false
    });

    const monitorTab = createdWindow?.tabs?.[0];
    const fresh = await readState();
    const current = fresh.tasks[taskId];
    if (!current) return;

    current.monitorCreating = false;
    current.monitorExpected = false;
    if (monitorTab?.id) bindTaskToTab(current, monitorTab, { isMonitor: true });
    if (createdWindow?.id != null) current.monitorWindowId = createdWindow.id;
    current.updatedAt = Date.now();
    fresh.tasks[taskId] = current;
    await writeTasks(fresh.tasks);

    if (monitorTab?.id) await makeMonitorTabDurable(monitorTab.id);
    if (createdWindow?.id) {
      setTimeout(() => {
        chrome.windows.update(createdWindow.id, { state: "minimized" }).catch(() => {});
      }, 700);
    }
  } catch (error) {
    console.warn("[ChatGPT Task Notifier] failed to create monitor window", error);
    const fresh = await readState();
    const current = fresh.tasks[taskId];
    if (current) {
      current.monitorCreating = false;
      current.monitorExpected = false;
      current.updatedAt = Date.now();
      fresh.tasks[taskId] = current;
      await writeTasks(fresh.tasks);
    }
  }
}

async function makeMonitorTabDurable(tabId) {
  try {
    await chrome.tabs.update(tabId, {
      muted: true,
      autoDiscardable: false
    });
  } catch (error) {
    console.debug("[ChatGPT Task Notifier] unable to protect monitor tab", error);
  }
}

async function closeMonitorTask(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task?.monitorTabId) return;

  const monitorTabId = task.monitorTabId;
  const monitorWindowId = task.monitorWindowId;
  task.suppressRespawnUntil = Date.now() + 10000;
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);

  setTimeout(async () => {
    try {
      if (monitorWindowId) await chrome.windows.remove(monitorWindowId);
      else await chrome.tabs.remove(monitorTabId);
    } catch {
      // Window or tab may already be closed.
    }
  }, 1200);
}

async function openTask(taskId) {
  const state = await readState();
  const task = state.tasks[taskId];
  if (!task) return;

  const boundTabs = await getValidBoundTabs(task);
  const matchingTabs = mergeTabs(boundTabs, await findConversationTabs(task.url));
  const tab = choosePreferredTab(matchingTabs, task);
  if (tab) {
    await focusExistingTab(tab);
    return;
  }

  const created = await createTabInNormalWindow(task.url || "https://chatgpt.com/");
  if (created?.id && ACTIVE_STATUSES.has(task.status)) {
    await enqueueMutation(async () => {
      const fresh = await readState();
      const current = fresh.tasks[taskId];
      if (!current) return;
      bindTaskToTab(current, created, { isMonitor: false });
      current.updatedAt = Date.now();
      fresh.tasks[taskId] = current;
      await writeTasks(fresh.tasks);
    });
  }
}

async function openChat() {
  const tabs = await queryChatTabs();
  if (tabs.length) {
    const active = tabs.find((tab) => tab.active) || tabs.sort((a, b) => (b.lastAccessed || 0) - (a.lastAccessed || 0))[0];
    await focusExistingTab(active);
    return;
  }
  await createTabInNormalWindow("https://chatgpt.com/");
}

async function focusExistingTab(tab) {
  if (!tab?.id || tab.windowId == null) return;
  const win = await chrome.windows.get(tab.windowId);
  const update = { focused: true };
  if (win.state === "minimized") update.state = "normal";
  await chrome.windows.update(tab.windowId, update);
  await chrome.tabs.update(tab.id, { active: true });
}

async function createTabInNormalWindow(url) {
  const normalWindows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const targetWindow = normalWindows.find((win) => win.focused) || normalWindows.at(-1);
  if (targetWindow?.id) {
    const tab = await chrome.tabs.create({ windowId: targetWindow.id, url, active: true });
    await chrome.windows.update(targetWindow.id, { focused: true });
    return tab;
  }

  const createdWindow = await chrome.windows.create({ url, focused: true, type: "normal" });
  return createdWindow?.tabs?.[0] || null;
}

async function stopTask(taskId) {
  await enqueueMutation(async () => {
    const state = await readState();
    const task = state.tasks[taskId];
    if (!task) return;

    task.status = "cancelled";
    task.finishedAt = Date.now();
    task.suppressRespawnUntil = Date.now() + 10000;
    task.updatedAt = Date.now();
    state.tasks[task.id] = task;
    await writeTasks(state.tasks);

    if (task.monitorTabId) {
      try {
        if (task.monitorWindowId) await chrome.windows.remove(task.monitorWindowId);
        else await chrome.tabs.remove(task.monitorTabId);
      } catch {
        // Already closed.
      }
    }
  });
}

async function getPopupState() {
  const state = await readState();
  const tasks = Object.values(state.tasks)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .slice(0, 12)
    .map((task) => publicTask(task));

  const permissionLevel = await chrome.notifications.getPermissionLevel();
  return {
    ok: true,
    settings: state.settings,
    tasks,
    permissionLevel
  };
}

async function updateSettings(partialSettings) {
  const current = await readSettings();
  const settings = { ...current, ...partialSettings };
  await chrome.storage.local.set({ [STORAGE_KEYS.SETTINGS]: settings });
  return { ok: true, settings };
}

async function clearHistory() {
  await enqueueMutation(async () => {
    const state = await readState();
    const tasks = Object.fromEntries(
      Object.entries(state.tasks).filter(([, task]) => ACTIVE_STATUSES.has(task.status))
    );
    await writeTasks(tasks);
  });
}
