# V1 伙伴委派兼容层（冻结 fork，待 V2 迁移后整体删除）

> 状态：**冻结的隔离层**。本层是 dev 侧对上游已删除的「V1 伙伴委派子系统」的保留 fork，
> 仅因我方的**项目工作项执行**仍依赖它而存在。**不要在本层内做新功能或重构**；新工作一律走
> 上游 V2 `send_to_session`。项目工作项执行迁移到 V2 后，本层整体删除。

## 为什么存在

上游在 `cacdb2bc91 refactor(teammate): remove V1 teammate delegation`（及配套的
`19590aed26 remove the V1 workbench and follow-up`、`d6c3af7786 drop teammate-only
permission gates`、`59499152d0 remove the V1 routine engine`、`90d6738a0c hand-offs
report back by asking`）中删除了 V1 委派/工作台/自治子系统，改用 V2 `send_to_session`
开普通任务；`bot_delegations` 表保留但**只读**（`botDelegationHistory.ts` 继续回答
`maker:bot-delegations:list`，"Nothing creates, advances or settles these rows any more"）。

我方本轮刚联调通过并入库的**项目管理**里，「项目工作项执行 / 请伙伴执行」建在 V1 委派写入路径上：

- `projectWorkItemHost.ts` / `projectWorkItemExecution.ts` / `projectWorkItemExecutionService.ts`
  调用 `BotDelegationService.getSessionTask` 与 `adoptProjectWorkItem`；
- tx op `bots.adoptProjectWorkItem` 写 `bot_delegations`；
- 运行期 guard 依赖 `bot_delegations ⋈ sessions` 的 `child_session_id` 绑定。

因此按主人拍板的**桥接方案**：保留 V1 作为隔离层，与上游 V2 共存。`bot_delegations` 的
**唯一写入方是本层**；上游 `botDelegationHistory.ts` 的只读语义不变、不改。

## 保留清单（从 dev 侧恢复的 V1 闭包）

上游删除、本层从 dev 恢复保留的文件（`git checkout dev -- <file>`）：

- 核心：`maker-ipc/botDelegationService.ts`（顶部带 COMPAT 头）、`botDelegationLifecycle.ts`、
  `botDelegationCompletionMessage.ts`、`botDelegationDispatchOutcome.ts`、
  `botSessionTaskRouteBridge.ts`、`botRuntimeRestore.ts`、`botGroupTaskPostSnapshot.ts`、
  `taskCompletionDeliveryHost.ts`、`routines/deliveryDispatch.ts`。
- 自治：`bot-autonomy/*`（botsChangedSignal、builtinRoutine、events、followUpPrompt、follower、
  glance、hostData、hub、ipc、nightlyLearningRoutine、runtime、service、taskWatch 及其 `__tests__`）、
  `maker-host/bot-autonomy-settings-store.ts`。
- 工作台：`maker-ipc/botWorkbench{Access,AutonomyBridge,Legacy,Tools}.ts`。
- 前端/移动端/工具：`renderer/features/bots/{botDelegationLive.ts,BotAutonomySettings.tsx,
  BotFollowUpInvitation.tsx,RemoteBotFollowUpInvitation.tsx}`、
  `mobile/src/session/CompanionFollowUpInvitation.tsx`、`lizi-mcps/src/xdt-helper/bot_workbench.ts`、
  `maker-shared/src/teammateTodo.ts`。
- 上述文件对应的 `__tests__`（botDelegation*、botRuntimeRestore、botSessionTaskRouteBridge、
  botWorkbenchAccess、botAutonomySettings、autonomyRules、followUpPrompt、hub、runtime、taskWatch、
  worktreeSessionTransfer、botGroupTaskPostSnapshot、botWorkbenchTool、teammateTodo）。

## 上游周边适配点（使编译与接线成立）

保留 V1 后，为与上游演进共存所做的最小适配（均带 `COMPAT` 注释）：

1. **权限闸（对应上游 `d6c3af7786` drop permission gates）**：上游从
   `maker-ipc/taskActionAuthorization.ts` 删除了 `approvedTaskDelegation` 与
   `runHostCompletionDelivery`（V1 委派创建证据 / 完成投递隔离），并把 owner/entrusted/autonomous
   principal、risk card 等一并拆除。本层**重新加回**这两个函数与 `DELEGATED_TASK_ACTIONS` 常量，
   直接跑在上游保留的 `actionContext`（AsyncLocalStorage，仍带 `sessionId`/`tool`）之上；对项目工作项
   执行流（tool = `execute_project_work_item`）`approvedTaskDelegation` 按设计返回 `undefined`（项目用
   `captureEntityProjectAuthority` 而非 V1 委派证据），行为最小可用。
