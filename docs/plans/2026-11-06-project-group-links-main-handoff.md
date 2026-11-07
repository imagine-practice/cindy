# 群—项目关联 main 协调片 C

本片提供本机关系的授权协调核心。没有注册 IPC、工具、dispatcher、preload、provider 或 UI；没有群发送、关联服务器写入、执行、模型调用。基线为 `1b18485d193812fa0a91a59939b0ab2aa2149707`，独立分支 `cindy/project-group-link-main`。没有提交、推送或合并。

## 固定依赖与写域

- 本机最小合同：`2026-11-06-群项目关联持久化最小合同.md`，SHA256 `F845E00D0B0B06CD621871C74749BEEB38FCC0DF10ACB776E027CA93320CE0B1`。
- B manifest：`2632A797576A4B9861C86BA950C87BDF9AFC658DD913A93969C9B463C83B6301`。先合并 inheritedInputs 与 outputs 的路径白名单，outputs 覆盖同路径旧指纹，得到 **30** 份本地支持输入。保留 B 的 0150 链，没有从 resolver 复制旧 schema、journal 或迁移。
- A manifest：`C608FC2D5DD984D8907AE8EF3F759A3A5409557502CC25471AC932B3C94C9B8B`。只读组合其中五文件；原生认证适配的实现和测试字节不变。
- G2-C 的 `entityProjectAuthority.ts` 只从 resolver r2 固定输入消费：`0D6C9394147BBA134E74FB384BF8D547ABC4DF2638D746BC8D5E807C5C7C30AF`。其来源 manifest 为 `0AEDAA7350A9313E5416CBE02A3523A515B051C2B8179DF7EC8E9DBECCF3FE0A`。
- 共 **36** 份不可变支持。早期装配曾多带 `ipc/projects.ts`、`shared/projectAccess.ts`、`shared/ipc-errors.ts`；它们不属于本片依赖链，已在核对本片 before/after 后撤销，仅保留原始基线。没有为此扩写事务类型。初始 39 项记录保留为历史；最终输入清单以 revision 2 为准。
- 新实现仅三文件：`apps/desktop/src/main/mcp-integrations/projectGroupLinksCoordinator.ts`、其专用测试、本文。最终外部交付 manifest 列全输入/产物 SHA256；补丁仅包含这三份新文件，应用在上述已核固定输入之上。

## 固定 main-only 签名

模块：`apps/desktop/src/main/mcp-integrations/projectGroupLinksCoordinator.ts`。

```ts
interface ProjectGroupLinksMainRuntime {
  groupService(): Pick<BotGroupChatService, 'groupAuthority'> | null;
  currentDeviceId(): string | null;
}
interface ProjectGroupLinksUiRuntime extends ProjectGroupLinksMainRuntime {
  assertTrustedUi(): void;
}
interface ProjectGroupLinksTaskRuntime
  extends ProjectGroupLinksMainRuntime, EntityProjectRuntime {}

coordinateProjectGroupLinksFromUi(
  raw: unknown, runtime: ProjectGroupLinksUiRuntime,
): Promise<ProjectGroupLinksResponse>;
coordinateProjectGroupLinksFromTask(
  raw: unknown, callerSessionId: string, runtime: ProjectGroupLinksTaskRuntime,
): Promise<ProjectGroupLinksResponse>;
```

唯一公共值协议仍是 B 的 `shared/projectGroupLinks.ts`，SHA256 `76B3F8A1B758A9356430EAFAF28DE3E44493E0B446CCF538273079E7C531EF6D`。没有添加公共身份字段。公共 raw 只接受其严格 parser 的 list/link/unlink；actor、context、grant、canManage、callerSessionId 等额外字段一概拒绝。

运行时、事件守卫、callerSessionId 和 groupService 均由可信 main 装配，不得从请求反序列化。`groupService()` 应返回当前稳定服务实例；换实例或换 authority 使捕获失效。正式生产来源为既有 BotGroupChatService 的 main-only `groupAuthority`；不可用即明确拒绝，没有假造 callerSessionId 或布尔授权的后门。

