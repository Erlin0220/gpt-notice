(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTUsage = api;
})(globalThis, function () {
  "use strict";
  const PREFIX = "notice:usage:";
  const WEEK = 7 * 24 * 60 * 60 * 1000;
  // This account's configured Chat allowance is shared by these two Pro
  // model slugs. Work/Codex model slugs are intentionally excluded.
  const MODELS = new Set(["gpt-6-pro", "gpt-5-6-pro"]);
  function fresh(now = Date.now()) {
    return { version: 1, revision: 0, limit: 50, firstUseDate: "2026-09-09", recordedSince: now,
      cycleStart: 0, resetAt: 0, resetSource: "unknown", correction: 0, baselineKnown: false, entries: [], updatedAt: now };
  }
  function normalize(raw, now = Date.now()) {
    const state = raw?.version === 1 ? structuredClone(raw) : fresh(now);
    if (state.resetAt > 0 && now >= state.resetAt) {
      const boundary = state.resetAt + Math.floor((now - state.resetAt) / WEEK) * WEEK;
      state.cycleStart = boundary;
      state.resetAt = boundary + WEEK;
      state.correction = 0;
      state.baselineKnown = false;
      state.resetSource = "manual-schedule";
    }
    return state;
  }
  function count(state) {
    return Math.max(0, state.correction + state.entries.filter(e => e.at >= state.cycleStart).length);
  }
  function apply(raw, command, now = Date.now()) {
    const state = normalize(raw, now);
    const before = JSON.stringify(state);
    if (command.op === "record") {
      if (MODELS.has(command.model) && /^[\w:-]{1,220}$/.test(command.turnId || "") && !state.entries.some(e => e.id === command.turnId)) {
        const at = Number(command.at);
        if (!Number.isFinite(at) || at < state.recordedSince - 60000 || at > now + 5000) throw new Error("无效的用量观察时间");
        state.entries.push({ id: command.turnId, model: command.model, at });
        state.entries = state.entries.filter(e => e.at >= now - 90 * 24 * 60 * 60 * 1000);
      }
    } else if (command.op === "edit") {
      if (command.revision !== state.revision) throw new Error("用量已变化，请重新打开校正面板");
      const limit = Number(command.limit);
      const resetAt = command.resetAt ? Number(command.resetAt) : 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("请输入有效的额度");
      if (resetAt && (!Number.isFinite(resetAt) || resetAt <= now || resetAt > now + 2 * WEEK)) throw new Error("刷新时间须为未来两周内的已确认时间");
      state.limit = limit;
      if (resetAt !== state.resetAt) {
        state.resetAt = resetAt;
        state.cycleStart = resetAt ? resetAt - WEEK : 0;
        state.resetSource = resetAt ? "manual" : "unknown";
        state.correction = 0;
        state.baselineKnown = false;
      }
      if (command.total !== "" && command.total !== undefined && command.total !== null) {
        const total = Number(command.total);
        if (!Number.isSafeInteger(total) || total < 0 || total > 100000) throw new Error("请输入有效的已用次数");
        state.correction = total - state.entries.filter(e => e.at >= state.cycleStart).length;
        state.baselineKnown = true;
      } else {
        state.correction = 0;
        state.baselineKnown = false;
      }
    } else if (command.op !== "get") throw new Error("未知用量操作");
    const changed = !raw || JSON.stringify(raw) !== JSON.stringify(state) || JSON.stringify(state) !== before;
    if (changed) { state.revision += 1; state.updatedAt = now; }
    return { state, changed };
  }
  function summary(raw, now = Date.now()) {
    const state = normalize(raw, now);
    const used = count(state);
    return { ...state, used, label: `GPT-6 · ${state.baselineKnown ? "校正后 " : "本地记录 "}${used} / ${state.limit}`,
      resetLabel: state.resetAt ? `${new Date(state.resetAt).toLocaleString()} · ${state.resetSource === "manual" ? "手动确认" : "按手动周期推算"}` : "刷新时间未知 · 请以原生额度提示为准",
      sourceLabel: state.baselineKnown ? "手动基数 + 本机观察；不是官方实时余额" : "仅本机观察；此前及其他设备用量未知，不能据此计算官方剩余次数" };
  }
  return { PREFIX, WEEK, MODELS, fresh, normalize, count, apply, summary };
});
