(() => {
  if (window.__CHATGPT_TASK_NOTIFIER_LOADED__) return;
  window.__CHATGPT_TASK_NOTIFIER_LOADED__ = true;

  const COMPLETION_STABLE_MS = 4000;
  const INSPECT_INTERVAL_MS = 800;
  const HEARTBEAT_INTERVAL_MS = 5000;
  const PENDING_SUBMISSION_MS = 10000;
  const MONITOR_REFRESH_MS = 15000;
  const MONITOR_REFRESH_KEY = "chatgpt-task-notifier:last-monitor-refresh";

  const state = {
    taskId: null,
    running: false,
    isMonitor: false,
    remoteStatus: null,
    baselineAssistantHash: "",
    latestAssistantHash: "",
    latestAssistantChangedAt: Date.now(),
    lastAssistantText: "",
    lastSettledAssistantHash: "",
    lastUserCount: 0,
    pendingPrompt: "",
    pendingBaselineHash: "",
    pendingAt: 0,
    startedAt: 0,
    lastUrl: location.href,
    lastReportedStatus: null,
    inspectionScheduled: false
  };

  boot().catch((error) => console.debug("[ChatGPT Task Notifier] boot failed", error));

  async function boot() {
    state.lastUserCount = getUserMessages().length;
    const assistant = getLatestAssistant();
    state.lastAssistantText = assistant.text;
    state.latestAssistantHash = assistant.hash;
    state.lastSettledAssistantHash = assistant.hash;

    const response = await safeSend({
      type: "PAGE_READY",
      url: location.href
    });

    if (response?.task && ["running", "waiting_action"].includes(response.task.status)) {
      attachExistingTask(response.task);
    }

    installSubmissionListeners();
    const observer = new MutationObserver(scheduleInspect);
    observer.observe(document.documentElement, {
      childList: true,
      subtree: true,
      characterData: true,
      attributes: true,
      attributeFilter: ["aria-label", "aria-hidden", "disabled", "data-testid"]
    });

    setInterval(inspect, INSPECT_INTERVAL_MS);
    setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS);
    inspect();
  }

  function attachExistingTask(task) {
    state.taskId = task.id;
    state.running = true;
    state.isMonitor = Boolean(task.isMonitor);
    state.remoteStatus = task.status;
    state.baselineAssistantHash = task.baselineAssistantHash || "";
    state.startedAt = task.startedAt || Date.now();
    state.lastReportedStatus = task.status;
    state.latestAssistantChangedAt = Date.now();
  }

  function installSubmissionListeners() {
    document.addEventListener(
      "click",
      (event) => {
        const button = event.target.closest?.("button");
        if (!button || button.disabled || !looksLikeSendButton(button)) return;
        rememberPendingSubmission();
      },
      true
    );

    document.addEventListener(
      "keydown",
      (event) => {
        if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
        const target = event.target;
        if (!isComposerElement(target)) return;
        rememberPendingSubmission();
      },
      true
    );
  }

  function rememberPendingSubmission() {
    const assistant = getLatestAssistant();
    state.pendingPrompt = getComposerText() || getLatestUserText() || "ChatGPT 任务";
    state.pendingBaselineHash = assistant.hash || state.lastSettledAssistantHash || "";
    state.pendingAt = Date.now();

    void startTask({
      prompt: state.pendingPrompt,
      baselineHash: state.pendingBaselineHash
    });
    setTimeout(inspect, 150);
  }

  function scheduleInspect() {
    if (state.inspectionScheduled) return;
    state.inspectionScheduled = true;
    setTimeout(() => {
      state.inspectionScheduled = false;
      inspect();
    }, 120);
  }

  async function inspect() {
    const now = Date.now();
    const assistant = getLatestAssistant();
    const userMessages = getUserMessages();
    const userCount = userMessages.length;
    const stopVisible = hasStopControl();
    const waitingAction = hasApprovalControl();
    const visibleError = findVisibleError();
    const changedUrl = location.href !== state.lastUrl;

    if (changedUrl) state.lastUrl = location.href;

    if (assistant.text !== state.lastAssistantText) {
      state.lastAssistantText = assistant.text;
      state.latestAssistantHash = assistant.hash;
      state.latestAssistantChangedAt = now;
    }

    const hasRecentSubmission = state.pendingAt && now - state.pendingAt <= PENDING_SUBMISSION_MS;
    if (userCount > state.lastUserCount && !state.running && hasRecentSubmission) {
      const latestPrompt = getLatestUserText();
      await startTask({
        prompt: latestPrompt || state.pendingPrompt,
        baselineHash: state.pendingBaselineHash || state.lastSettledAssistantHash
      });
    }
    state.lastUserCount = userCount;

    if (stopVisible && !state.running) {
      await startTask({
        prompt: state.pendingPrompt || getLatestUserText(),
        baselineHash: state.pendingBaselineHash || state.lastSettledAssistantHash
      });
    }

    if (!state.running) {
      if (assistant.hash) state.lastSettledAssistantHash = assistant.hash;
      return;
    }

    if (stopVisible && state.remoteStatus !== "running") {
      await reportStatus("running", assistant.hash);
    }

    if (waitingAction && !stopVisible) {
      await reportStatus("waiting_action", assistant.hash);
      return;
    }

    if (visibleError && !stopVisible) {
      await reportStatus("failed", assistant.hash);
      finishLocalTask();
      return;
    }

    const responseChanged = Boolean(
      assistant.hash && assistant.hash !== state.baselineAssistantHash && assistant.text.trim()
    );
    const stableLongEnough = now - state.latestAssistantChangedAt >= COMPLETION_STABLE_MS;
    const ranLongEnough = now - state.startedAt >= 1800;
    const looksBusy = hasBusyIndicator();
    const composerReady = isComposerReady();

    if (
      !stopVisible &&
      !waitingAction &&
      !looksBusy &&
      responseChanged &&
      stableLongEnough &&
      ranLongEnough &&
      composerReady
    ) {
      await reportStatus("completed", assistant.hash, assistant);
      state.lastSettledAssistantHash = assistant.hash;
      finishLocalTask();
      return;
    }

    maybeRefreshMonitor(now);
  }

  async function startTask({ prompt, baselineHash }) {
    if (state.running) return;
    state.running = true;
    state.remoteStatus = "running";
    state.startedAt = Date.now();
    state.baselineAssistantHash = baselineHash || state.lastSettledAssistantHash || "";
    state.latestAssistantChangedAt = Date.now();
    state.lastReportedStatus = "running";

    const response = await safeSend({
      type: "TASK_STARTED",
      taskId: state.taskId,
      url: location.href,
      title: getQuestionTitle(prompt || getLatestUserText() || "ChatGPT 任务"),
      questionTitle: getQuestionTitle(prompt || getLatestUserText() || "ChatGPT 任务"),
      prompt: cleanText(prompt || getLatestUserText() || "ChatGPT 任务", 100),
      baselineAssistantHash: state.baselineAssistantHash,
      latestAssistantHash: getLatestAssistant().hash
    });

    if (response?.task?.id) {
      state.taskId = response.task.id;
      state.isMonitor = Boolean(response.task.isMonitor);
    }
  }

  async function reportStatus(status, latestAssistantHash, assistant = getLatestAssistant()) {
    if (!state.taskId || state.lastReportedStatus === status) {
      state.remoteStatus = status;
      return;
    }

    state.lastReportedStatus = status;
    state.remoteStatus = status;
    await safeSend({
      type: "TASK_STATE",
      taskId: state.taskId,
      status,
      url: location.href,
      prompt: getLatestUserText(),
      questionTitle: getQuestionTitle(getLatestUserText()),
      assistantFirstLine: assistant.firstLine || "",
      thinkingTimeText: assistant.thinkingTimeText || (status === "completed" ? formatThinkingTime(Date.now() - state.startedAt) : ""),
      latestAssistantHash
    });
  }

  function finishLocalTask() {
    state.running = false;
    state.remoteStatus = null;
    state.taskId = null;
    state.isMonitor = false;
    state.startedAt = 0;
    state.pendingPrompt = "";
    state.pendingBaselineHash = "";
    state.pendingAt = 0;
    state.lastReportedStatus = null;
    state.baselineAssistantHash = state.latestAssistantHash;
    sessionStorage.removeItem(MONITOR_REFRESH_KEY);
  }

  async function sendHeartbeat() {
    if (!state.taskId || !state.running) return;
    const response = await safeSend({
      type: "HEARTBEAT",
      taskId: state.taskId,
      url: location.href,
      latestAssistantHash: getLatestAssistant().hash
    });
    if (response?.task) state.isMonitor = Boolean(response.task.isMonitor);
  }

  function maybeRefreshMonitor(now) {
    if (!state.isMonitor || !state.running) return;
    if (now - state.startedAt < 8000) return;

    const lastRefresh = Number(sessionStorage.getItem(MONITOR_REFRESH_KEY) || 0);
    if (now - lastRefresh < MONITOR_REFRESH_MS) return;

    sessionStorage.setItem(MONITOR_REFRESH_KEY, String(now));
    setTimeout(() => location.reload(), 50);
  }

  function getLatestAssistant() {
    const nodes = [...document.querySelectorAll('[data-message-author-role="assistant"]')]
      .filter(isVisibleOrHasContent);
    const node = nodes.at(-1);
    const rawText = String(node?.innerText || node?.textContent || "");
    const text = cleanText(rawText, 20000);
    return {
      node,
      text,
      hash: text ? hashText(text) : "",
      firstLine: getAssistantFirstLine(node, rawText),
      thinkingTimeText: getThinkingTimeText(node)
    };
  }

  function getUserMessages() {
    return [...document.querySelectorAll('[data-message-author-role="user"]')];
  }

  function getLatestUserText() {
    const node = getUserMessages().at(-1);
    return cleanText(node?.innerText || node?.textContent || "ChatGPT 任务", 100);
  }

  function getComposerText() {
    const composer = findComposer();
    if (!composer) return "";
    return cleanText(composer.value || composer.innerText || composer.textContent || "", 100);
  }

  function findComposer() {
    return (
      document.querySelector('#prompt-textarea') ||
      document.querySelector('textarea[placeholder]') ||
      document.querySelector('[contenteditable="true"][data-virtualkeyboard]') ||
      document.querySelector('main [contenteditable="true"]')
    );
  }

  function isComposerElement(target) {
    if (!(target instanceof Element)) return false;
    return Boolean(
      target.matches?.('#prompt-textarea, textarea, [contenteditable="true"]') ||
      target.closest?.('#prompt-textarea, textarea, [contenteditable="true"]')
    );
  }

  function isComposerReady() {
    if (state.isMonitor) {
      return document.readyState === "interactive" || document.readyState === "complete";
    }
    const composer = findComposer();
    if (!composer || !isVisible(composer)) return false;
    return composer.getAttribute("aria-disabled") !== "true" && !composer.disabled;
  }

  function looksLikeSendButton(button) {
    const dataTestId = (button.getAttribute("data-testid") || "").toLowerCase();
    const label = combinedText(button).toLowerCase();
    return (
      dataTestId.includes("send-button") ||
      /^(send|发送|傳送|提交)$/.test(label) ||
      label.includes("send message") ||
      label.includes("发送消息")
    );
  }

  function hasStopControl() {
    const selectors = [
      'button[data-testid*="stop"]',
      'button[aria-label*="Stop"]',
      'button[aria-label*="stop"]',
      'button[aria-label*="停止"]',
      'button[aria-label*="中止"]',
      'button[aria-label*="取消生成"]'
    ];
    if (selectors.some((selector) => [...document.querySelectorAll(selector)].some(isRelevantElement))) {
      return true;
    }

    return getRelevantButtons().some((button) => {
      const text = combinedText(button).toLowerCase();
      return [
        "stop generating",
        "stop responding",
        "停止生成",
        "停止响应",
        "中止生成",
        "取消生成"
      ].some((keyword) => text.includes(keyword));
    });
  }

  function hasApprovalControl() {
    const exactLabels = new Set([
      "allow",
      "approve",
      "confirm",
      "continue",
      "run",
      "allow once",
      "always allow",
      "允许",
      "批准",
      "确认",
      "继续",
      "运行",
      "允许一次",
      "始终允许"
    ]);

    return getRelevantButtons().some((button) => {
      const label = combinedText(button).toLowerCase();
      if (!exactLabels.has(label)) return false;
      return Boolean(button.closest("main"));
    });
  }

  function findVisibleError() {
    const errorWords = [
      "something went wrong",
      "there was an error generating a response",
      "network error",
      "conversation not found",
      "出现错误",
      "发生错误",
      "网络错误",
      "生成回复时出错",
      "找不到对话"
    ];

    const candidates = [
      ...document.querySelectorAll('[role="alert"], main [data-testid*="error"], main .text-red-500')
    ].filter(isRelevantElement);

    return candidates.some((node) => {
      const text = cleanText(node.innerText || node.textContent || "", 500).toLowerCase();
      return errorWords.some((word) => text.includes(word));
    });
  }

  function hasBusyIndicator() {
    const busyWords = [
      "working",
      "thinking",
      "searching",
      "running",
      "generating",
      "正在处理",
      "正在思考",
      "正在搜索",
      "正在运行",
      "正在生成"
    ];

    const nodes = [
      ...document.querySelectorAll('main [aria-live="polite"], main [role="status"], main [data-state="loading"]')
    ].filter(isRelevantElement);

    return nodes.some((node) => {
      const text = cleanText(node.innerText || node.textContent || "", 200).toLowerCase();
      return busyWords.some((word) => text.includes(word));
    });
  }

  function getRelevantButtons() {
    return [...document.querySelectorAll("main button")].filter(isRelevantElement);
  }

  function combinedText(element) {
    return cleanText(
      `${element.getAttribute("aria-label") || ""} ${element.innerText || ""} ${element.title || ""}`,
      120
    );
  }

  function isRelevantElement(element) {
    if (!state.isMonitor) return isVisible(element);
    if (!(element instanceof Element)) return false;
    if (element.hidden || element.getAttribute("aria-hidden") === "true") return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") return false;
    return Boolean(combinedText(element) || element.textContent?.trim() || element.getAttribute("data-testid"));
  }

  function isVisible(element) {
    if (!(element instanceof Element)) return false;
    const style = getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0) {
      return false;
    }
    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function isVisibleOrHasContent(element) {
    return Boolean(element && (isVisible(element) || element.textContent?.trim()));
  }

  function getQuestionTitle(value) {
  const raw = String(value || "").replace(/\r/g, "").trim();
  let title = raw.split(/\n+/).map((line) => line.trim()).find(Boolean) || "ChatGPT 任务";
  const punctuationIndexes = ["。", "！", "？", "!", "?"]
    .map((mark) => title.indexOf(mark))
    .filter((index) => index >= 6);
  if (punctuationIndexes.length) {
    title = title.slice(0, Math.min(...punctuationIndexes) + 1);
  }
  return cleanText(title.replace(/^#+\s*/, ""), 80) || "ChatGPT 任务";
}

function getAssistantFirstLine(node, rawText) {
  const roots = [
    node?.querySelector?.('[data-message-content]'),
    node?.querySelector?.('.markdown'),
    node?.querySelector?.('[class*="prose"]'),
    node
  ].filter(Boolean);

  for (const root of roots) {
    const blocks = root.matches?.("h1,h2,h3,h4,p,li,blockquote,pre")
      ? [root]
      : [...root.querySelectorAll?.("h1,h2,h3,h4,p,li,blockquote,pre") || []];
    for (const block of blocks) {
      const lines = String(block.innerText || block.textContent || "").split(/\n+/);
      const line = lines.map((item) => item.trim()).find((item) => item && !isAssistantUiLine(item));
      if (line) return cleanText(line, 240);
    }
  }

  const fallback = String(rawText || "")
    .split(/\n+/)
    .map((line) => line.trim())
    .find((line) => line && !isAssistantUiLine(line));
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

  function cleanText(value, maxLength) {
    return String(value || "")
      .replace(/\s+/g, " ")
      .trim()
      .slice(0, maxLength);
  }

  function hashText(text) {
    let hash = 2166136261;
    for (let index = 0; index < text.length; index += 1) {
      hash ^= text.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  async function safeSend(message) {
    try {
      return await chrome.runtime.sendMessage(message);
    } catch {
      return null;
    }
  }
})();
