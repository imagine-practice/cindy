# Cindy 项目内核 v1（M1 实现规格）

2026-11-05。用户决定：项目要做进 Cindy 主项目，项目管理是 Cindy 的核心能力，**要完全替代现在的协作模式**（按目录归组 + 群聊分工）。原型阶段已结束，本文件是 M1 的唯一实现输入。

## 1. 现状与目标

现状（代码事实）：

- “项目”只是 `sessions.project_dir` 的归组；侧栏由 `projectGrouping.ts` 按 `workingDir` 归一化后分组，同名靠路径段消歧，另有 `projectAliases`。
- 没有项目实体：没有 `projects` 表，没有负责人、成员、项目级访问。
- 协作靠群：`bots` 相关群聊承载分工，群成员是参与边界，任务与项目之间没有显式绑定。

目标：把项目变成一等实体，任务绑定项目，成员与负责人成为数据而非约定；群聊降级为一种沟通频道，不再是项目协作的前提。

## 2. M1 范围（只做这些）

1. **数据模型 + migration**（append-only，按 `docs/dev-rules/database-and-migrations.md`）：
   - `projects`：`id`(text pk)、`name`、`goal`、`owner_id`、`status`('active'|'archived')、`created_at`、`updated_at`
   - `project_members`：`project_id`、`subject_kind`('account'|'bot')、`subject_id`、`role`('owner'|'member')、`added_at`；唯一键 `(project_id, subject_id)`
   - `sessions.project_id`（nullable，加索引）；`sessions.assignee_kind`、`sessions.assignee_id`（nullable）
   - 旧 `project_dir` 保留：`project_id` 为空时仍按现有归组显示，不做批量回填。
2. **主进程服务层**：项目的创建/查询/改名/归档、成员增删、负责人转交、任务绑定项目、设置处理人。规则在服务层强制：
   - 负责人必须是成员，且唯一；移除负责人必须先转交
   - 处理人为空 = 未分配，不得由负责人推断；非成员不可被指派
   - 成员按稳定 ID 去重，`subject_kind` 与人/伙伴的 ID 命名空间显式区分
3. **IPC + preload + renderer store**：按仓库既有约定接线，不新造跨进程协议；暴露上述服务层能力。
4. **界面（M1 最小）**：
   - 项目列表：实体项目与旧目录分组并存显示，实体项目有明确标识，可进入详情
   - 项目详情：概况、成员列表（含负责人标记）、工作项（= 绑定该项目的任务）列表
   - 新建项目：名称、目标、负责人（默认当前账号，可选成员）、成员多选
   - 任务绑定：新建任务时可选择归属项目；已绑定任务在侧栏归到该项目下
5. **测试**：schema/migration replay（`migrationReplay.test.ts` 会跑到新 migration）、服务层规则单测（负责人唯一、非成员不可指派、移除负责人被拒、成员去重）、分组逻辑在 `project_id` 存在时优先的回归。

## 3. 不做（M1 明确排除）

- 材料与版本（M2）、项目级真实 ACL 与多账号共享（M3）、移动端（后续）、插件化视图。
- 不改群聊模型，不删除现有群能力；M1 只让项目成为主载体，群聊继续可用。
- 不做旧数据自动迁移；不写回填 SQL。
- 不改 `projectAliases` 既有行为。

## 4. 边界与停止条件

- 不得重写历史 migration；新 migration 由 `pnpm --filter desktop db:generate` 生成，不手改 journal/snapshot。
- 遇到"必须先决定多账号所有权边界"的表级改动，停止并写提案，不自行铺开 `owner_id`。
- 若发现侧栏分组改动会破坏既有 `projectGrouping` 回归，先保旧行为，把新行为放进"有 project_id 时"的分支。
- 不提交、不推送、不合并；保留工作区现有未提交改动（`docs/dev-rules/repo-map.md` 与两个未跟踪文档）。

## 5. 验收（M1）

| ID | 操作 | 预期 |
| --- | --- | --- |
| C1 建项目 | 新建项目，名称/目标/负责人/成员 | 写入 `projects` 与 `project_members`；负责人同时是成员；列表可见 |
| C2 负责人守卫 | 尝试移除负责人；转交后再移除 | 前者被拒并给原因；后者成功，旧负责人仍留成员 |
| C3 成员去重 | 同名两个伙伴 + 同一账号重复添加 | 按稳定 ID 去重，同名不同 ID 分别保留 |
| C4 任务绑定 | 在项目内新建任务；给任务设置处理人 | `sessions.project_id` 正确；处理人写入；未分配时为 null |
| C5 指派守卫 | 指派非成员；清空处理人 | 非成员被拒；清空后为未分配，不被负责人填补 |
| C6 归属优先 | 有 `project_id` 的任务与仅 `project_dir` 的旧任务并存 | 侧栏按实体项目归组，旧任务仍按目录分组，互不吞并 |
| C7 持久 | 重启应用 | 项目、成员、负责人、处理人、任务绑定都还在 |
| C8 回归 | 跑分组/侧栏既有测试 | 无回归；`pnpm --filter desktop db:validate` 通过 |

## 6. 分片建议

- M1（本次）：第 2 节全部，界面到"能建项目、能配人、能建任务并绑定"。
- M2：材料与版本，走 `cindy-media` + `materials` 表。
- M3：项目级访问与多端（成员决定谁能看/能派），以及群聊与项目的角色分工收敛。
- M4：项目进度视图（里程碑、阻塞、验收状态）与自动化联动。

## 7. 执行方式：小步快跑 + 多路并行

M1 通过三项审计（migration 合规、守卫在服务层、旧目录分组回归）后才开后续片。切片与并行规则：

| 片 | 目标 | 写域 | 并行条件 |
| --- | --- | --- | --- |
| M2-A | `materials` 表 + 版本 + 受控媒体引用 | `apps/desktop/src/main/localDb/`、media adapter | 与 M2-B 并行，但先冻结 schema 与 IPC 契约 |
| M2-B | 工作项材料面板：添加、预览、去重选择、版本引用 | `apps/desktop/src/renderer/` | 依赖 M2-A 契约（类型与 IPC 签名），不依赖其实现完成 |
| M3-A | 成员决定项目可见与可派工 | main + renderer 的访问判定 | 与 M3-B 分开，避免同改群模型 |
| M3-B | 群聊降级为频道，项目成为协作主载体 | `features/bots/`、侧栏 | 串行，排在 3-A 之后 |

硬规则：

1. 每片单一目标，改动控制在 8 个文件以内；超出的先拆片，不硬塞。
2. 同一文件、schema、migration 序号、共享契约只能有一个所有者；其余片等契约冻结后再并行。
3. 派工前写清输入（规格条款）、写域（可改目录）、验收（可执行检查）、停止条件（遇到什么就停）。
4. 独立复验只测受影响项，不重跑已通过的全量矩阵。
5. 交付不产全量 hash 清单与成套截图；只在需要用户判断时给关键 3 张以内。

