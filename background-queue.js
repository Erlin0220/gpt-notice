const QUEUE_STORAGE_KEY_V051 = "messageQueues";
const QUEUE_OBSERVER_STORAGE_KEY = "queueObserverTabs";
const QUEUE_WATCHDOG_ALARM = "chatgpt-message-queue-watchdog";
const QUEUE_WATCHDOG_MINUTES = 0.5;
const QUEUE_CLEANUP_GRACE_MS = 30_000;
let queueReconcilePromise = Promise.resolve();

chrome.runtime.onInstalled.addListener(() => {
  void ensureQueueWatchdogAlarm();
  void reconcileQueueObservers();
});

chrome.runtime.onStartup?.addListener(() => {
  void ensureQueueWatchdogAlarm();
  void reconcileQueueObservers();
});

chrome.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === "local" && changes[QUEUE_STORAGE_KEY_V051]) void reconcileQueueObservers();
});

chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === QUEUE_WATCHDOG_ALARM) void reconcileQueueObservers();
});

chrome.tabs.onRemoved.addListener((tabId) => {
  void removeQueueObserverMapping(tabId).then(() => {
    setTimeout(() => void reconcileQueueObservers(), 300);
  });
});

chrome.tabs.onActivated.addListener(({ tabId }) => {
  void promoteQueueObserverTab(tabId);
});

void ensureQueueWatchdogAlarm();
void reconcileQueueObservers();

async function ensureQueueWatchdogAlarm() {
  const current = await chrome.alarms.get(QUEUE_WATCHDOG_ALARM);
  if (!current) chrome.alarms.create(QUEUE_WATCHDOG_ALARM, { periodInMinutes: QUEUE_WATCHDOG_MINUTES });
}

function reconcileQueueObservers() {
  const run = queueReconcilePromise.then(reconcileQueueObserversNow);
  queueReconcilePromise = run.catch(() => {});
  return run;
}

async function reconcileQueueObserversNow() {
  const stored = await chrome.storage.local.get([QUEUE_STORAGE_KEY_V051, QUEUE_OBSERVER_STORAGE_KEY]);
  const queues = stored[QUEUE_STORAGE_KEY_V051] || {};
  const observers = { ...(stored[QUEUE_OBSERVER_STORAGE_KEY] || {}) };
  const tabs = await queryQueueChatTabs();
  const now = Date.now();
  let changed = false;

  for (const [key, observer] of Object.entries(observers)) {
    const tab = tabs.find((candidate) => candidate.id === observer.tabId);
    if (!tab) {
      delete observers[key];
      changed = true;
      continue;
    }
    observer.url = tab.url || observer.url;
    observer.windowId = tab.windowId;
  }

  for (const [key, rawQueue] of Object.entries(queues)) {
    const queue = normalizeBackgroundQueue(rawQueue, key);
    const active = isBackgroundQueueActive(queue);
    const observer = observers[key];
    const matchingTabs = tabs.filter((tab) => queueTabMatches(tab, key, queue.conversationUrl));

    if (active) {
      if (observer) {
        if (observer.cleanupAt) changed = true;
        observer.cleanupAt = 0;
        observers[key] = observer;
        try {
          await chrome.tabs.update(observer.tabId, { muted: true, autoDiscardable: false });
        } catch {}
        continue;
      }
      if (matchingTabs.length) continue;
      const created = await createQueueObserverTab(key, queue.conversationUrl);
      if (created) {
        const createdTab = created.tab;
        delete created.tab;
        observers[key] = created;
        changed = true;
        tabs.push(createdTab);
      }
      continue;
    }

    if (!observer) continue;
    if (!observer.cleanupAt) {
      observer.cleanupAt = now + QUEUE_CLEANUP_GRACE_MS;
      observers[key] = observer;
      changed = true;
      continue;
    }
    if (observer.cleanupAt > now) continue;
    delete observers[key];
    changed = true;
    try { await chrome.tabs.remove(observer.tabId); } catch {}
  }

  for (const [key, observer] of Object.entries(observers)) {
    if (queues[key]) continue;
    delete observers[key];
    changed = true;
    try { await chrome.tabs.remove(observer.tabId); } catch {}
  }

  if (changed) await chrome.storage.local.set({ [QUEUE_OBSERVER_STORAGE_KEY]: observers });
}

function normalizeBackgroundQueue(queue = {}, key = "") {
  const items = Array.isArray(queue.items) ? queue.items : [];
  return {
    conversationKey: key || String(queue.conversationKey || ""),
    conversationUrl: String(queue.conversationUrl || ""),
    paused: Boolean(queue.paused),
    activeItemId: queue.activeItemId || null,
    items
  };
}

