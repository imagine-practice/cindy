# 项目进度视图独立切片 V1

2026-11-05。用户要求完整项目管理，并按小步并行方式交付。本片在数据库与权限片执行期间实现可组合的只读进度组件；生产读服务和页面装配另片接入，不以组件预览冒称项目已可用。

## 输入与既有界面

- 明确读取主目录 `docs/plans/2026-11-05-project-progress-contract.md`，含 B1 绑定代次规则。
- 实际现有页面在 `.cindy-worktrees/m4-status/apps/desktop/src/renderer/features/projects/ProjectDetailPage.tsx`，不要假定主目录已有实现。
- 同工作树的 `shared/workItemStatus.ts`、`shared/workItemProgress.ts` 及进度事务是已冻结输入，保持字节不变。
- 沿用现有 Button、错误提示、主题 token、字体、图标、任务名和主体展示规则；先读本树 AGENTS、DESIGN 与 desktop-development 的组件 UI 检查章节。

## 用户看到什么

项目内“进度”区包含：有效工作项总数；未开始、进行中、受阻、待确认、工作完成、未知的计数；受阻项及原因、解除条件；最近进度记录。没有燃尽图、预算、工时或新的导航体系。

- 点击状态计数筛选同一份工作项数据；“全部”恢复，不对另一个列表单独计数。
- 点击工作项走注入的 `onOpenWorkItem(sessionId)`；同名任务按稳定 ID 区分，不以标题路由。
- 受阻原因或解除条件缺失就显示未记录，不编造解除建议。
- “工作完成”只代表明确进度确认，界面说明与独立验收、业务接受、发布分别记录；运行停止不生成完成。
- 历史展示前后进度、主体、时间、原因、解除说明、完成说明；旧绑定周期记录标“历史绑定”，不能被计入当前进度。
- 加载、加载失败及重试、无工作项、无进度历史、无权限各有明确状态。非 ready 状态不继续显示上一项目正文；报错文案不输出原始路径或未授权内容。

## 组件数据边界（不是线上 IPC 合同）

由 props 接收当前 projectId、可区分的 loading/error/forbidden/ready 状态、工作项数组及已授权历史数组，回调仅打开任务和请求刷新。本片不读 window bridge、不访问数据库、不自动请求模型。

工作项投影至少具有 sessionId、projectId、title、sessionStatus、bindingRevision、nullable progress record，及可选可信运行信号。直接复用共享 WorkItemProgressRecord/WorkItemSessionSignals 类型，不复制另一套状态机。显示名称由既有主体展示规则处理，未知名称保留明确 ID，不猜身份。

显示当前进度的必要条件：记录的 projectId、sessionId、bindingRevision 都与当前行相符。旧代次或跨项记录不能作为 explicitStatus；若当前代次缺进度，不从旧记录继承完成。无可靠当前信号时为 null，而不是 todo。当前合法记录的 done 还应具有 completionEventId，异常记录保守显示未知。

汇总使用已冻结 summarizeWorkItems，保留 sessionStatus，deleted 排除、archived 不自动完成、unknown 留在总数。跨项目的工作项不混进当前页。当前行的稳定 ID 不重复计数；重复输入及冲突记录明确保守处理，不按标题去重。

历史仅显示当前项目的已授权投影；同项目旧绑定可保留并标注。组件过滤是防错显示，不能替代后续 main 的权限检查，不宣称撤权安全已实现。

最近记录按时间及稳定事件 ID 确定排序，可限制初始显示并提供展开；不假装这是完整服务器历史。当前页切项目时清除筛选/展开等本地状态，不能让旧筛选把新项目显示为空而不说明。

## 独占写域

继续原 `m4-status` 工作树。只新增 `apps/desktop/src/renderer/features/projects/progress/` 下组件、必要本地投影类型/函数及测试；可新增 `apps/desktop/scripts/fixtures/project-progress/` 场景。只允许在本树12个locale的 common.json 中新增 `ccAgent.projectCore.progress` 命名空间，不改既有材料或后台任务 key。

不改已冻结5文件、ProjectDetailPage、router、shared/projects、IPC、preload、worker注册、schema、migration 或其他工作树。材料界面作者已冻结语言文件；两边只增不同命名空间，最终由集成片合并键，不整文件覆盖。

本片不实现进度编辑表单、运行态适配、通知、调度。交付回调/props签名及未来读服务缺项，不能靠手改数据库演示。先做小片后再装配真实页面，避免写未冻结 IPC。

## 必须验证

1. 计数与过滤列表一致；unknown 计入总数、deleted 排除、archived 保留原进度。
2. 旧绑定 done、新绑定无记录显示未知；异项目/异session记录不误验当前项；缺完成事件的 done 不展示为已确认。
3. 同名不同 ID 打开各自任务；受阻项原因/解除条件及历史解除说明可读。
4. ready 切 loading/forbidden 或切项目后，旧正文不残留；empty 与 error 不混用；重试回调一次。
5. Tab/Shift+Tab、Enter/Space；320/390 CSS px 与宽屏、浅/深主题无整页横向溢出。长任务名和多行阻塞内容可读。
6. 按仓库 ui:check 挂载真实组件，查看 overview 和关键截图；标明 fixture 与未接宿主，检查12语言键一致。只测本片必要测试及类型/卫生/文档检查，不反复重跑无关事务。

交付实际组件、测试输出、截图和逐文件hash，明确主目录未接线。未提交、合并、推送；独立复核后进入统一装配。
