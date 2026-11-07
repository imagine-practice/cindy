# 材料正式派发：持久数据片 r3

本片只实现可供正式 main 消费的 SQLite 数据层、元数据映射和共享值合同。没有接队列、消息 writer、Session/provider hook、dispatcher、注册、preload 或 UI；没有调用真实模型、群或用户数据库。它是正式发送的持久层依赖，不是材料发送整链完成。

## 输入、迁移与固定版本

- 独立分支 `cindy/material-dispatch-data`，HEAD 和 fetch 后的 `origin/main` 均为 `1b18485d193812fa0a91a59939b0ab2aa2149707`。
- 输入需求 SHA256 `AAE4E04CCE8D5B959C8DE77E7769B5FCED403AB0CB4C14D9B6DC853F8219E09F`；正式边界说明 `28C1F44BF134CE6B2819E265D0A37D5CDA29D15DF5600A276CDD1091DC798339`。两份全文读取；不是从 I1 取进行中字节。
- 按 B manifest `2632A797576A4B9861C86BA950C87BDF9AFC658DD913A93969C9B463C83B6301` 的输出覆盖旧输入，逐 hash 继承最终 **30** 文件及完整 0146–0150 链。只有 schema、journal、必要 migrationReplay 测试在新树增量修改，其余 **27** 输入保持不变，原 B 树全部 30 输入不写。
- 工具命令 `pnpm --filter desktop db:generate` 生成 `0151_silly_kate_bishop.sql`、对应 snapshot 和 journal 新条目。旧 SQL/companion/snapshot 不变，旧 journal **151 项前缀**不变；没有手改迁移序号或历史。新表不回填旧消息，不改变 SDK metadata。
- 初版共享 SHA256 `F1B4DAC179282DE53A9205C7C35B064735743C405D59EA71E51AAD6959716DCA` 的 PDF 合同不兼容，**不得消费**，完整旧字节另存交付目录作历史。当前 r2 共享值合同为 `54031BDF7851A7739CE05E6FE1E110BE1A4C9C7595126294D45D85AA85385121`。

## 持久位置与关系键

账号隔离沿所属 Data Owner DB，不接受调用方 accountId 来选择数据库。消息稳定键为 `(session_id, client_id)`，不是 contextId、最新 turn 或文件 hash。

| 新表 | 持久内容与不变量 |
| --- | --- |
| `material_dispatch_messages` | session/client 复合主键、current_revision、关联的真实 message_id 和时间。可在消息落库前存在，因而 selector 不只留在会被收窄的 pendingQueue |
| `material_dispatch_revisions` | 同消息 revision 复合主键、项目 ID、严格 selector JSON、真实落库正文序列化 SHA、queued/attached/superseded/cancelled、准备 JSON、创建时间。selector/content/preparation 不倒改；只推进生命周期状态 |
| `material_dispatch_attempts` | 同消息/revision/attempt/consumer 复合主键、真实 turn_generation、vision/provider、preparationKey、实际选入的 reference IDs、实际 consumer payload SHA、开始时 kind/id、pending/confirmed/not-consumed/unknown、最新证据及时间 |
| `material_dispatch_observations` | 同一 attempt 下按 receipt SHA 去重的追加证据。unknown 后对账确认保留两条观察，旧 unknown 不被覆盖成“从未未知” |

内部外键将 revision/attempt/observation 串联；故意不级联到 messages/sessions/materials。物理删除或软状态变化不能倒改已经发生的消费事实；历史读取仍需当前项目成员权限，不借历史恢复执行权。只有 Hash、标识、状态、覆盖和证据；没有原文、PDF 提取文本、base64、源路径、storageRef、URL、函数、凭证或 grant。

## 共享签名与 main-only 操作

`apps/desktop/src/shared/materialDispatch.ts`：

```ts
parseMaterialDispatchSelector(value: unknown): MaterialDispatchSelector | null;
// selector 恰好五字段：
// contextId, projectId, workItemId, bindingRevision, purpose
```

五字段 parser 严格拒绝额外 actor、evidence、preparedBody、grant 等。ID 不截断；普通 ID 最多 200、referenceId 最多 400，代次非负安全整数，purpose 沿用 reference/redecompose/recheck。

`main/localDb/materialDispatchPreparation.ts`：

```ts
materialDispatchPreparationFromItems(
  preparationKey: string, items: readonly MaterialDispatchPreparedSource[],
): MaterialDispatchPreparation;
```

它接受固定真实 `PreparedMaterialItem` 的结构类型，无需 consumer cast。只投影身份、准备状态与证据，正文/附件立即剥离；普通 text 的 textSha256 从实际文本 UTF-8 计算，PDF textSha 与生产者 coverage 校核。已核固定生产者当前 attachment 是 image；未来新表示类型须显式扩合同，不能把新增格式强转成已支持。

