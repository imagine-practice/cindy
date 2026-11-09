# G1-A：群项目引用的共享值对象与编解码交接

2026-11-05。仅共享定位值对象及卡片 build/parse；没有群发送、解析资料、权限授予、数据写入或执行。基线 `1b18485d193812fa0a91a59939b0ab2aa2149707`。输入 G0 文件 `2026-11-05-project-group-agent-integration-g0.md` 的 SHA256 为 `664F64421AAA010F221A720E340B49825E25BC46943EDD05C4F9A04F61FD1A30`。

本片执行已定默认：只分享需授权解析的私有引用；关联管理须同时满足群与项目两侧已有配置权限；消息编辑不自动产生执行，只有新消息的明确跟进才可能形成新意图。群成员与项目成员独立；普通 @、话题与引用回复讨论保持原规则，不受此卡片解析结果误禁。

## 1. 固定共享合同

源码：[projectGroupReference.ts](../../packages/maker-shared/src/projectGroupReference.ts)。独立模块，不改中央 `index.ts`、`botGroupChat.ts` 或 package exports。集成者以后单独追加出口，当前不能声称外部 package 子路径已发布。

```ts
interface ProjectLocator { accountId: string; deviceId: string; projectId: string }
interface WorkItemLocator extends ProjectLocator { sessionId: string; bindingRevision: number }
interface ProjectGroupSource { endpoint: string; roomId: string; threadRootId: string | null }
type ProjectGroupReference = (
  | { kind: 'project'; locator: ProjectLocator }
  | { kind: 'work-item'; locator: WorkItemLocator }
) & { source: ProjectGroupSource };
```

资源账号来自可信认证／目录上下文，不是群 actor ID、名字或 `ownerVerified`。电脑为目录中的 `DeviceView.deviceId: string`（`packages/device-link/src/protocol.ts`），不是设备身份公钥记录 ID；共享既有 `BotGroupProcessRef.deviceId` 也只按字符串读取。此处不猜 UUID、hex 或设备名格式。项目和工作项分别用真实 projectId、sessions.id，目录不作为项目身份。相同 UUID 在不同账号／电脑不相等。

工作项必须显式带观察到的 bindingRevision，非负安全整数；零可表达真实观察到的零，不会为缺字段补零。parser 不能核数据库当前代次：旧 token 仍保留原值，后续目标电脑必须拒绝过期 token。项目定位不能混入 sessionId／bindingRevision。

群来源独立保留 endpoint、roomId、threadRootId；主时间线必须显式 null，话题必须有真实根 ID。它只是声称的分享位置，不含消息版本／作者／执行租约，也不是后续跟进的可信来源事件。

## 2. 精确导出签名与 namespace

```ts
normalizeProjectGroupEndpoint(value: unknown): string | null
parseProjectLocator(value: unknown): ProjectLocator | null
parseWorkItemLocator(value: unknown): WorkItemLocator | null
parseProjectGroupSource(value: unknown): ProjectGroupSource | null
parseProjectGroupReference(value: unknown): ProjectGroupReference | null
buildProjectGroupReferenceCard(reference: ProjectGroupReference): ProjectGroupReferenceCard
readProjectGroupReferenceCard(value: unknown): ProjectGroupReference | null
projectGroupReferenceKey(reference: ProjectGroupReference): string
```

builder/key 对非法 runtime 输入抛 `INVALID_PROJECT_GROUP_REFERENCE`；parser/read 返回 null，调用方明确呈现不可解析，不能转成任务创建／执行。返回值为规范化后的新对象，不修改输入。

卡片采用既有 `{type:'card', namespace, schemaRevision, fallback, data}` 形状，namespace 固定为 `cindy.project-reference`，schemaRevision 固定为数字 1。这只声明本功能 payload 版本，不表示 Chat Server、设备或旧客户端支持。data 为上述 ProjectGroupReference，层层精确字段校验，未知类型／字段／版本拒绝；不携带标题、摘要、正文、附件、路径、storageRef、actor、ownerVerified 或执行动作。

fallback 固定为 `Private reference: authorized resolution required; unavailable on unsupported clients.`，不能传自定义文本，也不拼接任何定位 ID／资料。read 仅接受这个通用 fallback；不能因此宣称能阻止恶意发送者在既有普通文本消息里披露资料，或撤回过去已发出的文本。

