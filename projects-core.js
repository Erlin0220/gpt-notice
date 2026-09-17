(function (root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTProjects = api;
})(globalThis, function () {
  "use strict";
  const PREFIX = "notice:projects:";
  const clean = (value, max) => typeof value === "string" ? value.replace(/\s+/g, " ").trim().slice(0, max) : "";
  // Observed native project identifiers, not a guessed slug/name conversion.
  function route(value, origin = "https://chatgpt.com") {
    try {
      const url = new URL(value, origin);
      if (url.origin !== origin || url.username || url.password || url.search || url.hash) return null;
      const match = /^\/g\/(g-p-([a-f0-9]{32})(?:-[a-zA-Z0-9_-]+)?)\/(?:project|c\/[\w-]+)\/?$/.exec(url.pathname);
      return match ? { projectId: `g-p-${match[2]}`, shortUrl: match[1] } : null;
    } catch { return null; }
  }
  function normalize(value) {
    if (!value || typeof value !== "object") return null;
    const shortUrl = clean(value.shortUrl, 250);
    const parsed = route(`/g/${shortUrl}/project`);
    const name = clean(value.name, 180);
    if (!parsed || parsed.projectId !== value.projectId || !name) return null;
    const out = { ...parsed, name };
    if (value.emoji === null) out.emoji = ""; else if (typeof value.emoji === "string") out.emoji = clean(value.emoji, 40);
    if (value.theme === null) out.theme = ""; else if (typeof value.theme === "string" && /^(?:#[a-f0-9]{6})?$/i.test(value.theme)) out.theme = value.theme;
    if (value.visual && typeof value.visual === "object") {
      const sprite = value.visual.sprite === "core" || value.visual.sprite === "shell" ? value.visual.sprite : "";
      const symbol = clean(value.visual.symbol, 40);
      if (sprite && /^[a-z0-9-]+$/i.test(symbol)) {
        out.visual = { sprite, symbol };
        const color = clean(value.visual.color, 32); if (color) out.visual.color = color;
      }
    }
    if (Number.isFinite(value.observedAt) && value.observedAt > 0 && value.observedAt <= Date.now() + 60_000) out.observedAt = value.observedAt;
    return out;
  }
  function fromCache(raw) {
    if (!raw || raw.length > 2_000_000) return [];
    try {
      const cache = JSON.parse(raw);
      const items = Array.isArray(cache.value?.pages) ? cache.value.pages.flatMap(p => Array.isArray(p.items) ? p.items : []) : [];
      return items.slice(0, 500).map(item => {
        const g = item?.gizmo?.gizmo;
        return normalize({ projectId: g?.id, shortUrl: g?.short_url, name: g?.display?.name,
          emoji: g?.emoji ?? g?.display?.emoji, theme: g?.theme ?? g?.display?.theme, observedAt: cache.timestamp });
      }).filter(Boolean);
    } catch { return []; }
  }
  function merge(raw, observations = [], now = Date.now()) {
    if (raw && (raw.version !== 1 || !Array.isArray(raw.items))) throw new Error("项目快捷数据版本不兼容，未覆盖原数据");
    if (!Array.isArray(observations) || observations.length > 500) throw new Error("项目观察数量无效");
    const items = new Map((raw?.items || []).map(p => [p.projectId, p]));
    let changed = !raw;
    for (const observation of observations) {
      const value = normalize(observation);
      if (!value) continue;
      const old = items.get(value.projectId);
      // A stale native cache must not undo a newer title seen on a project page.
      if (value.observedAt && old?.observedAt > value.observedAt) continue;
      const next = { ...old, ...value, observedAt: value.observedAt || now };
      if (old && value.observedAt && (old.emoji !== value.emoji || old.theme !== value.theme) && !value.visual) delete next.visual;
      if (old && ["shortUrl", "name", "emoji", "theme"].every(k => old[k] === next[k]) && JSON.stringify(old.visual || null) === JSON.stringify(next.visual || null)) continue;
      items.set(value.projectId, next); changed = true;
    }
    return { state: changed ? { version: 1, revision: (raw?.revision || 0) + 1, items: [...items.values()] } : raw, changed };
  }
  return { PREFIX, route, normalize, fromCache, merge };
});
