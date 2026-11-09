# 群项目引用：本机授权解析核心交接

2026-11-05。仅正式任务上下文的只读 main resolver，不发送群消息、不写关联、不调度执行。独立工作树基线 `1b18485d193812fa0a91a59939b0ab2aa2149707`，不写 I1／主树或此前固定工作树。

## 固定输入及写域

支持输入是 project-entity-host 的 `artifacts/project-entity-host/delivery-manifest.json`，SHA256 `F831FD335978BF49D5E274CCA01D8150BE331C76A490CDD810EAB44E641D1774`，共 43 文件；另继承固定 G1-A 三文件及 ES2022 兼容两文件。写入前逐项核 source hash 和目标 before／不存在状态，原字节复制，48 文件此后只读。没有从 I1 读取进行中字节，没有生成／改写迁移。

G0 输入 `2026-11-05-project-group-agent-integration-g0.md` SHA256 `664F64421AAA010F221A720E340B49825E25BC46943EDD05C4F9A04F61FD1A30`。旧材料、进度、注册、provider、共享 codec、中央 exports 等导入文件只是依赖输入，不是本片实现或待重复覆盖集成树的产物。

本片新增三文件：[resolver](../../apps/desktop/src/main/mcp-integrations/projectGroupReferenceResolver.ts)、[专用测试](../../apps/desktop/src/main/mcp-integrations/__tests__/projectGroupReferenceResolver.test.ts)、本文。完整输入 manifest、产物 SHA256、有限补丁及验证结果随独立交接回执提供；此前回执不重写。

## 精确接口

```ts
interface ProjectGroupReferenceResolverRuntime extends EntityProjectRuntime {
  currentDeviceId(): string | null;
}
resolveProjectGroupReference(
  reference: ProjectGroupReference,
  callerSessionId: string,
  runtime: ProjectGroupReferenceResolverRuntime,
): Promise<ProjectGroupReferenceResolveResult>
```

`EntityProjectRuntime` 为固定 G2-C 的 input/getSession 合同。callerSessionId 必须来自主进程正式任务调用上下文，runtime 从可信宿主注入，不是 renderer／工具参数／卡片传入值。普通 UI 账号读取需要以后单独做可信适配；不得伪造一个 callerSessionId 复用此入口，也不在本片新增账号默认通行口。

成功仅为 `{ok:true, entity:{kind,locator,title,status}}`。locator 为固定 G1-A 的 ProjectLocator 或 WorkItemLocator；工作项保留原 sessionId/bindingRevision。不会返回 goal、成员表、材料、摘要、目录、storageRef、actor、来源核实标记、执行状态、群投递回执或工具权限。

status 是既有项目／Session 的生命周期状态，不新增工作进度或业务验收判定。

失败仅为 `{ok:false,errorCode,message}`；message 固定为 `Private reference unavailable or access changed.`。errorCode 白名单：`INVALID_REFERENCE`、`HOST_NOT_READY`、`OWNER_SCOPE_CHANGED`、`DEVICE_UNAVAILABLE`、`UNSUPPORTED_CAPABILITY`、`TASK_UNAVAILABLE`、`TASK_ACTION_SOURCE_UNAUTHORIZED`、`TASK_ACTION_AUTHORIZATION_EXPIRED`、`BOT_SESSION_INACTIVE`、`NOT_PROJECT_MEMBER`、`REFERENCE_UNAVAILABLE`、`BINDING_CONFLICT`、`GROUP_AUTHORIZATION_REQUIRED`、`GROUP_AUTHORIZATION_UNAVAILABLE`、`INTERNAL`。未识别异常或错误码归 INTERNAL，SQL／路径／标题／异常正文不离开 main，也不拼入 fallback。

共享 codec 直接引用已固定源码模块，因为 G1-A 的公开 package 子路径／中央 exports 尚未接入。main 静态依赖共享包源码，依赖方向不变；唯一集成者以后追加正式导出并调整 import，不在本片抢写出口。

## 真实账号、电脑与权限收口

资源账号取 `getCurrentDbClientSnapshot().userId`，不从群 actor、名字、目录或卡片推断。捕获 snapshot 对象（含 clientEpoch）及 client，再调用真实 `captureEntityProjectAuthority`。后者核 caller 生命周期／来源、活跃 runtime、已接收输入、owner 代次、当前 DB、kind/id 主体与真实群 owner-action 租约。bot／account 同 ID 不混用，不从 projects.owner_id 字符串补 owner 权限。

设备身份的正式生产来源已实查：`apps/desktop/src/main/device-link/index.ts#getSelfDeviceId()` 只是转交 `client?.getSelfDeviceId()`；底层 `packages/device-link/src/client.ts#getSelfDeviceId()` 返回最近一次 hello-ack 的缓存 ID，未收到过 ACK 时为 null。固定基线的 stopConnection 没有清空 selfDeviceId，停止连接不能据此推导 getter 立即为 null；也不能推导非空值是当前账号的 ACK 或在线证明。它对应目录 `DeviceView.deviceId: string`，不是名字、machine ID 或设备身份公钥记录 ID。后续可信接线可提供 `currentDeviceId: getSelfDeviceId`。

