# ChatGPT 任务完成提醒

Chrome Manifest V3 扩展。在 ChatGPT 网页任务完成、等待确认、失败或后台监控断开时发送 Windows 系统通知。

## v0.4.0 核心变化

v0.4.0 删除了最小化 Popup 窗口方案，改为在现有 Chrome 普通窗口中创建 `active: false` 的后台标签，并放入折叠的 **GPT 后台** 标签组。

- 不再产生额外 Windows 任务栏窗口。
- 创建后台监控页时不抢焦点、不切换当前标签。
- 同一 Chrome 窗口中的多个任务复用一个折叠标签组。
- 后台标签自动静音，并设置 `autoDiscardable: false`。
- 用户手动点击后台标签时，自动将其提升为普通标签。
- 点击通知优先复用已有正常标签；只有后台标签时直接提升，不重复打开。
- 任务完成后默认保留后台标签 30 秒，方便点击通知后直接查看，再自动清理。
- 使用 30 秒 Alarm 看门狗检查心跳、丢弃状态和 Content Script 连接。
- 删除后台页面每 15 秒固定刷新的旧逻辑，只有监控异常时才刷新标签。
- 10 分钟内最多自动恢复 3 次，超过后显示“连接丢失”，避免无限刷新。
- 用户手动关闭后台标签或标签组后，不会立刻重新创建。

## 通知格式

完成通知：

```text
标题：用户问题的第一行或首句
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

## 使用行为

### 切换到其他标签

原 ChatGPT 标签继续实时监控，不创建额外标签。

### 关闭正在执行任务的 ChatGPT 标签

扩展会在现有普通 Chrome 窗口末尾创建非活动标签，并收纳进折叠的“GPT 后台”组。当前活动页面不会被切换。

### 点击完成通知

1. 有正常会话标签：直接切换过去。
2. 只有后台标签：移出后台组、取消静音并切换过去。
3. 页面已经清理：根据会话地址打开新标签。

### 手动关闭 GPT 后台标签或标签组

视为用户主动停止后台监控，不自动重建。扩展面板会显示“监控已停止”，可点击“恢复监控”。

## 看门狗与恢复

Chrome Alarm 每 30 秒扫描任务：

- 检查绑定标签是否仍存在。
- 检查后台标签是否被 Chrome 丢弃。
- 发送 `PROBE_TASK_STATE` 检查 Content Script。
- 后台标签无响应时执行有限次数刷新恢复。
- 任务完成后按设置清理后台标签。
- 连续恢复失败后转为 `observer_lost`，并发送提醒。

## 已知边界

- 完全退出 Chrome 后无法继续监控。
- 关闭最后一个 Chrome 普通窗口后，网页监控无法保留；重新打开 Chrome 后会显示连接丢失。
- ChatGPT 网页 DOM 改版后，状态识别规则可能需要更新。
- Alarm 可能因系统繁忙或电脑睡眠延迟触发。

## 隐私

扩展不调用 ChatGPT 私有接口，不读取登录 Cookie，也不向第三方服务器上传聊天内容。任务标题、状态和会话地址仅保存在本机 `chrome.storage.local`。

## 开发与测试

```bash
node --check background.js
node --check background-utils.js
node --check background-tab-groups.js
node --check background-monitor-tabs.js
node --check background-watchdog.js
node --check background-actions.js
node --check background-events.js
node --check content.js
node --check popup.js
node tests/static.test.js
node tests/background.test.js
```

## 项目结构

- `background.js`：Service Worker 加载入口。
- `background-utils.js`：任务状态、存储迁移和会话工具。
- `background-tab-groups.js`：GPT 后台标签组管理。
- `background-monitor-tabs.js`：后台标签创建、复用、提升和旧窗口迁移。
- `background-watchdog.js`：Alarm 探测、恢复和延迟清理。
- `background-actions.js`：通知、打开任务、设置和面板操作。
- `background-events.js`：Chrome 事件和消息路由。
- `content.js`：ChatGPT 页面状态识别和探测响应。
- `popup.*`：扩展面板。
- `tests/`：无依赖单元测试和静态架构测试。

> ChatGPT 和相关图标归 OpenAI 所有。本项目为非官方浏览器扩展，与 OpenAI 不存在隶属或背书关系。
