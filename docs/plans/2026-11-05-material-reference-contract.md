# 材料当前引用最小合同（R1 已冻结）

2026-11-05。本文只定义下一片；未实现 schema/API，未改变已通过的数据/B1/权限/C1生产代码。
任务即 sessions；下文 workItemId 指 sessions.id。仍按项目去重，移除为软状态，字节存储沿用原材料契约 0.1。
协调于2026-11-05冻结R1。本文是实现依据，不是已上线能力；按独立写域执行。

## 0. 冻结裁定与实现边界

审查输入hash为 `0B33290BA7DA4F409BBC7DD3448D4993A0FD6A35E2B71F5B13535AAC756F209E`。
采用§6的保守迁入规则：代次0且项目/任务仍匹配才作为初始当前引用；其余保留null代次历史，必须明确重新引用。
这是对现有迁移要求的实现裁定，不声称恢复了缺失的历史事实。UI需显示该变化和历史入口，不静默隐藏资料；不迁移真实用户库。

本轮按小片落地：先冻结共享TypeScript类型和关系事务/迁移，再完成main、桥接与UI。
I1装配目标正在写入，关系数据实现必须另建隔离工作树，保留I1及所有旧候选原字节；不得修改正在被集成的来源树。
新增迁移只基于核验后的现有链由Drizzle生成，不能重复覆盖已生成0146–0148或手改编号。
实现期新增问题按具体契约缺口处理；不把本轮扩成新的存储/OCR/模型执行系统。

## 1. 已读现状与取代边界

- 缺口正本：本目录 2026-11-05-material-reference-gap.md，SHA256
  5EDC95681A9B968E39B6E08C5B5D974535D5263C0182B7BD26CF969B22B361C0。
- 数据候选：project-core-rebase 的 schema.ts、shared/materials.ts、materialsTx.ts。
  材料实体只有一个 work_item_id；currentVersion 目前等于实体最大版本，status 也在实体上。
- m3-access/ipc/materials.ts：list/readVersionsForProject 按实体 work_item_id 过滤；
  addMaterials 的 sameName/bySha 命中直接 push duplicates 并 continue，可能整个请求不进入事务。
- m2-materials-ui/features/materials/materialsService.ts：list/add 带 projectId/workItemId；
  remove 只带 materialId；addVersion 只带 materialId/file 并传 replaceCurrentReference=true；
  normalizeMaterial、版本选择、context/preview 尚无引用身份和绑定代次。

本文冻结后，仅取代“当前归属/当前版本/软移除”的真相源。material_versions 内容与版本号不变；
旧 materials.work_item_id/status 保留作迁移来源，停止作为新列表、去重或移除的权威字段。
不能复制材料来绕过去重，不能改旧 work_item_id 抢走原任务归属，也不能把项目全部材料混入各任务。

## 2. 三种对象与关系字段

| 对象 | 权威含义 |
| --- | --- |
| materials + material_versions | 项目内材料实体及不可变版本；最新版本只表示版本目录最大号 |
| material_references（新增） | 某个范围主动持有哪个确切版本，以及该范围的软状态 |
| material_contexts | 创建时明确选择的不可变参考快照；不是当前引用的动态查询 |

material_references 最小字段：

| 字段 | 类型/约束 | 含义 |
| --- | --- | --- |
| id | text pk | referenceId，作用于当前引用，不代替 materialId |
| project_id | text not null | 必须等于材料所属项目 |
| work_item_id | text null | null=项目级资料；非空=工作项引用 |
| binding_revision | integer null | 项目级为 null；新工作项引用必须为非负整数；旧未知代次仅历史保留 null |
| material_id | text not null | 指向同项目实体 |
| version | integer not null | 确切版本，必须存在于该 material，不能用 MAX(version) 代替 |
| status | text not null | active / removed |
| created_by_kind/id | text not null | 可信 main actor；迁入用旧材料记录的主体，不伪造创建人 |
| created_at / updated_at | integer not null | 原始创建及关系最近变更时刻 |