本片只用该值进行稳定设备身份相等判定，不据此授予权限，也不要求网络在线；不注册或启动 Device Link，不使用 renderer 自报 ID。getter 确实没有可用身份（null）才返回 DEVICE_UNAVAILABLE；没有本机同 UUID 兜底。缓存设备身份、当前 owner/client/input 代次、真实群租约是三个独立维度：即使 getter 仍返回旧同值，owner／input／lease 失效仍拒绝。群专线继续复用既有租约校验，不能由缓存设备 ID 补位；这不新增群网络可用性或产品在线限制。

locator.accountId/deviceId 必须精确匹配真实捕获值。不匹配返回 UNSUPPORTED_CAPABILITY，尚未进入项目服务／目标数据查询；当前没有远端路由或跨账号授权解析。caller 验证过程中读取其权限目录不等于查询目标实体。

项目及工作项均先通过 `readProjectDetail(projectId, explicitActor, capturedClient)`；不调用账号默认 wrapper。返回前再 `authority.refresh([projectId])`，并以单条最终 SELECT 在同一 SQLite 读快照里同时核项目成员 kind/id/role、caller 数据库身份指纹、目标 Session 的真实归属／状态／bindingRevision，直接从该快照取最小标题／状态。任务不存在、deleted、归属不符拒绝；绑定代次不相等返回 BINDING_CONFLICT，不改成最新代次。解绑再绑定必须取得新引用；不复制 Session。

caller 指纹只比较真实已授权 caller 的 source/status/远端路由字段及 bot link/profile 生命周期字段，不自行推导另一套 actor 权限。最终查询前后的身份策略仍由固定 G2-C 捕获和 refresh 决定。群专线另从真实 caller 行捕获同一既有 owner-action guard，便于最终异步 DB 读之后同步 assertCurrent，不使用卡片 source 来查租约。

每个异步阶段后、返回前都同步复核 owner/client snapshot、runtime/input、当前设备及捕获的群租约。最终 DB SELECT 是此只读结果的数据授权快照；之后没有异步操作。它不承诺阻止该快照之后的撤权／删除，也不声称跨 SQLite、网络服务端和 UI 天然原子；未来 UI 应在 owner／设备／权限变化时作废正文和在途结果。

## 群来源与执行边界

reference.source.endpoint/roomId/threadRootId 仅为经过 codec 结构校验的声称位置，既不验证源消息存在，也不证明群成员、主人发言、事件版本、消息内容或跟进授权。成功结果甚至不返回这些字段，避免把它们投影成“已核实来源”。真实 group 校验来自调用任务的现有租约；未注册／tools 档／失效租约均不可替代 owner-action。

分享、只读查询、跟进执行仍是三件事。此模块没有 Session 创建、消息写入、群发送、关联落库、进度更新、模型调用或 scheduler。它不挂接普通 @／Thread 聊天判定：解析失败不能作为禁止原生讨论的理由。群—项目关联管理仍需两侧已有配置权限的交集；本片不实现该管理动作。

## 实证与后续依赖

专用测试走真实 G1-A build/read、G2-C authority、项目服务、Inproc DbClient 和固定迁移 SQLite。迁移完整回放一次，每例内存事务隔离。控制的是应用 owner 生命周期、任务 runtime/input、设备 getter、日志／Electron 边界；群／channel guard 使用真实现有注册与校验模块，其服务端 validate 是受控 closure。不是原生 worker-process、真实 Chat Server／设备或生产 Host 验收。

覆盖：最小授权返回与零写；同 UUID 不同账号／电脑和缺设备不回落；非成员与相同 ID 不同 kind；缺成员行不从 owner_id 提权；真实 projectsTx 的 p→q→p 和 p→null→p；目标丢失／删除／跨项目；准备期撤权／解绑／caller 变化；最后快照前成员／绑定／caller 变化；返回前 owner／账号／client epoch／设备／输入／runtime 变化；真实群 owner 租约撤销；非主人 channel；raw actor 等字段和错误正文脱敏。

现有在途失效及群租约用例已补显式断言：owner/input/runtime/client 变化或 lease 失效时，受控设备 getter 仍为原同值，解析仍拒绝且无新增 DB 写入。没有重复另造同义测试；这只证明身份缓存不能替代独立授权，不是实际断网、退出账号、设备重连或缓存清除生命周期的实机测试。

本轮专用 29 项及固定 G2-C 21 项联合 50/50，3.80s 总耗时；最终专用单文件 29/29，3.24s、测试体 222ms。固定 G1-A／兼容片 48/48、Desktop 全量类型检查 exit 0、lint、文档 10/10、测试卫生与 diff 检查通过。首次完整类型检查发现非法字段测试的字面量断言 TS2352，已去掉断言并保留运行期拒绝用例，随后完整复跑通过；生产身份／读取规则未借类型转换绕过。

现有 group authorization 的 validate／拒绝报告 callback 属于宿主既有流程；本片不构造或投递群消息，也不替换该流程。测试没有注册真实网络 validate 或 onDenied 通知，不能将受控 closure 的通过当成真实群验证／投递证据。

后续唯一集成者接公开导出／provider／注册；UI 作者做普通账号可信入口、授权正文生命周期及 Desktop/Mobile/device-link 呈现；数据作者另做群项目关系事务／迁移；正式来源消息核验、跨设备授权和 G3 跟进由对应作者独立完成。真实群服务器保存与 card 支持、远端解析、用户权限与 UI、模型绑定均未验。本片只交本机只读解析核心，作者自查不等于验收，不宣称群关联或跟进已完成。
