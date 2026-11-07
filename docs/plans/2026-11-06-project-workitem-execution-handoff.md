# 既有项目工作项正式执行：候选交接

独立 `project-workitem-execution-adoption`，base `1b18485d193812fa0a91a59939b0ab2aa2149707`。未改旧冻结树/I1，未提交、推送、操作真实库/账号/群或调用模型。本片是 main/SQLite 可组合候选，不是公共工具、native worker 或 G3 来源编排已上线。

## 输入和产物

输入为已独立通过的 0152 joint 最终 52 路径，原 manifest SHA256 `F32620664370DB846B8C4AB13878303ECFAF5EF424A2E9A40AF727AA53888F50`。另按固定来源核验并继承 `entityProjectAuthority.ts`（`0D6C9394147BBA134E74FB384BF8D547ABC4DF2638D746BC8D5E807C5C7C30AF`）和 `shared/projectAccess.ts`（`51AC8AC2F3A23E39FA35AB61D4D4AC18DDBD011F02B6E89F3F089A6ADD06D94E`），没有读 I1 进行中字节。54 输入逐 hash 装配；其中只在新树修改 botDelegationService/canonical 测试两项，其余保持原字节。原树来源在交付时重新核验。

七个本片产物：

1. `shared/projectWorkItemExecution.ts`：闭合 main-only DTO。
2. `main/maker-ipc/projectWorkItemExecutionService.ts`：可信来源、actor、owner/client/source 代次捕获及事务适配。
3. `main/localDb/worker/opHandlers/projectWorkItemExecutionTx.ts`：独立原子 inspect/admit/verify 核心。
4. `main/maker-ipc/botDelegationService.ts`：正式 adoptProjectWorkItem 入口、仅新入口使用的 native acceptance guard、项目执行恢复/读取/消息防绕过。
5. 原 `botCanonicalSession.test.ts`：复用实际迁移和正式服务 fixture 的有界测试组。
6. 固定短合同 `2026-11-06-project-workitem-execution-contract.md`，SHA256 `437071B630CD6A3A4F61F7D0C183FA4C15C6D5F9802121E742C1323DC2FAE372`。
7. 本交接。

最终 before/after 与 patch 以 `artifacts/project-workitem-execution-adoption/delivery-manifest.json` 为准。补丁以固定 joint 输入为 before，不携带旧 schema/迁移覆盖。

## 准确入口与事务接入

```ts
createProjectWorkItemExecutionService({
  runtime, delegation, transact, now,
}).start({
  intent: 'start', callerSessionId, targetBotId,
  projectId, sessionId, expectedBindingRevision, requestId, objective,
});
```

`runtime` 复用 EntityProjectRuntime 的真实 input/getSession，同时必须提供宿主绑定的 `callerSessionId()` 与现有 coordinator 的 `isExecutionPaused(sessionId)`。调用体 callerSessionId 必须匹配宿主，不可借另一条 Session 的身份；raw actor/time/permission/路径等额外参数拒绝。`captureEntityProjectAuthority` 只解析主体和来源，执行另走正式 resolveCaller/group owner-action/taskAction 权限；来源字段不构成 ownerVerified。

`delegation` 为实际 `createBotDelegationService` 对象。新增方法 `adoptProjectWorkItem(input, host)` 使用真实 caller，要求 requested targetBot 与它一致。其他 Bot 必须由上游路由到目标 Bot 的真实授权执行通道，不冒用它。正式服务必须已有 taskControl、withSessionLock 和带 generation 的 live readCallerPermission；无能力或仅旧版字符串权限快照明确拒绝。锁只保护 admission，进入原生 send 之前释放，避免重入原发送锁。

`transact(capturedClient, request)` 必须由可信 main 用同一个捕获 client 调用新具名操作 `bots.adoptProjectWorkItem`；请求/结果类型为 `ProjectWorkItemExecutionRequest/Result`。中央 tx/types、worker 注册本片按要求未改，因而尚不能通过真实 DbClient 该名字调用。测试注入的是 `runProjectWorkItemExecutionTransaction(realSQLite, request)`，不是假成功接口。

唯一数据/集成作者需添加该名字的类型映射和 worker case，调用独立核心；本片不要求新 schema/table/migration。0152 的 `bot_task_followup_requests` 足够保存首次 admission 与原回执。登记和正式 delegation 插入在一个 SQLite immediate transaction 中完成；核心是此类复用的唯一写入口，不能另开路径绕过同一 child 的查重。已有创建接口仍 INSERT 新 session，无法借它抢占原 session。

## 保持与拒绝口径

- 不写 sessions；保留原 id、title/model/permission、assignee、workdir、binding、parent、历史和活动/归档/删除状态。原生正式输入会按原流程追加消息/turn 事件，这不同于 adapter 改写历史或配置。
- 当前只支持本机 ordinary desktop target，无任何 Bot 私有 lane link；远端/agentDevice 定位不确定明确不支持，不降级本机。
- 源 caller 与目标原权限配置不一致时返回 `PERMISSION_CONFIG_CONFLICT`，不擅自升降权限；配置变更与相应现有授权应走独立正式路径。本片没有新增批准 UI 或写配置。
- SQL 同事务查实际 actor(kind,id) 和 executor Bot-kind 成员、active project、bindingRevision、caller/executor、目标配置及原执行。p→q→p 不接受旧 revision。assignee 不提供权限或执行证据。
- 已有 delegation 只在受信项目读取 guard 下调用原 getSessionTask，返回原执行；不重开、不恢复、不发送补充。新 request 在旧执行上的结果明确 existing=true。
- 同 key 同规范化意图重放原回执；同 key 换意图冲突；unknown 保留固定 input，不换键/ID 或盲目继续。SQLite 与 provider 网络不声称 exactly-once。
- 新首次执行仍走原任务卡、timeout、attemptDispatch、native onAccepted、原生接收回执与 completion 投递。只给这条路径注入项目/成员/绑定/配置/来源校验：native receipt 异步写入后再次校验，最后事务快照返回后只做同步 owner/source/permission-generation 检查，不再追加另一个异步读取。旧路径无 hook 时不新增 await。
- 暂停的原生输入、已有持久队列、运行中目标、目录占用拒绝新 acquisition；不同目录的工作项在同 Bot 下能同时 running；保留既有宿主 maxActiveChildren 配额并在事务内检查，不引入单伙伴串行或新硬编码上限。目录比较复用 workingDirEquals，宿主最终资源锁仍沿原发送路径。

