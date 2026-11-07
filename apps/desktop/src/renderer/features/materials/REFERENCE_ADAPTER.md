# R3-A typed adapter 固定交接

本片新增 `materialReferenceService.ts`，不改或接入旧 Panel/page/model/service。
旧 `features/materials` 从冻结 m2-materials-ui 按目录白名单原字节复制，只作为只读输入。
工作树 `material-reference-ui`，分支 `cindy/material-reference-ui`，基线为该树 HEAD `77153376ba`。
本片生产新增一个 adapter、一个专用测试和本文；未复制整个工作树、locale、路由或挂载点。

## 固定输入

- 主目录材料引用合同：F7BF78CA1001BECB3ED09B69655B48EC5FA2675CD4D973B11B51736E337F5A4E。
- 唯一 R1 公共材料类型 `shared/materials.ts`：
  7427D8C1A39BFD8927DB5E9DB0DB79A196F564D8B3AAA0715D3C36E087383CF3。
  原字节复制；没有修改、补字段或另造同名本地实体协议。
- 类型化 bridge 方法全部引用上述请求/结果类型；边界以 unknown 接收回执，严格解码。
  不接受旧数组/直接实体、snake_case、缺失 contract/scope 或隐式代次补值。

## 使用与生命周期

`createMaterialReferenceService(scope)` 为一个已观察到的不可变 MaterialScope 创建实例。
先 `await service.list()` 验证 referenceContract=1、回执 scope、引用和选中版本投影，再允许写入。
历史列表不授予写能力；替换 window bridge、权限/绑定错误或协议错误后需要重新验证 list。
SOURCE_MISSING/CHANGED 等可恢复错误原样抛出，不改变原操作。

切项目/工作项/绑定代次时创建新实例，立即 `dispose()` 旧实例；卸载也要 dispose。
实例同时检查账号 generation，旧回执抛 PRECONDITION_FAILED，不能投射成新页面空成功。
当前 list 的乱序旧回执会拒绝，但不能撤销较新 list 已验证的能力。
这不是宿主授权、撤销或取消已发送写入的机制；所有真实权限仍由 main 复查。

## 八通道请求/返回

下表 `s` 为 `{projectId:'p',workItemId:'t3',bindingRevision:9}`，没有省略 scope 字段。
每个回执都要求 `referenceContract:1`；此标记按冻结类型位于返回值，不擅自加到请求。

| 通道（沿用 local-db 前缀） | 请求 | adapter 返回 |
| --- | --- | --- |
| materials:list | `s`；历史 `{projectId:'p',workItemId:'t3',history:true}` | 原 R1 MaterialsListResult；保留 scope/history/reference/currentVersion/latestVersion/version 目录 |
| materials:add | `s + {files:[{name,path,sameNameAction?}]}` 或 `s + {existing:[{materialId,version}]}` | UI 组合 `{receipt:MaterialsAddResult,current:MaterialsListResult|null}`；不改变线上回执；成功引用（含 duplicates/restores）均重读原 scope，纯 rejected 时 current=null |
| materials:add-version | `s + {referenceId:'ref-t3',materialId:'mA',file,replaceCurrentReference:true}` | 原 MaterialAddVersionResult；检查 reference.id/materialId/选中版本一致；不退化为 add 或实体移除 |
| materials:remove-reference | `s + {referenceId:'ref-t3'}` | 原 MaterialRemoveReferenceResult；仅该 removed 引用；不发送 materialId-only remove |
| materials:preview | `s + {referenceId,materialId,version}` 或 `{contextId,materialId,version}`，互斥 | 原 MaterialPreview，核对实际 materialId/version；unsupported 的 url 也保留 |
| materials:retry-read | 与 preview 相同定位 | 原 MaterialRetryReadResult，核对仍是所请求版本；不恢复引用、不创建版本 |
| material-contexts:create | `s + {purpose,refs:[{referenceId,materialId,version}]}`，必须任务 scope | 原 MaterialContextCreateResult；核对 project/binding、用途和原选择版本；允许显式选目录中的其他版本 |
| material-contexts:list | 任务 `s` 或同任务 history 查询 | 原 MaterialContextsListResult；保留历史 null 元数据、旧 ref 中缺省 referenceId，不将旧快照推为当前 |

