# Repository instructions

## 长期产品与安全边界

产品包含 ChatGPT 原生体验、纯文本 Queue、最终完成提醒、GPT-6 Pro / GPT-5.6 Pro 本地用量与刷新配置，以及新聊天默认折叠和侧栏快捷项目。不创建第二套聊天输入框，不接管原生 Send、Stop、模型选择和附件，不主动调用或重放 ChatGPT 私有接口。首页、项目首页和 `WEB:` 临时路由展示用量与侧栏能力；只有稳定 conversation 才有 Queue。

**禁止发送真实 GPT-6 / GPT-6 Pro / GPT-5.6 Pro 消息做测试，禁止消耗用户 GPT-6 / Pro 额度。** 允许使用真实的“GPT日本” ShardX 浏览器做验证，但必须把现有 tab 视为用户正在使用的共享状态：不得改动、发送、刷新、导航、关闭或以其他方式影响已有 tab 中的任务、草稿、附件、Queue、生成状态和页面状态。发送、重生成、故障注入默认只用受控 fixture 和独立临时浏览器 Profile；不得清空用户真实扩展存储。只有用户明确要求真实发送验证时，才允许在专门新开的测试 tab 中先确认实际 model slug 不属于 GPT-6 / Pro allowlist，再以最少消息、明显间隔进行验证，禁止高频或连续快速发送。真实浏览器测试同时最多新开 1–2 个测试 tab，用完立即关闭；优先复用一个测试 tab 完成验证，不为测试堆积页面。不得改动其他真实草稿/附件，也不得刷新正在生成的对话。

## 已确认的实现原则

- Service Worker 是本地状态唯一写入者，操作串行持久化。继续复用现有轻量 lease → intent → receipt outbox，不引入第二套队列框架。intent 后失去结果必须进入 unknown；时间流逝、出现动画或点击成功都不是送达证据。原生 Send 的 hold 必须同时持久化发送前最后一个 user message ID (`holdBaseline`)，让 content controller/Worker 重启后能用“出现了 baseline 之后的新原生 user turn”恢复提交身份；仍不得仅凭时间或网络完成猜送达。存储失败不得清空草稿；不做自动重发。
- 队列按账号/Workspace 摘要与 conversation 隔离。tabId 不是账号或文档身份；后台针对当前 document 查询页面身份。Popup 无法确认当前账号时不展示其他账号队列；通知不能仅凭相同 URL 跨账号跳转。
- 同一 tab 也可能切换分支。替换未完成 turn 要有前驱消息或明确原生 Retry 证据；不同分支的 Stop、晚到回执和旧完成按钮不得覆盖新生成。真实冲突暂停不能自动解除；仅保留已确认的旧版无来源 false-conflict 的窄范围恢复。
- 终态与送达分开：正常完成可消费下一条；当前轮已确认的原生“无法思考”等可恢复异常也可消费已有下一条，但不是重试上一条或自动补发“继续”。连续两轮可恢复异常暂停，成功或人工继续重置计数。Stop、限额/策略/账号阻塞、未分类错误、unknown 不能自动越过；审批/继续生成只提醒一次并保持本轮未结束。只分类原生 UI，不从助手正文推断失败或策略状态。页面 sampler 与 network probe 复用同一个终态判定；network completion 只能成为带 TTL 的 wake candidate，不能直接 settle。若同一 generation 已有 network-completion candidate 且原生 Copy 等最终动作存在，陈旧 Stop/busy 不得永久压住完成；显式 Stop/错误/审批仍优先。依据及限制见 ADR-0005。
- 一个低频页面采样器和一个独立 Shadow DOM UI。页面状态由低频 snapshot、精确 document probe、network completion hint 与 visibility/pageshow/resume 唤醒驱动；不使用 MutationObserver、React 内部依赖、第二输入框或 fetch/XHR/History monkey patch。长对话优化只允许浏览器原生 CSS `content-visibility:auto` + intrinsic-size 占位，不再用 JS IntersectionObserver 把 turn 强制设为 hidden，也不对 React turn 做卸载。滚动稳定器必须与性能优化分离：只复用现有 sampler 定位最新 turn/滚动容器，允许窄范围 ResizeObserver + rAF；仅在用户原本跟随底部且没有向上阅读意图时纠正明显回跳，短时间反复争抢滚动位置时停止自动纠正并退化为“跳到最新消息”按钮；禁止 monkey-patch scrollTop/scrollTo。只有存在未确认 completion candidate 时允许一个 30 秒 Chrome Alarm safety net，禁止把它扩成常驻 keepalive 或第二套高频轮询。附件保护覆盖全部 file input、图片预览和中英文移除按钮。原生浮层与 Bar、Panel、编辑器任一区域相交都要让位，隐藏不能丢失未保存编辑内容；不通过极大 z-index 或扩展 top layer 压住原生菜单。
- Worker 随时可能被终止：关键队列状态用 `storage.local`，短期请求关联用 `storage.session`；不使用心跳、offscreen 或常驻服务保活。扩展 context 失效后停止旧页面实例的定时器和操作，提示人工刷新，保留原生草稿及附件。Chrome 扩展重新加载后旧 ChatGPT 页不会自动获得新 content script；Popup 在确认当前 ChatGPT tab 失联时可提供一次显式“刷新当前页面”，但不得后台静默刷新，也不为热注入新增 scripting 权限。
- 侧栏优化不阻止、重定向或伪造任何 ChatGPT 请求。只在进入 `/` 或项目主页时一次性收起原生置顶/项目/聊天；之后尊重用户手动展开。快捷项目必须作为原生 Sidebar 正常布局流中的 sibling，随上方分区自然位移；不得用 fixed/absolute 模拟目录位置。视觉结构要复用当前原生 Projects section/menu-item class 与 sprite，默认 8 条 +“查看更多”，并允许用户在扩展面板配置默认展示数量；hover 的 compose 新建入口用新标签打开项目主页；禁止再维护独立的 emoji/theme→sprite/颜色映射。项目的名称、shortUrl、emoji/theme 来自 ChatGPT 自己写入的项目列表缓存；原生项目行真实渲染时只被动学习当前 sprite symbol/颜色作为最小视觉提示。改名/改图标不主动触发列表请求，等 ChatGPT 下一次自然刷新/展开列表后渐进更新；语义图标已变化时不得继续沿用旧视觉提示。项目元数据按现有 scope 隔离、按 ID 合并，缺席不删；快捷项不批量预取。修改该适配时先读 README 对应章节；真实 `_account` 是 JSON 字符串，原生缓存路径使用解码 ID，但不得因此变更已有 Queue/用量的 scope 摘要。原生折叠 cookie 仅是 UI 偏好，不读取认证凭据。旧 DNR 规则只允许迁移性删除，禁止新增规则。

