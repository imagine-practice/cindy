# 正式跟进请求账本：schema / migration 数据片

本片严格消费原执行作者 5a 的冻结目标，只交付表结构、工具生成迁移及真实 SQLite 验证。没有实现 `bots.followupRequest`、service、admission/reopen、dispatcher、中央 types、注册或发送；不能据此宣称跟进请求幂等整链完成。未提交、推送或合并，不操作真实账号、群、用户库或模型。

## 输入与基线

- 独立树 `task-followup-data`，分支 `cindy/task-followup-data`。HEAD 与本轮 `git fetch origin main` 后的 `origin/main` 均为 `1b18485d193812fa0a91a59939b0ab2aa2149707`。
- 显式全文读取冻结 `2026-11-06-task-followup-data-contract.md`，SHA256 `79A91217BC81B5ACE9721AEBC969E9A6AA3C58763E25B1A9DA86BAE57E52AA6D`。
- 同源目标 SQL fixture SHA256 `24019CD9D39D6CB2EBFCEF0C918B308DCDFB13838ECAE1836776CE9C91194FFB`，按原字节复制为 `apps/desktop/src/main/localDb/__tests__/fixtures/botTaskFollowupRequests.sql`，仅供测试，不当生产 migration。
- 仅从已验收材料 r3 manifest `DB7E0B984AA87F4E717CF22C7B0A8CF7B5338F6AAB05432944747D4182E667D8` 组合 B30 输入和 11 输出，以输出覆盖旧同路径项，得到 **38** 个最终固定输入；逐 hash 继承完整 0151 链。没有复制被覆盖的旧 schema/journal，没有读取 I1 或 5a 进行中的实现。
- 38 输入中只对 schema、journal、必要 migrationReplay 测试做本片增量，另 **35** 输入保持字节不变。材料 r3 原树 38 份源输入不写，旧 r3 manifest/log 保持原样。
- 按新 worktree 规则独立 `pnpm install --frozen-lockfile --prefer-offline --prod=false`，正常执行 postinstall，未复制/链接别树 node_modules。

## 正式产物与字段

`pnpm --filter desktop db:generate` 在实际 0151 链上生成 **`0152_far_nekra.sql`**、`0152_snapshot.json` 和 journal 追加项。没有手工分配序号、手改生成 SQL/meta 或改写历史。现有 journal 的 **152 项前缀**保持不变；旧 SQL/companion/snapshot 原样保留。无需 companion 或历史回填，旧消息与已有 delegation 不自动生成请求记录。

schema 导出：`botTaskFollowupRequests`；表名：`bot_task_followup_requests`。严格 **12 列**，无新增 owner/权限列：

| SQL 列 | Drizzle 属性 | 类型／空值与含义 |
| --- | --- | --- |
| task_id | taskId | TEXT NOT NULL；FK bot_delegations(id) ON DELETE CASCADE |
| requester_bot_id | requesterBotId | TEXT NOT NULL；真实 requester 由 main/原服务解析 |
| key_digest | keyDigest | TEXT NOT NULL；main 对原幂等 key 计算 SHA256 |
| body_digest | bodyDigest | TEXT NOT NULL；main 对 text.trim() 计算 SHA256，不存正文 |
| input_id | inputId | TEXT NOT NULL UNIQUE；owner DB 内固定输入身份 |
| admitted_run_sequence | admittedRunSequence | INTEGER NOT NULL，CHECK >= 1；记录原 admission 的 run |
| child_session_id | childSessionId | TEXT NOT NULL；记录原 admission 的 child，不挂新 Session FK |
| phase | phase | TEXT NOT NULL，CHECK admitted/dispatching/unknown/settled |
| native_accepted_at | nativeAcceptedAt | INTEGER 可空；原生 onAccepted 事实，与 provider/模型消费无关 |
| result_json | resultJson | TEXT 可空；由原服务保存实际 public result，本片不另定其字段 |
| created_at | createdAt | INTEGER NOT NULL |
| updated_at | updatedAt | INTEGER NOT NULL |

主键为 `(task_id, requester_bot_id, key_digest)`。没有以 run、parent/canonical Session 或 body 为主键，没有 body 去重或 `permission_snapshot_json` 内账本。owner 范围沿现有账号数据库；调用方不能靠提供 owner 字符串选择数据库。

Drizzle 将 input_id 的 UNIQUE 生成为具名唯一索引 `bot_task_followup_requests_input_id_unique`，fixture 是 SQLite autoindex；名字和 index origin 属物理表达差异，不影响唯一列或行为。CHECK 由 Drizzle 具名输出，predicate 与 fixture 相同。没有擅加 digest 格式、JSON、额外时间或严格整数 CHECK；运行时输入校验仍归原服务。不存在无法忠实表达而改合同的部分。

