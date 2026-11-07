# 项目进展同步到群（手动，规格）

2026-11-06。方向已由用户确认：**不自动播报**，只提供手动"同步到群"。已实施（见 §6）。

## 1. 已有能力

- `botGroupChatService.sendMessage({ groupId, clientId, text, attachments?, mentions? })`：以当前账号身份向 Cindy 群发一条消息；`clientId` 作为幂等键，重复提交返回已发送的那条。
- `project_group_links`：群与项目的关联关系（含 status/revision，`byProject` 索引）。
- 进度：`work_item_progress` + 事件表；项目进度读取 IPC 已存在（含每项的处理人绑定）。
- `local-db:project-group-links:list-project`：按项目读本机的 active 关联（只读）。

## 2. 要做的动作

在项目详情（或工作项）提供「同步到群」：

1. 只在**该项目已关联的群**里选择目标（按项目一次读，不再按群逐个反查）；没有关联群时提示先去群设置关联。
2. 生成一段**基于真实数据**的摘要：项目名、按状态计数、**每个工作项一行（标题 + 当前状态 + 处理人，未分配写"未分配"）**、阻塞项的原因与解除条件、最近一次进展时间。不得编造未记录的状态或百分比。
3. 发送前二次确认（发到群不可撤回），显示将发送的完整文本。
4. **同一段内容可以重复发送**：每次确认发送生成一枚新的 `sendId`，`clientId = hash(项目 + 文本 + sendId)`；失败/未知重试复用同一枚（不会产生第二条），成功后作废。连点在确认框打开与发送期间都不再响应。
5. 结果如实：已发送 / 已发送过（这一枚已入库）/ 失败原因；不在群里显示"已同步"但实际未发出。

## 3. 硬约束

- **以账号身份发送**，不冒充伙伴、不以伙伴名义发言。
- 摘要只包含该项目内、当前账号有权读取的内容；不包含材料正文、成员名单、凭证。
- 不新增表、不改群发送协议；关联群读取复用 `project_group_links`。
- 不做定时播报、不做自动触发、不做批量同步多群。
- i18n 12 语种同步；`check:i18n` 通过。

## 4. 按项目列群关联（`local-db:project-group-links:list-project`）

- 只读：无 `requestId`、无动作账本、不改 revision；失败一律 `commitState: 'not-committed'`。
- 鉴权口径：当前账号（DB Data Owner）+ 本机设备 + 项目成员资格；事务内同一快照先证成员资格再出行，事务后再用最后一次 SQL 复核（之后无 await）。
- 只返回 `status='active'`、且 `resource_account_id` / `resource_device_id` 等于本次上下文的行；上限 200 行，超过时 `truncated: true`，界面说明"可能不完整"。
- 返回的 group locator 是**记录**而不是授权：发送时群通道自己再鉴权。
- 按群 `list`（群设置用）保持不变，仍需群读取/配置权限与分页。

## 5. 验收

| ID | 操作 | 预期 |
| --- | --- | --- |
| S1 | 项目无关联群 | 入口禁用并说明先去关联 |
| S2 | 有 1 个关联群，点同步 | 显示确认框与将发送文本；确认后群里出现该消息 |
| A1 | 同一段内容隔一会儿再点一次 | 新的 `sendId` → 新的 `clientId`，群里出现第二条（用户决定允许） |
| A2 | 失败/未知结果后点重试 | 复用同一枚 `sendId`，不产生第二条 |
| A3 | 连点按钮 | 确认框只开一次，最多一条消息 |
| S4 | 摘要内容 | 每个工作项一行含状态与处理人（未分配明说），阻塞项附原因与解除条件；无数据时明确写"暂无记录"而不是 0% |
| S5 | 发送失败 | 显示真实原因并保留可重试；不显示成功 |
| S6 | 非项目成员 | 入口不可用（读不到项目即无摘要） |
| C1 | 按项目列关联群 | 只返回该项目本机 active 关联；非成员被拒 |
| S7 | 320 宽与浅深主题 | 可操作、无溢出（本轮未实机目检，见 §6） |

## 6. 实施状态与限制

已实现：`projectProgressSync.ts`（摘要 + sendId）、`ProjectProgressToGroupSection.tsx`（确认/发送/重试）、
`useProjectLinkedGroups.ts` + `projectGroupLinkClient.readProjectGroupLinksByProject`（按项目读，替代原
"按群逐个反查 + 60 秒缓存"的 `projectLinkedGroupsScan.ts`）、主进程 `readProjectGroupLinksByProject`
与 worker `projectGroupLinks.listProject`、`projectProgress.read` 增加处理人字段。

未做：自动播报/定时/批量；跨设备读关联（只读本机记录）；手机端入口；320 宽与双主题实机目检。
风险：`sendId` 只在内存，页面刷新后的重试等于新发送（用户已确认同内容可再发）；群关联读与远端群权限
不是同一个事务，发送仍以群通道的鉴权为准。
