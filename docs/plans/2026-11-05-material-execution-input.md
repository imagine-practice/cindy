# 材料快照到正式输入：准备核心合同与交接

2026-11-05。本片已实现可独立调用的准备核心，没有发送、注册入口或记录模型使用。
基线 `1b18485d193812fa0a91a59939b0ab2aa2149707`；独立工作树 `material-execution-input`。
本片新增 helper、专用测试、本交接三文件。固定支持另列，原冻结树、I1 均不改。

## 固定输入与写域

- 权威输入：主目录 `docs/plans/2026-11-05-material-reference-contract.md`（材料当前引用合同），
  SHA256 `F7BF78CA1001BECB3ED09B69655B48EC5FA2675CD4D973B11B51736E337F5A4E`。
  该未提交文件从主目录读取，不假定各 worktree 都有它。
- 协调 workspace/documents 的 R1 数据片固定回执：
  `2D7DC7D2AC7308704D14C0D1A8ECD0EA7FCE2696C7367E75C1EE7817CE4F77C8`；
  R2 主进程固定回执：`1E39B8BD5B12ED1C12C7E8E599DA8A8C2464F4B1B74A389A3BBE90024BCDB5A6`。
- 只从 `material-reference-data` 按这两份 manifest 取必要白名单：既有 0146–0149 链和元数据、
  R1 schema/materialsTx/projectsTx/shared 材料与项目类型、R2 materialReferenceIo 及其固定 materialSource。
  共 17 文件，逐文件 before/after/hash 在本片 `artifacts/material-execution-input/support-manifest.json`。
  未取 I1 变动字节，未整树覆盖；这些是固定支持输入，不是本片修改数据库或迁移。
- 实现文件：`main/maker-ipc/materialExecutionInput.ts`、同目录专用 `__tests__`、本文件。
  不改 schema、migration、materialsTx、公共 register/provider/preload/UI 或模型核心。

## 已冻结最小调用形状

所有类型和函数从 `apps/desktop/src/main/maker-ipc/materialExecutionInput.ts` 导出，均为 main 专用。

```ts
interface MaterialExecutionRequest {
  contextId: string;
  projectId: string;
  workItemId: string; // sessions.id
  bindingRevision: number; // 调用方明确观察值，不能默认补齐
  purpose: 'reference' | 'redecompose' | 'recheck';
}
interface MaterialExecutionHost {
  client: DbClient;
  actor: { kind: 'account' | 'bot'; id: string };
  assertCurrent(): void;
}
prepareMaterialExecutionInput(raw: unknown, host: MaterialExecutionHost): Promise<MaterialExecutionResult>;
```

请求只允许以上五字段；actor、role、now、路径、任意 refs 或附件描述一律 INVALID_PARAMS。
Host 由 main 在同一来源/账号边界捕获 actor、client，并注入可同步检查 owner generation、DB epoch、
调用来源租约的 assertCurrent。不得从 renderer 选择 actor，也不得从 helperSurface、群名或目录推断权限。
helper 不负责创建来源授权，不默认 account/owner；实际成员查询仍按 kind+id。

结果为以下区分联合；不含 storageRef、源路径、预览 URL 或内部 JSON。结果含实际用户内容，
仅供可信正式发送层消费，不能把整个结果投影给 renderer、日志或公共工具。

```ts
// 每个结果始终 modelDispatch: 'not-dispatched'
{ ok: false, code, modelDispatch }
// 成功表示完成准备检查；readiness 不承诺所有材料都已准备好
{ ok: true, request, context, preparationKey,
  readiness: 'ready' | 'partial' | 'not-prepared', items, modelDispatch,
  revalidate(): Promise<void> }

// items 每项都有 referenceId/materialId/version/versionId/expectedSha256
{ ...selection, status: 'prepared', verifiedSha256,
  content: { kind: 'text', text } | { kind: 'attachment', file: AgentInputSerializedFile } }
{ ...selection, status: 'unsupported' | 'failed', code }
```