`main/localDb/worker/opHandlers/materialDispatchTx.ts`：

```ts
runMaterialDispatchTransaction(db, raw): MaterialDispatchResult;
// raw = { action, key:{sessionId,clientId}, host:{actor:{kind,id},now}, ... }
```

**全部 worker 操作均为封闭 main-only 请求，不是公共 IPC/tool 原样透传。** 即使共享 TS 类型可见，也不构成凭证。main 必须捕获真实 actor、owner/client 代次、来源/租约和实际 Session；worker 同事务重读精确 kind/id 成员、任务绑定和材料引用。

| action | 额外参数 | 返回与规则 |
| --- | --- | --- |
| queue | expectedRevision、selector、contentSha256 | `{revision,replayed}`。首次显式 0；同键同意图重放。同键异意图缺 CAS 则 INTENT_CONFLICT；只允许未落消息的 queued 用当前 revision 显式编辑 |
| read | history? | key/currentRevision/messageId/revisions；history 逐项目按当前 kind/id 成员过滤，无隐藏总数。读取不授权准备/派发 |
| attachMessage | revision、messageId | 核 messages 的实际 session/client/id、user role、未 rewind、原始 `content` 字符串 SHA 相等后关联。重复相同关联幂等 |
| cancel | revision | 未消费可取消，重复幂等；旧准备保留为历史但不能开始。pending/unknown 或 provider confirmed 不伪造取消。vision confirmed 可以保留事实并取消后续未发生的 provider |
| prepare | revision、preparation | 不可变 preparationKey 与全量 items。身份/版本/expectedSha 校对固定 context 和版本行；新 ready/partial 还要当前版本 ready。重复同值幂等，异值 PREPARATION_CONFLICT |
| begin | revision、attemptId、turnGeneration、consumer、preparationKey、referenceIds、payloadSha256 | 在外部副作用前落 pending。新插入才 `{started:true,attempt}`；相同尝试重放始终 started:false。实际代次/attempt 必须由正式生命周期捕获，字段缺失拒绝，不能猜 latest |
| recordOutcome | revision、attemptId、turnGeneration、consumer、evidence | **仅真实宿主证据入口**，返回 `{recorded:true,replayed}`，不返私有 selector/preparation。来源、原 actor kind/id、代次、phase 和尝试必须匹配；观察追加与状态更新同事务 |

新准备/开始须核当前成员、Session 非 deleted、项目与 bindingRevision 完全匹配、context 五字段相等、每个 reference 同作用域且 active、固定 material/version/versionId/SHA 存在。reference 指针补 v2 不使 context v1 漂移；移除引用或解绑再绑定则不能将旧历史当新输入。未带 R1 精确 scope 的旧 context 不自动迁作可派发依据。

错误为固定前缀 `[CODE] Material dispatch request rejected`，不返回 SQL/文件名。有限码：INVALID_PARAMS、FORBIDDEN、SCOPE_MISMATCH、BINDING_CONFLICT、REFERENCE_INVALID、NOT_FOUND、EVIDENCE_CONFLICT、CANCELLED、INTENT_CONFLICT、INTENT_FROZEN、REVISION_CONFLICT、OUTCOME_UNRESOLVED、MESSAGE_MISMATCH、PREPARATION_CONFLICT、NOT_READY、INTERNAL。没有更改中央 IPC 错误枚举或注册。

## PDF 无损证据修订 r2

真实准备来源：`materialExecutionInput.ts` SHA256 `D1B3B06A2704A583803C3EF5DD5D2D076A494385D040210246903C21DEC02F43`、`materialExecutionPdf.ts` SHA256 `826E24C3BA834037ADB26A7F6B9A57C327016FFD80FE49FCA472D38BFBA244D2`，只读核对。

- producer `prepared` 映射 ready，`partial` 保留 partial，unsupported/failed 保留原状态与 failureCode；记录 expectedSha，只有实际准备成功才有 verifiedSha。
- coverage 完整保存 `kind/numPages/pagesInspected/textPages/clipped/completeText/textSha256/textChars/characterLimit/pagesWithoutTextOrNotInspected/visualCoverage`。保留 `visualCoverage:'not-assessed'`，不能写成视觉已查看。
- 没有 coveredPages。页数不是页号，textPages 不代表图像覆盖，计数也不能推导 completeText。截断、无文字页和未检查页不丢失；失败/无文字结果也可保留原 coverage。
- ready/partial 只说明有可准备内容，绝不表示 vision 或 provider 已消费。begin 记录实际引用子集；unsupported/failed 仍在不可变准备记录中，不能选为已派发。不会把 partial 统一标为“全量参考成功”。
- 专用 `.d.ts` fixture 用 TypeScript AST 从上述**实际冻结源声明**提取 `PreparedMaterialItem` 与 PDF 类型；类型检查验证真实类型可直接传映射器，没有消费者断言。运行用例是受控真实类型值，不运行 PDF.js、文件解析或生产者模块，不冒充 PDF 运行时联合验收。

