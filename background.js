importScripts("queue-core.js", "usage-core.js");
const Queue = globalThis.ChatGPTQueueCore;
const Usage = globalThis.ChatGPTUsage;
let mutations = Promise.resolve();
const serial = fn => {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
};
const PAGE_URLS = ["https://chatgpt.com/*", "https://chat.openai.com/*"];
const REQUEST_PREFIX = "notice:request:";
const CLEANUP_KEY = "notice:last-cleanup";
const REQUEST_TTL = 10 * 60_000;
const REQUEST_FILTER = {
  urls: ["chatgpt.com", "chat.openai.com"].flatMap(host => [
    `https://${host}/backend-api/f/conversation*`, `https://${host}/backend-api/conversation*`
  ]), types: ["xmlhttprequest"]
};
const nativePost = details => details.method === "POST" && /^https:\/\/(?:chatgpt\.com|chat\.openai\.com)\/backend-api\/(?:f\/)?conversation(?:\?|$)/.test(details.url);
let lastCleanup = 0;
const cleanNoticeText = (value, max) => String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
function cleanNoticePreview(value, max = 220) {
  const text = String(value ?? "")
    .replace(/```[\s\S]*?```/g, "\n\n")
    .replace(/`([^`]+)`/g, "$1")
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/^\s{0,3}(?:#{1,6}\s+|>\s+|[-*+]\s+|\d+[.)]\s+)/gm, "")
    .replace(/\*\*([^*]+)\*\*/g, "$1")
    .replace(/__([^_]+)__/g, "$1")
    .replace(/~~([^~]+)~~/g, "$1");
  const paragraph = text.split(/\n\s*\n/).map(part => part.replace(/\s+/g, " ").trim()).find(Boolean) || "";
  return paragraph.slice(0, max);
}
function formatElapsed(elapsedMs) {
  const totalSeconds = Math.max(1, Math.round(Number(elapsedMs || 0) / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return minutes ? `${minutes}m ${seconds}s` : `${seconds}s`;
}
function completionNotice(command) {
  const meta = command?.notice || {};
  const preview = cleanNoticePreview(meta.preview, 160) || "\u56de\u590d\u5df2\u5b8c\u6210";
  return {
    title: cleanNoticeText(meta.title, 56) || "ChatGPT \u56de\u590d\u5b8c\u6210",
    message: `${formatElapsed(meta.elapsedMs)} \u00b7 ${preview}`
  };
}
async function pageContext(tabId, documentId) {
  // Tab IDs survive worker restarts, but are not account/document identities.
  // Ask the exact live document; never reuse an unbounded tab -> account cache.
  let timer;
  try {
    const value = await Promise.race([
      chrome.tabs.sendMessage(tabId, { type: "NOTICE_SCOPE" }, { frameId: 0, ...(documentId ? { documentId } : {}) }),
      new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000); })
    ]);
    return /^[a-f0-9]{64}$/.test(value?.scope || "") && Queue.route(value.url).mode !== "off" ? value : null;
  } catch { return null; }
  finally { clearTimeout(timer); }
}
function requestJson(requestBody) {
  const parts = requestBody?.raw;
  if (!parts?.length || parts.some(part => !part.bytes || part.file) || parts.reduce((n, part) => n + part.bytes.byteLength, 0) > 2_000_000) return null;
  try {
    const decoder = new TextDecoder("utf-8", { fatal: true });
    return JSON.parse(parts.map(part => decoder.decode(part.bytes, { stream: true })).join("") + decoder.decode());
  } catch { return null; }
}
function submittedUsage(details) {
  if (!nativePost(details) || !Number.isInteger(details.tabId) || details.tabId < 0 || details.frameId !== 0 || !details.documentId || !/^[\w.-]{1,100}$/.test(details.requestId || "")) return null;
  if (!/^https:\/\/(?:chatgpt\.com|chat\.openai\.com)$/.test(details.initiator || "")) return null;
  const body = requestJson(details.requestBody);
  const model = String(body?.model || "");
  if (body?.action !== "next" || !Usage.MODELS.has(model)) return null;
  const message = [...(Array.isArray(body.messages) ? body.messages : [])].reverse().find(item => item?.author?.role === "user");
  const turnId = String(message?.id || "");
  if (!/^[\w:-]{1,220}$/.test(turnId)) return null;
  // No prompt, attachment, headers, response, token or account ID is retained.
  return { turnId, model, tabId: details.tabId, documentId: details.documentId, requestId: details.requestId, at: Date.now() };
}
async function captureUsage(observation) {
  const context = await pageContext(observation.tabId, observation.documentId);
  if (!context) return;
  await pruneStorage().catch(() => {});
  await chrome.storage.session.set({ [REQUEST_PREFIX + observation.requestId]: { ...observation, scope: context.scope } });
}
async function recordSubmittedUsage(details) {
  const key = REQUEST_PREFIX + details.requestId;
  const observation = (await chrome.storage.session.get(key))[key];
  if (!observation || observation.tabId !== details.tabId || observation.documentId !== details.documentId || Date.now() - observation.at > REQUEST_TTL) return;
  const context = await pageContext(details.tabId, details.documentId);
  if (context?.scope !== observation.scope) { await chrome.storage.session.remove(key); return; }
  const usageKey = Usage.PREFIX + observation.scope;
  const stored = await chrome.storage.local.get(usageKey);
  const result = Usage.apply(stored[usageKey], { op: "record", turnId: observation.turnId, model: observation.model, at: Date.now() });
  if (result.changed) await chrome.storage.local.set({ [usageKey]: result.state });
  await chrome.storage.session.remove(key);
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.webRequest.onBeforeRequest.addListener(details => {
  const observation = submittedUsage(details);
  if (observation) void serial(() => captureUsage(observation)).catch(() => {});
}, REQUEST_FILTER, ["requestBody"]);
// onBeforeRequest precedes connection establishment and cancellation. Count at
// the last read-only send boundary, not on a click or an attempted request.
chrome.webRequest.onSendHeaders.addListener(details => {
  if (!nativePost(details)) return;
  void serial(() => recordSubmittedUsage(details)).catch(() => {});
}, REQUEST_FILTER);
for (const event of [chrome.webRequest.onCompleted, chrome.webRequest.onErrorOccurred]) {
  event.addListener(details => { if (nativePost(details)) void serial(() => chrome.storage.session.remove(REQUEST_PREFIX + details.requestId)).catch(() => {}); }, REQUEST_FILTER);
}
chrome.notifications.onClicked.addListener(id => void openNotice(id).catch(() => {}));
chrome.notifications.onClosed.addListener(id => void chrome.storage.local.remove(`notice:notification:${id}`).catch(() => {}));

async function handle(message, sender) {
  if (message?.type === "NOTICE_POPUP") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可读取概览");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PAGE_URLS });
    const context = tab && await pageContext(tab.id);
    const stored = await chrome.storage.local.get(null);
    const queues = context ? Object.entries(stored).filter(([k]) => k.startsWith(`${Queue.PREFIX}${context.scope}:`)).map(([k, q]) => ({ key: k, url: q?.url, count: q?.items?.length || 0, paused: q?.paused })).filter(q => q.count && Queue.route(q.url).mode === "conversation") : [];
    return { ok: true, queues, scopeKnown: Boolean(context), enabled: stored["notice:notifications"] !== false };
  }
  if (message?.type === "NOTICE_SETTING") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可修改设置");
    await chrome.storage.local.set({ "notice:notifications": message.enabled !== false });
    return { ok: true };
  }
  if (message?.type !== "NOTICE" || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || !sender.documentId || !/^[a-f0-9]{64}$/.test(message.scope || "")) throw new Error("无效的页面上下文");
  const route = Queue.route(message.url);
  const actual = Queue.route((await chrome.tabs.get(sender.tab.id)).url);
  if (route.mode === "off" || route.mode !== actual.mode || route.id !== actual.id) throw new Error("页面已切换，操作已取消");
  const context = await pageContext(sender.tab.id, sender.documentId);
  const liveRoute = Queue.route(context?.url);
  if (context?.scope !== message.scope || liveRoute.mode !== route.mode || liveRoute.id !== route.id) throw new Error("账号、Workspace 或页面已切换，操作已取消");
  const usageKey = Usage.PREFIX + message.scope;
  const queueKey = Queue.key(message.scope, message.url);
  await pruneStorage(queueKey).catch(() => {});
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
  let command = message.command || { op: "get" };
  if (command.op === "start") {
    const tabs = await chrome.tabs.query({ url: PAGE_URLS });
    const sameConversation = tabs.filter(tab => Queue.route(tab.url).id === route.id);
    command = { ...command, singleTab: sameConversation.length === 1 };
  }
  let result;
  try { result = Queue.apply(raw, command, owner); }
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
  const notificationId = result.notify && stored["notice:notifications"] !== false ? `notice:${message.scope.slice(0,16)}:${route.id}:${command.generationId || command.userId}` : "";
  if (notificationId) writes[`notice:notification:${notificationId}`] = { url: route.url, scope: message.scope, tabId: sender.tab.id, at: Date.now() };
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  let notificationError = "";
  if (notificationId) {
    try {
      const notice = completionNotice(command);
      await chrome.notifications.create(notificationId, {
        type: "basic", iconUrl: chrome.runtime.getURL("icons/chatgpt.png"),
        title: notice.title, message: notice.message, priority: 0
      });
    } catch (error) { notificationError = error.message; }
    await pruneNotices().catch(() => {});
  }
  return { ok: true, queue: result.state, usage: usage.state, item: result.item, conflict: result.conflict, notificationError };
}

async function openNotice(id) {
  const key = `notice:notification:${id}`;
  const notice = (await chrome.storage.local.get(key))[key];
  if (!notice || Queue.route(notice.url).mode !== "conversation") return;
  const desired = Queue.route(notice.url).id;
  const tabs = await chrome.tabs.query({ url: PAGE_URLS });
  // A reused tab may now contain a different conversation.
  const candidates = tabs.filter(t => Queue.route(t.url).id === desired).sort((a, b) => Number(b.id === notice.tabId) - Number(a.id === notice.tabId));
  let tab;
  for (const candidate of candidates) {
    if ((await pageContext(candidate.id))?.scope === notice.scope) { tab = candidate; break; }
  }
  if (tab) {
    await chrome.tabs.update(tab.id, { active: true });
    await chrome.windows.update(tab.windowId, { focused: true });
  } else {
    const [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PAGE_URLS });
    if (!active || (await pageContext(active.id))?.scope !== notice.scope) return;
    await chrome.tabs.create({ url: notice.url, active: true });
  }
  await chrome.notifications.clear(id);
  await chrome.storage.local.remove(key);
}

async function pruneNotices(stored) {
  stored ||= await chrome.storage.local.get(null);
  const notices = Object.entries(stored).filter(([key]) => key.startsWith("notice:notification:"))
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
  const expired = notices.filter(([, value], index) => index >= 100 || !Number.isFinite(value?.at) || Date.now() - value.at > 7 * 86400000).map(([key]) => key);
  if (expired.length) {
    await Promise.all(expired.map(key => chrome.notifications.clear(key.slice("notice:notification:".length))));
    await chrome.storage.local.remove(expired);
  }
}

async function pruneStorage(keepKey = "") {
  const now = Date.now();
  if (lastCleanup && now - lastCleanup < 3600_000) return;
  const previous = (await chrome.storage.session.get(CLEANUP_KEY))[CLEANUP_KEY];
  if (previous > 0 && previous <= now && now - previous < 3600_000) { lastCleanup = previous; return; }
  const stored = await chrome.storage.local.get(null);
  // Never expire user text, unresolved intent, explicit pause or an active turn.
  // Only empty, completed, inactive v8 bookkeeping can be reclaimed.
  const expired = Object.entries(stored).filter(([key, q]) => key !== keepKey && key.startsWith(Queue.PREFIX) && q?.version === 8 && Array.isArray(q.items) && q.items.length === 0 && !q.paused && !q.holdUntil && (!q.turn || q.turn.done === true) && q.updatedAt > 0 && now - q.updatedAt > 30 * 86400_000).map(([key]) => key);
  if (expired.length) await chrome.storage.local.remove(expired);
  await pruneNotices(stored);
  const session = await chrome.storage.session.get(null);
  const abandoned = Object.entries(session).filter(([key, value]) => key.startsWith(REQUEST_PREFIX) && (!Number.isFinite(value?.at) || now - value.at > REQUEST_TTL)).map(([key]) => key);
  if (abandoned.length) await chrome.storage.session.remove(abandoned);
  await chrome.storage.session.set({ [CLEANUP_KEY]: now });
  lastCleanup = now;
}

// Legacy storage is an inert backup: never migrate or delete unknown user data.
