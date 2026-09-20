importScripts("queue-core.js", "usage-core.js", "projects-core.js");
const Queue = globalThis.ChatGPTQueueCore;
const Usage = globalThis.ChatGPTUsage;
const Projects = globalThis.ChatGPTProjects;
let mutations = Promise.resolve();
const serial = fn => {
  const next = mutations.then(fn, fn);
  mutations = next.catch(() => {});
  return next;
};
const PAGE_URLS = [...Queue.HOSTS].map(host => `https://${host}/*`);
const REQUEST_PREFIX = "notice:request:";
const CLEANUP_KEY = "notice:last-cleanup";
const COMPLETION_ALARM = "notice:completion-probe";
const REQUEST_TTL = 10 * 60_000;
const FEATURE_KEYS = {
  sidebarCollapse: "notice:sidebar-collapse-enabled",
  toolFold: "notice:tool-fold-enabled",
  queue: "notice:queue-enabled",
  notifications: "notice:notifications"
};
const HISTORY_GUARD_RULE_ID = 910001;
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
async function featureSettings() {
  const stored = await chrome.storage.local.get(Object.values(FEATURE_KEYS));
  return Object.fromEntries(Object.entries(FEATURE_KEYS).map(([name,key]) => [name, stored[key] !== false]));
}
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
  return minutes ? `${minutes} 分 ${seconds} 秒` : `${seconds} 秒`;
}
function completionPublication(state, hidden, meta = {}) {
  if (!["completed", "attention", "recoverable", "blocked", "failed"].includes(state)) return null;
  const kind = state === "completed" ? hidden ? "generic" : "completed" : state === "attention" ? "attention" : "failed";
  const label = state === "completed" ? meta.queueFinal ? "队列已完成" : "回复已完成" : state === "attention" ? "需要你确认" : "回复需要处理";
  const prompt = cleanNoticeText(meta.prompt, 48);
  return { kind, payload: {
    title: `${label}${prompt ? ` · ${prompt}` : ""}`,
    message: state === "completed" ? (!hidden && cleanNoticePreview(meta.response, 150)) || "回复已就绪，点击查看对话。" : state === "attention" ? "等待审批、确认或继续操作；请回到原生页面处理。" : state === "blocked" ? "限额、策略或账号受限；请处理原生提示后继续。" : "回复出现异常；请回到对话检查后继续。",
    contextMessage: `gpt-notice · 本轮用时 ${formatElapsed(meta.elapsedMs)}`
  } };
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
  await chrome.storage.session.set({
    [REQUEST_PREFIX + observation.requestId]: { ...observation, scope: context.scope, url: context.url, sentAt: 0, completedAt: 0 }
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
void serial(async () => {
  // Dynamic rules survive extension upgrades. Keep this permission for one
  // migration cycle solely to remove the superseded sidebar blocker; never add
  // another request rule.
  await chrome.declarativeNetRequest.updateDynamicRules({ removeRuleIds:[HISTORY_GUARD_RULE_ID] });
  await chrome.declarativeNetRequest.updateSessionRules({ removeRuleIds:[HISTORY_GUARD_RULE_ID] });
  const session = await chrome.storage.session.get(null);
  const obsolete = Object.keys(session).filter(k => k.startsWith("notice:history-allow-once:"));
  if (obsolete.length) await chrome.storage.session.remove(obsolete);
  // Only unfinished delivery records are revisited on wake. No timer/keepalive.
  const stored = await chrome.storage.local.get(null);
  const recovered = new Set();
  for (const [key, notice] of Object.entries(stored)) {
    if (!key.startsWith("notice:notification:") || !notice?.pendingKind) continue;
    const target = `${notice.scope}:${Queue.route(notice.url).id}`;
    if (recovered.has(target)) continue;
    const context = await pageContext(notice.tabId);
    if (context?.scope === notice.scope && Queue.route(context.url).id === Queue.route(notice.url).id) { recovered.add(target); await retryNotices(notice.scope, notice.url); }
  }
}).catch(() => {});
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
chrome.alarms.onAlarm.addListener(alarm => { if (alarm?.name === COMPLETION_ALARM) void serial(retryCompletionRequests).catch(() => {}); });
async function handle(message, sender) {
  if (message?.type === "NOTICE_POPUP") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可读取概览");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PAGE_URLS });
    const context = tab && await pageContext(tab.id);
    const stored = await chrome.storage.local.get(null);
    const queues = context ? Object.entries(stored).filter(([k]) => k.startsWith(`${Queue.PREFIX}${context.scope}:`)).map(([k, q]) => ({ key: k, url: q?.url, count: q?.items?.length || 0, paused: q?.paused })).filter(q => q.count && Queue.route(q.url).mode === "conversation") : [];
    const notices = context ? Object.entries(stored).filter(([k, n]) => k.startsWith("notice:notification:") && n?.scope === context.scope).map(([,n]) => n).sort((a,b) => b.at-a.at) : [];
    return { ok: true, queues, scopeKnown: Boolean(context), reloadable: Boolean(tab), settings: await featureSettings(), permission: await chrome.notifications.getPermissionLevel(), notification: { pending: notices.filter(n => n.pendingKind && !n.dismissedAt).length, lastAt: notices.find(n => n.kind)?.at || 0 } };
  }
  if (message?.type === "NOTICE_RELOAD_ACTIVE") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可刷新页面");
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true, url: PAGE_URLS });
    if (!tab?.id) throw new Error("当前没有可刷新的 ChatGPT 页面");
    await chrome.tabs.reload(tab.id);
    return { ok: true };
  }
  if (message?.type === "NOTICE_FEATURE_SETTING") {
    if (sender.url !== chrome.runtime.getURL("popup.html")) throw new Error("仅扩展面板可修改设置");
    const numeric = message.feature === "shortcutCount";
    const key = FEATURE_KEYS[message.feature] || numeric && "notice:shortcut-project-limit";
    if (!key) throw new Error("未知功能设置");
    const value = numeric ? Number(message.value) : message.enabled !== false;
    if (numeric && (!Number.isInteger(value) || value < 1 || value > 50)) throw new Error("数量须为 1-50");
    await chrome.storage.local.set({ [key]: value });
    if (message.feature === "notifications" && !value) {
      const stored = await chrome.storage.local.get(null), writes = {};
      for (const [k, n] of Object.entries(stored)) if (k.startsWith("notice:notification:") && n?.pendingKind) { delete n.pendingKind; delete n.pendingOutcome; writes[k] = n; }
      if (Object.keys(writes).length) await chrome.storage.local.set(writes);
    }
    return { ok: true, settings: await featureSettings() };
  }
  if (message?.type !== "NOTICE" || !Number.isInteger(sender.tab?.id) || sender.frameId !== 0 || !sender.documentId || !/^[a-f0-9]{64}$/.test(message.scope || "")) throw new Error("无效的页面上下文");
  const route = Queue.route(message.url);
  const actual = Queue.route((await chrome.tabs.get(sender.tab.id)).url);
  if (route.mode === "off" || route.mode !== actual.mode || route.id !== actual.id) throw new Error("页面已切换，操作已取消");
  const context = await pageContext(sender.tab.id, sender.documentId);
  const liveRoute = Queue.route(context?.url);
  if (context?.scope !== message.scope || liveRoute.mode !== route.mode || liveRoute.id !== route.id) throw new Error("账号、Workspace 或页面已切换，操作已取消");
  if (message.projects) {
    const key = Projects.PREFIX + message.scope;
    const stored = await chrome.storage.local.get(key);
    const result = Projects.merge(stored[key], message.projects, Date.now(), message.promoteProjectId);
    if (result.changed) await chrome.storage.local.set({ [key]: result.state });
    return { ok: true, projects: result.state };
  }
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
  const stored = await chrome.storage.local.get([queueKey, usageKey, "notice:notifications", FEATURE_KEYS.queue]);
  const raw = stored[queueKey];
  let command = { ...(message.command || { op: "get" }), queueEnabled: stored[FEATURE_KEYS.queue] !== false };
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
  const queueFinal = result.state.items.length === 0 && result.state.receipts.some(r => r.userId === command.userId);
  const publication = result.notify ? completionPublication(result.outcome || "completed", command.notice?.hidden === true, { ...command.notice, queueFinal }) : null;
  const notificationId = publication ? noticeId(message.scope, route.id, command.generationId || command.userId, publication.kind) : "";
  const intent = notificationId && stored["notice:notifications"] !== false ? await noticeIntent(notificationId, { url: route.url, scope: message.scope, tabId: sender.tab.id, queueFinal, elapsedMs: Math.max(0, Date.now() - (result.state.turn?.at || Date.now())) }, publication.kind, result.outcome || command.outcome || "completed") : null;
  // Queue finality and the minimal notification intent commit together. No
  // prompt or reply text is persisted, including during failure recovery.
  if (intent) writes[noticeKey(notificationId)] = intent;
  if (!result.conflict && (command.op === "stop" || command.op === "settle" && result.state.turn?.done)) {
    const key = noticeKey(noticeId(message.scope, route.id, command.generationId || command.userId, "attention"));
    const n = (await chrome.storage.local.get(key))[key];
    if (n?.pendingKind) { delete n.pendingKind; delete n.pendingOutcome; writes[key] = n; }
  }
  if (Object.keys(writes).length) await chrome.storage.local.set(writes);
  let notificationError = "";
  if (intent) {
    notificationError = await deliverNotice(notificationId, intent, publication.payload);
    await pruneNotices().catch(() => {});
  }
  notificationError ||= await retryNotices(message.scope, route.url);
  const clearTurn = command.op === "claim" ? result.item?.baseline : command.op === "start" ? command.previousUserId : command.op === "stop" || command.op === "settle" && (result.state.paused || !result.state.items.length) ? command.userId : "";
  if (clearTurn) await clearCompletionRequests(message.scope, route.url, clearTurn);
  return { ok: true, queue: result.state, usage: usage.state, item: result.item, conflict: result.conflict, notificationError };
}

