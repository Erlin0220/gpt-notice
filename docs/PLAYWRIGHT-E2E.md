# Playwright 浏览器测试

## 分层

### 自动回归

`npm run e2e:smoke` 使用独立 Chromium 配置和本地 ChatGPT fixture，加载真实 Manifest V3 扩展，但不会访问或发送真实 ChatGPT 消息，因此不会消耗任何模型额度。

fixture 之外的网络请求和 WebSocket 默认全部阻断，仅放行 `chrome-extension:` 本地资源。不能只依赖默认 Thinking 模型或单个已知 endpoint 的 mock 来保证零额度。

覆盖重点：

- 首页、项目首页与正式普通/项目对话的 SPA 路由切换。
- 首页及项目首页仅显示用量，正式 conversation 才启用 Queue。
- 首次发送经过 `WEB:` 临时路由时不创建或迁移临时 Queue，且插件根节点保持不变。
- Queue 的持久化、编辑、删除、排序、暂停/继续、立即发送、连续派发与刷新恢复。
- 多标签 claim/lease、发送 intent、严格 delivery receipt、未知送达隔离与防重复发送。
- 草稿、附件、IME、原生 Send 抢占及持久化延迟竞态保护。
- Streaming 高频 DOM 更新和原生 composer 替换期间插件按钮保持同一节点且可点击。
- 手动发送与 Queue 发送的完成识别、Queue 未空不通知、最终只通知一次。
- GPT-6 Pro / GPT-5.6 Sol Pro 的本地观察计数、去重、手动校正、已确认刷新周期和存储失败降级。

运行：

```bash
npm install
npm run e2e:install
npm test
npm run e2e:smoke
```

### 已登录 ChatGPT 只读核查

真人页面用于确认当前 ChatGPT 的路由、DOM selector、原生 composer、消息 ID、完成控件、模型 slug 和扩展 UI 位置是否仍与适配器一致。默认只读，不发送测试 prompt，不消耗 GPT-6 或其他受限模型额度。

如需复用当前 Chrome，可使用：

```bash
npm run e2e:chrome:prepare
npm run e2e:chrome:endpoint
npm run e2e:chrome:probe
```

该流程仅附加当前已登录 Chrome，不复制 Cookie 或浏览器配置。`DevToolsActivePort` 不可用时，应把真人 CDP 核查记为未完成，而不是回退到独立登录、复制 Profile 或自动发送真实消息。

已有明确选定、可附加的 Profile 时，优先使用可复现只读核查：

```sh
node scripts/e2e-live-readonly.mjs "<selected-profile-directory>" "<project-home-url>" "<already-open-conversation-url>"
```

脚本只读取端口文件，不获取登录凭据；对已有对话仅在隔离 world 中运行本轮 Queue 路由/DOM 适配器的读取方法。独立首页/项目页阻断全部写请求及 WebSocket，验证已安装的用量 UI；不刷新扩展、不安装本轮完整控制器、不修改或重新加载已有对话。结束仅关闭自己创建的页面并断开测试进程。`test-results/live-readonly-audit.json` 记录适配器 SHA-256、布尔事实、阻断数量、生成请求数和原标签页保留情况；截图只留在本机测试目录。

## 真人验证边界

- 未经明确授权，不发送真实 prompt，也不使用受限模型做回归。
- 不修改用户已有草稿、Queue、模型选择或对话内容。
- 可以只读检查首页、项目首页、正式普通/项目对话是否加载正确 UI。
- 可以检查已有消息节点和原生完成控件，但不得用旧回复推断本轮发送一定仍兼容。
- 官方用量/reset 数据只有页面实际暴露时才能称为官方；没有暴露时只验证本地记录和来源标签。
- Windows 通知横幅是否可见还受系统“请勿打扰”和 Chrome 通知设置影响；自动化只证明扩展创建/去重/路由行为。

## 安全边界

- `.test-profile/`、`test-results/`、Playwright trace 和临时连接信息不得提交到 Git。
- 不读取或保存 Cookie、Token、登录凭据。
- 不注入第二套聊天 Runtime 或私有 API 客户端；测试专用出站阻断只用于防止发送，不进入扩展发布产物、不修改生产 fetch/XHR。
- 真人核查与 fixture 证据必须分开描述，不能把 fixture 行为宣称为线上 ChatGPT 已实发验证。
