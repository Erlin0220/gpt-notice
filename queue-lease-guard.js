(function attachQueueLeaseGuard(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueLeaseGuard = api;
  if (root.chrome?.storage?.local && root.sessionStorage) api.install(root);
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueLeaseGuard() {
  const LEASE_STORAGE_KEY = "messageQueueConversationLeasesV1";
  const INSTANCE_STORAGE_KEY = "chatgpt-message-queue-instance-v060";
  const INSTALL_MARKER = "__CHATGPT_QUEUE_LEASE_GUARD_INSTALLED__";

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

  function normalizeLease(lease) {
    if (!lease || typeof lease !== "object") return null;
    const ownerTabId = Number(lease.ownerTabId);
    const ownerInstanceId = String(lease.ownerInstanceId || "");
    const ownerQueueKey = String(lease.ownerQueueKey || "");
    const expiresAt = Number(lease.expiresAt || 0);
    if (!Number.isInteger(ownerTabId) || !ownerInstanceId || !ownerQueueKey || !Number.isFinite(expiresAt)) return null;
    return { ...lease, ownerTabId, ownerInstanceId, ownerQueueKey, expiresAt };
  }

  function isSameOwner(lease, identity) {
    const normalized = normalizeLease(lease);
    return Boolean(normalized && Number.isInteger(identity?.tabId) && normalized.ownerTabId === identity.tabId && normalized.ownerInstanceId === identity.instanceId);
  }

  function compareInstanceAge(leftId, rightId) {
    const leftTimestamp = parsePageInstanceTimestamp(leftId);
    const rightTimestamp = parsePageInstanceTimestamp(rightId);
    if (leftTimestamp !== rightTimestamp) return leftTimestamp - rightTimestamp;
    return String(leftId || "").localeCompare(String(rightId || ""));
  }

  function sanitizeLeaseMapForReader(rawLeases, identity, now = Date.now()) {
    const leases = rawLeases && typeof rawLeases === "object" ? rawLeases : {};
    const next = {};
    for (const [conversationKey, rawLease] of Object.entries(leases)) {
      const lease = normalizeLease(rawLease);
      if (!lease) continue;
      if (lease.ownerTabId !== identity?.tabId || lease.ownerInstanceId === identity?.instanceId) {
        next[conversationKey] = lease;
        continue;
      }

      const readerIsNewer = compareInstanceAge(identity?.instanceId, lease.ownerInstanceId) > 0;
      if (readerIsNewer) {
        // A new document in the same Chrome tab may immediately take over the old document's lease.
        continue;
      }

      // An older BFCache/page instance must treat the newer document as a different owner.
      next[conversationKey] = { ...lease, ownerTabId: -1, expiresAt: Math.max(lease.expiresAt, Number(now) + 1) };
    }
    return next;
  }

  function reconcileLeaseMaps(rawCurrent, rawProposed, identity, now = Date.now()) {
    const currentMap = rawCurrent && typeof rawCurrent === "object" ? rawCurrent : {};
    const proposedMap = rawProposed && typeof rawProposed === "object" ? rawProposed : {};
    const next = {};
    const keys = new Set([...Object.keys(currentMap), ...Object.keys(proposedMap)]);

    for (const conversationKey of keys) {
      const current = normalizeLease(currentMap[conversationKey]);
      const proposed = normalizeLease(proposedMap[conversationKey]);

      if (!proposed) {
        if (current && !isSameOwner(current, identity)) next[conversationKey] = current;
        continue;
      }

      if (!isSameOwner(proposed, identity)) {
        next[conversationKey] = current || proposed;
        continue;
      }

      if (!current || current.expiresAt <= now || isSameOwner(current, identity)) {
        next[conversationKey] = proposed;
        continue;
      }

      if (current.ownerTabId !== identity.tabId) {
        next[conversationKey] = current;
        continue;
      }

      const callerIsNewer = compareInstanceAge(identity.instanceId, current.ownerInstanceId) > 0;
      next[conversationKey] = callerIsNewer ? proposed : current;
    }

    return next;
  }

  function requestsLeaseKey(keys) {
    if (keys === null || keys === undefined) return true;
    if (typeof keys === "string") return keys === LEASE_STORAGE_KEY;
    if (Array.isArray(keys)) return keys.includes(LEASE_STORAGE_KEY);
    return typeof keys === "object" && Object.prototype.hasOwnProperty.call(keys, LEASE_STORAGE_KEY);
  }

  function settleWithCallback(promise, callback, fallbackValue) {
    if (typeof callback !== "function") return promise;
    promise.then(callback, (error) => {
      console.warn("[ChatGPT Queue Lease Guard] storage operation failed", error);
      callback(fallbackValue);
    });
    return undefined;
  }

  function install(root = globalThis) {
    if (root[INSTALL_MARKER]) return root[INSTALL_MARKER];
    const local = root.chrome?.storage?.local;
    const session = root.sessionStorage;
    if (!local || !session || typeof local.get !== "function" || typeof local.set !== "function") return null;

    const instanceId = createPageInstanceId();
    session.setItem(INSTANCE_STORAGE_KEY, instanceId);

    const originalGet = local.get.bind(local);
    const originalSet = local.set.bind(local);
    const identityPromise = Promise.resolve(root.chrome.runtime.sendMessage({ type: "GET_TAB_CONTEXT" }))
      .then((response) => {
        if (!response?.ok || !Number.isInteger(response.tabId)) throw new Error("无法识别当前 Chrome 标签页");
        return { tabId: response.tabId, instanceId };
      });

    local.get = function guardedGet(keys, callback) {
      const promise = Promise.resolve(originalGet(keys)).then(async (result) => {
        if (!requestsLeaseKey(keys) || !result || typeof result !== "object") return result;
        const identity = await identityPromise;
        return {
          ...result,
          [LEASE_STORAGE_KEY]: sanitizeLeaseMapForReader(result[LEASE_STORAGE_KEY], identity)
        };
      });
      return settleWithCallback(promise, callback, {});
    };

    local.set = function guardedSet(values, callback) {
      if (!values || typeof values !== "object" || !Object.prototype.hasOwnProperty.call(values, LEASE_STORAGE_KEY)) {
        return originalSet(values, callback);
      }
      const promise = (async () => {
        const identity = await identityPromise;
        const currentResult = await originalGet(LEASE_STORAGE_KEY);
        const safeLeases = reconcileLeaseMaps(currentResult?.[LEASE_STORAGE_KEY], values[LEASE_STORAGE_KEY], identity);
        await originalSet({ ...values, [LEASE_STORAGE_KEY]: safeLeases });
      })();
      return settleWithCallback(promise, callback);
    };

    const installed = { instanceId, identityPromise, originalGet, originalSet };
    root[INSTALL_MARKER] = installed;
    return installed;
  }

  return {
    LEASE_STORAGE_KEY,
    INSTANCE_STORAGE_KEY,
    createPageInstanceId,
    parsePageInstanceTimestamp,
    normalizeLease,
    isSameOwner,
    compareInstanceAge,
    sanitizeLeaseMapForReader,
    reconcileLeaseMaps,
    requestsLeaseKey,
    install
  };
});
