(() => {
  "use strict";
  if (globalThis.ChatGPTNotice) return;
  const Q = globalThis.ChatGPTQueueCore, D = globalThis.ChatGPTPageAdapter, U = globalThis.ChatGPTUsage;
  const instance = crypto.randomUUID();
  const rt = { context: null, queue: null, usage: null, page: null, turn: null, lastUserId: "", previousTail: "",
    tickBusy: false, actionBusy: false, sending: false, writing: false, composing: false, inputEpoch: 0,
    pending: null, retryBaseline: null, attempt: null, addAttempt: null, quietAt: Date.now(), stopped: "", disposed: false, ticks: 0, maxTickMs: 0 };
  const events = new AbortController();
  const ui = globalThis.ChatGPTQueueUI.create(action);
  const RELOAD_REQUIRED = "扩展已更新，请刷新当前页面后再操作；草稿和附件未改动";
  let interval = 0;
  const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
  const current = context => context === rt.context && location.href === context?.url && !rt.disposed;
  function disconnect() {
    rt.disposed = true;
    clearInterval(interval);
    events.abort();
    try { chrome.storage.onChanged.removeListener(storageListener); } catch {}
    try { chrome.runtime.onMessage.removeListener(scopeListener); } catch {}
  }
  function invalidate() {
    if (rt.disposed) return;
    disconnect();
    ui.deactivate(RELOAD_REQUIRED);
  }
  function runtime() {
    const api = globalThis.chrome?.runtime;
    if (!api?.id || typeof api.sendMessage !== "function") { invalidate(); throw new Error(RELOAD_REQUIRED); }
    return api;
  }
  function accept(reply, context) {
    if (!current(context)) return;
    if (reply.queue && (!rt.queue || reply.queue.revision >= rt.queue.revision)) rt.queue = reply.queue;
    if (reply.usage && (!rt.usage || reply.usage.revision >= rt.usage.revision)) rt.usage = reply.usage;
    if (reply.notificationError) ui.showNotice(`系统通知未能创建：${reply.notificationError}`);
  }
  async function request(command, context = rt.context, usage) {
    if (!context?.scope) throw new Error("账号尚未识别，未改动草稿或 Queue");
    const api = runtime();
    if (!current(context)) throw new Error("页面已切换，操作已取消");
    let reply;
    try {
      reply = await api.sendMessage({ type: "NOTICE", scope: context.scope, url: context.url, instance, command, usage });
    } catch (error) {
      const detail = String(error?.message || error || "");
      if (!globalThis.chrome?.runtime?.id || /extension context invalidated/i.test(detail)) { invalidate(); throw new Error(RELOAD_REQUIRED); }
      throw error;
    }
    if (!reply?.ok) throw new Error(reply?.error || "扩展连接不可用，请重新加载页面");
    accept(reply, context);
    return reply;
  }
  function render(status = "") {
    const context = rt.context || { mode: "off", key: "", scope: "" };
    const p = rt.page;
    ui.render({ ...context, queue: rt.queue, usage: rt.usage, actionBusy: rt.actionBusy, attachments: Boolean(p?.attachments),
      status: status || (rt.previousTail ? "等待目标对话加载" : p?.attachments ? "检测到图片或附件；Queue 暂仅支持纯文本，附件保持在原生输入框" : (rt.queue?.paused || rt.queue?.holdUntil) && rt.queue.reason ? rt.queue.reason : p?.running || rt.turn || rt.queue?.turn && !rt.queue.turn.done ? "正在等待当前回复真正结束；请保持最新消息可见" : !p?.empty ? "草稿已保留，Queue 等待输入框为空" : !rt.queue?.items.length ? "Queue 为空" : rt.queue?.reason || "队列就绪") });
    ui.anchor(p?.anchor || null);
  }
  function isInput(target) { return Boolean(target?.closest?.(D.COMPOSER)); }
  function submission(event) {
    if (event.defaultPrevented || rt.writing) return;
    const button = event.target?.closest?.("button");
    if (event.type === "click" && button?.matches(D.STOP)) {
      rt.stopped = D.snapshot().userId;
      const generationId = rt.turn?.id === rt.stopped ? rt.turn.generationId : rt.stopped;
      if (current(rt.context) && rt.context?.mode === "conversation") void request({ op: "stop", userId: rt.stopped, generationId }).catch(() => {});
      return;
    }
    const retry = event.target?.closest?.('button, [role="menuitem"]');
    if (event.type === "click" && /^(regenerate|retry|try again|重新生成|重试|再试一次)$/i.test((retry?.getAttribute("aria-label") || retry?.textContent || "").trim())) {
      const page = D.snapshot();
      rt.retryBaseline = { userId: page.userId, assistantId: page.assistantId };
      if (rt.context?.mode === "conversation" && current(rt.context)) void request({ op: "hold" }).catch(() => {});
    }
    const nativeSend = event.type === "click" && button?.matches(D.SEND) || event.type === "keydown" && event.key === "Enter" && !event.shiftKey && !event.isComposing && isInput(event.target) || event.type === "submit" && event.target?.contains?.(rt.page?.composer);
    if (nativeSend) {
      const page = D.snapshot();
      if (page.empty) return;
      if (rt.attempt) rt.attempt.submitted = true;
      rt.pending = { at: Date.now(), baseline: rt.page?.userId || "", fromUsage: Q.route(location.href).mode === "usage" };
      rt.quietAt = Date.now();
      if (!rt.sending && rt.context?.mode === "conversation" && current(rt.context)) void request({ op: "hold" }).catch(() => {});
    }
    // Observation only: never preventDefault, replace handlers, patch history or fetch.
  }
  for (const type of ["click", "keydown", "submit"]) document.addEventListener(type, submission, { capture: true, signal: events.signal });
  for (const type of ["beforeinput", "input", "compositionstart", "compositionend", "pointerdown"]) document.addEventListener(type, event => {
    if (!isInput(event.target) || rt.writing) return;
    rt.inputEpoch += 1;
    rt.quietAt = Date.now();
    if (type === "compositionstart") rt.composing = true;
    if (type === "compositionend") rt.composing = false;
  }, { capture: true, passive: true, signal: events.signal });
  const storageListener = (changes, area) => {
    if (area !== "local" || !rt.context) return;
    const queue = changes[rt.context.key]?.newValue;
    const usage = changes[U.PREFIX + rt.context.scope]?.newValue;
    if (Object.hasOwn(changes, rt.context.key) && !queue) rt.queue = null;
    if (Object.hasOwn(changes, U.PREFIX + rt.context.scope) && !usage) rt.usage = null;
    accept({ queue, usage }, rt.context);
  };
  chrome.storage.onChanged.addListener(storageListener);
  const scopeListener = (message, sender, reply) => {
    if (message?.type !== "NOTICE_SCOPE") return;
    const url = location.href;
    if (rt.disposed) { reply(null); return; }
    void D.scope().then(scope => reply(!rt.disposed && location.href === url ? { scope, url } : null), () => reply(null));
    return true;
  };
  chrome.runtime.onMessage.addListener(scopeListener);

  async function tick() {
    if (rt.tickBusy || rt.disposed) return;
    rt.tickBusy = true;
    const start = performance.now();
    try {
      runtime();
      const url = location.href;
      const route = Q.route(url);
      if (route.mode === "off") { rt.context = { mode: "off", url, scope: "", key: "" }; rt.page = null; render(); return; }
      const scope = await D.scope();
      if (location.href !== url) return;
      const key = Q.key(scope, url);
      const p = D.snapshot(document, Boolean(rt.turn));
      const changed = rt.context?.url !== url || rt.context.scope !== scope;
      if (changed) {
        const old = rt.context;
        const firstSendTransition = old?.mode === "usage" && old.scope === scope && rt.pending?.fromUsage && Date.now() - rt.pending.at < 60000;
        const promoting = firstSendTransition && route.mode === "conversation";
        rt.previousTail = old?.mode === "conversation" && old.id !== route.id ? rt.lastUserId : "";
        rt.context = { ...route, url, scope, key: key || `usage:${scope}` };
        rt.queue = null; rt.usage = null; rt.turn = null; rt.lastUserId = promoting ? "" : p.userId;
        rt.quietAt = Date.now(); rt.stopped = ""; rt.retryBaseline = null; rt.addAttempt = null;
        if (!firstSendTransition) rt.pending = null;
        if (scope) await request({ op: "get" });
        if (!current(rt.context)) return;
      }
      rt.page = p;
      if (scope && (!rt.usage || route.mode === "conversation" && !rt.queue)) await request({ op: "get" });
      const now = Date.now();
      if (scope && rt.usage?.resetAt && now >= rt.usage.resetAt) await request(null, rt.context, { op: "get" });
      if (!scope || route.mode !== "conversation") { render(); return; }
      if (rt.previousTail && p.userId && p.userId !== rt.previousTail) rt.previousTail = "";
      if (rt.previousTail) { render(); return; }
      if (rt.queue?.items.some(item => item.state === "sending" && item.expiresAt <= now)) await request({ op: "get" });
      // A refresh may recover an exact receipt, but never infer one merely from Streaming.
      for (const item of rt.queue?.items || []) {
        if (!["sending", "unknown"].includes(item.state) || item.phase !== "submitting") continue;
        const node = D.receipt(item, p);
        if (node) await request({ op: "receipt", id: item.id, claim: item.claim, userId: D.messageId(node), text: D.readText(node) });
      }
      // The native user turn may render attachment/file chips or other metadata
      // that was not present in the composer text. The captured native submit
      // event plus a new user message in the same live conversation is enough
      // to begin completion tracking; Queue delivery still requires its stricter
      // text-matching receipt below and therefore cannot be acknowledged here.
      const confirmedSubmission = rt.pending && now - rt.pending.at < 60000 && p.userId && p.userId !== rt.pending.baseline;
      const storedTurn = rt.queue?.turn;
      const storedUser = storedTurn?.userId || storedTurn?.id;
      const resume = storedTurn && !storedTurn.done && storedUser === p.userId;
      const retry = rt.retryBaseline?.userId === p.userId && p.assistantId && p.assistantId !== rt.retryBaseline.assistantId;
      const regenerated = retry || storedTurn?.done && storedUser === p.userId && p.running && p.assistantId && p.assistantId !== storedTurn.assistantId;
      const recoveredCompleted = storedTurn && !storedTurn.done && storedUser && p.userId && storedUser !== p.userId && !p.running && p.copy;
      // A regeneration gets a new native response identity, while tool/message
      // segments within one ongoing generation still count only once.
      const generationId = regenerated ? `${p.userId}:${p.assistantId}` : resume ? storedTurn.id : p.userId;
      const live = p.running && !p.copy && p.userId && !rt.queue?.settled?.includes(generationId);
      if (p.userId && (confirmedSubmission || resume || live || regenerated || recoveredCompleted) && rt.turn?.generationId !== generationId) {
        const candidate = { id: p.userId, generationId, at: resume && !regenerated ? storedTurn.at : now, fingerprint: "", stableAt: now, counted: Boolean(regenerated || recoveredCompleted || generationId !== p.userId), recovered: Boolean(recoveredCompleted && !confirmedSubmission) };
        if (regenerated) rt.stopped = "";
        const started = await request({ op: "start", userId: p.userId, generationId,
          previousUserId: D.precedes(storedUser, p.user) ? storedUser : "", retryOf: retry ? storedTurn?.id : "" });
        if (started.conflict || rt.queue?.turn?.id !== generationId) {
          rt.turn = null;
          rt.pending = null;
          rt.retryBaseline = null;
          render(rt.queue?.reason || "检测到同一对话存在并发生成；Queue 已暂停");
          return;
        }
        rt.turn = candidate;
        rt.pending = null;
        rt.retryBaseline = null;
      }
      rt.lastUserId = p.userId || rt.lastUserId;
      if (p.running) rt.quietAt = now;
      const active = rt.turn;
      if (active && p.userId === active.id && D.generationMatches(active.generationId, p)) {
        const fingerprint = !p.running && p.copy ? `${p.assistantId}:${p.settledText}` : "";
        if (active.fingerprint !== fingerprint) { active.fingerprint = fingerprint; active.stableAt = now; }
        const finished = !p.running && p.ready && fingerprint && now - active.stableAt >= 3000 && now - active.at >= 3000;
        const stopped = rt.stopped === active.id || rt.queue?.turn?.id === active.generationId && rt.queue.turn.stopped;
        const failed = !p.running && (p.error || stopped) && now - rt.quietAt >= 2000;
        if (!active.counted && finished && !p.error && !stopped && U.MODELS.has(p.model)) {
          // A model label can be rendered optimistically before any request is
          // sent. Only a confirmed completed answer is a safe DOM fallback.
          // Usage is auxiliary accounting. A storage/validation failure must not
          // strand the completion state machine or block the next Queue item.
          // Prefer a visible undercount to delaying the user's conversation.
          try {
            await request(null, rt.context, { op: "record", turnId: active.id, model: p.model, at: active.at });
            active.counted = true;
          } catch {}
        }
        if (finished || failed) {
          await request({ op: "settle", userId: active.id, generationId: active.generationId, assistantId: p.assistantId, failed: Boolean(p.error || stopped), suppressNotify: Boolean(active.recovered) });
          rt.turn = null; rt.stopped = ""; rt.quietAt = now;
        }
      }
      render();
      if (!rt.actionBusy && !rt.sending && safeToSend(p) && !rt.queue?.paused && rt.queue?.items[0]?.state === "pending") await dispatch(rt.queue.items[0].id, false);
    } catch (error) {
      // Missing adapters, storage failures and route races do not fall back to sending.
      render(error.message);
    } finally {
      rt.ticks += 1;
      rt.maxTickMs = Math.max(rt.maxTickMs, performance.now() - start);
      rt.tickBusy = false;
    }
  }

  function safeToSend(p) {
    return Boolean(rt.context?.mode === "conversation" && rt.context.scope && current(rt.context) && !rt.previousTail &&
      p.userId && p.ready && p.empty && !p.running && !p.error && !rt.turn && !rt.composing &&
      !rt.queue?.holdUntil && (!rt.queue?.turn || rt.queue.turn.done && (rt.queue.turn.userId || rt.queue.turn.id) === p.userId) && Date.now() - rt.quietAt >= 4000);
  }
  async function dispatch(id, manual) {
    if (rt.sending) throw new Error("正在确认上一条发送");
    let page = D.snapshot();
    if (!safeToSend(page)) throw new Error("当前回复、草稿、附件或页面尚未就绪；没有发送");
    const context = rt.context, epoch = rt.inputEpoch, input = page.composer;
    let item, clicked = false;
    const attempt = { submitted: false };
    rt.attempt = attempt;
    rt.sending = true;
    const guard = expected => {
      runtime();
      const p = D.snapshot();
      if (!current(context) || rt.inputEpoch !== epoch || rt.composing || p.composer !== input || !p.ready || p.running || p.error || p.attachments || rt.queue?.holdUntil || rt.queue?.turn && !rt.queue.turn.done || D.readText(input).trim() !== expected.trim() || item && (Date.now() >= item.expiresAt || p.userId !== item.baseline)) throw new Error("页面或草稿已变化，发送已停止");
      return p;
    };
    try {
      item = (await request({ op: "claim", id, manual, baseline: page.userId }, context)).item;
      guard("");
      await request({ op: "intent", id: item.id, claim: item.claim, manual }, context);
      if (await D.scope() !== context.scope) throw new Error("账号已切换，发送已停止");
      guard("");
      rt.writing = true;
      let written;
      try { written = D.write(input, item.text); } finally { rt.writing = false; }
      if (!written) throw new Error("原生输入框未接受文本，Queue 已保留");
      const deadline = Date.now() + 2500;
      do {
        await delay(100);
        if (await D.scope() !== context.scope) throw new Error("账号已切换，发送已停止");
        page = guard(item.text);
        if (!manual && rt.queue?.paused) throw new Error("队列已暂停，草稿保留");
        const button = D.sendButton();
        if (button && D.enabled(button)) {
          clicked = true; // Before click: any exception after this point is ambiguous.
          button.click();
          rt.quietAt = Date.now();
          return;
        }
      } while (Date.now() < deadline);
      throw new Error("原生发送按钮不可用；未点击，文本保留在原生输入框");
    } catch (error) {
      if (item && current(context)) {
        try { await request({ op: "abort", id: item.id, claim: item.claim, beforeClick: !clicked && !attempt.submitted }, context); } catch {}
      }
      // Never restore an old draft over newer user input, or retry an ambiguous click.
      ui.showNotice(error.message);
    } finally { rt.sending = false; rt.attempt = null; }
  }
  async function action(name, payload) {
    if (rt.actionBusy) throw new Error("上一项操作尚未完成");
    rt.actionBusy = true;
    const context = rt.context;
    try {
      if (!current(context)) throw new Error("页面已切换，请重新操作");
      runtime();
      if (await D.scope() !== context.scope || !current(context)) throw new Error("账号、Workspace 或页面已切换，草稿未改动");
      if (name === "save-usage") { await request(null, context, { op: "edit", ...payload }); return; }
      if (context.mode !== "conversation") throw new Error("仅正式对话提供 Queue");
      if (name === "add") {
        const page = D.snapshot(), text = D.readText(page.composer), epoch = rt.inputEpoch;
        if (!text.trim() || !page.composer || page.attachments || rt.composing) throw new Error("仅支持已完成输入的纯文本；草稿和附件未改动");
        if (page.running && page.userId && !rt.queue?.turn) await request({ op: "start", userId: page.userId }, context);
        if (!rt.addAttempt || rt.addAttempt.text !== text || rt.addAttempt.context !== context) rt.addAttempt = { id: Q.id(), text, context };
        await request({ op: "add", id: rt.addAttempt.id, text, running: page.running || Boolean(rt.turn) }, context);
        if (await D.scope() !== context.scope || !current(context) || epoch !== rt.inputEpoch || D.composer() !== page.composer || D.readText(page.composer) !== text || D.snapshot().attachments || rt.composing) { ui.showNotice("已保存 Queue；输入期间有变化，当前草稿保持原样"); return; }
        runtime();
        rt.writing = true;
        let cleared;
        try { cleared = D.write(page.composer, ""); } finally { rt.writing = false; }
        if (!cleared) { await request({ op: "pause", paused: true }, context); ui.showNotice("已保存并暂停；原生草稿未能清空，请核对后继续"); }
        else { rt.addAttempt = null; ui.showNotice("已加入当前对话 Queue"); }
      } else if (name === "pause") await request({ op: "pause", paused: !rt.queue?.paused }, context);
      else if (name === "send") await dispatch(payload.id, true);
      else if (name === "save-edit") {
        if (payload.key !== context.key) throw new Error("编辑所属对话已变化");
        await request({ op: "edit", ...payload }, context);
      } else if (name === "remove") await request({ op: "remove", id: payload.id }, context);
      else if (name === "up" || name === "down") await request({ op: "move", id: payload.id, direction: name === "up" ? -1 : 1 }, context);
      else if (name === "resolve-retry" || name === "resolve-remove") await request({ op: "resolve", id: payload.id, confirmed: true, retry: name === "resolve-retry" }, context);
    } finally { rt.actionBusy = false; render(); }
  }
  interval = setInterval(() => void tick(), 1000);
  addEventListener("popstate", () => void tick(), { signal: events.signal });
  addEventListener("pageshow", () => void tick(), { signal: events.signal });
  globalThis.ChatGPTNotice = {
    stats: () => ({ ticks: rt.ticks, maxTickMs: rt.maxTickMs, mode: rt.context?.mode, sending: rt.sending }),
    dispose() { disconnect(); ui.dispose(); delete globalThis.ChatGPTNotice; }
  };
  void tick();
})();
