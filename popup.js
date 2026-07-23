const STATUS_TEXT = {
  running: "执行中",
  waiting_action: "等待操作",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止",
  observer_lost: "连接丢失",
  monitor_stopped: "监控已停止"
};

const OBSERVER_TEXT = {
  normal_tab: "前台标签监控",
  group_tab: "GPT 后台标签组",
  lost: "未连接",
  none: "无监控页面"
};

let popupState = null;

document.addEventListener("DOMContentLoaded", init);

async function init() {
  bindEvents();
  await refresh();
}

function bindEvents() {
  document.querySelectorAll("[data-setting]").forEach((input) => {
    input.addEventListener("change", async () => {
      const key = input.dataset.setting;
      const value = input.type === "checkbox" ? input.checked : Number(input.value);
      const settings = { [key]: value };
      if (key === "autoKeepAlive") settings.backgroundMonitorMode = value ? "tab_group" : "disabled";
      await chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings });
      await refresh();
    });
  });

  document.getElementById("testButton").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "TEST_NOTIFICATION" });
  });
  document.getElementById("openChatButton").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "OPEN_CHAT" });
    window.close();
  });
  document.getElementById("clearButton").addEventListener("click", async () => {
    await chrome.runtime.sendMessage({ type: "CLEAR_HISTORY" });
    await refresh();
  });
}

async function refresh() {
  popupState = await chrome.runtime.sendMessage({ type: "GET_POPUP_STATE" });
  if (!popupState?.ok) return;

  for (const [key, value] of Object.entries(popupState.settings)) {
    const input = document.querySelector(`[data-setting="${key}"]`);
    if (!input) continue;
    if (input.type === "checkbox") input.checked = Boolean(value);
    else input.value = String(value);
  }

  const activeCount = popupState.tasks.filter((task) => ["running", "waiting_action"].includes(task.status)).length;
  const backgroundCount = popupState.tasks.filter((task) => task.observerMode === "group_tab").length;
  document.getElementById("summary").textContent = activeCount
    ? `正在监控 ${activeCount} 个任务${backgroundCount ? `，其中 ${backgroundCount} 个在后台组` : ""}`
    : "当前没有运行中的任务";

  document.getElementById("permissionWarning").classList.toggle(
    "hidden",
    popupState.permissionLevel === "granted"
  );
  renderTasks(popupState.tasks);
}

function renderTasks(tasks) {
  const list = document.getElementById("taskList");
  list.replaceChildren();
  if (!tasks.length) {
    const empty = document.createElement("div");
    empty.className = "empty";
    empty.textContent = "在 ChatGPT 中发送消息后会自动开始监控。";
    list.append(empty);
    return;
  }

  for (const task of tasks) {
    const card = document.createElement("article");
    card.className = "task";

    const head = document.createElement("div");
    head.className = "task-head";
    const title = document.createElement("div");
    title.className = "task-title";
    title.title = task.title || task.prompt || "ChatGPT 任务";
    title.textContent = task.title || task.prompt || "ChatGPT 任务";
    const badge = document.createElement("span");
    badge.className = `badge ${task.status}`;
    badge.textContent = STATUS_TEXT[task.status] || task.status;
    head.append(title, badge);

    const meta = document.createElement("div");
    meta.className = "task-meta";
    const cleanup = task.cleanupAt && task.cleanupAt > Date.now()
      ? ` · ${Math.max(0, Math.ceil((task.cleanupAt - Date.now()) / 1000))} 秒后清理`
      : "";
    meta.textContent = `${OBSERVER_TEXT[task.observerMode] || task.observerMode} · ${formatTime(task.updatedAt)}${cleanup}`;

    card.append(head, meta);
    if (task.observerLostReason) {
      const error = document.createElement("div");
      error.className = "task-error";
      error.textContent = task.observerLostReason;
      card.append(error);
    }

    const actions = document.createElement("div");
    actions.className = "task-actions";
    actions.append(makeButton("打开", async () => {
      await chrome.runtime.sendMessage({ type: "OPEN_TASK", taskId: task.id });
      window.close();
    }));

    if (task.hasMonitor) {
      actions.append(makeButton("提升为普通标签", async () => {
        await chrome.runtime.sendMessage({ type: "PROMOTE_TASK", taskId: task.id });
        window.close();
      }));
    }
    if (["running", "waiting_action"].includes(task.status)) {
      actions.append(makeButton("停止监控", async () => {
        await chrome.runtime.sendMessage({ type: "STOP_TASK", taskId: task.id });
        await refresh();
      }));
    }
    if (["observer_lost", "monitor_stopped"].includes(task.status)) {
      actions.append(makeButton("恢复监控", async () => {
        await chrome.runtime.sendMessage({ type: "RESUME_TASK", taskId: task.id });
        await refresh();
      }));
    }
    card.append(actions);
    list.append(card);
  }
}

function makeButton(label, onClick) {
  const button = document.createElement("button");
  button.textContent = label;
  button.addEventListener("click", onClick);
  return button;
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}
