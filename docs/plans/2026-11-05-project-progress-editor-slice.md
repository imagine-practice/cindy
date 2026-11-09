# 工作项进度操作表单 E1

本片补齐已冻结进度事务的用户操作表单，不增加一套状态机。目标是为I1后实际页面接线提供可调用组件；本片本身不宣称客户端读写已接通。

## 输入和写域

必须显式读取主目录 `2026-11-05-project-progress-contract.md`（含B1），并读取m4-status固定 `shared/workItemStatus.ts`、`shared/workItemProgress.ts`、`workItemProgressTx.ts` 实现。进度含义是工作状态，done不是独立验收、业务接受或发布。

独立工作树 `.cindy-worktrees/progress-editor-ui`，基于已有M1 `77153376ba` 建立，不修改m2-materials-ui或m4-status冻结来源，也不改正在装配的project-core-rebase。先核对真实状态和环境规则。

允许按原字节复制m4-status的两个共享模块作输入：workItemStatus SHA256 F8D04EEC4933DC8CDC111FA6CD96B803772F30B7D2DB72DC62A1E0CA32F27404；workItemProgress SHA256 AA74A46DD5739343A2CF72F698A0F321F9FD3A8CEAFDBC476E2C934FF96D68A0。目标存在时须一致，不覆盖不同候选。

新增 `renderer/features/projects/progress/WorkItemProgressDialog.tsx`、必要纯表单辅助与专用测试、独立ui fixture；12语言只新增 `ccAgent.projectCore.progressEdit` 子树。其他已有进度模块/语言不改。不改路由、ProjectDetailPage、IPC/preload、worker、schema、迁移或真实模型运行。

## 组件与动作契约

组件受控open/onOpenChange，接收当前已获授权的读取快照：projectId、sessionId、title、bindingRevision、progressRevision、status（可null）、当前阻塞原因/解除条件、canRecord、canConfirmDone。权限字段只控制显示；后端必须按实际成员重验，不从这些布尔值生成actor。

回调 `onSubmit(intent: WorkItemProgressIntent): Promise<WorkItemProgressResult>`、`onRefresh(): void`、`onSaved(result): void`。没有桥也能用真实DOM验证。实际接口装配时直接复用此意图/返回类型，不自造另一套状态字符串。

- 提供五档进度；已知进度的可选目标使用现有allowedWorkItemTransitions，保留同状态记录的事务规则。未知进度可首次明确记录；done仍必须canConfirmDone。
- 当前/目标清楚显示；进入blocked要求原因与解除条件；从blocked解除只到todo/doing且需处理说明；done要求完成说明，并明确是工作进度确认。
- 所有说明去空白、上限4000，与事务一致。必填失败就地显示，不提交；取消零调用。不得把归档、Agent运行退出或刷新当done。
- expectedRevision/expectedBindingRevision来自打开时读取的快照，必填且合法；不自动补当前值、不从历史行推断。提交只含冻结意图字段，不含身份/role/now/evidenceId。
- 同一次明确提交生成一次requestId；忙时防重复。请求结果未知时保持原意图与requestId，用户明确重试才重发，避免一次操作重复追加历史；修改内容后才是新的明确意图。不能用每次点击重试生成新ID掩盖回执未知。
- revision或binding冲突：保留可读说明、提示刷新，不自动重试/重基/覆盖；撤权/删除/错项目：禁止继续写并清除不可再展示的数据，要求父级重新读取。
- 项目、任务、绑定代次、账号代次或打开实例改变后，旧成功/失败/finally不得覆盖新表单或调用新上下文onSaved。关闭再开要清理忙态与错误；已经发出的请求不能声称被取消或回滚。
- 成功结果必须属于原project/session/binding，才通知父级刷新并收口；异常不显示成功。

## 体验与验证

复用现有Radix表单、FormField/Input/Select/Button、错误与主题token。依DESIGN：初焦点到主输入/状态选择；Tab/ShiftTab限制在弹窗；Esc/取消回触发器；遮罩不关闭；有取消按钮不再堆一个右上关闭。忙时关闭行为明确，不谎称取消已提交操作。

最小验证：普通记录、未知首次记录、成员无done能力、负责人带说明done、blocked缺原因/条件、解除缺说明、合法解除、取消零写、双击一次、未知回执同ID重试、revision冲突不自动提交、绑定/账号/任务切换晚回执被丢弃、同scope关开晚回执不得关闭新表单。类型严格、320/390浅深及键盘操作；语言结构与定向测试检查。不得mock掉表单本身而仅测辅助函数。

交组件签名、修改清单、必要测试输出与不超过3张关键截图。表单无IPC接线和真实权限/数据库的边界保留。先给可用固定组件，再由唯一集成者接实际读写；不提交推送或合并。
