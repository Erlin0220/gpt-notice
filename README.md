# ChatGPT 任务完成提醒

Chrome Manifest V3 扩展。在 ChatGPT 网页任务完成、等待确认、失败或后台监控断开时发送 Windows 系统通知，并支持把下一条消息加入会话队列自动执行。

## v0.5.0 核心变化

- ChatGPT 正在回答时，可继续输入下一条消息并点击 **加入队列**。
- 当前回答完成、页面稳定后，自动发送队首消息。
- 每条队列消息仍按独立任务处理，完成后立即发送一次 Windows 通知，然后继续下一条。
- 队列按 ChatGPT 会话隔离，并保存到 `chrome.storage.local`。
- 支持查看、编辑、删除、排序、暂停、继续和手动重试。
- 页面刷新、扩展 Service Worker 重启或后台监控标签接管后可恢复。
- 多个相同会话标签使用租约避免重复发送。
- 页面报错时最多自动重试一次，再次失败则暂停队列。

## 后台监控

v0.4.0 起，扩展使用当前 Chrome 普通窗口中的非活动标签继续监控，并收纳进折叠的 **GPT 后台** 标签组。

- 不创建额外 Windows 任务栏窗口。
- 创建后台监控页时不抢焦点。
- 同一窗口中的多个任务复用一个折叠标签组。
- 后台标签自动静音，并设置 `autoDiscardable: false`。
- 点击通知优先复用已有正常标签；只有后台标签时直接提升。
- 任务完成后默认保留后台标签 30 秒，再自动清理。
- 30 秒 Alarm 看门狗检查心跳、标签丢弃和 Content Script 连接。
- 10 分钟内最多自动恢复 3 次，超过后进入连接丢失状态。

## 通知格式

每个普通任务或队列步骤完成后分别通知：

```text
标题：用户问题或队列消息的第一行/首句
正文：思考了 37m 51s，回复正文第一行
```

扩展优先读取 ChatGPT 页面显示的实际思考时间；读取不到时使用任务运行时间兜底。

## 安装

1. 从 GitHub Releases 下载最新 `chatgpt-task-notifier-vX.Y.Z.zip`。
2. 解压 ZIP。
3. Chrome 打开 `chrome://extensions/`。
4. 开启右上角“开发者模式”。
5. 点击“加载已解压的扩展程序”，选择解压后的文件夹。
6. 打开扩展面板，点击“测试 Windows 通知”。

## 消息队列用法

1. ChatGPT 正在回答时，在输入框输入下一条消息。
2. 点击页面右下角 **加入队列**，消息不会立即发送。
3. 点击 **队列** 可查看等待项。
4. 当前回答完成后，扩展等待页面稳定并自动发送队首消息。
5. 每条消息完成后立即发送 Windows 通知，同时继续执行下一条。

用户手动发送消息时，队列会等待该消息回答完成后再继续，不会抢占输入框。

## 点击完成通知

1. 有正常会话标签：直接切换过去。
2. 只有后台标签：移出后台组、取消静音并切换过去。
3. 页面已经清理：根据会话地址打开新标签。

## 已知边界

- 完全退出 Chrome 后网页无法继续执行；重新启动后可读取已保存队列并恢复。
- 关闭最后一个 Chrome 普通窗口后，网页监控无法保留。
- 第一版队列仅支持纯文本，不包含文件、图片、模式切换或工具配置。
- ChatGPT 网页 DOM 改版后，输入框、发送按钮和状态识别规则可能需要更新。
- Alarm 可能因系统繁忙或电脑睡眠延迟触发。

## 隐私

扩展不调用 ChatGPT 私有接口，不读取登录 Cookie，也不向第三方服务器上传聊天内容。任务标题、状态、会话地址和消息队列仅保存在本机 `chrome.storage.local`。

## 开发与测试

```bash
node --check background.js
node --check background-utils.js
node --check background-tab-groups.js
node --check background-monitor-tabs.js
node --check background-watchdog.js
node --check background-actions.js
node --check background-events.js
node --check queue-core.js
node --check content.js
node --check queue.js
node --check popup.js
node tests/static.test.js
node tests/background.test.js
node tests/queue.test.js
```

## 项目结构

- `background.js`：Service Worker 加载入口。
- `background-utils.js`：任务状态、存储迁移和会话工具。
- `background-tab-groups.js`：GPT 后台标签组管理。
- `background-monitor-tabs.js`：后台标签创建、复用、提升和旧窗口迁移。
- `background-watchdog.js`：Alarm 探测、恢复和延迟清理。
- `background-actions.js`：通知、打开任务、设置和面板操作。
- `background-events.js`：Chrome 事件和消息路由。
- `content.js`：ChatGPT 页面任务状态识别和探测响应。
- `queue-core.js`：消息队列数据结构和纯函数。
- `queue.js`：消息队列页面 UI、持久化、恢复和自动发送。
- `popup.*`：扩展面板。
- `tests/`：无依赖单元测试和静态架构测试。

> ChatGPT 和相关图标归 OpenAI 所有。本项目为非官方浏览器扩展，与 OpenAI 不存在隶属或背书关系。
