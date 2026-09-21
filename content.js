(() => {
  "use strict";
  if (globalThis.ChatGPTNotice) return;
  const Q = globalThis.ChatGPTQueueCore, D = globalThis.ChatGPTPageAdapter, U = globalThis.ChatGPTUsage, P = globalThis.ChatGPTProjects;
  const QUEUE_SETTING = "notice:queue-enabled";
  const TOOL_FOLD_SETTING = "notice:tool-fold-enabled";
  const instance = crypto.randomUUID();
  const rt = { context: null, queue: null, usage: null, page: null, turn: null, lastUserId: "", previousTail: "",
    tickBusy: false, tickAgain: false, actionBusy: false, sending: false, writing: false, composing: false, inputEpoch: 0,
    pending: null, retryBaseline: null, attempt: null, addAttempt: null, quietAt: Date.now(), stopped: "", disposed: false,
    queueEnabled: true, toolFoldEnabled: true, projects: null, projectSignature: "", projectBusy: false, projectPromote: null, notificationRetryAt: 0, notificationError: "", completionHint: null };
  const events = new AbortController();
  const ui = globalThis.ChatGPTQueueUI.create(action);
  const RELOAD_REQUIRED = "扩展已更新，请刷新当前页面后再操作；草稿和附件未改动";
  let interval = 0;
  const current = context => context === rt.context && location.href === context?.url && !rt.disposed;
  function disconnect() {
    rt.disposed = true;
    clearInterval(interval);
    events.abort();
    try { globalThis.ChatGPTToolFold?.dispose(); } catch {}
    try { globalThis.ChatGPTScrollStabilizer?.dispose(); } catch {}
    try { chrome.storage.onChanged.removeListener(storageListener); } catch {}
    try { chrome.runtime.onMessage.removeListener(runtimeListener); } catch {}
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
    if (reply.projects && (!rt.projects || reply.projects.revision >= rt.projects.revision)) rt.projects = reply.projects;
    if (Object.hasOwn(reply, "notificationError")) {
      rt.notificationRetryAt = reply.notificationError ? Date.now() + 10000 : 0;
      if (reply.notificationError && reply.notificationError !== rt.notificationError) ui.showNotice(`系统通知暂未送达，将重试：${reply.notificationError}`);
      rt.notificationError = reply.notificationError;
    }
  }
  async function sendRuntime(message, fallback) {
    try {
      const reply = await runtime().sendMessage(message);
      if (!reply?.ok) throw new Error(reply?.error || fallback);
      return reply;
    } catch (error) {
      if (!globalThis.chrome?.runtime?.id || /extension context invalidated/i.test(String(error?.message || error || ""))) { invalidate(); throw new Error(RELOAD_REQUIRED); }
      throw error;
    }
  }
  async function request(command, context = rt.context, usage) {
    if (!context?.scope) throw new Error("账号尚未识别，未改动草稿或 Queue");
    if (!current(context)) throw new Error("页面已切换，操作已取消");
    const reply = await sendRuntime({ type: "NOTICE", scope: context.scope, url: context.url, instance, command, usage }, "扩展连接不可用");
    accept(reply, context);
    return reply;
  }
  async function refreshProjects(context) {
    if (rt.projectBusy || !context?.scope || !current(context)) return;
    rt.projectBusy = true;
    try {
      const projects = globalThis.ChatGPTSidebar.collect(context.scope, context.url);
      const signature = JSON.stringify(projects);
      const promote = rt.projectPromote?.scope === context.scope ? rt.projectPromote.id : "";
      if (rt.projects && signature === rt.projectSignature && !promote) return;
      const reply = await sendRuntime({ type: "NOTICE", scope: context.scope, url: context.url, projects, promoteProjectId: promote }, "项目快捷访问暂不可用");
      accept(reply, context);
      if (promote && reply.projects?.items?.[0]?.projectId === promote && rt.projectPromote?.scope === context.scope && rt.projectPromote.id === promote) rt.projectPromote = null;
      if (current(context)) { rt.projectSignature = signature; render(); }
    } catch { /* Auxiliary metadata failure must never strand Queue or completion. */ }
    finally { rt.projectBusy = false; }
  }
  function render(status = "") {
    const context = rt.context || { mode: "off", key: "", scope: "" };
    const p = rt.page;
    ui.render({ ...context, queue: rt.queue, usage: rt.usage, actionBusy: rt.actionBusy, attachments: Boolean(p?.attachments), queueEnabled: rt.queueEnabled, canSend: Boolean(p && safeToSend(p) && !rt.queue?.items.some(i => i.state !== "pending")),
      status: status || (rt.previousTail ? "等待目标对话加载" : p?.attachments ? "检测到图片或附件；Queue 暂仅支持纯文本，附件保持在原生输入框" : (rt.queue?.paused || rt.queue?.holdUntil) && rt.queue.reason ? rt.queue.reason : p?.waiting ? "等待你处理原生确认或继续操作；Queue 不会自动批准" : p?.running || rt.turn || rt.queue?.turn && !rt.queue.turn.done ? "正在等待当前回复真正结束；请保持最新消息可见" : p?.error && !errorAllowsNext(p) ? "原生页面仍有阻塞或异常提示；请先处理后继续" : !p?.empty ? "草稿已保留，Queue 等待输入框为空" : !rt.queue?.items.length ? "Queue 为空" : rt.queue?.reason || "队列就绪") });
    try { globalThis.ChatGPTSidebar.render(rt.projects, context.url, context.scope); } catch {}
    ui.anchor(p?.anchor || null);
  }
  function isInput(target) { return Boolean(target?.closest?.(D.COMPOSER)); }
  function isComposerControl(target) {
    if (!target) return false;
    if (rt.page?.anchor?.contains?.(target)) return true;
    const form = target.closest?.("form");
    return Boolean(form?.querySelector?.(D.COMPOSER));
  }
  function isNativeTurnControl(target) {
    return D.nativeTurnControl(target);
  }
  function submission(event) {
    if (event.defaultPrevented || rt.writing) return;
    const button = event.target?.closest?.("button");
    if (event.type === "click" && button?.matches(D.STOP) && isComposerControl(button)) {
      rt.stopped = D.snapshot().userId;
      const generationId = rt.turn?.id === rt.stopped ? rt.turn.generationId : rt.stopped;
      if (rt.queueEnabled && current(rt.context) && rt.context?.mode === "conversation") void request({ op: "stop", userId: rt.stopped, generationId }).catch(() => {});
      return;
    }
    const retry = event.target?.closest?.('button, [role="menuitem"]');
    if (event.type === "click" && isNativeTurnControl(retry) && /^(regenerate|retry|try again|重新生成|重试|再试一次)$/i.test((retry?.getAttribute("aria-label") || retry?.textContent || "").trim())) {
      const page = D.snapshot();
      rt.retryBaseline = { userId: page.userId, assistantId: page.assistantId };
      if (rt.queueEnabled && rt.context?.mode === "conversation" && current(rt.context)) void request({ op: "hold" }).catch(() => {});
    }
    const nativeSend = event.type === "click" && button?.matches(D.SEND) && isComposerControl(button) || event.type === "keydown" && event.key === "Enter" && !event.shiftKey && !event.isComposing && isInput(event.target) || event.type === "submit" && event.target?.contains?.(rt.page?.composer);
    if (nativeSend) {
      const page = D.snapshot();
      if (page.empty) return;
      rt.completionHint = null;
      if (rt.attempt) rt.attempt.submitted = true;
      rt.pending = { at: Date.now(), baseline: rt.page?.userId || "", fromUsage: Q.route(location.href).mode === "usage", project: P.route(location.href, location.origin)?.projectId, text: Q.comparable(D.readText(page.composer)) };
      rt.quietAt = Date.now();
      if (rt.queueEnabled && !rt.sending && rt.context?.mode === "conversation" && current(rt.context)) void request({ op: "hold", baseline: page.userId }).catch(() => {});
    }
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
    if (area !== "local") return;
    if (Object.hasOwn(changes, QUEUE_SETTING)) rt.queueEnabled = changes[QUEUE_SETTING].newValue !== false;
    if (Object.hasOwn(changes, TOOL_FOLD_SETTING)) {
      rt.toolFoldEnabled = changes[TOOL_FOLD_SETTING].newValue !== false;
      try { rt.toolFoldEnabled ? globalThis.ChatGPTToolFold?.sync() : globalThis.ChatGPTToolFold?.dispose(); } catch {}
    }
    if (!rt.context) return;
    for (const [key, change] of Object.entries(changes)) {
      const n = change.newValue;
      if (key.startsWith("notice:notification:") && n?.pendingKind && n.scope === rt.context.scope && Q.route(n.url).id === rt.context.id) rt.notificationRetryAt = n.retryAt || Date.now() + 10000;
    }
    const queue = changes[rt.context.key]?.newValue;
    const usage = changes[U.PREFIX + rt.context.scope]?.newValue;
    const projectChange = changes[globalThis.ChatGPTProjects.PREFIX + rt.context.scope];
    if (projectChange) { rt.projects = projectChange.newValue || null; render(); }
    if (Object.hasOwn(changes, rt.context.key) && !queue) rt.queue = null;
    if (Object.hasOwn(changes, U.PREFIX + rt.context.scope) && !usage) rt.usage = null;
    accept({ queue, usage }, rt.context);
    if (Object.hasOwn(changes, QUEUE_SETTING)) { render(); void tick(); }
  };
  chrome.storage.onChanged.addListener(storageListener);
  function observedOutcome(p, active, now = Date.now()) {
    if (!active || p.userId !== active.id || !D.generationMatches(active.generationId, p)) return "running";
    const stopped = rt.stopped === active.id || rt.queue?.turn?.id === active.generationId && rt.queue.turn.stopped;
    const hinted = !stopped && active.networkAt && p.copy && p.assistantId && !p.waiting && !p.error;
    const outcome = stopped && !p.running ? "stopped" : hinted ? "completed" : p.outcome;
    // Both the sampler and a network-woken probe use this same semantic gate.
    // Transport completion, disappearing Stop, and an idle composer are not finality.
    const terminal = outcome === "attention" || ["completed", "recoverable", "blocked", "failed", "stopped"].includes(outcome) && (!p.running || hinted);
    const fingerprint = terminal && (outcome !== "completed" || p.ready) ? `${outcome}:${p.assistantId}:${outcome === "completed" ? p.settledText : ""}` : "";
    if (active.fingerprint !== fingerprint) { active.fingerprint = fingerprint; active.stableAt = now; }
    const delay = hinted ? 0 : outcome === "completed" ? 3000 : 2000;
    return fingerprint && now - active.stableAt >= delay && now - active.at >= delay ? outcome : "running";
  }
  async function recoverProbeTurn(message, scope, url, p) {
    if (rt.turn?.id === message.turnId && rt.context?.scope === scope) {
      if (Number.isFinite(message.at) && message.at > 0) rt.turn.networkAt = message.at;
      return rt.turn;
    }
    const key = Q.key(scope, url);
    if (!key || p.userId !== message.turnId) return rt.turn;
    const stored = (await chrome.storage.local.get(key))[key];
    const turn = stored?.turn, userId = turn?.userId || turn?.id;
    // An exact network candidate may wake a throttled hidden document after
    // its in-memory controller state was lost. Rebuild only from the durable
    // current turn; never borrow a retry/regeneration or a stopped turn.
    if (!turn || turn.done || turn.stopped || turn.outcome === "stopped" || turn.id !== message.turnId || userId !== p.userId) return rt.turn;
    if (!rt.queue || stored.revision >= rt.queue.revision) rt.queue = stored;
    const now = Date.now();
    rt.turn = {
      id: p.userId,
      generationId: turn.id,
      at: Number.isFinite(turn.at) ? turn.at : now,
      fingerprint: "",
      stableAt: now,
      counted: true,
      recovered: true,
      networkAt: Number.isFinite(message.at) && message.at > 0 ? message.at : now
    };
    return rt.turn;
  }
  const runtimeListener = (message, sender, reply) => {
    if (message?.type === "NOTICE_COMPLETION_HINT") {
      rt.completionHint = { scope: message.scope, id: message.turnId, at: message.at };
      if (rt.turn?.id === message.turnId && rt.context?.scope === message.scope) rt.turn.networkAt = message.at;
      reply({ ok: true }); void tick(true); return;
    }
    if (message?.type === "NOTICE_SCOPE") {
      const url = location.href;
      if (rt.disposed) { reply(null); return; }
      void D.scope().then(scope => reply(!rt.disposed && location.href === url ? { scope, url } : null), () => reply(null));
      return true;
    }
    if (message?.type !== "NOTICE_COMPLETION_PROBE") return;
    const url = location.href;
    if (rt.disposed) { reply(null); return; }
    void (async () => {
      const scope = await D.scope();
      if (rt.disposed || location.href !== url || scope !== message.scope) { reply(null); return; }
      const p = D.snapshot(document, true);
      const sameTurn = p.userId === message.turnId && current(rt.context) && rt.context.scope === scope;
      const active = sameTurn ? await recoverProbeTurn(message, scope, url, p) : null;
      const state = !sameTurn ? "stale" : observedOutcome(p, active);
      reply({
        scope, url, state, hidden: document.hidden,
        generationId: active?.id === message.turnId ? active.generationId : message.turnId,
        prompt: sameTurn ? D.readText(p.user).slice(0, 1000) : "",
        response: state === "completed" ? D.readText(p.assistant).slice(0, 1000) : ""
      });
      if (active) void tick(true);
    })().catch(() => reply(null));
    return true;
  };
  chrome.runtime.onMessage.addListener(runtimeListener);

  async function tick(wake = false) {
    if (rt.disposed) return;
    if (rt.tickBusy) { if (wake) rt.tickAgain = true; return; }
    rt.tickBusy = true;
    try {
      runtime();
      const url = location.href;
      const route = Q.route(url);
      if (rt.toolFoldEnabled) try { globalThis.ChatGPTToolFold?.sync(); } catch {}
      if (route.mode === "off") { try { globalThis.ChatGPTScrollStabilizer?.sample(null); } catch {} rt.context = { mode: "off", url, scope: "", key: "" }; rt.page = null; render(); return; }
      const scope = await D.scope();
      if (location.href !== url) return;
      const key = Q.key(scope, url);
      const p = D.snapshot(document, Boolean(rt.turn));
      const changed = rt.context?.url !== url || rt.context.scope !== scope;
      if (changed) {
        const old = rt.context;
        const firstSendPending = old?.scope === scope && rt.pending?.fromUsage && Date.now() - rt.pending.at < 60000;
        const promotedId = rt.pending?.promotedId || "";
        const promoting = firstSendPending && route.mode === "conversation" && (!promotedId || promotedId === route.id);
        const carryingFirstSend = firstSendPending && (route.mode === "usage" || promoting);
        if (promoting && !rt.pending.promotedId) rt.pending.promotedId = route.id;
        rt.previousTail = old?.mode === "conversation" && old.id !== route.id ? rt.lastUserId : "";
        rt.context = { ...route, url, scope, key: key || `usage:${scope}` };
        rt.projects = null; rt.projectSignature = "";
        rt.notificationRetryAt = 0; rt.notificationError = "";
        rt.queue = null; rt.usage = null; rt.turn = null; rt.lastUserId = promoting ? "" : p.userId;
        if (old?.scope && old.scope !== scope) rt.completionHint = null;
        rt.quietAt = Date.now(); rt.stopped = ""; rt.retryBaseline = null; rt.addAttempt = null;
        if (!carryingFirstSend) rt.pending = null;
        if (scope) await request({ op: "get" });
        if (!current(rt.context)) return;
      }
      rt.page = p;
      try { globalThis.ChatGPTScrollStabilizer?.sample(p.assistant || p.user || null); } catch {}
      try { globalThis.ChatGPTSidebar.sample(url); } catch {}
      const now = Date.now();
      const pendingSubmission = Boolean(rt.pending && now - rt.pending.at < 60000 && p.userId && p.userId !== rt.pending.baseline);
      if (route.mode === "conversation" && pendingSubmission && rt.pending?.project && rt.pending.text && Q.comparable(D.readText(p.user)) === rt.pending.text) rt.projectPromote = { scope, id: rt.pending.project };
      void refreshProjects(rt.context);
      if (scope && (!rt.usage || route.mode === "conversation" && !rt.queue)) await request({ op: "get" });
      if (scope && route.mode === "conversation" && rt.notificationRetryAt && now >= rt.notificationRetryAt) await request({ op: "get" });
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
      // Native turns may add attachment metadata; Queue receipts still require exact text.
      const durableSubmission = Boolean(rt.queue?.holdUntil && (!rt.queue?.turn || rt.queue.turn.done) && rt.queue.holdBaseline && p.userId && p.userId !== rt.queue.holdBaseline);
      const confirmedSubmission = Boolean(pendingSubmission || durableSubmission);
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
        const candidate = { id: p.userId, generationId, at: resume && !regenerated ? storedTurn.at : durableSubmission ? rt.queue.holdUntil : now, fingerprint: "", stableAt: now, counted: Boolean(regenerated || recoveredCompleted || generationId !== p.userId), recovered: Boolean(recoveredCompleted && !confirmedSubmission), networkAt: rt.completionHint?.scope === scope && rt.completionHint.id === p.userId ? rt.completionHint.at : 0 };
        if (regenerated) rt.stopped = "";
        const started = await request({ op: "start", userId: p.userId, generationId,
          previousUserId: durableSubmission ? rt.queue.holdBaseline : D.precedes(storedUser, p.user) ? storedUser : "", retryOf: retry ? storedTurn?.id : "" });
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
      const active = rt.turn;
      const networkSettled = (active?.networkAt || rt.completionHint?.id === p.userId && rt.completionHint.at) && p.copy && !p.waiting && !p.error;
      if (p.running && !networkSettled) rt.quietAt = now;
      if (active && p.userId === active.id && D.generationMatches(active.generationId, p)) {
        const outcome = observedOutcome(p, active, now);
        if (!active.counted && outcome === "completed" && U.MODELS.has(p.model)) {
          // Count only confirmed completed replies; usage failures must not block Queue.
          try {
            await request(null, rt.context, { op: "record", turnId: active.id, model: p.model, at: active.at });
            active.counted = true;
          } catch {}
        }
        if (outcome !== "running" && (outcome !== "attention" || !rt.queue?.turn?.attention)) {
          const hidden = document.hidden;
          await request({ op: outcome === "attention" ? "attention" : "settle", userId: active.id, generationId: active.generationId, assistantId: p.assistantId, outcome, suppressNotify: Boolean(active.recovered),
            notice: { prompt: D.readText(p.user).slice(0, 1000), response: hidden || outcome !== "completed" ? "" : D.readText(p.assistant).slice(0, 1000), elapsedMs: Math.max(0, now - active.at), hidden } });
          if (outcome !== "attention") {
            rt.turn = null; rt.stopped = ""; if (rt.completionHint?.id === active.id && (rt.queue?.paused || !rt.queue?.items.length)) rt.completionHint = null; rt.quietAt = ["completed", "recoverable"].includes(outcome) ? 0 : now;
          }
        }
      }
      render();
      if (!rt.actionBusy && !rt.sending && safeToSend(p) && !rt.queue?.paused && rt.queue?.items[0]?.state === "pending") await dispatch(rt.queue.items[0].id, false);
    } catch (error) {
      // Missing adapters, storage failures and route races do not fall back to sending.
      render(error.message);
    } finally {
      rt.tickBusy = false;
      if (rt.tickAgain) { rt.tickAgain = false; void tick(true); }
    }
  }

  function errorAllowsNext(p) {
    const turn = rt.queue?.turn;
    return !p.error || p.failure === "recoverable" && turn?.done && turn.outcome === "recoverable" && (turn.userId || turn.id) === p.userId && D.generationMatches(turn.id, p);
  }
  function safeToSend(p) {
    return Boolean(rt.queueEnabled && rt.context?.mode === "conversation" && rt.context.scope && current(rt.context) && !rt.previousTail &&
      p.userId && p.ready && p.empty && !p.running && errorAllowsNext(p) && !rt.turn && !rt.composing &&
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
      if (!rt.queueEnabled || !current(context) || rt.inputEpoch !== epoch || rt.composing || p.composer !== input || !p.ready || p.running || !errorAllowsNext(p) || p.attachments || rt.queue?.holdUntil || rt.queue?.turn && !rt.queue.turn.done || D.readText(input).trim() !== expected.trim() || item && (Date.now() >= item.expiresAt || p.userId !== item.baseline)) throw new Error("页面或草稿已变化，发送已停止");
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
        await new Promise(resolve => setTimeout(resolve, 100));
        if (await D.scope() !== context.scope) throw new Error("账号已切换，发送已停止");
        page = guard(item.text);
        if (!manual && rt.queue?.paused) throw new Error("队列已暂停，草稿保留");
        const button = D.sendButton();
        if (button && D.enabled(button)) {
          clicked = true; // Before click: any exception after this point is ambiguous.
          rt.completionHint = null;
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
      if (!rt.queueEnabled) throw new Error("Queue 功能已关闭");
      if (context.mode !== "conversation") throw new Error("仅正式对话提供 Queue");
      if (name === "add") {
        const page = D.snapshot(), text = D.readText(page.composer), epoch = rt.inputEpoch;
        if (!text.trim() || !page.composer || page.attachments || rt.composing) throw new Error("仅支持已完成输入的纯文本；草稿和附件未改动");
        if (page.running && page.userId && !rt.queue?.turn) await request({ op: "start", userId: page.userId }, context);
        if (!rt.addAttempt || rt.addAttempt.text !== text || rt.addAttempt.context !== context) rt.addAttempt = { id: Q.id(), text, context };
        await request({ op: "add", id: rt.addAttempt.id, text }, context);
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
  for (const type of ["popstate", "pageshow"]) addEventListener(type, () => void tick(true), { signal: events.signal });
  for (const type of ["visibilitychange", "resume"]) document.addEventListener(type, () => void tick(true), { signal: events.signal });
  globalThis.ChatGPTNotice = { dispose() { disconnect(); ui.dispose(); delete globalThis.ChatGPTNotice; } };
  void (async () => {
    try {
      const settings = await chrome.storage.local.get([QUEUE_SETTING, TOOL_FOLD_SETTING]);
      rt.queueEnabled = settings[QUEUE_SETTING] !== false;
      rt.toolFoldEnabled = settings[TOOL_FOLD_SETTING] !== false;
    }
    catch (error) { render(error.message); }
    if (rt.disposed) return;
    interval = setInterval(() => void tick(), 1000);
    void tick();
  })();
})();
