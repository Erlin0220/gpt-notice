# 原生终态分类与有限 Queue 继续

日期：2026-09-16。依据当前真实代码与同日固定提交的上游源码核查。

## 决策

保留原有单 writer、lease/intent/receipt、单 sampler、独立 UI。原生 UI 派生 outcome 仍是业务终态；网络结束不是业务结束，也不是发送回执。但真实后台页验证表明“一次 network probe 失败后立即丢弃 request correlation”会把通知和 Queue 同时重新绑回页面 sampler，所以 network completion 现在保留为**带 TTL 的 wake candidate**：立即提示精确 document、继续复用同一语义判定；仍未终态时只用 30 秒 Chrome Alarm 做低频复核，不能直接 settle。

另一个恢复缺口来自原生 Send：仅存在页面内存的 pending baseline 时，扩展重载、页面刷新或 content controller 重建会留下 durable hold，却无法证明后来出现的新 user turn 属于这次发送。现在 hold 同步持久化发送前最后一个原生 user message ID (`holdBaseline`)；恢复时必须观察到一个位于该 baseline 之后的新原生 user turn，才允许重新建立 turn。baseline 本身是原生消息 ID，不保存 prompt 正文，也不把经过的时间当送达证据。

| 页面事实 | Queue / 提醒 |
| --- | --- |
| 当前轮原生完成控件、正确消息身份、非 running、稳定 3 秒 | 正常结束；可发送已有下一条，队列空才发成功提醒 |
| 已停止生成的原生瞬时错误（如“无法思考”），稳定 2 秒 | 记录 recoverable；可发已有下一条，不重发上一条、不生成继续文本 |
| 连续两轮 recoverable | 暂停并提醒；成功或人工继续重置计数 |
| 用户 Stop | 暂停，无成功提醒；已有人工/冲突暂停不被降级 |
| 原生审批或继续生成 | 仍是活动轮次；至多一次需要处理提醒，不代替用户操作 |
| 原生限额、策略、账号限制或未分类错误 | 暂停，发非成功提醒；点击 Queue 继续也不能绕过仍存在的原生阻塞 |
| intent 后无精确送达回执 | 仍使用既有 unknown 隔离，绝不自动重发 |
| 只有 network 结束、无完成控件，或 probe 超时/页面冻结 | 不推测完成；保留 candidate，30 秒后复核，frozen 等恢复 |
| 同一 generation 的 network 已完成，原生 Copy 等最终动作已出现，但 Stop/busy 仍残留 | 视为后台 UI 陈旧；允许完成。显式 Stop、error、approval 仍优先 |

这里只检查当前轮/原生 composer 的 alert、错误控件及窄范围状态标签；助手正文、代码示例和历史错误不是失败信号。正常安全拒答文本也不自动等同于账户策略封禁。`completed` 与 `recoverable` 的相同发送前置条件仍包括空草稿、无附件/IME、原生可发送、正确账号/路由/消息、未暂停及无未知 outbox。

两轮阈值是本产品对“允许下一条”与“避免持续耗额”的小型固定取舍，不宣称是上游通用最佳值。不增加通用重试调度器、HITL 自动审批、offscreen、心跳或页面请求钩子；completion Alarm 只服务未确认 candidate，candidate 清空后不再唤醒 Worker。

与 ADR-0002 不冲突：已经进入兼容性、安全、人工或冲突暂停仍需明确恢复；本决策只让已确认的 recoverable 终态不被错误地归为必暂停。取代早期 README/范围文档中“探针不可用时先发 generic”的规则；无事实不能发完成提醒。

## 上游取舍与可复核源码

以下 SHA 来自 GitHub API 的默认分支 HEAD；按固定 SHA 获取原始代码并核查关键分支。网页缓存无法显示部分固定链接时，通过同一 GitHub raw 源读取，不把缓存日期当作 HEAD。

- [OpenAI Codex](https://github.com/openai/codex/tree/7784318b5f7fa35728d41ffa13e2a5821ebb4d75)：`codex-rs/core/src/session/input_queue.rs`、`app-server/src/request_processors/thread_queue_processor.rs`。借鉴服务端拥有 Queue/空闲提交和明确事件边界；不搬入其 runtime、线程存储和多代理系统。官方 [App Server](https://learn.chatgpt.com/docs/app-server) 区分 `turn/completed` 的 completed/interrupted/failed 以及审批请求；这些不是 ChatGPT Web 扩展可直接订阅的公开事件。
- [chatgpt-yolo](https://github.com/kartikkabadi/chatgpt-yolo/tree/d018c6a9402685bf9bb90bd508988267c5895be8)：`queue.js` 明确区分 intent 前可重新 claim 与 intent 后 delivery_unknown。保留现有 MIT outbox 适配，不引入 workflow/自动刷新/审批体系。
- [dsh-auto-continue](https://github.com/HsiangNianian/dsh-auto-continue/tree/94a3e102681d8ba06c5e2bb85bf9f939b001d11b)：`src/host/engine.ts` 以 host `turn/end` 原因区分 completed/aborted/失败并限制连续尝试。只借鉴已知原因分类、用户 Stop 优先和有界恢复；不移植自动发“继续”、loop guard、事件流重连和退避系统。
- [chatgpt-done-notifier](https://github.com/kkonstantin08/chatgpt-done-notifier/tree/54381bf1c3362570d0dd8186dc258fa0c35e95ad)：`src/content/state-machine.ts` 跟踪真实生成周期、错误、手动 Stop 与稳定窗口；复核了这些思路，不复制未确认许可证的实现，也不引入其 Observer/offscreen 路径。
- [chatgpt.js](https://github.com/KudoAI/chatgpt.js/tree/43f377e0485c3ca8eaaf1cb8363fc8b03afd602c)：`src/chatgpt.js` 的 `isIdle()` 依赖 DOM/MutationObserver；idle 工具不提供本项目需要的送达保证或完整异常分类，不作为 Queue 的最终判据，不新增库依赖。
- Chrome [webRequest](https://developer.chrome.com/docs/extensions/reference/api/webRequest)、[MV3 Worker 生命周期](https://developer.chrome.com/docs/extensions/develop/concepts/service-workers/lifecycle)、[Page Lifecycle](https://developer.chrome.com/docs/web-platform/page-lifecycle-api)：运输层结束、worker 存活和页面可执行性是不同边界。不以保活或网络重放规避它们；Workbox Background Sync 的失败请求重放与本产品边界相反。

这些实现提供可复核思路，不代表所有库具有相同成熟度，更不能证明 ChatGPT DOM 是稳定契约。

## 验证与限制

核心模型/worker 单元测试覆盖终态、连续异常、Stop/unknown 优先、旧请求与重生成身份隔离。Chromium MV3 fixture 覆盖错误-only turn、正常/异常后下一条、限额/策略/未知错误、审批、Stop 残留完成按钮、无完成控件、助手正文误判、多标签/路由/账号、重启、草稿/附件与计数。

真实登录验证只验证实际页面适配和已安装 UI，不发送任何模型消息，不证明服务器实发成功，也不证明后台长期冻结时能及时执行。测试网络出站默认拒绝；真实只读报告与 fixture 结果分开保存在 `test-results/`，不提交个人数据。没有新增运行依赖、权限或 runtime 文件。
