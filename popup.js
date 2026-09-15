(async () => {
  const status = document.getElementById("status");
  try {
    const reply = await chrome.runtime.sendMessage({ type: "NOTICE_POPUP" });
    if (!reply.ok) throw new Error(reply.error);
    const enabled = document.getElementById("enabled");
    enabled.checked = reply.enabled;
    document.getElementById("permission").textContent = reply.permission === "granted" ? "系统通知权限：允许" : "系统通知权限：已被浏览器或系统禁止";
    enabled.addEventListener("change", async () => {
      try {
        const result = await chrome.runtime.sendMessage({ type: "NOTICE_SETTING", enabled: enabled.checked });
        if (!result.ok) throw new Error(result.error);
      } catch (error) { status.textContent = error.message; }
    });
    const list = document.getElementById("queues");
    list.textContent = !reply.scopeKnown ? "请先切回已识别账号的 ChatGPT 页面；不会展示其他账号或 Workspace 的 Queue。" : reply.queues.length ? "" : "当前账号 / Workspace 没有待发消息。";
    reply.queues.forEach((queue, index) => {
      if (ChatGPTQueueCore.route(queue.url).mode !== "conversation") return;
      const link = document.createElement("a");
      link.href = queue.url; link.target = "_blank"; link.rel = "noopener";
      link.textContent = `对话 ${index + 1} · ${queue.count} 条 · ${queue.paused ? "暂停" : "等待执行"}`;
      link.title = queue.url;
      list.appendChild(link);
    });
  } catch (error) { status.textContent = error.message; }
})();
