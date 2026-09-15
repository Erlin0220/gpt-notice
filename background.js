importScripts("queue-core.js", "usage-core.js");
const Queue = globalThis.ChatGPTQueueCore;
const Usage = globalThis.ChatGPTUsage;
let mutations = Promise.resolve();
const serial = fn => {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
};
const PAGE_URLS = [...Queue.HOSTS].map(host => `https://${host}/*`);
const REQUEST_PREFIX = "notice:request:";
const CLEANUP_KEY = "notice:last-cleanup";
const REQUEST_TTL = 10 * 60_000;
const REQUEST_FILTER = {
  urls: [...Queue.HOSTS].flatMap(host => [
    `https://${host}/backend-api/f/conversation*`, `https://${host}/backend-api/conversation*`
  ]), types: ["xmlhttprequest"]
};
const nativePost = details => {
  if (details.method !== "POST") return false;
  try {
    const url = new URL(details.url);
    return url.protocol === "https:" && Queue.HOSTS.has(url.hostname) && /^\/backend-api\/(?:f\/)?conversation$/.test(url.pathname);
  } catch { return false; }
};
const trustedOrigin = value => {
  try { const url = new URL(value); return url.protocol === "https:" && Queue.HOSTS.has(url.hostname) && url.origin === value; }
  catch { return false; }
};
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
  const preview = cleanNoticePreview(meta.response, 160) || "\u56de\u590d\u5df2\u5b8c\u6210";
  return {
    title: cleanNoticeText(meta.prompt, 56) || "ChatGPT \u56de\u590d\u5b8c\u6210",
    message: `${formatElapsed(meta.elapsedMs)} \u00b7 ${preview}`
  };
}
function genericCompletionNotice(meta = {}) {
  return {
    title: cleanNoticeText(meta.prompt, 56) || "ChatGPT 有新结果",
    message: `${formatElapsed(meta.elapsedMs)} · 点击查看对话`
  };
}
function completionPublication(state, hidden, meta = {}) {
  if (["stale", "running", "unavailable"].includes(state)) return null;
  if (hidden === true) return { kind: "generic", payload: genericCompletionNotice(meta) };
  if (state === "completed") return { kind: "completed", payload: completionNotice({ notice: meta }) };
  if (state === "attention") return {
    kind: "attention",
    payload: {
      title: cleanNoticeText(meta.prompt, 56) || "ChatGPT 需要你处理",
      message: `${formatElapsed(meta.elapsedMs)} · 等待确认或继续操作`
    }
  };
  if (state === "failed") return {
    kind: "failed",
    payload: {
      title: cleanNoticeText(meta.prompt, 56) || "ChatGPT 回复异常",
      message: `${formatElapsed(meta.elapsedMs)} · 回复出现异常，点击查看对话`
    }
  };
  return null;
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
function submittedConversation(details) {
  if (!nativePost(details) || !Number.isInteger(details.tabId) || details.tabId < 0 || details.frameId !== 0 || !details.documentId || !/^[\w.-]{1,100}$/.test(details.requestId || "")) return null;
  if (!trustedOrigin(details.initiator || "")) return null;
  const body = requestJson(details.requestBody);
  const model = String(body?.model || "").slice(0, 120);
  if (body?.action !== "next") return null;
  const message = [...(Array.isArray(body.messages) ? body.messages : [])].reverse().find(item => item?.author?.role === "user");
  const turnId = String(message?.id || "");
  if (!/^[\w:-]{1,220}$/.test(turnId)) return null;
  // Prompt/attachment/response content is never retained. This correlation is
  // transport metadata only and is cleared at request completion/error.
  return { turnId, model, tabId: details.tabId, documentId: details.documentId, requestId: details.requestId, at: Date.now() };
}
async function captureRequest(observation) {
  const context = await pageContext(observation.tabId, observation.documentId);
  if (!context) return;
  await pruneStorage().catch(() => {});
  let finalQueueRequest = false;
  const route = Queue.route(context.url);
  if (route.mode === "conversation") {
    const queueKey = Queue.key(context.scope, context.url);
    const queue = queueKey ? (await chrome.storage.local.get(queueKey))[queueKey] : null;
    const item = queue?.items?.length === 1 ? queue.items[0] : null;
    finalQueueRequest = Boolean(item && item.state === "sending" && item.phase === "submitting" && String(item.owner || "").startsWith(`${observation.tabId}:${observation.documentId}:`));
  }
  await chrome.storage.session.set({
    [REQUEST_PREFIX + observation.requestId]: { ...observation, scope: context.scope, url: context.url, finalQueueRequest, sentAt: 0 }
  });
}
function readUsage(raw) {
  try { return Usage.apply(raw, { op: "get" }); }
  catch { return { state: raw && typeof raw === "object" ? raw : { version: 0, revision: 0 }, changed: false }; }
}
async function recordSubmittedUsage(details) {
  const key = REQUEST_PREFIX + details.requestId;
  const observation = (await chrome.storage.session.get(key))[key];
  if (!observation || observation.tabId !== details.tabId || observation.documentId !== details.documentId || Date.now() - observation.at > REQUEST_TTL) return;
  const sentAt = Date.now();
  await chrome.storage.session.set({ [key]: { ...observation, sentAt } });
  if (!Usage.MODELS.has(observation.model)) return;
  const context = await pageContext(details.tabId, details.documentId);
  if (context?.scope !== observation.scope) return;
  const usageKey = Usage.PREFIX + observation.scope;
  const stored = await chrome.storage.local.get(usageKey);
  const result = Usage.apply(stored[usageKey], { op: "record", turnId: observation.turnId, model: observation.model, at: sentAt });
  if (result.changed) await chrome.storage.local.set({ [usageKey]: result.state });
}

chrome.runtime.onMessage.addListener((message, sender, reply) => {
  serial(() => handle(message, sender)).then(reply, error => reply({ ok: false, error: error.message }));
  return true;
});
chrome.webRequest.onBeforeRequest.addListener(details => {
  const observation = submittedConversation(details);
  if (observation) void serial(() => captureRequest(observation)).catch(() => {});
}, REQUEST_FILTER, ["requestBody"]);
// onBeforeRequest precedes connection establishment and cancellation. Count at
// the last read-only send boundary, not on a click or an attempted request.
chrome.webRequest.onSendHeaders.addListener(details => {
  if (!nativePost(details)) return;
  void serial(() => recordSubmittedUsage(details)).catch(() => {});
}, REQUEST_FILTER);
chrome.webRequest.onCompleted.addListener(details => {
  if (nativePost(details)) void serial(() => completeConversationRequest(details)).catch(() => {});
}, REQUEST_FILTER);
chrome.webRequest.onErrorOccurred.addListener(details => {
  if (nativePost(details)) void serial(() => chrome.storage.session.remove(REQUEST_PREFIX + details.requestId)).catch(() => {});
}, REQUEST_FILTER);
chrome.notifications.onClicked.addListener(id => void serial(() => openNotice(id)).catch(() => {}));
chrome.notifications.onClosed.addListener((id, byUser) => { if (byUser) void serial(() => markNoticeClosed(id)).catch(() => {}); });

async function handle(message, sender) {
  if (message?.type === "NOTICE_POPUP") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可读取概览");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PAGE_URLS });
    const context = tab && await pageContext(tab.id);
    const stored = await chrome.storage.local.get(null);
    const queues = context ? Object.entries(stored).filter(([k]) => k.startsWith(`${Queue.PREFIX}${context.scope}:`)).map(([k, q]) => ({ key: k, url: q?.url, count: q?.items?.length || 0, paused: q?.paused })).filter(q => q.count && Queue.route(q.url).mode === "conversation") : [];
    return { ok: true, queues, scopeKnown: Boolean(context), enabled: stored["notice:notifications"] !== false, permission: await chrome.notifications.getPermissionLevel() };
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
    const usage = readUsage(stored[usageKey]);
    if (usage.changed) await chrome.storage.local.set({ [usageKey]: usage.state });
    return { ok: true, queue: null, usage: usage.state };
  }
  const stored = await chrome.storage.local.get([queueKey, usageKey, "notice:notifications"]);
  const raw = stored[queueKey];
  let command = message.command || { op: "get" };
  if (command.op === "start" && raw?.turn && !raw.turn.done && !raw.turn.source) {
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
  const usage = readUsage(stored[usageKey]);
  const writes = {};
  if (usage.changed) writes[usageKey] = usage.state;
  if (result.changed) {
    result.state.url = route.url;
    writes[queueKey] = result.state;
  }
  const notificationId = result.notify && stored["notice:notifications"] !== false ? noticeId(message.scope, route.id, command.generationId || command.userId) : "";
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  let notificationError = "";
  if (notificationId) {
    const publication = completionPublication("completed", command.notice?.hidden === true, command.notice);
    notificationError = await publishNotice(notificationId, {
      url: route.url, scope: message.scope, tabId: sender.tab.id
    }, publication.payload, publication.kind);
    await pruneNotices().catch(() => {});
  }
  return { ok: true, queue: result.state, usage: usage.state, item: result.item, conflict: result.conflict, notificationError };
}

const NOTICE_RANK = { generic: 1, attention: 2, failed: 3, completed: 4 };
const noticeKey = id => `notice:notification:${id}`;
const noticeId = (scope, routeId, generationId) => `notice:${scope.slice(0,16)}:${routeId}:${generationId}`;

async function publishNotice(id, routing, payload, kind) {
  const key = noticeKey(id);
  const stored = await chrome.storage.local.get([key, "notice:notifications"]);
  if (stored["notice:notifications"] === false) return "";
  const previous = stored[key];
  if (previous?.dismissedAt || previous?.closedAt || previous?.consumedAt || (NOTICE_RANK[previous?.kind] || 0) >= (NOTICE_RANK[kind] || 0)) return "";
  const options = {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/chatgpt.png"),
    title: payload.title, message: payload.message, priority: 0
  };
  const routingRecord = { ...previous, ...routing, at: previous?.at || Date.now() };
  try {
    // Persist only routing before the OS call. The delivered rank is written
    // after create/update succeeds, so a failed notification remains retryable.
    await chrome.storage.local.set({ [key]: routingRecord });
    const updated = previous ? await chrome.notifications.update(id, options) : false;
    if (!updated) await chrome.notifications.create(id, options);
    await chrome.storage.local.set({ [key]: { ...routingRecord, kind } });
    return "";
  } catch (error) {
    return String(error?.message || error || "notification failed");
  }
}

async function markNoticeClosed(id) {
  const key = noticeKey(id);
  const notice = (await chrome.storage.local.get(key))[key];
  if (notice && !notice.dismissedAt) await chrome.storage.local.set({ [key]: { ...notice, dismissedAt: Date.now() } });
}

async function completionProbe(observation, route) {
  let timer;
  try {
    const value = await Promise.race([
      chrome.tabs.sendMessage(observation.tabId, {
        type: "NOTICE_COMPLETION_PROBE", scope: observation.scope, turnId: observation.turnId
      }, { frameId: 0, documentId: observation.documentId }),
      new Promise(resolve => { timer = setTimeout(() => resolve({ state: "unavailable" }), 700); })
    ]);
    if (!value || value.state === "unavailable") return value || { state: "stale" };
    if (value.scope !== observation.scope) return { state: "stale" };
    const probedRoute = Queue.route(value.url);
    if (probedRoute.mode !== "conversation" || probedRoute.id !== route.id) return { state: "stale" };
    return value;
  } catch {
    // An immediate sendMessage failure means the exact document no longer exists.
    // A timeout or missing document is not evidence that the reply completed.
    return { state: "stale" };
  } finally {
    clearTimeout(timer);
  }
}

async function networkNoticeEligible(observation, route) {
  const queueKey = Queue.key(observation.scope, route.url);
  if (!queueKey) return true;
  const queue = (await chrome.storage.local.get(queueKey))[queueKey];
  if (!queue?.items?.length) return true;
  if (!observation.finalQueueRequest || queue.items.length !== 1) return false;
  const item = queue.items[0];
  return item.state === "sending" && item.phase === "submitting" && String(item.owner || "").startsWith(`${observation.tabId}:${observation.documentId}:`);
}

async function completeConversationRequest(details) {
  const key = REQUEST_PREFIX + details.requestId;
  const observation = (await chrome.storage.session.get(key))[key];
  await chrome.storage.session.remove(key);
  if (!observation || !observation.sentAt || observation.tabId !== details.tabId || observation.documentId !== details.documentId || Date.now() - observation.at > REQUEST_TTL) return;
  if (!Number.isFinite(details.statusCode) || details.statusCode < 200 || details.statusCode >= 300) return;

  let tab;
  try { tab = await chrome.tabs.get(observation.tabId); } catch { return; }
  const route = Queue.route(tab?.url);
  const originRoute = Queue.route(observation.url);
  if (route.mode !== "conversation" || originRoute.mode === "conversation" && originRoute.id !== route.id) return;
  const notificationEligible = await networkNoticeEligible(observation, route);

  const probe = tab?.discarded ? { state: "unavailable" } : await completionProbe(observation, route);
  if (!notificationEligible) return;
  const elapsedMs = Math.max(0, Date.now() - (observation.sentAt || observation.at));
  const generationId = /^[\w:-]{1,300}$/.test(probe?.generationId || "") ? probe.generationId : observation.turnId;
  const id = noticeId(observation.scope, route.id, generationId);
  const publication = completionPublication(probe?.state, probe?.hidden === true, {
    prompt: probe?.prompt, response: probe?.response, elapsedMs
  });
  if (!publication) return;

  await publishNotice(id, { url: route.url, scope: observation.scope, tabId: observation.tabId }, publication.payload, publication.kind);
  await pruneNotices().catch(() => {});
}

async function openNotice(id) {
  const key = noticeKey(id);
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
  await chrome.storage.local.set({ [key]: { ...notice, dismissedAt: Date.now() } });
  await chrome.notifications.clear(id);
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