数据库约束：材料版本的复合外键 (material_id,version)；关系所属项目与材料、工作项项目一致性由事务重读。
项目级唯一 (project_id,material_id)，谓词 work_item_id IS NULL（此时 binding_revision 必须为 null）；
工作项唯一 (project_id,work_item_id,binding_revision,material_id)，谓词 work_item_id IS NOT NULL AND binding_revision IS NOT NULL。
旧未知代次另以 (project_id,work_item_id,material_id) 唯一、谓词 work_item_id IS NOT NULL AND binding_revision IS NULL 保留。
唯一键不含 status/version：同一范围重复沿用不插第二行；恢复软移除复用 referenceId。
不建立会随 sessions 删除而级联删历史引用的外键。项目/材料硬删除及生命周期不在本片扩展。

项目级资料和工作项引用是两个独立范围：给 t1 加材料不自动生成项目级引用；t3 沿用不搬走 t1 引用。
项目内可读版本目录仍可按现有项目成员权限明确浏览；这不等于给每个任务添加当前引用。

## 3. 当前范围、固定版本与软移除

Scope = {projectId, workItemId, bindingRevision}，字段均显式传入：
项目级取 {workItemId:null,bindingRevision:null}；工作项取真实 id 和客户端观察的代次。
main 不能用当前代次代填缺失值；事务内核对 sessions.project_id/status/project_binding_revision。
解绑或换项目由既有 bindSession 推进代次，本片不再修改 projectsTx；旧关系原样保留，但不再进入新代次当前列表。

- 当前列表只含本 Scope 的 active 关系；项目级只列项目级资料，工作项只列该任务该代次。
- 关系持有 v1 时，别人创建 v2 不改变该关系的 version、readState、预览或默认送入模型的版本。
  “最新版本”可单独提示，不可赋给 currentVersion 冒充当前引用。
- add 的明确导入/沿用、显式选择已有版本，或带引用身份的 addVersion，才可推进调用范围自己的关系。
  同一关系上的并发明确操作按事务提交顺序生效；本片不新增引用修订号，绑定代次只解决任务重绑，不冒充关系 CAS。
- remove 只设置该 reference.status=removed。实体、版本、其他范围关系、旧 context 与媒体 pin 不变。
  单独补版本不会恢复另一范围已移除关系；恢复本范围必须显式 add。
- 预览、快照及模型材料解析都必须使用关系选定/快照明确选择的版本，不回退最新版本。

## 4. 最小 IPC 增量（原八通道名保留）

以下是新合同完整调用形状；actor、now、生成 id 仍只在 main-only envelope 注入，不来自 renderer。
响应追加 referenceContract:1。客户端必须先从 list 确认此标记及 Scope，再启用新引用写操作；
旧 host 无标记时不尝试新写法。新 host 对缺 Scope/引用身份的旧写请求明确拒绝 REFERENCE_SCOPE_REQUIRED，
不能把旧 materialId-only remove 猜成全项目移除。此为尚未发布的 M1/M2 联调切换，不声称现有跨端协议已兼容；
发布前须对真实调用方（含远端/插件）完成兼容核验，不能用 UI 已更新代替协议验证。

Reference = {id,projectId,workItemId,bindingRevision,materialId,version,status,createdByKind,createdById,createdAt,updatedAt}。
Material 原字段保留；列表的 status/workItemId/currentVersion/readState 改为此条关系的投影，另加 reference；
versions 是同实体版本目录，currentVersion=reference.version，readState 来自该版本。实体最大号另加 latestVersion。
storageRef 继续不投影。没有引用时不能凭实体 work_item_id 合成一条当前引用。

