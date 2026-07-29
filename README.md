# ChatGPT 任务完成提醒

非官方 Chrome Manifest V3 扩展。监控当前仍然打开的 ChatGPT 页面，在任务完成、等待确认或失败时发送 Windows 通知，并提供按标签页隔离的纯文本消息队列。

## v0.7.1 核心变化

- 任务监控和消息队列统一使用页面状态适配层，不再各自维护停止按钮、发送按钮、确认、忙碌、错误和消息节点规则。
- 页面支持状态区分 `initializing`、`supported` 和 `unsupported`；兼容性区分 `healthy`、`degraded` 和 `blocked`。
- 页面无法安全判断时自动队列进入兼容性暂停；页面恢复后仍需用户点击“继续”，不会隐式重发。
- **加入队列**在受支持的 ChatGPT 工作页面中始终可点击。空输入、页面不支持或无法安全读取输入框时会给出明确结果。
- 没有活动任务时也可以预存队列消息；空闲入队默认暂停，不会立即发送。
- 修复 ChatGPT 空输入框隐藏发送按钮时，队列恢复后一直等待、无法写入首条消息的问题；扩展现在会先写入文本，再等待发送按钮出现。
- 修复首页提升到 `WEB:` 临时会话和正式会话时，旧队列清理误删共享正文、导致剩余消息消失的问题。
- 队列固定为 FIFO，取消上移和下移；编辑、失败重试保持原位置，“立即执行”是唯一明确插队操作。
- 队列 UI 与 ChatGPT 流式回复 DOM 更新解耦；按钮和列表节点仅在真实队列状态变化时增量更新。
- Popup 新增本地诊断中心，可查看页面兼容性、通知权限、活动任务和消息队列状态。
- 支持复制脱敏 Markdown 诊断摘要、下载 JSON 以及单独清除诊断记录。
- 诊断事件最多保存 200 条、7 天，只保存在 `chrome.storage.local`，默认不包含完整问题、回复、队列正文、Cookie、Token、完整 URL 或原始会话 ID。
- 运行文本资源增加 175 KB 门禁，任一运行 JavaScript 文件不得超过 50 KB。

## 工作方式

1. 用户在 ChatGPT 页面发送消息后，扩展确认用户消息已经进入会话，再创建任务记录。
2. 可以切换到其他浏览器标签页，原 ChatGPT 页面仍会继续运行和通知。
3. 草稿页或 `WEB:` 临时会话进入正式 `/c/<会话ID>` 后，任务和当前标签队列会安全迁移。
4. 关闭 ChatGPT 页面后，该页任务停止监控；扩展不会创建后台标签或重新打开页面。
5. 页面刷新后，未完成队列统一暂停，避免重复发送。

## 消息队列

- 在输入框中填写内容后点击 **加入队列**。
- 空闲页面允许预存，入队后默认暂停；点击 **继续** 才开始发送。
- ChatGPT 正在回答时加入的消息会在当前回答稳定完成后按 FIFO 顺序发送。
- 输入框已有草稿时，自动发送、立即执行和编辑取回都会先询问是否覆盖。
- **立即执行**会重新读取实时页面状态，只有页面可安全发送时才执行。
- 支持编辑、删除、暂停、继续和失败重试；不支持上移、下移或拖拽排序。
- 队列按“标签页 + 会话”隔离；同一会话多个标签拥有各自队列，但共享唯一会话执行租约。
- 单条消息最多 200,000 个字符；完整正文与队列元数据拆分存储，界面只显示短预览。

## 页面兼容性与安全暂停

页面适配器公开结构化快照和能力标志：

- `canTrackTask`
- `canDetectCompletion`
- `canAdmitQueue`
- `canDispatchQueue`
- `canWriteComposer`
- `canClickSend`

当核心输入框或发送目标无法唯一确认时，页面进入 `blocked`。扩展会继续观察页面恢复，但不会误报完成、覆盖草稿或自动发送队列。正式兼容性暂停后必须由用户手动继续。