`context` 保留 refs 的原 version/readStateAtPin。`expectedSha256` 是版本元数据；只有 prepared 的
`verifiedSha256` 表示实际读取过的字节校验成功。unsupported 不代表正文已读取。
`preparationKey` 是本次固定选择与准备状态的内容指纹，既不是授权凭证，也不是模型派发去重凭证。
空快照为 not-prepared；不得发送一个“准备成功”空内容来冒充材料已用。

## 已实现的读取与权限顺序

1. 按严格请求和可信 Host 构造 R2 `materials.execute/action:listContexts` 当前 Scope；
   真实事务核验成员、目标 sessions.project_id、删除状态及 bindingRevision，定位指定 context。
   不调用 history fallback，不猜旧 context 的项目/代次，不找最新快照替代。
2. 要求 context 与目标项目、session、当前代次和明确 purpose 全部相同。旧/null 代次仅可历史查看。
   refs 必须已有确切 referenceId；缺失不会自动生成引用。
3. 每个 ref 同时经过冻结 R2 `resolveVersion` 的当前引用定位与 context 明确版本定位。
   当前引用必须仍 active、同 Scope/实体；软移除后的历史快照不自动复活成新执行。
   当前关系改选 v2 时，仍可按快照明确读取该实体的 v1，不把关系 currentVersion/latestVersion 当内容版本。
4. 从捕获 client 查询该 materialId/version 的私有行，前后再走真实 resolveVersion，
   比对 versionId、SHA、大小、MIME、存储形态与可读状态。没有目录遍历或 MAX(version) 快路。
5. 文本复用 R2 `readVerifiedMaterialText`：UTF-8 解码的同一 buffer 先过 SHA，沿其 1 MiB 现有预览能力；
   超限/不能解码返回 unsupported，不截断冒充全文。BOM 解码行为沿原 helper，SHA 仍指原始字节。
6. 图片经真实 `blobStore.openBlobFile`，或既有 `readBoundedFileNoFollow`，从同一句柄限量读取，
   校验该实际 buffer 的大小、SHA 和真实 MIME，再保留其 base64。读取边界是版本记录大小，
   没有新增任意产品配额；最终模型/附件上限仍由正式通道执行。
   描述使用已有 AgentInputSerializedFile：path 为空、无 URL、带真实 base64/MIME/大小。
   `buildMakerUserMessage` 因而使用固定 base64，不会稍后重新打开材料源路径。
   PNG/JPEG/WEBP 沿既有 image block；GIF 仍服从既有策略作为 file block，不承诺 inline vision。
7. PDF/Office/其他二进制目前没有本片正文解析器；原 file 通道仅有后续读取路径，
   本片未建立不可变文档交接/生命周期，故明确 UNSUPPORTED_CONTENT，不拿文件名或预览 URL 声称读过正文。
   不新增 OCR、转码、下载或独立模型调用；这是当前实现缺口，不是产品永远不支持的裁决。
8. 内容读取后的逐项 R2 检查保留，最后再用捕获 client 的**单个 SQLite SELECT**同时核对全部引用、
   固定版本元数据/readState、原始 context refs_json、当前任务 Scope/绑定和成员资格。
   最终版本状态与产生实际准备内容的选定版本逐字段比对，不仅比较最早/最晚快照，避免状态往返漏检。
   此最终读取快照内可见的撤成员、绑定变化、引用移除或版本状态变化整次失败，不返回已准备正文。
   SQL 返回后及 prepare 最后返回前保留同步 owner/client/source 检查。
   版本源改变/缺失等字节问题逐项 failed；未知异常只输出 INTERNAL，原错误/路径不外传。

### 2026-11-06 晚移除修订（revision 2）

协调的真实事务反例成立：最后一次 resolveVersion 返回后移除引用，旧末尾 listContexts 不查 active 引用，
仍会把正文作为准备成功返回。单纯再加逐项 await 也不能保证先检查项在后项等待期间保持有效。

