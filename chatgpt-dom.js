(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTPageAdapter = api;
})(globalThis, function () {
  "use strict";
  // Keep the selectors verified by the previous extension and the live web regression.
  const COMPOSER = '#prompt-textarea, main textarea[placeholder], main [contenteditable="true"][data-virtualkeyboard]';
  const STOP = 'button[data-testid*="stop"], button[aria-label*="Stop"], button[aria-label*="stop"], button[aria-label*="停止"], button[aria-label*="中止"], button[aria-label*="取消生成"]';
  const SEND = '#composer-submit-button, button[data-testid*="send-button"], button[data-testid*="composer-submit"]';
  const all = (doc, selector) => [...doc.querySelectorAll(selector)];
  const visible = n => Boolean(n?.isConnected && n.getClientRects().length && getComputedStyle(n).visibility !== "hidden");
  const enabled = n => Boolean(n && !n.disabled && n.getAttribute("aria-disabled") !== "true");
  const readText = n => String(n?.value ?? n?.innerText ?? n?.textContent ?? "").replace(/\r\n?/g, "\n");
  const messageId = n => n?.getAttribute("data-message-id") || "";
  const turn = n => n?.closest('[data-testid^="conversation-turn-"], article');
  const MESSAGE = '[data-message-author-role]';
  let messageRoot = null, cachedUser = null, discoveryAfter = 0;
  function tail(doc) {
    if (!messageRoot?.isConnected || messageRoot.ownerDocument !== doc) {
      if (Date.now() < discoveryAfter) return [];
      discoveryAfter = Date.now() + 2000;
      const nodes = all(doc, MESSAGE);
      cachedUser = nodes.findLast(n => n.dataset.messageAuthorRole === "user") || null;
      const last = turn(nodes.at(-1));
      messageRoot = last?.parentElement || null;
      // Live ChatGPT wraps each turn in its own div; the fixture/direct layout
      // puts sections directly under the transcript. Cache their common parent.
      if (messageRoot?.children.length === 1) messageRoot = messageRoot.parentElement;
      while (messageRoot && cachedUser && !messageRoot.contains(cachedUser)) messageRoot = messageRoot.parentElement;
      if (!messageRoot) return [];
    }
    const groups = [];
    for (let node = messageRoot.lastElementChild; node && groups.length < 12; node = node.previousElementSibling) groups.push(node);
    const nodes = groups.reverse().flatMap(n => n.matches(MESSAGE) ? [n] : all(n, MESSAGE));
    const user = nodes.findLast(n => n.dataset.messageAuthorRole === "user");
    if (user) cachedUser = user;
    else if (cachedUser?.isConnected && messageRoot.contains(cachedUser)) nodes.unshift(cachedUser);
    return nodes;
  }
  function composer(doc = document) {
    const nodes = all(doc, COMPOSER).filter(visible);
    return nodes.length === 1 ? nodes[0] : null;
  }
  function sendButton(doc = document) {
    // Never mistake Stop/interrupt for Send even when they reuse the same id.
    return all(doc, SEND).find(n => visible(n) && !n.matches(STOP) && !/stop|停止|中止/i.test(n.getAttribute("aria-label") || "")) || null;
  }
  function snapshot(doc = document, completion = false) {
    const input = composer(doc);
    const box = input?.closest("form") || input?.parentElement;
    const stop = all(doc, STOP).some(visible);
    const messages = tail(doc);
    const users = messages.filter(n => n.dataset.messageAuthorRole === "user");
    const assistants = messages.filter(n => n.dataset.messageAuthorRole === "assistant");
    const user = users.at(-1) || null;
    const assistant = assistants.at(-1) || null;
    const afterUser = Boolean(user && assistant && (user.compareDocumentPosition(assistant) & 4));
    const assistantTurn = turn(assistant);
    const activeTurn = afterUser ? assistantTurn : turn(user);
    const local = selector => activeTurn ? all(activeTurn, selector) : [];
    const waiting = local('button').some(n => visible(n) && /^(allow|approve|confirm|continue|allow once|always allow|允许|批准|确认|继续|允许一次|始终允许)$/i.test(n.innerText.trim()));
    const busy = local('[role="status"], [data-state="loading"]').some(n => visible(n) && /working|thinking|searching|generating|正在处理|正在思考|正在搜索|正在生成/i.test(n.textContent.slice(0,200)));
    const errors = [...local('[role="alert"], [data-testid*="error"]'), ...(box ? all(box, '[role="alert"], [data-testid*="error"]') : [])];
    const error = errors.some(n => visible(n) && /error|wrong|failed|错误|失败|出错|达到.*限|limit/i.test(n.textContent.slice(0,500)));
    const attachments = Boolean(box?.querySelector('input[type="file"]')?.files?.length || box?.querySelector('[data-testid*="attachment"], [data-testid*="file-preview"], button[aria-label*="Remove file"], button[aria-label*="删除附件"]'));
    return { composer: input, anchor: box, ready: enabled(input), empty: !readText(input).trim() && !attachments,
      attachments, stop, waiting, busy, error, running: stop || waiting || busy,
      user, users, userId: messageId(user), assistant, assistantId: afterUser ? messageId(assistant) : "",
      model: afterUser ? assistant?.getAttribute("data-message-model-slug") || "" : "",
      copy: afterUser && Boolean(assistantTurn?.querySelector('button[data-testid="copy-turn-action-button"]')),
      // Never read or hash streamed answer tokens. Content is sampled only after native controls are idle.
      settledText: completion && afterUser && !stop && !busy && !waiting ? (assistant.textContent || "").slice(0,200000) : "" };
  }
  function receipt(item, page) {
    const baseline = document.querySelector(`[data-message-author-role="user"][data-message-id="${CSS.escape(item.baseline)}"]`);
    if (!baseline) return null; // Missing/virtualized baseline cannot prove delivery.
    return page.users.find(n => (baseline.compareDocumentPosition(n) & 4) && messageId(n) && globalThis.ChatGPTQueueCore.comparable(readText(n)) === globalThis.ChatGPTQueueCore.comparable(item.text)) || null;
  }
  let bootstrapNode, userId = "", initialAccount = "", scopeIdentity = "", scopeValue = "";
  async function scope(doc = document) {
    const node = doc.getElementById("client-bootstrap");
    if (node !== bootstrapNode) {
      bootstrapNode = node;
      userId = "";
      initialAccount = "";
      try {
        const value = JSON.parse(node?.textContent || "{}");
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
      scopeValue = [...new Uint8Array(hash)].map(n => n.toString(16).padStart(2,"0")).join("");
      scopeIdentity = identity;
    }
    return scopeValue;
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
  return { COMPOSER, STOP, SEND, visible, enabled, readText, messageId, composer, sendButton, snapshot, receipt, scope, write };
});
