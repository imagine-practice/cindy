# 材料随执行输入发送（界面规格草案）

2026-11-06。主进程已有材料分发与消费调度，缺的是让用户把"已固定的材料上下文"带进下一次发送。未实施。

## 1. 已有能力（不要重造）

- 选择器：`shared/materialDispatch.ts` 的 `MaterialDispatchSelector = { contextId, projectId, workItemId, bindingRevision, purpose }`——**发的是上下文快照，不是单个版本号**。
- 入队载荷：`shared/agentInputQueue.ts` 中队列项支持 `materialDispatch: { selector, expectedRevision }`，并带 `materialDispatchRevision`。
- 主进程：`maker-ipc/materialExecutionInput.ts`（准备与校验）、`materialInputAdmission.ts`（准入与准入失败处理），已接入 `register.ts` 发送链与队列恢复。
- 状态机：分发修订 `queued / attached / superseded / cancelled`；消费结果 `pending / confirmed / not-consumed / unknown`。

## 2. 要做的界面

| 位置 | 内容 |
| --- | --- |
| 工作项材料面板 | 每个已固定的上下文显示"随下一轮发送"开关；选中后显示将发送的项目与版本摘要 |
| 发送前 | 发送框上方显示已挂载上下文的 chip（可移除），并提示"仅在本次发送生效" |
| 发送后 | 工作项详情显示该次发送的材料状态：排队中 / 已附上 / 已被替换 / 已取消；消费结果另列 |
| 失败 | 准入失败（如上下文已被移除、版本不可读、绑定代次变化）要明确说出原因并撤销挂载 |

## 3. 硬约束

1. 只用既有 `materialDispatch` 载荷与既有发送通道；**不新增 IPC、不改准入逻辑、不复制准备逻辑到 renderer**。
2. `expectedRevision` 必须来自真实读取的上下文修订；不猜、不硬编码。
3. 一次发送只挂一个上下文；换上下文即替换，不并存。
4. 消费结果 `pending` 不得显示为"已使用"；`unknown` 只提示对账，不自动重发。
5. 上下文被移除或版本不可读时，发送前必须拦下并说明，不允许"先发再报错"。
6. i18n 12 语种同步；`check:i18n` 通过。

## 4. 验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| M1 | 挂上一个上下文后发送 | 消息带 `materialDispatch`，队列项显示该 selector 与修订 |
| M2 | 发送前移除挂载 | 消息不带 dispatch，不会被误发 |
| M3 | 上下文在发送前被移除 | 拦下并说明原因，不产生半成品消息 |
| M4 | 连续两次发送 | 第二次是新的修订；第一次显示"已被替换"而非"失败" |
| M5 | 消费结果为 pending | 显示"等待消费"，不显示"已使用" |
| M6 | 消费结果为 unknown | 只给对账提示，不自动重发 |
| M7 | 刷新页面 | 状态来自真实读取 |

## 5. 不做

- 不做多上下文并行挂载、不做自动选择材料。
- 不做新存储、不改分发表结构。
- 不碰执行后续、群发送与自动化写域。