| 通道 | 请求 | 返回及裁定 |
| --- | --- | --- |
| materials:list | 当前：Scope；历史：{projectId,workItemId,history:true}（workItemId 可 null，不带 bindingRevision） | 当前 {referenceContract:1,scope,materials}；历史 {referenceContract:1,projectId,workItemId,history:true,materials}；历史含 removed/旧代次/null代次，绝不算当前；列表行均含 reference 和 latestVersion |
| materials:add | Scope + files:[{name,path,sameNameAction?}]；或 Scope + existing:[{materialId,version}]，两种输入互斥 | 原 {added,duplicates,rejected} 保留，另加 references:Reference[] 和 scope；added 仍为新版本，duplicates 仍含确切 materialId/version/name；references 按成功输入顺序给出已持久关系，含沿用/幂等恢复结果 |
| materials:remove-reference | Scope + {referenceId} | {ok:true,status:'removed',reference,scope,referenceContract:1}；已 removed 可幂等成功；无作用域不猜旧 materialId |
| materials:add-version | Scope + {referenceId,materialId,file,replaceCurrentReference?} | {version,reference,scope,referenceContract:1}；原子追加版本并仅推进此 active 关系；materialId 必须与关系一致。replaceCurrentReference 仍只保留原“同内容也显式占新版本位”语义，不再解释为推进所有引用 |
| material-contexts:create | Scope（必须工作项）+ {purpose,refs:[{referenceId,materialId,version}]} | {context,referenceContract:1}；context 追加 projectId/bindingRevision；新 refs 保存 referenceId，其余字段及 readStateAtPin 不变 |
| material-contexts:list | 当前：Scope；历史：{projectId,workItemId,history:true}，workItemId 必须非空 | 当前 {contexts,scope,referenceContract:1}；历史 {contexts,projectId,workItemId,history:true,referenceContract:1}；历史仅列请求来源项目下该任务的快照，不把旧代次算当前 |
| materials:preview | 当前：Scope+{referenceId,materialId,version}；历史：{contextId,materialId,version}，两种互斥 | 原 {kind,url?,text?,name,mime,size} 保留，追加实际 materialId/version 及 referenceContract:1；不根据新版本改请求 |
| materials:retry-read | 当前同 preview 的引用定位，或历史 context 定位 | 原 {version} + referenceContract:1；只改指定版本可读性，不创建版本、不恢复引用、不改快照 |

existing 是显式沿用/版本选择入口，复用 add 通道，不新增材料实体或字节。可选失败版本也须如实返回 readState，
不能伪装 ready；files 的自动内容去重仅选择当前可读版本。sameNameAction='create-new' 只绕过同名冲突，不能绕过同项目同内容去重。
files 若与多个同名材料冲突，不猜目标补版本；返回 DUPLICATE_CONTENT，界面显示实体/引用身份后显式选择。

context 创建时：每个 referenceId 必须是该 Scope 的 active 引用，且 materialId 一致；version 必须存在于该实体。
允许用户从版本目录显式选旧版/新版建立快照，不要求等于当前引用，但 UI 缺省值必须是 reference.version；
这一选择不倒改当前关系。当前 preview 同样允许该引用实体中显式指定的历史版本，默认仍取 reference.version。
上下文必须保存实际选定版本，模型只读取 context.refs 里的确切版本，不读取随后改变的关系版本。

新 context 在既有表新增 nullable project_id/binding_revision 元数据列；新行必须完整写入，旧行保持 null，
旧 refs_json 与主体/时间逐字节不改。历史 preview 必须验证请求恰在 context.refs 中；
授权按快照来源项目成员资格重读，不按任务今天所属的新项目放行。旧 context 来源项目仅可从其全部 refs
一致推导；空 refs 或无法唯一推导时返回 CONTEXT_SCOPE_UNKNOWN，不披露内容，原记录仍保留。
两种 history 列表只按请求的来源项目鉴权，不要求任务今天仍在原项目，不能返回新项目的任务详情；
旧 context 来源无法判定时不混入任一项目历史，单条读取报 CONTEXT_SCOPE_UNKNOWN。历史关系不支持直接原地恢复为当前，必须 existing add。
context 引用被移除不阻止历史读取；源文件已变/丢失仍按原 SOURCE_CHANGED/SOURCE_MISSING 规则拒绝，不能用新内容冒充旧版。

新增错误：REFERENCE_SCOPE_REQUIRED、REFERENCE_NOT_FOUND、REFERENCE_MISMATCH、BINDING_CONFLICT、CONTEXT_SCOPE_UNKNOWN。
沿用 FORBIDDEN、INVALID_PARAMS、PRECONDITION_FAILED、原材料/版本错误；鉴权失败先于披露项目材料、去重目标或文件内容。
范围/权限/代次错误整次零业务写入；文件级探测失败/同名冲突仍逐项 rejected，成功项保留。

## 5. 事务守卫、去重快路径与回执刷新

1. main 白名单重建意图并注入可信 actor。成员资格必须按 kind+id，不能用 owner_id fallback；
   当前关系写入、context 创建及 retryRead 在真正事务内重读成员、任务归属/删除、绑定代次和引用归属。
   即使 IPC 预检曾通过，撤权/换绑定后进入事务也必须拒绝且零业务写入。
