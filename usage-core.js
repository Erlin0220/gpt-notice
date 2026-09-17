(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTUsage = api;
})(globalThis, function () {
  "use strict";
  const PREFIX = "notice:usage:";
  const DAY = 24 * 60 * 60 * 1000;
  const DEFAULT_CYCLE_DAYS = 7;
  const MAX_CYCLE_DAYS = 90;
  // This account's configured Chat allowance is shared by these two Pro
  // model slugs. Work/Codex model slugs are intentionally excluded.
  const MODELS = new Set(["gpt-6-pro", "gpt-5-6-pro"]);
  const cycleDays = value => Number.isSafeInteger(Number(value)) && Number(value) >= 1 && Number(value) <= MAX_CYCLE_DAYS ? Number(value) : DEFAULT_CYCLE_DAYS;
  const shortReset = value => {
    if (!value) return "刷新未知";
    const date = new Date(value);
    const pad = number => String(number).padStart(2, "0");
    return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} 刷新`;
  };
  function fresh(now = Date.now()) {
    return { version: 1, revision: 0, limit: 50, recordedSince: now,
      cycleDays: DEFAULT_CYCLE_DAYS, cycleStart: 0, resetAt: 0, correction: 0, baselineKnown: false, entries: [] };
  }
  function normalize(raw, now = Date.now()) {
    if (raw && (raw.version !== 1 || !Array.isArray(raw.entries))) throw new Error("本地用量数据格式异常；未覆盖原始数据，请先备份检查");
    const state = raw?.version === 1 ? structuredClone(raw) : fresh(now);
    delete state.firstUseDate;
    delete state.resetSource;
    delete state.updatedAt;
    state.cycleDays = cycleDays(state.cycleDays);
    const period = state.cycleDays * DAY;
    if (state.resetAt > 0 && now >= state.resetAt) {
      const boundary = state.resetAt + Math.floor((now - state.resetAt) / period) * period;
      state.cycleStart = boundary;
      state.resetAt = boundary + period;
      state.correction = 0;
      state.baselineKnown = false;
    }
    // Keep the whole counted interval. With an unknown reset, deleting old
    // entries would silently reduce both observed totals and manual corrections.
    state.entries = state.entries.filter(e => e.at >= now - MAX_CYCLE_DAYS * DAY || e.at >= state.cycleStart);
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
      }
    } else if (command.op === "edit") {
      if (command.revision !== state.revision) throw new Error("用量设置已变化，请重新打开面板");
      const limit = Number(command.limit);
      const nextCycleDays = Number(command.cycleDays ?? state.cycleDays);
      const resetAt = command.resetAt ? Number(command.resetAt) : 0;
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 10000) throw new Error("请输入有效的额度");
      if (!Number.isSafeInteger(nextCycleDays) || nextCycleDays < 1 || nextCycleDays > MAX_CYCLE_DAYS) throw new Error(`刷新周期须为 1-${MAX_CYCLE_DAYS} 天`);
      const period = nextCycleDays * DAY;
      if (!Number.isFinite(resetAt) || resetAt !== 0 && (resetAt <= now || resetAt > now + 2 * period)) throw new Error("刷新时间须为未来两个刷新周期内的时间");
      state.limit = limit;
      if (resetAt !== state.resetAt || nextCycleDays !== state.cycleDays) {
        state.cycleDays = nextCycleDays;
        state.resetAt = resetAt;
        state.cycleStart = resetAt ? resetAt - period : 0;
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
    if (changed) state.revision += 1;
    return { state, changed };
  }
  function summary(raw, now = Date.now()) {
    if (raw && (raw.version !== 1 || !Array.isArray(raw.entries))) {
      return { incompatible: true, revision: Number.isSafeInteger(raw.revision) ? raw.revision : 0, used: 0, limit: "", cycleDays: "", resetAt: 0, baselineKnown: false,
        label: "GPT-6 · 数据需升级", resetLabel: "本地用量数据版本不兼容", sourceLabel: "请更新扩展；原数据未被覆盖" };
    }
    const state = normalize(raw, now);
    const used = count(state);
    return { ...state, used, label: `GPT-6 · ${used} / ${state.limit} · ${shortReset(state.resetAt)}`,
      resetLabel: state.resetAt ? `下一次刷新：${new Date(state.resetAt).toLocaleString()} · 每 ${state.cycleDays} 天` : `下一次刷新：未知 · 每 ${state.cycleDays} 天`,
      sourceLabel: state.baselineKnown ? "手动基数 + 本机观察；不是官方实时余额" : "仅本机观察；此前及其他设备用量未知，不能据此计算官方剩余次数" };
  }
  return { PREFIX, DAY, DEFAULT_CYCLE_DAYS, MAX_CYCLE_DAYS, MODELS, fresh, normalize, count, apply, summary };
});