UI 集成者须先使用真实 `assertTrustedAppRendererEvent` 类守卫，并将捕获事件/窗口的生命周期断言封闭在 `assertTrustedUi` 中，不能提供无条件 no-op。UI actor 仅取当前 DB Data Owner 的 account kind/id。正式任务复用真实 `captureEntityProjectAuthority`，包括输入、来源、群租约和 DB/owner 代次；自主 bot 不回落 account。UI 不伪装成正式任务。

`currentDeviceId` 的正式来源为 `main/device-link/index.ts#getSelfDeviceId`，底层是最近一次 hello-ack 缓存。这里只做当前稳定设备相等检查；非空不能证明在线、当前账号 ACK 或授权。owner、DB epoch、input、群源执行租约与目标群权限分别复验，无新增 Device Link 在线业务门。

## 调用时序及事务接线

1. 公共白名单解析；捕获当前 owner/client 快照、owner key、设备、服务；核真实 UI 或正式任务来源。target 只限当前账号、本机，远端/缺设备不回落同 UUID 本机项目。
2. A `capture`：普通 list 用 `read`；link/unlink 和 includeRemoved 用 `configure`。事实中的 owner、规范化 endpoint、canonical room 必须与本次范围相等。URL 路径大小写保留；输入 URL 不作为网络请求地址。
3. 事务前刷新 core/source lease，再刷新 A；每次用新 A 捕获替换旧捕获。A 自己使旧对象失效，选中 actor/role 变化拒绝；失败不续用旧 grant。
4. main 封闭注入 `{intent, context:{actor,accountId,deviceId,group,now}, newRelationId?}`，仅 link 生成新 UUID。调用 `capturedClient.tx<ProjectGroupLinksResult>('projectGroupLinks.execute', args)`。不传 public actor；真实 B 在 SQLite 同事务精确重验项目 kind/id owner、CAS、幂等账本。
5. 收到成功 ACK 后再次刷新来源/群权限；最终一个 SQLite 查询重验返回项目的成员/owner 与正式 caller 指纹，并重读 mutation 的 current 关系状态。该查询之后只同步核 owner/client/device/input/服务/源租约/目标群生命周期，再返回。历史 `commit` 不改写；并发 unlink 后可返回 `commit=active r1, current=removed r2`。

list 的可见集合、分页和游标由真实 B 先按当前精确项目成员过滤，不返回隐藏总数/过滤数量；includeRemoved 由 A configure 加 B owner 过滤共同约束。最终阶段若返回项目已撤权，整份结果拒绝，不泄漏此前页中元数据。list 页内容以其 B 读取快照为准，不承诺在任意后续并发状态改变后仍是最新页面。

源群租约只由真实正式 caller 取得，卡片或请求中的 endpoint/room 不能代替来源证明；请求 group 是被 A 独立鉴权的目标群。这里不验证某条源消息，不从 thread、房间位置或 requestId 推导“跟进授权”。普通 @/Thread 聊天不经过本核心，不因本地关系缺失而禁用。

注册仍归唯一集成者：需要将具名 `projectGroupLinks.execute` 映射到固定 B 的 `runProjectGroupLinksTransaction`，并补正式入口；本片不改 dispatcher、tx types 或中央 exports。当前只验证可控 dispatch 到真实 B，不声称生产 worker/IPC 已注册。

## 提交状态与错误

所有失败仅 `{ok:false,errorCode,message,commitState}`。固定公共错误码和通用文本，不透传 SQL、标题、路径、服务器响应或堆栈。

