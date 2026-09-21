# gpt-notice

[![CI](https://github.com/Erlin0220/gpt-notice/actions/workflows/ci.yml/badge.svg)](https://github.com/Erlin0220/gpt-notice/actions/workflows/ci.yml)
[![Release](https://img.shields.io/github/v/release/Erlin0220/gpt-notice)](https://github.com/Erlin0220/gpt-notice/releases/latest)
![Chrome MV3](https://img.shields.io/badge/Chrome-Manifest%20V3-4285F4?logo=googlechrome&logoColor=white)
![Local first](https://img.shields.io/badge/data-local--first-2ea44f)

> **让 ChatGPT Web 少发无意义请求，并补上真正好用的消息队列、完成提醒和项目快捷访问。**

如果你长期把 ChatGPT Web 当工作台、项目越来越多，很可能见过这些现象：侧栏一展开，多个项目同时加载详情和最近会话；Network 里同类请求成片出现；页面用久后更容易遇到 `429`、侧栏卡顿或请求风暴。

**gpt-notice 的重点不是“拦截 ChatGPT API”，而是尽量不去触发那些本来就没必要发生的请求。**

- 新聊天默认收起原生 **置顶 / 项目 / 聊天** 分区，减少项目侧栏展开带来的 request fan-out。
- 正常使用时被动记住项目，直接在侧栏提供 **快捷项目**，不用为了找项目反复展开完整项目列表。
- 不后台遍历项目，不主动预取项目详情，不批量拉取其他项目的 conversations。
- 保留 ChatGPT 原生 Conversation、发送、Streaming、Stop、附件、模型选择和当前项目最近会话。
- 在此基础上增加 **消息队列、完成系统通知、本地 GPT 用量记录**。

它解决的是 **ChatGPT Web 中不必要的请求扇出与交互浪费**，从而降低相关 `429` 风险；它不会绕过服务端限流，也不会伪造接口返回。

## 为什么会有这个扩展

ChatGPT 的左侧栏并不只是静态目录。项目和置顶内容展开后，页面可能针对多个项目请求类似：

```text
GET /backend-api/gizmos/{projectId}
GET /backend-api/gizmos/{projectId}/conversations?...
```

项目一多，这些请求很容易形成 fan-out：

```text
原生侧栏展开
   ├─ Project A ── detail + conversations
   ├─ Project B ── detail + conversations
   ├─ Project C ── detail + conversations
   └─ ...
             ↓
      请求变多 / 429 风险上升
```

一组 2026-09-16 的真实浏览器对比很直观：在同一账号、同一页面版本下，刷新后观察约 10 秒，**使用前（原生“项目”展开）约 63 次 Fetch/XHR；使用 gpt-notice 默认折叠后约 51 次 Fetch/XHR**。这是当时页面版本与缓存状态下的实测样本，不是固定请求数承诺；真正稳定的目标是避免多个项目同时展开造成的 fan-out。

gpt-notice 选择从交互源头减量：

```text
进入新聊天
   ↓
默认折叠高请求分区
   ↓
本地快捷项目直接进入目标项目
   ↓
只让 ChatGPT 加载你真正打开的页面
```

这比“硬拦截接口”更稳：原生页面仍然拥有完整控制权，ChatGPT 改接口或返回结构时，扩展不需要伪造一套后端行为。

完整的 Network 调研、不同折叠 / 展开状态对应的请求矩阵，以及为什么最终选择“减少触发而不是拦接口”，见 [ChatGPT Web 侧栏请求行为调研与减量策略](docs/research/chatgpt-sidebar-network.md)。

## Highlights

| 能力 | gpt-notice 的做法 |
| --- | --- |
| **减少侧栏请求** | 新聊天默认折叠置顶 / 项目 / 聊天，降低多项目同时展开产生的请求扇出 |
| **项目快捷访问** | 从 ChatGPT 已经加载的数据中逐步学习项目，不额外批量请求项目详情 |
| **原生体验优先** | 不创建第二个输入框，不接管 Send / Stop / 模型 / 附件 |
| **长对话性能优化** | 使用浏览器原生 `content-visibility:auto` 与 intrinsic-size 占位，减少屏外渲染成本，不隐藏或卸载 React turn |
| **滚动稳定器** | 只在用户原本跟随最新消息时纠正长会话异常回跳；主动向上阅读立即停用自动纠正，并提供“最新消息”兜底按钮 |
| **工具调用折叠** | 工具调用跟随原生“思考了 …”一起展开 / 收起，完成后保持原生默认折叠；面板开关可独立关闭 |
| **消息队列** | 在正式 Conversation 中给原生 Composer 增加轻量 FIFO Queue |
| **完成提醒** | 网络完成只作为候选，必须再经过页面语义确认，避免切 Tab / HTTP 完成误报 |
| **人工处理提醒** | approval、quota、policy、error 等状态单独提醒，不自动替用户确认 |
| **本地 GPT 用量** | 只记录本机实际观察到的 Pro 模型发送，不伪造官方余额 |
| **Local-first** | 设置、Queue、项目缓存和用量记录都保存在浏览器本地，无后端、无 API Key |

## 安装

### 推荐：安装最新 Release

1. 打开 [Releases](https://github.com/Erlin0220/gpt-notice/releases/latest)，下载最新的 `chatgpt-task-notifier-v*.zip`。
2. 解压 zip。
3. 打开 `chrome://extensions`。
4. 开启右上角 **开发者模式**。
5. 点击 **加载已解压的扩展程序**，选择解压后包含 `manifest.json` 的目录。
6. 刷新已经打开的 ChatGPT 页面。

更新扩展时，不要在 ChatGPT 正在生成回复的过程中强制刷新页面。

### 从源码构建

```sh
npm ci
npm run build
```

然后在 `chrome://extensions` 中加载生成的 `dist/`。不要直接加载仓库根目录；仓库还包含测试、开发脚本和依赖。

扩展运行本身不需要 Node、后端服务或 OpenAI API Key。

## 30 秒上手

### 1. 先让侧栏安静下来

安装后，“**新聊天默认收起侧栏分区**”默认开启。进入 `/` 或项目主页时，原生 **置顶 / 项目 / 聊天** 会以折叠状态开始。

这不是永久锁死：你手动展开后，当前页面继续尊重你的选择；下一次进入新的聊天环境时才重新默认折叠。

### 2. 用快捷项目代替反复展开完整项目列表

你正常展开项目、进入项目主页或项目 Conversation 时，gpt-notice 会逐步记住：

- `projectId`
- `shortUrl`
- 项目名称
- ChatGPT 已提供的 emoji / theme / 当前原生图标提示

以后直接点击侧栏里的 **快捷项目** 即可进入 `/g/{shortUrl}/project`。

快捷项目不会为了“保持最新”去后台扫所有项目。改名、shortUrl 或图标变化会在 ChatGPT 下次自然加载项目列表时逐步同步。

从某个项目主页新建会话并进入正式 Conversation 后，该项目会提升到快捷项目最上方；仅打开已有会话不会改变快捷项目顺序。

### 3. 长任务放进消息队列

正式 Conversation 页面继续使用 ChatGPT **原生输入框**。写好纯文本后点击 **加入队列**：

- 空闲时自动开始；
- 当前回复结束后继续下一条；
- 支持暂停 / 继续、立即发送、编辑、删除、上移 / 下移；
- 草稿、附件、IME、Stop、未知送达等情况优先 fail closed，不猜、不强发。

图片和附件仍使用 ChatGPT 原生发送。

### 4. 离开标签页也能收到结果提醒

- 单条手动消息完成：提醒。
- 连续 Queue：正常中间项不轰炸通知，**整队最终完成提醒一次**。
- approval / quota / policy / error / 连续异常暂停：单独提醒你回来处理。
- 用户主动 Stop：不伪装成成功完成。

## 解决请求问题，但不做接口劫持

这是这个项目最重要的边界。

**gpt-notice 不拦截 ChatGPT 的列表、Conversation 或项目请求，也不伪造响应。**

普通的：

```text
/backend-api/conversations?...
```

仍由 ChatGPT 原生加载。具体 Conversation：

```text
/backend-api/conversations/{conversationId}
```

也完全不受影响。

进入项目主页时，ChatGPT 自己需要的当前项目最近会话：

```text
/backend-api/gizmos/{currentProjectId}/conversations?cursor=0
```

继续正常工作。

扩展减少的是 **“因为侧栏展开而同时触发很多并不急需的项目请求”**，而不是把 ChatGPT 网络层改造成另一套代理。

当前版本：

- 不 patch `fetch` / XHR / History；
- 不使用 `webRequestBlocking`；
- 不主动调用私有项目 API；
- 不循环预加载缓存中的所有项目；
- 不新增 MutationObserver；
- 不新增第二套高频轮询；只有存在未确认的 network-completion candidate 时，才用 Chrome Alarm 每 30 秒做一次低频语义复核；
- 旧实验版本留下的 DNR 拦截规则只会被清理，不会重新创建。

“长对话性能优化”现在只使用浏览器原生 CSS：turn 使用 `content-visibility:auto`，并用 `contain-intrinsic-size:auto 500px` 给尚未渲染的屏外内容提供占位。它不再用 JavaScript `IntersectionObserver` 把 turn 强制切成 `content-visibility:hidden`，也没有为性能功能新增 `MutationObserver`、节点卸载或 GPU `will-change`。原因是已经用 fixture 稳定复现：旧虚拟化 turn 被 ChatGPT SPA/React 复用到新会话时，旧 hidden 状态可以跟着节点留下，最终表现为新会话整块空白；关闭优化才会恢复。

“滚动稳定器”与性能优化是独立能力。它不修改 ChatGPT 的虚拟列表实现，也不 monkey-patch `scrollTop` / `scrollTo`；只复用现有低频页面 sampler 定位最新 turn 和滚动容器，用窄范围 `ResizeObserver` + 用户滚动意图 + `requestAnimationFrame` 判断是否发生了非用户触发的明显回跳。用户向上滚动、拖动滚动条或按 PageUp/Home 时立即解除自动跟随；若页面短时间反复抢夺滚动位置，扩展停止自动纠正，只保留“↓ 最新消息”按钮。

扩展面板仍保留独立开关。关闭时只移除根节点上的性能 class，恢复浏览器默认渲染；重新开启后 CSS 会自动覆盖当前和之后出现的 turn，不需要追踪滚动容器或路由。新版初始化还会清理旧版本留下的 `chatgpt-accelerator-hidden/unloaded` class 与内联高度状态，避免升级后继续继承旧虚拟化结果。这个实现刻意比旧方案保守：减少屏外 layout/paint 成本，但不尝试删除 DOM 或强制隐藏 React 管理的内容。

## 为什么尽量保持“薄”

ChatGPT Web 本身已经有完整的 Composer、Streaming、Stop、附件、项目和路由系统。gpt-notice 只补原生产品缺失的几个点，而不是再造一个 ChatGPT 客户端。

因此项目长期坚持：

1. **原生能力能用就直接复用。**
2. **状态只保留一个事实源。** Queue 状态由 Service Worker 串行持久化，UI 只做投影。
3. **宁可暂停，也不猜测。** 无法确认是否发送成功时进入 unknown，不自动重发。
4. **不靠高频观察器追着 React DOM 跑。** 页面只有一个低频 sampler；网络完成会主动唤醒对应 document，遗漏时再由 30 秒 Alarm 做有限恢复。
5. **不为了快捷入口制造更多请求。** 项目数据只从正常使用中渐进积累。

## 隐私与权限

gpt-notice 是 local-first 扩展。

- 不需要 OpenAI API Key。
- 不运行远程后端。
- Queue 文本、项目缓存、设置和用量记录保存在扩展本地存储。
- 不持久化 ChatGPT 回复正文用于通知恢复。
- 不保存 Cookie、Token 或完整请求正文。
- 系统通知中的短标题 / 回复摘要只在当次页面可用时交给 Chrome / 操作系统显示。

具体权限和数据边界见 [PRIVACY.md](PRIVACY.md)。

## 详细行为

<details>
<summary><strong>左侧栏默认折叠与快捷项目</strong></summary>

Popup 的“新聊天默认收起侧栏分区”默认开启。进入 `/` 或 `/g/{shortUrl}/project` 这类新聊天环境时，只把原生“置顶 / 项目 / 聊天”三个分区初始化为折叠；不关闭整个侧栏，也不持续接管用户状态。用户在当前页面手动展开后保持展开，直到下一次进入新的聊天环境。

“快捷项目”作为普通 DOM 流节点插在原生“项目”和“聊天”之间，会随着上方原生分区展开自然下移、折叠自然上移，并随侧栏滚动。结构对齐当前原生 Projects section：复用原生 section/header/menu-item class、chevron / compose sprite 和已渲染项目的图标提示，不复制 React 实例，也不依赖 React fiber。

快捷项目读取当前账号 / Workspace 已有的原生项目缓存，以及正常使用中出现的项目链接和项目页标题，逐步记录最小项目元数据。未出现在某次列表中不代表删除，也不会为了即时同步主动请求项目列表、项目详情或 conversations。

默认展示前 8 个项目并提供“查看更多”，扩展 Popup 可把默认展示数量调整为 1–50。点击项目名称在当前标签进入项目主页；hover 后的 compose 图标以新标签打开同一项目主页，让 ChatGPT 自己在首条消息后创建 Conversation。

</details>

<details>
<summary><strong>Queue 的可靠性边界</strong></summary>

Queue 按账号 / Workspace 与正式 Conversation 保存；重开同一对话可恢复，不跟随 tab 身份。ChatGPT 首条发送期间的 `WEB:` 临时 URL 不建立临时队列。

原生 Send 开始时会把“发送前最后一个原生 user message ID”作为最小 `holdBaseline` 一起持久化；不保存问题正文。即使扩展更新、页面刷新或 content controller 重建后丢失了内存里的提交上下文，只要页面已经出现一个位于该 baseline 之后的新原生 user turn，就可以重新建立这轮 turn，再按正常语义终态继续 Queue，而不是永久卡在“等待原生提交确认”。

发送结果无法确认时，Queue 暂停并标记“送达未知”，不会自动重发。请先检查原生对话，再明确选择重新入队或移除。

原生 UI 明确报告“无法思考”等可恢复异常、且本轮已经结束时，可以继续发送已有下一条，但不会重试失败原文，也不会自动生成“继续”。连续两轮可恢复异常会暂停，避免把整个 Queue 持续消耗掉。

用户 Stop、限额 / 策略阻塞、未分类错误、并发冲突和未知送达均保持暂停。Stop 与手动“暂停队列”现在使用不同 pause cause，界面会保留“上一轮手动停止”的原因，避免后续误以为 Queue 无故卡住。需要审批或继续生成时只提醒，不代替用户操作。

关闭浏览器、电脑休眠或关闭相关对话后，不承诺后台继续聊天。

</details>

<details>
<summary><strong>长工具调用如何折叠</strong></summary>

当 ChatGPT 原生回复仍带有“思考了 … / Thought for …”折叠区时，工具调用继续跟随原生思考区：思考区收起时工具调用一起隐藏，展开时一起显示。

2026-09 的 ChatGPT Web 在很多工具型回复中已经不再提供 turn 级 `aria-expanded` Thought 按钮，而是每个工具行自己提供“打开工具调用列表 / Open tool call list”。这种当前结构下，gpt-notice 会把同一回复里重复的、纯摘要型“已调用工具”行压成最后一条，保留一个原生工具列表入口；包含 iframe、图片、表格、App surface 或额外交互控件的工具行 fail-open，不隐藏。

两条路径都只改变展示属性，不移动 React DOM、不读取或改写工具参数 / 结果、不模拟点击，也不新增观察器；同步仍复用现有低频页面 tick。

扩展面板提供独立的“工具调用折叠”气泡开关，默认开启。关闭时当前页面立即恢复全部原生工具调用；重新开启后，已有长工具调用重新按默认折叠规则处理。

</details>

<details>
<summary><strong>完成提醒如何避免误报和漏报</strong></summary>

系统提醒采用“后台网络候选完成 + 页面语义确认”的两层机制。Service Worker 只读观察原生 conversation POST 的生命周期；网络完成不等于回复完成，仍需要精确 document 的页面状态确认。网络结束后如果第一次 probe 仍是 running / unavailable，不再立即丢弃关联，而是保留最小 candidate、主动唤醒对应 document，并用 30 秒 Chrome Alarm 继续有限复核，直到语义终态、路由失效或 10 分钟 TTL 到期。

仍在生成、页面无法响应、探针超时、账号 / Workspace / conversation 不匹配时都不会直接发成功提醒。若网络已完成且同一轮已经出现原生 Copy 等最终动作，允许把仍残留的 Stop / busy 视为后台 UI 陈旧状态；显式 Stop、错误、审批仍优先。

后台节流导致页面 controller 丢失内存里的 active turn 时，精确 network probe 可以从该 conversation 已持久化的 current turn 恢复这一个临时状态，再执行同一套终态判断。恢复要求 scope、route、document、原生 user message 和 generation 全部一致，并拒绝 Stop、已结束 turn 与重生成借位；因此不会把“HTTP 已结束”直接当成“回复已完成”。

Chrome 明确标记 tab 为 `frozen` 时，页面不能执行 event handler、timer 或原生 Send，所以扩展不会伪装成“后台仍能点击发送”。如果这一轮网络请求已经结束，会发一个不宣称回复成功的“后台标签页已冻结”提醒，并继续保留 completion candidate；点击提醒会激活原标签页、解除冻结，然后立即重新做语义确认并继续 Queue。discarded / 换 document 则停止这次精确恢复。

完成状态与待投递通知意图通过同一次 `storage.local.set` 批量提交。Chrome 通知创建失败时保留最小恢复记录，复用现有 sampler 以至少 10 秒间隔重试；Worker 再次启动时也可以恢复。30 秒 Alarm 只在存在未确认 completion candidate 时存在，不做常驻 keepalive。

approval、异常和最终完成使用不同事件 ID；同一完成结果的 generic → rich 使用同一 ID 静默更新。用户明确关闭 / 点击与系统自动收起分开处理，避免重复轰炸或吞掉后续最终结果。

Chrome Notifications API 能控制标题、正文、icon、`contextMessage`、时间等，但字体、圆角、背景由 Chrome / 操作系统决定。实现细节见 [ADR-0006](docs/adr/0006-notification-delivery.md)。

扩展重新加载后，Chrome 不会把新 content script 热替换进已经打开的 ChatGPT 页面；这类页面在 Popup 会显示“当前页面未连接”。此时可直接点击“刷新当前 ChatGPT 页面”恢复连接，扩展不会在后台擅自刷新页面。

</details>

<details>
<summary><strong>GPT 用量记录</strong></summary>

本地额度默认配置为 50 次，GPT-6 Pro 与 GPT-5.6 Pro 计入同一组本地记录；这不是官方额度声明。

扩展只读解析原生发送请求中的 `model` 与本次用户消息 ID，在 Chrome `onSendHeaders` 发送边界计数：只接受 `gpt-6-pro` / `gpt-5-6-pro`，Thinking、Work 和 Codex 不计。发送前取消不计；缺少可靠模型标识时不猜。

其他设备、未打开扩展时的调用和无法观察到的模型调用不会自动补齐。用量 Popover 明确显示来源和刷新信息，设置页允许手动校正当前周期基数、额度与下一次刷新时间。

</details>

## 开发与验收

完整验收统一使用：

```sh
npm run verify
```

它会依次运行单元/静态测试、完整 Playwright E2E、构建、vendored upstream 完整性检查，以及非 vendor 文件的 staged / unstaged diff whitespace 检查。

需要分开执行时：

```sh
npm ci
npm run build
npm test
npm run e2e:smoke
```

完整 E2E：

```sh
npm run e2e
```

Chromium MV3 回归始终加载 `dist/`，使用独立临时 Profile，fixture 之外的网络与 WebSocket 默认隔离，避免自动测试消耗真实 GPT-6 / Pro 额度。

真实 ChatGPT 只读核查：

```sh
node scripts/e2e-live-readonly.mjs "<Profile 目录>" "<项目首页 URL>" "<已打开的对话 URL>"
```

该流程只读取页面适配事实和已安装 UI，不发送消息。详细步骤见 [PLAYWRIGHT-E2E.md](docs/PLAYWRIGHT-E2E.md)。

## 设计与文档

- [ChatGPT Web 侧栏请求行为调研与减量策略](docs/research/chatgpt-sidebar-network.md)
- [范围与来源](docs/scope-v080.md)
- [通知投递决策 ADR-0006](docs/adr/0006-notification-delivery.md)
- [隐私说明](PRIVACY.md)
- [第三方声明](THIRD_PARTY_NOTICES.md)
- [Changelog](CHANGELOG.md)

## 反馈

遇到 ChatGPT 页面适配、Queue、通知或侧栏行为问题，可以直接提交 [Issue](https://github.com/Erlin0220/gpt-notice/issues)。

报告问题时，优先描述：ChatGPT 页面类型、是否为项目会话、扩展版本、是否多标签页，以及你观察到的原生 UI 状态。请不要公开 Cookie、Token、完整私密对话或账号标识。

---

**gpt-notice 的目标很简单：让 ChatGPT Web 保持原生体验，同时少做无意义的事。**
