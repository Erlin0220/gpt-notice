(() => {
  "use strict";
  if (globalThis.ChatGPTToolFold) return;
  const MARKER = '[class~="group/tool-message"]';
  const FLOW = "data-gpt-notice-tool-flow";
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
  function ensureStyle(doc) {
    if (style?.isConnected) return;
    style = doc.createElement("style");
    style.id = "gpt-notice-tool-fold-style";
    style.textContent = `[${FLOW}="collapsed"] > .contents:has(${MARKER}){display:none!important}`;
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
      const turn = marker.closest('[data-turn-id], [data-testid^="conversation-turn-"]');
      if (!row || !flow || !turn || !row.classList.contains("contents") || !turn.contains(flow)) continue;
      let group = groups.get(flow);
      if (!group) groups.set(flow, group = []);
      if (!group.includes(row)) group.push(row);
    }
    for (const flow of doc.querySelectorAll(`[${FLOW}]`)) if (!groups.has(flow)) flow.removeAttribute(FLOW);
    for (const [flow, rows] of groups) {
      const thought = thoughtButton(flow, rows[0]);
      if (!thought) { flow.removeAttribute(FLOW); continue; }
      bind(thought, doc);
      flow.setAttribute(FLOW, thought.getAttribute("aria-expanded") === "true" ? "expanded" : "collapsed");
    }
  }
  function dispose(doc = document) {
    active = false;
    for (const flow of doc.querySelectorAll(`[${FLOW}]`)) flow.removeAttribute(FLOW);
    style?.remove(); style = null;
  }
  globalThis.ChatGPTToolFold = { sync, dispose };
})();