修订在读取内容前捕获原始快照依据，在 prepare 和 live revalidate 的最后一步均执行相同单 SQL：
成员 JOIN 约束真实 kind+id/角色，task/context/refs/具体版本 JOIN 与聚合在同一 SQLite 读取快照完成。
版本仅取 refs 的明确 version，不要求当前关系仍选该版，也不遍历最新版本。
随后只有同步比较与 Host 断言，没有再 await 另一轮数据读取。
最终元数据与实际读取内容时捕获的版本比较，包含 readState、SHA、大小、MIME、存储形态/locator 等；
readState 从 failed→ready→failed 的往返不能因初末值相同而放行已准备正文。

事实边界是**最后这个 SQLite 读取快照**以及随后同步 Host 检查；不保证 DB 在快照后不再变化，
更不声称与将来的 provider 网络派发原子。live revalidate 失败会 reject，不返回新的正文或成功回执；
main 必须停止消费先前持有的 prepared 内容，本函数不能撤回已经合法交给调用方的内存字节。
正式发送接线、使用持久化和发送前再次复验仍未实现，不交作正式发送集成已验收。

材料原文、文件名、其中看似 system/授权/派工的指令都是用户附件数据。
本 helper 不构造 system prompt、来源标记、ownerVerified 或宿主授权。purpose 也不触发任何执行。

## 唯一集成者的准确接线点与剩余合同

本片只提供 prepare 与 live `revalidate()`，未触碰以下正式通道：

| 真实入口 | 后续接线用途与边界 |
| --- | --- |
| `maker-ipc/register.ts::prepareUserMessageForAgent(sessionId,message,logPrefix)` | send/steer 共用的 `normalizeUserMessage` 附件归一化及现有持久化保护；继续沿用 |
| `shared/agentInputQueue.ts::buildMakerUserMessage(queued,referenceContexts?)` | 已实测本片图片描述变成真实 base64 image block；文本作为普通 user 内容加入，保持原请求与来源元数据 |
| `maker-ipc/register.ts::sendUserMessageWithAwaitedGitBaseline(session,message,anchorClientId,opts,source?)` | 原字符串直发入口与 Git/来源保护保留；图片不得塞入该字符串参数，走既有结构化正式输入通道 |
| `maker-ipc/register.ts` 的 coordinator `sendToAgent` / `sendToAgentAccepted` | 复用正式 start/send，不直接调用 vendor/裸模型；最终传规范化的 UserMessage |
| `agent-input-coordinator.ts::beforeDispatchUserTurn` / `onAcceptedQueuedMessage` | 真正 drain 时重新准备/复验当前 selector 与 scope，不能用入队时旧检查替代；accepted 仍不是 dispatch |
| `agent-input-coordinator.ts::onDispatchedUserTurn` 对应 register 回调 | send 明确已派发后才写实际引用版本回执；未派发失败/取消不写 used |
| `maker-core/session.ts::SessionSendOptions` / `Session.send` | beforeProviderStart → onAccepted → 视觉桥 → resolveAutoReviewUserIntent → 同步 onDispatching → handle.send；保留原权限、取消、Plan/来源流程 |

必须由唯一集成者补齐的最小项：

- **主进程 selector 与来源接线**：在既有正式输入的白名单边界携带五字段 selector，main 自行捕获
  Host；不能接受工具/renderer 传来的 prepared 附件或 revalidate 函数当作可信准备回执。
  入队持久 selector/原版本回执的共享类型与恢复校验尚未接线，本片没有私塞公共字段。
- **最后异步准备后的材料复验**：只挂 beforeProviderStart 不够，后面还有 onAccepted/Git 基线及视觉桥。
  应在正式 wrapper 所有 Git/持久化准备后、任何视觉模型调用前复验，并在最终 provider 派发前再次复验，
  同步 onDispatching 保留 Host 租约检查。不得覆盖既有 resolveAutoReviewUserIntent 的意图返回。
  现有 task-action 守卫有“落库后不再拦截”的消息投递语义，不能冒充材料读取的逐次权限复验。
  这些 hook 的真实集成/晚撤权回归未实现；本 helper 不保证准备返回到将来发送之间的授权持续有效。
