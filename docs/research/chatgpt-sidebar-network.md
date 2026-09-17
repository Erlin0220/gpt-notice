# ChatGPT Web 侧栏请求行为调研与减量策略

> 调研日期：2026-09-16。本文记录真实 ChatGPT Web 页面上通过浏览器 Network 面板观察到的行为，以及 gpt-notice 基于这些事实采用的请求减量策略。

## TL;DR

ChatGPT 左侧栏不是纯静态导航。**置顶 / 项目 / 聊天** 的展开状态会影响页面何时加载项目列表、项目详情、项目最近会话和普通聊天列表；项目数量较多时，展开项目相关区域尤其容易产生 request fan-out。

gpt-notice 最终没有选择拦截这些请求，而是采用更低侵入的方式：

1. 进入新聊天或项目新建页时，默认把原生 **置顶 / 项目 / 聊天** 收起；
2. 正常使用过程中被动积累项目元数据，提供本地 **快捷项目**；
3. 快捷项目只做导航，不批量预取项目详情或最近会话；
4. 用户真正进入某个项目时，继续让 ChatGPT 原生加载**当前项目**需要的数据；
5. 普通聊天列表、具体 Conversation、发送、Streaming、Stop、附件等网络行为保持原生。

因此，优化目标不是“让 ChatGPT 不发请求”，而是**减少因为侧栏展开、浏览和项目数量增长而触发的非必要并发请求**。

---

## 调研方法

本调研使用已登录的 ChatGPT Web，在 Chrome DevTools Network 中对以下场景逐一比较：

- 普通 Conversation 页面；
- 置顶折叠 / 展开；
- 项目折叠 / 展开；
- 聊天折叠 / 展开；
- 进入项目主页；
- 从项目主页新建会话；
- 已存在的项目 Conversation；
- 渲染 gpt-notice 快捷项目但不进入项目。

观察重点是请求的**类型和触发关系**，而不是某一次会话里的固定请求数量。ChatGPT Web 是持续迭代的私有前端，缓存命中、账号状态、实验分组和页面版本都会影响某个请求是否在某次刷新中出现。

因此本文将结论分成：

- **已确认行为**：在真实页面中重复观察到，且产品设计直接依赖；
- **常见请求**：观察到但具体次数可能随页面版本和缓存变化；
- **不能依赖的行为**：例如“把聊天折叠就一定不请求最近聊天列表”。

---

## 关键请求类型

### 1. 普通聊天列表

真实观察到的普通最近聊天列表请求包括：

```text
GET /backend-api/conversations?offset=0&limit=28...
GET /backend-api/conversations?...&hide_snorlax=true
```

它们返回的是普通最近聊天的列表元数据，不是完整消息树。

一个重要结论是：**“聊天”分区即使处于折叠状态，这两类请求仍可能由 ChatGPT 自动发起。**

因此 gpt-notice 不把“折叠聊天”当成可靠的网络拦截机制，也不伪造空列表响应。

### 2. 具体 Conversation

具体对话使用：

```text
GET /backend-api/conversations/{conversationId}
```

这是实际聊天内容加载链路的一部分，必须完整保留。

gpt-notice 不拦截、不替换、不重定向该请求。

### 3. 项目列表

项目侧栏列表相关请求包括：

```text
GET /backend-api/gizmos/snorlax/sidebar?...
```

该请求提供项目列表相关数据。gpt-notice 不主动调用它，而是读取 ChatGPT 自己已经加载并写入页面缓存的数据。

### 4. 单个项目详情

单项目详情使用：

```text
GET /backend-api/gizmos/{projectId}
```

真实响应中观察到的可用字段包括：

```text
projectId
short_url
display.name
emoji
theme
```

这些字段足以构建一个轻量的项目快捷入口，因此没有必要为了快捷项目再维护第二套完整项目模型。

### 5. 项目最近会话

进入项目主页时，当前项目最近会话使用：

```text
GET /backend-api/gizmos/{projectId}/conversations?cursor=0
```

实测通常只需要当前项目自己的这一份列表。响应包含类似：

```text
conversation id
title
snippet
时间信息
```

它是轻量最近会话列表，不是完整消息树。

**这个请求是有价值的，gpt-notice 明确保留。**

---

## 不同侧栏状态下观察到的请求

下表描述的是“触发关系”，不是对 ChatGPT 私有实现的永久 API 契约。

