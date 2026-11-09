# 项目进度事务契约

2026-11-05。承接项目内核计划与已复核的工作项进度纯函数。本契约冻结下一小片的实现范围，不代表页面、权限入口或迁移已经交付。

## 用户行为与含义

- 项目成员可记录普通工作进度，登记阻塞与解除条件；解除时必须留处理说明。
- `done` 是项目工作进度的明确完成确认，不自动表示独立质量验收、业务接受或发布。运行退出、未读完成消息、归档和 Agent 自报均不能生成完成确认。
- 本片完成确认使用现有成员表中带主体种类的负责人角色；不新增委托权限系统。负责人可以是伙伴，但伙伴完成确认也不能替代主人保留的业务接受或发布决定。以后新增委托需有明确可核验的授权记录，不能以任意客户端字段自授。
- 未知状态保留为 null；删除任务不允许再写进度，归档不自动完成。原有 `sessions.status` 不变。

## 事务输入与返回

客户端意图字段：`projectId`、`sessionId`、`expectedRevision`、`requestId`、`to`，以及按动作所需的 `reason`、`unblockCondition`、`resolution`、`completionNote`。无显式记录的 expectedRevision 为 0。

内部事务入口单独接收可信 `actor: {kind,id}` 与 `now`，只能由 main 的受信上下文提供，不能从客户端意图复制。确切 TypeScript 命名由执行者按现有风格实现并随交付列出，不扩展线上 IPC。

返回当前记录和本次事件标识、revision、是否重放。错误至少区分非法输入、无访问权、任务项目不匹配、任务删除、版本冲突、requestId 内容冲突、缺阻塞/解除/完成依据和不合法流转；错误不泄露不可见项目正文。

## 持久化意图

当前记录按 sessionId 唯一，包含项目、nullable 进度、revision、阻塞信息、最近事件及修改主体/时间。历史追加不可覆盖，记录前后状态、原因、条件、解除说明、完成确认说明、主体、来源项目、时间及 requestId。

完成确认本身作为有权主体明确发起的历史事件，同事务绑定当前记录，不能只接受一个无法查证的任意 evidenceId。它是进度确认记录，不是假造测试或业务接受证据。

进度变更、revision 自增、历史事件和请求回执同事务提交。成员资格与 sessions.project_id 必须在该事务读取验证；不可使用事务外传入的 role 或 members 快照放行。已解除项目绑定拒绝写；迁移项目后旧历史保存，旧项目作用域的完成状态不可自动带入新项目，转换需新显式事件。跨项目历史可见性由后续读服务另行核验，不默认向新成员公开旧项目材料。

幂等范围为 projectId + sessionId + actor.kind/id + requestId。同键同规范化意图返回原回执，不重复加 revision/历史；同键不同意图拒绝。先核对当前访问权再返回历史回执，撤权不能靠重放绕过。expectedRevision 用于新请求的乐观并发；重放不因已成功更新的 revision 被误报为失败。

无显式状态且证据不足时允许首次明确记录普通进度，历史 from=null；进入 done 仍须负责人确认。已 blocked 只能先明确解除到 todo/doing。已有状态遵循已冻结纯函数；普通记录不能静默抹掉阻塞信息，解除条件和原原因保留在事件中。

## 本片写域与集成顺序

执行任务继续原 m4-status 工作树，保留两个已冻结文件的字节。只新增：

1. `apps/desktop/src/shared/workItemProgress.ts`：事务意图/结果契约。
2. `apps/desktop/src/main/localDb/worker/opHandlers/workItemProgressTx.ts`：事务实现，遵循现有 worker 与 legacy inline worker 可装配约束。
3. `apps/desktop/src/main/localDb/__tests__/workItemProgress.test.ts`：真实内存 SQLite 测试及明确标注的测试表结构。

本片不修改 IPC、projectsTx、shared/projects、schema、migration、worker 注册、preload、页面、语言包，也不操作真实用户库。测试中的新表仅是目标结构 fixture，不能冒称生产 migration 已存在或上线接线完成。