## 生命周期与消费交接

这张表只承载冻结合同已有事实：

- admitted：有持久请求和固定 input identity；dispatching：宿主已领取且可能越过派发边界；unknown：保留不确定结果；settled：实际 public result 已落库。
- `native_accepted_at` 和 `result_json` 独立；可先 settled 为 queued 结果，再收到原生 onAccepted。不能把字段写入解释成网络派发、模型理解或业务验收。
- delegation snapshot 整段替换、切 parent/canonical Session、run 更新、暂停或终态不能抹掉请求表。仅 task 删除会通过 FK cascade 移除；不新增 reusable key 清理策略。
- schema 保存原 input/result/child/admitted run，不替 main 产生或验证这些事实。不暗中添加新角色、跨账号 ACL、来源授权或重放豁免。

后续由 5a 原作者把固定消费者接到**正式生成 0152** 后联合验证：`bots.followupRequest` 的真实作用域查询、atomic admission/dispatch CAS/native acceptance/unknown/result；terminal admission 的 reopen 与 INSERT 同事务；旧 `bots.reopenDelegation` 的 mandatory expectedRunSequence；重放前后真实 caller/group/owner 权限；同 K 异 body 冲突及跨 run/Session 的原结果返回。本片没有复制其未收口 handler/service 或中央 hunk，也不把原先手建 fixture 测试算成生产迁移联合通过。

启用 keyed consumer 的先决条件是原 owner DB 已跑完正式迁移。旧无 key 路径、普通聊天、暂停/确认流程、provider 队列语义均未被本片改变。unknown 仍须原键/原 input 正式对账，不由 schema 删除占位或新建输入重发。

## 实际验证及边界

新增两项并入既有 `migrationReplay.test.ts`，使用 migration tier，未新建默认单测文件或增加 timeout。测试价值：旧回放没有此 12 列目标约束及跟进 phase 的 fileDB 恢复；最小失败为 input 重复被接纳、部分 DDL 留存或 dispatching/unknown 丢失。

1. **新库真实完整迁移 vs 固定 fixture**：动态比对全部 12 列（类型、空值、默认、PK 次序）、FK 及 unique 列集合，并在两种真实 SQLite 表上执行相同约束矩阵。验证 10 个 NOT NULL、复合 PK、全局 input 唯一、task/requester 两个范围维度、run=0/-1、非法 phase、缺 task FK、四个合法 phase、nullable native/result，以及删 task cascade，不只扫描 SQL 字面量。
2. **真实 0151→0152 升级**：保留已有 bot/profile/Session/delegation/messages 及 SDK metadata 快照。在表创建后的 unique-index 语句制造名称冲突，验证 migration 整体回滚、表消失、schema_version 仍 151、history 无 152、旧数据不变；移除受控冲突后正常重试到 152。
3. 在 fileDB 保存 admitted/dispatching/unknown/settled、原 input/result/child/run；替换 permission snapshot、改 parent/canonical Session 与当前 run 后两次真实关闭/重开，确认原记录及结果不漂移、重放迁移不重复执行。另验证 settled 后 native acceptance 注记不改 result/input、删除旧 child 不删历史身份、最终 task 删除按 FK 清理。

这里的行 INSERT/UPDATE 是**数据验证 fixture**，不是实际服务 admission/reopen 或 dispatch，不宣称发送了一个真实输入。新库/临时 fileDB、SQLite 与正式 migrationRunner 是真实执行；宿主/消费者联合与真实账号/模型尚未验。

本轮定向 **2 passed / 32 skipped，6.46 秒**；不能写成 34 项通过。随后完整回放另实跑 **34/34，18.98 秒**，测试体 14.74 秒；`db:validate` **6/6**。耗时属于已有 migration tier，不以删例或放宽 timeout 适配默认 unit 预算。默认完整 Desktop typecheck exit 0、文档检查 10/10、测试卫生检查 PASS（355 基线文件）、whitespace 检查通过。新 schema ESLint 通过；完整继承 replay 文件仍有 B 原有第 1141 行 `no-unsafe-finally` 一项，不顺手改旧冻结清理逻辑。逐 hash 清单与原始输出见外部固定 manifest/log，未跑的消费者联合检查不冒称通过。macOS 未实跑。

最小 **7 文件**增量：schema、生成 SQL/snapshot/journal、必要回放测试、原字节目标 fixture、本文；before/after 与完整原始输出在固定回执中。不写任何旧冻结树，交出固定版本后不继续改同版文件。作者验证不等于独立验收；后续仍需原消费者与正式 0152 的 admission/reopen 联合证据。