公开投影使用逐字段构建，嵌套 reference/version/context 也不透传 storageRef 或 storage_ref。
当前引用的 currentVersion 必须等于 reference.version/readState 对应版本，绝不取目录最大值替代。
历史未知 bindingRevision=null 保留为 null，不作为当前 scope 或写入 token。
referenceId 校验为400字符；materialId 为200字符，二者不混用。

## 下一片 Panel/page 需要的输入

1. 页面先读取真实已授权的进度读取结果。只读核对 S 的 `shared/projectProgressApi.ts` 与
   `projectProgressReadTx.ts`：`ProjectProgressReadResult.items[]` 每项的 `bindingRevision`
   来自 `sessions.project_binding_revision`，即使 `item.progress === null` 也有独立 token。
   选择匹配当前 projectId/sessionId 的 item，用其 bindingRevision 构造任务 scope。
   本工作树未安装该 main/preload 入口；应由集成者接入真实 `progress.read`，不是本片伪造桥。
   禁止用旧 session 目录、历史事件、旧 progress record 或缺失值回填0来猜当前代次。
2. Panel/page props 应携带完整 `scope`、该 scope 的 service、完整 R1 list 回执及加载/错误状态。
   旧 `projectId/workItemId` 两字段和旧本地 Material 类型不够；不能逐页把丢字段当成功。
3. 用 `reference.id` 标识引用、移除和补版本目标。预览/快照的默认版本取 reference.version；
   版本目录可显式选择，latestVersion 只作为提示，不推进其他工作项引用。
4. 失败重试必须保存完整操作：add 的 scope + files/existing + create-new，或 addVersion 的
   scope/referenceId/materialId/file/replaceCurrentReference。不得从 name/path 重建普通 add。
   取消不调用写接口。当前只读旧 Panel 的10条回归继续通过，包括取消零调用和原重试行为，
   但它尚未改成新 props，也不构成新 R1 页面已接通的证据。
5. add 返回 `current` 才能更新列表；若 add 已提交但重读失败，异常仍向上传递，不能提示空成功。
   当前 scope 变化后旧实例回执不能通知新页面；父组件保留请求票据并 dispose 旧实例。
6. 新错误码需要后续 UI 文案/占位接入；本片不改12 locale，不通过旧 model 的通用错误掩盖它们。

## 验证与未覆盖

专用真实 service→受控 window bridge 测试28项通过；只读旧 Panel 测试10项通过。
测试覆盖 t1/t3 同内容各自引用、duplicate 重读、t3/v1 对 t1/v2 不漂移、独立移除、显式 existing、
八通道请求、历史 null、旧 Host、400字符 referenceId、缺/失配 scope、错误版本、raw storageRef
剔除、create-new 的抛错/批量 rejected 后重试、补版本原目标重试、dispose/账号/乱序回执。
定向 tsc 使用 artifacts/material-reference-r3a/tsconfig.json，只检查新 adapter/专用测试及其导入。

未覆盖真实 R2 IPC/staging/事务/迁移、上传字节、数据库持久化、权限隔离、真实 token 读取接线，
以及 R1 Panel/page/预览卡/快照 UI 的最终装配和模型材料发送。受控响应不能证明这些完成。
本片没有实际签名冲突；R2 需要按固定类型提供 contract 标记、scope 和成功 references。
批量 rejected.code 按固定公共联合的四项处理；SOURCE_MISSING/CHANGED 异常原样保留，未擅自扩联合。
未提交、推送、合并或操作用户库。
