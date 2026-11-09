# 项目进度生产读写接线 W2

承接B1、W1和进度只读组件/E1表单。目标是让实际项目页读到同一数据库快照，并通过已存在的进度事务写入。范围只限项目工作进度，不创造业务验收、发布、预算或新的调度机制。

## 共享读取合同

新增 `shared/projectProgressApi.ts`，不能从renderer导入类型到main。UI现有progressProjection的item/history结构是形状参考，允许结构兼容，不重做其算法。

请求：`{projectId:string,beforeEventId?:number}`。projectId非空且≤200字符，cursor必须正安全整数；拒绝actor/role/now等额外字段。未传cursor取最新历史。

返回：`{projectId,items,history,capabilities,historyPage}`。

- items：当前属于项目且未删除的工作项完整集合，每项sessionId/projectId/title/sessionStatus/bindingRevision/progress。progress只有项目、session与绑定代次匹配才返回现行记录，否则null；不能把旧代次完成当当前完成。数据不足保持未知，不从归档、运行退出推done。
- progress使用现有WorkItemProgressRecord。done须确认completionEventId真实存在且与该session/project/代次相同、对应done确认；失配记录不得展示为已完成。不得从当前owner反推历史确认人。
- history：仅请求项目来源下的事件，字段与已冻结ProjectProgressHistoryEntry兼容（eventId/projectId/sessionId/bindingRevision/from/to/actor/createdAt/原因/解除条件/处理说明/完成说明）。不展开或返回before_json/after_json/intent_json等内部原始数据。主体稳定kind/id必须保留；没有可信名称则null，不能伪造姓名。
- 不因任务迁到另一项目而返回其新项目标题/状态。旧事件仍属于原来源项目，读取权限也在原项目校验。删除任务不计当前统计，历史仍可按原项目授权读取。
- capabilities：canRecord、canConfirmDone，来自同一读取事务的成员角色；只是UI提示，写入仍重验。成员可记录，只有当前owner可完成确认；项目归档等现有写禁用规则必须与进度事务真实行为一致，不另加未实现的UI承诺。
- historyPage：`{limit:100,hasMore:boolean,nextBeforeEventId:number|null}`。事件按event_id降序，读取101条判hasMore，响应最多100条；cursor只影响history，不截断items，统计不能按历史页或前100个工作项算。UI显示范围并明确“加载更早记录”，不能冒称全部历史。

## 原子读取与信任边界

R核心函数约定 `readProjectProgressTransaction(db, raw, context)`；context仅含可信actor，独立参数，不从raw取。纯内部请求，不增加renderer SQL通道。函数自包含，以便现有inline worker序列化，与W1保持一致的运行边界。

在同一SQLite读取事务中检查真实成员(kind,id,role)、项目存在，并读取当前工作项、进度和项目历史。不是先await一次鉴权再拼多次不一致的查询。无成员/缺可信主体拒绝且不返回任务名、说明、历史或数量；缺项目与非法输入按既有错误风格处理。不要返回storageRef或材料内容。

main层捕获当前数据owner/DB快照，事务返回后确认仍是同一owner；已变更则丢弃结果。成员变更通知使页面重新读取，FORBIDDEN清掉已失权投影。此规则不承诺擦除用户过去已经看到的内容。

## 接线顺序和唯一写域

1. R只读核心片：新共享类型、新 `worker/opHandlers/projectProgressReadTx.ts`、新专用真实SQLite测试，最多3文件。不改schema/migration、已有进度5文件、IPC、worker注册、UI。先在m4-status原任务的新文件范围完成，接续原子创建核心后执行，不改其他工作树。原目标无进度表的生产接线由I1集成解决；fixture只证明核心，不冒称迁移完成。
2. S桥接片：I1固定后，由唯一集成者登记 `projectProgress.read` 具名事务（文件与inline两条路径），新增受信main入口 `ipc/projectProgress.ts` 并在registerAll注册。preload/renderer声明仅暴露 `localDb.projectProgress.read(request)` 与 `.update(intent)`；update调用已固定 `workItemProgress.execute`，main独立注入actor/now，保留客户端revision与bindingRevision。返回WorkItemProgressResult，不再发明状态格式。新增API需遵守现有来源校验，不将bot身份交renderer声明。
3. S成功写入后复用 `local-db:projects:changed` 作为失效通知，不在广播附带进度说明正文；失败不广播成功。不因为窗口关闭让已提交写入被当成失败；返回未知时同requestId重放规则保持。
4. T页面片：I1集成者或指定UI作者在唯一目标接ProjectDetailPage、读service、现有只读组件与E1表单。分页按cursor去重追加，不倒序串页；切换项目/账号/代次、刷新与迟到响应防护复用已验证材料路由原则。首次加载、空态、错误、无权、刷新、提交结果和冲突要有实际入口。成员信息仅作展示，不能靠页面隐藏按钮替代事务授权。

S/T各自在上一片固定后再派发，不让三位作者同时修改preload/shared/registerAll/ProjectDetailPage。原子创建缺口、材料引用合同与本片分开，不在进度读接口里顺手修它们。

## 最小验收

R真实SQLite：成员/非成员/同ID异种类；当前绑定及旧代次完成；真实确认缺失/错代次时未知；归档不等于done；删除不计当前；未知计入总数；原项目可看旧事件但看不到新项目标题；另一项目事件不混入；101条历史分页无丢重且items不截断；缺身份/额外身份字段/非法cursor拒绝；读操作零写入。

S：真实具名分发和受信IPC，伪造actor/缺代次/撤成员/owner切换/重放；生产生成迁移上的读写往返。T：界面记录todo→doing→blocked→解除→review→有权确认done，刷新重启保留；冲突不自动覆盖；未授权成员不能确认done；320/390、浅深与键盘。分别记录实际证据，不把R单测替代S/T或Electron实测。

不提交、推送、合并或真实用户库操作。交清冻结签名与范围，后续按实际需要做公开工具/群聊/自动化入口接入，不声称它们已随本片存在。
