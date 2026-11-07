# 项目卡片首页候选（2026-11-06）

独立工作树 `project-index-ui`，分支 `cindy/project-index-ui`，基线 `77153376ba`。
材料 R3-B、E1、详情页、原新建弹窗候选和 I1 均未修改；本片未提交、推送或合并。

## 新增与复用

新增生产入口：`ProjectsPage.tsx`、`projectsIndexController.ts`。
新增一份专用 DOM 测试、两份 ui:check fixture 和本交接。
12 locale 只增加 `ccAgent.projectCore.index` 的30个键；其余 JSON 数据与 HEAD 一致。

复用既有 Button/Input/Select/Spinner、Cindy 语义色、12px容器圆角、无投影卡片；
卡片是一整个原生 button，内无按钮/链接/输入嵌套，名称为可访问标签，目标/元数据为可访问说明。
目标摘要最多三行并保留完整 title；320窄屏一列、宽屏两至三列，无另外一套产品风格。

只读输入：

| 文件 | SHA256 |
| --- | --- |
| NewProjectDialog.tsx，原 m2-materials-ui 固定源原字节复制 | 11691DFCDDAEBC2DE13B1FFAC5B834A3729D4742F32CD4CEA637A7219222624C |
| projectService.ts，M1基线，与固定原树一致 | 9523EFFAFFFFD6A9BC5BE99A164551F0A13CAFC6FD9BE77A8C55CF1D39E59A77 |
| shared/projects.ts，M1基线，与固定原树一致 | 535F175C6EBA9E7597FF086DF9728BB5FCE9D5A94D6076AF8F1264D903A38C87 |

新建弹窗在本 worktree 相对 HEAD 显示修改，是引入上述已固定输入，不是本片改写。
原树和此副本的 hash 都核对；最终候选清单再次核对。
没有拷贝主进程、provider、迁移或其他任务的页面；没有读 I1 变动文件作为输入。

## 实际数据与操作

controller 调用真实既有 `listProjects()` 和 `onProjectsChanged()`，不经过 projectStore，
不以 bridge 缺失或异常返回 []。验证 ProjectRecord 列表、唯一项目ID、合法生命周期、
非负任务数和唯一 owner 成员。未知成员 kind/不完整响应显示读取错误，不显示空成功。
成员去重使用 `kind:id`；账号和伙伴同ID仍是两人。负责人取成员 role=owner 的 subject，
不把 `ownerId` 当作现任负责人，不从同名或群成员推断项目权利。

展示名字、目标、负责人类型/名称或ID、成员数（含负责人）、伙伴子集数、任务数、
active/archived 生命周期和更新时间。缺目标、不可解析时间均诚实占位。
没有统一的卡片进度读取输入；只显示“进入项目查看进度”，不做完整工作项 detail/progress N+1，
不显示0%、不把归档称为完成/业务验收/发布。

搜索名称和目标；初始只看在用项目，可切已归档/全部。过滤在授权列表内完成，不产生新读取。
按更新时间降序、稳定项目ID打破平局。同名不同ID各有一张卡片。
真正空列表与搜索/状态无匹配分开；后者可清筛选显示全部。

列表/订阅不可用显示旧Host占位；mutate入口缺失时仍可看授权卡片，但禁用新建并说明原因。
每次通知/重试先撤下旧列表和新建表单，再读当前权威列表；最新请求才发布。
owner/同账号epoch变化用组件作用域重建；旧成功、失败、订阅、创建回调和卸载后回执无效。
Host可调用入口更换时拒绝旧读结果；比较方法引用以兼容既有代理bridge，而不是比较代理对象本身。
前端丢弃回执不代表已发送的后端创建被取消或回滚。

错误显示的最小兼容差异：M1闭合错误枚举未收录后续 NOT_PROJECT_MEMBER 等码，固定 service
可能包装为 UNKNOWN。controller 只从明确的IPC错误前缀识别权限失败，保持失败状态，
不修改共享错误枚举或固定 service，不据此授予权限。

## 唯一集成者接线