2. add 的预检可以只读探测字节、发现候选重复，不能在 bySha/sameName 分支直接返回 duplicates。
   同内容也必须进入事务：重新核对可读候选及同项目归属，再 upsert 本 Scope 的引用，最后返回 duplicate+reference。
   无需再次写 blob 的候选也必须过这条事务；不同项目同内容不能借用对方实体或泄漏其存在。
3. files 的指纹按真实字节探测；同名同内容若已不可读，不能仅因名字相同沿用“成功”。
   去重对象是确切可读版本，不能把同一材料的 latestVersion 填成匹配旧字节的版本。
   同名不同内容仍需明确另建或指定补版本，禁止重命名/移除旧实体来绕过。
4. 新文件沿既有 cindy-media staging/记账/引用路径，DB 业务事务失败清理本次 staging，不动其他版本 pin；
   file 形态不复制、不入媒体仓。读回/发 URL 前及异步读取结束时重验数据 owner、项目权限和当前 Scope，
   不把过期 owner/代次的结果交给 renderer；后续原文件变更仍在每次预览前重新 SHA256 核验。
5. t3 同内容添加返回 duplicates 不是“没有变化”：references 必含 t3 持久引用。
   M2-B 对 added/duplicates 两种成功均按原 Scope 重新 list；仅失败且无成功项不伪造列表行。
   响应/刷新按 data-owner+projectId+workItemId+bindingRevision+请求序列验收，旧回执不能覆盖新任务/代次或最新刷新。
   服务层不能把新 reference 字段 normalize 丢掉，重进页面仍从关系表读到 t3 的 v1。

回收不随当前引用软移除释放版本的既有媒体持有。复用同一 material/version 不重复 ingest；
本片不重做 pin/recycler，不声称 file 源删除后仍可读，不承诺跨设备字节可用。

## 6. 旧 work_item_id 迁入（生成新迁移，不改历史）

- 保留旧列、版本行、context.refs_json 和既有媒体引用；只插关系及新增元数据列。
- work_item_id=null：每实体迁一条项目级关系，version=迁移时该实体最大版本，status 原样带入；
  无版本的异常行不伪造版本，保留实体并列异常计数。为何取最大：旧 Material.currentVersion 正是最大版本。
- work_item_id 非空：旧关联只能迁回原工作项，不能挪给当前别的任务，也不能顺便生成项目级关系。
  若真实 session 未删除、project_id 一致且 project_binding_revision=0，建议按 B1 初始一代的迁入裁决迁到代次 0，version/status 同上；
  这不是证明 B1 以前从未重绑，也不允许将非 0 当前代次套用此规则。
- session 缺失/删除、项目不一致、或绑定代次非 0：旧数据没有“引用创建时属于哪一代”的证据。
  推荐迁为原工作项的 binding_revision=null 历史关系，保留原 status/version，但永不进入当前列表；
  只在鉴权后的历史/迁移异常说明中显示“代次待确认”。再次使用必须显式 existing add，在真实当前代次新建关系。
  不把 null 代次自动等于 0 或当前值；不改写旧关系，也不因 p→null→p 或 p→q→p 自动复活。
- migration replay 覆盖空库、含旧资料库、失败回滚与重复启动幂等；真实 binding 入口再回归代次。
  实际序号由唯一迁移执行者核对最新主干后以 Drizzle 生成，不在本稿预定 0149，也不手改 journal/snapshot。

## 7. 旧资料接纳裁定（已由§0确认）

旧工作项材料没有绑定代次：0 的初始接纳是迁入裁决；不能证明非 0 代次材料是“本代次合法添加”还是“上次遗留”。
采用 §6 的保守历史迁入规则，不假设存在可验证的逐条原代次映射。
推荐方案会让这部分旧资料退出当前列表，需要在历史/迁移说明中可见并允许显式重新引用；这是可见行为变化，
不得默默执行，也不能宣称所有旧资料均无损保留了“当前”身份。除此之外本稿无隐含产品选择。
本条允许隔离实现/回放，不授权操作真实用户库；不能用原 work_item_id 或当前值猜测消除未知代次。

## 8. 独立写域与执行顺序

