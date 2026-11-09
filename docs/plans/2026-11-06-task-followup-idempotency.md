# 原任务跟进幂等：独立修复交接

本片在 `task-followup-idempotency` 实现独立持久账本、事务 CAS 和服务消费接线，基线 `1b18485d193812fa0a91a59939b0ab2aa2149707`。没有改 I1、schema、migration、公共工具、UI 或已冻结消费 hook；未提交、推送、调用模型或操作真实用户库/账号/群。作者自查不等于独立验收。

## 固定数据输入

数据作者输入为 `2026-11-06-task-followup-data-contract.md`（SHA256 `79A91217BC81B5ACE9721AEBC969E9A6AA3C58763E25B1A9DA86BAE57E52AA6D`）以及 `localDb/worker/opHandlers/__tests__/fixtures/botTaskFollowupRequests.sql`（SHA256 `24019CD9D39D6CB2EBFCEF0C918B308DCDFB13838ECAE1836776CE9C91194FFB`）。两者固定后未改变。

`bot_task_followup_requests` 是独立表，主键为 owner 数据库内的 task + 可信 requester bot + keyDigest，不依赖当前 parent/session/run。字段、唯一约束、阶段与时间正本见固定合同/fixture。这里只安装测试目标表；生产 schema、迁移编号、历史迁移回放由数据作者负责。唯一集成者必须先接真实迁移，再启用本消费代码；不能把 fixture 通过当作生产已迁移。

## 文件及接口

生产增量只有以下四处：

- `apps/desktop/src/main/maker-ipc/botDelegationService.ts`：真实 caller/group 重新鉴权、稳定身份生成、重放原回执、正式派发前认领与 native 接收标注、未知结果保留。
- `apps/desktop/src/main/localDb/worker/opHandlers/botFollowupRequestTx.ts`：独立同步 SQLite handler，不创建表；终态 admission 调用现有 reopen core，同事务写账本，任何异常整体回滚。
- `apps/desktop/src/main/localDb/client/tx/types.ts`：Host-only DTO 与具名事务映射；`BotsReopenDelegationArgs.expectedRunSequence` 变为必填。
- `apps/desktop/src/main/localDb/worker/opHandlers/tx.ts`：一个 import、一个 case、reopen 当前代次读取/校验的精确 hunk。语义合入新基线，禁止整文件覆盖。

其余为原 canonical 测试、固定 SQL fixture、固定数据合同和本交接，共八个文件。专用实现签名：

```ts
runBotFollowupRequest(
  db: Database.Database,
  raw: unknown,
  reopen: (args: BotsReopenDelegationArgs) => BotsReopenDelegationResult,
): BotFollowupRequestResult
```

内部 `getDbClient().tx('bots.followupRequest', args)` 支持 `lookup/input/run/admit/claim/accepted/unknown/finish`。精确联合类型见 `BotFollowupRequestArgs`；结果为 missing/changed/conflict 或带持久记录的 request/admitted/claimed。新事务不是公共 IPC/工具参数；不从 raw 接收 actor、input ID、结果或时钟。

## 行为与时序

1. 沿用真实 `findOwnedSessionTask`、caller/task scope、group authority；暂停/取消等待/steer 分支保持既有入口规则。同 key 重放在返回前也重新核验权限，撤权不返回历史成功正文。没有改成 owner 默认身份或新角色。
2. 对 keyed queue/message 使用原 key 的 SHA256；正文仅按现有 `.trim()` 规范化后取 digest。稳定 inputId 使用原 delegation-interjection 前缀及 `[taskId, requesterBotId, rawKey]` 的 digest，无 run 后缀。不是按文本永久去重。
3. 已有 key：同正文返回实际存储的原公开 result；异正文 `IDEMPOTENCY_CONFLICT`；未确认结果返回 `FOLLOWUP_PENDING` 或 `FOLLOWUP_OUTCOME_UNKNOWN`，零派发。
4. 新 key：保留首次捕获的 expectedRunSequence，不在异步准备后补最新值。terminal admission 在同一事务中复核当前代次、原 child/可用状态并 reopen 原任务、登记账本；active 只登记原插话/队列输入。不调用 startSessionTask，不生成新 child。
5. worker CAS 从 admitted 认领 dispatching；同时复核当前 run、child、活动状态、暂停与授权等待。两服务实例/两连接同 K 只能一方认领。同 key 旧成功重放依据账本，不错误地要求旧 admitted run 等于当前 run。
6. 原 `dispatchTrackedInput` / `attemptDispatch` 使用固定 inputId；已有 native `onAccepted` 注明接收时间。结果由实际 dispatch 回执生成并保存，terminal 也返回对应 queuedMessageId。明确未确认的 dispatch 不能伪装为 queued success。
7. ACK 丢失保留 unknown（或崩溃留下 dispatching），不删除记录、换 ID 或走普通合成 resume 消息重发。恢复查询与重放能返回明确未知；本片不自动猜测 provider 是否消费，也不承诺自动完成这种不确定请求。后续人工/宿主对账需要确切 provider/queue 证据，不能把 user 消息落盘当已消费。

