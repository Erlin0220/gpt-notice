(function attachQueueCore(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueCore = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueCore() {
  const QUEUE_SCHEMA_VERSION = 2;
  const QUEUE_STORAGE_KEY = "messageQueues";
  const WRITE_LOCK_STORAGE_KEY = "messageQueueWriteLocks";
  const ITEM_STATUSES = new Set(["pending", "dispatching", "running", "completed", "failed"]);
  const MAX_HISTORY_ITEMS = 120;
  const MAX_COMPLETED_ITEMS = 60;

  function cleanText(value, maxLength = 20_000) {
    return String(value || "").replace(/\r/g, "").trim().slice(0, maxLength);
  }

  function createId(prefix = "queue") {
    const random = typeof crypto !== "undefined" && typeof crypto.randomUUID === "function"
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
      baselineAssistantCount: Math.max(0, Number(item.baselineAssistantCount || 0)),
      baselineUserCount: Math.max(0, Number(item.baselineUserCount || 0)),
      error: cleanText(item.error || "", 240)
    };
  }

  function normalizeLease(lease) {
    if (!lease || typeof lease !== "object") return null;
    const ownerId = String(lease.ownerId || "");
    const expiresAt = Number(lease.expiresAt || 0);
    return ownerId && expiresAt ? { ownerId, expiresAt } : null;
  }

  function pruneItems(items) {
    const normalized = (Array.isArray(items) ? items : []).map(normalizeItem).filter((item) => item.text);
    const protectedItems = normalized.filter((item) => item.status !== "completed");
    const completedLimit = Math.max(0, Math.min(MAX_COMPLETED_ITEMS, MAX_HISTORY_ITEMS - protectedItems.length));
    const completed = normalized
      .filter((item) => item.status === "completed")
      .sort((a, b) => (b.finishedAt || b.createdAt) - (a.finishedAt || a.createdAt))
      .slice(0, completedLimit);
    const keepIds = new Set([...protectedItems, ...completed].map((item) => item.id));
    return normalized.filter((item) => keepIds.has(item.id));
  }

  function normalizeQueue(queue = {}, conversationKey = "") {
    const items = pruneItems(queue.items);
    const activeItem = items.find((item) => item.id === queue.activeItemId);
    return {
      version: QUEUE_SCHEMA_VERSION,
      revision: Math.max(0, Number(queue.revision || 0)),
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

  function createQueueItem(text) {
    const cleaned = cleanText(text);
    if (!cleaned) return null;
    return normalizeItem({ text: cleaned, status: "pending" });
  }

  function findConversationId(value) {
    try {
      const url = new URL(value || "https://chatgpt.com/");
      const match = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
      return match?.[1] || "";
    } catch {
      return "";
    }
  }

  function getConversationKey(value, temporaryKey = "", discoveredConversationId = "") {
    try {
      const url = new URL(value || "https://chatgpt.com/");
      const conversationId = findConversationId(url.href);
      if (conversationId) return `c:${conversationId}`;
      const shareMatch = url.pathname.match(/(?:^|\/)share\/([^/?#]+)/);
      if (shareMatch) return `share:${shareMatch[1]}`;
      const projectMatch = url.pathname.match(/(?:^|\/)g\/(g-p-[^/]+)\/project(?:\/|$)/);
      if (projectMatch) return `project-draft:${projectMatch[1]}:${temporaryKey || "page"}`;
      const trimmedPath = url.pathname.replace(/\/+$/, "") || "/";
      if (trimmedPath !== "/") return `path:${trimmedPath}`;
      if (discoveredConversationId) return `c:${discoveredConversationId}`;
    } catch {
      // Fall through to a per-tab temporary key.
    }
    return temporaryKey ? `temp:${temporaryKey}` : "";
  }

  function shouldMigrateQueue(fromKey, toKey) {
    if (!fromKey || !toKey || fromKey === toKey || !toKey.startsWith("c:")) return false;
    return fromKey.startsWith("temp:") || fromKey.startsWith("project-draft:");
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

  function hasActiveWork(queue) {
    const normalized = normalizeQueue(queue);
    return Boolean(normalized.activeItemId || normalized.items.some((item) => item.status === "pending"));
  }

  function canAdmit(queue, snapshot) {
    const normalized = normalizeQueue(queue);
    return Boolean(
      normalized.activeItemId ||
      snapshot?.stopVisible ||
      snapshot?.busy ||
      snapshot?.waitingAction ||
      snapshot?.taskRunning ||
      snapshot?.manualHold
    );
  }

  function canDispatch(queue, snapshot, now = Date.now()) {
    const normalized = normalizeQueue(queue);
    if (normalized.paused || normalized.activeItemId || !getNextPendingItem(normalized)) return false;
    if (normalized.nextDispatchAt > now) return false;
    if (!snapshot?.composerReady || snapshot.stopVisible || snapshot.waitingAction || snapshot.taskRunning || snapshot.visibleError) return false;
    const stableForMs = Number(snapshot.stableForMs || 0);
    if (snapshot.busy && stableForMs < 8_000) return false;
    if (snapshot.manualHold || snapshot.composerEmpty === false) return false;
    return stableForMs >= 4_000;
  }

  function isItemCompleted(item, snapshot, now = Date.now()) {
    if (!item || !["dispatching", "running"].includes(item.status)) return false;
    if (snapshot?.stopVisible || snapshot?.waitingAction || snapshot?.taskRunning || snapshot?.visibleError || !snapshot?.composerReady) return false;
    const stableForMs = Number(snapshot.stableForMs || 0);
    if (stableForMs < 4_000) return false;
    if (item.startedAt && now - item.startedAt < 1_800) return false;
    const responseAdvanced = Boolean(
      Number(snapshot.assistantCount || 0) > Number(item.baselineAssistantCount || 0) ||
      (snapshot.assistantHash && snapshot.assistantHash !== item.baselineAssistantHash)
    );
    if (!responseAdvanced || !String(snapshot.assistantText || "").trim()) return false;
    if (snapshot.busy && stableForMs < 8_000) return false;
    return true;
  }

  function moveItem(items, itemId, direction) {
    const next = (items || []).map(normalizeItem);
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
      if (item.status !== "dispatching") return item;
      return {
        ...item,
        status: "pending",
        startedAt: null,
        finishedAt: null,
        error: item.error || "页面重新加载，等待恢复执行"
      };
    });
    const active = normalized.items.find((item) => item.id === normalized.activeItemId);
    if (!active || active.status !== "running") normalized.activeItemId = null;
    normalized.nextDispatchAt = now + 2_000;
    normalized.updatedAt = now;
    return normalized;
  }

  return {
    QUEUE_SCHEMA_VERSION,
    QUEUE_STORAGE_KEY,
    WRITE_LOCK_STORAGE_KEY,
    MAX_HISTORY_ITEMS,
    cleanText,
    createId,
    normalizeItem,
    normalizeQueue,
    pruneItems,
    createQueueItem,
    findConversationId,
    getConversationKey,
    shouldMigrateQueue,
    getPendingItems,
    getNextPendingItem,
    countPending,
    hasActiveWork,
    canAdmit,
    canDispatch,
    isItemCompleted,
    moveItem,
    resetInterruptedItems
  };
});
