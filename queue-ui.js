(function attachQueueUI(root, factory) {
  const api = factory();
  if (typeof module === "object" && module.exports) module.exports = api;
  root.ChatGPTQueueUI = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function createQueueUIApi() {
  const DEFAULT_ROOT_ID = "chatgpt-message-queue-root";
  const PREVIEW_LENGTH = 240;
  const STATUS_LABELS = { pending: "等待", dispatching: "发送中", running: "执行中", completed: "已完成", failed: "失败" };

  function create({ documentRef = globalThis.document, ownerId = "", onAction = async () => {}, rootId = DEFAULT_ROOT_ID } = {}) {
    let root = null;
    let lastSignature = "";

    function ensure() {
      const existing = documentRef.getElementById(rootId);
      if (existing && existing.dataset.gptqOwner !== ownerId) existing.remove();
      root = documentRef.getElementById(rootId);
      if (!root) {
        root = documentRef.createElement("div");
        root.id = rootId;
        root.dataset.gptqOwner = ownerId;
        root.innerHTML = buildMarkup();
        (documentRef.body || documentRef.documentElement).appendChild(root);
        bindEvents(root);
      }
      return root;
    }

    function bindEvents(node) {
      node.addEventListener("click", async (event) => {
        const button = event.target?.closest?.("button");
        if (!button || !node.contains(button)) return;
        const action = button.dataset.action || (button.classList.contains("gptq-trigger") ? "toggle-panel" : "");
        if (!action) return;
        event.preventDefault();
        event.stopPropagation();
        event.stopImmediatePropagation();
        await onAction({ action, itemId: button.dataset.id || "", button, root: node });
      }, true);
    }

    function render(model = {}) {
      const node = ensure();
      const normalized = normalizeModel(model);
      const signature = JSON.stringify(normalized);
      if (signature === lastSignature) return false;
      lastSignature = signature;

      setText(node.querySelector(".gptq-count"), normalized.pendingCount);
      node.querySelector(".gptq-trigger")?.classList.toggle("has-items", normalized.pendingCount > 0);
      const enqueue = node.querySelector('[data-action="enqueue"]');
      if (enqueue) {
        enqueue.disabled = normalized.busy;
        enqueue.title = normalized.enqueueTitle;
      }
      const pause = node.querySelector('[data-action="pause"]');
      if (pause) pause.textContent = normalized.paused ? "继续" : "暂停";
      setText(node.querySelector(".gptq-status"), normalized.statusText);
      syncItems(node.querySelector(".gptq-list"), normalized.items, documentRef);
      node.dataset.busy = normalized.busy ? "true" : "false";
      return true;
    }

    function syncItems(list, items, doc) {
      if (!list) return;
      const existing = new Map([...list.querySelectorAll(".gptq-item[data-id]")].map((node) => [node.dataset.id, node]));
      const wanted = new Set(items.map((item) => item.id));
      for (const [id, node] of existing) if (!wanted.has(id)) node.remove();
      list.querySelector(".gptq-empty")?.remove();
      if (!items.length) {
        const empty = doc.createElement("li");
        empty.className = "gptq-empty";
        empty.textContent = "输入下一条消息后加入队列";
        list.appendChild(empty);
        return;
      }
      items.forEach((item, index) => {
        let node = existing.get(item.id);
        if (!node) {
          node = createItemNode(doc, item.id);
          list.appendChild(node);
        }
        updateItemNode(node, item, index, doc);
        if (list.children[index] !== node) list.insertBefore(node, list.children[index] || null);
      });
    }

    function openConfirmation(mode, itemId, message) {
      const node = ensure();
      const box = node.querySelector(".gptq-confirm");
      if (!box || !itemId) return false;
      if (!box.hidden && box.dataset.mode && box.dataset.mode !== "auto-execute" && mode === "auto-execute") return false;
      box.dataset.mode = mode;
      box.dataset.itemId = itemId;
      setText(box.querySelector(".gptq-confirm-message"), message);
      box.hidden = false;
      const panel = node.querySelector(".gptq-panel");
      if (panel) panel.hidden = false;
      lastSignature = "";
      return true;
    }

    function closeConfirmation(onlyMode = "") {
      const node = ensure();
      const box = node.querySelector(".gptq-confirm");
      if (!box || (onlyMode && box.dataset.mode !== onlyMode)) return;
      box.hidden = true;
      delete box.dataset.mode;
      delete box.dataset.itemId;
      setText(box.querySelector(".gptq-confirm-message"), "");
      lastSignature = "";
    }

    function getConfirmation() {
      const box = ensure().querySelector(".gptq-confirm");
      if (!box || box.hidden) return { mode: "", itemId: "" };
      return { mode: box.dataset.mode || "", itemId: box.dataset.itemId || "" };
    }

    function setPanelOpen(open) {
      const panel = ensure().querySelector(".gptq-panel");
      if (panel) panel.hidden = !open;
    }

    function togglePanel() {
      const panel = ensure().querySelector(".gptq-panel");
      if (panel) panel.hidden = !panel.hidden;
    }

    function setBusy(busy) {
      const node = ensure();
      node.dataset.busy = busy ? "true" : "false";
      for (const button of node.querySelectorAll("button")) button.disabled = Boolean(busy);
      lastSignature = "";
    }

    function invalidate() { lastSignature = ""; }

    return { ensure, render, openConfirmation, closeConfirmation, getConfirmation, setPanelOpen, togglePanel, setBusy, invalidate, getRoot: () => ensure() };
  }

  function normalizeModel(model) {
    return {
      pendingCount: Math.max(0, Number(model.pendingCount || 0)),
      paused: Boolean(model.paused),
      busy: Boolean(model.busy),
      enqueueTitle: String(model.enqueueTitle || "将输入框内容加入当前页面队列"),
      statusText: String(model.statusText || "暂无等待消息"),
      items: (model.items || []).map((item) => ({
        id: String(item.id || ""),
        status: String(item.status || "pending"),
        text: String(item.text || ""),
        error: String(item.error || ""),
        canModify: Boolean(item.canModify),
        canRetry: Boolean(item.canRetry),
        canDelete: Boolean(item.canDelete)
      })).filter((item) => item.id)
    };
  }

  function createItemNode(doc, id) {
    const node = doc.createElement("li");
    node.className = "gptq-item";
    node.dataset.id = id;
    const main = doc.createElement("div");
    main.className = "gptq-item-main";
    const index = doc.createElement("span");
    index.className = "gptq-index";
    const content = doc.createElement("div");
    const preview = doc.createElement("p");
    const meta = doc.createElement("small");
    content.append(preview, meta);
    main.append(index, content);
    const actions = doc.createElement("div");
    actions.className = "gptq-item-actions";
    node.append(main, actions);
    return node;
  }

  function updateItemNode(node, item, index, doc) {
    node.dataset.status = item.status;
    setText(node.querySelector(".gptq-index"), index + 1);
    const preview = item.text.length > PREVIEW_LENGTH ? `${item.text.slice(0, PREVIEW_LENGTH)}…` : item.text;
    setText(node.querySelector("p"), preview);
    setText(node.querySelector("small"), `${STATUS_LABELS[item.status] || item.status} · ${item.text.length.toLocaleString()} 字符${item.error ? ` · ${item.error}` : ""}`);
    const actions = node.querySelector(".gptq-item-actions");
    const actionSignature = JSON.stringify([item.canModify, item.canRetry, item.canDelete]);
    if (actions.dataset.signature === actionSignature) return;
    actions.dataset.signature = actionSignature;
    actions.replaceChildren();
    if (item.canModify) {
      actions.append(createButton(doc, "编辑", "edit", item.id));
      actions.append(createButton(doc, "立即执行", "execute-now", item.id));
    }
    if (item.canRetry) actions.append(createButton(doc, "重试", "retry", item.id));
    if (item.canDelete) actions.append(createButton(doc, "删除", "delete", item.id));
  }

  function createButton(doc, label, action, id = "") {
    const button = doc.createElement("button");
    button.type = "button";
    button.dataset.action = action;
    if (id) button.dataset.id = id;
    button.textContent = label;
    return button;
  }

  function setText(node, value) {
    if (node && node.textContent !== String(value ?? "")) node.textContent = String(value ?? "");
  }

  function buildMarkup() {
    return `
      <div class="gptq-dock">
        <button class="gptq-quick-add" type="button" data-action="enqueue">加入队列</button>
        <button class="gptq-trigger" type="button"><span>队列</span><strong class="gptq-count">0</strong></button>
      </div>
      <section class="gptq-panel" hidden>
        <header><strong>消息队列</strong><button type="button" data-action="close" aria-label="关闭">×</button></header>
        <div class="gptq-actions"><button type="button" data-action="pause">暂停</button><button type="button" data-action="clear-completed">清除已完成</button></div>
        <div class="gptq-confirm" hidden><p class="gptq-confirm-message"></p><div class="gptq-confirm-actions"><button type="button" data-action="cancel-confirm">否</button><button type="button" data-action="confirm-action">是</button></div></div>
        <div class="gptq-status"></div>
        <ol class="gptq-list"></ol>
      </section>`;
  }

  return { create, normalizeModel, PREVIEW_LENGTH };
});