const NOTICE_RANK = { generic: 1, attention: 2, failed: 3, completed: 4 };
const noticeKey = id => `notice:notification:${id}`;
// A dismissed approval must not consume the subsequent final result. Keep the
// legacy completion ID for generic -> rich enrichment, separate other events.
const noticeId = (scope, routeId, generationId, kind) => `notice:${scope.slice(0,16)}:${routeId}:${generationId}${["attention", "failed"].includes(kind) ? `|${kind}` : ""}`;

async function noticeIntent(id, routing, kind, outcome = kind) {
  const key = noticeKey(id);
  const stored = await chrome.storage.local.get([key, "notice:notifications"]);
  if (stored["notice:notifications"] === false) return null;
  // Older versions used one ID for attention/error/final. A historical closed
  // attention record is not proof that its later successful result was read.
  const previous = ["generic", "completed"].includes(kind) && ["attention", "failed"].includes(stored[key]?.kind) ? null : stored[key];
  if (previous?.dismissedAt || previous?.closedAt || previous?.consumedAt || (NOTICE_RANK[previous?.kind] || 0) >= (NOTICE_RANK[kind] || 0)) return null;
  return { ...previous, ...routing, at: previous?.at || Date.now(), pendingKind: kind, pendingOutcome: outcome };
}
async function publishNotice(id, routing, payload, kind, outcome = kind) {
  const intent = await noticeIntent(id, routing, kind, outcome);
  if (!intent) return "";
  await chrome.storage.local.set({ [noticeKey(id)]: intent });
  return deliverNotice(id, intent, payload);
}
async function deliverNotice(id, record, payload) {
  if (record.retryAt > Date.now()) return "系统通知暂未送达，将自动重试";
  const key = noticeKey(id);
  const options = {
    type: "basic", iconUrl: chrome.runtime.getURL("icons/chatgpt.png"),
    title: payload.title, message: payload.message, contextMessage: payload.contextMessage,
    eventTime: record.at, priority: 0
  };
  try {
    if (await chrome.notifications.getPermissionLevel() !== "granted") throw new Error("浏览器通知权限未允许");
    // Stable ID + update first also repairs a crash after OS success but before
    // the local acknowledgment. Enrichment is silent, new events are not.
    const updated = await chrome.notifications.update(id, { ...options, silent: true });
    if (!updated) await chrome.notifications.create(id, options);
    const delivered = { ...record, kind: record.pendingKind };
    delete delivered.pendingKind; delete delivered.pendingOutcome; delete delivered.retryAt;
    await chrome.storage.local.set({ [key]: delivered });
    return "";
  } catch (error) {
    await chrome.storage.local.set({ [key]: { ...record, retryAt: Date.now() + 10000 } }).catch(() => {});
    return String(error?.message || "系统通知暂未送达");
  }
}
async function retryNotices(scope, url) {
  const stored = await chrome.storage.local.get(null);
  let error = "";
  if (stored["notice:notifications"] === false) return error;
  for (const [key, n] of Object.entries(stored)) {
    if (!key.startsWith("notice:notification:") || !n?.pendingKind || n.dismissedAt || n.scope !== scope || Queue.route(n.url).id !== Queue.route(url).id) continue;
    const outcome = n.pendingOutcome || (n.pendingKind === "generic" ? "completed" : n.pendingKind);
    const publication = completionPublication(outcome, true, n);
    if (publication) error = await deliverNotice(key.slice("notice:notification:".length), n, publication.payload) || error;
  }
  return error;
}

