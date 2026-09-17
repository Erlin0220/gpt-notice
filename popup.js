(async () => {
  const status = document.getElementById("status");
  document.getElementById("version").textContent = `v${chrome.runtime.getManifest().version}`;
  try {
    const reply = await chrome.runtime.sendMessage({ type: "NOTICE_POPUP" });
    if (!reply.ok) throw new Error(reply.error);
    const permission = document.getElementById("permission");
    permission.textContent = reply.permission === "granted" ? "浏览器已允许" : "浏览器未允许";
    permission.dataset.denied = String(reply.permission !== "granted");
    const showDelivery = settings => {
      document.getElementById("delivery").textContent = settings?.notifications === false ? "提醒已关闭，不影响消息发送。" : reply.permission !== "granted" ? "请检查浏览器通知权限。系统勿扰设置也可能隐藏横幅。" : reply.notification?.pending ? `有 ${reply.notification.pending} 条提醒等待补送。` : reply.notification?.lastAt ? `最近提交系统：${new Date(reply.notification.lastAt).toLocaleTimeString([], { hour:"2-digit", minute:"2-digit" })}。系统勿扰模式可能隐藏横幅。` : "队列只在最终完成时提醒，避免逐条打扰。";
    };
    showDelivery(reply.settings);
    for (const feature of ["sidebarCollapse", "queue", "notifications"]) {
      const control = document.getElementById(feature);
      control.checked = reply.settings?.[feature] !== false;
      control.disabled = false;
      control.addEventListener("change", async () => {
        control.disabled = true; status.textContent = "";
        try {
          const result = await chrome.runtime.sendMessage({ type: "NOTICE_FEATURE_SETTING", feature, enabled: control.checked });
          if (!result.ok) throw new Error(result.error);
          control.checked = result.settings?.[feature] !== false;
          if (feature === "notifications" && !control.checked && reply.notification) reply.notification.pending = 0;
          showDelivery(result.settings);
        } catch (error) { control.checked = !control.checked; status.textContent = error.message; }
        finally { control.disabled = false; }
      });
    }
    const count=document.getElementById("shortcutCount"),key="notice:shortcut-project-limit",stored=await chrome.storage.local.get(key);
    count.value=stored[key]||8;
    count.onchange = async () => {
      const result = await chrome.runtime.sendMessage({ type: "NOTICE_FEATURE_SETTING", feature: "shortcutCount", value: +count.value });
      if (!result.ok) status.textContent = result.error;
    };
    const list = document.getElementById("queues");
    document.getElementById("scope-state").textContent = reply.scopeKnown ? "当前账号与工作区" : "当前页面未连接";
    if (!reply.scopeKnown || !reply.queues.length) {
      const empty = document.createElement("p"); empty.className = "queue-empty";
      empty.textContent = reply.scopeKnown ? "暂无待发消息。" : "请在已登录的 ChatGPT 页面打开面板；或刷新已失效的页面。";
      list.append(empty);
    }
    reply.queues.forEach((queue, index) => {
      if (ChatGPTQueueCore.route(queue.url).mode !== "conversation") return;
      const link = document.createElement("a");
      link.href = queue.url; link.target = "_blank"; link.rel = "noopener";
      link.className = "queue-link";
      const name = document.createElement("span"), detail = document.createElement("small");
      name.textContent = `对话 ${index + 1} · ${queue.count} 条`;
      detail.textContent = reply.settings?.queue === false ? "功能已关闭" : queue.paused ? "已暂停" : "等待发送";
      link.append(name, detail);
      link.title = queue.url;
      list.appendChild(link);
    });
  } catch (error) { status.textContent = error.message; }
})();