## 用量、存储与发布

用量模型使用明确允许列表 `gpt-6-pro` / `gpt-5-6-pro`；Thinking、Work、Codex 不计。Chrome `onBeforeRequest` 发生在建连前，只提取 conversation action、模型、原生用户 message ID 与 tab/document 元数据；`onSendHeaders` 是 Pro 用量的只读发送边界，在此立即计数，不等回复结束。`onCompleted` 只作为候选完成事件：先把最小 request correlation 标成 completedAt，再向精确 document 发 completion hint 并做语义 probe；running/unavailable 不直接完成，而是保留 candidate 并按 30 秒 Alarm 复核。若精确 tab/route 仍匹配，但页面因浏览器节流、冻结或扩展 document 暂不可响应，允许基于“原生网络请求已正常结束”发一次非成功的“后台回复待确认” attention，提示用户返回页面继续语义确认；不得把这个兜底升级成 completed、推进 Queue 或包含回复正文。candidate 在正常 settle、下一条 claim、Stop、路由/document 失效或 10 分钟 TTL 后清理。discarded 直接结束精确恢复。scope / route / generation 的已确认不匹配必须 fail closed，不得退化成 generic。DOM 兜底只接受已确认正常完成的新回复，以相同原生用户 message ID 去重；发送前可能出现的乐观模型标记、assistant ID、重生成 ID、点击次数或所选模型都不能制造用量。未知请求结构/身份/模型宁可漏记并允许手动校正。ChatGPT 路径、bootstrap 字段和模型 slug 都是适配观察，不是稳定公开契约；不得伪造官方历史、余额或刷新时间。

