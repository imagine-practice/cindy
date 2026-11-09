# 项目进度事务注册切片 W1

2026-11-05。这是进度纯函数/事务与后续主进程 API 之间的最小执行接线，不包含生产 schema、页面装配或真实账号操作。用户要求按独立写域并行，访问入口片已固定后可执行本片。

## 已核实的实际路径

现有 M1/M2 集成与 m3-access 中：

- `apps/desktop/src/main/localDb/client/tx/types.ts`：DbTxName、请求和结果映射。
- `apps/desktop/src/main/localDb/worker/dispatcher.ts`：tx操作进入opHandlers/tx。
- `apps/desktop/src/main/localDb/worker/opHandlers/tx.ts`：文件worker/进程内命名事务分发。
- `apps/desktop/src/main/localDb/client/WorkerThreadTransport.ts`：旧内嵌worker的函数序列化与独立分发分支。
- 现有projects.execute和materials.execute均在上述类型和两条分发中注册，进度尚未注册。

后续IPC实际注册聚合为 `main/localDb/ipc/registerAll.ts`，preload实际文件为 `src/preload/preload.ts`；本片不修改这些文件，不能假定src/preload.ts存在。

## 冻结执行形状

新增命名事务 `workItemProgress.execute`。

main-only事务请求为 `{intent: WorkItemProgressIntent, context: WorkItemProgressContext}`，结果为WorkItemProgressResult。intent与context严格分开，分发调用已有 `runWorkItemProgressTransaction(db, intent, context)`；不把整个envelope当intent，不把renderer给的字段当context。缺context的请求拒绝，不填默认actor/当前时间。

context只由未来main受信入口构造。新增数据库内部名称不代表向renderer开放context，也不新增通用任意事务桥。进度意图仍必须携带客户端读取到的expectedBindingRevision；分发不能替换为数据库最新值，也不吞并错误为成功。

文件worker与内嵌worker使用同一冻结事务函数及同一请求语义。事务需要的函数必须可独立序列化；不得把进度算法复制到新的switch中。保留原返回的eventId/revision/replayed和错误码。

## 基线与写域

继续原m3-access工作树，先检查状态。保留已冻结访问5文件不变，不改projectsTx、materialsTx、shared/projects、schema、migration、IPC、preload、renderer、locale。

允许把下列3个固定源文件按原字节复制到同相对位置，仅目标不存在时复制；存在且hash不同立即报告，不覆盖：

源目录 `.cindy-worktrees/m4-status/apps/desktop/src/`：

| 文件 | SHA256 |
| --- | --- |
| shared/workItemStatus.ts | F8D04EEC4933DC8CDC111FA6CD96B803772F30B7D2DB72DC62A1E0CA32F27404 |
| shared/workItemProgress.ts | AA74A46DD5739343A2CF72F698A0F321F9FD3A8CEAFDBC476E2C934FF96D68A0 |
| main/localDb/worker/opHandlers/workItemProgressTx.ts | 055603C2A6D42037613089790E60B416DC1E8B0E3A8DE266F7FE27C333729997 |

除此仅修改上述3个注册文件，并新增一个 `main/localDb/__tests__/workItemProgressDispatch.test.ts`。共7个产品/测试文件，交接文档可另加一份。

生产迁移当前由唯一数据作者在project-core-rebase处理，不把旧树0145/0146迁移复制到新树，不提前合并数据片。本片测试若用B1目标结构fixture，必须明确标注，不能冒充生成migration联合回放。

## 必测与交付

1. 通过真实dispatcher调用命名事务，在隔离内存SQLite目标结构上落入真实进度函数并产生记录/事件；不要只spy函数调用而不验证返回结果。
2. 同请求重放保持一个事件；旧绑定代次、无权主体、缺context、intent夹带actor均拒绝且不写入。
3. 旧内嵌worker新增分支与文件worker返回/错误语义一致。优先沿用已有worker测试基础设施；不能只grep到case就宣布运行通过。若无法执行真实worker，分清独立序列化函数执行与完整transport未覆盖。
4. 类型检查新增请求/结果映射；错误不可把私有说明正文泄漏到日志。保留原项目/材料分发，不改写既有行为。
5. 运行定向测试、必要类型/测试卫生/文档检查，报告实际耗时及未覆盖。无需重跑UI或整个事务测试集合。

交固定hash、真实命令输出与生产接线缺项。此片通过后才安排main读/写API、preload和受权限约束的进度查询，以及页面装配；不把命名事务注册当作客户端已可用。未提交、推送或合并。