| 场景 | 真实观察到的主要请求 | gpt-notice 的处理 |
| --- | --- | --- |
| 普通 Conversation 首次进入 | 普通 `/backend-api/conversations?...` 列表；当前 `/backend-api/conversations/{conversationId}` | 全部保留 |
| **置顶收起** | 不主动展开项目型置顶内容；已经触发的请求不会被取消 | 新聊天默认收起 |
| **置顶展开** | 常见多个 `/backend-api/gizmos/{projectId}` 与对应项目 conversations，请求数量会随置顶内容增加 | 用户手动展开后完全尊重原生行为 |
| **项目收起** | 避免因为用户一进入新聊天就立刻展开整批项目 | 新聊天默认收起 |
| **项目展开** | `/backend-api/gizmos/snorlax/sidebar?...`；可进一步出现多个项目详情与项目 conversations | 不拦截；只避免“默认就展开” |
| **聊天收起** | `/backend-api/conversations?...` 仍可能自动请求 | 不承诺通过折叠消除它 |
| **聊天展开** | 普通最近聊天列表继续由 ChatGPT 原生加载 | 不拦截 |
| **仅渲染快捷项目** | **扩展自身不新增项目详情 / conversations 请求** | 从本地项目缓存和已渲染 DOM 读取 |
| **点击快捷项目** | 导航到 `/g/{shortUrl}/project`，由 ChatGPT 加载当前项目需要的数据 | 只导航，不预取 |
| **点击快捷项目的新建按钮** | 新标签打开 `/g/{shortUrl}/project`；后续由 ChatGPT 加载当前项目数据 | 不提前创建 Conversation |
| **进入已有项目 Conversation** | 当前具体 `/backend-api/conversations/{conversationId}`，以及页面自身需要的项目上下文 | 完整保留 |

### 为什么“项目 / 置顶展开”是主要减量目标

当多个项目同时可见时，观察到的典型 fan-out 类似：

```text
展开项目 / 置顶
   │
   ├─ Project A
   │   ├─ GET /backend-api/gizmos/A
   │   └─ GET /backend-api/gizmos/A/conversations?...
   │
   ├─ Project B
   │   ├─ GET /backend-api/gizmos/B
   │   └─ GET /backend-api/gizmos/B/conversations?...
   │
   └─ Project C ...
```

项目越多，同时展开时产生的并发请求越明显。

这也是 gpt-notice 后来放弃“精确拦截某几个 URL”的原因：真正的问题不是某一个接口存在，而是**UI 默认展开会让很多本来暂时不需要的项目同时进入加载路径**。

---

## 进入项目新建页时发生什么

项目主页地址已经确认是：

```text
/g/{shortUrl}/project
```

它代表“在这个项目里开始新的聊天环境”，而不是一个已经存在的 Conversation。

在真实页面中，进入这里时 ChatGPT 会按需获得项目自身的数据，其中最重要的是当前项目最近会话：

```text
GET /backend-api/gizmos/{currentProjectId}/conversations?cursor=0
```

根据当前缓存和页面版本，还可能出现项目列表或当前项目详情相关请求，例如：

```text
GET /backend-api/gizmos/snorlax/sidebar?...
GET /backend-api/gizmos/{currentProjectId}
```

关键边界是：

> **进入 Project A 时，可以加载 Project A；不应该因为快捷列表里还缓存了 B、C、D，就顺手把 B、C、D 的 conversations 一起预取。**

真正的 Conversation 通常是在用户发送第一条消息后由 ChatGPT 自己创建。gpt-notice 不提前创建 Conversation，也不调用私有接口代替这一过程。

---

## 快捷项目为什么不会制造新的请求风暴

快捷项目采用“被动学习”而不是“主动同步”。

### 数据来源

扩展只使用 ChatGPT 已经产生的数据：

1. ChatGPT 自己写入的项目列表缓存；
2. 当前页面已经出现的项目链接；
3. 当前项目页标题；
4. 原生项目行已经实际渲染出的图标 / sprite 信息。

扩展持久化的是最小项目元数据：

```text
projectId
shortUrl
name
emoji/theme（如果原生缓存提供）
最小原生图标提示（如果实际观察到）
```

### 不做什么

快捷项目不会：

```text
for every cached project:
    GET /backend-api/gizmos/{projectId}
    GET /backend-api/gizmos/{projectId}/conversations
```

也不会因为某次原生项目列表里没出现一个项目，就立即认定它已经被删除。

项目改名、shortUrl 或图标发生变化时，如果 ChatGPT 本轮没有自然刷新项目列表，快捷项也不主动追着请求；等下次正常展开 / 进入项目时再渐进同步。

这使快捷入口的请求成本基本与“本地渲染一份导航”一致，而不是“维护第二套项目客户端”。

---

## gpt-notice 的请求减量设计

### 方案 A：曾考虑过的 URL 拦截

早期实验曾考虑直接阻止普通列表或项目列表请求。

问题是这种方案会扩大兼容性风险：

- 很难长期证明哪些列表请求“永远无用”；
- ChatGPT 前端会迭代，请求参数和调用顺序不是公开契约；
- 项目主页确实需要当前项目最近会话；
- 具体 Conversation 绝对不能误伤；
- 返回伪造空数据会把扩展变成 ChatGPT 私有后端协议的代理实现。

