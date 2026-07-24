(() => {
  if (window.__CHATGPT_MESSAGE_QUEUE_V060_LOADED__) return;
  window.__CHATGPT_MESSAGE_QUEUE_V060_LOADED__ = true;

  const core = globalThis.ChatGPTQueueCore;
  if (!core) return;

  const INSPECT_INTERVAL_MS = 900;
  const SEND_CONFIRM_TIMEOUT_MS = 10_000;
  const COMPLETION_TO_NEXT_DELAY_MS = 2_500;
  const LEASE_TTL_MS = 15_000;
  const LEASE_REFRESH_MS = 5_000;
  const WRITE_LOCK_TTL_MS = 5_000;
  const WRITE_LOCK_ATTEMPTS = 12;
  const STORAGE_LOCK_NAME = "gpt-notice-queue-storage-v3";
  const INDEX_STORAGE_KEY = "messageQueueIndexV3";
  const ITEM_STORAGE_PREFIX = "messageQueueItemV3:";
  const LEGACY_STORAGE_KEY = core.QUEUE_STORAGE_KEY;
  const UI_ID = "chatgpt-message-queue-root";
  const STYLE_ID = "chatgpt-message-queue-style";
  const PREVIEW_LENGTH = 240;
  const MAX_AUTO_RETRY = 1;

  const runtime = {
    instanceId: getStableInstanceId(),
    temporaryKey: getTemporaryKey(),
    conversationKey: "",
    queue: null,
    assistantHash: "",
    assistantText: "",
    assistantChangedAt: Date.now(),
    lastUrl: location.href,
    lastSnapshot: null,
    inspectRunning: false,
    uiScheduled: false,
    uiActionInFlight: false,
    dispatching: false,
    sendConfirmation: null,
    manualSubmissionPendingUntil: 0,
    manualTaskObserved: false,
    deferredAutoItemId: "",
    uiNotice: "",
    storageWrite: Promise.resolve(),
    queueCache: new Map(),
    lastLeaseRefreshAt: 0,
    suppressComposerMutations: 0,
    observer: null
  };

  boot().catch((error) => console.warn("[ChatGPT Message Queue] boot failed", error));

  async function boot() {
    runtime.conversationKey = resolveConversationKey();
    resetAssistantTracking();
    runtime.queue = await loadQueue(runtime.conversationKey);
    await recoverInterruptedQueue();
    installStyles();
    ensureUi();
    installSubmissionListeners();
    installNavigationListeners();
    installStorageListener();
    installObserver();
    addEventListener("pagehide", releaseCurrentLease, { capture: true });
    setInterval(() => void inspect(), INSPECT_INTERVAL_MS);
    setInterval(() => void refreshLease(), LEASE_REFRESH_MS);
    await inspect();
  }

  function installStorageListener() {
    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local") return;
      const itemChanged = Object.keys(changes).some((key) => key.startsWith(ITEM_STORAGE_PREFIX));
      if (!changes[INDEX_STORAGE_KEY] && !itemChanged) return;
      void loadQueue(runtime.conversationKey, { forceTexts: itemChanged }).then((queue) => {
        runtime.queue = queue;
        scheduleUiRender();
      });
    });
  }

  function installObserver() {
    runtime.observer = new MutationObserver((mutations) => {
      if (runtime.suppressComposerMutations > 0) return;
      const root = document.getElementById(UI_ID);
      const composer = findComposer();
      const external = mutations.some((mutation) => {
        if (root?.contains(mutation.target)) return false;
        if (composer && composer.contains(mutation.target) && runtime.suppressComposerMutations > 0) return false;
        return true;
      });
      if (!external) return;
      scheduleUiRender();
      void inspect();
    });
    runtime.observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "disabled", "data-testid", "data-state", "data-conversation-id", "data-thread-id"]
    });
  }

  async function inspect() {
    if (runtime.inspectRunning) return;
    runtime.inspectRunning = true;
    try {
      await handleNavigationChange();
      ensureUi();
      const now = Date.now();
      const snapshot = collectSnapshot(now);
      updateAssistantTracking(snapshot.assistant, now);
      snapshot.stableForMs = now - runtime.assistantChangedAt;
      snapshot.taskRunning = resolveEffectiveTaskRunning(snapshot);
      snapshot.manualHold = isManualHoldActive(snapshot, now);
      runtime.lastSnapshot = snapshot;
      runtime.queue = await loadQueue(runtime.conversationKey);
      await handleSendConfirmation(snapshot, now);

      const activeItem = getActiveItem(runtime.queue);
      if (activeItem) {
        if (snapshot.visibleError && !snapshot.domRunning) await handleActiveFailure(activeItem, "ChatGPT 页面显示执行错误");
        else if (isQueueItemCompleted(activeItem, snapshot, now)) await completeActiveItem(activeItem, now);
      } else if (core.getNextPendingItem(runtime.queue)) {
        await dispatchNextItem(snapshot);
      }
      scheduleUiRender();
    } catch (error) {
      console.debug("[ChatGPT Message Queue] inspect failed", error);
    } finally {
      runtime.inspectRunning = false;
    }
  }

  function collectSnapshot(now = Date.now()) {
    const assistant = getLatestAssistant();
    const taskState = getNotifierTaskState();
    const composerText = getComposerText();
    const stopVisible = hasStopControl();
    const waitingAction = hasApprovalControl();
    const busy = hasBusyIndicator();
    return {
      assistant,
      assistantHash: assistant.hash,
      assistantText: assistant.text,
      assistantCount: assistant.count,
      stopVisible,
      waitingAction,
      busy,
      domRunning: stopVisible || waitingAction || busy,
      bridgeRunning: Boolean(taskState.running || ["running", "waiting_action"].includes(taskState.status)),
      taskStatus: String(taskState.status || ""),
      taskRunning: false,
      visibleError: findVisibleError(),
      composerReady: isComposerReady(),
      composerEmpty: !composerText,
      composerText,
      userCount: getUserMessages().length,
      stableForMs: now - runtime.assistantChangedAt,
      manualHold: false
    };
  }

  function resolveEffectiveTaskRunning(snapshot) {
    if (snapshot.domRunning) return true;
    const clearlyIdle = snapshot.composerReady && !snapshot.visibleError && snapshot.stableForMs >= 1_500;
    return snapshot.bridgeRunning && !clearlyIdle;
  }

  function updateAssistantTracking(assistant, now) {
    if (assistant.hash === runtime.assistantHash && assistant.text === runtime.assistantText) return;
    runtime.assistantHash = assistant.hash;
    runtime.assistantText = assistant.text;
    runtime.assistantChangedAt = now;
  }

  function resetAssistantTracking() {
    const assistant = getLatestAssistant();
    runtime.assistantHash = assistant.hash;
    runtime.assistantText = assistant.text;
    runtime.assistantChangedAt = Date.now();
  }

  function getNotifierTaskState() {
    try {
      const value = globalThis.ChatGPTTaskNotifierBridge?.getTaskState?.();
      return value && typeof value === "object" ? value : {};
    } catch {
      return {};
    }
  }

  function isManualHoldActive(snapshot, now) {
    if (snapshot.domRunning || snapshot.taskRunning) {
      runtime.manualTaskObserved = true;
      return true;
    }
    if (runtime.manualSubmissionPendingUntil > now) return true;
    if (!runtime.manualTaskObserved) return false;
    if (!snapshot.composerReady || snapshot.stableForMs < 2_500) return true;
    runtime.manualTaskObserved = false;
    runtime.manualSubmissionPendingUntil = 0;
    return false;
  }

  function installSubmissionListeners() {
    document.addEventListener("input", (event) => {
      if (runtime.suppressComposerMutations || !isComposerElement(event.target)) return;
      scheduleUiRender();
    }, true);
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("button");
      if (!button || runtime.dispatching || !looksLikeSendButton(button)) return;
      markManualSubmission();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (runtime.dispatching || event.key !== "Enter" || event.shiftKey || event.isComposing || !isComposerElement(event.target)) return;
      markManualSubmission();
    }, true);
    document.addEventListener("submit", (event) => {
      if (!runtime.dispatching && event.target?.querySelector?.("#prompt-textarea, textarea, [contenteditable='true']")) markManualSubmission();
    }, true);
  }

  function markManualSubmission() {
    runtime.manualSubmissionPendingUntil = Date.now() + SEND_CONFIRM_TIMEOUT_MS;
    runtime.manualTaskObserved = false;
    scheduleUiRender();
  }

  function installNavigationListeners() {
    for (const method of ["pushState", "replaceState"]) {
      const original = history[method];
      if (typeof original !== "function" || original.__gptQueuePatched) continue;
      const patched = function patchedHistory(...args) {
        const result = original.apply(this, args);
        queueMicrotask(() => void inspect());
        return result;
      };
      patched.__gptQueuePatched = true;
      history[method] = patched;
    }
    addEventListener("popstate", () => void inspect(), true);
    addEventListener("hashchange", () => void inspect(), true);
  }

  async function handleNavigationChange() {
    const currentUrl = location.href;
    const nextKey = resolveConversationKey();
    if (!nextKey || (currentUrl === runtime.lastUrl && nextKey === runtime.conversationKey)) return;
    if (nextKey === runtime.conversationKey) {
      runtime.lastUrl = currentUrl;
      return;
    }
    const previousKey = runtime.conversationKey;
    const previousUrl = runtime.lastUrl;
    if (core.shouldMigrateQueue(previousKey, nextKey)) await migrateQueue(previousKey, nextKey, previousUrl);
    else await releaseLease(previousKey);
    runtime.lastUrl = currentUrl;
    runtime.conversationKey = nextKey;
    runtime.queue = await loadQueue(nextKey);
    runtime.sendConfirmation = null;
    runtime.dispatching = false;
    runtime.manualSubmissionPendingUntil = 0;
    runtime.manualTaskObserved = false;
    runtime.deferredAutoItemId = "";
    resetAssistantTracking();
  }

  async function migrateQueue(fromKey, toKey, previousUrl) {
    const source = await loadQueue(fromKey);
    if (!source.items.length) return;
    await mutateQueueByKey(toKey, (target) => {
      const ids = new Set(target.items.map((item) => item.id));
      target.items.push(...source.items.filter((item) => !ids.has(item.id)));
      target.paused = source.paused || target.paused;
      target.activeItemId = source.activeItemId || target.activeItemId;
      target.nextDispatchAt = Math.max(source.nextDispatchAt, target.nextDispatchAt);
      target.conversationUrl = location.href;
      target.lease = null;
      return target;
    });
    await deleteQueue(fromKey, source);
    runtime.lastUrl = previousUrl;
  }

  async function recoverInterruptedQueue() {
    if (!runtime.queue || !core.shouldRecoverInterruptedQueue(runtime.queue, runtime.instanceId, Date.now())) return;
    runtime.queue = await mutateCurrentQueue((current) => {
      if (!core.shouldRecoverInterruptedQueue(current, runtime.instanceId, Date.now())) return current;
      const recovered = core.resetInterruptedItems(current);
      recovered.lease = null;
      return recovered;
    });
  }

  async function enqueueComposerText() {
    const now = Date.now();
    const snapshot = collectSnapshot(now);
    updateAssistantTracking(snapshot.assistant, now);
    snapshot.stableForMs = now - runtime.assistantChangedAt;
    snapshot.taskRunning = resolveEffectiveTaskRunning(snapshot);
    snapshot.manualHold = isManualHoldActive(snapshot, now);
    runtime.lastSnapshot = snapshot;
    runtime.queue = await loadQueue(runtime.conversationKey);
    if (!core.canAdmit(runtime.queue, snapshot)) {
      showUiNotice("当前没有正在进行的会话，不能加入队列");
      return;
    }
    const text = getComposerTextRaw();
    if (!text.trim()) return;
    showUiNotice(`正在加入队列… ${text.length.toLocaleString()} 字符`);
    await nextFrame();
    const item = core.createQueueItem(text);
    if (!item) return;
    if (!(await writeComposerText(""))) {
      showUiNotice("输入框清空失败，内容未加入队列");
      return;
    }
    try {
      await mutateCurrentQueue((queue) => {
        queue.items.push(item);
        queue.conversationUrl = location.href;
        return queue;
      });
    } catch (error) {
      await writeComposerText(text);
      throw error;
    }
    showUiNotice(`已加入队列 · ${item.text.length.toLocaleString()} 字符`);
    scheduleUiRender();
    void inspect();
  }

  async function dispatchNextItem(snapshot) {
    if (runtime.dispatching || runtime.sendConfirmation) return;
    runtime.queue = await loadQueue(runtime.conversationKey);
    const now = Date.now();
    const fresh = collectSnapshot(now);
    updateAssistantTracking(fresh.assistant, now);
    fresh.stableForMs = now - runtime.assistantChangedAt;
    fresh.taskRunning = resolveEffectiveTaskRunning(fresh);
    fresh.manualHold = isManualHoldActive(fresh, now);
    const next = core.getNextPendingItem(runtime.queue);
    if (!next || !canPrepareQueueDispatch(runtime.queue, fresh, now)) return;
    if (!fresh.composerEmpty) {
      if (runtime.deferredAutoItemId === next.id) return;
      openQueueConfirmation(document.getElementById(UI_ID), "auto-execute", next.id, "当前输入框内存在内容，是否覆盖并执行下一条队列任务？");
      return;
    }
    runtime.deferredAutoItemId = "";
    closeQueueConfirmation(document.getElementById(UI_ID), "auto-execute");
    await dispatchQueueItem(next.id, { allowOverwrite: false, source: "auto" });
  }

  function canPrepareQueueDispatch(queue, snapshot, now = Date.now()) {
    const normalized = core.normalizeQueue(queue, runtime.conversationKey);
    if (normalized.paused || normalized.activeItemId || !core.getNextPendingItem(normalized) || normalized.nextDispatchAt > now) return false;
    if (!snapshot.composerReady || snapshot.domRunning || snapshot.taskRunning || snapshot.visibleError || snapshot.manualHold) return false;
    return snapshot.stableForMs >= 4_000;
  }

  function canStartManualDispatch(snapshot) {
    return Boolean(snapshot.composerReady && !snapshot.domRunning && !snapshot.visibleError);
  }

  async function requestImmediateExecution(root, itemId) {
    await reconcilePageStateForAction();
    const queue = await loadQueue(runtime.conversationKey);
    const item = queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) {
      showUiNotice("该消息当前无法立即执行");
      return;
    }
    if (queue.activeItemId) {
      showUiNotice("上一条队列任务状态仍未解除，请稍后重试");
      return;
    }
    const now = Date.now();
    const snapshot = collectSnapshot(now);
    updateAssistantTracking(snapshot.assistant, now);
    snapshot.stableForMs = now - runtime.assistantChangedAt;
    snapshot.taskRunning = resolveEffectiveTaskRunning(snapshot);
    snapshot.manualHold = isManualHoldActive(snapshot, now);
    if (!canStartManualDispatch(snapshot)) {
      showUiNotice("当前页面仍在真实执行任务，暂时无法立即发送");
      return;
    }
    if (getComposerText()) {
      openQueueConfirmation(root, "execute-now", item.id, "当前输入框内存在内容，是否覆盖并立即执行？");
      return;
    }
    await dispatchQueueItem(item.id, { allowOverwrite: false, source: "manual" });
  }

  async function reconcilePageStateForAction() {
    const now = Date.now();
    const snapshot = collectSnapshot(now);
    updateAssistantTracking(snapshot.assistant, now);
    snapshot.stableForMs = now - runtime.assistantChangedAt;
    if (snapshot.domRunning || !snapshot.composerReady || snapshot.visibleError || snapshot.stableForMs < 500) return;
    runtime.manualTaskObserved = false;
    runtime.manualSubmissionPendingUntil = 0;
    const queue = await loadQueue(runtime.conversationKey);
    const active = getActiveItem(queue);
    if (!active) return;
    const responseAdvanced = Number(snapshot.assistantCount || 0) > Number(active.baselineAssistantCount || 0) || (snapshot.assistantHash && snapshot.assistantHash !== active.baselineAssistantHash);
    await mutateCurrentQueue((current) => {
      const item = current.items.find((candidate) => candidate.id === active.id);
      if (!item || !["dispatching", "running"].includes(item.status)) return current;
      if (responseAdvanced) {
        item.status = "completed";
        item.finishedAt = Date.now();
        item.error = "";
      } else {
        item.status = "failed";
        item.finishedAt = Date.now();
        item.error = "页面已空闲，已解除未同步的执行状态";
      }
      current.activeItemId = null;
      current.nextDispatchAt = Date.now() + 500;
      return current;
    });
  }

  async function dispatchQueueItem(itemId, { allowOverwrite = false, source = "auto" } = {}) {
    if (!itemId || runtime.dispatching || runtime.sendConfirmation) return false;
    let queue = await loadQueue(runtime.conversationKey);
    const candidate = queue.items.find((item) => item.id === itemId);
    if (!candidate || !["pending", "failed"].includes(candidate.status) || queue.activeItemId) return false;
    const now = Date.now();
    const snapshot = collectSnapshot(now);
    updateAssistantTracking(snapshot.assistant, now);
    snapshot.stableForMs = now - runtime.assistantChangedAt;
    snapshot.taskRunning = resolveEffectiveTaskRunning(snapshot);
    snapshot.manualHold = isManualHoldActive(snapshot, now);
    const pageReady = source === "auto" ? canPrepareQueueDispatch(queue, snapshot, now) : canStartManualDispatch(snapshot);
    if (!pageReady) {
      if (source !== "auto") showUiNotice("当前页面仍在真实执行任务，暂时无法立即发送");
      return false;
    }
    const previousComposerText = getComposerTextRaw();
    if (previousComposerText.trim() && !allowOverwrite) return false;
    if (!(await acquireLease())) {
      showUiNotice("其他相同会话标签页正在处理队列");
      return false;
    }
    runtime.dispatching = true;
    const startedAt = Date.now();
    let claimed = false;
    try {
      queue = await mutateCurrentQueue((current) => {
        const item = current.items.find((value) => value.id === itemId);
        if (!item || !["pending", "failed"].includes(item.status) || current.activeItemId) return current;
        const wasFailed = item.status === "failed";
        item.status = "dispatching";
        if (wasFailed) item.retryCount = 0;
        item.startedAt = startedAt;
        item.finishedAt = null;
        item.baselineAssistantHash = snapshot.assistantHash;
        item.baselineAssistantCount = snapshot.assistantCount;
        item.baselineUserCount = snapshot.userCount;
        item.error = "";
        current.activeItemId = item.id;
        current.paused = false;
        current.conversationUrl = location.href;
        claimed = true;
        return current;
      });
      if (!claimed) return false;
      const sent = await submitPrompt(candidate.text, { allowOverwrite });
      if (!sent) throw new Error("未找到可用的发送按钮");
      runtime.sendConfirmation = { itemId, baselineUserCount: snapshot.userCount, expiresAt: Date.now() + SEND_CONFIRM_TIMEOUT_MS };
      runtime.deferredAutoItemId = "";
      return true;
    } catch (error) {
      if (previousComposerText && allowOverwrite && !runtime.sendConfirmation) await writeComposerText(previousComposerText);
      if (claimed) await handleDispatchFailure(itemId, error?.message || "消息发送失败");
      if (source !== "auto") showUiNotice(`立即执行失败：${error?.message || "未知错误"}`);
      return false;
    } finally {
      runtime.dispatching = false;
    }
  }

  async function submitPrompt(text, { allowOverwrite = false } = {}) {
    const composer = findComposer();
    if (!composer || !isVisible(composer)) return false;
    const previous = getComposerTextRaw();
    if (previous.trim() && !allowOverwrite) return false;
    const written = await writeComposerText(text);
    if (!written) return false;
    await delay(120);
    const button = findSendButton();
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      await writeComposerText(previous);
      return false;
    }
    button.click();
    return true;
  }

  async function handleSendConfirmation(snapshot, now) {
    const confirmation = runtime.sendConfirmation;
    if (!confirmation) return;
    const observed = snapshot.userCount > confirmation.baselineUserCount || snapshot.domRunning;
    if (observed) {
      await mutateCurrentQueue((queue) => {
        const item = queue.items.find((candidate) => candidate.id === confirmation.itemId);
        if (item?.status === "dispatching") item.status = "running";
        return queue;
      });
      runtime.sendConfirmation = null;
      return;
    }
    if (now >= confirmation.expiresAt) {
      runtime.sendConfirmation = null;
      await handleDispatchFailure(confirmation.itemId, "发送后未检测到新任务");
    }
  }

  async function handleDispatchFailure(itemId, message) {
    await mutateCurrentQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item) return queue;
      item.retryCount += 1;
      item.error = core.cleanText(message, 240);
      item.startedAt = null;
      item.finishedAt = null;
      if (item.retryCount <= MAX_AUTO_RETRY) {
        item.status = "pending";
        queue.nextDispatchAt = Date.now() + 3_000;
      } else {
        item.status = "failed";
        item.finishedAt = Date.now();
        queue.paused = true;
      }
      queue.activeItemId = null;
      return queue;
    });
  }

  async function handleActiveFailure(item, message) {
    runtime.sendConfirmation = null;
    await handleDispatchFailure(item.id, message);
  }

  function isQueueItemCompleted(item, snapshot, now) {
    const corrected = { ...snapshot, taskRunning: snapshot.domRunning ? true : false };
    return core.isItemCompleted(item, corrected, now);
  }

  async function completeActiveItem(item, now) {
    await mutateCurrentQueue((queue) => {
      const current = queue.items.find((candidate) => candidate.id === item.id);
      if (!current || !["dispatching", "running"].includes(current.status)) return queue;
      current.status = "completed";
      current.finishedAt = now;
      current.error = "";
      queue.activeItemId = null;
      queue.nextDispatchAt = now + COMPLETION_TO_NEXT_DELAY_MS;
      return queue;
    });
  }

  async function requestRestoreToComposer(root, itemId) {
    const queue = await loadQueue(runtime.conversationKey);
    const item = queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) return showUiNotice("该消息当前不可编辑");
    if (!findComposer()) return showUiNotice("未找到当前输入框");
    if (getComposerText()) {
      openQueueConfirmation(root, "restore", item.id, "当前输入框内存在内容，是否覆盖？");
      return;
    }
    await restoreItemToComposer(item.id);
  }

  async function restoreItemToComposer(itemId) {
    const queue = await loadQueue(runtime.conversationKey);
    const item = queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) return showUiNotice("该消息状态已变化，无法取回");
    const previousComposerText = getComposerTextRaw();
    showUiNotice(`正在取回… ${item.text.length.toLocaleString()} 字符`);
    await nextFrame();
    if (!(await writeComposerText(item.text))) {
      await writeComposerText(previousComposerText);
      return showUiNotice("内容写入输入框失败，队列消息已保留");
    }
    let removed = false;
    try {
      await mutateCurrentQueue((current) => {
        const found = current.items.find((candidate) => candidate.id === itemId);
        if (!found || !["pending", "failed"].includes(found.status)) return current;
        current.items = current.items.filter((candidate) => candidate.id !== itemId);
        removed = true;
        return current;
      });
    } catch (error) {
      await writeComposerText(previousComposerText);
      throw error;
    }
    if (!removed) {
      await writeComposerText(previousComposerText);
      return showUiNotice("该消息状态已变化，已恢复原输入内容");
    }
    findComposer()?.focus();
    showUiNotice("队列消息已取回输入框");
  }

  async function deleteItem(itemId) {
    let removed = false;
    await mutateCurrentQueue((queue) => {
      const before = queue.items.length;
      queue.items = queue.items.filter((item) => item.id !== itemId);
      removed = queue.items.length !== before;
      if (queue.activeItemId === itemId) queue.activeItemId = null;
      return queue;
    });
    if (removed) showUiNotice("队列消息已删除");
  }

  async function moveItem(itemId, direction) {
    let changed = false;
    await mutateCurrentQueue((queue) => {
      const before = queue.items.map((item) => item.id).join("|");
      queue.items = core.moveItem(queue.items, itemId, direction);
      changed = before !== queue.items.map((item) => item.id).join("|");
      return queue;
    });
    if (changed) showUiNotice(direction === "up" ? "已上移" : "已下移");
  }

  async function retryItem(itemId) {
    await mutateCurrentQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (item?.status === "failed") {
        item.status = "pending";
        item.error = "";
        item.retryCount = 0;
        item.startedAt = null;
        item.finishedAt = null;
        queue.paused = false;
        queue.nextDispatchAt = Date.now() + 1_000;
      }
      return queue;
    });
  }

  function ensureUi() {
    let root = document.getElementById(UI_ID);
    if (root && root.dataset.gptqOwner !== runtime.instanceId) {
      root.remove();
      root = null;
    }
    if (!root) {
      root = document.createElement("div");
      root.id = UI_ID;
      root.dataset.gptqOwner = runtime.instanceId;
      root.innerHTML = buildUiMarkup();
      (document.body || document.documentElement).appendChild(root);
      bindUiEvents(root);
    }
    renderUi(root);
  }

  function buildUiMarkup() {
    return `
      <div class="gptq-dock">
        <button class="gptq-quick-add" type="button" data-action="enqueue">加入队列</button>
        <button class="gptq-trigger" type="button"><span>队列</span><strong class="gptq-count">0</strong></button>
      </div>
      <section class="gptq-panel" hidden>
        <header><strong>消息队列</strong><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="gptq-actions"><button type="button" data-action="pause">暂停</button><button type="button" data-action="clear-completed">清除已完成</button></div>
        <div class="gptq-confirm" hidden><p class="gptq-confirm-message"></p><div class="gptq-confirm-actions"><button type="button" data-action="cancel-confirm">否</button><button type="button" data-action="confirm-action">是</button></div></div>
        <div class="gptq-status"></div>
        <ol class="gptq-list"></ol>
      </section>`;
  }

  function bindUiEvents(root) {
    root.addEventListener("click", async (event) => {
      const button = event.target instanceof Element ? event.target.closest?.("button") : null;
      if (!button || !root.contains(button)) return;
      const action = button.dataset.action;
      if (!action && !button.classList.contains("gptq-trigger")) return;
      event.preventDefault();
      event.stopPropagation();
      event.stopImmediatePropagation();
      if (runtime.uiActionInFlight) return;
      runtime.uiActionInFlight = true;
      setUiBusy(root, true);
      try {
        if (button.classList.contains("gptq-trigger")) root.querySelector(".gptq-panel").hidden = !root.querySelector(".gptq-panel").hidden;
        else if (action === "close") root.querySelector(".gptq-panel").hidden = true;
        else if (action === "enqueue") await enqueueComposerText();
        else if (action === "pause") await mutateCurrentQueue((queue) => ({ ...queue, paused: !queue.paused }));
        else if (action === "clear-completed") await mutateCurrentQueue((queue) => ({ ...queue, items: queue.items.filter((item) => item.status !== "completed") }));
        else if (action === "delete") await deleteItem(button.dataset.id);
        else if (action === "up" || action === "down") await moveItem(button.dataset.id, action);
        else if (action === "edit") await requestRestoreToComposer(root, button.dataset.id);
        else if (action === "execute-now") await requestImmediateExecution(root, button.dataset.id);
        else if (action === "retry") await retryItem(button.dataset.id);
        else if (action === "cancel-confirm") cancelQueueConfirmation(root);
        else if (action === "confirm-action") await confirmQueueAction(root);
        renderUi(root);
        void inspect();
      } catch (error) {
        console.warn("[ChatGPT Message Queue] action failed", action, error);
        showUiNotice(`队列操作失败：${error?.message || "未知错误"}`);
      } finally {
        runtime.uiActionInFlight = false;
        setUiBusy(root, false);
        renderUi(root);
      }
    }, true);
  }

  function setUiBusy(root, busy) {
    root.dataset.busy = busy ? "true" : "false";
    for (const button of root.querySelectorAll("button")) button.disabled = busy;
  }

  function renderUi(root = document.getElementById(UI_ID)) {
    if (!root) return;
    const queue = core.normalizeQueue(runtime.queue, runtime.conversationKey);
    const snapshot = runtime.lastSnapshot || collectSnapshot();
    const canAdmit = core.canAdmit(queue, snapshot);
    const composerText = getComposerText();
    const pendingCount = core.countPending(queue) + (queue.activeItemId ? 1 : 0);
    root.querySelector(".gptq-count").textContent = String(pendingCount);
    root.querySelector(".gptq-trigger").classList.toggle("has-items", pendingCount > 0);
    const enqueue = root.querySelector('[data-action="enqueue"]');
    enqueue.disabled = runtime.uiActionInFlight || !composerText || !canAdmit;
    enqueue.title = !canAdmit ? "当前没有正在进行的会话，不能加入队列" : "将输入框内容加入当前会话队列";
    const pause = root.querySelector('[data-action="pause"]');
    pause.textContent = queue.paused ? "继续" : "暂停";
    const status = root.querySelector(".gptq-status");
    if (runtime.uiNotice) status.textContent = runtime.uiNotice;
    else if (!canAdmit && !queue.activeItemId) status.textContent = "当前没有正在进行的会话，不能加入队列";
    else if (queue.paused) status.textContent = "队列已暂停";
    else if (queue.activeItemId) status.textContent = "正在执行队列消息";
    else if (!snapshot.composerEmpty && core.countPending(queue)) status.textContent = "输入框有草稿，队列暂缓发送";
    else if (core.countPending(queue)) status.textContent = `等待执行 ${core.countPending(queue)} 条`;
    else status.textContent = "暂无等待消息";
    const list = root.querySelector(".gptq-list");
    const listMarkup = queue.items.length ? queue.items.map(renderItem).join("") : '<li class="gptq-empty">任务执行中输入下一条消息后加入队列</li>';
    if (list.dataset.signature !== hashText(listMarkup)) {
      list.innerHTML = listMarkup;
      list.dataset.signature = hashText(listMarkup);
    }
  }

  function renderItem(item, index) {
    const labels = { pending: "等待", dispatching: "发送中", running: "执行中", completed: "已完成", failed: "失败" };
    const canModify = item.status === "pending" || item.status === "failed";
    const preview = item.text.length > PREVIEW_LENGTH ? `${item.text.slice(0, PREVIEW_LENGTH)}…` : item.text;
    return `<li class="gptq-item" data-status="${escapeHtml(item.status)}">
      <div class="gptq-item-main"><span class="gptq-index">${index + 1}</span><div><p>${escapeHtml(preview)}</p><small>${labels[item.status] || item.status} · ${item.text.length.toLocaleString()} 字符${item.error ? ` · ${escapeHtml(item.error)}` : ""}</small></div></div>
      <div class="gptq-item-actions">
        ${canModify ? `<button type="button" data-action="edit" data-id="${escapeHtml(item.id)}">编辑</button><button type="button" data-action="execute-now" data-id="${escapeHtml(item.id)}">立即执行</button>` : ""}
        ${item.status === "failed" ? `<button type="button" data-action="retry" data-id="${escapeHtml(item.id)}">重试</button>` : ""}
        ${item.status === "pending" ? `<button type="button" data-action="up" data-id="${escapeHtml(item.id)}">↑</button><button type="button" data-action="down" data-id="${escapeHtml(item.id)}">↓</button>` : ""}
        ${!["running", "dispatching"].includes(item.status) ? `<button type="button" data-action="delete" data-id="${escapeHtml(item.id)}">删除</button>` : ""}
      </div></li>`;
  }

  function openQueueConfirmation(root, mode, itemId, message) {
    const box = root?.querySelector(".gptq-confirm");
    if (!box || !itemId) return;
    if (!box.hidden && box.dataset.mode && box.dataset.mode !== "auto-execute" && mode === "auto-execute") return;
    box.dataset.mode = mode;
    box.dataset.itemId = itemId;
    box.querySelector(".gptq-confirm-message").textContent = message;
    box.hidden = false;
    root.querySelector(".gptq-panel").hidden = false;
  }

  function closeQueueConfirmation(root, onlyMode = "") {
    const box = root?.querySelector(".gptq-confirm");
    if (!box || (onlyMode && box.dataset.mode !== onlyMode)) return;
    box.hidden = true;
    delete box.dataset.mode;
    delete box.dataset.itemId;
    box.querySelector(".gptq-confirm-message").textContent = "";
  }

  function cancelQueueConfirmation(root) {
    const box = root?.querySelector(".gptq-confirm");
    if (box?.dataset.mode === "auto-execute" && box.dataset.itemId) {
      runtime.deferredAutoItemId = box.dataset.itemId;
      showUiNotice("已保留当前输入，输入框清空后队列会继续执行");
    }
    closeQueueConfirmation(root);
  }

  async function confirmQueueAction(root) {
    const box = root?.querySelector(".gptq-confirm");
    const mode = box?.dataset.mode || "";
    const itemId = box?.dataset.itemId || "";
    if (!mode || !itemId) return;
    closeQueueConfirmation(root);
    if (mode === "restore") await restoreItemToComposer(itemId);
    else if (mode === "execute-now" || mode === "auto-execute") {
      runtime.deferredAutoItemId = "";
      await reconcilePageStateForAction();
      await dispatchQueueItem(itemId, { allowOverwrite: true, source: "manual" });
    }
  }

  function showUiNotice(message) {
    runtime.uiNotice = message;
    scheduleUiRender();
    setTimeout(() => {
      if (runtime.uiNotice === message) runtime.uiNotice = "";
      scheduleUiRender();
    }, 2_800);
  }

  function scheduleUiRender() {
    if (runtime.uiScheduled) return;
    runtime.uiScheduled = true;
    requestAnimationFrame(() => {
      runtime.uiScheduled = false;
      ensureUi();
    });
  }

  async function loadQueue(key, { forceTexts = false, allowLegacy = true } = {}) {
    const indexResult = await chrome.storage.local.get([INDEX_STORAGE_KEY, LEGACY_STORAGE_KEY]);
    const index = indexResult[INDEX_STORAGE_KEY] || {};
    const metadata = index[key];
    if (!metadata && allowLegacy && indexResult[LEGACY_STORAGE_KEY]?.[key]) {
      await migrateLegacyQueue(key, indexResult[LEGACY_STORAGE_KEY][key]);
      return loadQueue(key, { forceTexts: true, allowLegacy: false });
    }
    if (!metadata) {
      runtime.queueCache.delete(key);
      return core.normalizeQueue({}, key);
    }
    const signature = metadataSignature(metadata);
    const cached = runtime.queueCache.get(key);
    if (!forceTexts && cached?.signature === signature) return cached.queue;

    const itemIds = (metadata.items || []).map((item) => item.id);
    const itemIdSet = new Set(itemIds);
    const textsById = new Map(cached?.textsById || []);
    for (const cachedId of [...textsById.keys()]) {
      if (!itemIdSet.has(cachedId)) textsById.delete(cachedId);
    }
    const idsToRead = forceTexts ? itemIds : itemIds.filter((id) => !textsById.has(id));
    const itemKeys = idsToRead.map(itemStorageKey);
    const storedTexts = itemKeys.length ? await chrome.storage.local.get(itemKeys) : {};
    for (const id of idsToRead) textsById.set(id, String(storedTexts[itemStorageKey(id)] || ""));

    const queue = core.normalizeQueue({
      ...metadata,
      items: (metadata.items || []).map((item) => ({ ...item, text: textsById.get(item.id) || "" }))
    }, key);
    runtime.queueCache.set(key, { signature, queue, textsById });
    return queue;
  }

  function metadataSignature(metadata) {
    return JSON.stringify({
      revision: Number(metadata?.revision || 0),
      activeItemId: metadata?.activeItemId || "",
      paused: Boolean(metadata?.paused),
      nextDispatchAt: Number(metadata?.nextDispatchAt || 0),
      lease: metadata?.lease || null,
      items: (metadata?.items || []).map((item) => [item.id, item.status, item.retryCount, item.startedAt, item.finishedAt, item.error])
    });
  }

  async function mutateCurrentQueue(mutator) {
    const result = await mutateQueueByKey(runtime.conversationKey, mutator);
    runtime.queue = result;
    return result;
  }

  async function mutateQueueByKey(key, mutator) {
    const run = runtime.storageWrite.then(() => withStorageLock(async () => {
      const previous = await loadQueue(key, { forceTexts: true, allowLegacy: false });
      const working = core.normalizeQueue(previous, key);
      const next = core.normalizeQueue(mutator(working) || working, key);
      next.revision = previous.revision + 1;
      next.updatedAt = Date.now();
      if (!next.conversationUrl) next.conversationUrl = key === runtime.conversationKey ? location.href : previous.conversationUrl;
      return persistQueueUnlocked(key, next, previous);
    }));
    runtime.storageWrite = run.catch(() => {});
    return run;
  }

  async function persistQueue(key, queue, previous = core.normalizeQueue({}, key)) {
    return withStorageLock(() => persistQueueUnlocked(key, queue, previous));
  }

  async function persistQueueUnlocked(key, queue, previous = core.normalizeQueue({}, key)) {
    const normalized = core.normalizeQueue(queue, key);
    const oldById = new Map(previous.items.map((item) => [item.id, item]));
    const setValues = {};
    for (const item of normalized.items) {
      if (oldById.get(item.id)?.text !== item.text) setValues[itemStorageKey(item.id)] = item.text;
    }
    const deletedKeys = previous.items.filter((item) => !normalized.items.some((next) => next.id === item.id)).map((item) => itemStorageKey(item.id));
    const { [INDEX_STORAGE_KEY]: currentIndex = {} } = await chrome.storage.local.get(INDEX_STORAGE_KEY);
    const metadata = { ...normalized, items: normalized.items.map(({ text, ...item }) => item) };
    setValues[INDEX_STORAGE_KEY] = { ...currentIndex, [key]: metadata };
    await chrome.storage.local.set(setValues);
    if (deletedKeys.length) await chrome.storage.local.remove(deletedKeys);
    runtime.queueCache.set(key, {
      signature: metadataSignature(metadata),
      queue: normalized,
      textsById: new Map(normalized.items.map((item) => [item.id, item.text]))
    });
    return normalized;
  }

  async function deleteQueue(key, queue) {
    return withStorageLock(() => deleteQueueUnlocked(key, queue));
  }

  async function deleteQueueUnlocked(key, queue) {
    const { [INDEX_STORAGE_KEY]: index = {} } = await chrome.storage.local.get(INDEX_STORAGE_KEY);
    const next = { ...index };
    delete next[key];
    await chrome.storage.local.set({ [INDEX_STORAGE_KEY]: next });
    const keys = queue.items.map((item) => itemStorageKey(item.id));
    if (keys.length) await chrome.storage.local.remove(keys);
    runtime.queueCache.delete(key);
  }

  async function migrateLegacyQueue(key, rawQueue) {
    await withStorageLock(async () => {
      const { [INDEX_STORAGE_KEY]: index = {} } = await chrome.storage.local.get(INDEX_STORAGE_KEY);
      if (!index[key]) {
        const legacy = core.normalizeQueue(rawQueue, key);
        await persistQueueUnlocked(key, legacy, core.normalizeQueue({}, key));
      }
      const { [LEGACY_STORAGE_KEY]: legacyQueues = {} } = await chrome.storage.local.get(LEGACY_STORAGE_KEY);
      if (legacyQueues[key]) {
        const nextLegacy = { ...legacyQueues };
        delete nextLegacy[key];
        if (Object.keys(nextLegacy).length) await chrome.storage.local.set({ [LEGACY_STORAGE_KEY]: nextLegacy });
        else await chrome.storage.local.remove(LEGACY_STORAGE_KEY);
      }
    });
  }

  async function withStorageLock(operation) {
    if (globalThis.navigator?.locks?.request) {
      return navigator.locks.request(STORAGE_LOCK_NAME, { mode: "exclusive" }, operation);
    }
    const token = await acquireFallbackStorageLock();
    try {
      return await operation();
    } finally {
      await releaseFallbackStorageLock(token);
    }
  }

  async function acquireFallbackStorageLock() {
    const ownerId = `${runtime.instanceId}:${core.createId("lock")}`;
    for (let attempt = 0; attempt < WRITE_LOCK_ATTEMPTS; attempt += 1) {
      const now = Date.now();
      const { [core.WRITE_LOCK_STORAGE_KEY]: locks = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      const current = locks[STORAGE_LOCK_NAME];
      if (current && current.ownerId !== ownerId && current.expiresAt > now) {
        await delay(35 + attempt * 20);
        continue;
      }
      await chrome.storage.local.set({
        [core.WRITE_LOCK_STORAGE_KEY]: {
          ...locks,
          [STORAGE_LOCK_NAME]: { ownerId, expiresAt: now + WRITE_LOCK_TTL_MS }
        }
      });
      await delay(30 + Math.floor(Math.random() * 20));
      const { [core.WRITE_LOCK_STORAGE_KEY]: verified = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      if (verified[STORAGE_LOCK_NAME]?.ownerId === ownerId) return ownerId;
    }
    throw new Error("消息队列跨标签写入锁获取失败");
  }

  async function releaseFallbackStorageLock(ownerId) {
    const { [core.WRITE_LOCK_STORAGE_KEY]: locks = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
    if (locks[STORAGE_LOCK_NAME]?.ownerId !== ownerId) return;
    const next = { ...locks };
    delete next[STORAGE_LOCK_NAME];
    if (Object.keys(next).length) await chrome.storage.local.set({ [core.WRITE_LOCK_STORAGE_KEY]: next });
    else await chrome.storage.local.remove(core.WRITE_LOCK_STORAGE_KEY);
  }

  function itemStorageKey(id) { return `${ITEM_STORAGE_PREFIX}${id}`; }

  async function acquireLease() {
    let claimed = false;
    await mutateCurrentQueue((current) => {
      const now = Date.now();
      if (current.lease && current.lease.ownerId !== runtime.instanceId && current.lease.expiresAt > now) return current;
      current.lease = { ownerId: runtime.instanceId, expiresAt: now + LEASE_TTL_MS };
      claimed = true;
      return current;
    });
    if (!claimed) return false;
    const verified = await loadQueue(runtime.conversationKey);
    return verified.lease?.ownerId === runtime.instanceId && verified.lease.expiresAt > Date.now();
  }

  async function refreshLease() {
    const queue = runtime.queue;
    if (!queue || queue.lease?.ownerId !== runtime.instanceId || !core.hasActiveWork(queue)) return;
    if (Date.now() - runtime.lastLeaseRefreshAt < LEASE_REFRESH_MS - 250) return;
    runtime.lastLeaseRefreshAt = Date.now();
    await mutateCurrentQueue((current) => {
      if (current.lease?.ownerId === runtime.instanceId) current.lease.expiresAt = Date.now() + LEASE_TTL_MS;
      return current;
    });
  }

  function releaseCurrentLease() { void releaseLease(runtime.conversationKey); }
  async function releaseLease(key) {
    if (!key) return;
    await mutateQueueByKey(key, (current) => {
      if (current.lease?.ownerId === runtime.instanceId) current.lease = null;
      return current;
    });
  }

  async function writeComposerText(text) {
    const composer = findComposer();
    if (!composer) return false;
    runtime.suppressComposerMutations += 1;
    try {
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        if (setter) setter.call(composer, text); else composer.value = text;
      } else {
        composer.replaceChildren(document.createTextNode(text));
      }
      composer.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        composed: true,
        inputType: text ? "insertText" : "deleteContentBackward",
        data: text || null
      }));
      await nextFrame();
      await nextFrame();
      return core.cleanText(getComposerTextRaw()) === core.cleanText(text);
    } finally {
      runtime.suppressComposerMutations = Math.max(0, runtime.suppressComposerMutations - 1);
      scheduleUiRender();
    }
  }

  function resolveConversationKey() {
    return core.getConversationKey(location.href, runtime.temporaryKey, discoverConversationId());
  }

  function discoverConversationId() {
    const main = document.querySelector("main");
    const values = [
      main?.getAttribute("data-conversation-id"),
      main?.getAttribute("data-thread-id"),
      main?.querySelector?.("[data-conversation-id]")?.getAttribute("data-conversation-id"),
      main?.querySelector?.("[data-thread-id]")?.getAttribute("data-thread-id")
    ];
    return values.map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  function getStableInstanceId() {
    const key = "chatgpt-message-queue-instance-v060";
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = core.createId("page");
      sessionStorage.setItem(key, value);
    }
    return value;
  }

  function getTemporaryKey() {
    const key = "chatgpt-message-queue-temp-key";
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = core.createId("tab");
      sessionStorage.setItem(key, value);
    }
    return value;
  }

  function getActiveItem(queue) {
    return queue?.activeItemId ? queue.items.find((item) => item.id === queue.activeItemId) || null : null;
  }

  function getLatestAssistant() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter((node) => isVisible(node) || node.textContent?.trim());
    const node = nodes.at(-1);
    const text = core.cleanText(node?.innerText || node?.textContent || "", 50_000);
    return { node, text, hash: text ? hashText(text) : "", count: nodes.length };
  }

  function getUserMessages() { return [...document.querySelectorAll('[data-message-author-role="user"]')]; }
  function findComposer() {
    return document.querySelector("#prompt-textarea") || document.querySelector("textarea[placeholder]") || document.querySelector('[contenteditable="true"][data-virtualkeyboard]') || document.querySelector('main [contenteditable="true"]');
  }
  function getComposerTextRaw() {
    const composer = findComposer();
    return String(composer?.value ?? composer?.innerText ?? composer?.textContent ?? "").replace(/\r/g, "");
  }
  function getComposerText() { return core.cleanText(getComposerTextRaw()); }
  function isComposerElement(target) {
    return target instanceof Element && Boolean(target.matches?.('#prompt-textarea, textarea, [contenteditable="true"]') || target.closest?.('#prompt-textarea, textarea, [contenteditable="true"]'));
  }
  function isComposerReady() {
    const composer = findComposer();
    return Boolean(composer && isVisible(composer) && composer.getAttribute("aria-disabled") !== "true" && !composer.disabled);
  }

  function findSendButton() {
    const selectors = ['button[data-testid="send-button"]', 'button[data-testid*="send"]', 'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]', 'button[aria-label*="发送"]', 'button[aria-label*="傳送"]'];
    for (const selector of selectors) {
      const button = [...document.querySelectorAll(selector)].find(isVisible);
      if (button) return button;
    }
    return [...document.querySelectorAll("main button")].find((button) => isVisible(button) && looksLikeSendButton(button)) || null;
  }
  function looksLikeSendButton(button) {
    const testId = (button.getAttribute("data-testid") || "").toLowerCase();
    const label = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""} ${button.title || ""}`.trim().toLowerCase();
    return testId.includes("send-button") || /^(send|发送|傳送|提交)$/.test(label) || label.includes("send message") || label.includes("发送消息");
  }
  function hasStopControl() {
    const selectors = ['button[data-testid*="stop"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]', 'button[aria-label*="停止"]', 'button[aria-label*="中止"]', 'button[aria-label*="取消生成"]'];
    return selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible));
  }
  function hasApprovalControl() {
    const words = ["allow", "approve", "confirm", "continue", "run", "允许", "批准", "确认", "继续", "运行", "始终允许"];
    return [...document.querySelectorAll("main button")].some((button) => {
      if (!isVisible(button)) return false;
      const text = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.trim().toLowerCase();
      return words.some((word) => text === word || text.includes(word));
    });
  }
  function hasBusyIndicator() {
    const words = ["working", "thinking", "searching", "running", "generating", "正在处理", "正在思考", "正在搜索", "正在运行", "正在生成"];
    return [...document.querySelectorAll('main [aria-live="polite"], main [role="status"], main [data-state="loading"]')]
      .filter(isVisible)
      .some((node) => words.some((word) => core.cleanText(node.innerText || node.textContent || "", 200).toLowerCase().includes(word)));
  }
  function findVisibleError() {
    const words = ["something went wrong", "there was an error generating a response", "network error", "conversation not found", "出现错误", "发生错误", "网络错误", "生成回复时出错", "找不到对话"];
    return [...document.querySelectorAll('[role="alert"], main [data-testid*="error"], main .text-red-500')]
      .filter(isVisible)
      .some((node) => words.some((word) => core.cleanText(node.innerText || node.textContent || "", 500).toLowerCase().includes(word)));
  }
  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function installStyles() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement("style");
    style.id = STYLE_ID;
    style.textContent = `
      #${UI_ID}{position:fixed;right:18px;bottom:104px;z-index:2147483646;font:13px/1.45 system-ui,-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;color:#202123}
      #${UI_ID} button{font:inherit;cursor:pointer}#${UI_ID} button:disabled{cursor:not-allowed;opacity:.45}
      #${UI_ID} .gptq-dock{display:flex;align-items:center;justify-content:flex-end;gap:7px}
      #${UI_ID} .gptq-trigger,#${UI_ID} .gptq-quick-add{display:flex;align-items:center;gap:7px;border:1px solid rgba(0,0,0,.16);border-radius:999px;background:#fff;padding:8px 12px;box-shadow:0 6px 24px rgba(0,0,0,.14)}
      #${UI_ID} .gptq-quick-add{background:#111;color:#fff}#${UI_ID} .gptq-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#111;color:#fff;font-size:11px}
      #${UI_ID} .gptq-panel{position:absolute;right:0;bottom:46px;width:min(390px,calc(100vw - 28px));max-height:min(520px,70vh);overflow:hidden;border:1px solid rgba(0,0,0,.15);border-radius:14px;background:#fff;box-shadow:0 18px 54px rgba(0,0,0,.22)}
      #${UI_ID} .gptq-panel[hidden],#${UI_ID} .gptq-confirm[hidden]{display:none}#${UI_ID} header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.09)}
      #${UI_ID} header button{border:0;background:transparent;font-size:21px}#${UI_ID} .gptq-actions{display:flex;gap:7px;padding:10px 12px}
      #${UI_ID} .gptq-actions button,#${UI_ID} .gptq-item-actions button,#${UI_ID} .gptq-confirm-actions button{border:1px solid rgba(0,0,0,.14);border-radius:8px;background:#fff;padding:5px 8px}
      #${UI_ID} .gptq-confirm{margin:0 12px 10px;padding:10px;border:1px solid rgba(0,0,0,.12);border-radius:10px;background:rgba(0,0,0,.025)}#${UI_ID} .gptq-confirm p{margin:0 0 8px}#${UI_ID} .gptq-confirm-actions{display:flex;justify-content:flex-end;gap:6px}
      #${UI_ID} .gptq-status{padding:0 12px 8px;color:#666}#${UI_ID} .gptq-list{max-height:390px;overflow:auto;margin:0;padding:0 10px 10px;list-style:none}
      #${UI_ID} .gptq-item{padding:10px 4px;border-top:1px solid rgba(0,0,0,.08)}#${UI_ID} .gptq-item-main{display:flex;gap:8px;align-items:flex-start}#${UI_ID} .gptq-index{flex:none;display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:rgba(0,0,0,.08);font-size:11px}
      #${UI_ID} .gptq-item-main>div{min-width:0;flex:1}#${UI_ID} .gptq-item p{margin:0;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}#${UI_ID} .gptq-item small{display:block;margin-top:4px;color:#777}
      #${UI_ID} .gptq-item[data-status="failed"] small{color:#b42318}#${UI_ID} .gptq-item-actions{display:flex;justify-content:flex-end;flex-wrap:wrap;gap:5px;margin-top:7px}#${UI_ID} .gptq-empty{padding:22px 8px;text-align:center;color:#777}
      @media (prefers-color-scheme:dark){#${UI_ID}{color:#ececec}#${UI_ID} .gptq-trigger,#${UI_ID} .gptq-panel,#${UI_ID} .gptq-actions button,#${UI_ID} .gptq-item-actions button,#${UI_ID} .gptq-confirm-actions button{background:#2f2f2f;color:#ececec;border-color:rgba(255,255,255,.15)}#${UI_ID} .gptq-confirm{background:rgba(255,255,255,.04);border-color:rgba(255,255,255,.12)}#${UI_ID} .gptq-quick-add{background:#ececec;color:#202123}#${UI_ID} .gptq-count{background:#ececec;color:#202123}#${UI_ID} header,#${UI_ID} .gptq-item{border-color:rgba(255,255,255,.1)}#${UI_ID} .gptq-status,#${UI_ID} .gptq-item small,#${UI_ID} .gptq-empty{color:#aaa}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let i = 0; i < text.length; i += 1) { hash ^= text.charCodeAt(i); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
  }
  function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }
  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }
  function nextFrame() { return new Promise((resolve) => requestAnimationFrame(() => resolve())); }
})();
