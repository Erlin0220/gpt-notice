# Issue tracker: GitHub

本仓库的需求、PRD 与开发任务统一记录在 `Erlin0220/gpt-notice` 的 GitHub Issues 中。所有操作优先使用 `gh` CLI，并由当前仓库的 Git remote 自动解析目标仓库。

## 约定

- 创建 Issue：`gh issue create --title "..." --body-file <file>`
- 查看 Issue：`gh issue view <number> --comments`
- 列出 Issue：`gh issue list --state open --json number,title,body,labels,comments`
- 评论 Issue：`gh issue comment <number> --body "..."`
- 添加或移除标签：`gh issue edit <number> --add-label "..."` / `--remove-label "..."`
- 关闭 Issue：`gh issue close <number> --comment "..."`

多行正文应优先写入临时文件并通过 `--body-file` 传入，避免 shell 转义破坏 Markdown。

## Pull requests as a triage surface

**PRs as a request surface: no.**

Pull Request 不作为需求入口。需求、缺陷和开发计划均先进入 GitHub Issues；PR 只承载对应 Issue 的代码实现与评审。

## 技能发布规则

- 当技能要求“发布到 issue tracker”时，创建 GitHub Issue。
- 当技能要求“读取相关 ticket”时，读取 Issue 正文、评论与标签。
- `/to-spec` 创建的规格 Issue 应添加 `ready-for-agent` 标签。
- `/to-tickets` 应按依赖顺序创建独立 Issue，并使用 GitHub 原生依赖；原生依赖不可用时，在正文中维护 `Blocked by: #<number>`。

## Wayfinding

- Map 使用单独 Issue，并添加 `wayfinder:map` 标签。
- 子任务优先使用 GitHub sub-issue；不可用时使用任务列表和 `Part of #<map>` 关联。
- 阻塞关系优先使用 GitHub Issue dependencies；不可用时在正文顶部记录阻塞项。
- 可执行 frontier 是所有 blocker 已关闭且尚未被领取的首个开放子任务。