| 唯一写者切片 | 允许写域 | 禁止交叉 |
| --- | --- | --- |
| 关系数据/迁移 | 独立material-reference-data工作树：schema、新 Drizzle SQL/meta、materialsTx、shared/materials、材料与迁移测试 | 不改I1目标与冻结 projectsTx/B1/进度消费；不改历史迁移；不碰 IPC/UI |
| main/可信边界 | M3：ipc/materials 的解析、预检、staging、事务 envelope、读后重验、共享权限及其测试 | 不复制关系规则，不占数据迁移写域；不接受 renderer actor |
| 桥接装配 | 协调指定唯一集成者：worker 文件/inline 分发、tx types、preload、vite-env 声明 | 签名按本文一致，不让 M2-B 另改 preload；本稿不等于注册授权 |
| 界面调用 | M2-B：materialsService/model、页面、快照/预览/版本选择、必要 i18n/测试 | 不碰 main/schema；按引用身份移除，保留代次/引用字段并刷新 duplicates |

顺序：已裁定 §7 → 冻结本合同及 hash → 各唯一写者按固定签名工作 → 联合回放与真实文件/界面复验。
迁移代码、权限入口、界面、实际模型参考分别验收，不能把单片绿灯当成全链完成。

## 9. 可执行反例清单（在未来实现片运行，本稿未实跑）

| 编号 | 最小动作 | 必须观察 |
| --- | --- | --- |
| R1 | p 内 t1 加 A→v1；t3 改名加同字节；刷新并重进 t3 | 仅一实体/一版本；两引用；duplicates 指 v1，t3 references/list 持久可见 |
| R2 | t3 再加 A，含重复批次输入；先移除 t3 再显式沿用 | 本代次本材料仅一关系；恢复沿用原 referenceId；t1 不变 |
| R3 | t3 持 v1 并建 context；t1 addVersion→v2 | t1 关系 v2；t3 currentVersion/默认预览/默认模型参考仍 v1；旧 context 字节不变 |
| R4 | 移除 t1，再从 t3 和旧 context 读 | t3 可读；实体/版本/media refs 未删除；t1 当前不显示 |
| R5 | t3 显式选择已有 v2；另从 v1 创建快照 | 当前只在明确选择后变化；快照按请求存 v1，不能被默认 latest 替换 |
| R6 | t3 经真实 bindSession：p→q→p，或 p→null→p；不做中间材料操作 | 旧代次 add/remove/addVersion/context/当前 preview 均 BINDING_CONFLICT；新代次当前空；旧 snapshot 保留 |
| R7 | IPC 预检确认重复后撤成员/转项目/改代次，再进材料事务 | 零业务写入；不得 duplicate 成功，也不泄漏重复目标 |
| R8 | 非成员/同 id 不同 kind/跨项目材料、引用或 context ID；项目级与任务级伪造混用 | 权限/范围拒绝；其他项目同 sha 不沿用对方实体；不返回正文/存储地址 |
| R9 | 项目级加 A；t1 不显式沿用，再显式 existing add | t1 初始空；沿用后仅新增 t1 引用；项目级和 t1 可分别软移除 |
| R10 | addVersion 使用另一任务 referenceId 或已移除引用；并发另一个范围补版本 | 越界/状态拒绝；合法补版本只推进请求引用；新版本追加和引用推进同事务 |
| R11 | file 源文件改变/删除；媒体 staging 后事务失败 | 旧版不冒充新字节；SOURCE_CHANGED/MISSING；只清本次 staging，不删已有 pin |
| R12 | 带 §6 各类旧行回放；记录旧 versions/refs_json 哈希；重启 | 来源/版本/status 正确；未知代次只历史；快照哈希不变；重复启动不重复迁入 |
| R13 | t3 duplicate 回执/刷新未返回就换任务/owner/代次，旧结果最后到达 | 不覆盖新页面；再进 t3 仍有正确引用，无“沿用成功但空列表” |
| R14 | 旧 host 无 referenceContract；旧 materialId-only 移除到新 host | 新 UI 禁止引用写；新 host 明确要求 Scope，不做全实体软移除 |

证据分层：关系/权限事务断言 → 真实迁移和绑定联合 → IPC/桥接 → 页面/真实文件 → 模型实际读取快照版本。
每层记录命令、输出、冻结文件 hash；不存在的能力或未跑的反例须写未覆盖。禁止真实用户库，不提交/推送/合并。
