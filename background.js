importScripts("queue-core.js", "usage-core.js");
const Queue = globalThis.ChatGPTQueueCore;
const Usage = globalThis.ChatGPTUsage;
let mutations = Promise.resolve();
const serial = fn => {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
};

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.notifications.onClicked.addListener(id => void openNotice(id));
chrome.notifications.onButtonClicked.addListener(id => void openNotice(id));
chrome.notifications.onClosed.addListener(id => void chrome.storage.local.remove(`notice:notification:${id}`));

async function handle(message, sender) {
  if (message?.type === "NOTICE_POPUP") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可读取概览");
    const stored = await chrome.storage.local.get(null);
    const queues = Object.entries(stored).filter(([k]) => k.startsWith(Queue.PREFIX)).map(([k, q]) => ({ key: k, url: q.url, count: q.items?.length || 0, paused: q.paused })).filter(q => q.count);
    return { ok: true, queues, enabled: stored["notice:notifications"] !== false };
  }
  if (message?.type === "NOTICE_SETTING") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可修改设置");
    await chrome.storage.local.set({ "notice:notifications": message.enabled !== false });
    return { ok: true };
  }
  if (message?.type !== "NOTICE" || !Number.isInteger(sender.tab?.id) || !/^[a-f0-9]{64}$/.test(message.scope || "")) throw new Error("无效的页面上下文");
  const route = Queue.route(message.url);
  const actual = Queue.route((await chrome.tabs.get(sender.tab.id)).url);
  if (route.mode === "off" || route.mode !== actual.mode || route.id !== actual.id) throw new Error("页面已切换，操作已取消");
  const usageKey = Usage.PREFIX + message.scope;
  const queueKey = Queue.key(message.scope, message.url);
  const owner = `${sender.tab.id}:${sender.documentId || "document"}:${String(message.instance || "").slice(0,80)}`;
  if (message.usage) {
    const stored = await chrome.storage.local.get(usageKey);
    const result = Usage.apply(stored[usageKey], message.usage);
    if (result.changed) await chrome.storage.local.set({ [usageKey]: result.state });
    return { ok: true, usage: result.state };
  }
  if (!queueKey) {
    if (message.command?.op && message.command.op !== "get") throw new Error("仅正式对话支持 Queue");
    const stored = await chrome.storage.local.get(usageKey);
    const usage = Usage.apply(stored[usageKey], { op: "get" });
    if (usage.changed) await chrome.storage.local.set({ [usageKey]: usage.state });
    return { ok: true, queue: null, usage: usage.state };
  }
  const stored = await chrome.storage.local.get([queueKey, usageKey, "notice:notifications"]);
  const raw = stored[queueKey];
  let result;
  try { result = Queue.apply(raw, message.command || { op: "get" }, owner); }
  catch (error) {
    // Persist lease expiry even when a subsequent operation is rejected.
    const recovered = Queue.apply(raw, { op: "get" }, owner);
    if (recovered.changed) await chrome.storage.local.set({ [queueKey]: recovered.state });
    throw error;
  }
  const usage = Usage.apply(stored[usageKey], { op: "get" });
  const writes = {};
  if (usage.changed) writes[usageKey] = usage.state;
  if (result.changed) {
    result.state.url = route.url;
    writes[queueKey] = result.state;
  }
  const notificationId = result.notify && stored["notice:notifications"] !== false ? `notice:${message.scope.slice(0,16)}:${route.id}:${message.command.generationId || message.command.userId}` : "";
  if (notificationId) writes[`notice:notification:${notificationId}`] = { url: route.url, scope: message.scope, tabId: sender.tab.id, at: Date.now() };
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  let notificationError = "";
  if (notificationId) {
    try {
      await chrome.notifications.create(notificationId, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/chatgpt.png"),
        title: "ChatGPT 已完成", message: "当前回复已结束，Queue 已空。点击返回对应对话。", priority: 1
      });
    } catch (error) { notificationError = error.message; }
    await pruneNotices();
  }
  return { ok: true, queue: result.state, usage: usage.state, item: result.item, notificationError };
}

async function openNotice(id) {
  const key = `notice:notification:${id}`;
  const notice = (await chrome.storage.local.get(key))[key];
  if (!notice || Queue.route(notice.url).mode !== "conversation") return;
  const desired = Queue.route(notice.url).id;
  const tabs = await chrome.tabs.query({ url: ["https://chatgpt.com/*", "https://chat.openai.com/*"] });
  // A reused tab may now contain a different conversation.
  const tab = tabs.find(t => t.id === notice.tabId && Queue.route(t.url).id === desired) || tabs.find(t => Queue.route(t.url).id === desired);
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else await chrome.tabs.create({ url: notice.url, active: true });
  await chrome.notifications.clear(id);
  await chrome.storage.local.remove(key);
}

async function pruneNotices() {
  const stored = await chrome.storage.local.get(null);
  const notices = Object.entries(stored).filter(([key]) => key.startsWith("notice:notification:"))
    .sort((a, b) => (b[1].at || 0) - (a[1].at || 0));
  const expired = notices.filter(([, value], index) => index >= 100 || Date.now() - value.at > 7 * 86400000).map(([key]) => key);
  if (expired.length) {
    await Promise.all(expired.map(key => chrome.notifications.clear(key.slice("notice:notification:".length))));
    await chrome.storage.local.remove(expired);
  }
}

// Old storage is an inert backup. No background task runtime or queue migration.
