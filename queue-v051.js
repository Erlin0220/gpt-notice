(() => {
  if (window.__CHATGPT_MESSAGE_QUEUE_V051_LOADED__) return;
  window.__CHATGPT_MESSAGE_QUEUE_V051_LOADED__ = true;

  const core = globalThis.ChatGPTQueueCore;
  if (!core) {
    console.warn("[ChatGPT Message Queue] queue-core.js not loaded");
    return;
  }

  const INSPECT_INTERVAL_MS = 800;
  const LEASE_TTL_MS = 15_000;
  const LEASE_REFRESH_MS = 5_000;
  const WRITE_LOCK_TTL_MS = 3_000;
  const SEND_CONFIRM_TIMEOUT_MS = 10_000;
  const COMPLETION_TO_NEXT_DELAY_MS = 2_500;
  const MAX_AUTO_RETRY = 1;
  const UI_ID = "chatgpt-message-queue-root";
  const STYLE_ID = "chatgpt-message-queue-style";

  const runtime = {
    instanceId: core.createId("page"),
    temporaryKey: getTemporaryKey(),
    conversationKey: "",
    queue: null,
    assistantHash: "",
    assistantText: "",
    assistantChangedAt: Date.now(),
    lastUrl: location.href,
    lastSnapshot: null,
    dispatching: false,
    sendConfirmation: null,
    manualSubmissionPendingUntil: 0,
    manualTaskObserved: false,
    storageWrite: Promise.resolve(),
    inspectRunning: false,
    uiScheduled: false,
    lastLeaseRefreshAt: 0,
    uiNotice: ""
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

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== "local" || !changes[core.QUEUE_STORAGE_KEY]) return;
      const queues = changes[core.QUEUE_STORAGE_KEY].newValue || {};
      runtime.queue = core.normalizeQueue(queues[runtime.conversationKey], runtime.conversationKey);
      scheduleUiRender();
    });

    const observer = new MutationObserver(() => {
      scheduleUiRender();
      void inspect();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "disabled", "data-testid", "data-state", "data-conversation-id", "data-thread-id"]
    });

    setInterval(() => void inspect(), INSPECT_INTERVAL_MS);
    setInterval(() => void refreshLease(), LEASE_REFRESH_MS);
    await inspect();
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
      snapshot.manualHold = isManualHoldActive(snapshot, now);
      runtime.lastSnapshot = snapshot;

      runtime.queue = await loadQueue(runtime.conversationKey);
      await handleSendConfirmation(snapshot, now);

      const activeItem = getActiveItem(runtime.queue);
      if (activeItem) {
        if (snapshot.visibleError && !snapshot.stopVisible && !snapshot.busy) {
          await handleActiveFailure(activeItem, "ChatGPT 页面显示执行错误");
        } else if (core.isItemCompleted(activeItem, snapshot, now)) {
          await completeActiveItem(activeItem, now);
        }
      } else if (core.canDispatch(runtime.queue, snapshot, now)) {
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
    const composerText = getComposerText();
    return {
      assistant,
      assistantHash: assistant.hash,
      assistantText: assistant.text,
      assistantCount: assistant.count,
      stopVisible: hasStopControl(),
      waitingAction: hasApprovalControl(),
      busy: hasBusyIndicator(),
      visibleError: findVisibleError(),
      composerReady: isComposerReady(),
      composerEmpty: !composerText,
      composerText,
      userCount: getUserMessages().length,
      stableForMs: now - runtime.assistantChangedAt,
      manualHold: false
    };
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

  function isManualHoldActive(snapshot, now) {
    if (runtime.manualSubmissionPendingUntil > now) {
      if (snapshot.stopVisible || snapshot.busy || snapshot.waitingAction || snapshot.userCount > 0) {
        runtime.manualTaskObserved = true;
      }
      return true;
    }
    if (!runtime.manualTaskObserved) return false;
    if (snapshot.stopVisible || snapshot.busy || snapshot.waitingAction || snapshot.stableForMs < 4_000) return true;
    runtime.manualTaskObserved = false;
    runtime.manualSubmissionPendingUntil = 0;
    return false;
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
    if (currentUrl === runtime.lastUrl && nextKey === runtime.conversationKey) return;
    if (!nextKey) return;

    const previousKey = runtime.conversationKey;
    if (nextKey === previousKey) {
      const explicitKey = core.getConversationKey(currentUrl, runtime.temporaryKey);
      if (explicitKey === previousKey) runtime.lastUrl = currentUrl;
      return;
    }

    const previousUrl = runtime.lastUrl;
    const previousQueue = await loadQueue(previousKey);
    if (core.shouldMigrateQueue(previousKey, nextKey)) {
      await migrateDraftQueue(previousKey, nextKey, previousUrl);
    } else if (core.hasActiveWork(previousQueue)) {
      await mutateQueueByKey(previousKey, (queue) => {
        if (queue.lease?.ownerId === runtime.instanceId) queue.lease = null;
        queue.conversationUrl = previousUrl || queue.conversationUrl;
        return queue;
      });
    }

    runtime.lastUrl = currentUrl;
    runtime.conversationKey = nextKey;
    runtime.queue = await loadQueue(nextKey);
    runtime.sendConfirmation = null;
    runtime.dispatching = false;
    runtime.manualSubmissionPendingUntil = 0;
    runtime.manualTaskObserved = false;
    resetAssistantTracking();
  }
  async function migrateDraftQueue(fromKey, toKey, previousUrl) {
    await mutateQueuesLocked(`migrate:${fromKey}:${toKey}`, (queues) => {
      const source = core.normalizeQueue(queues[fromKey], fromKey);
      const target = core.normalizeQueue(queues[toKey], toKey);
      if (!source.items.length) return queues;

      const existingIds = new Set(target.items.map((item) => item.id));
      target.items.push(...source.items.filter((item) => !existingIds.has(item.id)));
      target.paused = source.paused || target.paused;
      target.activeItemId = source.activeItemId || target.activeItemId;
      target.nextDispatchAt = Math.max(source.nextDispatchAt, target.nextDispatchAt);
      target.conversationUrl = location.href;
      target.lease = null;
      target.revision += 1;
      target.updatedAt = Date.now();
      queues[toKey] = core.normalizeQueue(target, toKey);
      delete queues[fromKey];
      return queues;
    });
  }

  async function recoverInterruptedQueue() {
    if (!runtime.queue?.activeItemId) return;
    const activeItem = getActiveItem(runtime.queue);
    if (!activeItem) return;

    const snapshot = collectSnapshot();
    const latestUserText = getLatestUserText();
    const wasSubmitted = snapshot.stopVisible || snapshot.busy || snapshot.waitingAction || samePrompt(latestUserText, activeItem.text);
    if (wasSubmitted) {
      await mutateCurrentQueue((queue) => {
        const item = queue.items.find((candidate) => candidate.id === activeItem.id);
        if (item?.status === "dispatching") item.status = "running";
        return queue;
      });
      return;
    }

    const recovered = core.resetInterruptedItems(runtime.queue);
    await saveQueue(recovered);
  }

  async function enqueueComposerText() {
    const snapshot = collectSnapshot();
    snapshot.manualHold = isManualHoldActive(snapshot, Date.now());
    runtime.lastSnapshot = snapshot;
    if (!core.canAdmit(runtime.queue, snapshot)) {
      showUiNotice("当前没有正在进行的会话，不能加入队列");
      return;
    }

    const text = snapshot.composerText;
    if (!text) return;
    const item = core.createQueueItem(text);
    if (!item) return;

    await mutateCurrentQueue((queue) => {
      queue.items.push(item);
      queue.conversationUrl = location.href;
      return queue;
    });
    clearComposer();
    showUiNotice("已加入队列");
    scheduleUiRender();
    void inspect();
  }

  async function dispatchNextItem(snapshot) {
    if (runtime.dispatching || runtime.sendConfirmation) return;
    if (!(await acquireLease())) return;

    runtime.queue = await loadQueue(runtime.conversationKey);
    const freshSnapshot = collectSnapshot();
    freshSnapshot.manualHold = isManualHoldActive(freshSnapshot, Date.now());
    freshSnapshot.stableForMs = Date.now() - runtime.assistantChangedAt;
    if (!core.canDispatch(runtime.queue, freshSnapshot, Date.now())) return;
    const nextItem = core.getNextPendingItem(runtime.queue);
    if (!nextItem) return;

    runtime.dispatching = true;
    const baselineUserCount = freshSnapshot.userCount;
    const baselineAssistantHash = freshSnapshot.assistantHash;
    const baselineAssistantCount = freshSnapshot.assistantCount;
    const startedAt = Date.now();

    await mutateCurrentQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === nextItem.id);
      if (!item || item.status !== "pending") return queue;
      item.status = "dispatching";
      item.startedAt = startedAt;
      item.finishedAt = null;
      item.baselineAssistantHash = baselineAssistantHash;
      item.baselineAssistantCount = baselineAssistantCount;
      item.baselineUserCount = baselineUserCount;
      item.error = "";
      queue.activeItemId = item.id;
      queue.conversationUrl = location.href;
      return queue;
    });

    try {
      const sent = await submitPrompt(nextItem.text);
      if (!sent) throw new Error(getComposerText() ? "输入框中存在未发送草稿" : "未找到可用的发送按钮");
      runtime.sendConfirmation = {
        itemId: nextItem.id,
        baselineUserCount,
        expiresAt: Date.now() + SEND_CONFIRM_TIMEOUT_MS
      };
    } catch (error) {
      await handleDispatchFailure(nextItem.id, error?.message || "消息发送失败");
    } finally {
      runtime.dispatching = false;
    }
  }

  async function handleSendConfirmation(snapshot, now) {
    const confirmation = runtime.sendConfirmation;
    if (!confirmation) return;

    const observed = snapshot.userCount > confirmation.baselineUserCount || snapshot.stopVisible || snapshot.busy || snapshot.waitingAction;
    if (observed) {
      await mutateCurrentQueue((queue) => {
        const item = queue.items.find((candidate) => candidate.id === confirmation.itemId);
        if (item && item.status === "dispatching") item.status = "running";
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
    await mutateCurrentQueue((queue) => {
      const current = queue.items.find((candidate) => candidate.id === item.id);
      if (!current) return queue;
      current.retryCount += 1;
      current.error = core.cleanText(message, 240);
      current.finishedAt = Date.now();
      if (current.retryCount <= MAX_AUTO_RETRY) {
        current.status = "pending";
        current.startedAt = null;
        current.finishedAt = null;
        queue.nextDispatchAt = Date.now() + 4_000;
      } else {
        current.status = "failed";
        queue.paused = true;
      }
      queue.activeItemId = null;
      return queue;
    });
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

  async function submitPrompt(text) {
    const composer = findComposer();
    if (!composer || !isVisible(composer) || getComposerText()) return false;
    setComposerText(composer, text);
    await delay(220);
    const button = findSendButton();
    if (!button || button.disabled || button.getAttribute("aria-disabled") === "true") {
      setComposerText(composer, "");
      return false;
    }
    button.click();
    return true;
  }

  function installSubmissionListeners() {
    document.addEventListener("input", (event) => {
      if (isComposerElement(event.target)) scheduleUiRender();
    }, true);
    document.addEventListener("click", (event) => {
      const button = event.target.closest?.("button");
      if (!button || !looksLikeSendButton(button) || runtime.dispatching) return;
      markManualSubmission();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || runtime.dispatching) return;
      if (!isComposerElement(event.target)) return;
      markManualSubmission();
    }, true);

    document.addEventListener("submit", (event) => {
      if (runtime.dispatching) return;
      if (event.target?.querySelector?.("#prompt-textarea, textarea, [contenteditable='true']")) markManualSubmission();
    }, true);
  }

  function markManualSubmission() {
    runtime.manualSubmissionPendingUntil = Date.now() + SEND_CONFIRM_TIMEOUT_MS;
    runtime.manualTaskObserved = false;
    scheduleUiRender();
  }

  function ensureUi() {
    let root = document.getElementById(UI_ID);
    if (!root) {
      root = document.createElement("div");
      root.id = UI_ID;
      root.innerHTML = buildUiMarkup();
      (document.body || document.documentElement).appendChild(root);
      bindUiEvents(root);
    } else if (!root.isConnected) {
      (document.body || document.documentElement).appendChild(root);
    }
    renderUi(root);
  }

  function buildUiMarkup() {
    return `
      <div class="gptq-dock">
        <button class="gptq-quick-add" type="button" data-action="enqueue">加入队列</button>
        <button class="gptq-trigger" type="button" title="ChatGPT 消息队列">
          <span>队列</span><strong class="gptq-count">0</strong>
        </button>
      </div>
      <section class="gptq-panel" hidden>
        <header><strong>消息队列</strong><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="gptq-actions">
          <button type="button" data-action="pause">暂停</button>
          <button type="button" data-action="clear-completed">清除已完成</button>
        </div>
        <div class="gptq-status"></div>
        <ol class="gptq-list"></ol>
      </section>
    `;
  }

  function bindUiEvents(root) {
    root.addEventListener("click", async (event) => {
      const button = event.target.closest("button");
      if (!button) return;
      const action = button.dataset.action;
      if (button.classList.contains("gptq-trigger")) {
        const panel = root.querySelector(".gptq-panel");
        panel.hidden = !panel.hidden;
        return;
      }
      if (action === "close") root.querySelector(".gptq-panel").hidden = true;
      else if (action === "enqueue") await enqueueComposerText();
      else if (action === "pause") await mutateCurrentQueue((queue) => ({ ...queue, paused: !queue.paused }));
      else if (action === "clear-completed") {
        await mutateCurrentQueue((queue) => {
          queue.items = queue.items.filter((item) => item.status !== "completed");
          return queue;
        });
      } else if (action === "delete") await deleteItem(button.dataset.id);
      else if (action === "up" || action === "down") await moveItem(button.dataset.id, action);
      else if (action === "edit") await editItem(button.dataset.id);
      else if (action === "retry") await retryItem(button.dataset.id);
      renderUi(root);
      void inspect();
    });
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

    for (const enqueueButton of root.querySelectorAll('[data-action="enqueue"]')) {
      enqueueButton.disabled = !composerText || !canAdmit;
      enqueueButton.title = !canAdmit ? "当前没有正在进行的会话，不能加入队列" : "将输入框内容加入当前会话队列";
    }
    const pauseButton = root.querySelector('[data-action="pause"]');
    pauseButton.textContent = queue.paused ? "继续" : "暂停";

    const status = root.querySelector(".gptq-status");
    if (runtime.uiNotice) status.textContent = runtime.uiNotice;
    else if (!canAdmit && !queue.activeItemId) status.textContent = "当前没有正在进行的会话，不能加入队列";
    else if (queue.paused) status.textContent = "队列已暂停";
    else if (queue.activeItemId) status.textContent = "正在执行队列消息";
    else if (snapshot.composerEmpty === false && core.countPending(queue)) status.textContent = "输入框有草稿，队列暂缓发送";
    else if (core.countPending(queue)) status.textContent = `等待执行 ${core.countPending(queue)} 条`;
    else status.textContent = "暂无等待消息";

    const list = root.querySelector(".gptq-list");
    list.innerHTML = queue.items.length
      ? queue.items.map((item, index) => renderItem(item, index)).join("")
      : '<li class="gptq-empty">任务执行中输入下一条消息后加入队列</li>';
  }

  function showUiNotice(message) {
    runtime.uiNotice = message;
    scheduleUiRender();
    setTimeout(() => {
      if (runtime.uiNotice === message) runtime.uiNotice = "";
      scheduleUiRender();
    }, 2_500);
  }

  function renderItem(item, index) {
    const label = {
      pending: "等待",
      dispatching: "发送中",
      running: "执行中",
      completed: "已完成",
      failed: "失败"
    }[item.status] || item.status;
    const canModify = item.status === "pending" || item.status === "failed";
    return `
      <li class="gptq-item" data-status="${escapeHtml(item.status)}">
        <div class="gptq-item-main"><span class="gptq-index">${index + 1}</span><div>
          <p>${escapeHtml(item.text)}</p><small>${label}${item.error ? ` · ${escapeHtml(item.error)}` : ""}</small>
        </div></div>
        <div class="gptq-item-actions">
          ${canModify ? `<button type="button" data-action="edit" data-id="${item.id}">编辑</button>` : ""}
          ${item.status === "failed" ? `<button type="button" data-action="retry" data-id="${item.id}">重试</button>` : ""}
          ${item.status === "pending" ? `<button type="button" data-action="up" data-id="${item.id}">↑</button><button type="button" data-action="down" data-id="${item.id}">↓</button>` : ""}
          ${!["running", "dispatching"].includes(item.status) ? `<button type="button" data-action="delete" data-id="${item.id}">删除</button>` : ""}
        </div>
      </li>`;
  }

  async function deleteItem(itemId) {
    await mutateCurrentQueue((queue) => {
      queue.items = queue.items.filter((item) => item.id !== itemId);
      if (queue.activeItemId === itemId) queue.activeItemId = null;
      return queue;
    });
  }

  async function moveItem(itemId, direction) {
    await mutateCurrentQueue((queue) => {
      queue.items = core.moveItem(queue.items, itemId, direction);
      return queue;
    });
  }

  async function editItem(itemId) {
    const item = runtime.queue?.items?.find((candidate) => candidate.id === itemId);
    if (!item) return;
    const nextText = window.prompt("编辑队列消息", item.text);
    if (nextText == null || !core.cleanText(nextText)) return;
    await mutateCurrentQueue((queue) => {
      const current = queue.items.find((candidate) => candidate.id === itemId);
      if (current && ["pending", "failed"].includes(current.status)) {
        current.text = core.cleanText(nextText);
        current.status = "pending";
        current.error = "";
        current.retryCount = 0;
      }
      return queue;
    });
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

  function scheduleUiRender() {
    if (runtime.uiScheduled) return;
    runtime.uiScheduled = true;
    setTimeout(() => {
      runtime.uiScheduled = false;
      ensureUi();
    }, 100);
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
      #${UI_ID} .gptq-quick-add{background:#111;color:#fff}#${UI_ID} .gptq-trigger.has-items{font-weight:600}
      #${UI_ID} .gptq-count{display:inline-grid;place-items:center;min-width:20px;height:20px;padding:0 5px;border-radius:999px;background:#111;color:#fff;font-size:11px}
      #${UI_ID} .gptq-panel{position:absolute;right:0;bottom:46px;width:min(380px,calc(100vw - 28px));max-height:min(520px,70vh);overflow:hidden;border:1px solid rgba(0,0,0,.15);border-radius:14px;background:#fff;box-shadow:0 18px 54px rgba(0,0,0,.22)}
      #${UI_ID} .gptq-panel[hidden]{display:none}#${UI_ID} header{display:flex;align-items:center;justify-content:space-between;padding:12px 14px;border-bottom:1px solid rgba(0,0,0,.09)}
      #${UI_ID} header button{border:0;background:transparent;font-size:21px;line-height:1}#${UI_ID} .gptq-actions{display:flex;gap:7px;padding:10px 12px}
      #${UI_ID} .gptq-actions button,#${UI_ID} .gptq-item-actions button{border:1px solid rgba(0,0,0,.14);border-radius:8px;background:#fff;padding:5px 8px}
      #${UI_ID} .gptq-status{padding:0 12px 8px;color:#666}#${UI_ID} .gptq-list{max-height:390px;overflow:auto;margin:0;padding:0 10px 10px;list-style:none}
      #${UI_ID} .gptq-item{padding:10px 4px;border-top:1px solid rgba(0,0,0,.08)}#${UI_ID} .gptq-item-main{display:flex;gap:8px;align-items:flex-start}
      #${UI_ID} .gptq-index{flex:none;display:grid;place-items:center;width:21px;height:21px;border-radius:50%;background:rgba(0,0,0,.08);font-size:11px}
      #${UI_ID} .gptq-item-main>div{min-width:0;flex:1}#${UI_ID} .gptq-item p{margin:0;white-space:pre-wrap;word-break:break-word;display:-webkit-box;-webkit-line-clamp:3;-webkit-box-orient:vertical;overflow:hidden}
      #${UI_ID} .gptq-item small{display:block;margin-top:4px;color:#777}#${UI_ID} .gptq-item[data-status="running"] small,#${UI_ID} .gptq-item[data-status="dispatching"] small{font-weight:600}
      #${UI_ID} .gptq-item[data-status="failed"] small{color:#b42318}#${UI_ID} .gptq-item-actions{display:flex;justify-content:flex-end;gap:5px;margin-top:7px}#${UI_ID} .gptq-empty{padding:22px 8px;text-align:center;color:#777}
      @media (prefers-color-scheme:dark){#${UI_ID}{color:#ececec}#${UI_ID} .gptq-trigger,#${UI_ID} .gptq-panel,#${UI_ID} .gptq-actions button,#${UI_ID} .gptq-item-actions button{background:#2f2f2f;color:#ececec;border-color:rgba(255,255,255,.15)}#${UI_ID} .gptq-quick-add{background:#ececec;color:#202123;border-color:#ececec}#${UI_ID} .gptq-count{background:#ececec;color:#202123}#${UI_ID} header,#${UI_ID} .gptq-item{border-color:rgba(255,255,255,.1)}#${UI_ID} .gptq-status,#${UI_ID} .gptq-item small,#${UI_ID} .gptq-empty{color:#aaa}}
    `;
    (document.head || document.documentElement).appendChild(style);
  }

  async function acquireLease() {
    const now = Date.now();
    const current = await loadQueue(runtime.conversationKey);
    if (current.lease && current.lease.ownerId !== runtime.instanceId && current.lease.expiresAt > now) return false;
    await mutateCurrentQueue((queue) => {
      const freshNow = Date.now();
      if (queue.lease && queue.lease.ownerId !== runtime.instanceId && queue.lease.expiresAt > freshNow) return queue;
      queue.lease = { ownerId: runtime.instanceId, expiresAt: freshNow + LEASE_TTL_MS };
      return queue;
    });
    await delay(60);
    const verified = await loadQueue(runtime.conversationKey);
    return verified.lease?.ownerId === runtime.instanceId && verified.lease.expiresAt > Date.now();
  }

  async function refreshLease() {
    const queue = runtime.queue;
    if (!queue?.items?.some((item) => ["pending", "dispatching", "running"].includes(item.status))) return;
    if (queue.lease?.ownerId !== runtime.instanceId) return;
    if (Date.now() - runtime.lastLeaseRefreshAt < LEASE_REFRESH_MS - 250) return;
    runtime.lastLeaseRefreshAt = Date.now();
    await mutateCurrentQueue((current) => {
      if (current.lease?.ownerId !== runtime.instanceId) return current;
      current.lease.expiresAt = Date.now() + LEASE_TTL_MS;
      return current;
    });
  }

  async function acquireWriteLock(lockKey) {
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const now = Date.now();
      const { [core.WRITE_LOCK_STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      const current = stored[lockKey];
      if (current && current.ownerId !== runtime.instanceId && current.expiresAt > now) {
        await delay(35 + attempt * 20);
        continue;
      }
      const next = { ...stored, [lockKey]: { ownerId: runtime.instanceId, expiresAt: now + WRITE_LOCK_TTL_MS } };
      await chrome.storage.local.set({ [core.WRITE_LOCK_STORAGE_KEY]: next });
      await delay(25);
      const { [core.WRITE_LOCK_STORAGE_KEY]: verified = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      if (verified[lockKey]?.ownerId === runtime.instanceId) return true;
    }
    return false;
  }

  async function releaseWriteLock(lockKey) {
    const { [core.WRITE_LOCK_STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
    if (stored[lockKey]?.ownerId !== runtime.instanceId) return;
    const next = { ...stored };
    delete next[lockKey];
    await chrome.storage.local.set({ [core.WRITE_LOCK_STORAGE_KEY]: next });
  }

  async function loadQueue(conversationKey) {
    const { [core.QUEUE_STORAGE_KEY]: queues = {} } = await chrome.storage.local.get(core.QUEUE_STORAGE_KEY);
    return core.normalizeQueue(queues[conversationKey], conversationKey);
  }

  async function saveQueue(queue) {
    return mutateQueueByKey(runtime.conversationKey, () => queue);
  }

  async function mutateCurrentQueue(mutator) {
    const result = await mutateQueueByKey(runtime.conversationKey, mutator);
    runtime.queue = result;
    return result;
  }

  async function mutateQueueByKey(key, mutator) {
    let updated = null;
    await mutateQueuesLocked(key, (queues) => {
      const current = core.normalizeQueue(queues[key], key);
      const next = core.normalizeQueue(mutator(current) || current, key);
      if (!next.conversationUrl) {
        next.conversationUrl = key === runtime.conversationKey ? location.href : runtime.lastUrl;
      }
      next.revision = current.revision + 1;
      next.updatedAt = Date.now();
      queues[key] = next;
      updated = next;
      return queues;
    });
    return updated || loadQueue(key);
  }

  async function mutateQueuesLocked(_lockKey, mutator) {
    const globalLockKey = `global:${core.QUEUE_STORAGE_KEY}`;
    const run = runtime.storageWrite.then(async () => {
      const acquired = await acquireWriteLock(globalLockKey);
      if (!acquired) throw new Error("消息队列写入锁获取失败");
      try {
        const { [core.QUEUE_STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(core.QUEUE_STORAGE_KEY);
        const queues = { ...stored };
        const next = mutator(queues) || queues;
        await chrome.storage.local.set({ [core.QUEUE_STORAGE_KEY]: next });
        return next;
      } finally {
        await releaseWriteLock(globalLockKey);
      }
    });
    runtime.storageWrite = run.catch(() => {});
    return run;
  }

  function resolveConversationKey() {
    return core.getConversationKey(location.href, runtime.temporaryKey, discoverConversationId());
  }

  function discoverConversationId() {
    const main = document.querySelector("main");
    const candidates = [
      main?.getAttribute("data-conversation-id"),
      main?.getAttribute("data-thread-id"),
      main?.querySelector?.("[data-conversation-id]")?.getAttribute("data-conversation-id"),
      main?.querySelector?.("[data-thread-id]")?.getAttribute("data-thread-id"),
      document.body?.getAttribute("data-conversation-id"),
      document.querySelector('meta[name="conversation-id"]')?.content,
      findIdInHistoryState(history.state)
    ];
    const canonical = document.querySelector('link[rel="canonical"]')?.href;
    if (canonical) candidates.push(core.findConversationId(canonical));
    return candidates.map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  function findIdInHistoryState(value, depth = 0, seen = new Set()) {
    if (!value || typeof value !== "object" || depth > 4 || seen.has(value)) return "";
    seen.add(value);
    for (const [key, candidate] of Object.entries(value)) {
      if (["conversationid", "conversation_id", "threadid", "thread_id"].includes(key.toLowerCase()) && typeof candidate === "string") return candidate;
    }
    for (const candidate of Object.values(value)) {
      const found = findIdInHistoryState(candidate, depth + 1, seen);
      if (found) return found;
    }
    return "";
  }

  function getActiveItem(queue) {
    if (!queue?.activeItemId) return null;
    return queue.items.find((item) => item.id === queue.activeItemId) || null;
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

  function getLatestAssistant() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .filter((node) => isVisible(node) || node.textContent?.trim());
    const node = nodes.at(-1);
    const text = core.cleanText(node?.innerText || node?.textContent || "");
    return { node, text, hash: text ? hashText(text) : "", count: nodes.length };
  }

  function getUserMessages() {
    return [...document.querySelectorAll('[data-message-author-role="user"]')];
  }

  function getLatestUserText() {
    const node = getUserMessages().at(-1);
    return core.cleanText(node?.innerText || node?.textContent || "");
  }

  function samePrompt(left, right) {
    const a = core.cleanText(left, 20_000);
    const b = core.cleanText(right, 20_000);
    return Boolean(a && b && (a === b || a.endsWith(b) || b.endsWith(a)));
  }

  function findComposer() {
    return document.querySelector("#prompt-textarea") ||
      document.querySelector("textarea[placeholder]") ||
      document.querySelector('[contenteditable="true"][data-virtualkeyboard]') ||
      document.querySelector('main [contenteditable="true"]');
  }

  function getComposerText() {
    const composer = findComposer();
    if (!composer) return "";
    return core.cleanText(composer.value || composer.innerText || composer.textContent || "");
  }

  function clearComposer() {
    const composer = findComposer();
    if (composer) setComposerText(composer, "");
  }

  function setComposerText(composer, text) {
    composer.focus();
    if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
      const prototype = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(prototype, "value")?.set;
      if (setter) setter.call(composer, text);
      else composer.value = text;
      composer.dispatchEvent(new Event("input", { bubbles: true }));
      composer.dispatchEvent(new Event("change", { bubbles: true }));
      return;
    }
    const selection = window.getSelection();
    const range = document.createRange();
    range.selectNodeContents(composer);
    selection.removeAllRanges();
    selection.addRange(range);
    const inserted = document.execCommand?.("insertText", false, text);
    if (!inserted) composer.textContent = text;
    composer.dispatchEvent(new InputEvent("input", {
      bubbles: true,
      inputType: text ? "insertText" : "deleteContentBackward",
      data: text || null
    }));
  }

  function findSendButton() {
    const selectors = [
      'button[data-testid="send-button"]', 'button[data-testid*="send"]',
      'button[aria-label="Send prompt"]', 'button[aria-label*="Send"]',
      'button[aria-label*="发送"]', 'button[aria-label*="傳送"]'
    ];
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

  function isComposerElement(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(target.matches?.('#prompt-textarea, textarea, [contenteditable="true"]') || target.closest?.('#prompt-textarea, textarea, [contenteditable="true"]'));
  }

  function isComposerReady() {
    const composer = findComposer();
    if (!composer || !isVisible(composer)) return false;
    return composer.getAttribute("aria-disabled") !== "true" && !composer.disabled;
  }

  function hasStopControl() {
    const selectors = [
      'button[data-testid*="stop"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]',
      'button[aria-label*="停止"]', 'button[aria-label*="中止"]', 'button[aria-label*="取消生成"]'
    ];
    if (selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible))) return true;
    return [...document.querySelectorAll("main button")].some((button) => {
      if (!isVisible(button)) return false;
      const text = `${button.getAttribute("aria-label") || ""} ${button.innerText || ""}`.toLowerCase();
      return ["stop generating", "stop responding", "停止生成", "停止响应", "中止生成", "取消生成"].some((keyword) => text.includes(keyword));
    });
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
    const nodes = [...document.querySelectorAll('main [aria-live="polite"], main [role="status"], main [data-state="loading"]')].filter(isVisible);
    return nodes.some((node) => {
      const text = core.cleanText(node.innerText || node.textContent || "", 200).toLowerCase();
      return words.some((word) => text.includes(word));
    });
  }

  function findVisibleError() {
    const words = ["something went wrong", "there was an error generating a response", "network error", "conversation not found", "出现错误", "发生错误", "网络错误", "生成回复时出错", "找不到对话"];
    const nodes = [...document.querySelectorAll('[role="alert"], main [data-testid*="error"], main .text-red-500')].filter(isVisible);
    return nodes.some((node) => {
      const text = core.cleanText(node.innerText || node.textContent || "", 500).toLowerCase();
      return words.some((word) => text.includes(word));
    });
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function escapeHtml(value) {
    return String(value || "").replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;").replaceAll("'", "&#039;");
  }

  function delay(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
  }
})();
