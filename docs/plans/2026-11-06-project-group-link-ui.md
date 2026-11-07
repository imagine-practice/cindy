# 群 ↔ 项目关联界面（规格草案）

2026-11-06。数据层与 IPC 已存在，本片只补用户界面。未实施。

## 1. 已有能力（可直接用）

- 表：`project_group_links`、`project_group_link_requests`。
- IPC：`local-db:project-group-links:list | link | unlink`。
- preload：`electronAPI.localDb.projectGroupLinks.list / link / unlink`。
- 协议（`shared/projectGroupLinks.ts`）：`link` 与 `unlink` 都带 `requestId` 幂等键与 `expectedRevision`；错误码含 `NOT_PROJECT_OWNER`、`GROUP_ACCESS_DENIED`、`REVISION_CONFLICT`、`GROUP_AUTHORIZATION_UNAVAILABLE` 等。

## 2. 要做的事

| 位置 | 内容 |
| --- | --- |
| 群侧 | 群设置里新增「关联项目」区块：列出该群已关联的项目、可发起关联、可解除关联 |
| 项目侧 | 项目详情显示「已关联群」列表；点开可跳到该群（若已有原生入口） |
| 冲突 | `REVISION_CONFLICT` 时提示"列表已变化"，重新读取后由用户再操作，不自动重试 |
| 权限 | `NOT_PROJECT_OWNER` / `GROUP_ACCESS_DENIED` 显示为无权限并说明所需角色，不隐藏整块 |
| 空态 | 未关联时说明"关联后，群里可以带项目上下文提问" |

## 3. 硬约束

1. 只用既有 preload 通道；不新增 IPC、不改协议、不碰主进程。
2. `requestId` 每个动作独立生成并保存，重试复用；同一动作连点只发一次。
3. 解除关联要二次确认，且文案说明"只解除关联，不删除项目或群"。
4. 不显示群成员名单、不显示群消息内容、不显示项目访问凭证。
5. 关联成功后必须重新读取真实列表再渲染，不用回执里的 `commit` 冒充当前状态（协议注释明确要求 `current` 为准）。
6. i18n 同步全部 12 个 locale，跑 `pnpm check:i18n`。

## 4. 验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| G1 | 未关联的群打开设置 | 显示空态与说明，不显示假列表 |
| G2 | 关联一个项目 | 成功后可读到该关系；重复点击不产生第二条 |
| G3 | 两个窗口同时改，后提交者 | 得到 `REVISION_CONFLICT`，重新读取后再操作 |
| G4 | 非项目负责人尝试关联 | 无权限提示并说明需要负责人 |
| G5 | 解除关联 | 二次确认后列表移除；项目与群本身不受影响 |
| G6 | 断网/Host 未就绪 | 明确错误与重试入口，不显示成功 |
| G7 | 320 宽与浅深主题 | 可操作、无溢出、焦点可见 |

## 5. 不做

- 不做群成员管理、不做群消息与项目的双向同步。
- 不做批量关联、不做自动关联规则。
- 不碰材料、执行、自动化写域。
