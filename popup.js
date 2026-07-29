const STATUS_TEXT={running:"执行中",waiting_action:"等待操作",completed:"已完成",failed:"失败",cancelled:"已停止"};
const OBSERVER_TEXT={current_page:"当前页面监控",none:"页面已关闭"};
const HEALTH_TEXT={healthy:"正常",degraded:"降级",blocked:"受阻",initializing:"初始化",unsupported:"不支持",no_page:"无页面",no_response:"未响应",paused:"已暂停",available:"可用",unknown:"未知"};
let popupState=null,diagnosticState=null;
const $=(id)=>document.getElementById(id);
const send=(type,extra={})=>chrome.runtime.sendMessage({type,...extra});
document.addEventListener("DOMContentLoaded",init);

async function init(){bindEvents();await refresh()}
function bindEvents(){
  document.querySelectorAll("[data-setting]").forEach((input)=>input.addEventListener("change",async()=>{await send("UPDATE_SETTINGS",{settings:{[input.dataset.setting]:input.checked}});await refresh()}));
  $("testButton").addEventListener("click",async()=>{await send("TEST_NOTIFICATION");feedback("测试通知已发送")});
  $("openChatButton").addEventListener("click",async()=>{await send("OPEN_CHAT");window.close()});
  $("clearButton").addEventListener("click",async()=>{await send("CLEAR_HISTORY");await refresh()});
  $("copyDiagnosticsButton").addEventListener("click",copyDiagnostics);
  $("downloadDiagnosticsButton").addEventListener("click",downloadDiagnostics);
  $("clearDiagnosticsButton").addEventListener("click",clearDiagnostics)
}

async function refresh(){
  [popupState,diagnosticState]=await Promise.all([send("GET_POPUP_STATE").catch(()=>null),send("GET_DIAGNOSTIC_REPORT").catch(()=>null)]);
  if(popupState?.ok){
    Object.entries(popupState.settings).forEach(([key,value])=>{const input=document.querySelector(`[data-setting="${key}"]`);if(input)input.checked=Boolean(value)});
    const active=popupState.tasks.filter((task)=>["running","waiting_action"].includes(task.status)).length;
    $("summary").textContent=active?`当前打开页面中正在监控 ${active} 个任务`:"当前没有运行中的任务";
    $("permissionWarning").classList.toggle("hidden",popupState.permissionLevel==="granted");
    renderTasks(popupState.tasks)
  }
  renderDiagnostics(diagnosticState)
}

function renderDiagnostics(state){
  const report=state?.report;
  if(!state?.ok||!report){
    health("page","blocked","诊断信息读取失败");health("notification","unknown","无法读取通知权限");health("task","unknown","无法汇总任务");health("queue","unknown","无法汇总队列");return
  }
  const page=report.currentPage;
  const pageStatus=state.pageProbeStatus==="no_response"?"no_response":page?.compatibility||page?.supportStatus||"no_page";
  const pageReason=page?`${routeText(page.routeType)}${page.reasonCodes?.length?` · ${page.reasonCodes.join("、")}`:""}`:state.pageProbeStatus==="no_response"?"当前 ChatGPT 页面脚本未响应":"当前活动标签不是 ChatGPT 工作页面";
  health("page",pageStatus,pageReason);
  const permission=report.environment?.notificationPermission||"unknown";
  health("notification",permission==="granted"?"healthy":"blocked",permission==="granted"?"Chrome 通知权限正常":`通知权限：${permission}`);
  const counts=report.tasks?.counts||{},active=Number(counts.running||0)+Number(counts.waiting_action||0);
  health("task",active?"healthy":"available",active?`正在监控 ${active} 个任务`:"当前没有活动任务");
  const queue=report.queues||{},pending=Number(queue.itemCounts?.pending||0);
  health("queue",queue.pausedQueueCount?"paused":"healthy",`${queue.queueCount||0} 个队列 · 等待 ${pending} 条 · 暂停 ${queue.pausedQueueCount||0} 个`)
}
function health(prefix,status,reason){const badge=$(`${prefix}Health`);badge.className=`health ${status||"unknown"}`;badge.textContent=HEALTH_TEXT[status]||status||"未知";$(`${prefix}Reason`).textContent=reason||""}
function routeText(type){return({draft:"草稿页面",provisional_conversation:"临时会话",conversation:"正式会话",unsupported:"不支持页面",unknown:"未知页面",non_chatgpt:"非 ChatGPT 页面"})[type]||type||"未知页面"}
async function report(){if(diagnosticState?.ok)return diagnosticState;diagnosticState=await send("GET_DIAGNOSTIC_REPORT");renderDiagnostics(diagnosticState);return diagnosticState}

