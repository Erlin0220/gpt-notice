(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTPageAdapter = api;
})(globalThis, function () {
  "use strict";
  // Keep the selectors verified by the previous extension and the live web regression.
  const COMPOSER = '#prompt-textarea, main textarea[placeholder], main [contenteditable="true"][data-virtualkeyboard]';
  const STOP = 'button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="停止"], button[aria-label*="中止"], button[aria-label*="取消生成"]';
  const SEND = '#composer-submit-button, button[data-testid*="send-button"], button[data-testid*="composer-submit"], button[aria-label="Send"], button[aria-label="发送"]';
  const TURN = '[data-testid^="conversation-turn-"], article, [data-turn-key]';
  const CURRENT_USER = '[data-chatgpt-search-unit-key$=":user"][data-chatgpt-search-message-ids]';
  const CURRENT_ASSISTANT = '[data-content-search-unit-key$=":assistant"]';
  const MESSAGE = `[data-message-author-role], ${CURRENT_USER}, ${CURRENT_ASSISTANT}`;
  const all = (doc, selector) => [...doc.querySelectorAll(selector)];
  const visible = n => Boolean(n?.isConnected && n.getClientRects().length && getComputedStyle(n).visibility !== "hidden");
  const enabled = n => Boolean(n && !n.disabled && n.getAttribute("aria-disabled") !== "true");
  const turn = n => n?.closest(TURN);
  function messageRole(n) {
    const legacy = n?.getAttribute("data-message-author-role") || "";
    if (legacy) return legacy;
    if (n?.matches?.(CURRENT_USER)) return "user";
    if (n?.matches?.(CURRENT_ASSISTANT)) return "assistant";
    return "";
  }
  function readText(n) {
    if (!n) return "";
    let value;
    if (n.matches?.(CURRENT_USER)) value = n.querySelector('[data-user-message-bubble="true"]')?.innerText ?? "";
    else if (n.matches?.(CURRENT_ASSISTANT)) {
      const blocks = all(n, '[data-markdown-text-style="assistant-message"]');
      value = blocks.length ? blocks.map(block => block.innerText ?? block.textContent ?? "").join("\n") : "";
    } else value = n.value ?? n.innerText ?? n.textContent ?? "";
    return String(value).replace(/\r\n?/g, "\n");
  }
  const uniqueIds = values => [...new Set(values.flatMap(value => String(value || "").trim().split(/\s+/)).filter(value => value && value.length <= 200))];
  function assistantMessageId(n) {
    if (!n) return "";
    const direct = uniqueIds([n.getAttribute("data-chatgpt-search-message-ids")]);
    if (direct.length === 1) return direct[0];
    const selected = uniqueIds(all(n, '[data-chatgpt-selection-message-id]').map(node => node.getAttribute("data-chatgpt-selection-message-id")));
    if (selected.length === 1) return selected[0];
    const key = n.closest('[data-content-search-turn-key]')?.getAttribute("data-content-search-turn-key") || "";
    return /^fallback-turn-/i.test(key) ? "" : key;
  }
  function messageId(n) {
    const legacy = n?.getAttribute("data-message-id") || "";
    if (legacy) return legacy;
    const role = messageRole(n), owner = turn(n);
    if (role === "user") return owner?.getAttribute("data-turn-key") || "";
    if (role !== "assistant") return "";
    return assistantMessageId(n);
  }
  const UNTRUSTED_TURN_CONTENT = '.markdown, .prose, pre, code, [data-message-author-role], [data-chatgpt-search-unit-key$=":user"], [data-user-message-bubble], [data-markdown-text-style="assistant-message"], [class~="group/tool-message"], [data-testid*="app"], [data-testid*="widget"], [role="application"]';
  const nativeSurfaceControl = (node, owner) => Boolean(node && owner?.contains?.(node) && visible(node) && !node.closest(UNTRUSTED_TURN_CONTENT));
  function nativeTurnControl(node) {
    const owner = turn(node);
    return nativeSurfaceControl(node, owner);
  }
  // Classify native UI only, never prose produced by the assistant. Blocking
  // signals win over transient wording (e.g. "network error: quota exceeded").
  function failureKind(value) {
    const text = String(value || "").replace(/\s+/g, " ").trim().slice(0, 500);
    if (/quota|rate.?limit|usage.?limit|message.?limit|too many requests|limit.{0,40}(?:reached|exceeded)|reached.{0,40}limit|额度|配额|上限|达到.{0,20}限|请求过多|频率限制|policy|safety|access denied|unauthori[sz]ed|forbidden|sign in|log in|context.{0,20}(?:length|limit)|策略|政策|安全限制|拒绝访问|重新登录|上下文.{0,12}(?:长度|限制)/i.test(text)) return "blocked";
    if (/^(?:you stopped this response|response stopped|用户已停止|你已停止|已停止生成)[.!。！]?$/i.test(text)) return "stopped";
    if (/unable to think|could(?: not|n't) think|thinking failed|无法思考|未能思考|思考失败|something went wrong|network error|network connection.{0,20}(?:lost|error)|request timed out|连接中断|网络错误|网络异常|请求超时|生成.{0,12}(?:错误|出错)/i.test(text)) return "recoverable";
    if (/error|wrong|failed|错误|失败|出错/i.test(text)) return "failed";
    return "";
  }
  let messageRoot = null, cachedUser = null, currentTailTurn = null, discoveryAfter = 0;
  function tail(doc) {
    const currentTurns = all(doc, '[data-turn-key]');
    if (currentTurns.length) {
      const groups = currentTurns.slice(-12);
      currentTailTurn = groups.at(-1) || null;
      messageRoot = null;
      const nodes = groups.flatMap(node => all(node, `${CURRENT_USER}, ${CURRENT_ASSISTANT}`));
      const user = nodes.findLast(n => messageRole(n) === "user");
      if (user) cachedUser = user;
      return nodes;
    }
    currentTailTurn = null;
    if (!messageRoot?.isConnected || messageRoot.ownerDocument !== doc) {
      if (Date.now() < discoveryAfter) return [];
      discoveryAfter = Date.now() + 2000;
      const nodes = all(doc, MESSAGE);
      cachedUser = nodes.findLast(n => messageRole(n) === "user") || null;
      const last = turn(nodes.at(-1));
      messageRoot = last?.parentElement || null;
      // Live ChatGPT wraps each turn in its own div; the fixture/direct layout
      // puts sections directly under the transcript. Cache their common parent.
      if (!last?.hasAttribute("data-turn-key") && messageRoot?.children.length === 1) messageRoot = messageRoot.parentElement;
      while (messageRoot && cachedUser && !messageRoot.contains(cachedUser)) messageRoot = messageRoot.parentElement;
      if (!messageRoot) return [];
    }
    const groups = [];
    for (let node = messageRoot.lastElementChild; node && groups.length < 12; node = node.previousElementSibling) groups.push(node);
    const nodes = groups.reverse().flatMap(n => n.matches(MESSAGE) ? [n] : all(n, MESSAGE));
    const user = nodes.findLast(n => messageRole(n) === "user");
    if (user) cachedUser = user;
    else if (cachedUser?.isConnected && messageRoot.contains(cachedUser)) nodes.unshift(cachedUser);
    return nodes;
  }
  function composer(doc = document) {
    const nodes = all(doc, COMPOSER).filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  }
  function sendButton(doc = document) {
    const input = composer(doc);
    const box = input?.closest("form") || input?.parentElement;
    if (!box) return null;
    // Never mistake Stop/interrupt for Send even when they reuse the same id.
    // Keep native transport controls inside the composer boundary so content or
    // embedded tool surfaces cannot spoof a send control elsewhere in the turn.
    return all(box, SEND).find(n => visible(n) && !n.matches(STOP) && !/stop|停止|中止/i.test(n.getAttribute("aria-label") || "")) || null;
  }
  function snapshot(doc = document, completion = false) {
    const input = composer(doc);
    const box = input?.closest("form") || input?.parentElement;
    // Native Stop belongs to the composer. A same-label button rendered by an
    // assistant/tool response must not keep Queue in a false running state.
    const stop = Boolean(box && all(box, STOP).some(visible));
    const messages = tail(doc);
    const users = messages.filter(n => messageRole(n) === "user");
    const assistants = messages.filter(n => messageRole(n) === "assistant");
    const user = users.at(-1) || null;
    const assistant = assistants.at(-1) || null;
    const afterUser = Boolean(user && assistant && (user.compareDocumentPosition(assistant) & 4));
    const assistantTurn = turn(assistant);
    // An error-only turn need not contain an assistant message at all.
    const lastGroup = messageRoot?.lastElementChild;
    const trailingTurn = currentTailTurn || (lastGroup?.matches(TURN) ? lastGroup : lastGroup?.querySelector(TURN));
    const activeTurn = user && trailingTurn && (user.compareDocumentPosition(trailingTurn) & 4) ? trailingTurn : afterUser ? assistantTurn : turn(user);
    const local = selector => activeTurn ? all(activeTurn, selector) : [];
    const nativeUI = n => nativeSurfaceControl(n, activeTurn);
    const waiting = local('button').some(n => nativeUI(n) && /^(allow|approve|confirm|continue|continue generating|allow once|always allow|允许|批准|确认|继续|继续生成|允许一次|始终允许)$/i.test(n.innerText.trim()));
    const busy = local('[role="status"], [data-state="loading"]').some(n => nativeUI(n) && !failureKind(n.textContent) && /working|thinking|searching|generating|正在处理|正在思考|正在搜索|正在生成/i.test(n.textContent.slice(0,200)));
    const errors = [
      ...local('[role="alert"], [data-testid*="error"]').filter(nativeUI),
      ...(box ? all(box, '[role="alert"], [data-testid*="error"]').filter(n => nativeSurfaceControl(n, box)) : [])
    ];
    // Some native reasoning failures are short button/status labels rather than alerts.
    const labels = local('button, [role="status"]').filter(nativeUI).map(n => (n.getAttribute('aria-label') || n.textContent || '').trim());
    const kinds = errors.map(n => failureKind(n.textContent) || "failed");
    for (const label of labels) if (/^(?:unable to think|could(?: not|n't) think|thinking failed|无法思考|未能思考|思考失败|you stopped this response|response stopped|用户已停止|你已停止|已停止生成)[.!。！]?$/i.test(label)) kinds.push(failureKind(label));
    const failure = ["blocked", "stopped", "failed", "recoverable"].find(kind => kinds.includes(kind)) || "";
    const copy = afterUser && Boolean(assistantTurn && all(assistantTurn, 'button').some(n => nativeTurnControl(n) && (
      n.matches('button[data-testid="copy-turn-action-button"]') || /^(?:copy|copy response|复制)$/i.test((n.getAttribute("aria-label") || "").trim())
    )));
    const outcome = waiting ? "attention" : stop || busy ? "running" : failure || (copy && messageId(assistant) ? "completed" : "idle");
    // Upload inputs may be cleared after upload. Native removal controls remain
    // the evidence that the composer still owns an attachment (including images).
    const attachments = Boolean(box && (
      all(box, 'input[type="file"]').some(n => n.files?.length) ||
      all(box, '[data-testid*="attachment"], [data-testid*="file-preview"], [data-testid*="image-preview"]').some(visible) ||
      all(box, 'button[aria-label], button[title]').some(n => visible(n) && /(?:remove|delete)\s+(?:file|attachment|image|photo)|(?:删除|移除|清除)(?:文件|附件|图片|图像|照片)/i.test(`${n.getAttribute("aria-label") || ""} ${n.getAttribute("title") || ""}`))
    ));
    return { composer: input, anchor: box, ready: enabled(input), empty: !readText(input).trim() && !attachments,
      attachments, stop, waiting, busy, error: Boolean(failure), failure, outcome, running: stop || waiting || busy,
      user, users, userId: messageId(user), assistant, assistantId: afterUser ? messageId(assistant) : "",
      model: afterUser ? assistant?.getAttribute("data-message-model-slug") || "" : "",
      copy,
      // Never read or hash streamed answer tokens. Content is sampled only after native controls are idle.
      settledText: completion && afterUser && outcome === "completed" ? readText(assistant).slice(0,200000) : "" };
  }
  function userNode(userId, doc = document) {
    if (!userId) return null;
    const escaped = CSS.escape(userId);
    return doc.querySelector(`[data-message-author-role="user"][data-message-id="${escaped}"]`) ||
      doc.querySelector(`[data-turn-key="${escaped}"] ${CURRENT_USER}`);
  }
  function precedes(userId, node, doc = document) {
    if (!userId || !node?.isConnected) return false;
    const baseline = userNode(userId, doc);
    return Boolean(baseline?.isConnected && (baseline.compareDocumentPosition(node) & 4));
  }
  function generationMatches(generationId, page, doc = document) {
    if (generationId === page.userId) return true;
    if (!generationId?.startsWith(`${page.userId}:`) || !page.assistant) return false;
    const responseId = generationId.slice(page.userId.length + 1);
    if (page.assistantId === responseId) return true;
    const marker = doc.querySelector(`[data-message-author-role="assistant"][data-message-id="${CSS.escape(responseId)}"]`);
    // Another tab may still show the previous answer to this same user message.
    // Require this regeneration's native marker, allowing subsequent tool segments.
    return Boolean(marker && (marker === page.assistant || (marker.compareDocumentPosition(page.assistant) & 4)));
  }
  function receipt(item, page) {
    const baseline = userNode(item.baseline);
    if (!baseline) return null; // Missing/virtualized baseline cannot prove delivery.
    return page.users.find(n => (baseline.compareDocumentPosition(n) & 4) && messageId(n) && globalThis.ChatGPTQueueCore.comparable(readText(n)) === globalThis.ChatGPTQueueCore.comparable(item.text)) || null;
  }
  let bootstrapNode, bootstrapText = "", userId = "", initialAccount = "", scopeIdentity = "", scopeValue = "";
  async function scope(doc = document) {
    const node = doc.getElementById("client-bootstrap");
    const serialized = node?.textContent || "";
    if (node !== bootstrapNode || serialized !== bootstrapText) {
      bootstrapNode = node;
      bootstrapText = serialized;
      userId = "";
      initialAccount = "";
      try {
        const value = JSON.parse(serialized || "{}");
        userId = String(value.user?.id || value.session?.user?.id || "");
        initialAccount = String(value.session?.account?.id || "");
      } catch {}
    }
    let account = "";
    try { account = localStorage.getItem("_account") || initialAccount || "personal"; } catch { return ""; }
    if (!userId) return "";
    const identity = `${userId}:${account}`;
    if (scopeIdentity !== identity) {
      const hash = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(identity));
      // Do not publish an old identity if an account change raced the digest.
      if (doc.getElementById("client-bootstrap") !== node || node?.textContent !== serialized) return "";
      try { if ((localStorage.getItem("_account") || initialAccount || "personal") !== account) return ""; } catch { return ""; }
      scopeValue = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2,"0")).join("");
      scopeIdentity = identity;
    }
    return scopeValue;
  }
  function projectCache(scope) {
    // Read only the selected account's native metadata cache; never enumerate
    // other accounts' caches or persist their raw contents in the extension.
    try {
      const account = localStorage.getItem("_account") || initialAccount || "personal";
      if (!scope || scope !== scopeValue || `${userId}:${account}` !== scopeIdentity || document.getElementById("client-bootstrap")?.textContent !== bootstrapText) return "";
      // Live Web serializes _account as a JSON string; the cache path uses its
      // decoded ID. Keep the existing Queue/usage scope digest unchanged.
      let cacheAccount = account;
      if (account.startsWith('"')) { cacheAccount = JSON.parse(account); if (typeof cacheAccount !== "string") return ""; }
      return localStorage.getItem(`cache/${userId}/${cacheAccount}/snorlax-history`) || "";
    } catch { return ""; }
  }
  function write(input, value) {
    if (!input || !enabled(input) || !visible(input)) return false;
    input.focus({ preventScroll: true });
    if (input instanceof HTMLTextAreaElement || input instanceof HTMLInputElement) {
      const prototype = input instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      Object.getOwnPropertyDescriptor(prototype, "value").set.call(input, value);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, composed: true, inputType: "insertText", data: value }));
    } else {
      const range = document.createRange();
      range.selectNodeContents(input);
      const selection = getSelection();
      selection.removeAllRanges();
      selection.addRange(range);
      // Let ProseMirror receive its normal edit transaction rather than replacing React DOM.
      if (!document.execCommand(value ? "insertText" : "delete", false, value)) return false;
    }
    return globalThis.ChatGPTQueueCore.comparable(readText(input)) === globalThis.ChatGPTQueueCore.comparable(value);
  }
  return { COMPOSER, STOP, SEND, visible, enabled, readText, messageId, failureKind, nativeTurnControl, composer, sendButton, snapshot, precedes, generationMatches, receipt, scope, projectCache, write };
});
