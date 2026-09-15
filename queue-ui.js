(() => {
  "use strict";
  const CSS = `
    :host{all:initial;position:fixed;display:block;z-index:9;pointer-events:none;font:12px/1.45 system-ui,sans-serif;color:var(--n-fg,#252525);transform:translateY(-100%)}
    *{box-sizing:border-box}[hidden],:host([hidden]){display:none!important}
    :host([data-native-overlay]) .bar,:host([data-native-overlay]) .panel,:host([data-native-overlay]) .notice{visibility:hidden!important;pointer-events:none!important}
    .bar{display:flex;align-items:center;gap:6px;justify-content:flex-end;min-height:32px;pointer-events:none}
    button,input,textarea{font:inherit;color:inherit}button{cursor:pointer;border:1px solid var(--n-line,#ddd);border-radius:9px;padding:6px 10px;background:var(--n-bg,#fff);min-height:30px;pointer-events:auto}
    button:hover{background:var(--n-hover,#f0f0f0)}button:focus-visible,input:focus-visible,textarea:focus-visible{outline:2px solid #538ae8;outline-offset:2px}button:disabled{opacity:.45;cursor:default}
    .usage{margin-right:auto;max-width:65%;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;color:var(--n-muted,#666)}
    .panel{position:absolute;bottom:calc(100% + 6px);right:0;width:min(100%,620px);max-height:min(58vh,560px,var(--n-panel-height,560px));overflow:auto;overscroll-behavior:contain;pointer-events:auto;border:1px solid var(--n-line,#ddd);border-radius:14px;background:var(--n-bg,#fff);box-shadow:0 12px 35px #0002;padding:14px}
    header{display:flex;align-items:center;gap:8px;margin-bottom:10px}header strong{font-size:14px;margin-right:auto}
    .hint{color:var(--n-muted,#666);margin:8px 0;overflow-wrap:anywhere}.status{margin:6px 0;min-height:18px}.list{list-style:none;margin:0;padding:0;display:grid;gap:8px}
    .item{border:1px solid var(--n-line,#ddd);border-radius:10px;padding:10px}.preview{white-space:pre-wrap;overflow-wrap:anywhere;max-height:110px;overflow:auto;margin:0 0 8px}.actions{display:flex;gap:5px;flex-wrap:wrap}.state{color:var(--n-muted,#666);margin-bottom:6px}
    label{display:block;margin:10px 0 4px}input,textarea{width:100%;border:1px solid var(--n-line,#ddd);border-radius:8px;padding:8px;background:var(--n-bg,#fff)}textarea{min-height:110px;resize:vertical}footer{display:flex;justify-content:flex-end;gap:8px;margin-top:12px}
    .notice{position:absolute;bottom:calc(100% + 8px);left:0;max-width:100%;background:var(--n-bg,#fff);border:1px solid var(--n-line,#ddd);border-radius:8px;padding:8px 12px;pointer-events:auto;white-space:pre-wrap}
    :host([data-dark=true]){--n-bg:#242424;--n-fg:#eee;--n-muted:#b2b2b2;--n-line:#484848;--n-hover:#363636}
    @media(max-width:550px){.bar{gap:4px}button{padding:5px 7px}.usage{max-width:55%;font-size:11px}.panel{width:100%}}
  `;
  function create(onAction) {
    const host = document.createElement("div");
    host.id = "chatgpt-message-queue-root";
    host.hidden = true;
    const shadow = host.attachShadow({ mode: "open" });
    shadow.innerHTML = `<style>${CSS}</style><div class="bar"><button class="usage" data-action="usage" title="GPT-6 用量设置">GPT-6 · 读取中</button><button data-action="add">加入 Queue</button><button data-action="queue" aria-expanded="false">Queue <span class="count">0</span></button></div>
      <section class="panel queue-panel" hidden aria-label="当前对话 Queue"><header><strong>Queue</strong><button data-action="pause">暂停</button><button data-action="close">关闭</button></header><p class="status" role="status"></p><ol class="list"></ol><p class="hint">使用原生输入框添加消息。Queue 当前只发送纯文本；图片和附件请使用 ChatGPT 原生发送。永不覆盖草稿或接管原生 Send。</p></section>
      <section class="panel usage-panel" hidden aria-label="GPT-6 用量"><header><strong>GPT-6 用量</strong><button data-action="close">关闭</button></header><p class="source hint"></p><p class="reset hint"></p><p class="config hint"></p><label>当前周期已用次数（可选）<input name="total" type="number" min="0" placeholder="未知"></label><label>周期额度<input name="limit" type="number" min="1" max="10000"></label><label>刷新周期（天）<input name="cycleDays" type="number" min="1" max="90" step="1"></label><label>下一次刷新<input name="resetAt" type="datetime-local"></label><p class="hint">所有统计只在本机保存。留空已用次数表示不补录历史；下一次刷新留空表示未知。</p><footer><button data-action="close">取消</button><button data-action="save-usage">保存设置</button></footer></section>
      <section class="panel edit-panel" hidden aria-label="编辑已保存的队列消息"><header><strong>编辑 Queue 消息</strong></header><label>已保存的文本<textarea name="edit" maxlength="200000"></textarea></label><footer><button data-action="cancel-edit">取消</button><button data-action="save-edit">保存</button></footer></section><div class="notice" hidden role="status"></div>`;
    document.body.appendChild(host);
    const $ = s => shadow.querySelector(s);
    let model = {}, editing = null, usageRevision = 0, lastKey = "", frame = 0, overlayTimer = 0, anchorNode = null, geometry = "", signature = "", noticeTimer, retired = false;
    const close = () => { for (const panel of shadow.querySelectorAll(".panel")) panel.hidden = true; $('[data-action="queue"]').setAttribute("aria-expanded", "false"); editing = null; };
    const showNotice = (value, persistent = false) => {
      clearTimeout(noticeTimer);
      $(".notice").textContent = value || "";
      $(".notice").hidden = !value;
      if (!persistent) noticeTimer = setTimeout(() => { $(".notice").hidden = true; }, 7000);
    };
    shadow.addEventListener("keydown", event => { if (event.key === "Escape") { close(); event.stopPropagation(); } });
    shadow.addEventListener("click", async event => {
      const button = event.target.closest("button[data-action]");
      if (!button || button.disabled || retired) return;
      const action = button.dataset.action;
      if (["queue", "usage", "edit"].includes(action)) position(true);
      const item = model.queue?.items.find(i => i.id === button.dataset.id);
      if (action === "close") return close();
      if (action === "queue") { const open = $(".queue-panel").hidden; close(); $(".queue-panel").hidden = !open; button.setAttribute("aria-expanded", String(open)); return; }
      if (action === "usage") {
        close(); $(".usage-panel").hidden = false;
        const usage = globalThis.ChatGPTUsage.summary(model.usage);
        usageRevision = usage.revision;
        $('[name="total"]').value = usage.baselineKnown ? usage.used : "";
        $('[name="limit"]').value = usage.limit;
        $('[name="cycleDays"]').value = usage.cycleDays;
        $('[name="resetAt"]').value = usage.resetAt ? new Date(usage.resetAt - new Date(usage.resetAt).getTimezoneOffset() * 60000).toISOString().slice(0,16) : "";
        return;
      }
      if (action === "edit" && item?.state === "pending") {
        editing = { id: item.id, revision: model.queue.revision, key: model.key };
        $(".queue-panel").hidden = true; $(".edit-panel").hidden = false;
        $('[name="edit"]').value = item.text; $('[name="edit"]').focus(); return;
      }
      if (action === "cancel-edit") { close(); $(".queue-panel").hidden = false; return; }
      if (action === "resolve-retry" || action === "resolve-remove") {
        if (!confirm(action === "resolve-retry" ? "请先核对原生对话：确认这条消息没有发送。重新入队可能导致重复发送，是否继续？" : "已核对原生对话，确认从 outbox 移除此未知结果，不再发送？")) return;
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
      // Absolutely positioned panels are outside the host/bar rectangle. Hide,
      // rather than destroy them, so an in-progress edit survives a native menu.
      const regions = [host.getBoundingClientRect(), ...[...shadow.querySelectorAll('.panel:not([hidden]), .notice:not([hidden])')].map(n => n.getBoundingClientRect())];
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
    document.addEventListener("click", rescanNativeOverlay, { capture: true, passive: true });
    document.addEventListener("keydown", rescanNativeOverlay, { capture: true, passive: true });
    document.addEventListener("toggle", rescanNativeOverlay, { capture: true, passive: true });
    function render(next) {
      if (retired) return;
      model = next;
      if (lastKey !== next.key) { lastKey = next.key; close(); signature = ""; }
      const usage = globalThis.ChatGPTUsage.summary(next.usage);
      $(".usage").textContent = next.scope ? usage.label : "GPT-6 · 账号未识别";
      $(".usage").title = next.scope ? usage.resetLabel : "GPT-6 用量设置";
      $(".source").textContent = usage.sourceLabel;
      $(".reset").textContent = usage.resetLabel;
      $(".config").textContent = usage.incompatible ? "本地用量数据由不兼容版本创建；当前版本不会覆盖。" : `当前设置：每 ${usage.cycleDays} 天 ${usage.limit} 次；GPT-6 Pro 与 GPT-5.6 Pro 计入这组本地额度，不包含 Thinking、Work 或 Codex。`;
      for (const name of ["add", "queue"]) $(`[data-action="${name}"]`).hidden = next.mode !== "conversation";
      $('[data-action="add"]').disabled = !next.scope || next.actionBusy || next.attachments;
      $('[data-action="add"]').title = next.attachments ? "图片/附件暂不支持加入 Queue；请使用 ChatGPT 原生发送" : "把当前纯文本草稿加入 Queue";
      $('[data-action="pause"]').textContent = next.queue?.paused ? "继续" : "暂停";
      $(".count").textContent = next.queue?.items.length || 0;
      $(".status").textContent = next.status || next.queue?.reason || "队列就绪";
      host.dataset.dark = String(document.documentElement.classList.contains("dark") || document.documentElement.style.colorScheme === "dark");
      const sig = `${next.key}:${next.queue?.revision || 0}`;
      if (sig !== signature) {
        signature = sig;
        const nodes = new Map([...$(".list").children].map(n => [n.dataset.id,n]));
        for (const item of next.queue?.items || []) {
          let node = nodes.get(item.id);
          nodes.delete(item.id);
          if (!node) { node = document.createElement("li"); node.className = "item"; node.dataset.id = item.id; node.innerHTML = '<div class="state"></div><p class="preview"></p><div class="actions"></div>'; }
          node.querySelector(".preview").textContent = item.text;
          node.querySelector(".state").textContent = { pending: "等待发送", sending: "正在确认送达", unknown: "发送结果未知 · 不会自动重发" }[item.state];
          if (node.dataset.state !== item.state) {
            node.dataset.state = item.state;
            const controls = item.state === "pending" ? [["send","立即发送"],["edit","编辑"],["up","上移"],["down","下移"],["remove","删除"]] : item.state === "unknown" ? [["resolve-retry","确认未发送，重新入队"],["resolve-remove","确认移除"]] : [];
            node.querySelector(".actions").replaceChildren(...controls.map(([action,label]) => { const b = document.createElement("button"); b.dataset.action=action; b.dataset.id=item.id; b.textContent=label; return b; }));
          }
          $(".list").appendChild(node);
        }
        for (const node of nodes.values()) node.remove();
      }
      position();
    }
    return { host, render, showNotice,
      deactivate(message) { retired = true; for (const button of shadow.querySelectorAll('button')) button.disabled = true; showNotice(message, true); },
      anchor(node) { if (node !== anchorNode) { observer.disconnect(); anchorNode = node; if (node) observer.observe(node); } position(); },
      dispose() { clearTimeout(noticeTimer); clearTimeout(overlayTimer); cancelAnimationFrame(frame); observer.disconnect(); removeEventListener("scroll",onScroll,true); removeEventListener("resize",onScroll); document.removeEventListener("click",rescanNativeOverlay,true); document.removeEventListener("keydown",rescanNativeOverlay,true); document.removeEventListener("toggle",rescanNativeOverlay,true); host.remove(); } };
  }
  globalThis.ChatGPTQueueUI = { create };
})();
