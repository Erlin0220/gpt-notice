# ADR-0006: 原子通知意图与低打扰交互

状态：采用。关联需求：GitHub #25。

## 问题

连续队列中间不通知、最终完成一次，是原有设计；截图不能证明 Windows 是否另行合并/隐藏横幅。审核发现两个确定漏洞：完成状态先写入，通知失败后页面清空 active turn，缺少重试；审批与完成共用 ID，关闭审批或隐藏页的较低 generic 等级会阻止后续完成提醒。

## 决策

使用现有 notification record，不另建数据库/后台队列。在 Queue 完成或 attention 状态提交时，用同一次 `storage.local.set` 批量写入状态与 pendingKind；这减少应用层的分步窗口，但不假定 Chrome Storage 提供未文档化的跨键事务语义。只保存路由、时间、耗时、队列来源等最小元数据，不保存问题或摘要。Chrome 调用成功后确认 kind 并删除 pendingKind。失败记录 retryAt，现有 sampler 至少间隔 10 秒重试；Worker 启动只恢复仍与当前账号/对话匹配的未投递记录。另增加 `alarms` 权限，仅在 network completion candidate 第一次语义 probe 未完成时创建 30 秒一次的 one-shot safety net；candidate 消失后不再续约，不作为 Worker keepalive。

审批、后台待确认恢复、异常与最终结果分离 ID；同一完成结果的 generic → rich 同 ID 静默 update。后台待确认提醒即使被关闭，也不能消费同一 generation 后续真实审批/确认提醒。先 update 也处理 OS 成功但本地确认前崩溃的窗口。明确关闭/点击只消费该事件；系统自动关闭不消费。Stop 或本轮终态取消已经失效的未投递审批；关闭提醒开关取消待补送。正常连续队列仍只通知最终结果；暂停或关闭队列功能不关闭独立手动回复提醒，且有待发消息时不宣称整队已完成。

队列按整体状态、有序消息、主次操作分层，中文化但不重写状态机。发送按钮直接使用 safeToSend 派生值，编辑/排序/未知结果仍走原 revision/lease 保护。Popup 用可键盘操作的原生 switch，区分功能、浏览器权限、最近投递和账号范围。

## 边界

系统通知只使用 Chrome Notifications API 支持的标题、正文、icon、contextMessage、eventTime、silent，不试图通过 CSS 改字体/圆角/背景。API 成功不等于 OS 横幅可见；勿扰/合并、浏览器崩溃及通知被 OS 清理无法靠本地记录做到绝对 exactly-once。后台页面可能被 Chrome/ShardX 标为 frozen，也可能只表现为精确 content-script probe 超时/暂不可响应。若对应 network request 已正常结束且 tab/route 仍匹配，这两种情况都只发一次事实型“后台回复待确认” attention，不把它升级成 completed；candidate 保留到页面恢复后的语义 probe。discarded、已确认 route/scope/generation 不匹配时放弃该次精确恢复。恢复通知使用通用文字，优先隐私而非持久化摘要。

侧栏折叠与被动缓存减少无意义项目 fan-out，缓解相关 429 风险，不绕过服务器限流。DNR 只保留旧规则删除迁移。

## 一手依据与验证

- Chrome Notifications API：https://developer.chrome.com/docs/extensions/reference/api/notifications
- MV3 持久化与事件：https://developer.chrome.com/docs/extensions/develop/migrate/to-service-workers
- Fluent 2 通知节制与标题：https://fluent2.microsoft.design/components/web/react/core/toast/usage
- Fluent 2 主次按钮：https://fluent2.microsoft.design/components/web/react/core/button/usage
- Chromium 操作可用性：https://chromium.googlesource.com/chromium/src/+/refs/heads/main/chrome/browser/download/download_commands.h

unit 覆盖单条/整队、分离 ID、关闭/点击、原子失败、权限、Worker 重启与 OS 成功确认前崩溃。Chromium MV3 fixture 验证连续发送、失败后自动补送、审批后完成、中文操作和 Popup；fixture 出站完全隔离。真实登录页只读适配器事实和已安装 UI，不冒充付费发送验证。