## 重启与后续 G3 必须接线的边界

执行计划中的 `projectWorkItemExecution` 是资源/权限范围标记（project/session/binding/actor/executor），不是请求账本。账本永久保留在独立 0152 表。

旧普通恢复不能在缺失实时项目 guard 时消耗已 admission 的输入；同样，已标记任务的普通 getSessionTask/messageSessionTask 不能仅凭 delegation ID 绕过项目范围。新增 main 入口为读取传入受信 guard；raw 消息/恢复/批准入口明确 `PROJECT_EXECUTION_GUARD_REQUIRED`。暂停/取消等现有停止通道保留，不自动释放暂停。

**因此这还不是完整 G3 跟进上线。** I1/G3 必须在项目范围读取/消息/批准/恢复桥接中提供当前可信来源、项目 ACL 和 binding guard；不能直接把新 delegation ID 丢回未接项目 guard 的旧公共工具并宣称可控。admitted/unknown 在失去来源或重启后可能停留待对账，不会自动补发。原生消费后续异步网络边界还须与既有消费前 hook 联合接线；本片实际验证的是事务 admission 和正式 native onAccepted 应用边界。

## 实证

保留旧路径红例 `before-tests.txt`：请求 `work-item`，正式 startSessionTask 实际创建 `session-2`（1 failed，45.41s）。没有用不存在的接口或假服务制造失败。

测试继续使用 joint 的真实 migrationRunner 完整 0151 模板和每库正式 0152 升级。受控的是 app owner/source/runtime 与 provider/group 网络回调，SQLite、项目事务、admission 核心、正式 delegation 生命周期及结果投递都是真实代码。

覆盖同 id 执行和原历史/config/parent、原结果投递、重放/fileDB 重开、异意图冲突、已有执行只查、同工作项竞争、两个独立锁/两文件连接争用、不同目录同时 running、共享目录冲突、成员/owner/群租约/权限代次在应用前失效、binding ABA、同 ID 不同 kind、暂停/持久队列、归档/删除/private lane/运行冲突、真实触发器失败回滚、unknown 重建和无 guard 恢复拒绝。

实际调度尝试与消费分别观察：fixture 的 started 数组是在 native preparation 阶段记录，不能拿它冒称 provider 已运行；撤权反例用 onAccepted 成功返回后的消费计数确认零消费，同时核对 ledger/native receipt/SQLite 行。没有真实模型或群发送、没有两个 OS 进程/真实登录切换测试。来源事件真实性仍由已独立的 G3 核心及后续编排负责。

最终命令与结果、类型/文档/hygiene、冻结输入复核及补丁 hash 见 manifest。只跑本片与受影响的原跟进集合，不重跑无变化的全部 UI/数据库矩阵。原大 fixture 收集开销另列，未新增真实等待/resetModules 或扩大 timeout。作者自查不等于独立验收。


## 检查记录说明

初始 19 项边界通过后逐步增加真实暂停/队列、独立连接与最后回执写入撤权覆盖。完整两文件回归首轮 740/741 通过；唯一失败是新历史保护用例缺少正式 messages.client_id，已补齐真实约束而非放宽断言。之后只重跑受影响的本片与旧跟进集合，不宣称那一轮完整命令 exit 0。另保留成员角色 SQL 字面量错误的一轮日志；最终修正后的固定字节与回执以 manifest 为准。

性能：沿用户要求复用原大 canonical DB 套件，真实迁移/文件库/CJK/多次权威读取和收集均计时，CPU/类型检查并行时选定集合执行约 5–12 秒、收集约 26–43 秒；没有为达到数字而改成假 service、增 timeout 或添加真实等待。原文件其他 661 项在本片选择中跳过，另有完整回归的历史日志可审阅。作者自查仍不等于验收。

## 本次固定验证回执

最终定向命令：`pnpm --filter desktop exec vitest run src/main/localDb/ipc/__tests__/botCanonicalSession.test.ts -t 'project work-item execution adoption|terminal follow-up idempotency|persistent follow-up admission'`。43 passed / 661 skipped，exit 0，30.76s（测试 5.06s）；日志 `final-verified-tests.txt`。其中新增采用组 27 项，继承跟进组 16 项。原执行绑定旧代次后，即便以新 revision 发新请求，也不能把旧执行重新标为当前项目执行。

最终完整 Desktop 类型检查、`pnpm check:dev-docs`、`pnpm check:test-hygiene` 及 `git diff --check` 的回执在 manifest 中逐项固定。补丁仅包含上列七产物，对照冻结输入生成；继承的 schema/迁移/中央注册均不在本片 patch 内。