async function markNoticeClosed(id) {
  const key = noticeKey(id);
  const notice = (await chrome.storage.local.get(key))[key];
  if (notice && !notice.dismissedAt) { delete notice.pendingKind; delete notice.pendingOutcome; await chrome.storage.local.set({ [key]: { ...notice, dismissedAt: Date.now() } }); }
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

async function networkNoticeEligible(observation, route, probe) {
  const queueKey = Queue.key(observation.scope, route.url);
  if (!queueKey) return false;
  const stored = await chrome.storage.local.get([queueKey, FEATURE_KEYS.queue]), queue = stored[queueKey];
  const generationId = probe?.generationId || observation.turnId;
  if (generationId !== observation.turnId) return false;
  if (queue?.holdUntil || queue?.turn && (queue.turn.id !== generationId || queue.turn.stopped || queue.turn.outcome === "stopped")) return false;
  // Unknown/sending outbox entries have no receipt yet. Network activity must
  // neither retire them nor borrow the identity of a later final Queue item.
  if (queue?.items?.some(item => item.state !== "pending")) return false;
  return stored[FEATURE_KEYS.queue] === false || queue?.paused || !queue?.items?.length || ["attention", "blocked", "failed"].includes(probe?.state);
}

async function scheduleCompletionProbe() {
  if (!await chrome.alarms.get(COMPLETION_ALARM)) await chrome.alarms.create(COMPLETION_ALARM, { periodInMinutes: 0.5 });
}
async function clearCompletionRequests(scope, url, turnId) {
  const routeId = Queue.route(url).id, stored = await chrome.storage.session.get(null);
  const keys = Object.entries(stored).filter(([key, value]) => key.startsWith(REQUEST_PREFIX) && value?.completedAt && value.scope === scope && value.turnId === turnId && Queue.route(value.url).id === routeId).map(([key]) => key);
  if (keys.length) {
    await chrome.storage.session.remove(keys);
    if (!Object.entries(stored).some(([key, value]) => key.startsWith(REQUEST_PREFIX) && value?.completedAt && !keys.includes(key))) await chrome.alarms.clear(COMPLETION_ALARM);
  }
}
async function probeCompletedRequest(key, observation) {
  let tab;
  try { tab = await chrome.tabs.get(observation.tabId); } catch { await chrome.storage.session.remove(key); return false; }
  const route = Queue.route(tab?.url), originRoute = Queue.route(observation.url);
  if (route.mode !== "conversation" || originRoute.mode === "conversation" && originRoute.id !== route.id) { await chrome.storage.session.remove(key); return false; }
  if (tab?.discarded) { await chrome.storage.session.remove(key); return false; }
  if (tab?.frozen) return true;
  try { await chrome.tabs.sendMessage(observation.tabId, { type: "NOTICE_COMPLETION_HINT", scope: observation.scope, turnId: observation.turnId, at: observation.completedAt }, { frameId: 0, documentId: observation.documentId }); } catch {}
  const probe = await completionProbe(observation, route);
  if (probe?.state === "stale" || probe?.state === "stopped" || probe?.generationId && probe.generationId !== observation.turnId) { await chrome.storage.session.remove(key); return false; }
  if (!await networkNoticeEligible(observation, route, probe)) return true;
  const queueKey = Queue.key(observation.scope, route.url), queue = (await chrome.storage.local.get(queueKey))[queueKey];
  const queueFinal = !queue?.items?.length && Boolean(queue?.receipts?.some(r => r.userId === observation.turnId));
  const elapsedMs = Math.max(0, Date.now() - (observation.sentAt || observation.at));
  const publication = completionPublication(probe?.state, probe?.hidden === true, { prompt: probe?.prompt, response: probe?.response, elapsedMs, queueFinal });
  if (!publication) return true;
  const id = noticeId(observation.scope, route.id, observation.turnId, publication.kind);
  await publishNotice(id, { url: route.url, scope: observation.scope, tabId: observation.tabId, elapsedMs, queueFinal }, publication.payload, publication.kind, probe?.state || "completed");
  await chrome.storage.session.remove(key); await pruneNotices().catch(() => {});
  return false;
}
async function retryCompletionRequests() {
  const stored = await chrome.storage.session.get(null); let pending = false;
  for (const [key, observation] of Object.entries(stored)) if (key.startsWith(REQUEST_PREFIX) && observation?.completedAt && Date.now() - observation.at <= REQUEST_TTL) pending = await probeCompletedRequest(key, observation) || pending;
  if (!pending) await chrome.alarms.clear(COMPLETION_ALARM);
}

async function completeConversationRequest(details) {
  const key = REQUEST_PREFIX + details.requestId;
  const observation = (await chrome.storage.session.get(key))[key];
  if (!observation || !observation.sentAt || observation.tabId !== details.tabId || observation.documentId !== details.documentId || Date.now() - observation.at > REQUEST_TTL || !Number.isFinite(details.statusCode) || details.statusCode < 200 || details.statusCode >= 300) { await chrome.storage.session.remove(key); return; }
  const completed = { ...observation, completedAt: Date.now() };
  await chrome.storage.session.set({ [key]: completed });
  if (await probeCompletedRequest(key, completed)) await scheduleCompletionProbe();
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
  delete notice.pendingKind;
  delete notice.pendingOutcome;
  await chrome.storage.local.set({ [key]: { ...notice, dismissedAt: Date.now() } });
  await chrome.notifications.clear(id);
}

async function pruneNotices(stored) {
  stored ||= await chrome.storage.local.get(null);
  const notices = Object.entries(stored).filter(([key]) => key.startsWith("notice:notification:"))
    .sort((a, b) => (b[1]?.at || 0) - (a[1]?.at || 0));
  const expired = notices.filter(([, value], index) => !value?.pendingKind && (index >= 100 || !Number.isFinite(value?.at) || Date.now() - value.at > 7 * 86400000)).map(([key]) => key);
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
