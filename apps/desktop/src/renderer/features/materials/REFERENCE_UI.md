# R3-B 界面接入候选（2026-11-06）

本片在 `material-reference-ui`，基线 `77153376ba`。未提交、推送或合并。
原 m2-materials-ui、progress-editor-ui、I1 和 m4-status 未作为本片写域。
本文件与 `artifacts/material-reference-r3b/candidate-sha256.json` 是新候选；R3-A 原清单及旧失败证据保留。

## 输入与优先级

R1 合同 SHA256 `F7BF78CA1001BECB3ED09B69655B48EC5FA2675CD4D973B11B51736E337F5A4E`；
唯一材料公共类型 `shared/materials.ts` SHA256 `7427D8C1A39BFD8927DB5E9DB0DB79A196F564D8B3AAA0715D3C36E087383CF3`，未修改。
PM-AC2 核得 `43FC5FB54479087A2ABE7C7253EC20C00B19187FF300761343462E53FC1FA04E`。
仅消费其去重、权限、版本留存与最小反例；旧角色、旧基线和原型评审门不替代当前 Core 合同。

只读支持从 project-entity-host 固定 support-manifest 核对后原字节复制：

| 文件（shared/） | SHA256 |
| --- | --- |
| projectProgressApi.ts | DA0160B0DF5A0F3495C10A9445905FBFD0CF325940A957E6B02813E714AD3D88 |
| workItemProgress.ts | AA74A46DD5739343A2CF72F698A0F321F9FD3A8CEAFDBC476E2C934FF96D68A0 |
| workItemStatus.ts | F8D04EEC4933DC8CDC111FA6CD96B803772F30B7D2DB72DC62A1E0CA32F27404 |

## 实际写域与行为

- WorkItemMaterialsPage：先调真实 S 读取入口，再构建 immutable scope/service；路由、Auth owner/generation、解绑广播与卸载淘汰旧实例。读取使用最新请求票据。权限/绑定/协议错误清材料、正文、快照与表单。缺项目变化订阅不开放写入，重试也不能绕过。
- materialScopeRead（新增）：局部严格边界调用既有 bridge，不注册公共入口；只用 items 中匹配 project/session 的独立 bindingRevision，progress=null 仍可用；未知 token 不填 0。
- MaterialsPanel/MaterialRow：多文件输入、拖入；reference.id 作为列表/移除标识；当前引用版和 latestVersion 分开显示；显式选择目录版本走 existing add。历史关系只读，不能当作当前写权。窄屏操作区换行，避免挤掉文件名和状态。
- MaterialSnapshotSection：选择以 reference.id 记录，缺省是引用版本，确认时传确切 refs；历史快照与未知代次保留为历史，预览只走 context locator。切换清 selection/picker/creating 等状态，旧回执不改变当前忙态。
- MaterialPreviewDialog：图片/文本/unsupported 都消费真实通道回执；unsupported 有受控地址时提供应用内打开，并标注不解析正文；错误不伪造正文。Radix 打开前记录触发器，Esc 关闭后返回焦点。
- materialReferenceView（新增）：仅共享类型别名和展示/文件输入辅助，无新的公共协议和旧数据成功 fallback。
- materialReferenceService：保留 R3-A 严格校验；新增 MaterialReferenceRefreshError 携带已收到的 add receipt 和刷新错误，防止把已提交成功误变成整批可重试。
- 三个既有 DOM 测试适配新入口；新增 referenceTestSupport 只供测试。旧 model/service 与 R3-A 28 个 service 测试保持原字节，生产组件不再引入旧 model/service。
- 12 locale 仅增加 ccAgent.materials；其余 JSON 数据与 HEAD 相同，原文本格式保留。新增 fixture 仅在 ui:check 目录，不注册产品页面或 IPC。

## 实际通道形状

令 s=`{projectId:'p1',workItemId:'s1',bindingRevision:7}`。referenceContract 在响应中，必须为 1。

