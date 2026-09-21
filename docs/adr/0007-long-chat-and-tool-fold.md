# ADR-0007: 长对话 fail-open 渲染、滚动稳定与当前工具行折叠

日期：2026-09-20。状态：采用。

## 问题

旧“长对话性能优化”直接运行 `chatgpt-web-accelerator` 的 JS 模式：`IntersectionObserver` 按滚动容器判断 turn 是否离屏，离屏后写入 `content-visibility:hidden` 和测量高度；上游 `MutationObserver` 再发现新增 turn。受控 E2E 已复现一个真实失效模式：一个已经被标成 hidden 的旧 turn 被 SPA/React 复用到新会话后，旧状态可以继续留在同一 DOM 节点上，新会话于是保持空白，直到关闭优化清理状态。2026-09-20 核查上游默认分支时，这套 JS 虚拟化机制仍存在，因此继续原样 vendoring 不能消除该根因。

同一天只读检查真实 ChatGPT Web，工具行仍有 `span.group/tool-message`，但很多工具型回复已经没有 turn 级 `button[aria-expanded]` Thought disclosure；当前原生入口是工具摘要行内部的“打开工具调用列表 / Open tool call list”按钮，状态使用 `data-state`。因此只跟随 Thought `aria-expanded` 的旧折叠逻辑不会命中。

## 决策

长对话优化改成浏览器原生 CSS：`content-visibility:auto` + `contain-intrinsic-size:auto 500px`。启停只切换 document 根 class；不追踪滚动容器、不保存每个 turn 的可见状态、不使用 MutationObserver / IntersectionObserver、不设置 `will-change`、不卸载 React 子树。初始化只做一次旧版本虚拟化 class/inline style 清理。这样浏览器仍能跳过屏外 layout/paint，但页面内 turn 永远由浏览器按当前位置自动重新判定，不再有跨路由持久化的 hidden 状态机。

滚动位置异常作为独立 page-fix 处理，不并入性能优化状态机：复用现有 1 秒页面 sampler 获取最新 turn，只对它的滚动祖先、内容根和最新 turn 使用 `ResizeObserver`，再通过 `requestAnimationFrame` 做一次稳定性判断。只有用户此前处于底部附近、没有 wheel/PageUp/Home/滚动条拖动等向上意图，并且出现明显反方向位移或内容增长造成的大幅离底时才恢复到底部。短时间连续出现多次反方向跳动时停止自动修复，避免和原生逻辑互相争抢，只显示“跳到最新消息”按钮。禁止 monkey-patch `scrollTop` / `scrollTo`，也不新增 MutationObserver、独立轮询或 React 内部依赖。

工具折叠保留兼容双路径：

- 若原生 Thought disclosure 仍存在，继续读取 `aria-expanded` 并同步工具行；
- 若 Thought disclosure 不存在，同一 assistant flow 内只压缩“纯摘要”工具行，保留最后一个原生工具列表入口；含 iframe、图片、表格、App surface 或 marker 外交互控件的行 fail-open。

不移动 React DOM，不合成点击，不解析工具参数/结果，不用语言文本作为唯一结构锚点。当前 `group/tool-message` 只作为观察到的适配契约，必须由真实页面只读核查和 fixture 回归共同维护。

## 依据

- MDN `content-visibility`：`auto` 的目的就是允许 UA 跳过屏外内容的 rendering work，同时在内容需要时恢复；示例同时使用 `contain-intrinsic-size:auto <length>`。https://developer.mozilla.org/en-US/docs/Web/CSS/Reference/Properties/content-visibility
- MDN `IntersectionObserver`：显式 `root` 必须是目标的祖先，observer 配置创建后不可变。ChatGPT SPA 会替换/复用滚动与 turn 节点，把这类外部状态机绑在 React DOM 生命周期上需要额外同步。https://developer.mozilla.org/en-US/docs/Web/API/Intersection_Observer_API
- Chrome tabs：frozen tab 不能执行 tasks，包括 event handlers 和 timers，激活后才解冻。这个边界同时解释为什么冻结页不能靠 content script 自动点击原生 Send。https://developer.chrome.com/docs/extensions/reference/api/tabs
- 当前社区实现只作 DOM 变化交叉验证，不复制其代码：`chatgpt-tool-slimmer` 也以 `group/tool-message` / “打开工具调用列表”识别 2026-09 工具摘要，并把带 App surface 的行 fail-open；`chatgpt-stability-guard` 同样把工具摘要 chrome 与真实 App/action surface 分开处理。

## 验证

Playwright 回归覆盖：

- 旧 JS 模式可稳定复现“hidden turn 被 SPA 复用后新会话继续空白”；
- 新 CSS 模式开/关即时生效，SPA 替换滚动根并复用 turn 后仍为 `content-visibility:auto`，没有 inline hidden 状态；
- 滚动稳定器能纠正无用户输入的明显回跳；用户主动向上滚动后不会被拉回底部，手动“最新消息”按钮可恢复到底部；
- 旧 Thought DOM 仍按原行为折叠；
- 当前无 Thought、只有原生工具列表按钮的 DOM 会压成一个可访问摘要；
- rich/action 工具行保持 fail-open。

真实登录页只做 DOM 结构和现有控件的只读核查，不发送任何 GPT-6 / GPT-6 Pro / GPT-5.6 Pro 消息。