## 正式消息 writer 必须接的原子交接

消息正文 SHA 取最终 `messages.content` **实际 JSON 序列化字符串**，不是编辑框纯文本或另一份格式化 JSON。原 `messages.agent_meta` 属 SDK；本片不读写、不覆盖它。

理想的精确事务边界由唯一消息 writer 装配：

1. 排队时先持久 queue，保留五字段 selector 和 contentSha；queue serialization/recovery 仍由原队列作者接入，不能仅内存保存。
2. 同一个 DB worker、同一个 SQLite 外层事务内：原 writer `INSERT messages` → 本数据函数 `attachMessage`（内部 nested SAVEPOINT）→ 外层 commit。attach 拒绝必须让外层事务抛出，消息与关联一起回滚。本片不另写一个 messages INSERT 入口。
3. 只有这次 commit 的确定 ACK 才允许原入口收窄 pendingQueue。注册/跨进程组合尚未接线，不宣称两个独立 RPC 是原子事务。

若先按兼容两步接线，必须 **先 queue 的确定 ACK → 原 messages 持久化 → attach 的确定 ACK → 收窄 pending**。消息已落、attach 未回时，从相同 session/client 读队列意图并对账实际消息，再幂等 attach；不能从 latest context 猜 selector。此模式明确有跨事务窗口，但已有 durable queue 意图承接恢复；旧消息无该意图不自动追认一份材料依据。

排队未落库时编辑需当前 revision CAS，同时形成新 selector/contentSha revision；旧准备标 superseded 且保留，但不进入新 revision。消息一旦 attached，意图冻结，改正文/selector 须新明确 clientId；否则会把历史用户消息与准备混用。同 context 的不同 clientId 是新请求。重启没有实际 reservation 时须走正式生命周期重新取得真实 reservation；不得拿“最新 turnGeneration”填空，更不得复用一个 pending/unknown attempt 发第二次。

## 消费与恢复证据边界

vision/provider 各自先 begin 成功落 pending，再由 main 重新校验来源/owner/成员/版本并进入真实消费者；末段同步 guard 保持原生语义。main 异步复验与 provider wrapper 的 await hook 接线归后续唯一集成者。

- queued、prepared、onAccepted、Git 准备完成、hook 返回都不产生 confirmed。vision 成功只确认 vision，不确认最终 provider。
- `evidence.source` 仅 session-send-result、vision-result、host-undispatched、reconciliation；outcome 仅 confirmed/not-consumed/unknown；receiptSha 只存正式证据的摘要，不保存响应正文。**这些字段本身不是事实证明**，main 必须核实际被选 provider 的结果语义、真实视觉结果或按原尝试查得的正式证据，不能接受 renderer/工具调用者自报。`SessionSendResult.accepted=true` 单独不足以证明模型消费：若实际 handle 只接收入本地队列，只能保留已知本地阶段事实，provider 仍待确认，不能写 confirmed。只有独立证据证明相应 provider 派发边界已跨过才记“已派发参考”，也不叫理解、业务接受或验收。
- provider 明确拒绝或确证尚未跨消费边界才记 not-consumed；未知不能降格成未发。pending/unknown 阻止所有新的 consumer 尝试；原 attempt 重放 started:false，也不授权再次消费。显式 not-consumed 后的新真实 attempt 仍需重新授权和 reservation。
- provider 已接受但记录失败：外部动作不可回滚，DB 仍留 pending，不标未发。重启只按原 key/attempt/代次查询正式证据；有据才能用 reconciliation 追加确认。没有正式可查询证据时保持待确认/unknown，本数据片不能创造 provider 对账能力。不能删占位、换 clientId/attempt 或重复模型调用来“补记录”。
- unknown 对账可转 confirmed 或 not-consumed，但旧观察仍在 append-only 表；已经确认的终态不改写。confirmed provider 阻止该消息后续 vision/provider 重发。
- 撤成员、移除 reference 或绑定变化后，历史只按当前项目权限读取；新准备/开始拒绝。已发生事实不能伪装没发生：封闭 main 的原消费者可凭匹配原 actor/attempt/代次将**最小终态**写到原捕获 DB，操作不读/返私有材料，也不续执行权，不新增角色。来源绑定是原消费者回调/正式对账证明，不是已失效租约的一次新执行授权。owner/client 外围守卫失效则不得写入另一账号 DB；保留 pending/unknown，回到合法原 owner 环境后对账。

