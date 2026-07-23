(function attachQueueCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueCore() {
  const QUEUE_SCHEMA_VERSION = 1;
  const QUEUE_STORAGE_KEY = "messageQueues";
  const ITEM_STATUSES = new Set(["pending", "dispatching", "running", "completed", "failed"]);

  function cleanText(value, maxLength = 20_000) {
    return String(value || "").replace(/\r/g, "").trim().slice(0, maxLength);
  }

  function createId(prefix = "queue") {
    const random = typeof crypto?.randomUUID === "function"
      ? crypto.randomUUID().slice(0, 8)
      : Math.random().toString(36).slice(2, 10);
    return `${prefix}-${Date.now().toString(36)}-${random}`;
  }

  function normalizeItem(item = {}) {
    const now = Date.now();
    const status = ITEM_STATUSES.has(item.status) ? item.status : "pending";
    return {
      id: item.id || createId("item"),
      text: cleanText(item.text),
      status,
      retryCount: Math.max(0, Number(item.retryCount || 0)),
      createdAt: Number(item.createdAt || now),
      startedAt: item.startedAt ? Number(item.startedAt) : null,
      finishedAt: item.finishedAt ? Number(item.finishedAt) : null,
      baselineAssistantHash: String(item.baselineAssistantHash || ""),
      error: cleanText(item.error || "", 240)
    };
  }

  function normalizeQueue(queue = {}, conversationKey = "") {
    const items = Array.isArray(queue.items)
      ? queue.items.map(normalizeItem).filter((item) => item.text)
      : [];
    const activeItem = items.find((item) => item.id === queue.activeItemId);
    return {
      version: QUEUE_SCHEMA_VERSION,
      conversationKey: String(conversationKey || queue.conversationKey || ""),
      conversationUrl: String(queue.conversationUrl || ""),
      paused: Boolean(queue.paused),
      activeItemId: activeItem && ["dispatching", "running"].includes(activeItem.status)
        ? activeItem.id
        : null,
      nextDispatchAt: Math.max(0, Number(queue.nextDispatchAt || 0)),
      lease: normalizeLease(queue.lease),
      items,
      createdAt: Number(queue.createdAt || Date.now()),
      updatedAt: Number(queue.updatedAt || Date.now())
    };
  }

  function normalizeLease(lease) {
    if (!lease || typeof lease !== "object") return null;
    const ownerId = String(lease.ownerId || "");
    const expiresAt = Number(lease.expiresAt || 0);
    return ownerId && expiresAt ? { ownerId, expiresAt } : null;
  }

  function createQueueItem(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return null;
    return normalizeItem({ text: cleaned, status: "pending" });
  }

  function getConversationKey(value, temporaryKey = "") {
    try {
      const url = new URL(value || "https://chatgpt.com/");
      const conversationMatch = url.pathname.match(/(?:^|\/)c\/([^/]+)/);
      if (conversationMatch) return `c:${conversationMatch[1]}`;
      const shareMatch = url.pathname.match(/(?:^|\/)share\/([^/]+)/);
      if (shareMatch) return `share:${shareMatch[1]}`;
      const trimmedPath = url.pathname.replace(/\/+$/, "") || "/";
      if (trimmedPath !== "/") return `path:${trimmedPath}`;
    } catch {
      // Fall through to the per-tab temporary key.
    }
    return temporaryKey ? `temp:${temporaryKey}` : "";
  }

  function getPendingItems(queue) {
    return normalizeQueue(queue).items.filter((item) => item.status === "pending");
  }

  function getNextPendingItem(queue) {
    return getPendingItems(queue)[0] || null;
  }

  function countPending(queue) {
    return getPendingItems(queue).length;
  }

  function canDispatch(queue, snapshot, now = Date.now()) {
    const normalized = normalizeQueue(queue);
    if (normalized.paused || normalized.activeItemId || !getNextPendingItem(normalized)) return false;
    if (normalized.nextDispatchAt > now) return false;
    if (!snapshot?.composerReady || snapshot.stopVisible || snapshot.busy || snapshot.visibleError) return false;
    if (snapshot.manualHold) return false;
    return Number(snapshot.stableForMs || 0) >= 4_000;
  }

  function isItemCompleted(item, snapshot, now = Date.now()) {
    if (!item || !["dispatching", "running"].includes(item.status)) return false;
    if (snapshot?.stopVisible || snapshot?.busy || snapshot?.visibleError || !snapshot?.composerReady) return false;
    if (Number(snapshot.stableForMs || 0) < 4_000) return false;
    if (item.startedAt && now - item.startedAt < 1_800) return false;
    return Boolean(
      snapshot.assistantHash &&
      snapshot.assistantHash !== item.baselineAssistantHash &&
      String(snapshot.assistantText || "").trim()
    );
  }

  function moveItem(items, itemId, direction) {
    const next = items.map(normalizeItem);
    const index = next.findIndex((item) => item.id === itemId);
    if (index < 0) return next;
    const target = direction === "up" ? index - 1 : index + 1;
    if (target < 0 || target >= next.length) return next;
    [next[index], next[target]] = [next[target], next[index]];
    return next;
  }

  function resetInterruptedItems(queue) {
    const normalized = normalizeQueue(queue);
    const now = Date.now();
    normalized.items = normalized.items.map((item) => {
      if (!["dispatching", "running"].includes(item.status)) return item;
      return {
        ...item,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        error: item.error || "页面重新加载，等待恢复执行"
      };
    });
    normalized.activeItemId = null;
    normalized.nextDispatchAt = now + 2_000;
    normalized.updatedAt = now;
    return normalized;
  }

  return {
    QUEUE_SCHEMA_VERSION,
    QUEUE_STORAGE_KEY,
    cleanText,
    createId,
    normalizeItem,
    normalizeQueue,
    createQueueItem,
    getConversationKey,
    getPendingItems,
    getNextPendingItem,
    countPending,
    canDispatch,
    isItemCompleted,
    moveItem,
    resetInterruptedItems
  };
});
