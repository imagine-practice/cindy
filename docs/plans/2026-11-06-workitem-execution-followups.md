# 工作项执行后续：继续 / 批准 / 排队 / 换模型（规格草案）

2026-11-06。承接「请该伙伴执行」入口（A 方案）。本文件是下一片实现的输入，未实施。

## 1. 现状

- 入口已能向执行伙伴投递一次请求，六态从真实行读取：`none / requested / accepted / running / failed / unknown / completed`。
- 幂等键由 main 生成，落 `messages.client_id`，唯一索引保证同键最多一个回合；只有终态允许新 round。
- 执行工具仍由伙伴在自己回合里调用；renderer 不持有执行授权。

## 2. 本片要做什么

| 动作 | 语义 | 允许条件 |
| --- | --- | --- |
| 继续 | 在当前执行的任务里追加一条输入，沿用原 Session 与历史 | 状态为 `completed` / `failed`；或 `accepted` 后伙伴已暂停等待输入 |
| 批准 | 对伙伴的暂停/待确认请求给出同意 | 存在待确认项，且当前主体仍是有权限的 owner |
| 排队 | 伙伴回合繁忙时，请求进入该任务队列而非新开回合 | 目标任务 `SESSION_RUNNING` 或队列未满 |
| 换模型 | 只改该执行后续回合的模型，不改历史 | 目标存在且允许改模；改模失败必须显示真实原因，不静默降级 |

## 3. 硬约束

1. 全部走既有 owner→伙伴回合通道（`ownerTurnDispatch`），不新造授权、不伪造 caller。
2. 每个动作独立幂等键：`project-workitem-followup:v1:<摘要>:<动作>:<round>`；动作不同则键不同，同一动作重试复用原键。
3. 状态只能来自真实行（`bot_delegations`、`bot_task_followup_requests.phase`、目标 Session 的实际运行状态），刷新重读。
4. `unknown` 一律只对账：不允许继续、批准、排队或换模型，直到对账出确定状态。
5. 换模型必须显式：不因失败自动回退到默认模型，不因账号切换静默换 provider。
6. 批准要有可审计记录：谁批的、批的哪一条、当时的执行状态。

## 4. 验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| F1 | 对 `completed` 状态发"继续" | 同一 Session 追加输入，历史保留，不新开任务 |
| F2 | 对 `unknown` 尝试任意后续动作 | 全部禁用并说明只可对账 |
| F3 | 伙伴回合繁忙时点"排队" | 进入该任务队列，返回排队位置，不新开回合 |
| F4 | 存在待确认项时"批准" | 记录批准人与动作，伙伴收到批准继续 |
| F5 | 换模型成功后发后续 | 仅该回合用新模型，历史消息与模型记录不被改写 |
| F6 | 换模型失败 | 显示真实错误，不静默回退、不重试到别的账号 |
| F7 | 连续点击同一动作 | 只产生一次投递（同键） |
| F8 | 刷新页面 | 状态与按钮可用性来自真实读取 |

## 5. 不做

- 不做批量执行、不做跨项目批量排期。
- 不做自动重试与自动升级重试。
- 不改执行工具契约与伙伴侧调用方式。
- 不碰材料发送、群与自动化写域。

## 6. 实施说明（2026-11-06 片二落地）

四个动作已接入，落点与关键裁决如下，供验收与后续改动对照。

### 6.1 落点

| 层 | 文件 | 作用 |
| --- | --- | --- |
| 线上形状 | `shared/projectWorkItemExecutionRequest.ts` | 动作/不可用原因/投影/意图/回执类型、后续键前缀、文本上限 |
| main 共用读取 | `main/project-execution/context.ts` | 授权守卫、真实行读取、状态分档、两套幂等键的摘要与正则（后续动作与入口同源） |
| main 入口 | `main/project-execution/entry.ts` | 入口投递 + 每个工作项带回后续可用性；注册后续 IPC |
| main 后续 | `main/project-execution/followup.ts` | 四个动作、状态门槛、幂等 round、批准审计、换模型 |
| 宿主窄面 | `main/maker-ipc/ownerTurnDispatch.ts` + `register.ts` 注入 | 复用输入协调器（繁忙/队列位置）、既有 owner 确认解析器、既有 SET_MODEL |

四个动作都作用在**执行会话**（工作项自己的 `sessions` 行，也就是
`bot_delegations.child_session_id`）上：继续/排队只向它追加一条输入（不新开任务、历史保留），
换模型只改它后续回合的路由，批准只解开它当前挂起的待确认项。

### 6.2 幂等键与 round

`project-workitem-followup:v1:<摘要>:<动作>:<round>`。

`<摘要>` 是**意图摘要** `sha256([projectId, sessionId, botId, action, normalizedText])`
前 32 位十六进制。把动作与追加输入一起放进摘要，是「改了内容就是另一个意图」的
结构性保证：同一个 round 里把指令从 A 改成 B 会得到不同的键，因此不会撞上 A 的
clientId 被消息层去重静默吞掉（那会表现为「界面显示已发送、实际发的是旧内容」）。
入口键仍用只看 (项目, 工作项, 伙伴) 的摘要，执行状态对账不受影响。

round 由真实消息行推导（按意图摘要 + 动作）：没有该意图的投递行 → 0；有投递行但目标
会话尚未产出 assistant/tool/thinking/ask_user/plan_review 行（按 `(created_at, rowid)`
严格大于判定，与 `localDb/sessionActiveTurn.ts` 同口径）→ **沿用该 round 与原键**；
上一轮已被消费 → `round + 1` 与新键。于是：同文本连点/重试落回同一个键（只投递一次），
动作不同、内容不同键不同，上一轮真的跑完了才能再追加一次。

防御式兜底：宿主回 `already-active`（该键已有行）时会读回那一行文本与本次意图比对，
不一致（摘要碰撞或别的写入方复用同键）返回 `IDEMPOTENCY_CONFLICT`，界面提示刷新后
重新发起，绝不把新内容显示成已投递。

### 6.3 宿主能力（全部复用，未新造授权）

- `readSessionBusy` / `readQueuedPosition`：读既有输入协调器的实时投影（`turnInProgress`、
  `pendingQueue`）；宿主缺失时回落到 `sessions.active_turn_started_at/last_turn_ended_at`。
- `approveInteraction`：只承认**该会话真实挂起、同种类**的 requestId，再走既有
  `resolvePendingInteraction`（permission → allow；plan_review → allow）；提问
  （ask_user_question）不可「批准」，需要回答。
- `setSessionModel`：走既有 SET_MODEL 语义（同引擎换模型；远程 Agent 会话只登记、
  下次发送生效）。失败只回真实原因，不回退默认模型、不换账号、不重试。

### 6.4 批准审计的落点与缺口

审计（谁批的 / 批的哪一条 / 当时执行状态）追加进该次委派**已有的**
`bot_delegations.permission_snapshot_json` 的 `executionApprovals` 数组（最多 50 条）。
选它的理由：不新开表、不改日志表语义、对模型不可见，且该 JSON 本来就会被
`extendDeadlineSnapshot` 等路径重写，追加一个键不会破坏解析。

**缺口**：这仍是「借位」而不是专用审计结构——它随 `bot_delegations` 行的生命周期存在，
不能跨执行轮次独立查询。真正合适的是追加写审计表（谁/何时/哪条 requestId/当时状态/结果），
那需要新表与迁移，按本片约束**没有新建**，留作后续单独立项。