async function copyDiagnostics(){
  const state=await report(),markdown=String(state?.markdown||"");
  if(!markdown)return feedback("没有可复制的诊断信息",true);
  const manual=$("manualCopyText");manual.classList.add("hidden");
  try{if(!navigator.clipboard?.writeText)throw new Error();await navigator.clipboard.writeText(markdown);feedback("诊断信息已复制")}
  catch{manual.value=markdown;manual.classList.remove("hidden");manual.focus();manual.select();feedback("自动复制失败，请在下方手动复制",true)}
}
async function downloadDiagnostics(){
  const state=await report();if(!state?.report)return feedback("没有可下载的诊断信息",true);
  const blob=new Blob([JSON.stringify(state.report,null,2)],{type:"application/json;charset=utf-8"}),url=URL.createObjectURL(blob),anchor=document.createElement("a");
  anchor.href=url;anchor.download=`gpt-notice-diagnostics-v${state.report.extension?.version||"unknown"}-${new Date(state.report.generatedAt||Date.now()).toISOString().replace(/[:.]/g,"-")}.json`;
  document.body.appendChild(anchor);anchor.click();anchor.remove();setTimeout(()=>URL.revokeObjectURL(url),0);feedback("诊断 JSON 已下载")
}
async function clearDiagnostics(){
  if(!confirm("确定清除诊断事件和最近页面快照吗？任务、队列、设置和本地诊断盐不会被删除。"))return;
  const response=await send("CLEAR_DIAGNOSTICS");if(!response?.ok)return feedback("诊断记录清除失败",true);
  diagnosticState=null;$("manualCopyText").classList.add("hidden");feedback("诊断记录已清除");await refresh()
}
function feedback(message,error=false){const node=$("diagnosticFeedback");node.textContent=message;node.classList.toggle("error",error);setTimeout(()=>{if(node.textContent===message)node.textContent=""},3000)}

function renderTasks(tasks){
  const list=$("taskList");list.replaceChildren();
  if(!tasks.length){const empty=document.createElement("div");empty.className="empty";empty.textContent="在 ChatGPT 中发送消息后会自动开始监控。";return list.append(empty)}
  tasks.forEach((task)=>{
    const card=document.createElement("article");card.className="task";
    const head=document.createElement("div");head.className="task-head";
    const title=document.createElement("div");title.className="task-title";title.title=title.textContent=task.title||task.prompt||"ChatGPT 任务";
    const badge=document.createElement("span");badge.className=`badge ${task.status}`;badge.textContent=STATUS_TEXT[task.status]||task.status;head.append(title,badge);
    const meta=document.createElement("div");meta.className="task-meta";meta.textContent=`${OBSERVER_TEXT[task.observerMode]||task.observerMode} · ${formatTime(task.updatedAt)}`;card.append(head,meta);
    if(task.stopReason){const reason=document.createElement("div");reason.className="task-error";reason.textContent=task.stopReason;card.append(reason)}
    const actions=document.createElement("div");actions.className="task-actions";
    actions.append(button("打开",async()=>{await send("OPEN_TASK",{taskId:task.id});window.close()}));
    if(["running","waiting_action"].includes(task.status))actions.append(button("停止监控",async()=>{await send("STOP_TASK",{taskId:task.id});await refresh()}));
    card.append(actions);list.append(card)
  })
}
function button(label,onClick){const node=document.createElement("button");node.textContent=label;node.addEventListener("click",onClick);return node}
function formatTime(timestamp){return timestamp?new Intl.DateTimeFormat("zh-CN",{hour:"2-digit",minute:"2-digit",second:"2-digit"}).format(new Date(timestamp)):""}