- **使用回执与幂等**：建议真实派发记录绑定 data-owner/sessionId/现有 clientId/turnGeneration，
  内容为 contextId/projectId/bindingRevision/purpose/preparationKey 及实际 prepared 的
  referenceId/materialId/version/versionId/verifiedSha256。unsupported/failed 不记 used。
  同一消息重试沿既有 clientId/派发回执去重，不按 contextId 全局吞掉新的明确消息。
  已有材料 context 没有 used/dispatch 生命周期，本片未修改任何持久字段；后续需显式增量元数据合同。
  onAccepted 只说明落库 hook；只有 `SessionSendResult.accepted === true` 或 coordinator 的真实派发回执
  才可记“已派发参考”，仍不能说模型已理解/验收。未知发送结果先查正式回执，不盲目重发。
- **生命周期**：本片只在内存保留已验文本/base64，不写新媒体、不增加 pin，也没有 durable lease。
  原媒体/版本 pin 沿 R2，实际 recycler/重启恢复未验。本次准备在进程中可用不等于已持久可重放；
  不能把可变原路径塞回结果代替字节。正式消息需沿既有 normalize/持久附件归属、失败补偿与清理流程，
  若要持久队列恢复后原样重放，应补 selector/字节持有/回执的一致合同，不能假装本片已解决。

## 实测与未测

专项：`pnpm --dir apps/desktop exec vitest run src/main/maker-ipc/__tests__/materialExecutionInput.test.ts`。
初版 2026-11-06 实跑 22/22，exit 0，1.96s（用例 286ms），当时完整 Desktop typecheck 通过。
revision 2 保留原 22 项，实跑 27/27，exit 0，1.99s（用例 318ms）；本次 helper/专用测试定向 tsc 再验 exit 0。
`pnpm check:dev-docs` 10/10、`pnpm check:test-hygiene` PASS、`git diff --check` exit 0。
依赖准备执行 `pnpm install --frozen-lockfile --prefer-offline --prod=false`、
`node scripts/ensure-deps.mjs` 与 `node scripts/ensure-dev-runtime-assets.mjs`，均成功。
真实完整冻结迁移至 0149 的内存 SQLite、真实 R1 materialsTx/projectsTx、R2 文本读取和媒体 blobStore，
加实际临时文本/PNG 字节；传输只是显式路由到真实事务的进程内测试适配，不称 worker 已注册。

22 项覆盖：v1 快照与 v2 共存、同名不同内容、实际 PNG 与正式附件 builder、图片损坏后不冒用新字节、
文件改变/丢失、打开后改内容的同 buffer 校验、PDF/Office/解码不支持、伪造身份/路径/refs、跨项目 ID、
同 ID 不同 kind、真实绑定往返、准备期间及字节读取结束后撤权/owner 变换、client 替换、移除当前引用、
purpose、复验钩子、原 refs_json 不变和准备零 DB 写。

新增 5 个表驱动测试覆盖 prepare/live 两阶段的单引用晚移除、多引用前项在后项 await 期间被移除、
晚 readState 变化，以及最终 SQL 回执后的 owner/client/source 失效；另覆盖 readState 往返后与实际内容不符。
晚移除先红（prepare 返回 true、live 未 reject），状态往返也先红，修订后全部通过。
初版 manifest/log 不覆盖；新证据单独位于 `artifacts/material-execution-input/revision-2/`。

模型 dispatch 只设受控 spy 检查零调用，没有加载/发送真实模型。Electron userData、main actor/owner 租约
及命名 transport 受控；临时目录位于 os.tmpdir 并清理，不触碰真实用户库/账号/群。
未测真实 dispatch/队列/视觉桥、使用记录幂等、模型解析质量与 token/缓存表现、真实媒体 pin/recycler/恢复、
双连接并发及跨端。没有任何模型调用或 system prompt 改动；作者自查不等于验收。