2. **IPC 通道去重**：上游 V2 在 `register.ts` 注册了 `maker:bot-delegations:list`
   （→ `listBotDelegationHistory` 只读）与 `maker:bot-delegation:cancel`。本层不再重复注册这两个
   通道的 V1 处理器，避免 Electron "second handler" 冲突；列表读仍走上游只读历史，写入仍走本层。
3. **tx 类型/算子**：`localDb/client/tx/types.ts` 与 `worker/opHandlers/tx.ts` 保留 dev 的 V1 委派
   类型与 `bots.adoptProjectWorkItem` 等算子，同时并入上游新增字段（`inactiveCindyIds` /
   `projectSessionIds`）与新算子。
4. **chatServer 信号**：上游把 bot 档案变更信号从 `bot-autonomy/botsChangedSignal` 迁到
   `botProfilesChangedSignal`。`chatServer.ts` 跟随上游用 `signalBotProfilesChanged`；V1 自治的
   `signalBotAutonomyBotsChanged` 不再由 chatServer 触发（本层冻结、可接受；见下「已知取舍」）。
5. **会话创建/存储**：本地 IPC 复用上游 `createUserSession` 共享创建服务；项目 id 校验、
   目录默认归属与 `persistAuthorizedSession` 原子成员校验保留在共享创建路径。Desktop 适配器
   继续捕获 owner scope 并做提前成员检查；共享服务在异步准备与写入边界复核。
6. **调度器**：`scheduler-host/index.ts`、`runner.ts` 采用上游重构，并把 dev 的项目绑定
   （`validateProjectBinding` 保存期闸 + runner 运行期复核 + 建会话下传 projectId + 拒绝处理）
   重新注入；`maker-scheduler/engine/scheduler.ts` 同时保留 `validateProjectBinding`（dev）与
   `validateModelSelection`（上游）。

## 已知取舍（桥接期）

- chatServer 不再触发 V1 自治的档案变更信号；V1 自治 hub 的该订阅在桥接期为惰性（不影响项目工作项执行）。

## V2 迁移范围备忘录（迁移到 `send_to_session` 时要改的触点）

逐条一句迁移提示：

1. `mcp-integrations/projectWorkItemExecution.ts` — 把 `runtime.delegation()` + `adoptProjectWorkItem`
   换成 V2 `send_to_session` jump 原工作项任务；保持既有 Session、项目绑定、权限档与幂等持久化，不创建替代任务。
2. `maker-ipc/projectWorkItemHost.ts` — `getSessionTask` 读取路径改为读 V2 普通任务；`bot_delegations ⋈
   sessions` 的 guard 改为对新任务绑定的成员/代数复核。
3. `maker-ipc/projectWorkItemExecutionService.ts` — `delegation.adoptProjectWorkItem` 的租约/幂等语义
   迁到 V2 任务创建 + `bot_task_followup_requests` 等价机制。
4. tx op `bots.adoptProjectWorkItem`（`worker/opHandlers/projectWorkItemExecutionTx.ts` + `tx.ts` +
   `tx/types.ts`）— 迁移后删除该算子及其类型；`bot_delegations` 写入停止（与上游只读语义合流）。
5. `maker-ipc/register.ts` — 删除 `createBotDelegationService` / `botDelegationServiceHolder` 实例化与
   全部 V1 接线（ensureCanonicalSession、handleInteraction*、getSessionTask 桥）；项目执行改接 V2。
6. `bot-autonomy/*` 使用点 — 若项目/伙伴仍需后台自治，评估迁到上游现存机制；否则随本层删除。
7. `mobile/src/session/CompanionFollowUpInvitation.tsx` 及桌面 `BotFollowUpInvitation` /
   `RemoteBotFollowUpInvitation` / `BotAutonomySettings` / `botDelegationLive` — 迁到 V2 的跟进/邀请 UI 或删除。
8. `maker-ipc/taskActionAuthorization.ts` 的 `approvedTaskDelegation` / `runHostCompletionDelivery` /
   `DELEGATED_TASK_ACTIONS` — 项目执行不再需要 V1 委派证据后删除。
9. 相关测试 — `botCanonicalSession.test.ts`（V1 段）、`botDelegation*.test.ts`、`botRuntimeRestore.test.ts`、
   `botSessionTaskRouteBridge.test.ts`、`botWorkbenchAccess.test.ts`、`bot-autonomy/__tests__/*`、
   `teammateTodo.test.ts`、`writableDirectoryGrantWiring.test.ts`：随本层删除或改写到 V2。
10. `docs/product-rules/agent-user-parity.md` 的「项目内创建未执行任务」段 — 迁移后更新为 V2 描述。
