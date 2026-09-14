# Repository instructions

## 长期产品与安全边界

产品只包含 ChatGPT 原生体验、纯文本 Queue、最终完成提醒、GPT-6 Pro / GPT-5.6 Pro 本地用量与刷新配置。不创建第二套聊天输入框，不接管原生 Send、Stop、模型选择和附件，不主动调用或重放 ChatGPT 私有接口。首页、项目首页和 `WEB:` 临时路由仅展示用量；只有稳定 conversation 才有 Queue。

**禁止发送真实 GPT-6 Pro / GPT-5.6 Pro 消息做测试，禁止消耗用户额度。** 发送、重生成、故障注入只用受控 fixture 和独立临时浏览器 Profile；不得清空用户真实扩展存储。真实登录页仅做只读验证，不改草稿、附件或刷新正在生成的对话。测试通过不等于真实服务发送已验证。

## 已确认的实现原则

- Service Worker 是本地状态唯一写入者，操作串行持久化。继续复用现有轻量 lease → intent → receipt outbox，不引入第二套队列框架。intent 后失去结果必须进入 unknown；时间流逝、出现动画或点击成功都不是送达证据。存储失败不得清空草稿；不做自动重发。
- 队列按账号/Workspace 摘要与 conversation 隔离。tabId 不是账号或文档身份；后台针对当前 document 查询页面身份。Popup 无法确认当前账号时不展示其他账号队列；通知不能仅凭相同 URL 跨账号跳转。
- 同一 tab 也可能切换分支。替换未完成 turn 要有前驱消息或明确原生 Retry 证据；不同分支的 Stop、晚到回执和旧完成按钮不得覆盖新生成。真实冲突暂停不能自动解除；仅保留已确认的旧版无来源 false-conflict 的窄范围恢复。
- 一个页面采样器、一个独立 Shadow DOM UI。不要为 token 重绘引入全页 MutationObserver、React 内部依赖、第二输入框或 fetch/XHR/History monkey patch。附件保护覆盖全部 file input、图片预览和中英文移除按钮。原生浮层与 Bar、Panel、编辑器任一区域相交都要让位，隐藏不能丢失未保存编辑内容；不通过极大 z-index 或扩展 top layer 压住原生菜单。
- Worker 随时可能被终止：关键队列状态用 `storage.local`，短期请求关联用 `storage.session`；不使用心跳、offscreen 或常驻服务保活。扩展 context 失效后停止旧页面实例的定时器和操作，提示人工刷新，保留原生草稿及附件。不自动刷新或为热注入新增 scripting 权限。

## 用量、存储与发布

用量模型使用明确允许列表 `gpt-6-pro` / `gpt-5-6-pro`；Thinking、Work、Codex 不计。Chrome `onBeforeRequest` 发生在建连前，只用于提取必要元数据；`onSendHeaders` 是只读发送边界，在此立即计数，不等回复结束。它仍不是服务端接收/官方扣费证明。DOM 兜底只接受已确认正常完成的新回复，以相同原生用户 message ID 去重；发送前可能出现的乐观模型标记、assistant ID、重生成 ID、点击次数或所选模型都不能制造用量。未知请求结构/身份/模型宁可漏记并允许手动校正。ChatGPT 路径、bootstrap 字段和模型 slug 都是适配观察，不是稳定公开契约；不得伪造官方历史、余额或刷新时间。

请求正文、Cookie、Token、响应内容不写入用量存储或诊断；临时 requestId 关联及时删除。机会性清理只删除长期空闲、无正文、无活动 turn、无暂停/未知意图的空 Queue bookkeeping。不得自动删除 pending/unknown 或未知旧版数据。未知刷新周期的累计 ID 仍参与计数，不能按固定保留天数删除；有明确周期时才清理过期非计额 ID。

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

## Agent skills

### Issue tracker

项目需求、PRD 与开发任务统一记录在 GitHub Issues。详见 `docs/agents/issue-tracker.md`。

### Triage labels

使用 mattpocock/skills 默认的五类分流标签。详见 `docs/agents/triage-labels.md`。

### Domain docs

本仓库采用单一上下文结构，领域术语写入根目录 `CONTEXT.md`，架构决策写入 `docs/adr/`。详见 `docs/agents/domain.md`。
