(() => {
  if (window.__CHATGPT_TASK_NOTIFIER_LOADED__) return;
  window.__CHATGPT_TASK_NOTIFIER_LOADED__ = true;

  const pageAdapter = globalThis.ChatGPTPageAdapter;
  if (!pageAdapter) return;

  const COMPLETION_STABLE_MS = 4_000;
  const COPY_ACTION_STABLE_MS = 600;
  const NAVIGATION_CONFIRM_MS = 2_000;
  const RECOVERY_IDLE_GRACE_MS = 10_000;
  const INSPECT_INTERVAL_MS = 800;
  const HEARTBEAT_INTERVAL_MS = 5_000;
  const PENDING_SUBMISSION_MS = 10_000;
  const URL_PROMOTION_WINDOW_MS = 60_000;
  const START_RETRY_MS = 800;

  const state = {
    taskId: null,
    running: false,
    remoteStatus: null,
    baselineAssistantHash: "",
    baselineCopyActionCount: 0,
    latestAssistantHash: "",
    latestAssistantChangedAt: Date.now(),
    lastAssistantText: "",
    lastAssistantHasCopyAction: false,
    lastSettledAssistantHash: "",
    lastUserCount: 0,
    pendingBaselineUserCount: 0,
    pendingBaselineUserHash: "",
    pendingPrompt: "",
    pendingBaselineHash: "",
    pendingBaselineCopyActionCount: 0,
    pendingAt: 0,
    pendingConfirmed: false,
    nextStartAttemptAt: 0,
    startInFlight: false,
    startedAt: 0,
    lastUrl: location.href,
    lastPageKey: getPageKey(location.href),
    lastReportedStatus: null,
    reportInFlight: false,
    lastContentChangeAt: Date.now(),
    inspectionScheduled: false,
    inspectRunning: false,
    restoredAt: 0,
    restoredAssistantHash: "",
    restoredObservedRunning: false,
    navigationCandidateUrl: "",
    navigationCandidateSince: 0,
    navigationCandidateTimer: null,
    documentStartedAt: Math.floor(globalThis.performance?.timeOrigin || Date.now()),
    lastPageState: null,
    lastCompatibilityKey: ""
  };

  globalThis.ChatGPTTaskNotifierBridge = {
    getTaskState() {
      return {
        taskId: state.taskId,
        running: state.running,
        status: state.remoteStatus,
        startedAt: state.startedAt,
        compatibility: state.lastPageState?.compatibility || "initializing"
      };
    },
    getPublicPageSnapshot() {
      return pageAdapter.toPublicSnapshot(state.lastPageState || collectPageState());
    }
  };

  boot().catch((error) => console.warn("[ChatGPT Task Notifier] boot failed", error));

  async function boot() {
    const initial = collectPageState();
    state.lastPageState = initial;
    state.lastUserCount = initial.messages.userCount;
    const assistant = assistantFromPage(initial);
    state.lastAssistantText = assistant.text;
    state.lastAssistantHasCopyAction = assistant.hasCopyAction;
    state.latestAssistantHash = assistant.hash;
    state.lastSettledAssistantHash = assistant.hash;

    await bindCurrentPage();
    installSubmissionListeners();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type === "PROBE_TASK_STATE") {
        sendResponse({ ok: true, ...buildProbe() });
        return false;
      }
      if (message?.type === "GET_PAGE_SNAPSHOT") {
        const current = collectPageState();
        state.lastPageState = current;
        sendResponse({ ok: true, snapshot: pageAdapter.toPublicSnapshot(current) });
        return false;
      }
      return false;
    });

    const observer = new MutationObserver(scheduleInspect);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "disabled", "data-testid", "data-state"]
    });

    setInterval(() => void inspect(), INSPECT_INTERVAL_MS);
    setInterval(() => void sendHeartbeat(), HEARTBEAT_INTERVAL_MS);
    await inspect();
  }

  function collectPageState(now = Date.now()) {
    return pageAdapter.collectPageState({ documentRef: document, locationRef: location, root: globalThis, now, documentStartedAt: state.documentStartedAt });
  }

  async function bindCurrentPage() {
    const response = await sendWithRetry({ type: "PAGE_READY", url: location.href }, 2);
    if (response?.task && ["running", "waiting_action"].includes(response.task.status)) attachExistingTask(response.task);
  }

  function attachExistingTask(task) {
    const page = collectPageState();
    const assistant = assistantFromPage(page);
    state.lastPageState = page;
    state.taskId = task.id;
    state.running = true;
    state.remoteStatus = task.status;
    state.baselineAssistantHash = task.baselineAssistantHash || "";
    state.baselineCopyActionCount = Math.max(0, Number(task.baselineCopyActionCount || 0));
    state.latestAssistantHash = assistant.hash;
    state.lastAssistantText = assistant.text;
    state.lastAssistantHasCopyAction = assistant.hasCopyAction;
    state.startedAt = task.startedAt || Date.now();
    state.lastReportedStatus = task.status;
    state.latestAssistantChangedAt = Date.now();
    state.restoredAt = Date.now();
    state.restoredAssistantHash = assistant.hash || task.latestAssistantHash || "";
    state.restoredObservedRunning = false;
  }

  function installSubmissionListeners() {
    document.addEventListener("click", (event) => {
      const button = event.target?.closest?.("button");
      if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true" || !pageAdapter.looksLikeSendButton(button)) return;
      rememberPendingSubmission();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      if (!isComposerElement(event.target)) return;
      rememberPendingSubmission();
    }, true);

    document.addEventListener("submit", (event) => {
      if (event.defaultPrevented) return;
      const composer = collectPageState().refs.composer;
      if (composer && (event.target === composer || event.target?.contains?.(composer))) rememberPendingSubmission();
    }, true);
  }

  function rememberPendingSubmission() {
    const page = collectPageState();
    const prompt = cleanText(page.private.composerText, 240);
    if (!prompt) return;
    const assistant = assistantFromPage(page);
    state.pendingBaselineUserCount = page.messages.userCount;
    state.pendingBaselineUserHash = hashText(page.private.latestUserText);
    state.pendingPrompt = prompt;
    state.pendingBaselineHash = assistant.hash || state.lastSettledAssistantHash || "";
    state.pendingBaselineCopyActionCount = page.messages.copyActionCount;
    state.pendingAt = Date.now();
    state.pendingConfirmed = false;
    state.nextStartAttemptAt = 0;
    setTimeout(() => void inspect(), 150);
  }

  function scheduleInspect() {
    state.lastContentChangeAt = Date.now();
    if (state.inspectionScheduled) return;
    state.inspectionScheduled = true;
    setTimeout(() => {
      state.inspectionScheduled = false;
      void inspect();
    }, 120);
  }

  async function inspect() {
    if (state.inspectRunning) return;
    state.inspectRunning = true;
    try {
      await handleNavigationChange();
      const now = Date.now();
      const page = collectPageState(now);
      state.lastPageState = page;
      const assistant = assistantFromPage(page);
      if (assistant.text !== state.lastAssistantText || assistant.hasCopyAction !== state.lastAssistantHasCopyAction) {
        state.lastAssistantText = assistant.text;
        state.lastAssistantHasCopyAction = assistant.hasCopyAction;
        state.latestAssistantHash = assistant.hash;
        state.latestAssistantChangedAt = now;
        state.lastContentChangeAt = now;
      }
      const compatibilityKey = `${page.supportStatus}:${page.compatibility}:${page.reasonCodes.join(",")}`;
      if (compatibilityKey !== state.lastCompatibilityKey) {
        const previousKey = state.lastCompatibilityKey;
        state.lastCompatibilityKey = compatibilityKey;
        recordDiagnostic({
          type: "page.compatibility_changed",
          module: "task-monitor",
          operation: "inspect",
          result: page.compatibility === "blocked" ? "blocked" : previousKey ? "recovered" : "ok",
          reasonCode: page.reasonCodes[0] || page.compatibility,
          snapshot: pageAdapter.toPublicSnapshot(page)
        });
      }
      const snapshot = collectTaskSnapshot(page, now, assistant);
      const userCount = page.messages.userCount;
      if (state.restoredAt && snapshot.domRunning) state.restoredObservedRunning = true;

      const recentSubmission = Boolean(state.pendingAt && now - state.pendingAt <= PENDING_SUBMISSION_MS);
      const latestUserText = page.private.latestUserText;
      const latestUserHash = hashText(latestUserText);
      const userMessageConfirmed = userCount > state.pendingBaselineUserCount || Boolean(
        latestUserHash && latestUserHash !== state.pendingBaselineUserHash && samePromptText(latestUserText, state.pendingPrompt)
      );
      if (recentSubmission && userMessageConfirmed) state.pendingConfirmed = true;
      if (!recentSubmission && !state.running) clearPendingSubmission();

      if (!state.running && state.pendingConfirmed && now >= state.nextStartAttemptAt) {
        await startTask({ prompt: latestUserText || state.pendingPrompt, baselineHash: state.pendingBaselineHash || state.lastSettledAssistantHash });
      }
      state.lastUserCount = userCount;

      if (!state.running) {
        if (assistant.hash) state.lastSettledAssistantHash = assistant.hash;
        return;
      }

      if (page.compatibility === "blocked" || page.supportStatus !== "supported") return;
      if (snapshot.stopVisible && state.remoteStatus !== "running") await reportStatus("running", assistant);
      if (snapshot.waitingAction && !snapshot.stopVisible) {
        await reportStatus("waiting_action", assistant);
        return;
      }
      if (snapshot.visibleError && !snapshot.stopVisible) {
        if (await reportStatus("failed", assistant)) finishLocalTask();
        return;
      }
      if (snapshot.completed && await reportStatus("completed", assistant)) {
        state.lastSettledAssistantHash = assistant.hash;
        finishLocalTask();
      }
    } catch (error) {
      console.debug("[ChatGPT Task Notifier] inspect failed", error);
    } finally {
      state.inspectRunning = false;
    }
  }

  async function handleNavigationChange() {
    const currentUrl = location.href;
    const currentPageKey = getPageKey(currentUrl);
    if (currentUrl === state.lastUrl && currentPageKey === state.lastPageKey) {
      clearNavigationCandidate();
      return;
    }
    const previousUrl = state.lastUrl;
    const previousPageKey = state.lastPageKey;
    const promoted = isConversationPromotion(previousUrl, currentUrl);
    if (previousPageKey && currentPageKey !== previousPageKey && !promoted && isAmbiguousConversationTransition(previousUrl, currentUrl)) {
      if (state.navigationCandidateUrl !== currentUrl) {
        clearNavigationCandidate();
        state.navigationCandidateUrl = currentUrl;
        state.navigationCandidateSince = Date.now();
        state.navigationCandidateTimer = setTimeout(() => {
          state.navigationCandidateTimer = null;
          void inspect();
        }, NAVIGATION_CONFIRM_MS);
      }
      if (Date.now() - state.navigationCandidateSince < NAVIGATION_CONFIRM_MS) return;
      clearNavigationCandidate();
    } else {
      clearNavigationCandidate();
    }
    state.lastUrl = currentUrl;
    state.lastPageKey = currentPageKey;

    if (previousPageKey && currentPageKey !== previousPageKey && promoted) {
      if (state.running && state.taskId) {
        const response = await sendWithRetry({ type: "PAGE_PROMOTED", taskId: state.taskId, url: currentUrl, previousUrl }, 3);
        if (response?.task?.id) {
          state.taskId = response.task.id;
          state.remoteStatus = response.task.status || state.remoteStatus;
        }
      }
      return;
    }

    if (previousPageKey && currentPageKey !== previousPageKey) {
      await sendWithRetry({
        type: "PAGE_CHANGED",
        url: currentUrl,
        previousUrl,
        reason: "已明确进入其他 ChatGPT 会话，旧任务监控已停止"
      }, 3);
      finishLocalTask();
      const page = collectPageState();
      state.lastUserCount = page.messages.userCount;
      const assistant = assistantFromPage(page);
      state.lastSettledAssistantHash = assistant.hash;
      state.lastAssistantText = assistant.text;
      state.latestAssistantHash = assistant.hash;
      await bindCurrentPage();
    }
  }

  function clearNavigationCandidate() {
    if (state.navigationCandidateTimer) clearTimeout(state.navigationCandidateTimer);
    state.navigationCandidateUrl = "";
    state.navigationCandidateSince = 0;
    state.navigationCandidateTimer = null;
  }

  function collectTaskSnapshot(page, now = Date.now(), assistant = assistantFromPage(page)) {
    const stopVisible = page.controls.stopVisible;
    const waitingAction = page.controls.waitingAction;
    const visibleError = page.error.visible;
    const busy = page.controls.busy;
    const domRunning = stopVisible || waitingAction || busy;
    const responseChanged = Boolean(assistant.hash && assistant.hash !== state.baselineAssistantHash && assistant.text.trim());
    const copyActionAdvanced = Boolean(responseChanged && assistant.hasCopyAction && page.messages.copyActionCount >= state.baselineCopyActionCount);
    const copyActionStable = copyActionAdvanced && now - state.latestAssistantChangedAt >= COPY_ACTION_STABLE_MS;
    const textStable = responseChanged && now - state.latestAssistantChangedAt >= COMPLETION_STABLE_MS;
    const ranLongEnough = !state.startedAt || now - state.startedAt >= 1_800;
    const recoveryReady = !state.restoredAt || state.restoredObservedRunning || assistant.hash !== state.restoredAssistantHash || now - state.restoredAt >= RECOVERY_IDLE_GRACE_MS;
    const completed = Boolean(
      state.running && page.capabilities.canDetectCompletion && !domRunning && !visibleError && ranLongEnough && page.composer.ready && recoveryReady && (copyActionStable || textStable)
    );
    return {
      assistant,
      stopVisible,
      waitingAction,
      visibleError,
      busy,
      domRunning,
      composerReady: page.composer.ready,
      copyActionCount: page.messages.copyActionCount,
      copyActionAdvanced,
      completed
    };
  }

  function buildProbe() {
    const page = collectPageState();
    state.lastPageState = page;
    const snapshot = collectTaskSnapshot(page);
    const assistant = assistantFromPage(page);
    return {
      taskId: state.taskId,
      url: location.href,
      pageReady: page.pageReady,
      supportStatus: page.supportStatus,
      compatibility: page.compatibility,
      reasonCodes: page.reasonCodes,
      capabilities: page.capabilities,
      stopVisible: snapshot.stopVisible,
      waitingAction: snapshot.waitingAction,
      visibleError: snapshot.visibleError,
      busy: snapshot.busy,
      composerReady: snapshot.composerReady,
      completed: snapshot.completed,
      latestAssistantHash: assistant.hash,
      assistantFirstLine: assistant.firstLine,
      thinkingTimeText: assistant.thinkingTimeText,
      publicPageSnapshot: pageAdapter.toPublicSnapshot(page),
      checkedAt: Date.now()
    };
  }

  async function startTask({ prompt, baselineHash }) {
    if (state.running || state.startInFlight || !state.pendingConfirmed) return false;
    state.startInFlight = true;
    try {
      const startedAt = Date.now();
      const page = collectPageState();
      const resolvedPrompt = prompt || page.private.latestUserText || state.pendingPrompt || "ChatGPT 任务";
      const response = await sendWithRetry({
        type: "TASK_STARTED",
        taskId: state.taskId,
        url: location.href,
        questionTitle: getQuestionTitle(resolvedPrompt),
        prompt: cleanText(resolvedPrompt, 240),
        baselineAssistantHash: baselineHash || state.lastSettledAssistantHash || "",
        baselineCopyActionCount: state.pendingBaselineCopyActionCount,
        latestAssistantHash: page.private.assistantHash,
        compatibility: page.compatibility
      }, 3);
      if (!response?.task?.id) {
        state.nextStartAttemptAt = Date.now() + START_RETRY_MS;
        return false;
      }
      state.taskId = response.task.id;
      state.running = true;
      state.remoteStatus = "running";
      state.startedAt = response.task.startedAt || startedAt;
      state.baselineAssistantHash = response.task.baselineAssistantHash || baselineHash || state.lastSettledAssistantHash || "";
      state.baselineCopyActionCount = Math.max(0, Number(response.task.baselineCopyActionCount ?? state.pendingBaselineCopyActionCount));
      state.lastReportedStatus = "running";
      state.latestAssistantChangedAt = Date.now();
      state.lastContentChangeAt = Date.now();
      state.restoredAt = 0;
      state.restoredAssistantHash = "";
      state.restoredObservedRunning = false;
      clearPendingSubmission();
      recordDiagnostic({ type: "task.started", module: "task-monitor", operation: "start", result: "started", reasonCode: "user_message_confirmed" });
      return true;
    } finally {
      state.startInFlight = false;
    }
  }

  async function reportStatus(status, assistant = assistantFromPage(collectPageState()), extra = {}) {
    if (!state.taskId) return false;
    if (state.lastReportedStatus === status) {
      state.remoteStatus = status;
      return true;
    }
    if (state.reportInFlight) return false;
    state.reportInFlight = true;
    try {
      const page = state.lastPageState || collectPageState();
      const response = await sendWithRetry({
        type: "TASK_STATE",
        taskId: state.taskId,
        status,
        url: location.href,
        prompt: page.private.latestUserText,
        questionTitle: getQuestionTitle(page.private.latestUserText),
        assistantFirstLine: assistant.firstLine || "",
        thinkingTimeText: assistant.thinkingTimeText || (status === "completed" ? formatThinkingTime(Date.now() - state.startedAt) : ""),
        latestAssistantHash: assistant.hash,
        lastContentChangeAt: state.lastContentChangeAt,
        compatibility: page.compatibility,
        ...extra
      }, 3);
      if (!response?.ok) return false;
      state.lastReportedStatus = status;
      state.remoteStatus = status;
      recordDiagnostic({
        type: `task.${status}`,
        module: "task-monitor",
        operation: "state",
        result: status === "failed" ? "failed" : status === "completed" ? "completed" : "ok",
        reasonCode: page.compatibility || ""
      });
      return true;
    } finally {
      state.reportInFlight = false;
    }
  }

  function clearPendingSubmission() {
    state.pendingBaselineUserCount = 0;
    state.pendingBaselineUserHash = "";
    state.pendingPrompt = "";
    state.pendingBaselineHash = "";
    state.pendingBaselineCopyActionCount = 0;
    state.pendingAt = 0;
    state.pendingConfirmed = false;
    state.nextStartAttemptAt = 0;
  }

  function finishLocalTask() {
    state.running = false;
    state.remoteStatus = null;
    state.taskId = null;
    state.startedAt = 0;
    state.lastReportedStatus = null;
    state.baselineAssistantHash = state.latestAssistantHash;
    state.baselineCopyActionCount = state.lastPageState?.messages.copyActionCount || 0;
    state.restoredAt = 0;
    state.restoredAssistantHash = "";
    state.restoredObservedRunning = false;
    clearPendingSubmission();
  }

  async function sendHeartbeat() {
    if (!state.taskId || !state.running) return;
    const page = collectPageState();
    state.lastPageState = page;
    const response = await sendWithRetry({
      type: "HEARTBEAT",
      taskId: state.taskId,
      url: location.href,
      latestAssistantHash: page.private.assistantHash,
      compatibility: page.compatibility
    }, 2);
    if (response?.task?.status) state.remoteStatus = response.task.status;
  }

  function assistantFromPage(page) {
    return {
      node: page?.refs?.assistantNode || null,
      text: String(page?.private?.assistantText || ""),
      hash: String(page?.private?.assistantHash || ""),
      count: Math.max(0, Number(page?.messages?.assistantCount || 0)),
      hasCopyAction: Boolean(page?.messages?.latestAssistantHasCopyAction),
      firstLine: String(page?.private?.assistantFirstLine || ""),
      thinkingTimeText: String(page?.private?.thinkingTimeText || "")
    };
  }

  function isComposerElement(target) {
    const composer = collectPageState().refs.composer;
    return Boolean(target && composer && (target === composer || composer.contains?.(target) || target.closest?.("#prompt-textarea, textarea, [contenteditable='true']") === composer));
  }

  function getPageKey(value) {
    try {
      const url = new URL(value, location.origin);
      const conversationId = pageAdapter.getConversationId(url.href, location.origin);
      if (conversationId) return `${url.origin}/c/${conversationId}`;
      return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
    } catch {
      return String(value || "");
    }
  }

  function isDraftChatUrl(value) {
    return pageAdapter.classifyRoute(value, location.origin).routeType === "draft";
  }

  function isConversationPromotion(previousUrl, currentUrl, now = Date.now()) {
    const recentSubmission = Boolean(state.pendingAt && now - state.pendingAt <= URL_PROMOTION_WINDOW_MS);
    const previousId = pageAdapter.getConversationId(previousUrl, location.origin);
    const currentId = pageAdapter.getConversationId(currentUrl, location.origin);
    const draftPromotion = isDraftChatUrl(previousUrl) && Boolean(currentId);
    const provisionalPromotion = pageAdapter.isProvisionalConversationId(previousId) && Boolean(currentId) && !pageAdapter.isProvisionalConversationId(currentId);
    return (draftPromotion || provisionalPromotion) && (state.running || recentSubmission);
  }

  function isAmbiguousConversationTransition(previousUrl, currentUrl) {
    const previousId = pageAdapter.getConversationId(previousUrl, location.origin);
    const currentId = pageAdapter.getConversationId(currentUrl, location.origin);
    return Boolean(previousId) !== Boolean(currentId);
  }

  function getQuestionTitle(value) {
    const raw = String(value || "").replace(/\r/g, "").trim();
    let title = raw.split(/\n+/).map((line) => line.trim()).find(Boolean) || "ChatGPT 任务";
    const indexes = ["。", "！", "？", "!", "?"].map((mark) => title.indexOf(mark)).filter((index) => index >= 6);
    if (indexes.length) title = title.slice(0, Math.min(...indexes) + 1);
    return cleanText(title.replace(/^#+\s*/, ""), 80) || "ChatGPT 任务";
  }

  function formatThinkingTime(elapsedMs) {
    const totalSeconds = Math.max(1, Math.round(Number(elapsedMs || 0) / 1000));
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `思考了 ${minutes ? `${minutes}m${seconds ? ` ${seconds}s` : ""}` : `${seconds}s`}`;
  }

  function samePromptText(left, right) {
    const normalize = (value) => String(value || "").replace(/\s+/g, " ").trim();
    const normalizedLeft = normalize(left);
    const normalizedRight = normalize(right);
    return Boolean(normalizedLeft && normalizedRight && normalizedLeft === normalizedRight);
  }

  function cleanText(value, maxLength) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function hashText(text) {
    return pageAdapter.hashText(String(text || ""));
  }

  function recordDiagnostic(event) {
    try {
      void chrome.runtime.sendMessage({ type: "DIAGNOSTIC_EVENT", event }).catch(() => {});
    } catch {}
  }

  function delay(ms) { return new Promise((resolve) => setTimeout(resolve, ms)); }

  async function sendWithRetry(message, attempts = 3) {
    for (let attempt = 0; attempt < attempts; attempt += 1) {
      try {
        const response = await chrome.runtime.sendMessage(message);
        if (response && response.ok !== false) return response;
      } catch (error) {
        if (attempt === attempts - 1) console.debug("[ChatGPT Task Notifier] message failed", message.type, error);
      }
      if (attempt < attempts - 1) await delay(150 * (attempt + 1));
    }
    return null;
  }
})();