- 未调用写事务、显式 `DB_TRANSPORT_NOT_SENT`，或固定 B 精确回滚错误回执：`not-committed`。后者仅匹配完整 `[...] Project group link request rejected`，且只能来自封闭 DB 调用（直接异常或原生 `WORKER_RPC_ERROR`）；不根据调用方参数判定。
- 写 ACK 成功以后任何 owner/群/项目/source 等失败：`committed`，只抑制元数据，绝不宣称远端刷新失败回滚了 SQLite。
- 发出写调用后未知异常、丢 ACK、`DB_TRANSPORT_OUTCOME_UNKNOWN`：`unknown`；unknown transport 标记优先，不被错误文本降为未提交。请求不自动换 requestId，也不自动重发。
- 对账仍提交原 intent/requestId，重新走真实权限交集与 B 账本。旧 link 重放不复活 removed；失去项目或群配置权限后连重放也拒绝。新 request/CAS 才能恢复。

远端权限刷新和本地 SQLite 没有分布式原子性。权限可能在最后一次远端读取与本地提交之间撤销；提交后发现时如实返回 committed。当前本地关系不授予权限，后续读取仍重验；不宣称已经撤销过去合法发出的内容或 URL。

## 实跑证据及限制

专用测试使用真实新 main 导出函数、真实 A `createChatGroupAuthority`、真实 G2-C 来源捕获、真实 B SQLite 事务与生成迁移 0146–0150。数据库只用内存，完整迁移装载一次，各例用隔离事务，无真实等待。

覆盖 UI/普通正式任务/自主 bot 同 id 不同 kind、原生 owned-admin 选择、raw 伪造、无服务与 endpoint/account/device 失配零 tx、read/configure 区别、事务前角色/actor/owner/服务变化、B 原子 owner 转交拒绝、提交后撤群/撤项目/换 owner/client/input/lease/device、丢 ACK 原键对账/撤权后重放、独立 unlink 与 commit/current、真实成员分页、末段 caller/租约/事件失效。设备 getter 仍返回旧同值时授权失效照样拒绝。

HTTP 层是 A captureBoundary 的受控认证 GET 返回，dispatch 是受控 `DbClient.tx` 转真实 B；app owner、UI 事件、设备 getter、turn 和 lease 由 fixture 控制。没有真实服务器 HTTP 往返、原生服务 token 生命周期、worker 进程、用户账号文件、实机设备生命周期或普通 renderer 接线验收；不能用本片测试宣称这些已通过。没有新增群写入或执行入口。

初跑专用 40 项出现五项 fixture/预期错误：转交目标未先加成员两处，A 无可选管理 actor 的错误码预期两处，渠道 scope 结构一处；修正为真实 API 前置条件后通过。补充三项并发/对账/末段 UI 行为后，最终专用 **43/43，3.31 秒**（测试体 413ms）；最终 A22+B19+公共14+C43 联合 **98/98，5.85 秒**。最终源码空值收窄修正后，默认完整 `pnpm --filter desktop typecheck` exit 0，专用源码/测试 ESLint exit 0，`pnpm check:dev-docs` 10/10、`pnpm check:test-hygiene` 通过。36 支持指纹全部匹配。完整输出和命令写入外部最终 manifest/log，不用早期运行替代最终字节证据。未重复已独立通过且字节固定的 B 专门回放/静态迁移检查；C 专用 fixture 另实际执行完整生成链到 0150。

首次完整 typecheck 失败于多余的冻结 projects IPC 缺事务类型四诊断和新文件空值收窄一诊断；已缩减多余支持、显式收窄，不修改受保护类型或用 cast 掩盖。独立依赖安装执行正常 postinstall，未复制 node_modules。macOS 未实跑；路径和临时资源沿既有跨平台工厂，Windows 已实际执行。

剩余依赖：唯一集成者补公共入口/worker dispatch/类型注册和真实 runtime 装配；展示方消费固定公共回执；真实 Chat Server、UI 生命周期及正式 Host 联合验收另做。C 是本地关系 main 协调核心，不是 G1 全链、群关联云同步、引用发送、源消息去重或跟进调度完成。作者自测不等于独立验收。
