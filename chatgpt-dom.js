(function attachChatGPTPageAdapter(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTPageAdapter = api;
  root.ChatGPTDomAdapter = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createChatGPTPageAdapter() {
  const PAGE_SNAPSHOT_SCHEMA_VERSION = 1;
  const INITIALIZING_GRACE_MS = 3_000;
  const MAX_PUBLIC_ERROR_LENGTH = 160;
  const CHAT_HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);

  const COMPOSER_SELECTORS = [
    "#prompt-textarea",
    "textarea[placeholder]",
    '[contenteditable="true"][data-virtualkeyboard]',
    'main [contenteditable="true"]'
  ];
  const SEND_SELECTORS = [
    "#composer-submit-button",
    'button[data-testid*="send-button"]',
    'button[data-testid*="composer-submit"]'
  ];
  const STOP_SELECTORS = [
    'button[data-testid*="stop"]',
    'button[aria-label*="Stop"]',
    'button[aria-label*="stop"]',
    'button[aria-label*="停止"]',
    'button[aria-label*="中止"]',
    'button[aria-label*="取消生成"]'
  ];
  const APPROVAL_LABELS = new Set([
    "allow", "approve", "confirm", "continue", "run", "allow once", "always allow",
    "允许", "批准", "确认", "继续", "运行", "允许一次", "始终允许"
  ]);
  const BUSY_WORDS = [
    "working", "thinking", "searching", "running", "generating",
    "正在处理", "正在思考", "正在搜索", "正在运行", "正在生成"
  ];
  const ERROR_WORDS = [
    "something went wrong", "there was an error generating a response", "network error",
    "conversation not found", "出现错误", "发生错误", "网络错误", "生成回复时出错", "找不到对话"
  ];

  function queryAll(documentRef, selector) {
    if (!documentRef || typeof documentRef.querySelectorAll !== "function") return [];
    try { return [...documentRef.querySelectorAll(selector)]; } catch { return []; }
  }

  function cleanText(value, maxLength = 50_000) {
    return String(value || "").replace(/\s+/g, " ").trim().slice(0, maxLength);
  }

  function hashText(text) {
    const value = String(text || "");
    let hash = 2166136261;
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index);
      hash = Math.imul(hash, 16777619);
    }
    return (hash >>> 0).toString(36);
  }

  function isComposerEnabled(node) {
    return Boolean(
      node &&
      node.disabled !== true &&
      node.getAttribute?.("aria-disabled") !== "true" &&
      node.getAttribute?.("aria-hidden") !== "true"
    );
  }

  function isElementVisible(node, root = globalThis) {
    if (!node) return false;
    const style = typeof root?.getComputedStyle === "function" ? root.getComputedStyle(node) : null;
    if (style && (style.display === "none" || style.visibility === "hidden" || Number(style.opacity) === 0)) return false;
    const rect = typeof node.getBoundingClientRect === "function" ? node.getBoundingClientRect() : null;
    return !rect || (rect.width > 0 && rect.height > 0);
  }

  function collectComposerCandidates(documentRef) {
    const seen = new Set();
    const candidates = [];
    for (const selector of COMPOSER_SELECTORS) {
      for (const node of queryAll(documentRef, selector)) {
        if (!node || seen.has(node)) continue;
        seen.add(node);
        candidates.push(node);
      }
    }
    return candidates;
  }

  function findActiveComposer(documentRef, isVisible = () => true) {
    const candidates = collectComposerCandidates(documentRef);
    if (!candidates.length) return null;
    const activeElement = documentRef?.activeElement;
    const focused = candidates.find((node) =>
      node === activeElement || (typeof node.contains === "function" && node.contains(activeElement))
    );
    if (focused && isComposerEnabled(focused) && isVisible(focused)) return focused;
    const visibleEnabled = candidates.filter((node) => isComposerEnabled(node) && isVisible(node));
    if (visibleEnabled.length) return visibleEnabled.at(-1);
    const visible = candidates.filter((node) => isVisible(node));
    if (visible.length) return visible.at(-1);
    return null;
  }

  function combinedText(element) {
    return cleanText(`${element?.getAttribute?.("aria-label") || ""} ${element?.innerText || ""} ${element?.title || ""}`, 120);
  }

  function looksLikeSendButton(button) {
    if (!button) return false;
    const id = String(button.id || button.getAttribute?.("id") || "").toLowerCase();
    const testId = String(button.getAttribute?.("data-testid") || "").toLowerCase();
    const label = combinedText(button).toLowerCase();
    return id === "composer-submit-button" ||
      testId.includes("send-button") ||
      testId.includes("composer-submit") ||
      /^(send|发送|傳送|提交)$/.test(label) ||
      label.includes("send message") ||
      label.includes("发送消息");
  }

  function isSendButtonEnabled(button) {
    return Boolean(button && button.disabled !== true && button.getAttribute?.("aria-disabled") !== "true");
  }

  function findSendButton(documentRef, root = globalThis) {
    for (const selector of SEND_SELECTORS) {
      const visible = queryAll(documentRef, selector).find((node) => isElementVisible(node, root));
      if (visible) return visible;
    }
    return queryAll(documentRef, "main button").find((node) => isElementVisible(node, root) && looksLikeSendButton(node)) || null;
  }

  function hasStopControl(documentRef, root = globalThis) {
    if (STOP_SELECTORS.some((selector) => queryAll(documentRef, selector).some((node) => isElementVisible(node, root)))) return true;
    const words = ["stop generating", "stop responding", "停止生成", "停止响应", "中止生成", "取消生成"];
    return queryAll(documentRef, "main button")
      .filter((node) => isElementVisible(node, root))
      .some((node) => words.some((word) => combinedText(node).toLowerCase().includes(word)));
  }

  function hasApprovalControl(documentRef, root = globalThis) {
    return queryAll(documentRef, "main button")
      .filter((node) => isElementVisible(node, root))
      .some((node) => APPROVAL_LABELS.has(combinedText(node).toLowerCase()));
  }

  function hasBusyIndicator(documentRef, root = globalThis) {
    return queryAll(documentRef, 'main [aria-live="polite"], main [role="status"], main [data-state="loading"]')
      .filter((node) => isElementVisible(node, root))
      .some((node) => {
        const text = cleanText(node.innerText || node.textContent || "", 200).toLowerCase();
        return BUSY_WORDS.some((word) => text.includes(word));
      });
  }

  function findVisibleError(documentRef, root = globalThis) {
    const found = queryAll(documentRef, '[role="alert"], main [data-testid*="error"], main .text-red-500')
      .filter((node) => isElementVisible(node, root))
      .map((node) => cleanText(node.innerText || node.textContent || "", 500))
      .find((text) => ERROR_WORDS.some((word) => text.toLowerCase().includes(word)));
    return found ? cleanText(found, MAX_PUBLIC_ERROR_LENGTH) : "";
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

  function isVisibleOrHasContent(node, root = globalThis) {
    return Boolean(node && (isElementVisible(node, root) || node.textContent?.trim()));
  }

  function getAssistantFirstLine(node, rawText) {
    const roots = [
      node?.querySelector?.("[data-message-content]"),
      node?.querySelector?.(".markdown"),
      node?.querySelector?.('[class*="prose"]'),
      node
    ].filter(Boolean);
    for (const candidate of roots) {
      const blocks = candidate.matches?.("h1,h2,h3,h4,p,li,blockquote,pre")
        ? [candidate]
        : [...(candidate.querySelectorAll?.("h1,h2,h3,h4,p,li,blockquote,pre") || [])];
      for (const block of blocks) {
        const line = String(block.innerText || block.textContent || "")
          .split(/\n+/)
          .map((item) => item.trim())
          .find((item) => item && !isAssistantUiLine(item));
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

  function collectAssistant(documentRef, root = globalThis) {
    const nodes = queryAll(documentRef, '[data-message-author-role="assistant"]')
      .filter((node) => isVisibleOrHasContent(node, root));
    const node = nodes.at(-1) || null;
    const rawText = String(node?.innerText || node?.textContent || "");
    const text = cleanText(rawText, 50_000);
    return {
      node,
      text,
      hash: text ? hashText(text) : "",
      count: nodes.length,
      hasCopyAction: hasCopyTurnAction(node),
      firstLine: getAssistantFirstLine(node, rawText),
      thinkingTimeText: getThinkingTimeText(node)
    };
  }

  function collectUsers(documentRef) {
    const nodes = queryAll(documentRef, '[data-message-author-role="user"]');
    const node = nodes.at(-1) || null;
    return {
      nodes,
      count: nodes.length,
      latestText: cleanText(node?.innerText || node?.textContent || "", 240)
    };
  }

  function getConversationId(value, base = "https://chatgpt.com/") {
    try { return new URL(value || base, base).pathname.match(/(?:^|\/)c\/([^/?#]+)/)?.[1] || ""; }
    catch { return ""; }
  }

  function isProvisionalConversationId(value) {
    return /^WEB:/i.test(String(value || "").trim());
  }

  function classifyRoute(value, base = "https://chatgpt.com/") {
    try {
      const url = new URL(value || base, base);
      if (!CHAT_HOSTS.has(url.hostname)) return { supportStatus: "unsupported", routeType: "non_chatgpt", conversationId: "" };
      const pathname = url.pathname.replace(/\/+$/, "") || "/";
      const conversationId = getConversationId(url.href, base);
      if (conversationId) {
        return {
          supportStatus: "supported",
          routeType: isProvisionalConversationId(conversationId) ? "provisional_conversation" : "conversation",
          conversationId
        };
      }
      if (pathname === "/" || /(?:^|\/)g\/g-p-[^/]+\/project$/.test(pathname)) {
        return { supportStatus: "supported", routeType: "draft", conversationId: "" };
      }
      if (/^\/(auth|login|settings|share|gpts)(?:\/|$)/.test(pathname)) {
        return { supportStatus: "unsupported", routeType: "unsupported", conversationId: "" };
      }
      return { supportStatus: "unsupported", routeType: "unknown", conversationId: "" };
    } catch {
      return { supportStatus: "unsupported", routeType: "unknown", conversationId: "" };
    }
  }

  function composerText(node) {
    return String(node?.value ?? node?.innerText ?? node?.textContent ?? "");
  }

  function textLengthBucket(length) {
    const size = Math.max(0, Number(length || 0));
    if (!size) return "empty";
    if (size < 1_000) return "short";
    if (size < 10_000) return "medium";
    if (size < 100_000) return "long";
    return "very_long";
  }

  function evaluatePageFacts(facts, { now = Date.now(), documentStartedAt = now } = {}) {
    if (facts.supportStatus === "unsupported") {
      return {
        supportStatus: "unsupported",
        compatibility: "unsupported",
        reasonCodes: ["unsupported_route"],
        capabilities: emptyCapabilities()
      };
    }
    const initializing = !facts.pageReady || (!facts.composer.exists && now - documentStartedAt < INITIALIZING_GRACE_MS);
    if (initializing) {
      return {
        supportStatus: "initializing",
        compatibility: "initializing",
        reasonCodes: ["page_initializing"],
        capabilities: emptyCapabilities()
      };
    }

    const blocked = [];
    const degraded = [];
    if (!facts.composer.exists) blocked.push("composer_missing");
    if (facts.composer.ambiguous) blocked.push("multiple_visible_composers");
    if (facts.composer.exists && !facts.composer.ready && !facts.controls.stopVisible) degraded.push("composer_not_ready");
    if (!facts.controls.send.exists && facts.composer.exists && !facts.composer.empty) degraded.push("send_control_missing");
    if (facts.messages.assistantCount > 0 && !facts.messages.latestAssistantHasCopyAction) degraded.push("copy_action_missing");

    const compatibility = blocked.length ? "blocked" : degraded.length ? "degraded" : "healthy";
    const reasonCodes = blocked.length ? blocked : degraded;
    const supported = facts.supportStatus === "supported";
    const canWriteComposer = supported && facts.composer.ready && !facts.composer.ambiguous;
    const canClickSend = canWriteComposer && facts.controls.send.exists && facts.controls.send.enabled;
    const canTrackTask = supported && !facts.composer.ambiguous;
    const canDetectCompletion = canTrackTask && compatibility !== "blocked";
    const canAdmitQueue = supported && facts.composer.exists && !facts.composer.ambiguous;
    const canDispatchQueue = compatibility !== "blocked" && canWriteComposer;
    return {
      supportStatus: "supported",
      compatibility,
      reasonCodes,
      capabilities: {
        canTrackTask,
        canDetectCompletion,
        canAdmitQueue,
        canDispatchQueue,
        canWriteComposer,
        canClickSend
      }
    };
  }

  function emptyCapabilities() {
    return {
      canTrackTask: false,
      canDetectCompletion: false,
      canAdmitQueue: false,
      canDispatchQueue: false,
      canWriteComposer: false,
      canClickSend: false
    };
  }

  function collectPageState({
    documentRef = globalThis.document,
    locationRef = globalThis.location,
    root = globalThis,
    now = Date.now(),
    documentStartedAt = now
  } = {}) {
    const route = classifyRoute(locationRef?.href || "", locationRef?.origin || "https://chatgpt.com/");
    const candidates = collectComposerCandidates(documentRef);
    const visibleEnabled = candidates.filter((node) => isComposerEnabled(node) && isElementVisible(node, root));
    const activeElement = documentRef?.activeElement;
    const focusedVisible = visibleEnabled.some((node) => node === activeElement || node.contains?.(activeElement));
    const composer = findActiveComposer(documentRef, (node) => isElementVisible(node, root));
    const text = composerText(composer);
    const sendButton = findSendButton(documentRef, root);
    const assistant = collectAssistant(documentRef, root);
    const users = collectUsers(documentRef);
    const facts = {
      schemaVersion: PAGE_SNAPSHOT_SCHEMA_VERSION,
      observedAt: now,
      pageReady: ["interactive", "complete"].includes(String(documentRef?.readyState || "")),
      supportStatus: route.supportStatus,
      routeType: route.routeType,
      composer: {
        exists: Boolean(composer),
        ready: Boolean(composer && isComposerEnabled(composer) && isElementVisible(composer, root)),
        empty: !text.trim(),
        textLengthBucket: textLengthBucket(text.length),
        visibleCount: visibleEnabled.length,
        ambiguous: visibleEnabled.length > 1 && !focusedVisible
      },
      controls: {
        send: { exists: Boolean(sendButton), enabled: isSendButtonEnabled(sendButton) },
        stopVisible: hasStopControl(documentRef, root),
        waitingAction: hasApprovalControl(documentRef, root),
        busy: hasBusyIndicator(documentRef, root)
      },
      error: { visible: Boolean(findVisibleError(documentRef, root)) },
      messages: {
        userCount: users.count,
        assistantCount: assistant.count,
        latestAssistantHasCopyAction: assistant.hasCopyAction,
        copyActionCount: queryAll(documentRef, 'button[data-testid="copy-turn-action-button"]').length
      }
    };
    const evaluation = evaluatePageFacts(facts, { now, documentStartedAt });
    return {
      ...facts,
      ...evaluation,
      refs: {
        composer,
        sendButton,
        assistantNode: assistant.node
      },
      private: {
        composerText: text,
        latestUserText: users.latestText,
        assistantText: assistant.text,
        assistantHash: assistant.hash,
        assistantFirstLine: assistant.firstLine,
        thinkingTimeText: assistant.thinkingTimeText,
        visibleErrorText: findVisibleError(documentRef, root),
        conversationId: route.conversationId
      }
    };
  }

  function toPublicSnapshot(state) {
    if (!state || typeof state !== "object") return null;
    return {
      schemaVersion: PAGE_SNAPSHOT_SCHEMA_VERSION,
      observedAt: Number(state.observedAt || Date.now()),
      pageReady: Boolean(state.pageReady),
      supportStatus: String(state.supportStatus || "unsupported"),
      routeType: String(state.routeType || "unknown"),
      compatibility: String(state.compatibility || "unsupported"),
      reasonCodes: [...new Set((state.reasonCodes || []).map(String))],
      capabilities: { ...emptyCapabilities(), ...(state.capabilities || {}) },
      composer: {
        exists: Boolean(state.composer?.exists),
        ready: Boolean(state.composer?.ready),
        empty: Boolean(state.composer?.empty),
        textLengthBucket: String(state.composer?.textLengthBucket || "empty"),
        visibleCount: Math.max(0, Number(state.composer?.visibleCount || 0)),
        ambiguous: Boolean(state.composer?.ambiguous)
      },
      controls: {
        send: {
          exists: Boolean(state.controls?.send?.exists),
          enabled: Boolean(state.controls?.send?.enabled)
        },
        stopVisible: Boolean(state.controls?.stopVisible),
        waitingAction: Boolean(state.controls?.waitingAction),
        busy: Boolean(state.controls?.busy)
      },
      error: { visible: Boolean(state.error?.visible) },
      messages: {
        userCount: Math.max(0, Number(state.messages?.userCount || 0)),
        assistantCount: Math.max(0, Number(state.messages?.assistantCount || 0)),
        latestAssistantHasCopyAction: Boolean(state.messages?.latestAssistantHasCopyAction),
        copyActionCount: Math.max(0, Number(state.messages?.copyActionCount || 0))
      }
    };
  }

  function install() {
    return false;
  }

  return {
    PAGE_SNAPSHOT_SCHEMA_VERSION,
    INITIALIZING_GRACE_MS,
    COMPOSER_SELECTORS,
    SEND_SELECTORS,
    cleanText,
    hashText,
    classifyRoute,
    getConversationId,
    isProvisionalConversationId,
    collectComposerCandidates,
    isComposerEnabled,
    isElementVisible,
    findActiveComposer,
    findSendButton,
    looksLikeSendButton,
    isSendButtonEnabled,
    hasStopControl,
    hasApprovalControl,
    hasBusyIndicator,
    findVisibleError,
    collectAssistant,
    collectUsers,
    evaluatePageFacts,
    collectPageState,
    toPublicSnapshot,
    install
  };
});
