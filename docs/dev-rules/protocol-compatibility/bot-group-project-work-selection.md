# 群项目配置的可选本机能力（2026-11-14，候选）

`localDb.projectGroupLinks.ownerInGroup === true` 声明支持 `policy: 'owner-in-group'`，
列表追加可选 `eligibleProjects`、关系追加 `available` / `linkedOwner` / `workDirKey`。
新 UI 缺该能力时沿旧操作者 owner 合同，不推测负责人资格；旧 UI 在新 Host 上省略 policy，旧字段含义不变。
`set-work` 是新动作，要求该 policy、稳定 requestId、expectedRevision、精确本机 target 和可空 dirKey；
null 只取消工作选择，不删除关联。关联 link/unlink 原回执和原动作键保持；新策略独立键，未知提交只对账、不自动换键重发。
`change` 仍描述关联状态，因此仅切目录时为 unchanged，目录当前值由 workDirKey 与 revision 表达。
Main 认证并复核群配置权与当前项目负责人，worker 同事务重查成员/负责人证据和 CAS；public 不接受授权上下文。

存储通过新 custom0014 追加三个可空列和每个本机群唯一工作选择索引，不改变旧 SQL/hash/history。
升级后旧关联不获新授权、不自动成为工作项目；旧应用的双链 catalog 缺少 custom14，按已有 ledger/manifest 门禁安全拒绝打开，
不能与升级后的库并发写或直接降级。回退须恢复升级前整套数据库及其配对 sidecar 备份。
本能力仅本机 preload/命名事务；未新增 device-link/relay 帧、远程资源或 Chat Server 路由，自建中转无需同步改动，手机旧能力不变。
认证 GET 复用群权限捕获/刷新，每份快照判断所有候选，不按项目逐个发请求、不新增轮询；列表事件刷新沿账号/群/组件生命周期过滤。