function isBackgroundQueueActive(queue) {
  const hasRunning = Boolean(queue.activeItemId) || queue.items.some((item) => ["dispatching", "running"].includes(item?.status));
  const hasPending = queue.items.some((item) => item?.status === "pending");
  return hasRunning || (!queue.paused && hasPending);
}

async function queryQueueChatTabs() {
  const windows = await chrome.windows.getAll({ populate: true, windowTypes: ["normal"] });
  return windows.flatMap((win) => win.tabs || []).filter((tab) => {
    try {
      const hostname = new URL(tab.url || "").hostname;
      return hostname === "chatgpt.com" || hostname === "chat.openai.com";
    } catch {
      return false;
    }
  });
}

function queueTabMatches(tab, key, url) {
  if (!tab?.url) return false;
  const tabKey = queueKeyFromUrl(tab.url);
  if (key.startsWith("c:") || key.startsWith("share:") || key.startsWith("path:")) return tabKey === key;
  return normalizeQueueUrl(tab.url) === normalizeQueueUrl(url);
}

function queueKeyFromUrl(value) {
  try {
    const url = new URL(value);
    const conversation = url.pathname.match(/(?:^|\/)c\/([^/?#]+)/);
    if (conversation) return `c:${conversation[1]}`;
    const share = url.pathname.match(/(?:^|\/)share\/([^/?#]+)/);
    if (share) return `share:${share[1]}`;
    const path = url.pathname.replace(/\/+$/, "") || "/";
    if (path !== "/") return `path:${path}`;
  } catch {}
  return "";
}

function normalizeQueueUrl(value) {
  try {
    const url = new URL(value || "https://chatgpt.com/");
    url.hash = "";
    return `${url.origin}${url.pathname.replace(/\/+$/, "") || "/"}${url.search}`;
  } catch {
    return String(value || "");
  }
}

async function createQueueObserverTab(key, url) {
  if (!isQueueChatUrl(url)) return null;
  const windows = await chrome.windows.getAll({ windowTypes: ["normal"] });
  const target = windows.find((win) => win.focused) || windows[0];
  if (!target?.id) return null;

  let tab = null;
  try {
    tab = await chrome.tabs.create({ windowId: target.id, url, active: false, index: 999 });
    await chrome.tabs.update(tab.id, { active: false, muted: true, autoDiscardable: false });
    let groupId = null;
    if (typeof getOrCreateMonitorGroup === "function") {
      try { groupId = await getOrCreateMonitorGroup(target.id, tab.id, null); } catch {}
      if (typeof collapseMonitorGroup === "function") {
        try { await collapseMonitorGroup(groupId); } catch {}
      }
    }
    return {
      tabId: tab.id,
      windowId: tab.windowId,
      groupId,
      url,
      createdAt: Date.now(),
      cleanupAt: 0,
      tab
    };
  } catch (error) {
    if (tab?.id) {
      try { await chrome.tabs.remove(tab.id); } catch {}
    }
    console.warn("[ChatGPT Message Queue] background tab create failed", key, error);
    return null;
  }
}

function isQueueChatUrl(value) {
  try {
    const url = new URL(value || "");
    return url.protocol === "https:" && (url.hostname === "chatgpt.com" || url.hostname === "chat.openai.com");
  } catch {
    return false;
  }
}

async function removeQueueObserverMapping(tabId) {
  const { [QUEUE_OBSERVER_STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(QUEUE_OBSERVER_STORAGE_KEY);
  const next = { ...stored };
  let changed = false;
  for (const [key, observer] of Object.entries(next)) {
    if (observer?.tabId !== tabId) continue;
    delete next[key];
    changed = true;
  }
  if (changed) await chrome.storage.local.set({ [QUEUE_OBSERVER_STORAGE_KEY]: next });
}

async function promoteQueueObserverTab(tabId) {
  const { [QUEUE_OBSERVER_STORAGE_KEY]: stored = {} } = await chrome.storage.local.get(QUEUE_OBSERVER_STORAGE_KEY);
  const entry = Object.entries(stored).find(([, observer]) => observer?.tabId === tabId);
  if (!entry) return;
  const [key, observer] = entry;
  const next = { ...stored };
  delete next[key];
  await chrome.storage.local.set({ [QUEUE_OBSERVER_STORAGE_KEY]: next });
  try {
    if (Number.isInteger(observer.groupId) && observer.groupId >= 0) await chrome.tabs.ungroup(tabId);
  } catch {}
  try { await chrome.tabs.update(tabId, { muted: false, autoDiscardable: true }); } catch {}
}
