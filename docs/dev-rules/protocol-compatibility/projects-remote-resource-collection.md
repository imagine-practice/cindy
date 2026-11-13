# 手机端项目页：`projects` 远程资源集合（2026-11-11，未发布）

> 通用规则见[跨端协议兼容](../protocol-compatibility.md)。

桌面端把本机项目暴露成 device-link 既有的 Remote Resource 集合 `projects`（`resourceKind: 'project'`），
供手机／平板读写。契约正本：`documents/2026-11-11-手机端项目页接口契约.md`（v1）。

- **不新增通道**：沿用 `REMOTE_RESOURCE_CHANNELS` 的 manifest / list / get / invoke 四条；provider 在
  `apps/desktop/src/main/localDb/ipc/projectRemoteResourceProvider.ts`，与 `registerProjectsIpc()` 同批注册进
  `remoteResourceRegistry`。`REMOTE_INVOKE_ALLOWLIST`、allowlist 哈希、`REMOTE_RESOURCE_PROTOCOL_VERSION`（仍为 1）、
  relay 与服务端都不变；自建中转只透传既有 invoke／push，无需同步发布。
- **新端行为**：集合带 `placement: 'home-scope'`（手机首页设备卡按这个位置合并，不新开一级 tab）。列表只含
  当前账号是成员的项目，按 `updated_at` 降序，`limit` 默认 20、上限 50，`nextCursor` 是不透明十进制偏移；
  详情按契约 §3 给五个 block（summary / progress / work-items / members / group-link），每个 block 都带
  `fallbackMarkdown`（按 `client.locale` 写，旧控制器只读它）。写动作有 `project.recordProgress`、
  `project.setAssignee`、`project.archive`、`project.unarchive`；权限与状态判据复用 `requireProjectAction`、
  `mutateProjects`、`workItemProgress.execute`、`projectProgress.read`，不另写一套：非成员 `NOT_PROJECT_MEMBER`，
  普通成员确认完成或归档／恢复 `NOT_PROJECT_OWNER`，进度或绑定代数不一致 `PRECONDITION_FAILED`。
  `remoteResourceRegistry` 的错误码因此新增 `NOT_PROJECT_MEMBER` / `NOT_PROJECT_OWNER` / `PRECONDITION_FAILED`
  （都是既有对外码，控制端旧版本按未知码走通用说明）。
- **旧被控端**（没注册这个集合）：manifest 里没有 `projects`，手机端隐藏入口、不报错（契约 §8 第 1 条）；
  直接对未注册集合发 list／get／invoke 得到 `NOT_FOUND`。
- **旧手机端**：不认识这个集合就忽略；集合与 block 的 primitive 都是开放字符串，未知 primitive 只渲染
  `fallbackMarkdown`。descriptor 里的 `disabled` 与 `confirmation` 只是展示提示，**不是授权**：每次 invoke 都重新
  判当前成员资格与项目状态，手机传来的角色不参与判定。
- **变更通知**（契约 §6「只选一种」）：**只走既有 `maker:remote-resources:changed` 广播**——写动作成功后
  `tapWindowBroadcast` 一次，payload 为 `{ collectionId: 'projects', resourceRefs: [该项目的 ref] }`。这条通道已在
  `PUSH_FORWARD_ALLOWLIST`（`packages/device-link/src/allowlist.ts`）与 `topics.ts` 的 sessions topic 里，手机端
  `DeviceLinkContext` 已在消费并按 `parseRemoteResourceChangedPayload` 重读。invoke 回包的 `effects` 为空、
  **不**内联刷新后的 resource：刷新只由广播驱动，不做第二套机制。不变量是「每个成功回包恰好一条广播」，
  幂等重放与状态未变的 no-op 也发，丢了响应的控制端重试时仍能收敛。
- **投影边界**：任何 block 都不含文件路径、`dir_key`、群 `roomId`、群端点、`chat.cindy.app` 或
  `account:` / `bot:` 前缀原始 id；主体名解析不到时给可读兜底（「某位成员」／「某个群聊」），不把内部 id 当名字。
  关联群块只在既有 `project-group-links:list-project` 读成功且有 active 关联时出现，群名只从本机 `bot_groups` 解析。
- **与契约的三处差异**（已回报契约作者，待其确认是否回写正本）：
  1. `requestId` / `expectedRevision` / `expectedBindingRevision` 在 host 侧是**可选**入参。缺 `requestId` 时按
     「账号 + 动作 + 规范化输入」派生稳定键（老控制器重试仍幂等），缺版本时按当前权威读推导；控制端带了就严格按它判并发。
     原因是契约 §3 的 work-items / progress 数据里没有进度 revision，手机端拿不到可绑定的值。
  2. `work-items` 每个 item 追加 `progressRevision`（契约允许新增字段）；手机要严格绑定进度版本时用它。
  3. `archive` 需要 `input.confirmation === true`（契约 §4 的必填确认）。它是控制端「问过用户」的显式同意位，
     不是授权标记：权限仍由负责人判据决定，没有这个位的归档请求回 `INVALID_PARAMS`（message 带 `CONFIRMATION_REQUIRED`）。
- **回归入口**：`apps/desktop/src/main/localDb/ipc/__tests__/projectRemoteResourceProvider.test.ts`
  （排序／limit／游标、五个 block 形状、禁止字段、负责人／成员／非成员 × 四个动作逐格断言、requestId 幂等与
  并发冲突、跨项目 sessionId 拒绝、未注册集合的旧端行为与四条通道常量）、
  `device-link/__tests__/remoteResourceRegistry.test.ts`、`device-link/__tests__/remoteResourcesIpc.test.ts`、
  `localDb/__tests__/projectProgressIpc.test.ts`。

## 未记录进度的只读展示（2026-11-13）

没有有效进度记录与明确记录 `todo` 分开显示，沿用桌面「未记录」用语。写入仍只有五种
状态，不添加状态、数据行或 migration。为允许两端独立升级：

- 保留 `project-progress.data.counts` 原五档含义（无记录计入 `todo`）和工作项的原 `status`。
  旧手机无需更新即可算全总数。
- 新 Host 追加 `recordedCounts`（只含实际记录的五档计数）、`unrecordedCount`，工作项追加
  `hasProgressRecord: boolean`。统计基于完整有效工作项集合，先统计再截取最多 200 行，
  不从手机收到的部分行反推总数；`sum(recordedCounts) + unrecordedCount = sum(counts)`。
- 新手机仅在两个统计字段均完整、非负整数且逐档与旧字段闭合时使用新统计；字段缺失或
  无效则保留旧显示，不推测「未记录」。任务行只有明确 `hasProgressRecord === false`
  才显示「未记录」，缺省保留原 `status`。`progressRevision` 的并发校验语义不变。
- Markdown 回退同样展示实际记录与「未记录」，其数据不回写。沿用既有五个 block、四条
  Remote Resource 通道和 protocol version 1，不改变授权、通知频率、relay 封包或恢复。
  官方／自建中转均透明转发已有业务 `data` 对象，无需同步改动中转或服务端。

真实 SQLite provider 回归保留旧字段断言并覆盖混合／全未记录／全记录／空集及 201 行截断；
手机投影和页面回归覆盖新字段与旧 Host 缺省路径，不以缓存或补写 `todo` 制造一致。
