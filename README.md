# ChatGPT Queue 与完成提醒

轻量 Manifest V3 Chrome 扩展。保留 ChatGPT 的原生输入框、发送、补充/中断、模型选择和附件体验，只添加 **本地消息 Queue、完成系统通知、来源明确的 GPT-6 用量记录**。

## 使用

先运行 `npm run build` 生成只包含运行文件与必要第三方声明的 `dist/`，再在 `chrome://extensions` 中开启开发者模式并加载 `dist/`。不要直接加载仓库根目录；仓库包含依赖和测试产物。CI 与 Release 也直接打包同一份白名单构建产物。更新代码后重新构建、重新加载扩展，并刷新需要使用它的 ChatGPT 标签页；不要打断仍在生成的对话。新版页面脚本检测到扩展失效后会停用计时器和操作、保留草稿与附件并提示刷新，不自动刷新或重新注入。扩展运行本身不需要 Node、后端、API Key 或额外服务。

首页和项目首页只显示用量。进入正式对话后，在原生输入框输入纯文本，点击外围的“加入 Queue”。Queue 面板提供编辑、删除、排序、暂停/继续及立即发送。空闲时加入 Queue 会自动开始；生成期间添加的消息在当前回复正常完成后继续。原生 UI 明确报告“无法思考”等可恢复异常、且本轮已结束时，也允许发送已有下一条，不重试失败原文、不自动生成“继续”消息。连续两轮异常会暂停，避免持续消耗整队列；成功或人工继续重置计数。用户 Stop、限额/策略阻塞、无法分类的错误、并发冲突和未知送达保持暂停。需要审批或继续生成时只提醒，不代替用户操作。任何发送都先检查原生草稿、附件、输入法组合输入及生成状态。

Queue 按账号/工作区及正式 conversation 保存；重开同一对话可恢复，不跟随标签页身份。ChatGPT 首条发送期间自己的 `WEB:` 临时 URL 只显示用量，不建立临时队列。旧版本本地数据作为不执行的备份保留，不自动迁移或发送。

Popup 只显示当前活动 ChatGPT 页已识别账号 / Workspace 的 Queue；无法确认身份时不列出其他账户的数据。维护仅机会性清理超过 30 天、已完成且空闲的空 Queue 记录，不删除待发正文、未知发送结果、暂停意图或活动回复。

发送结果无法确认时，Queue 暂停并标识“未知”，不会自动重发。请先检查原生对话，再明确选择重新入队或移除。关闭浏览器、电脑休眠或关闭相关对话后，不承诺后台继续聊天。找不到可靠 DOM/消息回执时宁可暂停。

## 完成提醒

系统提醒采用“后台网络候选完成 + 页面语义确认”的两层机制。Service Worker 只读观察原生 conversation POST 的成功完成事件，并向精确 document 请求当前页面事实。sampler 和探针共用同一稳定终态判断，核对账号、对话及 generation。仍在生成、页面无法响应、探针超时或身份不符时不发提醒，不能把切换标签页或 HTTP 完成当成回复完成。已确认正常完成但页面隐藏时只发无正文提醒；错误和等待人工处理使用明确的非成功提示。正常或可恢复的中间轮次有后续 Queue 时不逐条通知；需要人工处理或连续异常暂停时仍会提醒。点击时重新核对账号 / Workspace / conversation，不凭旧 tabId 跳转。被冻结、丢弃或关闭的页面不能保证及时通知或继续 Queue。

网络完成只代表 transport 完成，不等于 Queue 可以继续发送。终态必须有当前页面的语义状态和原生消息身份；发送下一条还须 Composer ready。Stop 事件立即持久化暂停，不等后续采样。系统通知先持久化不含正文的跳转路由，create/update 真正成功后才记录 delivered 等级；update 找不到既有系统通知时用同一 ID 重新 create。只有用户主动关闭或点击的提醒才写 dismissed marker，系统自动收起不会阻止后续 enrichment。Popup 同时显示扩展开关和浏览器/系统通知权限。

## GPT-6 用量

本地额度默认配置为 50 次，GPT-6 Pro 与 GPT-5.6 Pro 计入同一组本地记录；这不是对所有订阅的官方额度声明。扩展只读解析原生发送请求中的 `model` 与本次用户消息 ID，在 Chrome `onSendHeaders` 发送边界立即计数：只接受 `gpt-6-pro` / `gpt-5-6-pro`，Thinking、Work 和 Codex 不计。`onBeforeRequest` 仅捕获必要元数据，发送前取消不计；这一浏览器边界不等于服务端接收或官方扣费成功。

后续 DOM 模型观察只为已确认正常完成的新用户回复兜底，并使用相同原生用户 ID 去重；不凭发送前的乐观模型标记计数。重生成的 assistant ID 仅用于完成状态，不制造新的用量 ID。缺少可靠模型标识时不猜测，其他设备和扩展未观察到的调用无法补齐。左侧徽标显示已用次数、配置额度和下一次刷新时间，详细来源在用量面板中说明。

已知首次使用日期为 2026-09-09，但历史使用次数和官方精确刷新时间未知。点击用量可设置当前周期已用次数、周期额度、刷新周期和下一次刷新时间。默认刷新周期为 7 天；未填写时间就显示未知，填写后按所设周期维护本地刷新计划。其他设备、未打开扩展时的调用和无法观察的模型调用不会自动补齐。官方网页核实记录见 [范围与来源](docs/scope-v080.md)。

## 开发与验收

```sh
npm ci
npm run build
npm test
npm run e2e:smoke
```

构建与测试需要 Node，E2E 另外需要 Playwright。Chromium MV3 回归始终加载 `dist/`，并使用系统临时目录里的独立 Profile；测试结束会自动清理。fixture 之外的出站请求与 WebSocket 全部阻断，只放行扩展自身本地资源。真实 ChatGPT 只读核查使用 `node scripts/e2e-live-readonly.mjs "<已明确选定的 Profile 目录>" "<项目首页 URL>" "<已打开的对话 URL>"`：现有对话只读取本轮适配器事实，独立首页/项目页阻断所有写请求；不刷新真实扩展或已有对话、不发送消息、不复制登录数据。已安装 UI 的只读核查不冒充本轮完整 runtime 已上线；完整 runtime 的发送链路由隔离 fixture 验证。详细步骤见 `docs/PLAYWRIGHT-E2E.md`。

运行代码不 patch `fetch` / XHR / History。Service Worker 只读观察 ChatGPT 原生 conversation POST 的请求生命周期，不修改或重放请求，也不读取响应正文、Cookie 或 Token。临时 requestId / turnId / document / scope 关联使用 `storage.session`；每次核对真实 document 与当前账号，不长期缓存 tabId → 账号。页面侧只有一个低频采样器；Service Worker 在原生请求完成后只向精确 document 发一次语义探针，不使用 MutationObserver。独立 Shadow DOM 保留稳定 UI，原生浮层覆盖 Bar 或打开的 Panel 时主动让位。所有本地变更经 Service Worker 串行持久化；outbox 的 lease/intent/receipt 思路及部分操作适配自 MIT `chatgpt-yolo`，见 [第三方声明](THIRD_PARTY_NOTICES.md)。

v0.8 的当前边界以 [scope-v080.md](docs/scope-v080.md) 为准，早期 ADR 中的 Task/临时 Queue 设计仅是历史记录，不是兼容要求。
