# Playwright 浏览器测试

## 测试分层

### 无登录自动回归

使用 Playwright Chromium 和 `.test-profile/automation`，验证：

- Manifest V3 Service Worker 加载。
- Popup 与诊断中心加载。
- Content Script 和队列 UI 注入。
- 流式 DOM 更新期间插件按钮节点稳定。
- 空闲入队默认暂停和固定 FIFO 入口。

运行：

```bash
npm install
npm run e2e:install
npm test
npm run e2e:smoke
```

### 当前已登录 Chrome 真实验收

真实 ChatGPT 测试复用用户当前正在使用、已经登录 ChatGPT 并安装 gpt-notice 的 Chrome 配置，不复制 Cookie，不启动独立 Playwright 登录浏览器，也不再假设配置目录名为 `Profile 2`。

Chrome 150 下，`playwright-cli attach --cdp=chrome` 可能丢失浏览器会话 ID。项目改用 Playwright 原生 `chromium.connectOverCDP()`，从 Chrome 生成的 `DevToolsActivePort` 读取完整 WebSocket 地址。

## 启用当前 Chrome 远程调试

1. 保持当前 Chrome 正常运行并登录 ChatGPT。
2. 运行：

```bash
npm run e2e:chrome:prepare
```

3. 脚本会在当前 Chrome 地址栏打开：

```text
chrome://inspect/#remote-debugging
```

4. 启用“允许对此浏览器实例进行远程调试”。
5. 发起连接时，Chrome 会显示“要允许远程调试吗？”确认，点击“允许”。
6. 检查当前连接和标签页：

```bash
npm run e2e:chrome:endpoint
npm run e2e:chrome:probe
```

旧命令 `npm run e2e:profile2:prepare` 和 `npm run e2e:profile2:attach` 仅作为兼容别名保留，内部转到当前 Chrome 流程。

## 真实验收范围

真实验收至少覆盖：

- 普通首页空闲入队、默认暂停和人工继续。
- 首页 → `WEB:` 临时会话 → 正式会话的队列迁移。
- 多条消息固定 FIFO 自动发送与逐条完成。
- 项目主页入队和正式项目会话提升。
- 多输入框冲突触发兼容性暂停，恢复后仍需人工继续。
- 流式回复期间插件根节点和按钮节点不被替换。
- Popup 四维诊断与 Markdown/JSON 脱敏。
- Windows 通知标题、正文、思考时间和“打开任务”动作。
- 从其他页面触发“打开任务”后聚焦原有 ChatGPT 标签。

## Windows 通知验证

Playwright 能验证扩展 API、任务状态、队列和标签聚焦。Windows 横幅可能被“请勿打扰”或系统策略静默收纳；此时应同时检查：

- Chrome 通知权限。
- Windows 中 Google Chrome 的通知开关。
- Windows 通知数据库中实际生成的标题、正文与动作。
- `OPEN_TASK` 动作能否聚焦原标签。

不得仅凭 `chrome.notifications.create()` 返回成功声称用户看到了横幅；也不得因横幅被系统静默隐藏而误判扩展未发送通知。

## 安全边界

- 远程调试仅在本机开启。
- 测试完成后可在 `chrome://inspect/#remote-debugging` 关闭远程调试。
- 不复制浏览器配置、Cookie 或登录凭据。
- 只在新建测试会话中发送验收消息，不操作用户现有工作会话。
- `.test-profile/`、`test-results/` 和临时连接信息不得提交到 Git。

## 故障处理

### 找不到 `DevToolsActivePort`

先运行 `npm run e2e:chrome:prepare` 并启用远程调试。确认连接请求已点击“允许”。

### 连接超时

重新读取 `npm run e2e:chrome:endpoint` 的完整地址。不要只连接 `ws://127.0.0.1:9222/`，必须包含 `/devtools/browser/<id>`。

### OpenAI 真人验证循环

不要复制 Profile 或重复登录。关闭独立 Playwright Chromium，改为附加当前已登录 Chrome。