本片没有修改 router、CCAgentSidebarUpper、EntityProjectsSection、ProjectDetailPage 或固定 Dialog源。
由集成者添加 `/cc-agent/projects` 全局入口并把详情返回接到此首页：

```tsx
<ProjectsPage
  onOpenProject={id => navigate(`/cc-agent/projects/${encodeURIComponent(id)}`)}
/>
```

卡片只回传稳定 projectId，不把名字当路由参数；实际路由注册和返回导航不在本候选内。
默认“新建项目”已复用固定 NewProjectDialog；成功通过既有
`projects.mutate({action:'create',input})` 后重读列表，取消不写。

若目标已有统一弹窗宿主，可使用可选回调：

```tsx
<ProjectsPage
  onOpenProject={openProjectById}
  onNewProject={afterCreated => openExistingProjectDialog({onCreated: afterCreated})}
/>
```

`onNewProject` 只负责让父层打开既有固定弹窗；传入的 afterCreated 仅在实际创建成功后调用，
不能在取消/失败时调用。它带页面owner/epoch/卸载保护，旧回调不会刷新新账号列表。
父层仍负责其弹窗的开关与作用域，避免再同时打开第二个弹窗。

固定 Dialog 还依赖既有 `projectCore.form.creatorMember` 文案。
当前独立M1基线不含该键；按“仅index增量”没有改form。集成目标应保留原新建弹窗片的
已固定12语言creatorMember资源；否则选bot负责人时会暴露缺失文案。
ui:check 的 Dialog 默认账号负责人；bot负责人/creator 必选关系在真实DOM→bridge测试覆盖，
不冒充已做其12语言新截图。不要用本片locale整文件覆盖I1的progress/creator等子树。

## 实跑

- 独立依赖：`pnpm install --frozen-lockfile --prefer-offline --prod=false`，37.4s完成，未跨树共用node_modules。
- `pnpm --filter desktop exec vitest run src/renderer/features/projects/__tests__/ProjectsPage.test.tsx --reporter=dot`：22/22，4.15s独立耗时。
- `pnpm exec tsc --noEmit -p artifacts/project-index-ui/tsconfig.json`：含实际页面/controller/固定Dialog、专用测试及fixture的定向类型检查。
- `pnpm check:i18n`：12语言14926键一致，报告5140条翻译警告；不称全门禁通过。
- `pnpm ui:check --page projects-index`：320x840六场景24变体；390x844及1280x900各三场景12变体，共48，中文/德语、Light/Dark。
- 场景：卡片/长文案、空、error重试、无权、旧Host、加载；键盘Enter按稳定ID打开、真实Select筛选、真实Dialog取消零写并返回新建触发器。
- 实看中文浅色320卡片与中文深色1280卡片；其他组合有自动截图，未逐张人工目检。
- `git diff --check`、locale写域及固定源指纹检查见 artifacts/project-index-ui。

首次17/18失败暴露权限码映射缺口，后续已补；首次UI检查也暴露代理对象身份比较不兼容，
修成可调用入口比较。旧失败日志保留，新证据独立保存。
测试包括同名不同ID、account/bot同ID计数、owner来源、搜索/归档、空/loading/旧Host/不完整响应、
无权撤下旧卡片、乱序成功/失败、owner/epoch/卸载、真实创建重读和取消零写、旧创建成功/失败不污染新表单。
“group”非法投影用例只证明界面拒绝错误数据，不证明真实群/项目授权。

## 未覆盖与范围

此候选尚未接入目标路由/侧栏/详情返回；交由唯一集成者装配，不能称完整导航已验收。
未操作真实用户库，未验证真实Host/M3权限、真实DB创建/广播、远端桥/跨设备、完整Electron或手机实机。
没有统一进度汇总、模型执行、群关联或交付tabs；没有用截图原型数据进入runtime。
专用fixture只替换 auth/bot 投影和 preload 回执，页面、controller、service、Dialog与UI组件为真实实现。
没有修改材料页或重跑无关材料/事务/E1/详情测试。