请求正文、Cookie、Token、响应内容不写入用量存储、完成关联或诊断；临时 requestId 关联及时删除。完成通知可以把当前问题的短标题、耗时和已完成回复的短预览交给 Chrome / 操作系统通知中心显示，但这些预览不得写入扩展持久化存储；generic network fallback 不得包含回复正文。后台标签页不能可靠执行 content script 或原生 Send：network request 已结束且精确 tab/route 仍匹配，但 tab 已 frozen 或精确 document probe 暂不可响应时，只允许发一次“后台回复待确认”的非成功 attention 并保留 candidate；页面恢复后再做语义确认和 Queue 续发，等待期间不得直接 settle。generic → rich 使用同一 notification ID 更新；update 返回不存在时用同一 ID create。通知记录只在系统 create/update 成功后提升 delivered 等级；此前只保存无正文路由。只有用户主动关闭或点击才写 dismissed marker，系统自动关闭不能等同于用户拒绝。通知跳转仍按账号 / Workspace / conversation 校验。机会性清理只删除长期空闲、无正文、无活动 turn、无暂停/未知意图的空 Queue bookkeeping。不得自动删除 pending/unknown 或未知旧版数据。未知刷新周期的累计 ID 仍参与计数，不能按固定保留天数删除；有明确周期时才清理过期非计额 ID。

构建白名单以 `scripts/build-extension.js` 为唯一来源；本地、CI、Release 都复用 `dist`，仅包含运行文件和必要第三方许可声明。禁止整仓复制再维护排除列表；测试 Profile、trace、视频、依赖和 `.git` 不得进入扩展。保持无运行时依赖，新增权限必须有无法用现有能力解决的真实理由。完成修改必须运行全部单元测试、Playwright E2E、审查 diff 和体积，再提交。普通 main 提交只跑 CI；自动发布由 manifest 版本文件变更触发，或显式手动触发。已有 tag 必须匹配打包源码，不得覆盖已发布同版本制品，也不能让 tag 与制品对应不同提交。

不引入 Workbox Background Sync / HTTP outbox：它解决失败请求重放，而本项目必须保留原生发送与 unknown 不重发边界。保留 `chatgpt-yolo` 的必要 MIT outbox 思路，不整体引入其 workflow、审批、模板或自动刷新体系。

一手依据（实现依据而非临时调试记录）：
- Chrome webRequest：https://developer.chrome.com/docs/extensions/reference/api/webRequest
- Worker 生命周期与存储：https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle 、 https://developer.chrome.com/docs/extensions/reference/api/storage
- 文档定向消息：https://developer.chrome.com/docs/extensions/reference/api/tabs#method-sendMessage
- CSS top layer 与原生 popover：https://drafts.csswg.org/css-position-4/#top-layer 、 https://html.spec.whatwg.org/multipage/popover.html
- 上游 outbox：https://github.com/kartikkabadi/chatgpt-yolo （许可见 THIRD_PARTY_NOTICES.md）
- 重放方案边界：https://developer.chrome.com/docs/workbox/modules/workbox-background-sync
- Worker 终止验证：https://developer.chrome.com/docs/extensions/how-to/test/test-serviceworker-termination-with-puppeteer

## 通知投递补充（ADR-0006）

Queue 完成状态与通知 pendingKind 意图必须通过同一次 storage.local.set 批量提交；不得把 Chrome Storage 描述成具有未文档化的事务保证。通知失败不得因为 turn.done 而遗失，也不能阻塞后续发送。通知投递失败仍复用原有 sampler（至少间隔 10 秒）与 Worker 启动；另外 completion candidate 可使用 30 秒 Alarm 做语义恢复，但只在候选存在期间启用，不是 keepalive。精确页面 probe 因后台节流/冻结暂不可响应时，可以发独立的非成功“后台回复待确认” attention；恢复后的真实 completed / approval / error 仍使用各自结果 ID，不被该兜底消费。同一结果的 generic → rich 静默 update，attention / failed 与最终结果分离 ID；用户关闭审批通知不能消费最终结果。关闭提醒开关丢弃待补发意图；Stop 或本轮终态取消已失效的未投递审批提醒。待投递记录不能被普通已完成通知清理误删。浏览器权限与 OS 实际横幅可见性必须区分，不承诺冻结/丢弃期间及时执行或 OS 绝对 exactly-once。Chrome 通知没有 CSS 外观接口，只用标题/正文/图标/contextMessage 等真正支持的字段。队列 UI 的发送可用性直接投影现有 safeToSend，不复制一套状态机。

## Agent skills

### Issue tracker

项目需求、PRD 与开发任务统一记录在 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 mattpocock/skills 默认的五类分流标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用单一上下文结构，领域术语写入根目录 `CONTEXT.md`，架构决策写入 `docs/adr/`。详见 `docs/agents/domain.md`。
