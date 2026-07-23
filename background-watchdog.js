async function ensureWatchdogAlarm() {
  try {
    const existing = await chrome.alarms.get(WATCHDOG_ALARM);
    if (!existing) {
      chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
    }
  } catch {
    chrome.alarms.create(WATCHDOG_ALARM, { periodInMinutes: 0.5 });
  }
}

async function probeTaskTab(tabId) {
  try {
    const result = await chrome.tabs.sendMessage(tabId, { type: "PROBE_TASK_STATE" });
    return result?.ok ? result : null;
  } catch {
    return null;
  }
}

function applyProbeResult(task, probe, now = Date.now()) {
  if (!probe) return false;
  task.lastProbeAt = now;
  task.lastHeartbeatAt = now;
  if (probe.latestAssistantHash && probe.latestAssistantHash !== task.latestAssistantHash) {
    task.latestAssistantHash = probe.latestAssistantHash;
    task.lastContentChangeAt = now;
  }
  task.assistantFirstLine = cleanText(probe.assistantFirstLine || task.assistantFirstLine || "", 240);
  task.thinkingTimeText = cleanText(probe.thinkingTimeText || task.thinkingTimeText || "", 60);
  task.url = sanitizeChatUrl(probe.url || task.url);
  task.conversationKey = getConversationKey(task.url);

  if (probe.visibleError && !probe.stopVisible) task.status = "failed";
  else if (probe.waitingAction && !probe.stopVisible) task.status = "waiting_action";
  else if (probe.completed) task.status = "completed";
  else if (probe.stopVisible || probe.busy) task.status = "running";

  if (FINISHED_STATUSES.has(task.status)) task.finishedAt = task.finishedAt || now;
  resetRecovery(task);
  task.updatedAt = now;
  return true;
}

async function markObserverLost(state, task, reason) {
  const previousStatus = task.status;
  task.status = "observer_lost";
  task.observerMode = "lost";
  task.observerLostReason = cleanText(reason || "后台监控连接已丢失", 160);
  task.updatedAt = Date.now();
  state.tasks[task.id] = task;
  await writeTasks(state.tasks);
  if (previousStatus !== task.status) await maybeNotify(task, state.settings);
}

async function recoverTaskObserver(state, task, tab = null) {
  const now = Date.now();
  if (task.nextRecoveryAt && now < task.nextRecoveryAt) return;
  if (!registerRecoveryAttempt(task, now)) {
    await markObserverLost(state, task, "10 分钟内恢复失败 3 次，请打开会话重新接管");
    return;
  }

  state.tasks[task.id] = task;
  await writeTasks(state.tasks);

  if (tab?.id) {
    if (tab.discarded && !state.settings.autoRecoverDiscardedTab) return;
    if (tab.active) {
      // Avoid flashing or interrupting the tab the user is currently viewing.
      return;
    }
    try {
      await chrome.tabs.reload(tab.id);
      return;
    } catch {
      // Fall through to observer recreation.
    }
  }

  task.monitorTabId = null;
  task.monitorGroupId = null;
  task.monitorWindowId = null;
  await createMonitorTabForTask(state, task, task.lastKnownWindowId);
}

async function handleTaskCleanup(state, task, now) {
  if (!task.cleanupAt || task.cleanupAt > now) return false;
  if (task.monitorTabId) await closeMonitorTabForTask(state, task, "cleanup");
  else {
    task.cleanupAt = 0;
    state.tasks[task.id] = task;
  }
  return true;
}

async function runWatchdog() {
  return enqueueMutation(async () => {
    const state = await readState();
    const now = Date.now();

    for (const task of Object.values(state.tasks)) {
      await reconcileTaskBindings(task);

      if (await handleTaskCleanup(state, task, now)) continue;
      if (!ACTIVE_STATUSES.has(task.status)) {
        state.tasks[task.id] = task;
        continue;
      }

      const tabs = await getValidTaskTabs(task);
      const preferred = choosePreferredTab(tabs, task);
      if (!preferred) {
        if (task.manualMonitorClosed && !state.settings.autoRecoverManuallyClosedMonitor) {
          task.status = "monitor_stopped";
          task.observerMode = "lost";
          task.observerLostReason = "后台标签已被手动关闭";
          task.updatedAt = now;
          state.tasks[task.id] = task;
          continue;
        }
        await recoverTaskObserver(state, task, null);
        continue;
      }

      const probe = await probeTaskTab(preferred.id);
      const previousStatus = task.status;
      if (applyProbeResult(task, probe, now)) {
        if (previousStatus !== task.status) await maybeNotify(task, state.settings);
        if (task.status === "completed") {
          await scheduleMonitorCleanup(state, task, state.settings.completedTabGraceSeconds * 1000);
        } else if (task.status === "failed") {
          await scheduleMonitorCleanup(state, task, 5_000);
        }
        state.tasks[task.id] = task;
        continue;
      }

      const heartbeatAge = task.lastHeartbeatAt ? now - task.lastHeartbeatAt : Number.POSITIVE_INFINITY;
      if (heartbeatAge >= HEARTBEAT_STALE_MS || preferred.discarded) {
        await recoverTaskObserver(state, task, preferred);
      }
      state.tasks[task.id] = task;
    }

    state.tasks = pruneTasks(state.tasks);
    await writeTasks(state.tasks);
  });
}