最终产品没有采用该方向。

### 方案 B：当前采用的“减少触发”

当前策略更接近成熟客户端的 lazy loading：

```text
新聊天 / 项目新建页
        │
        ├─ 默认折叠 Pinned
        ├─ 默认折叠 Projects
        └─ 默认折叠 Chats
                 │
                 ▼
        避免默认展开带来的 fan-out

用户需要项目
        │
        ├─ 已缓存 → 快捷项目直接导航
        └─ 未缓存 → 正常展开原生项目列表

真正进入某个项目
        │
        └─ 只让 ChatGPT 自己加载当前项目所需数据
```

实现上：

- 只在进入 `/` 或 `/g/{shortUrl}/project` 时初始化一次折叠状态；
- 同时更新 ChatGPT 自己使用的侧栏分区偏好，并在必要时点击已经展开的原生分区按钮；
- 折叠完成后不继续控制，用户手动展开立即恢复原生行为；
- 快捷项目放在原生 Sidebar 正常布局流中，不通过 fixed overlay 模拟；
- 旧实验 DNR 规则只做迁移性删除，当前代码不再新增阻止规则；
- 没有 `fetch` / XHR monkey patch；
- 没有项目预取循环；
- 没有为侧栏新增 MutationObserver 或第二套轮询。

---

## 请求预算：什么应该加载，什么不应该加载

可以把当前设计理解成一个简单的 request budget：

### 应该加载

- 当前用户真正打开的 Conversation；
- 当前用户真正打开的项目；
- 当前项目主页需要的最近会话；
- 用户主动展开原生列表后 ChatGPT 自己决定加载的数据；
- ChatGPT 自己需要的普通最近聊天元数据。

### 不应该由扩展额外加载

- 所有已缓存项目的详情；
- 所有已缓存项目的最近会话；
- 仅为了刷新快捷项目名称 / 图标而主动调用项目 API；
- 为了让“聊天折叠看起来没有请求”而伪造 conversations 响应；
- 为了减少 Network 数量而误伤具体 Conversation。

这个边界比“拦哪些 URL”更稳定，因为它描述的是产品意图：

> **只加载用户当前真正使用的上下文；缓存目录只负责导航，不负责预热所有内容。**

---

## 验收时应该看什么

在 Network 面板中验证侧栏优化时，重点不是“请求必须为 0”，而是以下行为：

### 普通 Conversation

- 具体 `/backend-api/conversations/{conversationId}` 正常返回；
- 普通 `/backend-api/conversations?...` 可以存在；
- 没有因为快捷项目而同时请求一批 `/gizmos/{otherProjectId}/conversations`。

### 新聊天

- 置顶 / 项目 / 聊天默认折叠；
- 用户手动展开后不被扩展反复强制折回；
- 快捷项目仍可用。

### 快捷项目

- 单纯渲染快捷列表不新增项目详情或最近会话请求；
- 点击项目只进入对应原生项目主页；
- 点击 compose 在新标签进入同一项目新聊天环境；
- 项目数量增加不会导致扩展后台遍历所有项目。

### 项目主页

- 当前项目自己的 `/gizmos/{currentProjectId}/conversations?cursor=0` 正常；
- 当前项目最近会话正常展示；
- 不因其他快捷项目存在而同时预取它们的 conversations。

---

## 已知边界

1. 这里记录的是 ChatGPT Web 的**实测私有实现**，不是 OpenAI 公开 API 契约。
2. 接口路径、参数、缓存结构和 React DOM 都可能变化，因此适配必须 fail closed。
3. 折叠 Chats 不能保证普通 conversation-list 请求消失；当前设计也不追求这一点。
4. 减少侧栏 fan-out 可以降低相关请求压力和 429 风险，但不能绕过服务器端限流。
5. 已经发出的请求不会因为扩展随后折叠侧栏而被取消；优化重点是**避免下一轮不必要触发**。
6. 浏览器缓存可能让某次验证少看到一个请求，因此应关注多项目展开时的整体趋势，而不是单次请求数量。

---

## 对应实现

- `sidebar.js`：新聊天一次性折叠、原生 Sidebar 快捷项目、原生图标复用。
- `projects-core.js`：项目最小元数据规范化与持久化合并。
- `chatgpt-dom.js`：读取 ChatGPT 已有的页面事实与项目缓存。
- `background.js`：项目持久化单写者与旧 DNR 规则迁移清理。
- `tests/e2e/sidebar.spec.js`：折叠、快捷导航、当前项目最近会话、账号隔离等回归。

实现约束同时记录在 `AGENTS.md` 的“侧栏优化”条目中。

