# G2-A 只读实体工具模块交接

2026-11-05。本片只实现模块与专用 registry 测试；公共 MCP server、宿主回调、能力索引和跨端访问尚未接线。没有写工具、模型启动、群操作或真实数据库测试。

## 固定输入与回调

导出 `registerEntityProjectTools(registry, { getSessionContext, callbacks })`。
`getSessionContext(): LiziMcpSessionContext | undefined` 必须是宿主当前调用上下文，不得用参数或服务器启动时的默认身份补位。缺少 sessionId 拒绝；SSH 与带 orcaRemoteLead 的远端执行明确不支持，不改投本机。

回调均返回 `Promise<ControlResult<T, string>>`，成功为 `{ ok: true, ...T }`，拒绝为 `{ ok: false, errorCode, message }`：

| 回调参数 | 成功 T | 真实服务依据 |
| --- | --- | --- |
| `list({ callerSessionId: string })` | `{ projects: EntityProject[] }` | I1 `listProjects(actor, client)` 返回完整数组；不虚构 offset/total/nextCursor |
| `detail({ callerSessionId: string, projectId: string })` | `EntityProjectDetail`：`{ project, workItems }` | I1 `readProjectDetail(projectId, actor, client)`；status 仍是存储状态 |
| `progress({ callerSessionId: string, projectId: string, beforeEventId?: number })` | `EntityProjectProgress`：`{ projectId, items, history, capabilities, historyPage }` | 冻结 R `ProjectProgressReadResult`；历史每页最多 100，items 完整且保留绑定代次、null 进度及实际能力提示 |

以上导出类型由模块的显式公有响应 schema 推导，与 I1/R 结构对应；未跨包 import Desktop 文件。不可直接把宽泛 DB 行当作 wire 合同。成功回执逐层投影，只保留定义字段，不扩散 storageRef、目录、内部 JSON 或额外身份资料。宿主拒绝代码和已脱敏 message 按既有 errorPayload 保留，模块不把服务拒绝改成空成功。

工具为 `list_project_entities({})`、`get_project_entity({ project_id })`、`get_project_progress({ project_id, before_event_id? })`，属于 control 类别。registry 的 strictObject 拒绝 actor/role/now、callerSessionId、device、project_path 等额外参数；明显目录或带设备前缀的 ID 不当作本机实体 ID。旧 list_projects/create_project/send_to_session/get_current_session_id 完全不改。

## 唯一集成者的最小接线

1. 在 `lizi_xdtHelperMcpServer.ts` 按既有 projectManagement 模式新增可选 callbacks 依赖及模块注册，不改旧目录工具的参数或默认行为；按现有包类型出口需要补导出。本片未修改这些公共文件。
2. main 从真实 callerSessionId／当前执行解析可信 kind/id 和账号、DB 快照，再调用 I1 项目读取与冻结 R 服务；群来源继续核验真实群执行授权。不能把 sessionId 本身当 actorId，不能因工具来自群而套用主人身份或扩宽工具档。
3. main 在异步读取后再次核对 owner/DB 仍相同，服务负责最终成员检查、完成证据与绑定代次。转译已知错误为 ControlResult，拒绝提示不得带私有项目正文或原始 SQL。模块的响应字段投影不是鉴权替代品。
4. 同次更新 list_tools 类别说明、get_capabilities 同权索引及 agent-user-parity 台账，说明实体查询与目录查询区别、本机范围和远端不可用原因。公共发现接线前不得称工具已可用；新增远端支持需另核能力与设备路由，不可默认降到本机。
5. 复验真实 MCP server 的发现和调用、缺身份／撤权／账号切换及原生群讨论不受抑制；本片 registry→受控 callback 不能替代这些证据。

G0 第 7 节本轮已收敛：引用仅授权解析、不主动公开私有标题；关联管理满足双方既有配置权限；编辑消息不自动重派，新明确消息重新判断。无需重复请求批准，但本只读工具模块也不实施这些群关系或执行动作。同伙伴多无冲突工作项并发规则保持不变。

## 本片验收边界

专用测试通过真实 registry 的 schema、handler 和受控 callback 验证：同名不同实体 ID、禁止目录替代、无可信上下文／远端拒绝、身份字段伪造、服务拒绝、游标合法性、120 个完整 items、嵌套进度记录及隐私字段投影、零写回调。

这里只模拟宿主响应，不证明 SQLite 权限、I1 服务注册、Chat Server、设备互通或跨端同权已完成。不运行 UI 测试，不创建后台任务，不添加未来写动作的占位成功。
