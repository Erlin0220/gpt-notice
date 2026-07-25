(function attachQueueLeaseGuard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueLeaseGuard = api;
  if (root.sessionStorage) api.preparePageInstance(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueLeaseGuard() {
  const INSTANCE_STORAGE_KEY = "chatgpt-message-queue-instance-v060";
  const PREPARED_MARKER = "__CHATGPT_QUEUE_PAGE_INSTANCE_PREPARED__";

  function createPageInstanceId(now = Date.now(), randomValue = Math.random()) {
    const random = Math.abs(Number(randomValue) || 0).toString(36).replace(/^0\./, "").slice(0, 8) || "instance";
    return `page-${Math.max(0, Number(now) || 0).toString(36)}-${random}`;
  }

  function parsePageInstanceTimestamp(instanceId) {
    const match = String(instanceId || "").match(/^page-([0-9a-z]+)-/i);
    if (!match) return 0;
    const timestamp = Number.parseInt(match[1], 36);
    return Number.isFinite(timestamp) ? timestamp : 0;
  }

  function compareInstanceAge(leftId, rightId) {
    const leftTimestamp = parsePageInstanceTimestamp(leftId);
    const rightTimestamp = parsePageInstanceTimestamp(rightId);
    if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
    return String(leftId || "").localeCompare(String(rightId || ""));
  }

  function preparePageInstance(root = globalThis, now = Date.now(), randomValue = Math.random()) {
    if (root[PREPARED_MARKER]) return root[PREPARED_MARKER];
    const session = root.sessionStorage;
    if (!session || typeof session.setItem !== "function") return "";
    const instanceId = createPageInstanceId(now, randomValue);
    session.setItem(INSTANCE_STORAGE_KEY, instanceId);
    root[PREPARED_MARKER] = instanceId;
    return instanceId;
  }

  return {
    INSTANCE_STORAGE_KEY,
    createPageInstanceId,
    parsePageInstanceTimestamp,
    compareInstanceAge,
    preparePageInstance
  };
});
