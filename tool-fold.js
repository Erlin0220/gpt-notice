(() => {
  "use strict";
  if (globalThis.ChatGPTToolFold) return;
  const MARKER = '[class~="group/tool-message"]';
  const FLOW = "data-gpt-notice-tool-flow";
  const ROW = "data-gpt-notice-tool-row";
  const RICH = 'iframe,canvas,video,audio,table,picture,object,embed,img,.no-scrollbar,[role="application"],[role="region"],[data-testid*="app"],[data-testid*="widget"],[data-testid*="artifact"]';
  const bound = new WeakSet();
  let style = null, active = false;

  function toolRow(marker) {
    let row = marker.closest(".contents");
    if (!row) return null;
    while (row.parentElement?.classList.contains("contents")) row = row.parentElement;
    return row;
  }
  function thoughtButton(flow, firstToolRow) {
    for (const child of flow.children) {
      if (child === firstToolRow) break;
      const button = child.querySelector?.('button[aria-expanded]');
      if (button && !child.querySelector(MARKER)) return button;
    }
    return null;
  }
  function passiveSummary(row) {
    const marker = row.querySelector(MARKER);
    if (!marker || row.querySelector(RICH)) return false;
    return ![...row.querySelectorAll("button,a,input,textarea,select")].some(control => !marker.contains(control));
  }
  function ensureStyle(doc) {
    if (style?.isConnected) return;
    style = doc.createElement("style");
    style.id = "gpt-notice-tool-fold-style";
    style.textContent = `[${FLOW}="collapsed"] > .contents:has(${MARKER}),[${ROW}="hidden"]{display:none!important}`;
    (doc.head || doc.documentElement).append(style);
  }
  function bind(button, doc) {
    if (bound.has(button)) return;
    bound.add(button);
    button.addEventListener("click", () => {
      if (!active) return;
      requestAnimationFrame(() => { if (active) sync(doc); });
    });
  }
  function sync(doc = document) {
    active = true;
    ensureStyle(doc);
    const groups = new Map();
    for (const marker of doc.querySelectorAll(MARKER)) {
      const row = toolRow(marker), flow = row?.parentElement;
      const turn = marker.closest('[data-turn-id], [data-testid^="conversation-turn-"], [data-turn-key]');
      if (!row || !flow || !turn || !row.classList.contains("contents") || !turn.contains(flow)) continue;
      let group = groups.get(flow);
      if (!group) groups.set(flow, group = []);
      if (!group.includes(row)) group.push(row);
    }
    for (const flow of doc.querySelectorAll(`[${FLOW}]`)) if (!groups.has(flow)) flow.removeAttribute(FLOW);
    const ownedRows = new Set([...groups.values()].flat());
    for (const row of doc.querySelectorAll(`[${ROW}]`)) if (!ownedRows.has(row)) row.removeAttribute(ROW);
    for (const [flow, rows] of groups) {
      const thought = thoughtButton(flow, rows[0]);
      for (const row of rows) row.removeAttribute(ROW);
      if (thought) {
        bind(thought, doc);
        flow.setAttribute(FLOW, thought.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
        continue;
      }
      // Current ChatGPT (2026-09) no longer renders a turn-level Thought
      // disclosure for many tool-heavy replies. Keep one native "tool calls"
      // summary as the escape hatch and compact only passive duplicate rows.
      const passive = rows.filter(passiveSummary);
      if (passive.length < 2) { flow.removeAttribute(FLOW); continue; }
      flow.setAttribute(FLOW, "compact");
      const keep = passive.at(-1);
      for (const row of passive) row.setAttribute(ROW, row === keep ? "keep" : "hidden");
    }
  }
  function dispose(doc = document) {
    active = false;
    for (const flow of doc.querySelectorAll(`[${FLOW}]`)) flow.removeAttribute(FLOW);
    for (const row of doc.querySelectorAll(`[${ROW}]`)) row.removeAttribute(ROW);
    style?.remove(); style = null;
  }
  globalThis.ChatGPTToolFold = { sync, dispose };
})();