原因：m3-access 正在写项目 IPC；m4-status 基线到 0145，材料集成基线已有 0146。在下一集成片统一选定包含材料链的基线，并核对最新 origin/main 后，由唯一迁移执行者修改 schema、使用 Drizzle 生成新迁移与元数据，再做回放。禁止从旧基线生成另一份 0146 或手动改 journal/snapshot。

本片通过后依次完成迁移/worker 注册、与权限任务联合 IPC 接线，再由页面任务接入概览和编辑。不把新增事务模块当作可用页面。

## 必测反例与交付

真实 SQLite 覆盖：首次记录未知进度；普通流转；阻塞缺原因/条件；解除缺说明；非负责人完成被拒；负责人确认完成与历史绑定；同 kind/id 权限及同名异种类；撤成员后写/重放拒绝；跨项目/解绑/删除拒绝；迁移项目不继承旧完成；两次不同请求使用同 revision 只有一次成功；同请求重放零新增；同键换内容拒绝；失败无半写；归档不冒领 done。

交付实际文件、完整签名、指纹、测试命令输出及未接线清单。无提交、推送、合并或真实模型发送。协调者独立审计后再安排接线。

## 绑定代次增量 B1（覆盖上文未区分绑定周期的部分）

实际事务反例已复现：p→q→p，中途没有进度写入，旧完成请求重放仍返回done。单凭项目ID与进度revision不能区分这两次绑定。

- sessions新增 `project_binding_revision`，非空整数，默认0。每次project_id实际改变（含解绑/重新绑定）同一绑定事务加1；同项目重复绑定、仅改处理人、归档不递增。新任务当前绑定以0为初始代次；不回填旧完成。
- 客户端进度意图增加必填 `expectedBindingRevision`，它是详情读取所得的前置条件，不是授权。事务读取sessions的实际代次，在幂等重放之前核对，不匹配返回 `BINDING_CONFLICT`；缺少或非法值拒绝，不由main悄悄补成最新值。
- 当前进度记录与事件增加 `binding_revision`，对外record增加 `bindingRevision`。仅项目及代次都匹配才可当当前进度，否则视为未知、有效progress revision=0。旧行/事件保留，不倒改。
- 幂等唯一范围加上binding_revision；新代次允许用户发新请求（即使requestId碰巧相同），但旧预条件请求必须拒绝。撤权检查仍先于读历史回执。版本冲突与绑定冲突各自保留。
- 详情/概览/历史读取和后续执行绑定也必须带绑定代次；旧回执不能覆盖较新的页面状态。本片不以新增列宣称这些读路径已接通。

### 数据结构与写域交接

进度两表字段以m4-status已交付 `workItemProgress.test.ts` 的目标fixture为结构输入（SHA256 F7DF2F7C099495858E8FF98E0B1E3D97225AC2E55C1050169EE789D5EDA1D26F），加上上述binding_revision；事件唯一索引包含该字段。字段类型、可空性与当前事务SQL须逐项对齐，Drizzle生成才是生产迁移。

迁移执行任务以已有0146的m2-materials-core为工作树：独占schema、新生成migration/meta、projectsTx绑定代次、必要projects/迁移测试；保持已复验材料三文件不变。不得改IPC/shared项目类型/UI/进度事务。生成前核对最新origin/main；若迁移链已变化，报告具体差异，不手改序号或隐式合并。

进度执行任务继续m4-status的原三新增文件，调整输入、代次守卫、存储字段、fixture与回归；不得抢改schema/projectsTx/migration/IPC。其fixture中的代次变化只证明事务消费正确，实际bindSession是否递增须由迁移任务用真实绑定事务单独验证，最终联合回放再次验证。

权限执行任务继续IPC写域，暂不修改projectsTx；后续代次字段对外透传按本契约接线，不能从renderer声明取得actor。若权限事务化需要改projectsTx，先提交明确补丁范围给协调，避免与绑定执行任务并写。

必测：p→q→p、p→null→p（期间均无进度写入）；旧代次原请求拒绝且零写入；新代次新记录from=null；同代次正常重放；同项目重复绑定不增代次；setAssignee不增代次；所有历史与旧确认保持原字节；生成迁移的旧库回放及原项目/材料回归。未完成联合接线前不得宣称生产缺口已关闭。
