(() => {
  if (window.__CHATGPT_MESSAGE_QUEUE_V060_LOADED__) return;
  window.__CHATGPT_MESSAGE_QUEUE_V060_LOADED__ = true;

  const core = globalThis.ChatGPTQueueCore;
  const leaseGuard = globalThis.ChatGPTQueueLeaseGuard;
  const pageAdapter = globalThis.ChatGPTPageAdapter;
  const queueUi = globalThis.ChatGPTQueueUI;
  if (!core || !leaseGuard || !pageAdapter || !queueUi) return;

  const INDEX_KEY = "messageQueueIndexV3";
  const ITEM_PREFIX = "messageQueueItemV3:";
  const LEASE_KEY = "messageQueueConversationLeasesV1";
  const STORAGE_LOCK = "gpt-notice-queue-storage-v3";
  const UI_ID = "chatgpt-message-queue-root";
  const INSPECT_MS = 900;
  const SEND_CONFIRM_MS = 10_000;
  const SEND_BUTTON_WAIT_MS = 2_500;
  const NEXT_DELAY_MS = 2_500;
  const LEASE_TTL_MS = 120_000;
  const LEASE_REFRESH_MS = 20_000;
  const DUPLICATE_WINDOW_MS = 5_000;
  const COMPATIBILITY_STABLE_MS = 2_500;
  const MAX_AUTO_RETRY = 1;

  const runtime = {
    instanceId: pageIdentity(),
    documentStartedAt: Math.floor(globalThis.performance?.timeOrigin || Date.now()),
    tabKey: stableSessionValue("chatgpt-message-queue-temp-key", "tab"),
    tabId: null,
    conversationKey: "",
    queueKey: "",
    queue: null,
    lease: null,
    lastUrl: location.href,
    lastSnapshot: null,
    assistantHash: "",
    assistantText: "",
    assistantCopy: false,
    assistantChangedAt: Date.now(),
    inspectRunning: false,
    uiAction: false,
    writingComposer: 0,
    dispatching: false,
    sendConfirmation: null,
    manualHoldUntil: 0,
    manualTaskObserved: false,
    deferredAutoItemId: "",
    notice: "",
    renderScheduled: false,
    compatibilitySince: 0,
    lastLeaseRefreshAt: 0,
    mutationQueue: Promise.resolve(),
    ui: null
  };

  boot().catch((error) => console.warn("[ChatGPT Message Queue] boot failed", error));

  async function boot() {
    const tab = await chrome.runtime.sendMessage({ type: "GET_TAB_CONTEXT" });
    if (!tab?.ok || !Number.isInteger(tab.tabId)) throw new Error("无法识别当前 Chrome 标签页");
    runtime.tabId = tab.tabId;
    setKeys(resolveConversationKey());
    runtime.queue = await loadQueue();
    if (core.shouldPauseQueueAfterPageReload(runtime.queue, runtime.instanceId, runtime.documentStartedAt)) {
      runtime.queue = await mutateQueue((queue) => core.pauseQueueAfterPageReload(queue));
    }
    resetAssistantTracking();
    runtime.ui = queueUi.create({ documentRef: document, ownerId: runtime.instanceId, rootId: UI_ID, onAction: handleUiAction });
    runtime.ui.ensure();
    installListeners();
    setInterval(() => void inspect(), INSPECT_MS);
    setInterval(() => void refreshLease(), LEASE_REFRESH_MS);
    await inspect();
  }

  function installListeners() {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes[INDEX_KEY] || Object.keys(changes).some((key) => key.startsWith(ITEM_PREFIX))) {
        void loadQueue().then((queue) => { runtime.queue = queue; scheduleRender(); });
      }
      if (changes[LEASE_KEY]) void loadLease().then((lease) => { runtime.lease = lease; scheduleRender(); });
    });

    document.addEventListener("input", (event) => {
      if (!runtime.writingComposer && isComposerTarget(event.target)) scheduleRender();
    }, true);
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      if (!runtime.dispatching && pageAdapter.looksLikeSendButton(button)) markManualSubmission();
    }, true);
    document.addEventListener("keydown", (event) => {
      if (!runtime.dispatching && event.key === "Enter" && !event.shiftKey && !event.isComposing && isComposerTarget(event.target)) markManualSubmission();
    }, true);
    document.addEventListener("submit", (event) => {
      const composer = currentPage().refs.composer;
      if (!runtime.dispatching && composer && event.target?.contains?.(composer)) markManualSubmission();
    }, true);

    const observer = new MutationObserver((mutations) => {
      if (runtime.writingComposer) return;
      const root = runtime.ui?.getRoot();
      if (mutations.some((mutation) => !root?.contains(mutation.target))) void inspect();
    });
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "disabled", "data-testid", "data-state", "data-conversation-id", "data-thread-id"]
    });

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
    addEventListener("pagehide", () => void releaseLease(), { capture: true });
  }

  async function inspect() {
    if (runtime.inspectRunning) return;
    runtime.inspectRunning = true;
    try {
      await handleNavigation();
      const now = Date.now();
      const snapshot = collectSnapshot(now);
      trackAssistant(snapshot, now);
      snapshot.stableForMs = now - runtime.assistantChangedAt;
      snapshot.taskRunning = effectiveTaskRunning(snapshot);
      snapshot.manualHold = manualHold(snapshot, now);
      runtime.lastSnapshot = snapshot;
      runtime.queue = await loadQueue();
      await enforceCompatibilityPause(snapshot, now);
      await confirmSentMessage(snapshot, now);
      await refreshLease();

      if (snapshot.supportStatus === "supported" && snapshot.compatibility !== "blocked") {
        const active = getActiveItem(runtime.queue);
        if (active && snapshot.visibleError && !snapshot.domRunning) await failDispatch(active.id, "ChatGPT 页面显示执行错误");
        else if (active && core.isItemCompleted(active, snapshot, now)) await completeItem(active.id, now);
        else if (!active && core.getNextPendingItem(runtime.queue)) await dispatchNext(snapshot);
      }
      scheduleRender();
    } catch (error) {
      console.debug("[ChatGPT Message Queue] inspect failed", error);
    } finally {
      runtime.inspectRunning = false;
    }
  }

  function collectSnapshot(now = Date.now()) {
    const page = currentPage(now);
    const task = globalThis.ChatGPTTaskNotifierBridge?.getTaskState?.() || {};
    return {
      page,
      supportStatus: page.supportStatus,
      compatibility: page.compatibility,
      reasonCodes: page.reasonCodes,
      capabilities: page.capabilities,
      assistantHash: page.private.assistantHash,
      assistantText: page.private.assistantText,
      assistantCount: page.messages.assistantCount,
      assistantHasCopyAction: page.messages.latestAssistantHasCopyAction,
      copyActionCount: page.messages.copyActionCount,
      stopVisible: page.controls.stopVisible,
      waitingAction: page.controls.waitingAction,
      busy: page.controls.busy,
      domRunning: page.controls.stopVisible || page.controls.waitingAction || page.controls.busy,
      bridgeRunning: Boolean(task.running || ["running", "waiting_action"].includes(task.status)),
      visibleError: page.error.visible,
      composerReady: page.composer.ready,
      composerEmpty: page.composer.empty,
      composerText: page.private.composerText,
      userCount: page.messages.userCount,
      taskRunning: false,
      manualHold: false,
      stableForMs: now - runtime.assistantChangedAt
    };
  }

  function trackAssistant(snapshot, now) {
    if (snapshot.assistantHash === runtime.assistantHash && snapshot.assistantText === runtime.assistantText && snapshot.assistantHasCopyAction === runtime.assistantCopy) return;
    runtime.assistantHash = snapshot.assistantHash;
    runtime.assistantText = snapshot.assistantText;
    runtime.assistantCopy = snapshot.assistantHasCopyAction;
    runtime.assistantChangedAt = now;
  }

  function resetAssistantTracking() {
    const page = currentPage();
    runtime.assistantHash = page.private.assistantHash;
    runtime.assistantText = page.private.assistantText;
    runtime.assistantCopy = page.messages.latestAssistantHasCopyAction;
    runtime.assistantChangedAt = Date.now();
  }

  function effectiveTaskRunning(snapshot) {
    if (snapshot.domRunning) return true;
    const clearlyIdle = snapshot.composerReady && !snapshot.visibleError && snapshot.stableForMs >= 1_500;
    return snapshot.bridgeRunning && !clearlyIdle;
  }

  function manualHold(snapshot, now) {
    if (snapshot.domRunning || snapshot.taskRunning) {
      runtime.manualTaskObserved = true;
      return true;
    }
    if (runtime.manualHoldUntil > now) return true;
    if (!runtime.manualTaskObserved) return false;
    if (!snapshot.composerReady || snapshot.stableForMs < 2_500) return true;
    runtime.manualTaskObserved = false;
    runtime.manualHoldUntil = 0;
    return false;
  }

  function markManualSubmission() {
    runtime.manualHoldUntil = Date.now() + SEND_CONFIRM_MS;
    runtime.manualTaskObserved = false;
  }

  async function enforceCompatibilityPause(snapshot, now) {
    if (snapshot.supportStatus !== "supported" || snapshot.compatibility !== "blocked") {
      runtime.compatibilitySince = 0;
      return;
    }
    if (!runtime.compatibilitySince) runtime.compatibilitySince = now;
    const strong = snapshot.reasonCodes.includes("multiple_visible_composers");
    if (!strong && now - runtime.compatibilitySince < COMPATIBILITY_STABLE_MS) return;
    if (!core.hasActiveWork(runtime.queue) || runtime.queue.pauseReason === "页面兼容性受阻") return;
    runtime.queue = await mutateQueue((queue) => core.pauseForCompatibility(queue, "页面兼容性受阻"));
    runtime.sendConfirmation = null;
    await releaseLease();
    notice("页面兼容性受阻，队列已安全暂停；恢复后请手动继续");
    diagnostic("queue.compatibility_paused", "paused", snapshot.reasonCodes[0] || "compatibility_blocked", "", snapshot.page);
  }

  async function enqueueComposer() {
    const before = currentPage();
    const text = String(before.private.composerText || "").replace(/\r/g, "");
    if (!text.trim()) return notice("输入框为空，请先输入要加入队列的内容");
    if (before.supportStatus !== "supported") return notice("当前不是受支持的 ChatGPT 工作页面");
    if (!before.capabilities.canAdmitQueue) return notice("当前页面无法安全读取输入框，内容未加入队列");

    runtime.queue = await loadQueue();
    const now = Date.now();
    if (runtime.queue.items.some((item) => ["pending", "dispatching", "running"].includes(item.status) && item.text === core.cleanText(text) && now - item.createdAt <= DUPLICATE_WINDOW_MS)) {
      return notice("相同内容刚刚已加入队列，未重复添加");
    }
    await nextFrame();
    if (String(currentPage().private.composerText || "") !== text) return notice("输入框内容已变化，未加入队列");
    const item = core.createQueueItem(text);
    if (!item || !(await writeComposer(""))) return notice("输入框清空失败，内容未加入队列");

    try {
      const snapshot = runtime.lastSnapshot || collectSnapshot(now);
      const idle = !snapshot.domRunning && !snapshot.taskRunning && !snapshot.bridgeRunning;
      const blocked = snapshot.compatibility === "blocked";
      runtime.queue = await mutateQueue((queue) => {
        queue.items.push(item);
        queue.conversationUrl = location.href;
        if (idle || blocked) {
          queue.paused = true;
          queue.pauseReason = blocked ? "页面兼容性受阻" : "空闲页面预存队列";
          queue.nextDispatchAt = 0;
        }
        return queue;
      });
      notice(blocked ? `已安全保存 · ${item.text.length.toLocaleString()} 字符；页面恢复后请手动继续` : idle ? `已保存并暂停 · ${item.text.length.toLocaleString()} 字符；点击继续后执行` : `已加入队列 · ${item.text.length.toLocaleString()} 字符`);
      diagnostic("queue.item_added", "ok", blocked ? "saved_while_blocked" : idle ? "saved_paused" : "queued");
    } catch (error) {
      await writeComposer(text);
      throw error;
    }
  }

  async function dispatchNext(snapshot) {
    if (runtime.dispatching || runtime.sendConfirmation) return;
    const next = core.getNextPendingItem(runtime.queue);
    if (!next || !canDispatch(runtime.queue, snapshot)) return;
    if (!snapshot.composerEmpty) {
      if (runtime.deferredAutoItemId !== next.id) runtime.ui.openConfirmation("auto-execute", next.id, "当前输入框内存在内容，是否覆盖并执行下一条队列消息？");
      return;
    }
    runtime.deferredAutoItemId = "";
    runtime.ui.closeConfirmation("auto-execute");
    await dispatchItem(next.id, false, "auto");
  }

  function canDispatch(queue, snapshot) {
    return core.canDispatch(queue, snapshot) && !snapshot.domRunning && !snapshot.taskRunning && !snapshot.bridgeRunning && !snapshot.manualHold;
  }

  function canManualDispatch(snapshot) {
    return snapshot.supportStatus === "supported" && snapshot.compatibility !== "blocked" && snapshot.capabilities.canDispatchQueue && snapshot.composerReady && !snapshot.domRunning && !snapshot.visibleError;
  }

  async function executeNow(itemId) {
    await reconcileStaleActive();
    runtime.queue = await loadQueue();
    const item = runtime.queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) return notice("该消息当前无法立即执行");
    if (runtime.queue.activeItemId) return notice("上一条队列消息仍在执行，请稍后重试");
    const snapshot = collectSnapshot();
    if (!canManualDispatch(snapshot)) return notice("当前页面仍在执行或兼容性受阻，暂时无法立即发送");
    if (!snapshot.composerEmpty) return runtime.ui.openConfirmation("execute-now", item.id, "当前输入框内存在内容，是否覆盖并立即执行？");
    await dispatchItem(item.id, false, "manual");
  }

  async function dispatchItem(itemId, allowOverwrite, source) {
    if (runtime.dispatching || runtime.sendConfirmation) return false;
    runtime.queue = await loadQueue();
    const item = runtime.queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status) || runtime.queue.activeItemId) return false;
    const snapshot = collectSnapshot();
    if (!(source === "auto" ? canDispatch(runtime.queue, snapshot) : canManualDispatch(snapshot))) return false;
    const previousText = snapshot.composerText;
    if (previousText.trim() && !allowOverwrite) return false;
    if (!(await acquireLease())) return notice("同一会话正在其他标签页执行，本标签队列将等待");

    runtime.dispatching = true;
    let claimed = false;
    try {
      runtime.queue = await mutateQueue((queue) => {
        const current = queue.items.find((candidate) => candidate.id === itemId);
        if (!current || !["pending", "failed"].includes(current.status) || queue.activeItemId) return queue;
        const wasFailed = current.status === "failed";
        current.status = "dispatching";
        current.startedAt = Date.now();
        current.finishedAt = null;
        if (wasFailed) current.retryCount = 0;
        current.baselineAssistantHash = snapshot.assistantHash;
        current.baselineAssistantCount = snapshot.assistantCount;
        current.baselineCopyActionCount = snapshot.copyActionCount;
        current.baselineUserCount = snapshot.userCount;
        current.error = "";
        queue.activeItemId = current.id;
        queue.paused = false;
        queue.pauseReason = "";
        claimed = true;
        return queue;
      });
      if (!claimed) return false;
      const sent = await submitPrompt(item.text, allowOverwrite);
      if (!sent.ok) throw Object.assign(new Error(sent.message), { retryable: sent.retryable });
      runtime.sendConfirmation = { itemId, baselineUserCount: snapshot.userCount, expiresAt: Date.now() + SEND_CONFIRM_MS };
      runtime.deferredAutoItemId = "";
      diagnostic("queue.dispatch_attempted", "started", "send_clicked");
      return true;
    } catch (error) {
      if (claimed && !runtime.sendConfirmation) await writeComposer(previousText);
      if (claimed) await failDispatch(itemId, error.message || "消息发送失败", error.retryable !== false);
      notice(`发送失败：${error.message || "未知错误"}`);
      return false;
    } finally {
      runtime.dispatching = false;
    }
  }

  async function submitPrompt(text, allowOverwrite) {
    const page = currentPage();
    if (!page.refs.composer || !page.composer.ready) return { ok: false, message: "未找到可用的输入框", retryable: false };
    if (page.private.composerText.trim() && !allowOverwrite) return { ok: false, message: "输入框已有内容，未允许覆盖", retryable: false };
    if (!(await writeComposer(text))) return { ok: false, message: "消息未能写入输入框", retryable: false };
    const deadline = Date.now() + SEND_BUTTON_WAIT_MS;
    let button = null;
    do {
      const current = currentPage();
      button = current.refs.sendButton;
      if (button && current.controls.send.enabled) {
        button.click();
        return { ok: true };
      }
      await delay(100);
    } while (Date.now() < deadline);
    return { ok: false, message: button ? "发送按钮仍不可用，队列已暂停，请检查输入框状态" : "未找到发送按钮，队列已暂停，请刷新页面或更新扩展", retryable: false };
  }

  async function confirmSentMessage(snapshot, now) {
    const pending = runtime.sendConfirmation;
    if (!pending) return;
    if (snapshot.userCount > pending.baselineUserCount || snapshot.domRunning) {
      runtime.queue = await mutateQueue((queue) => {
        const item = queue.items.find((candidate) => candidate.id === pending.itemId);
        if (item?.status === "dispatching") item.status = "running";
        return queue;
      });
      runtime.sendConfirmation = null;
    } else if (now >= pending.expiresAt) {
      runtime.sendConfirmation = null;
      await failDispatch(pending.itemId, "发送后未检测到新任务");
    }
  }

  async function failDispatch(itemId, message, retryable = true) {
    diagnostic("queue.dispatch_failed", "failed", retryable ? "retryable" : "blocked", message);
    runtime.queue = await mutateQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item) return queue;
      item.error = core.cleanText(message, 240);
      item.startedAt = null;
      item.finishedAt = null;
      item.retryCount += retryable ? 1 : 0;
      if (retryable && item.retryCount <= MAX_AUTO_RETRY) {
        item.status = "pending";
        queue.nextDispatchAt = Date.now() + 3_000;
      } else {
        item.status = retryable ? "failed" : "pending";
        item.finishedAt = retryable ? Date.now() : null;
        queue.paused = true;
        queue.pauseReason = retryable ? "发送失败" : "页面发送控件不可用";
        queue.nextDispatchAt = 0;
      }
      queue.activeItemId = null;
      return queue;
    });
    if (runtime.queue.paused) await releaseLease();
  }

  async function completeItem(itemId, now) {
    runtime.queue = await mutateQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (!item || !["dispatching", "running"].includes(item.status)) return queue;
      item.status = "completed";
      item.finishedAt = now;
      item.error = "";
      queue.activeItemId = null;
      queue.nextDispatchAt = now + NEXT_DELAY_MS;
      return queue;
    });
    diagnostic("queue.item_completed", "completed", "reply_completed");
    if (!core.hasLeaseWork(runtime.queue)) await releaseLease();
  }

  async function reconcileStaleActive() {
    if (runtime.dispatching || runtime.sendConfirmation) return;
    const snapshot = collectSnapshot();
    if (snapshot.domRunning || !snapshot.composerReady || snapshot.visibleError || snapshot.stableForMs < 500) return;
    runtime.queue = await loadQueue();
    const active = getActiveItem(runtime.queue);
    if (!active) return;
    const advanced = snapshot.assistantCount > active.baselineAssistantCount || (snapshot.assistantHash && snapshot.assistantHash !== active.baselineAssistantHash);
    runtime.queue = await mutateQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === active.id);
      if (!item) return queue;
      item.status = advanced ? "completed" : "failed";
      item.finishedAt = Date.now();
      item.error = advanced ? "" : "页面已空闲，已解除未同步的执行状态";
      queue.activeItemId = null;
      queue.nextDispatchAt = Date.now() + 500;
      return queue;
    });
  }

  async function restoreToComposer(itemId) {
    runtime.queue = await loadQueue();
    const item = runtime.queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) return notice("该消息当前不可编辑");
    const page = currentPage();
    if (!page.refs.composer) return notice("未找到当前输入框");
    if (!page.composer.empty) return runtime.ui.openConfirmation("restore", item.id, "当前输入框内存在内容，是否覆盖？");
    await applyRestore(item.id);
  }

  async function applyRestore(itemId) {
    runtime.queue = await loadQueue();
    const item = runtime.queue.items.find((candidate) => candidate.id === itemId);
    if (!item || !["pending", "failed"].includes(item.status)) return notice("该消息状态已变化，无法取回");
    const previous = currentPage().private.composerText;
    if (!(await writeComposer(item.text))) return notice("内容写入输入框失败，队列消息已保留");
    try {
      runtime.queue = await mutateQueue((queue) => {
        queue.items = queue.items.filter((candidate) => candidate.id !== itemId);
        return queue;
      });
      currentPage().refs.composer?.focus();
      notice("队列消息已取回输入框");
    } catch (error) {
      await writeComposer(previous);
      throw error;
    }
  }

  async function handleUiAction({ action, itemId }) {
    if (runtime.uiAction) return;
    if (action === "toggle-panel") return runtime.ui.togglePanel();
    if (action === "close") return runtime.ui.setPanelOpen(false);
    runtime.uiAction = true;
    runtime.ui.setBusy(true);
    try {
      if (action === "enqueue") await enqueueComposer();
      else if (action === "pause") await togglePause();
      else if (action === "clear-completed") runtime.queue = await mutateQueue((queue) => ({ ...queue, items: queue.items.filter((item) => item.status !== "completed") }));
      else if (action === "delete") runtime.queue = await mutateQueue((queue) => ({ ...queue, items: queue.items.filter((item) => item.id !== itemId) }));
      else if (action === "edit") await restoreToComposer(itemId);
      else if (action === "execute-now") await executeNow(itemId);
      else if (action === "retry") await retryItem(itemId);
      else if (action === "cancel-confirm") cancelConfirmation();
      else if (action === "confirm-action") await confirmAction();
      void inspect();
    } catch (error) {
      console.warn("[ChatGPT Message Queue] action failed", action, error);
      notice(`队列操作失败：${error.message || "未知错误"}`);
    } finally {
      runtime.uiAction = false;
      runtime.ui.setBusy(false);
      renderUi();
    }
  }

  async function togglePause() {
    runtime.queue = await loadQueue();
    if (runtime.queue.paused) {
      const snapshot = collectSnapshot();
      if (snapshot.supportStatus !== "supported" || snapshot.compatibility === "blocked") return notice("页面仍无法安全执行，请恢复页面兼容性后再继续");
      runtime.queue = await mutateQueue((queue) => core.resumeQueue(queue));
    } else {
      runtime.queue = await mutateQueue((queue) => ({ ...queue, paused: true, pauseReason: "用户暂停", nextDispatchAt: 0 }));
      if (!runtime.queue.activeItemId) await releaseLease();
    }
  }

  async function retryItem(itemId) {
    runtime.queue = await mutateQueue((queue) => {
      const item = queue.items.find((candidate) => candidate.id === itemId);
      if (item?.status === "failed") {
        item.status = "pending";
        item.error = "";
        item.retryCount = 0;
        item.startedAt = null;
        item.finishedAt = null;
        if (!queue.paused) queue.nextDispatchAt = Date.now() + 1_000;
      }
      return queue;
    });
  }

  function cancelConfirmation() {
    const confirmation = runtime.ui.getConfirmation();
    if (confirmation.mode === "auto-execute") {
      runtime.deferredAutoItemId = confirmation.itemId;
      notice("已保留当前输入，输入框清空后队列会继续执行");
    }
    runtime.ui.closeConfirmation();
  }

  async function confirmAction() {
    const { mode, itemId } = runtime.ui.getConfirmation();
    if (!mode || !itemId) return;
    runtime.ui.closeConfirmation();
    if (mode === "restore") await applyRestore(itemId);
    else {
      runtime.deferredAutoItemId = "";
      await reconcileStaleActive();
      await dispatchItem(itemId, true, mode === "auto-execute" ? "auto" : "manual");
    }
  }

  function renderUi() {
    if (!runtime.ui) return;
    const queue = core.normalizeQueue(runtime.queue, runtime.queueKey);
    const snapshot = runtime.lastSnapshot || collectSnapshot();
    const waiting = core.countPending(queue);
    const confirmation = runtime.ui.getConfirmation();
    let status = "输入内容后可随时加入队列";
    if (runtime.notice) status = runtime.notice;
    else if (snapshot.supportStatus === "initializing") status = "ChatGPT 页面正在初始化";
    else if (snapshot.supportStatus === "unsupported") status = "当前不是受支持的 ChatGPT 工作页面";
    else if (queue.paused) status = `${queue.pauseReason || "队列已暂停"}，请点击继续`;
    else if (queue.activeItemId) status = "正在执行队列消息";
    else if (otherLeaseExists()) status = "同一会话正在其他标签页执行，本标签队列等待中";
    else if (confirmation.mode === "auto-execute") status = "等待确认：是否覆盖当前草稿并执行下一条";
    else if (!snapshot.composerEmpty && waiting) status = "输入框有草稿，队列等待确认";
    else if (waiting) status = `等待执行 ${waiting} 条`;
    else if (snapshot.compatibility === "blocked") status = "页面兼容性受阻；仍可安全保存队列";
    runtime.ui.render({
      pendingCount: waiting + (queue.activeItemId ? 1 : 0),
      paused: queue.paused,
      busy: runtime.uiAction,
      enqueueTitle: snapshot.composerText.trim() ? snapshot.compatibility === "blocked" ? "安全保存到暂停队列" : "将输入框内容加入当前页面队列" : "输入框为空，点击后会显示提示",
      statusText: status,
      items: queue.items.map((item) => ({
        id: item.id,
        status: item.status,
        text: item.text,
        error: item.error,
        canModify: ["pending", "failed"].includes(item.status),
        canRetry: item.status === "failed",
        canDelete: !["running", "dispatching"].includes(item.status)
      }))
    });
  }

  function scheduleRender() {
    if (runtime.renderScheduled) return;
    runtime.renderScheduled = true;
    void nextFrame().then(() => {
      runtime.renderScheduled = false;
      renderUi();
    });
  }

  function notice(message) {
    runtime.notice = message;
    scheduleRender();
    setTimeout(() => {
      if (runtime.notice === message) runtime.notice = "";
      scheduleRender();
    }, 2_800);
  }

  async function handleNavigation() {
    const nextUrl = location.href;
    const nextConversation = resolveConversationKey();
    if (nextUrl === runtime.lastUrl && nextConversation === runtime.conversationKey) return;
    if (nextConversation === runtime.conversationKey) {
      runtime.lastUrl = nextUrl;
      return;
    }
    const previousQueue = runtime.queueKey;
    const previousConversation = runtime.conversationKey;
    const nextQueue = core.getTabQueueKey(runtime.tabId, nextConversation, runtime.tabKey);
    if (core.shouldMigrateQueue(previousConversation, nextConversation)) await migrateQueue(previousQueue, nextQueue);
    await releaseLease(previousConversation);
    runtime.lastUrl = nextUrl;
    setKeys(nextConversation);
    runtime.queue = await loadQueue();
    runtime.lease = await loadLease();
    runtime.sendConfirmation = null;
    runtime.dispatching = false;
    runtime.manualHoldUntil = 0;
    runtime.manualTaskObserved = false;
    runtime.deferredAutoItemId = "";
    resetAssistantTracking();
  }

  function setKeys(conversationKey) {
    runtime.conversationKey = conversationKey;
    runtime.queueKey = core.getTabQueueKey(runtime.tabId, conversationKey, runtime.tabKey);
  }

  function resolveConversationKey() {
    const page = currentPage();
    return core.getConversationKey(location.href, runtime.tabKey, page.private.conversationId || discoverConversationId());
  }

  function discoverConversationId() {
    const main = document.querySelector("main");
    return [main?.getAttribute("data-conversation-id"), main?.getAttribute("data-thread-id")]
      .map((value) => String(value || "").trim()).find(Boolean) || "";
  }

  async function migrateQueue(fromKey, toKey) {
    const source = await loadQueue(fromKey);
    if (!source.items.length) return;
    const target = await loadQueue(toKey);
    const ids = new Set(target.items.map((item) => item.id));
    target.items.push(...source.items.filter((item) => !ids.has(item.id)));
    target.paused ||= source.paused;
    target.pauseReason ||= source.pauseReason;
    target.activeItemId ||= source.activeItemId;
    target.nextDispatchAt = Math.max(target.nextDispatchAt, source.nextDispatchAt);
    await saveQueue(toKey, target, target);
    await deleteQueue(fromKey,{items:[]});
  }

  async function loadQueue(key = runtime.queueKey) {
    if (!key) return core.normalizeQueue({}, key);
    const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
    const metadata = index[key];
    if (!metadata) return core.normalizeQueue({}, key);
    const itemKeys = (metadata.items || []).map((item) => `${ITEM_PREFIX}${item.id}`);
    const texts = itemKeys.length ? await chrome.storage.local.get(itemKeys) : {};
    return core.normalizeQueue({
      ...metadata,
      items: (metadata.items || []).map((item) => ({ ...item, text: String(texts[`${ITEM_PREFIX}${item.id}`] || "") }))
    }, key);
  }

  function mutateQueue(mutator) {
    const run = runtime.mutationQueue.then(() => withStorageLock(async () => {
      const previous = await loadQueue();
      const next = core.normalizeQueue(mutator(core.normalizeQueue(previous, runtime.queueKey)) || previous, runtime.queueKey);
      next.revision = previous.revision + 1;
      next.updatedAt = Date.now();
      next.ownerTabId = runtime.tabId;
      next.ownerInstanceId = runtime.instanceId;
      next.conversationUrl ||= location.href;
      return saveQueue(runtime.queueKey, next, previous, false);
    }));
    runtime.mutationQueue = run.catch(() => {});
    return run;
  }

  async function saveQueue(key, queue, previous = core.normalizeQueue({}, key), lock = true) {
    const operation = async () => {
      const normalized = core.normalizeQueue(queue, key);
      const previousById = new Map(previous.items.map((item) => [item.id, item]));
      const values = {};
      for (const item of normalized.items) {
        if (previousById.get(item.id)?.text !== item.text) values[`${ITEM_PREFIX}${item.id}`] = item.text;
      }
      const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
      values[INDEX_KEY] = {
        ...index,
        [key]: {
          ...normalized,
          items: normalized.items.map(({ text, ...item }) => ({ ...item, textLength: text.length }))
        }
      };
      await chrome.storage.local.set(values);
      const deleted = previous.items.filter((item) => !normalized.items.some((next) => next.id === item.id)).map((item) => `${ITEM_PREFIX}${item.id}`);
      if (deleted.length) await chrome.storage.local.remove(deleted);
      runtime.queue = normalized;
      return normalized;
    };
    return lock ? withStorageLock(operation) : operation();
  }

  async function deleteQueue(key, queue) {
    await withStorageLock(async () => {
      const { [INDEX_KEY]: index = {} } = await chrome.storage.local.get(INDEX_KEY);
      const next = { ...index };
      delete next[key];
      await chrome.storage.local.set({ [INDEX_KEY]: next });
      const keys = queue.items.map((item) => `${ITEM_PREFIX}${item.id}`);
      if (keys.length) await chrome.storage.local.remove(keys);
    });
  }

  async function withStorageLock(operation) {
    if (globalThis.navigator?.locks?.request) return navigator.locks.request(STORAGE_LOCK, { mode: "exclusive" }, operation);
    const owner = `${runtime.instanceId}:${core.createId("lock")}`;
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const now = Date.now();
      const { [core.WRITE_LOCK_STORAGE_KEY]: locks = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      const current = locks[STORAGE_LOCK];
      if (current && current.ownerId !== owner && current.expiresAt > now) {
        await delay(35 + attempt * 20);
        continue;
      }
      await chrome.storage.local.set({ [core.WRITE_LOCK_STORAGE_KEY]: { ...locks, [STORAGE_LOCK]: { ownerId: owner, expiresAt: now + 5_000 } } });
      await delay(30);
      const { [core.WRITE_LOCK_STORAGE_KEY]: verify = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
      if (verify[STORAGE_LOCK]?.ownerId === owner) {
        try { return await operation(); }
        finally {
          const { [core.WRITE_LOCK_STORAGE_KEY]: latest = {} } = await chrome.storage.local.get(core.WRITE_LOCK_STORAGE_KEY);
          if (latest[STORAGE_LOCK]?.ownerId === owner) {
            const next = { ...latest };
            delete next[STORAGE_LOCK];
            Object.keys(next).length ? await chrome.storage.local.set({ [core.WRITE_LOCK_STORAGE_KEY]: next }) : await chrome.storage.local.remove(core.WRITE_LOCK_STORAGE_KEY);
          }
        }
      }
    }
    throw new Error("消息队列跨标签写入锁获取失败");
  }

  function normalizeLease(value) {
    const ownerTabId = Number(value?.ownerTabId);
    const ownerInstanceId = String(value?.ownerInstanceId || "");
    const ownerQueueKey = String(value?.ownerQueueKey || "");
    const leaseId = String(value?.leaseId || "");
    const expiresAt = Number(value?.expiresAt || 0);
    return Number.isInteger(ownerTabId) && ownerInstanceId && ownerQueueKey && expiresAt ? { ownerTabId, ownerInstanceId, ownerQueueKey, leaseId, expiresAt } : null;
  }

  async function loadLease(conversation = runtime.conversationKey) {
    if (!conversation) return null;
    const { [LEASE_KEY]: leases = {} } = await chrome.storage.local.get(LEASE_KEY);
    return normalizeLease(leases[conversation]);
  }

  function ownsLease(lease, expectedId = "") {
    return leaseGuard.isLeaseOwner(lease, { tabId: runtime.tabId, instanceId: runtime.instanceId, queueKey: runtime.queueKey }, expectedId);
  }

  function otherLeaseExists(now = Date.now()) {
    return Boolean(runtime.lease && !ownsLease(runtime.lease) && runtime.lease.expiresAt > now);
  }

  async function acquireLease() {
    let claimed = false;
    await withStorageLock(async () => {
      const now = Date.now();
      const { [LEASE_KEY]: stored = {} } = await chrome.storage.local.get(LEASE_KEY);
      const leases = { ...stored };
      const current = normalizeLease(leases[runtime.conversationKey]);
      const sameOwner = ownsLease(current);
      const newerSameTab = current && current.ownerTabId === runtime.tabId && current.ownerInstanceId !== runtime.instanceId && leaseGuard.compareInstanceAge(runtime.instanceId, current.ownerInstanceId) > 0;
      if (current && !sameOwner && !newerSameTab && current.expiresAt > now) {
        runtime.lease = current;
        return;
      }
      runtime.lease = {
        ownerTabId: runtime.tabId,
        ownerInstanceId: runtime.instanceId,
        ownerQueueKey: runtime.queueKey,
        leaseId: core.createId("lease"),
        expiresAt: now + LEASE_TTL_MS
      };
      leases[runtime.conversationKey] = runtime.lease;
      await chrome.storage.local.set({ [LEASE_KEY]: leases });
      claimed = true;
    });
    if (!claimed) return false;
    runtime.lease = await loadLease();
    const acquired = ownsLease(runtime.lease) && runtime.lease.expiresAt > Date.now();
    if (acquired) diagnostic("queue.lease_acquired", "ok", "owner_verified");
    return acquired;
  }

  async function refreshLease() {
    if (!core.hasLeaseWork(runtime.queue)) {
      if (ownsLease(runtime.lease)) await releaseLease();
      return;
    }
    if (!ownsLease(runtime.lease) || Date.now() - runtime.lastLeaseRefreshAt < LEASE_REFRESH_MS - 250) return;
    runtime.lastLeaseRefreshAt = Date.now();
    await withStorageLock(async () => {
      const { [LEASE_KEY]: stored = {} } = await chrome.storage.local.get(LEASE_KEY);
      const leases = { ...stored };
      const current = normalizeLease(leases[runtime.conversationKey]);
      if (!ownsLease(current, runtime.lease.leaseId)) return;
      runtime.lease = { ...current, expiresAt: Date.now() + LEASE_TTL_MS };
      leases[runtime.conversationKey] = runtime.lease;
      await chrome.storage.local.set({ [LEASE_KEY]: leases });
    });
  }

  async function releaseLease(conversation = runtime.conversationKey) {
    if (!conversation || !runtime.lease) return;
    const expectedId = runtime.lease.leaseId;
    await withStorageLock(async () => {
      const { [LEASE_KEY]: stored = {} } = await chrome.storage.local.get(LEASE_KEY);
      const leases = { ...stored };
      const current = normalizeLease(leases[conversation]);
      if (!ownsLease(current, expectedId)) return;
      delete leases[conversation];
      await chrome.storage.local.set({ [LEASE_KEY]: leases });
      if (conversation === runtime.conversationKey) runtime.lease = null;
    });
  }

  async function writeComposer(text) {
    const composer = currentPage().refs.composer;
    if (!composer) return false;
    runtime.writingComposer += 1;
    try {
      composer.focus();
      if (composer instanceof HTMLTextAreaElement || composer instanceof HTMLInputElement) {
        const proto = composer instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, "value")?.set;
        setter ? setter.call(composer, text) : composer.value = text;
      } else {
        composer.replaceChildren(document.createTextNode(text));
      }
      composer.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: text ? "insertText" : "deleteContentBackward", data: text || null }));
      await nextFrame();
      await nextFrame();
      return core.cleanText(currentPage().private.composerText) === core.cleanText(text);
    } finally {
      runtime.writingComposer = Math.max(0, runtime.writingComposer - 1);
      scheduleRender();
    }
  }

  function currentPage(now = Date.now()) {
    return pageAdapter.collectPageState({ documentRef: document, locationRef: location, root: globalThis, now, documentStartedAt: runtime.documentStartedAt });
  }

  function isComposerTarget(target) {
    const composer = currentPage().refs.composer;
    return Boolean(target && composer && (target === composer || composer.contains?.(target)));
  }

  function getActiveItem(queue) {
    return queue?.activeItemId ? queue.items.find((item) => item.id === queue.activeItemId) || null : null;
  }

  function pageIdentity() {
    return leaseGuard.preparePageInstance(globalThis) || core.createId("page");
  }

  function stableSessionValue(key, prefix) {
    let value = sessionStorage.getItem(key);
    if (!value) {
      value = core.createId(prefix);
      sessionStorage.setItem(key, value);
    }
    return value;
  }

  function diagnostic(type, result, reasonCode = "", summary = "", page = null) {
    try {
      void chrome.runtime.sendMessage({
        type: "DIAGNOSTIC_EVENT",
        event: { type, result, reasonCode, summary, module: "queue-runtime", sessionKey: runtime.conversationKey, snapshot: page ? pageAdapter.toPublicSnapshot(page) : undefined }
      }).catch(() => {});
    } catch {}
  }

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  function nextFrame() {
    return new Promise((resolve) => {
      let done = false;
      const finish = () => {
        if (done) return;
        done = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, 100);
      typeof requestAnimationFrame === "function" ? requestAnimationFrame(finish) : finish();
    });
  }
})();