永久账本不放 permission snapshot。本轮 `taskInput.inputId` 只是 terminal run 的执行指针；请求身份、原回执及阶段仍只在独立表。账本不随 nextPlan、pause、终态、restore、旧快照替换清空。仍按现有 owner DB 与每个工作项串行，不限制同伙伴在不同任务并发。

无 key 路径保留旧发送/队列/明确拒绝后的重试行为，仅给 reopen 增加代次 CAS。带 key 的历史“拒绝后换内部 retry ID”断言已按本次固定合同改为重放原失败回执；另有 no-key 回归保留旧行为。原队列用例不再写死旧 ID 字面量，改为核对持久账本与实际派发使用同一个 inputId，仍检查指令正文、原生队列完成边界和父任务只留摘要。

## 实证与边界

旧失败日志和旧 manifest/patch 原样留在 `artifacts/task-followup-idempotency/`。旧交接保存在 `handoff.before-repair.md`，其中 snapshot 账本建议已被协调裁定取代。初始 6 红例现已转绿：运行/完成/服务重建重放、旧 key 换正文、未知 ACK、terminal ABA；K2 同正文仍是新意图。

新增边界用例沿用原真实 SQLite / 正式委派服务 fixture，覆盖：文件数据库关闭后重新打开、同 bot 的新 parent/routine lane、两个服务实例通过两个文件连接争用同 K、真实 INSERT 触发失败回滚 reopen/parent/ledger、过时代次新 key 零写、群撤权前后读取、重放不新增群 started/result 回执、暂停/权限等待不批准、未知回执重建服务后固定 input 保留。群发送和 provider 是受控回调，未进行网络群发或真实模型调用。

双实例测试证明两个服务对象与两个 SQLite 连接的原子认领；没有启动两个 OS 进程。文件重开证明磁盘持久，不替代真实 Desktop 重启、生产迁移、跨端或完整 G3 来源事件核验。native_accepted_at 不是 provider 消费证明；本片不记录 used，不声称 provider 网络与 SQLite 原子。

最终命令、实测时长、before/after hash、补丁与日志 hash 以 `artifacts/task-followup-idempotency/repair-delivery-manifest.json` 为准。测试价值：旧覆盖从 active 补充开始，缺 terminal key 和 ABA；本片经真实服务/事务入口观察 dispatch、child/run、原回执、消息及群回执，未读生产源码作断言，也没有新增真实等待或 resetModules。原大 fixture 收集耗时高于 5 秒，新增专项执行本身约 1 秒；未扩大 timeout。

## 唯一集成者接入顺序

数据作者按固定合同生成 schema/migration并验证回放；随后语义合入四个生产增量与测试。同步所有内部 reopen 调用传首次捕获的 expectedRunSequence；新 reader/handler 表缺失时不应提前启用此代码。保持 main 正式 caller/group/taskAction 授权与队列保护，公开工具 schema 不增加身份或结果字段。最后在 I1 真迁移和正式发送保护下复跑原红例、重启及来源权限集成。G3 群引用/来源消息核验/并行冲突调度仍未由本片完成。
