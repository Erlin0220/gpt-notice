(() => {
  if (window.__CHATGPT_TASK_NOTIFIER_LOADED__) return;
  window.__CHATGPT_TASK_NOTIFIER_LOADED__ = true;

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
    navigationCandidateTimer: null
  };

  globalThis.ChatGPTTaskNotifierBridge = {
    getTaskState() {
      return {
        taskId: state.taskId,
        running: state.running,
        status: state.remoteStatus,
        startedAt: state.startedAt
      };
    }
  };

  boot().catch((error) => console.warn("[ChatGPT Task Notifier] boot failed", error));

  async function boot() {
    state.lastUserCount = getUserMessages().length;
    const assistant = getLatestAssistant();
    state.lastAssistantText = assistant.text;
    state.lastAssistantHasCopyAction = assistant.hasCopyAction;
    state.latestAssistantHash = assistant.hash;
    state.lastSettledAssistantHash = assistant.hash;

    await bindCurrentPage();
    installSubmissionListeners();
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (message?.type !== "PROBE_TASK_STATE") return false;
      sendResponse({ ok: true, ...buildProbe() });
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

  async function bindCurrentPage() {
    const response = await sendWithRetry({ type: "PAGE_READY", url: location.href }, 2);
    if (response?.task && ["running", "waiting_action"].includes(response.task.status)) {
      attachExistingTask(response.task);
    }
  }

  function attachExistingTask(task) {
    const assistant = getLatestAssistant();
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
      const button = event.target.closest?.("button");
      if (!button || button.disabled || button.getAttribute?.("aria-disabled") === "true" || !looksLikeSendButton(button)) return;
      rememberPendingSubmission();
    }, true);

    document.addEventListener("keydown", (event) => {
      if (event.key !== "Enter" || event.shiftKey || event.isComposing || event.defaultPrevented) return;
      if (!isComposerElement(event.target)) return;
      rememberPendingSubmission();
    }, true);

    document.addEventListener("submit", (event) => {
      if (event.defaultPrevented) return;
      if (event.target?.querySelector?.("#prompt-textarea, textarea, [contenteditable='true']")) rememberPendingSubmission();
    }, true);
  }

  function rememberPendingSubmission() {
    const prompt = getComposerText();
    if (!prompt) return;
    const assistant = getLatestAssistant();
    const latestUserText = getLatestUserText();
    state.pendingBaselineUserCount = getUserMessages().length;
    state.pendingBaselineUserHash = hashText(latestUserText);
    state.pendingPrompt = prompt;
    state.pendingBaselineHash = assistant.hash || state.lastSettledAssistantHash || "";
    state.pendingBaselineCopyActionCount = getCopyTurnActionCount();
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
      const assistant = getLatestAssistant();
      if (assistant.text !== state.lastAssistantText || assistant.hasCopyAction !== state.lastAssistantHasCopyAction) {
        state.lastAssistantText = assistant.text;
        state.lastAssistantHasCopyAction = assistant.hasCopyAction;
        state.latestAssistantHash = assistant.hash;
        state.latestAssistantChangedAt = now;
        state.lastContentChangeAt = now;
      }
      const snapshot = collectSnapshot(now, assistant);
      const userCount = getUserMessages().length;
      if (state.restoredAt && snapshot.domRunning) state.restoredObservedRunning = true;

      const recentSubmission = Boolean(state.pendingAt && now - state.pendingAt <= PENDING_SUBMISSION_MS);
      const latestUserText = getLatestUserText();
      const latestUserHash = hashText(latestUserText);
      const userMessageConfirmed = userCount > state.pendingBaselineUserCount || Boolean(
        latestUserHash &&
        latestUserHash !== state.pendingBaselineUserHash &&
        samePromptText(latestUserText, state.pendingPrompt)
      );
      if (recentSubmission && userMessageConfirmed) state.pendingConfirmed = true;
      if (!recentSubmission && !state.running) clearPendingSubmission();

      if (!state.running && state.pendingConfirmed && now >= state.nextStartAttemptAt) {
        await startTask({
          prompt: getLatestUserText() || state.pendingPrompt,
          baselineHash: state.pendingBaselineHash || state.lastSettledAssistantHash
        });
      }
      state.lastUserCount = userCount;

      if (!state.running) {
        if (assistant.hash) state.lastSettledAssistantHash = assistant.hash;
        return;
      }

      if (snapshot.stopVisible && state.remoteStatus !== "running") await reportStatus("running", assistant);
      if (snapshot.waitingAction && !snapshot.stopVisible) {
        await reportStatus("waiting_action", assistant);
        return;
      }
      if (snapshot.visibleError && !snapshot.stopVisible) {
        if (await reportStatus("failed", assistant)) finishLocalTask();
        return;
      }
      if (snapshot.completed) {
        if (await reportStatus("completed", assistant)) {
          state.lastSettledAssistantHash = assistant.hash;
          finishLocalTask();
        }
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
        const response = await sendWithRetry({
          type: "PAGE_PROMOTED",
          taskId: state.taskId,
          url: currentUrl,
          previousUrl
        }, 3);
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
      state.lastUserCount = getUserMessages().length;
      const assistant = getLatestAssistant();
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

  function collectSnapshot(now = Date.now(), assistant = getLatestAssistant()) {
    const stopVisible = hasStopControl();
    const waitingAction = hasApprovalControl();
    const visibleError = findVisibleError();
    const busy = hasBusyIndicator();
    const domRunning = stopVisible || waitingAction || busy;
    const responseChanged = Boolean(assistant.hash && assistant.hash !== state.baselineAssistantHash && assistant.text.trim());
    const copyActionCount = getCopyTurnActionCount();
    const copyActionAdvanced = Boolean(
      responseChanged && assistant.hasCopyAction && copyActionCount >= state.baselineCopyActionCount
    );
    const copyActionStable = copyActionAdvanced && now - state.latestAssistantChangedAt >= COPY_ACTION_STABLE_MS;
    const textStable = responseChanged && now - state.latestAssistantChangedAt >= COMPLETION_STABLE_MS;
    const ranLongEnough = !state.startedAt || now - state.startedAt >= 1_800;
    const composerReady = isComposerReady();
    const recoveryReady = !state.restoredAt || state.restoredObservedRunning || assistant.hash !== state.restoredAssistantHash || now - state.restoredAt >= RECOVERY_IDLE_GRACE_MS;
    const completed = Boolean(
      state.running && !domRunning && !visibleError && ranLongEnough && composerReady && recoveryReady && (copyActionStable || textStable)
    );
    return { assistant, stopVisible, waitingAction, visibleError, busy, domRunning, composerReady, copyActionCount, copyActionAdvanced, completed };
  }

  function buildProbe() {
    const snapshot = collectSnapshot();
    return {
      taskId: state.taskId,
      url: location.href,
      pageReady: document.readyState === "interactive" || document.readyState === "complete",
      stopVisible: snapshot.stopVisible,
      waitingAction: snapshot.waitingAction,
      visibleError: snapshot.visibleError,
      busy: snapshot.busy,
      composerReady: snapshot.composerReady,
      completed: snapshot.completed,
      latestAssistantHash: snapshot.assistant.hash,
      assistantFirstLine: snapshot.assistant.firstLine,
      thinkingTimeText: snapshot.assistant.thinkingTimeText,
      checkedAt: Date.now()
    };
  }

  async function startTask({ prompt, baselineHash }) {
    if (state.running || state.startInFlight || !state.pendingConfirmed) return false;
    state.startInFlight = true;
    try {
      const startedAt = Date.now();
      const resolvedPrompt = prompt || getLatestUserText() || state.pendingPrompt || "ChatGPT 任务";
      const response = await sendWithRetry({
        type: "TASK_STARTED",
        taskId: state.taskId,
        url: location.href,
        questionTitle: getQuestionTitle(resolvedPrompt),
        prompt: cleanText(resolvedPrompt, 240),
        baselineAssistantHash: baselineHash || state.lastSettledAssistantHash || "",
        baselineCopyActionCount: state.pendingBaselineCopyActionCount,
        latestAssistantHash: getLatestAssistant().hash
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
      return true;
    } finally {
      state.startInFlight = false;
    }
  }

  async function reportStatus(status, assistant = getLatestAssistant(), extra = {}) {
    if (!state.taskId) return false;
    if (state.lastReportedStatus === status) {
      state.remoteStatus = status;
      return true;
    }
    if (state.reportInFlight) return false;
    state.reportInFlight = true;
    try {
      const response = await sendWithRetry({
        type: "TASK_STATE",
        taskId: state.taskId,
        status,
        url: location.href,
        prompt: getLatestUserText(),
        questionTitle: getQuestionTitle(getLatestUserText()),
        assistantFirstLine: assistant.firstLine || "",
        thinkingTimeText: assistant.thinkingTimeText || (status === "completed" ? formatThinkingTime(Date.now() - state.startedAt) : ""),
        latestAssistantHash: assistant.hash,
        lastContentChangeAt: state.lastContentChangeAt,
        ...extra
      }, 3);
      if (!response?.ok) return false;
      state.lastReportedStatus = status;
      state.remoteStatus = status;
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
    state.baselineCopyActionCount = getCopyTurnActionCount();
    state.restoredAt = 0;
    state.restoredAssistantHash = "";
    state.restoredObservedRunning = false;
    clearPendingSubmission();
  }

  async function sendHeartbeat() {
    if (!state.taskId || !state.running) return;
    const response = await sendWithRetry({
      type: "HEARTBEAT",
      taskId: state.taskId,
      url: location.href,
      latestAssistantHash: getLatestAssistant().hash
    }, 2);
    if (response?.task?.status) state.remoteStatus = response.task.status;
  }

  function getLatestAssistant() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')].filter(isVisibleOrHasContent);
    const node = nodes.at(-1);
    const rawText = String(node?.innerText || node?.textContent || "");
    const text = cleanText(rawText, 50_000);
    return {
      node,
      text,
      hash: text ? hashText(text) : "",
      hasCopyAction: hasCopyTurnAction(node),
      firstLine: getAssistantFirstLine(node, rawText),
      thinkingTimeText: getThinkingTimeText(node)
    };
  }

  function getCopyTurnActionCount() {
    return document.querySelectorAll('button[data-testid="copy-turn-action-button"]').length;
  }

  function hasCopyTurnAction(node) {
    if (!node) return false;
    const turn = node.closest?.('[data-testid^="conversation-turn-"], article');
    if (turn?.querySelector?.('button[data-testid="copy-turn-action-button"]')) return true;
    let parent = node.parentElement;
    for (let depth = 0; parent && depth < 3; depth += 1, parent = parent.parentElement) {
      if (parent.querySelector?.('button[data-testid="copy-turn-action-button"]')) return true;
    }
    return false;
  }

  function getUserMessages() { return [...document.querySelectorAll('[data-message-author-role="user"]')]; }
  function getLatestUserText() {
    const node = getUserMessages().at(-1);
    return cleanText(node?.innerText || node?.textContent || "ChatGPT 任务", 240);
  }
  function getComposerText() {
    const composer = findComposer();
    return composer ? cleanText(composer.value || composer.innerText || composer.textContent || "", 240) : "";
  }
  function findComposer() {
    return document.querySelector("#prompt-textarea") || document.querySelector("textarea[placeholder]") || document.querySelector('[contenteditable="true"][data-virtualkeyboard]') || document.querySelector('main [contenteditable="true"]');
  }
  function isComposerElement(target) {
    return target instanceof Element && Boolean(target.matches?.('#prompt-textarea, textarea, [contenteditable="true"]') || target.closest?.('#prompt-textarea, textarea, [contenteditable="true"]'));
  }
  function isComposerReady() {
    const composer = findComposer();
    return Boolean(composer && isVisible(composer) && composer.getAttribute("aria-disabled") !== "true" && !composer.disabled);
  }
  function looksLikeSendButton(button) {
    const id = (button.id || button.getAttribute("id") || "").toLowerCase();
    const testId = (button.getAttribute("data-testid") || "").toLowerCase();
    const label = combinedText(button).toLowerCase();
    return id === "composer-submit-button" || testId.includes("send-button") || testId.includes("composer-submit") || /^(send|发送|傳送|提交)$/.test(label) || label.includes("send message") || label.includes("发送消息");
  }
  function hasStopControl() {
    const selectors = ['button[data-testid*="stop"]', 'button[aria-label*="Stop"]', 'button[aria-label*="stop"]', 'button[aria-label*="停止"]', 'button[aria-label*="中止"]', 'button[aria-label*="取消生成"]'];
    if (selectors.some((selector) => [...document.querySelectorAll(selector)].some(isVisible))) return true;
    return getRelevantButtons().some((button) => ["stop generating", "stop responding", "停止生成", "停止响应", "中止生成", "取消生成"].some((keyword) => combinedText(button).toLowerCase().includes(keyword)));
  }
  function hasApprovalControl() {
    const labels = new Set(["allow", "approve", "confirm", "continue", "run", "allow once", "always allow", "允许", "批准", "确认", "继续", "运行", "允许一次", "始终允许"]);
    return getRelevantButtons().some((button) => labels.has(combinedText(button).toLowerCase()));
  }
  function findVisibleError() {
    const words = ["something went wrong", "there was an error generating a response", "network error", "conversation not found", "出现错误", "发生错误", "网络错误", "生成回复时出错", "找不到对话"];
    return [...document.querySelectorAll('[role="alert"], main [data-testid*="error"], main .text-red-500')].filter(isVisible).some((node) => {
      const text = cleanText(node.innerText || node.textContent || "", 500).toLowerCase();
      return words.some((word) => text.includes(word));
    });
  }
  function hasBusyIndicator() {
    const words = ["working", "thinking", "searching", "running", "generating", "正在处理", "正在思考", "正在搜索", "正在运行", "正在生成"];
    return [...document.querySelectorAll('main [aria-live="polite"], main [role="status"], main [data-state="loading"]')].filter(isVisible).some((node) => {
      const text = cleanText(node.innerText || node.textContent || "", 200).toLowerCase();
      return words.some((word) => text.includes(word));
    });
  }
  function getRelevantButtons() { return [...document.querySelectorAll("main button")].filter(isVisible); }
  function combinedText(element) { return cleanText(`${element.getAttribute("aria-label") || ""} ${element.innerText || ""} ${element.title || ""}`, 120); }
  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) return false;
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }
  function isVisibleOrHasContent(element) { return Boolean(element && (isVisible(element) || element.textContent?.trim())); }
  function getPageKey(value) {
    try {
      const url = new URL(value, location.origin);
      const conversationId = getConversationId(url.href);
      if (conversationId) return `${url.origin}/c/${conversationId}`;
      return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}`;
    } catch {
      return String(value || "");
    }
  }
  function getConversationId(value) {
    try {
      return new URL(value, location.origin).pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1] || "";
    } catch {
      return "";
    }
  }
  function isDraftChatUrl(value) {
    try {
      const pathname = new URL(value, location.origin).pathname.replace(/\/+$/, "") || "/";
      return !getConversationId(value) && (pathname === "/" || /(?:^|\/)g\/g-p-[^/]+\/project$/.test(pathname));
    } catch {
      return false;
    }
  }
  function isConversationPromotion(previousUrl, currentUrl, now = Date.now()) {
    const recentSubmission = Boolean(state.pendingAt && now - state.pendingAt <= URL_PROMOTION_WINDOW_MS);
    return isDraftChatUrl(previousUrl) && Boolean(getConversationId(currentUrl)) && (state.running || recentSubmission);
  }
  function isAmbiguousConversationTransition(previousUrl, currentUrl) {
    const previousId = getConversationId(previousUrl);
    const currentId = getConversationId(currentUrl);
    return Boolean(previousId) !== Boolean(currentId);
  }
  function getQuestionTitle(value) {
    const raw = String(value || "").replace(/\r/g, "").trim();
    let title = raw.split(/\n+/).map((line) => line.trim()).find(Boolean) || "ChatGPT 任务";
    const indexes = ["。", "！", "？", "!", "?"].map((mark) => title.indexOf(mark)).filter((index) => index >= 6);
    if (indexes.length) title = title.slice(0, Math.min(...indexes) + 1);
    return cleanText(title.replace(/^#+\s*/, ""), 80) || "ChatGPT 任务";
  }
  function getAssistantFirstLine(node, rawText) {
    const roots = [node?.querySelector?.("[data-message-content]"), node?.querySelector?.(".markdown"), node?.querySelector?.('[class*="prose"]'), node].filter(Boolean);
    for (const root of roots) {
      const blocks = root.matches?.("h1,h2,h3,h4,p,li,blockquote,pre") ? [root] : [...(root.querySelectorAll?.("h1,h2,h3,h4,p,li,blockquote,pre") || [])];
      for (const block of blocks) {
        const line = String(block.innerText || block.textContent || "").split(/\n+/).map((item) => item.trim()).find((item) => item && !isAssistantUiLine(item));
        if (line) return cleanText(line, 240);
      }
    }
    const fallback = String(rawText || "").split(/\n+/).map((line) => line.trim()).find((line) => line && !isAssistantUiLine(line));
    return cleanText(fallback || "", 240);
  }
  function isAssistantUiLine(line) {
    const normalized = cleanText(line, 160).toLowerCase();
    return /^(思考了\s*\d|thought for\s*\d|复制$|copy$|分享$|share$|重新生成$|regenerate$|good response$|bad response$)/i.test(normalized);
  }
  function getThinkingTimeText(node) {
    const turn = node?.closest?.('[data-testid^="conversation-turn-"]') || node?.closest?.("article") || node?.parentElement;
    const text = String(turn?.innerText || node?.innerText || node?.textContent || "");
    const match = text.match(/(?:思考了|thought for)\s*((?:\d+\s*(?:h|小时|hours?|hrs?)\s*)?(?:\d+\s*(?:m|分钟|minutes?|mins?)\s*)?(?:\d+\s*(?:s|秒|seconds?|secs?))?)/i);
    if (!match?.[1] || !/\d/.test(match[1])) return "";
    const duration = match[1];
    const hours = Number(duration.match(/(\d+)\s*(?:h|小时|hours?|hrs?)/i)?.[1] || 0);
    const minutes = Number(duration.match(/(\d+)\s*(?:m|分钟|minutes?|mins?)/i)?.[1] || 0);
    const seconds = Number(duration.match(/(\d+)\s*(?:s|秒|seconds?|secs?)/i)?.[1] || 0);
    const totalMinutes = hours * 60 + minutes;
    const parts = [];
    if (totalMinutes) parts.push(`${totalMinutes}m`);
    if (seconds || !totalMinutes) parts.push(`${seconds}s`);
    return `思考了 ${parts.join(" ")}`;
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
  function cleanText(value, maxLength) { return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength); }
  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) { hash ^= text.charCodeAt(index); hash = Math.imul(hash, 16777619); }
    return (hash >>> 0).toString(36);
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
