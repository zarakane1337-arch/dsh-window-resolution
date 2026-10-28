# Issue Tracker：本地 Markdown

本仓库的 issue 与 spec 以 markdown 文件形式存放在 `.scratch/` 下。仓库尚无 git remote，GitHub 发布后（见 `.scratch/window-resolution/issues/` 中的发布 ticket）再迁移到 GitHub Issues。

## 约定

- 每个特性一个目录：`.scratch/<feature-slug>/`
- spec 是 `.scratch/<feature-slug>/spec.md`
- 实现 ticket 一票一文件：`.scratch/<feature-slug>/issues/<NN>-<slug>.md`，从 `01` 编号，不允许合并成一个大文件
- Triage 状态写在每个 issue 文件顶部的 `Status:` 行（角色字符串见 `triage-labels.md`）
- 评论与对话历史追加到文件底部 `## Comments` 标题下

## 当某个技能说"发布到 issue tracker"

在 `.scratch/<feature-slug>/` 下新建文件（目录不存在则创建）。

## 当某个技能说"抓取对应 ticket"

读取对应路径的文件；用户通常会直接给路径或编号。

## Wayfinding 操作

供 `/wayfinder` 使用。**Map** 是一个文件，每条 ticket 一个 **child** 文件。

- **Map**：`.scratch/<effort>/map.md`（Notes / Decisions-so-far / Fog 正文）。
- **Child ticket**：`.scratch/<effort>/issues/NN-<slug>.md`，从 `01` 编号，正文写问题。`Type:` 行记录 ticket 类型（`research`/`prototype`/`grilling`/`task`）；`Status:` 行记录 `claimed`/`resolved`。
- **Blocking**：顶部附近写 `Blocked by: NN, NN` 行。一个 ticket 只有在它列出的所有文件都 `resolved` 后才算解除阻塞。
- **Frontier**：扫描 `.scratch/<effort>/issues/` 中 open、未被阻塞、未被领取的文件；编号最小者优先。
- **Claim**：工作前先置 `Status: claimed` 并保存。
- **Resolve**：在 `## Answer` 标题下追加答案，置 `Status: resolved`，然后把 context pointer（要点 + 链接）追加到 `map.md` 的 Decisions-so-far。

## 迁移说明

GitHub Issues 可用后（安装并登录 `gh` CLI 后）：

1. 为每个 issue 文件创建对应 GitHub issue（`gh issue create`），标题取文件首行 `# ` 标题，正文取全文；
2. 把 `docs/agents/issue-tracker.md` 换成 GitHub 模板，`AGENTS.md` 的 Issue tracker 行同步更新；
3. `.scratch/` 下文件保留为历史归档。
