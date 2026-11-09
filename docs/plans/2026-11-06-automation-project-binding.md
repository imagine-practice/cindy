# 自动化绑定项目实体（规格草案）

2026-11-06。当前自动化只有"仓库配置分组"（`schedules.project_config_id`），**没有指向项目实体的绑定**。本片补上"定时任务跑到咖啡亭项目里"。未实施。

## 1. 目标

1. 创建/编辑定时任务时可选一个项目实体；选中后该自动化产生的任务自动归属于该项目。
2. 项目进度页能看到"由自动化创建"的工作项，并按既有进度规则显示。
3. 项目归档/移除成员后，自动化不能继续往该项目写。

## 2. 数据

- `schedules` 增加 `project_id`（可空，指向 `projects.id`）；不加外键级联删除，项目归档时由服务层拒绝新运行。
- 迁移走 `db:generate`，序号接在现有链后；不手改 journal/snapshot。

## 3. 行为

| 场景 | 规则 |
| --- | --- |
| 创建/更新时选项目 | 必须是成员；非成员拒绝并给出原因；项目已归档拒绝 |
| 运行时项目被归档或成员被移除 | 本次运行失败并记录原因，不产生归属错误的会话；不静默改成无项目运行 |
| 运行产生会话 | `sessions.project_id = schedules.project_id`，`project_binding_revision` 从 0 开始，按既有创建链路 |
| 项目侧展示 | 进度列表里该工作项标注"由自动化创建"，并可跳到对应会话 |
| 删除/清空绑定 | 只影响后续运行，历史会话保持原归属 |

## 4. 硬约束

- 不重做 scheduler，不新增第二个调度器，不改运行语义（幂等、预约、补跑）。
- 不修改 `project_config_id` 的既有语义（仓库配置分组继续可用）。
- 运行失败必须留下可核对的原因，不得只写日志。
- 迁移与数据写入遵守 `docs/dev-rules/database-and-migrations.md`。

## 5. 验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| A1 | 给项目建一个定时任务并立即运行 | 生成的会话 `project_id` 正确，项目进度出现该工作项 |
| A2 | 非成员尝试绑定该项目 | 拒绝并说明需要成员资格 |
| A3 | 项目归档后触发运行 | 运行失败且原因可见；不产生无归属或错误归属的会话 |
| A4 | 运行前移除调度创建者成员资格 | 同上拒绝 |
| A5 | 清空项目绑定后运行 | 产生普通会话，不归属任何项目 |
| A6 | 项目侧显示 | 标注"由自动化创建"，可跳到会话 |
| A7 | 历史 | 改绑定/删任务不影响已完成会话的归属 |

## 6. 不做

- 不做跨项目批量自动化、不做项目级配额。
- 不做自动化产出自动转成验收状态。
- 不碰材料发送与群同步。

## 7. 实施记录（2026-11-06 收尾）

已按本规格实现，改动集中在 scheduler / schema / 自动化表单与项目进度读数，未改材料与群同步。
运行产生的会话**没有**新增第二条创建链路：`sessions.project_id` 由会话创建既有的授权事务写入。

| 位置 | 内容 |
| --- | --- |
| `apps/desktop/drizzle/0153_fuzzy_tomas.sql` | `schedules.project_id`（可空、无外键）。SQL 就是 `db:generate` 产出的裸 `ALTER TABLE schedules ADD project_id text;`，未做条件式改写。 |
| `migrationReplay` 夹具 | 一批"从 125+ 中途版本回放"的断言夹具从来自建最小库、没有 `schedules`；0153 的裸 ALTER 需要该表存在（真实库自 0010 起必有），因此这些夹具逐条补出 0152 形状的 `schedules`（`SCHEDULES_AT_0152_SQL`，列来源逐一注明）。不做 `createTempDb()` 全局补壳：0010 是 `CREATE TABLE IF NOT EXISTS`，先建只有 id 的壳会让 0010 跳过建全表。 |
| `scheduler-host/projectBinding.ts` | 保存期与运行期**同一份**判定：项目存在 → 未归档 → 当前账号是成员；空主体一律拒绝。 |
| `Scheduler.validateProjectBinding`（engine 钩子） | GUI / MCP / 仓库自动化三条 create・update 入口共用一道门，被拒时不落库。 |
| `scheduler-host/runner.ts` | fire 前再判一次（在任何工作区分配、hook、建会话之前）；失败写 `schedule_runs.error_msg` 并投失败通知。新建会话时把 `projectId` 传给 `maker.createSession`；绑定既有任务的运行不下传。 |
| `maker-core`（`SessionMeta.projectId` / `CreateSessionOptions.projectId`，可选） | 只做透传，其余入口不带该字段 → 行为不变。 |
| `maker-host/session-storage.ts` | 带项目归属的新建走 `persistAuthorizedSession`（成员资格 + 未归档 + `project_binding_revision=0` 同一事务）；普通新建保持原 insert。 |
| 自动化表单 | `ScheduleFormDialog` 增「归属项目」选择器（`ScheduleProjectBindingSelect`），script / 绑定既有会话两种不新建会话的形态不展示；保存失败按错误码给本地化文案。 |
| 项目进度 | 读取侧按 `schedule_runs.session_id → schedules(project_id=本项目)` 反查「由自动化创建」，`ProjectProgressView` 只加一个标记；无真实会话不出现。 |
| i18n | 12 语种同步：`scheduler.editor.projectBinding.*`、`ccAgent.projectCore.progress.automationOrigin*`。 |

已知边界：`schedules.project_id` 由调度侧持有，`schedules.json`（仓库自动化）尚无该字段，项目自动化形态不展示选择器；
运行失败原因是 main 的英文运维文案（与其它 runner 失败一致），界面按 IPC 错误码给本地化提示。
