# Playwright 浏览器测试

## 测试分层

### 无登录自动回归

使用 Playwright Chromium 和 `.test-profile/automation`，验证：

- Manifest V3 Service Worker 加载。
- Popup 页面加载。
- Content Script 在 ChatGPT 域名页面注入队列 UI。
- Trace、视频、截图和控制台日志生成。

该层不登录 ChatGPT，不受账号验证影响。

### 真实 Team 页面验收

真实 ChatGPT 测试不再使用 Playwright Chromium 独立登录。OpenAI 可能将自动化浏览器识别为新设备或异常环境，并持续触发真人验证。

改为将 Playwright CLI 附加到用户已经登录、已经安装 gpt-notice 的 Chrome Profile 2。该方式复用现有 Cookie、Team 工作区、标签页和扩展，不复制 Profile 文件，也不重新输入账号凭据。

## 首次安装

```bash
npm install
npm run e2e:install
```

## 无登录冒烟测试

```bash
npm test
npm run e2e:smoke
```

## 连接 Chrome Profile 2

1. 保持 Chrome Profile 2 正常登录 ChatGPT Team。
2. 运行：

```bash
npm run e2e:profile2:prepare
```

3. 脚本会在 Profile 2 打开：

```text
chrome://inspect/#remote-debugging
```

4. 启用“允许对此浏览器实例进行远程调试”。
5. 运行：

```bash
npm run e2e:profile2:attach
```

6. Chrome 弹出连接授权时点击“允许”。
7. 获取当前页面快照或截图：

```bash
npm run e2e:profile2:snapshot
npm run e2e:profile2:screenshot
```

8. 完成后断开：

```bash
npm run e2e:profile2:close
```

连接只在本机进行。附加期间自动化工具可以访问当前 Chrome 会话中的页面和登录状态，因此只应在受信任的本机环境使用，测试完成后关闭连接。

## 目录约定

- `.test-profile/automation`：无账号扩展冒烟测试配置。
- `.test-profile/team`：已弃用，不再用于登录 ChatGPT。
- `test-results/`：报告、截图、视频、Trace 和脱敏诊断。
- `.playwright-cli/`：Playwright CLI 会话输出，禁止提交到 Git。

## Windows 通知边界

Playwright 可以验证页面、扩展 UI、Storage、任务状态和队列执行。Windows 通知是否真正弹出、正文是否正确以及点击后是否聚焦原标签，仍需在 Profile 2 中进行有界面验收。

## 故障处理

### Profile 2 无法附加

确认：

- Chrome 版本支持现有会话远程调试。
- `chrome://inspect/#remote-debugging` 已启用。
- Chrome 的连接授权弹窗已点击“允许”。
- 没有残留的同名 Playwright CLI 会话。

可先运行：

```bash
npm run e2e:profile2:close
npm run e2e:profile2:attach
```

### 出现 OpenAI 真人验证循环

不要继续刷新或重复验证，也不要尝试复制 Profile 2 的 Cookie。关闭 Playwright Chromium，改用上述 Profile 2 附加流程。
