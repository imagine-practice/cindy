# 正式 0152 迁移与跟进消费者联合验证

本片只验证固定实现的组合，没有修改生产实现、schema 或迁移。独立 `task-followup-joint` 基线为 `1b18485d193812fa0a91a59939b0ab2aa2149707`，未读取 I1 进行中字节，未提交、推送或访问真实用户库/账号/群。

## 固定输入与装配

- 数据来源：`task-followup-data`，正式数据 manifest SHA256 `9D345E57128CDA579D7658C50551D817E9E0BC865BA39BAF1EFFA61ECF3347CC`。
- 消费者来源：`task-followup-idempotency`，原 repair manifest SHA256 `466CF5E54C2EA39CFEF71C9E3F8C7029372FC4EDB8920C2C7EDD160BE11CCAF8`。
- 逐 hash 核验并复制 35 个不变数据输入、7 个数据输出和 8 个消费者输入，共 50 个唯一路径。数据 inheritedInputs 中 schema/journal/migrationReplay 三项由其正式 outputs 取代；没有复制旧版本覆盖 0152。两个不同路径的 SQL 目标 fixture 字节相同，均未作为联合初始化执行。
- 50 项输入的路径、来源、hash 记录在 `artifacts/task-followup-joint/protected-inputs.json`；输入 manifest 原字节留存。原数据树 42 文件、消费者树 8 文件及原 manifest 在交付时再次核对。

唯一适配的固定输入是新树里的原 canonical 测试：替换初始化，保留原服务、宿主依赖及所选行为断言；文件重开/第二连接改用生产 SQLite factory。其余 49 项装配输入保持原字节。旧树的八冻结文件完全不动。

## 联合增量（三个文件）

1. `apps/desktop/src/main/localDb/ipc/__tests__/jointFollowupMigration.fixture.ts`：测试专用初始化，使用生产 `createBetterSqliteDatabase`、bundled sqlite-vec、`listMigrations` 和 `runMigrationReplay`。
2. `apps/desktop/src/main/localDb/ipc/__tests__/botCanonicalSession.test.ts`：只在联合树移除原手写 schema/账本 fixture 初始化，改接上述 helper；重开和双连接保留生产 CJK/SQLite 连接初始化。
3. 本交接文档。

初始化先把固定实际 SQL/companion 文件的完整链运行至 0151，断言账本尚不存在，再关闭为只读模板来源。每个隔离用例复制该真实文件数据库，由 runner 执行正式 `0152_far_nekra.sql`，断言 currentVersion=151、applied 仅含 152、finalVersion=152 且 migration_history 含 152。没有手工 CREATE 账本、同步 Drizzle schema 或用 fixture SQL 替代迁移。

模板复用只降低重复回放 0000..0151 的开销；每个用例的 0152 都真实执行。所有文件均在原 fixture 已有的临时根中，目标路径经过边界校验，清理由原套件管理。文件关闭重开及两个连接都打开真实磁盘库。

## 实际入口及观测

沿用 `seedPair/createDelegationRuntime/settleChild`，调用真实公开服务方法 `messageSessionTask`，经过正式 caller/task/group 授权、生产 `botDelegationService`、实际具名 SQLite dispatcher、`bots.followupRequest` handler 与 reopen core。没有替代服务或新工作项。

宿主 dispatch/provider/群网络发送仍为原受控回调；这不是完整 Main MCP transport、发送队列或 native worker RPC 的生产接线验收。SQLite dispatcher 本身为真实实现，但在测试进程内调用；独立 native worker 注册仍由 I1 验证。

用例通过 dispatch 次数、稳定 inputId、实际原回执、child/runSequence、账本与 SQLite 行变化观察结果，覆盖：

- 原六红例：运行中/终态/服务重建重放、同 key 异正文、未知 ACK、旧 reopen ABA；K2 同正文作为新请求。
- 文件库关闭重开和同 bot 的新 parent/routine lane，trim 等价及重开后异正文冲突。
- 两服务实例/两文件连接同 K 争用；事务插入失败使 reopen、parent、账本整体零写；新请求过时代次不补最新值。
- 群读取前/读取后撤权，已知重放不新增 started/result 回执。
- 暂停及等待授权不被普通 message 批准；明确拒绝后的无 key 旧重试行为。
- 原生 ACK 丢失后，独立账本保留；旧快照丢 inputId 时仍不回退新 start ID；派发未确认返回 unknown 而非 queued success。

没有修改上述行为断言来迎合迁移。初始化适配首次运行即 23/23，通过后未重跑无变化的 716 全套或数据作者已独立通过的 34 项及 db:validate。实际命令与输出留在 `artifacts/task-followup-joint/joint-tests.txt`：

```text
pnpm --filter desktop exec vitest run src/main/localDb/ipc/__tests__/botCanonicalSession.test.ts -t 'terminal follow-up idempotency|persistent follow-up admission|retains a rejected keyed supplement|waits for a queued follow-up|does not rebind an idempotent supplement|refuses continuation of a|rejects group task reopening revoked'
```

结果：23 passed、654 skipped、总计 44.04s，执行 6.70s（其中包含真实迁移与磁盘 I/O），收集 36.53s。新增测试价值为生产迁移生成的约束/默认值/触发器与原服务时序的联合可观察差异；普通手写 fixture 已通过，不能替代这一层。沿原大 DB 套件运行，不新增真实等待/resetModules，不扩大 timeout。

## 交付与未覆盖

联合专用 patch 以冻结消费者测试为 before，仅包含初始化适配、新 helper 和本交接，不携带生产/schema/迁移覆盖。50 项装配输入另列 manifest，供唯一集成者逐项核验。最终类型/文档/测试规范检查、patch 和源码 before/after hash 见 `artifacts/task-followup-joint/delivery-manifest.json`。

本次未发现生产实现缺陷；未修改任何冻结生产字节。没有宣称两个 OS 进程、真实 Desktop 重启/owner 切换、真实群、provider 网络消费、完整 G3 来源消息验证或 I1 native worker 注册已通过。unknown 仍保留固定请求供确切证据对账，不自动重派或推断消费。作者自查不等于独立验收。