| 字段 | 编解码边界 |
| --- | --- |
| accountId、projectId、sessionId | 1–200 UTF-16 字符，原样保留，不截断、不按名字替换 |
| deviceId、roomId、threadRootId | 1–500 UTF-16 字符，无 UUID 假设；主时间线 threadRootId 必须 null |
| ID 文本 | 不接受空白、控制字符；不对 ID 做 trim／大小写归一 |
| endpoint | 输入最多 2048 字符；复用 `parseClientEndpointManifest` 的 chatApiBaseUrl 校验及 trim／去尾斜杠，不 lower-case URL 路径；额外拒绝 query／fragment，避免令牌混入定位 |
| endpoint 协议 | HTTPS 及既有 allowHttp 的隔离 HTTP 身份可表达；不代表获准连接或绕过受信任端点配置。凭据 URL、非 HTTP(S) 拒绝 |
| bindingRevision | 显式非负安全整数，不接受字符串、小数、NaN、无限、缺失 |

`projectGroupReferenceKey` 是规范化 reference 的 JSON 本地相等键，含账号／电脑／实体及群来源／话题／绑定代次，避免串用。它不是消息事件 ID、分享发送 operationId、查询请求 ID、跟进幂等键或权限凭据。分享、查询、跟进必须分别处理，不能拿一枚卡片／相等键兼作执行事件。

## 3. 既有编解码核对与测试证据

已实查 Desktop `chatServerMigration.ts` 的 ChatContentBlock、`chatServer.ts` 的 contentText，以及 Mobile `chatServerClient.ts` 的 chatMessageText：已有通用 card 字段和 text/fallback 投影。现有共享 quote/task/process readers 不会把新 namespace 误认为引用回复、后台任务或工作记录。未修改这些入口。

maker-shared 没有可直接复用的公开通用 ChatContentBlock 序列化器；Desktop 类型及 Mobile 导出投影在应用层，含应用依赖，不引入共享包依赖倒置。单测实际调用新 build/parse、既有 endpoint parser 和既有共享 card readers，并经 JSON 序列化往返。它证明本地字段可往返及未知 namespace 不误识别，不证明真实旧 UI 渲染、服务器持久化／透传或远端 capability。

测试：[projectGroupReference.test.ts](../../packages/maker-shared/src/__tests__/projectGroupReference.test.ts)。覆盖不同实体／同 UUID 不同账号电脑、主群／话题来源、session／bindingRevision 区分、非法和过长输入、未知类型／版本、拒绝资料与伪造 authority 字段、无私有 fallback、既有 reader 未识别新块。

运行命令与最终结果由固定交接回执记录。新测试单独运行 33/33，首轮总耗时 985ms、测试 7ms；没有网络、真实群、用户库、模型或数据库访问。

默认 package build 目前有基线失败：未改动 `botGroupProcess.ts:95` 使用 findLastIndex，但 package tsconfig lib 为 ES2022，产生 TS2550 和 TS7006。只读排除两个新增源码／测试 root 后仍有相同两条诊断。`tsc --noEmit --lib ES2023` 的完整 package 检查通过，仅作为显式配置覆盖验证，不能写成默认 build 通过；本片不改既有 tsconfig 或该模块。

## 4. 下一片唯一写域建议与验收边界

| 责任片 | 独占写域与必须完成的核验 |
| --- | --- |
| G1 数据作者 | 新关联表／migration／worker 事务；真实账号电脑定位、群／项目双侧管理权限、当前 bindingRevision 与撤权原子重验。不在本片预占迁移序号，不复制项目／Session 来冒充关联 |
| G1 展示与读取作者 | Desktop/Mobile/device-link 的引用投影与授权解析；未获权不返回标题、正文、附件地址；账号／电脑／项目／代次变化作废在途结果，未知端明确不可用，普通 @ 讨论保持原规则 |
| 唯一集成者 | maker-shared 的中央 index／botGroupChat／package exports、公共注册／preload、群发送入口和 Chat Server 适配。先核服务器能保存并回读完整卡片，不支持时拒绝新增分享，不能以明文资料 fallback 假装成功 |
| 后续 G3 作者 | 独立可信来源事件／版本、明确跟进意图、持久去重与正式执行接口。分享读取零执行；消息编辑不重派；原执行跟进与无执行时创建分开，未知回执对账，不新增裸模型 scheduler |

本片没有 ACL 实现或 schema／migration，没有群消息发送、服务端操作、注册、UI、工具目录、跟进 scheduler 或 Session 创建。卡片不得作为权限、消息来源核实或主人授权凭据。实际权限、关联管理、过期代次拒绝、异步撤权、三端显示、服务端存储及真实互通仍由后续片验收。作者自查不等于验收；G1-A 不等于 G1 或完整项目管理目标已完成。
