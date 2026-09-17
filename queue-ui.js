(() => {
  "use strict";
  const CSS = `
    :host{all:initial;position:fixed;display:block;z-index:9;pointer-events:none;font:12px/1.45 system-ui,sans-serif;color:var(--n-fg,#252525);transform:translateY(-100%)}
    *{box-sizing:border-box}[hidden],:host([hidden]){display:none!important}
    :host([data-native-overlay]) :is(.bar,.panel,.usage-popover,.usage-backdrop,.notice){visibility:hidden!important;pointer-events:none!important}
    .bar{display:flex;align-items:center;width:100%;pointer-events:none}.queue-actions{display:flex;align-items:center;gap:2px;margin-left:auto;padding:3px}
    .queue-actions,.usage{border:1px solid var(--n-line,#ddd);border-radius:12px;background:var(--n-bg,#fff)}:host([data-project]) .usage{margin-inline:auto}
    button,input,textarea{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--n-line,#ddd);border-radius:9px;padding:6px 10px;background:var(--n-bg,#fff);min-height:30px;pointer-events:auto}
    button:hover{background:var(--n-hover,#f0f0f0)}:is(button,input,textarea):focus-visible{outline:2px solid #538ae8;outline-offset:2px}button:disabled{opacity:.45;cursor:default}
    .bar button{min-height:28px;padding:5px 9px;border:0;background:transparent}
    .usage{min-width:0;max-width:min(380px,65vw);overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--n-muted,#666);font-weight:500;padding:8px 12px}.queue{display:flex;align-items:center;gap:5px}.count{display:inline-grid;min-width:18px;height:18px;place-items:center;padding:0 5px;border-radius:999px;background:var(--n-hover,#f0f0f0);font-size:11px}
    .panel{position:absolute;bottom:calc(100% + 6px);right:0;width:min(100%,620px);max-height:min(58vh,560px,var(--n-panel-height,560px));overflow:auto;overscroll-behavior:contain;pointer-events:auto;border:1px solid var(--n-line,#ddd);border-radius:14px;background:var(--n-bg,#fff);box-shadow:0 12px 35px #0002;padding:14px}
    header{display:flex;align-items:center;gap:8px;margin-bottom:10px}header strong{font-size:14px;margin-right:auto}
    .queue-panel{width:min(100%,520px);padding:16px}.queue-panel header{margin-bottom:12px}.queue-heading{flex:1;min-width:0}.queue-heading strong{display:block}.queue-subtitle{font-size:11px;color:var(--n-muted,#666)}.queue-summary{display:flex;align-items:center;gap:8px}.queue-state{flex:none;padding:3px 7px;border-radius:6px;background:var(--n-hover,#f0f0f0);font-size:11px}.queue-panel[data-state=attention] .queue-state{color:#bc7025}.queue-panel .status{margin:0;min-height:0;color:var(--n-muted,#666);overflow-wrap:anywhere}.empty{padding:24px 12px;text-align:center}.empty strong{font-size:14px;font-weight:500}.empty p{margin:7px 0 0;color:var(--n-muted,#666)}.queue-panel .list:not(:empty){margin-top:14px}.queue-foot{border-top:1px solid var(--n-line,#ddd);padding-top:10px;margin:12px 0 0;color:var(--n-muted,#666);font-size:11px}.queue-panel .item{padding:12px;border:0;background:var(--n-hover,#f0f0f0)}.item-head{display:flex;align-items:center;gap:7px;margin-bottom:6px}.order{font-size:11px;color:var(--n-muted,#666);font-variant-numeric:tabular-nums}.queue-panel .state{margin:0;font-size:11px}.queue-panel .preview{font-size:13px;line-height:1.65;max-height:130px}.queue-panel .actions button{border:0;background:transparent;padding:4px 7px;min-height:28px}.queue-panel .actions button:first-child{background:var(--n-bg,#fff);border:1px solid var(--n-line,#ddd)}.queue-panel .actions [data-action=remove]{margin-left:auto}.queue-panel .actions [data-action=remove]:hover{color:#d55454}.queue-panel .actions button:hover{background:var(--n-bg,#fff)}
    .usage-popover{position:absolute;left:var(--n-usage-x,50%);bottom:calc(100% + 8px);width:min(360px,calc(100vw - 24px));transform:translateX(-50%);pointer-events:auto;border:1px solid var(--n-line,#ddd);border-radius:14px;background:var(--n-bg,#fff);box-shadow:0 12px 32px #0002;padding:14px}
    :host([data-usage-side=bottom]) .usage-popover{top:calc(100% + 8px);bottom:auto}
    .usage-popover header{margin-bottom:12px}.usage-number{display:flex;align-items:baseline;gap:6px;margin:2px 0 8px}.usage-used{font-size:28px;line-height:1;font-weight:650}.usage-limit{color:var(--n-muted,#666);font-size:14px}.usage-track{height:6px;border-radius:999px;background:var(--n-hover,#f0f0f0);overflow:hidden}.usage-track i{display:block;height:100%;width:var(--n-usage-progress,0%);border-radius:inherit;background:currentColor;opacity:.72}.usage-meta{display:grid;gap:8px;margin-top:12px}.usage-meta div{display:grid;grid-template-columns:56px 1fr;gap:10px;align-items:start}.usage-meta span:first-child{color:var(--n-muted,#666)}.usage-meta strong{font-weight:500;overflow-wrap:anywhere}.usage-settings-link{display:flex;width:100%;align-items:center;justify-content:space-between;margin-top:12px;border-color:transparent;background:var(--n-hover,#f0f0f0)}.usage-settings-link span:last-child{font-size:20px}
    .usage-backdrop{position:absolute;left:var(--n-viewport-left,0);top:var(--n-viewport-top,0);width:100vw;height:100vh;display:grid;place-items:center;padding:20px;pointer-events:auto;background:#0006}.usage-settings{width:min(420px,calc(100vw - 32px));max-height:min(80vh,620px);overflow:auto;border:1px solid var(--n-line,#ddd);border-radius:16px;background:var(--n-bg,#fff);box-shadow:0 20px 60px #0005;padding:16px}.usage-settings header{margin-bottom:8px}.usage-settings .config{margin:8px 0 16px}
    .hint{color:var(--n-muted,#666);margin:8px 0;overflow-wrap:anywhere}.status{margin:6px 0;min-height:18px}.list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
    .item{border:1px solid var(--n-line,#ddd);border-radius:10px;padding:10px}.preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:110px;overflow:auto;margin:0 0 8px}.actions{display:flex;gap:5px;flex-wrap:wrap}.state{color:var(--n-muted,#666);margin-bottom:6px}
    label{display:block;margin:10px 0 4px}input,textarea{width:100%;border:1px solid var(--n-line,#ddd);border-radius:8px;padding:8px;background:var(--n-bg,#fff)}textarea{min-height:110px;resize:vertical}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
    .notice{position:absolute;bottom:calc(100% + 8px);left:0;max-width:100%;background:var(--n-bg,#fff);border:1px solid var(--n-line,#ddd);border-radius:10px;padding:8px 12px;box-shadow:0 6px 18px #0002;pointer-events:auto;white-space:pre-wrap}
    :host([data-mode=conversation]) .notice{left:auto;right:0}:host([data-project]) .notice{left:50%;transform:translateX(-50%)}
    :host([data-dark=true]){--n-bg:#242424;--n-fg:#eee;--n-muted:#b2b2b2;--n-line:#484848;--n-hover:#363636}
    @media(max-width:550px){button{padding:5px 7px}.usage{max-width:52vw;font-size:11px}.bar button{padding:5px 7px}.panel{width:100%}.usage-popover{width:min(340px,calc(100vw - 20px))}.usage-backdrop{padding:12px}}
  `;
  function create(onAction) {
    const host = document.createElement("div");
    host.id = "chatgpt-message-queue-root";
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style><div class="bar"><button class="usage" data-action="usage" title="GPT-6 用量设置">GPT-6 · 读取中</button><div class="queue-actions"><button data-action="add">加入队列</button><button class="queue" data-action="queue" aria-expanded="false">队列 <span class="count">0</span></button></div></div>
      <section class="panel queue-panel" hidden aria-label="当前对话消息队列"><header><div class="queue-heading"><strong>消息队列</strong><span class="queue-subtitle">仅当前对话 · 按顺序发送</span></div><button data-action="pause">暂停队列</button><button data-action="close" aria-label="关闭消息队列">关闭</button></header><div class="queue-summary"><span class="queue-state"></span><p class="status" role="status"></p></div><div class="empty"><strong>暂无待发消息</strong><p>在原生输入框写好消息后，点击「加入队列」。</p></div><ol class="list" aria-label="待发送的消息"></ol><p class="queue-foot">仅支持纯文本。图片和附件请使用原生发送。</p></section>
      <section class="usage-popover" hidden aria-label="GPT-6 用量"><header><strong>GPT-6 用量</strong><button data-action="close">关闭</button></header><div class="usage-number"><span class="usage-used">0</span><span class="usage-limit">/ 50</span></div><div class="usage-track"><i></i></div><div class="usage-meta"><div><span>刷新</span><strong class="usage-reset-short"></strong></div><div><span>来源</span><strong class="usage-source-short"></strong></div></div><button class="usage-settings-link" data-action="usage-settings"><span>用量设置</span><span aria-hidden="true">›</span></button></section>
      <div class="usage-backdrop" hidden><section class="usage-settings" role="dialog" aria-modal="true" aria-label="GPT-6 用量设置"><header><strong>GPT-6 用量设置</strong><button data-action="close">关闭</button></header><p class="config hint"></p><label>当前周期已用次数（可选）<input name="total" type="number" min="0" placeholder="未知"></label><label>周期额度<input name="limit" type="number" min="1" max="10000"></label><label>刷新周期（天）<input name="cycleDays" type="number" min="1" max="90" step="1"></label><label>下一次刷新<input name="resetAt" type="datetime-local"></label><p class="hint">所有统计只在本机保存。留空已用次数表示不补录历史；下一次刷新留空表示未知。</p><footer><button data-action="close">取消</button><button data-action="save-usage">保存设置</button></footer></section></div>
      <section class="panel edit-panel" hidden aria-label="编辑已保存的队列消息"><header><strong>编辑队列消息</strong></header><label>消息内容<textarea name="edit" maxlength="200000"></textarea></label><footer><button data-action="cancel-edit">取消</button><button data-action="save-edit">保存修改</button></footer></section><div class="notice" hidden role="status"></div>`;
    document.body.appendChild(host);
    const $ = s => shadow.querySelector(s);
    let model = {}, editing = null, usageRevision = 0, lastKey = "", frame = 0, overlayTimer = 0, anchorNode = null, geometry = "", signature = "", noticeTimer, retired = false;
    const close = () => { for (const panel of shadow.querySelectorAll(".panel,.usage-popover,.usage-backdrop")) panel.hidden = true; $('[data-action="queue"]').setAttribute("aria-expanded", "false"); editing = null; };
    const showNotice = (value, persistent = false) => {
      clearTimeout(noticeTimer);
      $(".notice").textContent = String(value || "").replaceAll("Queue", "队列").replaceAll("Workspace", "工作区");
      $(".notice").hidden = !value;
      if (!persistent) noticeTimer = setTimeout(() => { $(".notice").hidden = true; }, 7000);
    };
    shadow.addEventListener("keydown", event => { if (event.key === "Escape") { close(); event.stopPropagation(); } });
    shadow.addEventListener("click", async event => {
      if (event.target.classList?.contains("usage-backdrop")) return close();
      const button = event.target.closest("button[data-action]");
      if (!button || button.disabled || retired) return;
      const action = button.dataset.action;
      if (["queue", "usage", "edit"].includes(action)) position(true);
      const item = model.queue?.items.find(i => i.id === button.dataset.id);
      if (action === "close") return close();
      if (action === "queue") { const open = $(".queue-panel").hidden; close(); $(".queue-panel").hidden = !open; button.setAttribute("aria-expanded", String(open)); return; }
      if (action === "usage") {
        close(); $(".usage-popover").hidden = false; position(true);
        return;
      }
      if (action === "usage-settings") {
        const usage = globalThis.ChatGPTUsage.summary(model.usage);
        usageRevision = usage.revision;
        $('[name="total"]').value = usage.baselineKnown ? usage.used : "";
        $('[name="limit"]').value = usage.limit;
        $('[name="cycleDays"]').value = usage.cycleDays;
        $('[name="resetAt"]').value = usage.resetAt ? new Date(usage.resetAt - new Date(usage.resetAt).getTimezoneOffset() * 60000).toISOString().slice(0,16) : "";
        $(".usage-popover").hidden = true; $(".usage-backdrop").hidden = false; position(true); $('[name="total"]').focus();
        return;
      }
      if (action === "edit" && item?.state === "pending") {
        editing = { id: item.id, revision: model.queue.revision, key: model.key };
        $(".queue-panel").hidden = true; $(".edit-panel").hidden = false;
        $('[name="edit"]').value = item.text; $('[name="edit"]').focus(); return;
      }
      if (action === "cancel-edit") { close(); $(".queue-panel").hidden = false; return; }
      if (action === "resolve-retry" || action === "resolve-remove") {
        if (!confirm(action === "resolve-retry" ? "请先核对原生对话：确认这条消息没有发送。重新入队可能导致重复发送，是否继续？" : "已核对原生对话，确认移除此未知结果，不再发送？")) return;
      }
      const payload = action === "save-edit" ? { ...editing, text: $('[name="edit"]').value } : action === "save-usage" ? { revision: usageRevision, total: $('[name="total"]').value, limit: $('[name="limit"]').value, cycleDays: $('[name="cycleDays"]').value, resetAt: $('[name="resetAt"]').value ? new Date($('[name="resetAt"]').value).getTime() : 0 } : { id: item?.id };
      button.disabled = true;
      try {
        await onAction(action, payload);
        if (action.startsWith("save-")) close();
      } catch (error) { showNotice(error.message); }
      finally { button.disabled = retired; }
    });
    const observer = new ResizeObserver(() => position());
    const nativeFloatingSelector = '.popover,[popover]:popover-open,dialog[open],[role="menu"],[role="listbox"],[role="dialog"],[data-radix-popper-content-wrapper]';
    const intersects = (a, b) => a.left < b.right && a.right > b.left && a.top < b.bottom && a.bottom > b.top;
    function nativeOverlayOverlaps(regions) {
      for (const node of document.querySelectorAll(nativeFloatingSelector)) {
        const style = getComputedStyle(node);
        const overlay = node.getBoundingClientRect();
        if (style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0" && overlay.width > 0 && overlay.height > 0 && regions.some(rect => intersects(rect, overlay))) return true;
      }
      return false;
    }
    function place() {
      frame = 0;
      if (!anchorNode?.isConnected) { host.hidden = true; host.removeAttribute("data-native-overlay"); return; }
      const rect = anchorNode.getBoundingClientRect();
      host.style.setProperty("--n-panel-height", `${Math.max(40, rect.top - 56)}px`);
      host.hidden = model.mode === "off" || rect.width < 1 || rect.top < 70 || rect.top > innerHeight;
      const width = Math.min(rect.width, innerWidth - 24);
      const left = Math.max(12, Math.min(rect.left, innerWidth - width - 12));
      const next = `${Math.round(left)}:${Math.round(rect.top - 6)}:${Math.round(width)}`;
      if (geometry !== next) { geometry = next; host.style.left = `${left}px`; host.style.top = `${rect.top - 6}px`; host.style.width = `${width}px`; }
      const hostRect = host.getBoundingClientRect();
      host.style.setProperty("--n-viewport-left", `${-hostRect.left}px`); host.style.setProperty("--n-viewport-top", `${-hostRect.top}px`);
      const usageButton = $(".usage").getBoundingClientRect(), popover = $(".usage-popover");
      if (!popover.hidden) {
        const popWidth = popover.getBoundingClientRect().width || Math.min(360, innerWidth - 24);
        const center = Math.max(12 + popWidth / 2, Math.min(usageButton.left + usageButton.width / 2, innerWidth - 12 - popWidth / 2));
        host.style.setProperty("--n-usage-x", `${center - hostRect.left}px`);
        host.dataset.usageSide = hostRect.top - popover.getBoundingClientRect().height - 8 < 12 ? "bottom" : "top";
      }
      // Absolutely positioned panels are outside the host/bar rectangle. Hide,
      // rather than destroy them, so an in-progress edit survives a native menu.
      const regions = [hostRect, ...[...shadow.querySelectorAll('.panel:not([hidden]), .usage-popover:not([hidden]), .usage-backdrop:not([hidden]) .usage-settings, .notice:not([hidden])')].map(n => n.getBoundingClientRect())];
      const nativeOverlay = !host.hidden && nativeOverlayOverlaps(regions);
      host.toggleAttribute("data-native-overlay", nativeOverlay);
    }
    function position(immediate = false) {
      if (immediate) { cancelAnimationFrame(frame); place(); return; }
      if (frame) return;
      frame = requestAnimationFrame(place);
    }
    const onScroll = () => position();
    addEventListener("scroll", onScroll, { capture: true, passive: true });
    addEventListener("resize", onScroll, { passive: true });
    const rescanNativeOverlay = () => {
      clearTimeout(overlayTimer);
      overlayTimer = setTimeout(() => { overlayTimer = 0; position(true); }, 80);
    };
    const onDocumentClick = event => { if (!$(".usage-popover").hidden && !event.composedPath().includes(host)) close(); rescanNativeOverlay(); };
    document.addEventListener("click", onDocumentClick, { capture: true, passive: true });
    document.addEventListener("keydown", rescanNativeOverlay, { capture: true, passive: true });
    document.addEventListener("toggle", rescanNativeOverlay, { capture: true, passive: true });
    function render(next) {
      if (retired) return;
      model = next;
      host.dataset.mode = next.mode;
      host.toggleAttribute("data-project", next.mode === "usage" && next.url?.includes("/g/"));
      if (lastKey !== next.key) { lastKey = next.key; close(); signature = ""; }
      const usage = globalThis.ChatGPTUsage.summary(next.usage);
      $(".usage").textContent = next.scope ? usage.label : "GPT-6 · 账号未识别";
      $(".usage").title = next.scope ? usage.resetLabel : "GPT-6 用量设置";
      $(".usage-used").textContent = usage.incompatible ? "—" : usage.used;
      $(".usage-limit").textContent = usage.incompatible ? "数据需升级" : `/ ${usage.limit}`;
      $(".usage-reset-short").textContent = usage.incompatible ? "数据版本不兼容" : usage.resetAt ? `${new Date(usage.resetAt).toLocaleString()} · 每 ${usage.cycleDays} 天` : `未知 · 每 ${usage.cycleDays} 天`;
      $(".usage-source-short").textContent = usage.incompatible ? "请更新扩展" : usage.baselineKnown ? "手动基数 + 本机观察" : "本机观察";
      $(".usage-source-short").title = usage.sourceLabel;
      host.style.setProperty("--n-usage-progress", usage.incompatible || !usage.limit ? "0%" : `${Math.min(100, usage.used / usage.limit * 100)}%`);
      $('[data-action="usage-settings"]').disabled = usage.incompatible;
      $(".config").textContent = usage.incompatible ? "本地用量数据由不兼容版本创建；当前版本不会覆盖。" : `当前设置：每 ${usage.cycleDays} 天 ${usage.limit} 次；GPT-6 Pro 与 GPT-5.6 Pro 计入这组本地额度，不包含 Thinking、Work 或 Codex。`;
      $(".queue-actions").hidden = next.mode !== "conversation" || next.queueEnabled === false;
      $('[data-action="add"]').disabled = !next.scope || next.actionBusy || next.attachments;
      $('[data-action="add"]').title = next.attachments ? "图片/附件暂不支持加入队列；请使用原生发送" : "把当前纯文本草稿加入队列";
      $('[data-action="pause"]').textContent = next.queue?.paused ? "继续队列" : "暂停队列";
      $('[data-action="pause"]').disabled = next.actionBusy || next.queueEnabled === false;
      $(".count").textContent = next.queue?.items.length || 0;
      $(".status").textContent = (next.status || next.queue?.reason || "队列就绪").replaceAll("Queue", "队列");
      $(".status").hidden = $(".status").textContent === "队列为空";
      const attention = next.queue?.items.some(i => i.state === "unknown") || next.queue?.paused && next.queue.pauseCause !== "user";
      $(".queue-panel").dataset.state = attention ? "attention" : "normal";
      $(".queue-state").textContent = next.queueEnabled === false ? "功能已关闭" : attention ? "需要处理" : next.queue?.paused ? "已暂停" : next.queue?.items.length ? "自动发送" : "已就绪";
      $(".empty").hidden = Boolean(next.queue?.items.length);
      host.dataset.dark = String(document.documentElement.classList.contains("dark") || document.documentElement.style.colorScheme === "dark");
      const sig = `${next.key}:${next.queue?.revision || 0}`;
      if (sig !== signature) {
        signature = sig;
        const nodes = new Map([...$(".list").children].map(n => [n.dataset.id,n]));
        for (const item of next.queue?.items || []) {
          let node = nodes.get(item.id);
          nodes.delete(item.id);
          if (!node) { node = document.createElement("li"); node.className = "item"; node.dataset.id = item.id; node.innerHTML = '<div class="item-head"><span class="order"></span><div class="state"></div></div><p class="preview"></p><div class="actions"></div>'; }
          node.querySelector(".order").textContent = `第 ${next.queue.items.indexOf(item) + 1} 条`;
          node.querySelector(".preview").textContent = item.text;
          node.querySelector(".state").textContent = { pending: "等待发送", sending: "正在确认送达", unknown: "送达未知 · 不会自动重发" }[item.state];
          if (node.dataset.state !== item.state) {
            node.dataset.state = item.state;
            const controls = item.state === "pending" ? [["send","立即发送"],["edit","编辑"],["up","上移"],["down","下移"],["remove","删除"]] : item.state === "unknown" ? [["resolve-retry","确认未发送，重新入队"],["resolve-remove","确认移除"]] : [];
            node.querySelector(".actions").replaceChildren(...controls.map(([action,label]) => { const b = document.createElement("button"); b.dataset.action=action; b.dataset.id=item.id; b.textContent=label; return b; }));
          }
          $(".list").appendChild(node);
        }
        for (const node of nodes.values()) node.remove();
      }
      for (const b of shadow.querySelectorAll('.list button')) {
        const item = next.queue?.items.find(i => i.id === b.dataset.id), index = next.queue?.items.indexOf(item);
        const adjacent = next.queue?.items[index + (b.dataset.action === "up" ? -1 : 1)];
        b.disabled = next.actionBusy || !item || ["up", "down"].includes(b.dataset.action) && adjacent?.state !== "pending";
        if (b.dataset.action === "send") b.disabled ||= !next.canSend;
      }
      position();
    }
    return { host, render, showNotice,
      deactivate(message) { retired = true; for (const button of shadow.querySelectorAll('button')) button.disabled = true; showNotice(message, true); },
      anchor(node) { if (node !== anchorNode) { observer.disconnect(); anchorNode = node; if (node) observer.observe(node); } position(); },
      dispose() { clearTimeout(noticeTimer); clearTimeout(overlayTimer); cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("scroll",onScroll,true); removeEventListener("resize",onScroll); document.removeEventListener("click",onDocumentClick,true); document.removeEventListener("keydown",rescanNativeOverlay,true); document.removeEventListener("toggle",rescanNativeOverlay,true); host.remove(); } };
  }
  globalThis.ChatGPTQueueUI = { create };
})();
