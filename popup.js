const STATUS_TEXT = {
  running: "执行中",
  waiting_action: "等待操作",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止"
};

const OBSERVER_TEXT = {
  current_page: "当前页面监控",
  none: "页面已关闭"
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
      const value = input.type === "checkbox" ? input.checked : Number(input.value);
      await chrome.runtime.sendMessage({ type: "UPDATE_SETTINGS", settings: { [input.dataset.setting]: value } });
      await refresh();
    });
  });
  document.getElementById("testButton").addEventListener("click", () => chrome.runtime.sendMessage({ type: "TEST_NOTIFICATION" }));
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
    if (input) input.checked = Boolean(value);
  }
  const activeCount = popupState.tasks.filter((task) => ["running", "waiting_action"].includes(task.status)).length;
  document.getElementById("summary").textContent = activeCount ? `当前打开页面中正在监控 ${activeCount} 个任务` : "当前没有运行中的任务";
  document.getElementById("permissionWarning").classList.toggle("hidden", popupState.permissionLevel === "granted");
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
    meta.textContent = `${OBSERVER_TEXT[task.observerMode] || task.observerMode} · ${formatTime(task.updatedAt)}`;
    card.append(head, meta);
    if (task.stopReason) {
      const reason = document.createElement("div");
      reason.className = "task-error";
      reason.textContent = task.stopReason;
      card.append(reason);
    }
    const actions = document.createElement("div");
    actions.className = "task-actions";
    actions.append(makeButton("打开", async () => {
      await chrome.runtime.sendMessage({ type: "OPEN_TASK", taskId: task.id });
      window.close();
    }));
    if (["running", "waiting_action"].includes(task.status)) {
      actions.append(makeButton("停止监控", async () => {
        await chrome.runtime.sendMessage({ type: "STOP_TASK", taskId: task.id });
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
  return timestamp ? new Intl.DateTimeFormat("zh-CN", { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(new Date(timestamp)) : "";
}
