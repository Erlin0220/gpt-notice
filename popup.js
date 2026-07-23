const STATUS_TEXT = {
  running: "执行中",
  waiting_action: "等待操作",
  completed: "已完成",
  failed: "失败",
  cancelled: "已停止"
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
      await chrome.runtime.sendMessage({
        type: "UPDATE_SETTINGS",
        settings: { [input.dataset.setting]: input.checked }
      });
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
    if (input) input.checked = Boolean(value);
  }

  const activeCount = popupState.tasks.filter((task) => ["running", "waiting_action"].includes(task.status)).length;
  document.getElementById("summary").textContent = activeCount
    ? `正在监控 ${activeCount} 个任务`
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

    const prompt = document.createElement("div");
    prompt.className = "task-prompt";
    prompt.title = task.prompt || "ChatGPT 任务";
    prompt.textContent = task.prompt || "ChatGPT 任务";

    const badge = document.createElement("span");
    badge.className = `badge ${task.status}`;
    badge.textContent = STATUS_TEXT[task.status] || task.status;

    const meta = document.createElement("div");
    meta.className = "task-meta";
    meta.textContent = `${task.hasMonitor ? "后台监控 · " : ""}${formatTime(task.updatedAt)}`;

    const actions = document.createElement("div");
    actions.className = "task-actions";

    const open = document.createElement("button");
    open.textContent = "打开";
    open.addEventListener("click", async () => {
      await chrome.runtime.sendMessage({ type: "OPEN_TASK", taskId: task.id });
      window.close();
    });
    actions.append(open);

    if (["running", "waiting_action"].includes(task.status)) {
      const stop = document.createElement("button");
      stop.textContent = "停止监控";
      stop.addEventListener("click", async () => {
        await chrome.runtime.sendMessage({ type: "STOP_TASK", taskId: task.id });
        await refresh();
      });
      actions.append(stop);
    }

    head.append(prompt, badge);
    card.append(head, meta, actions);
    list.append(card);
  }
}

function formatTime(timestamp) {
  if (!timestamp) return "";
  return new Intl.DateTimeFormat("zh-CN", {
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit"
  }).format(new Date(timestamp));
}