| 调用 | 请求 | 响应/界面消费 |
| --- | --- | --- |
| projectProgress.read | `{projectId}` | `items[{sessionId,projectId,title,sessionStatus,bindingRevision,progress}], capabilities.canRecord`；失败或不匹配不构造写域 |
| materials.list | s；历史 `{projectId,workItemId,history:true}` | 当前 `{referenceContract:1,scope,materials}`；历史保留 history 与 reference/version/currentVersion/latestVersion |
| materials.add | `s + {files:[{name,path,sameNameAction?}]}` 或 `s + {existing:[{materialId,version}]}`，互斥 | `{referenceContract:1,scope,added,duplicates,rejected,references}`；任一成功引用（含 duplicates）重读原 s，UI 消费 `{receipt,current}` |
| materials.addVersion | `s + {referenceId,materialId,file,replaceCurrentReference:true}` | `{referenceContract:1,scope,version,reference}`，随后重读；展示真实回执版本号 |
| materials.removeReference | `s + {referenceId}` | `{referenceContract:1,scope,ok:true,status:'removed',reference}`，随后重读，不移除共享实体 |
| materials.preview | `s + {referenceId,materialId,version}` 或 `{contextId,materialId,version}` | `{referenceContract:1,materialId,version,kind,name,mime,size,url?,text?}` |
| materials.retryRead | 与 preview 相同的固定定位 | `{referenceContract:1,version}`；当前行重读状态，不分配新版本 |
| materialContexts.create | `s + {purpose,refs:[{referenceId,materialId,version}]}` | `{referenceContract:1,context}`，刷新记录列表 |
| materialContexts.list | s 或同任务历史查询 | `{referenceContract:1,scope,contexts}` 或 history 形状；nullable 元数据不推断为 0 |

只有用户明确“新建独立材料”发送 sameNameAction=create-new；普通添加和补版本不带该字段。
可恢复错误行保留原 file/operation/referenceId/materialId，重试仍由 Host 重检。
取消同名选择零写入。R1 rejection 四种闭合码按契约消费；SOURCE_MISSING/CHANGED 通过异常场景覆盖，未造扩展 rejection 协议。
写结果未知或写回执已到、后续读取失败时显示“待确认”，阻止自动/按钮重放创建版本，只允许先刷新核实。

## 验证与证据

- 全部材料测试：83/83，5 文件，3.45s（tests-final.txt）。包含原 model10、service28、Panel10、Snapshot7，以及页面28：真实组件→新 service→可控 preload。
- 定向类型检查包含页面、依赖组件、全部材料测试及 fixture：`pnpm exec tsc --noEmit -p artifacts/material-reference-r3b/tsconfig.json`。
- `pnpm --filter desktop check:i18n`：此基线 desktop 没有该脚本，真实失败保留；根级 `pnpm check:i18n` 通过，12 语言15015键一致，报告5152条翻译警告，不称无警告或全门禁通过。
- ui:check：320x820 与390x844，中文/德语 × Light/Dark × 版本/空态，共16变体；含 Enter 预览、Esc 返回确切触发器、Select 弹层 Esc 不误关外层、再 Esc 取消快照。版本展示文件名宽度检查防止窄屏挤压。
- 保留首次 CLI 逗号解析失败、早期关闭时序/焦点检查失败和被实看否定的窄屏截图；最终证据另存 ui-320-frozen、ui-390-frozen。
- `git diff --check` 及 locale 写域/只读输入指纹检查见 artifacts。未运行无关事务、E1、详情页、全仓门禁。

页面实测含：多文件及 duplicates 重读；t1/t3 独立引用和 v1/v2 展示/精确预览/按引用移除；显式目录版本选择；历史 context v1 不漂移；未知代次 history 与 CONTEXT_SCOPE_UNKNOWN；缺/失配 token、无权、旧 Host 零写；路由/账号/绑定/同 scope 替换/旧 success/error/finally；同名原意图失败重试；提交成功但刷新失败不重放。
页面与事务测试证据不同，不能互相替代。

## 集成与未覆盖

唯一集成者取本候选生产文件和所需 locale 材料子树；不要整文件覆盖其他任务新增的 locale 子树。
实际入口仍由集成树原材料路由挂载本页面；本片没有改路由、ProjectDetailPage、preload、main、provider、schema 或模型流程。
真实 S read 与 projects.onChanged 需在目标 Host 可用；主进程应继续权威核验 scope 与权限。前端废弃回执不代表已发送写入取消或回滚。

**能保存版本参考快照，但尚未绑定实际执行/材料送入模型。** purpose=redecompose 只是用途记录，不是已经重新拆解；本片不自动发送模型消息、不声称已读。
后续执行入口需由用户明确触发，把选定 contextId 交主进程统一权威绑定，本片不自创调用协议。
无本地路径的剪贴板截图仍不支持，提示仅宣传文件选择/拖入。
真实 R2/Host 联合验收、真实字节上传/文件变化校验/权限隔离、实际模型参考、跨设备与原生剪贴板/拖拽尚未验证。
同名选择覆盖当前可见引用；未新增跨项目材料目录发现接口。同批同名不同路径文件的 rejection 对应关系未专项覆盖。
截图为 Chromium 受控 fixture，不是登录账号或完整 Electron/手机实机验收。