本片不承诺网络/SQLite 原子、exactly-once、真实媒体 pin 或 recycler 生命周期。B 现有材料版本引用和用户原文件规则不变；本片只存元数据，不复制文件。源文件可能变化/删除，main 重开字节仍须 SHA 复核；历史证据不保证字节永久可读。

## 作者验证与未接范围

保留 r2 原 manifest/log 为历史：其专用 **29/29，2.15 秒**、相关数据 **145/145，2.65 秒**、完整迁移回放 **32/32，15.45 秒**、`db:validate` 6/6 是 r2 实跑，不能当作改动后的测试已新跑。r3 专用 **32/32，3.08 秒**已新跑。schema/worker/mapper/shared/迁移及回放源逐 hash 与 r2 相同，本轮不重复完整回放和静态迁移验证；r3 manifest 明确列为带原日志和精确 hash 的沿用证据。数据库只内存/独立临时文件，消费者结果与宿主身份受控，没有真实模型/群/用户库。

新生产代码/专用测试及 schema ESLint 的 r2 通过证据保留；r3 修改后的专用测试 ESLint 已新跑通过。完整 replay 文件仍有继承 B 原有 `no-unsafe-finally` 一处（原群关系临时目录清理），未改该冻结语义来顺手消错。首次回放四失败来自预期序号一处重复/一处漏加，已纠正后完整通过；首次 typecheck 的测试返回联合收窄问题已修正。r3 类型和文档新跑结果以及全产物指纹见外部 r3 manifest/log；r2 原 typecheck/docs/hygiene 日志保留，不冒充 r3 新运行。macOS 未实跑，不用 Windows SQLite 检查冒充跨平台实机验收。

## r3 增量与真实阶段映射

r2 冻结后收到后续合同补充，本次版本只改专用测试与本文；其余九产物和 27 保护输入逐 hash 不变。不是只加 failed-with-coverage：还增加 full-text case（全量文本仍 visualCoverage 未验），加强 clipped case 为所有文字页都已检查但截断，并新增 vision pending 不能凭伪阶段解锁的反例。r2 审计因指纹不一致停止，没有把未跑的协调验收写成通过。

| 已核生产来源／阶段 | 本片允许的记录与缺口 |
| --- | --- |
| 原队列、messages 持久化、prepared、onAccepted、Git/hook 完成 | 仅相应本地生命周期；不写 vision/provider confirmed |
| `maker-core/src/session.ts` dispatchSend 等待 handle.send 后返回 accepted=true | 只说明该 handle 的 send 合同完成，必须追到实际 handle，不能一律解释成远端模型接收 |
| `agents/claude-code/index.ts` send 的 inputQueue.push(sdkInput) 成功后返回 | 已实查该分支是本地 SDK 输入队列接收，不是模型/网络确认；仅这个返回不能用于 provider confirmed。更强的正式派发回执/对账接线仍缺，保持 pending/unknown，不重复发送 |
| `session.ts#bridgedVisionMessage` applied=false 或异常会 passthrough | 到达 beforeProvider、函数返回、fallback note 都不能倒推实际 vision 调用成功；现包装不提供可直接供本账本消费的结构化真实 vision 证据 |
| 真实 vision 请求成功及结果绑定原 attempt/实际 selected payload | main 才可构造 vision-result confirmed；同一消费者的 pending 被真实结果解除，provider 另行 begin/观察，不能混作一枚确认 |
| 确证未发起 vision、或有明确未消费证据后 fallback | 记 vision not-consumed，保持原准备状态；不能为了继续 provider 抬成 vision confirmed。若是否发起/被接收不明则 unknown，只走原键正式对账 |

本片不新增 maker-core hook。后续唯一集成者必须在真实消费者结果点取得证据并保留原生 fallback 语义，不能把 beforeProvider 伪装成该结果点。当前账本的 pending/unknown 保守阻止盲重发，不能据此宣称普通 Session 的既有 fallback 已被本片接好或改变。完整文本与 partial 都需按真实选入内容的 payloadSha256 和 referenceIds 记录，UI 仍须展示 partial；任何 PDF 文本结果都保持 visualCoverage 未评估。

新增/改动 **11 文件**：共享、映射 helper、worker、schema、SQL/snapshot/journal、专用测试、其真实声明 fixture、必要 migrationReplay 测试和本文。27 保护输入不动，B/R1/R2/C 旧固定树不动，未提交/推送/合并。今后 G3 结构需求仅回传方案，不并行抢写本 schema。

后续 main 的最小接线：queue codec 往返五字段 → 同库消息 writer 原子 attach → 捕获真实 reservation → producer revalidate 与本片 prepare → vision/provider 各自 begin/正式观察/恢复对账。中央 dispatcher 与具名事务映射、正式来源守卫、Session await hook、UI partial/unknown 呈现仍未实现。作者自查不等于独立验收；不把数据片测试当成真实发送、媒体或 Host 全链已通过。
