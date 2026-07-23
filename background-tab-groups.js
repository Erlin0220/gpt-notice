async function getNormalWindows({ populate = true } = {}) {
  try {
    return await chrome.windows.getAll({ populate, windowTypes: ["normal"] });
  } catch {
    return [];
  }
}

async function chooseMonitorWindow(preferredWindowId = null) {
  const windows = await getNormalWindows({ populate: false });
  if (!windows.length) return null;
  if (Number.isInteger(preferredWindowId)) {
    const preferred = windows.find((win) => win.id === preferredWindowId);
    if (preferred) return preferred;
  }
  return windows.find((win) => win.focused) || windows.at(-1) || windows[0];
}

async function getOrCreateMonitorGroup(windowId, tabId, preferredGroupId = null) {
  if (!Number.isInteger(windowId) || !Number.isInteger(tabId)) {
    throw new Error("A normal window and tab are required to create the monitor group");
  }

  let groupId = null;
  if (Number.isInteger(preferredGroupId)) {
    try {
      const existing = await chrome.tabGroups.get(preferredGroupId);
      if (existing.windowId === windowId) groupId = preferredGroupId;
    } catch {
      groupId = null;
    }
  }

  if (!Number.isInteger(groupId)) {
    try {
      const groups = await chrome.tabGroups.query({ windowId });
      const reusable = groups.find((group) => group.title === MONITOR_GROUP_TITLE);
      if (reusable) groupId = reusable.id;
    } catch {
      groupId = null;
    }
  }

  if (Number.isInteger(groupId)) {
    await chrome.tabs.group({ tabIds: [tabId], groupId });
  } else {
    groupId = await chrome.tabs.group({ tabIds: [tabId] });
  }

  await chrome.tabGroups.update(groupId, {
    title: MONITOR_GROUP_TITLE,
    color: "grey",
    collapsed: true
  });
  return groupId;
}

async function collapseMonitorGroup(groupId) {
  if (!Number.isInteger(groupId)) return;
  try {
    await chrome.tabGroups.update(groupId, {
      title: MONITOR_GROUP_TITLE,
      color: "grey",
      collapsed: true
    });
  } catch {
    // The group may have disappeared when its last tab was removed.
  }
}

async function ungroupMonitorTab(tabId) {
  if (!Number.isInteger(tabId)) return;
  try {
    await chrome.tabs.ungroup([tabId]);
  } catch {
    // The tab may already be outside a group or already closed.
  }
}

async function removeStaleMonitorGroupReferences(tasks) {
  const groupIds = [...new Set(
    Object.values(tasks)
      .map((task) => task.monitorGroupId)
      .filter(Number.isInteger)
  )];
  const valid = new Set();
  for (const groupId of groupIds) {
    try {
      const group = await chrome.tabGroups.get(groupId);
      if (group.title === MONITOR_GROUP_TITLE) valid.add(groupId);
    } catch {
      // Stale IDs are expected after browser restarts.
    }
  }
  for (const task of Object.values(tasks)) {
    if (Number.isInteger(task.monitorGroupId) && !valid.has(task.monitorGroupId)) {
      task.monitorGroupId = null;
    }
  }
}