## 诊断中心

Popup 诊断中心显示：

- 当前页面支持范围、兼容性状态和原因代码
- Chrome 通知权限
- 活动任务数量
- 队列数量、暂停数量和待执行数量
- 最近任务、队列、租约、兼容性及通信事件

导出内容采用允许列表生成，不包含完整聊天正文、队列正文、Cookie、Token、完整 URL、原始会话 ID、真实 Tab ID、设备名或本地路径。清除诊断记录不会删除任务、设置、队列和本地诊断盐。

## 通知格式

```text
标题：用户问题或队列消息的第一行/首句
正文：思考了 37m 51s，回复正文第一行
```

## 安装与更新

1. 从 GitHub Releases 下载最新 `chatgpt-task-notifier-vX.Y.Z.zip`。
2. 解压到固定目录。
3. Chrome 打开 `chrome://extensions/` 并开启开发者模式。
4. 首次安装选择“加载已解压的扩展程序”；更新时覆盖同一目录并点击“重新加载”。
5. 打开扩展面板，点击“测试 Windows 通知”。

也可以使用 `scripts/update-installed-extension.ps1` 备份并覆盖固定安装目录。

## 已知边界

- 扩展依赖 ChatGPT 网页 DOM；网页结构变化后可能进入兼容性降级或暂停，需要更新适配规则。
- 队列只支持纯文本，不包含附件、图片、模型、模式或工具配置。
- 关闭 ChatGPT 标签页或完全退出 Chrome 后，无法继续监控和执行队列。
- 页面刷新后的未完成队列必须由用户确认继续。

## 隐私

扩展不调用 ChatGPT 私有接口，不读取登录 Cookie，也不上传聊天、队列或诊断数据。所有运行数据只保存在本机 `chrome.storage.local`。完整说明见 `PRIVACY.md`。

## 开发与测试

```bash
npm ci
npm test
npm run e2e:install
npm run e2e:smoke
```

语法检查：

```bash
node --check background.js
node --check chatgpt-dom.js
node --check content.js
node --check diagnostics.js
node --check popup.js
node --check queue-core.js
node --check queue-lease-guard.js
node --check queue-ui.js
node --check queue-v060.js
```

真实 ChatGPT 验收复用当前已经登录的 Chrome，不复制 Cookie，也不再依赖固定的 `Profile 2` 目录：

```bash
npm run e2e:chrome:prepare
npm run e2e:chrome:endpoint
npm run e2e:chrome:probe
```

Chrome 150 下使用 `DevToolsActivePort` 的完整 WebSocket 地址和 Playwright 原生 `connectOverCDP`；详情见 `docs/PLAYWRIGHT-E2E.md`。无登录 Chromium 冒烟覆盖 Service Worker、Popup 诊断、流式 DOM 下 UI 节点稳定和空闲入队；未执行真实登录环境验收时不得声明真实 ChatGPT E2E 已通过。

## 项目结构

- `chatgpt-dom.js`：唯一页面事实适配层、支持状态、兼容性和能力评估。
- `content.js`：任务监控状态机、导航提升和通知状态上报。
- `queue-core.js`：FIFO 队列数据结构、安全派发与恢复纯函数。
- `queue-lease-guard.js`：会话执行租约的页面实例隔离。
- `queue-ui.js` / `queue.css`：稳定挂载和增量更新的页面队列界面。
- `queue-v060.js`：队列运行编排、拆分存储、发送确认和租约管理。
- `diagnostics.js`：诊断事件、脱敏、裁剪和公开报告模型。
- `background.js`：任务存储、通知、诊断汇总和 Popup 消息路由。
- `popup.*`：设置、最近任务和诊断中心。
- `tests/`：单元、静态、生命周期、隐私及 Playwright 浏览器回归。

> ChatGPT 和相关图标归 OpenAI 所有。本项目为非官方浏览器扩展，与 OpenAI 不存在隶属或背书关系。
