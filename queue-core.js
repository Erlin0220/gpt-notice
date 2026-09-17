/* Queue claim/outbox operations adapted from chatgpt-yolo (MIT).
 * Upstream queue.js blob 544217149cf42e6890ac936a60a09da6a28b3edd.
 * See THIRD_PARTY_NOTICES.md. No workflow/runtime is imported. */
(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueCore = api;
})(globalThis, function () {
  "use strict";
  const PREFIX = "notice:conversation:";
  const HOSTS = new Set(["chatgpt.com", "chat.openai.com"]);
  const MAX_ITEMS = 50;
  const MAX_TEXT = 200_000;
  const MAX_TOTAL = 1_000_000;
  const LEASE_MS = 30_000;
  const CONFLICT_REASON = "检测到同一对话存在并发生成；Queue 已暂停，请确认对话后继续";
  const id = () => crypto.randomUUID();
  const text = value => String(value ?? "").replace(/\r\n?/g, "\n");
  const comparable = value => text(value).replace(/\u00a0/g, " ").trim();
  const clone = value => JSON.parse(JSON.stringify(value));
  const source = owner => String(owner || "").split(":", 1)[0];
  function route(value) {
    try {
      const url = new URL(value);
      if (!/^https:$/.test(url.protocol) || !HOSTS.has(url.hostname)) return { mode: "off", id: "" };
      const path = url.pathname.replace(/\/+$/, "") || "/";
      const conversation = path.match(/(?:^|\/)c\/([a-zA-Z0-9_-]+)$/)?.[1];
      if (conversation) return { mode: "conversation", id: conversation, url: `${url.origin}${path}` };
      // ChatGPT itself can briefly expose this URL after first Send. It has no
      // queue identity: keep the usage UI, never create or migrate an outbox.
      if (/(?:^|\/)c\/WEB:[a-zA-Z0-9_-]+$/.test(path)) return { mode: "usage", id: "", url: `${url.origin}${path}` };
      if (path === "/" || /^\/g\/[^/]+\/project$/.test(path)) return { mode: "usage", id: "", url: `${url.origin}${path}` };
    } catch {}
    return { mode: "off", id: "" };
  }
  function key(scope, url) {
    const r = route(url);
    return /^[a-f0-9]{32,64}$/.test(scope || "") && r.id ? `${PREFIX}${scope}:${r.id}` : "";
  }
  function fresh() {
    return { version: 8, revision: 0, paused: false, pauseCause: "", reason: "", items: [], receipts: [], turn: null, settled: [], failureStreak: 0, holdUntil: 0, updatedAt: 0 };
  }
  function normalize(raw, now = Date.now()) {
    if (raw && (raw.version !== 8 || !Array.isArray(raw.items) || !Array.isArray(raw.receipts) || !Array.isArray(raw.settled))) throw new Error("本地 Queue 数据格式异常；未覆盖原始数据，请先备份检查");
    const state = raw?.version === 8 ? clone(raw) : fresh();
    if (typeof state.pauseCause !== "string") {
      state.pauseCause = !state.paused ? "" : state.reason === "已暂停" ? "user" : state.reason === CONFLICT_REASON ? "conflict" : state.reason === "已保存，点击继续或立即发送" ? "legacy-idle" : "safety";
    }
    for (const item of state.items) {
      if (item.state === "sending" && item.expiresAt <= now) {
        // A lost sender before intent is safe to reclaim; after intent it is not.
        if (item.phase === "submitting") {
          item.state = "unknown";
          state.paused = true;
          state.pauseCause = "safety";
          state.reason = "发送结果未知，请核对对话后处理";
        } else {
          item.state = "pending";
          delete item.claim;
        }
      }
    }
    return state;
  }
  function apply(raw, command, owner, now = Date.now()) {
    const state = normalize(raw, now);
    const before = JSON.stringify(state);
    let result = {};
    const reject = message => { throw new Error(message); };
    const find = () => state.items.find(item => item.id === command.id) || reject("队列项不存在");
    const pending = () => {
      const item = find();
      if (item.state !== "pending") reject("正在发送或发送结果未知，不能修改");
      return item;
    };
    const claimed = () => {
      const item = find();
      if (item.claim !== command.claim || item.owner !== owner || item.state !== "sending" || item.expiresAt <= now) reject("发送租约已失效");
      return item;
    };
    switch (command.op) {
      case "get": break;
      case "hold":
        // A native submission has no lease-owned retry. Keep it blocked until
        // a message receipt or an explicit user resume resolves the uncertainty.
        state.holdUntil = now;
        state.reason = "等待原生提交确认；未送达请检查后暂停/继续";
        break;
      case "add": {
        if (state.items.some(item => item.id === command.id) || state.receipts.some(r => r.itemId === command.id)) break;
        const value = text(command.text);
        if (!value.trim() || value.length > MAX_TEXT) reject("消息为空或超过 200,000 字符，草稿未改动");
        if (state.items.length >= MAX_ITEMS || state.items.reduce((n, i) => n + i.text.length, 0) + value.length > MAX_TOTAL) reject("本地队列容量已满，草稿未改动");
        if (!/^[a-zA-Z0-9_-]{8,80}$/.test(command.id || "")) reject("无效的消息标识");
        state.items.push({ id: command.id, text: value, state: "pending", createdAt: now });
        break;
      }
      case "edit": {
        const item = pending();
        if (command.revision !== state.revision) reject("队列已在其他标签页变化，请重新编辑");
        const value = text(command.text);
        if (!value.trim() || value.length > MAX_TEXT || state.items.reduce((n, i) => n + i.text.length, 0) - item.text.length + value.length > MAX_TOTAL) reject("消息为空或超出队列容量");
        item.text = value;
        break;
      }
      case "remove": pending(); state.items = state.items.filter(i => i.id !== command.id); break;
      case "move": {
        pending();
        const index = state.items.findIndex(i => i.id === command.id);
        const target = index + (command.direction === -1 ? -1 : 1);
        if (target >= 0 && target < state.items.length && state.items[target].state === "pending") [state.items[index], state.items[target]] = [state.items[target], state.items[index]];
        break;
      }
      case "pause":
        if (!command.paused && state.items.some(i => i.state === "unknown")) reject("请先核对发送结果未知的消息，继续不会自动重发");
        state.paused = Boolean(command.paused);
        state.pauseCause = state.paused ? "user" : "";
        state.reason = state.paused ? "已暂停" : "";
        if (!state.paused) { state.holdUntil = 0; state.failureStreak = 0; }
        break;
      case "claim": {
        if (state.holdUntil) reject("正在等待原生提交确认");
        if (state.turn && !state.turn.done) reject("上一条回复尚未确认结束");
        if (state.turn && (state.turn.userId || state.turn.id) !== command.baseline) reject("当前标签页尚未同步最新对话");
        if (state.items.some(i => i.state !== "pending")) reject("已有发送租约或未知结果");
        if (state.paused && !command.manual) reject("队列已暂停");
        const item = command.manual ? pending() : state.items[0];
        if (!item) reject("队列为空");
        item.state = "sending";
        item.claim = id();
        item.owner = owner;
        item.expiresAt = now + LEASE_MS;
        item.phase = "claimed";
        item.baseline = String(command.baseline || "");
        result.item = clone(item);
        break;
      }
      case "intent": {
        const item = claimed();
        if (state.holdUntil || state.turn && !state.turn.done) reject("原生消息已开始提交，取消队列发送");
        if (state.turn && (state.turn.userId || state.turn.id) !== item.baseline) reject("对话已在其他标签页变化");
        if (state.paused && !command.manual) reject("队列已暂停");
        item.phase = "submitting";
        result.item = clone(item);
        break;
      }
      case "abort": {
        const item = claimed();
        // Only the sender may attest it has not clicked. Never infer this after reload.
        if (command.beforeClick === true) { item.state = "pending"; delete item.claim; }
        else item.state = "unknown";
        state.paused = true;
        state.pauseCause = "safety";
        state.reason = command.beforeClick ? "发送前已停止，草稿保留，请检查后继续" : "发送结果未知，请核对对话后处理";
        break;
      }
      case "receipt": {
        const receipt = state.receipts.find(r => r.itemId === command.id && r.claim === command.claim);
        if (receipt) { result.alreadyReceived = true; break; }
        const item = find();
        if (!["sending", "unknown"].includes(item.state) || item.claim !== command.claim || item.phase !== "submitting") reject("发送意图不匹配");
        if (!command.userId || command.userId === item.baseline || comparable(command.text) !== comparable(item.text)) reject("用户消息回执不匹配");
        state.items = state.items.filter(i => i.id !== item.id);
        state.receipts.push({ itemId: item.id, claim: item.claim, userId: command.userId, at: now });
        state.receipts = state.receipts.slice(-100);
        const currentUser = state.turn?.userId || state.turn?.id;
        if (!state.settled.includes(command.userId) && currentUser !== command.userId) {
          if (state.turn && currentUser !== item.baseline) {
            // A late receipt proves delivery, not that this is still the active
            // branch. Acknowledge the outbox without replacing a newer turn.
            state.paused = true;
            state.pauseCause = "conflict";
            state.reason = CONFLICT_REASON;
            state.holdUntil = now;
            result.conflict = true;
          } else state.turn = { id: command.userId, userId: command.userId, source: source(item.owner), at: now, done: false };
        } else if (state.turn?.id === command.userId) state.turn.source = source(item.owner);
        if (!result.conflict) state.holdUntil = 0;
        if (state.reason === "发送结果未知，请核对对话后处理" && !state.items.some(i => i.state === "unknown")) state.reason = "已确认送达，请检查后继续";
        break;
      }
      case "resolve": {
        const item = find();
        if (item.state !== "unknown" || command.confirmed !== true) reject("需要先明确核对发送结果");
        if (command.retry) { item.state = "pending"; delete item.claim; }
        else state.items = state.items.filter(i => i.id !== item.id);
        state.paused = true;
        state.pauseCause = "safety";
        state.reason = "已处理，请检查对话后继续";
        break;
      }
      case "start": {
        const generationId = command.generationId || command.userId;
        const currentSource = source(owner);
        if (command.userId && !state.settled.includes(generationId) && state.turn?.id !== generationId) {
          if (state.turn && !state.turn.done) {
            // Same tab is not proof of the same branch. Require a visible
            // predecessor (or an explicitly observed native retry) as well.
            const previousUser = state.turn.userId || state.turn.id;
            const follows = command.previousUserId === previousUser && command.userId !== previousUser;
            const retry = command.retryOf === state.turn.id && command.userId === previousUser;
            const sameSource = Boolean(state.turn.source && state.turn.source === currentSource && (follows || retry));
            const legacySingleTab = !state.turn.source && command.singleTab === true;
            if (!sameSource && !legacySingleTab) {
              state.paused = true;
              state.pauseCause = "conflict";
              state.holdUntil = now;
              state.reason = CONFLICT_REASON;
              result.conflict = true;
              break;
            }
            state.settled = [...state.settled.filter(id => id !== state.turn.id), state.turn.id].slice(-200);
            if (legacySingleTab && state.pauseCause === "conflict") {
              state.paused = false;
              state.pauseCause = "";
              state.reason = "";
            }
          }
          state.turn = { id: generationId, userId: command.userId, source: currentSource, at: now, done: false };
          state.holdUntil = 0;
          if (!state.paused) state.reason = "";
        } else if (state.turn?.id === generationId && !state.turn.source && currentSource) {
          state.turn.source = currentSource;
        }
        break;
      }
      case "stop": {
        const generationId = command.generationId || command.userId;
        if (command.userId && !state.settled.includes(generationId)) {
          if (state.turn && !state.turn.done && state.turn.id !== generationId) {
            state.paused = true;
            state.pauseCause = "conflict";
            state.reason = CONFLICT_REASON;
            state.holdUntil = now;
            result.conflict = true;
            break;
          }
          if (state.turn?.id !== generationId) state.turn = { id: generationId, userId: command.userId, source: source(owner), at: now, done: false };
          state.turn.stopped = true;
          // Persist the user's intent now, not on a later sampler tick: a
          // fast manual follow-up may supersede this turn before it settles.
          if (!state.paused) {
            state.pauseCause = "stop";
            state.reason = "上一轮手动停止后，Queue 已暂停；点击继续恢复";
          }
          state.paused = true;
        }
        break;
      }
      case "attention":
        if (state.turn?.id !== (command.generationId || command.userId) || state.turn.done || state.turn.stopped || state.turn.attention || state.holdUntil) break;
        state.turn.attention = true;
        result.notify = true;
        result.outcome = "attention";
        break;
      case "settle": {
        if (state.turn?.id !== (command.generationId || command.userId) || state.turn.done) break;
        const outcome = state.turn.stopped ? "stopped" : command.outcome || (command.failed ? "failed" : "completed");
        if (!["completed", "recoverable", "blocked", "failed", "stopped"].includes(outcome)) reject("没有明确的回复终态");
        state.turn.done = true;
        state.turn.outcome = outcome;
        state.turn.assistantId = String(command.assistantId || "");
        state.settled = [...state.settled, state.turn.id].slice(-200);
        state.failureStreak = outcome === "recoverable" ? Math.min(2, (state.failureStreak || 0) + 1) : 0;
        const exhausted = state.failureStreak >= 2;
        if (["blocked", "failed", "stopped"].includes(outcome) || exhausted) {
          state.paused = true;
          // Never downgrade an existing explicit pause or branch-conflict guard.
          if (!["user", "stop", "conflict"].includes(state.pauseCause)) {
            state.pauseCause = "safety";
            state.reason = exhausted ? "连续两轮异常，Queue 已暂停；请检查后继续" : outcome === "stopped" ? "上一轮手动停止后，Queue 已暂停；点击继续恢复" : outcome === "blocked" ? "限额、策略或账号受限，Queue 已暂停；请先处理原生提示" : "当前回复异常，Queue 已暂停；请检查后继续";
          }
        }
        // Return notification intent only after the completion state is durable.
        result.outcome = outcome;
        result.notify = !command.suppressNotify && outcome !== "stopped" && !state.holdUntil && (command.queueEnabled === false || state.paused || state.items.length === 0 || ["blocked", "failed"].includes(outcome) || exhausted);
        break;
      }
      default: reject("未知队列操作");
    }
    const changed = JSON.stringify(state) !== before || JSON.stringify(raw || fresh()) !== JSON.stringify(state);
    if (changed) { state.revision += 1; state.updatedAt = now; }
    return { state, changed, ...result };
  }
  return { PREFIX, HOSTS, MAX_ITEMS, MAX_TEXT, LEASE_MS, CONFLICT_REASON, id, text, comparable, route, key, fresh, normalize, apply };
});
