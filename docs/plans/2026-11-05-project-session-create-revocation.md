# 新建项目任务的撤权竞态

状态：真实公开处理器反例已复现，必须在客户端整体验收前修复。不是既有绑定事务回归失败；新建走另一条写入路径。

## 独立证据

协调workspace `documents/2026-11-05-项目新建任务撤权独立复验.test.ts` 与同名txt。复用现有sessionsUpdate测试的Electron/账号/内存SQLite夹具，调用真实注册的 `local-db:sessions:create`、真实项目入口守卫、真实openSession及Drizzle落库，不替换被测处理器。模型准入是受控异步准备，不调用模型服务。

对照组：普通成员创建项目任务成功。反例组：前置项目检查后，在模型准入回调中从真实SQLite删除该成员，再返回模型配置；创建仍成功，sessions.project_id='p'且成员行已不存在。两项结果1通过1失败；实际执行35ms，Vitest总11.59s。原始生产文件保持不变。

`ipc/sessions.ts` 预先await assertProjectBindable，后续await openSession准备，最终回调直接db.insert(sessions).values(prepared)。assertCurrent仅校验账号代次，不能替代项目成员即时授权。

## 必须满足的修复边界

- 最终会话插入与项目存在/未归档、可信主体成员资格检查必须属于同一数据库原子操作。仅再加一个await预检仍有竞态，不接受。
- actor来自宿主账号上下文，不采信body.actor/role；保留已有账号切换、来源白名单、路径授权、模型准入、工作区锁、provisional及失败清理。
- 不改变未绑定项目的普通任务原有创建语义，不通过先写未绑定任务再另行bind留下半成功任务，也不把拒绝偷偷降级成无项目创建。
- 新任务绑定代次仍为0；现有任务移动、归档和进度算法不在本修复写域。
- 不修改schema/migration，不绕过数据库worker，不新增通用renderer SQL接口。优先复用现有主进程SQL生成/事务装配能力，避免复制整份sessions列定义形成双份schema。
- 失败不留session、项目绑定或成功广播；正常创建不重复插入。所有参数边界与异常语义须能在真实handler测试中核验。

## 分工

隔离整树装配正在project-core-rebase执行；本缺口不让另一执行者同时改该树。进度执行任务可先在其原m4-status工作树完成最小原子持久化方案及独立事务核心/测试，写域需先核对后限定；不得修改已冻结进度五文件、组件或locale，不修改在途的IPC/worker注册公共文件。交出确切函数签名、主进程可信输入来源、对现有sessions:create的最小接线diff建议以及验证。公共入口与worker注册在I1候选冻结后由唯一集成者应用，不能以核心测试通过关闭全路径问题。

最小反例：成员正常创建；准备期间撤成员；准备期间归档/删除项目；账号切换；同名不同kind主体；缺可信身份；重复sessionId；未绑定项目创建保持；错误不发成功广播。分别标明事务核心、实际处理器与完整客户端的证据边界。

## C1 公共接线（核心固定后）

协调已复跑14项核心测试通过；尚未关闭真实入口反例。I1装配固定后，唯一集成者在project-core-rebase进行本片，不回写m4-status来源。

核心源 m4-status/apps/desktop/src/main/localDb/：

- authorizedSessionPersistence.ts：B6B1A61205159BCA5AC8014877CDF5B91208EBADE6D29F4D6552082D0768503C
- worker/opHandlers/authorizedSessionCreateTx.ts：8C145CE08C28F83FC245D282542A407259C80F20CC24DE6178041EB4BDED8CD0
- __tests__/authorizedSessionCreate.test.ts：1BB1CF0972E8DA279BA430BB79D92AFE536249B639363BAD318C5ADE6956E2F0

主进程辅助从真实schema编译INSERT，request封装为main-only；不能把SQL或actor从renderer复制进来。worker在IMMEDIATE事务中查真实成员、项目状态再插入，并校验最终项目和初始代次。核心目前允许旧schema无代次列，集成目标的新schema必须存在该列并验证0，不能以旧schema兼容测试替代。

接线写域：以上3文件按固定输入复制；client/tx/types.ts、worker/opHandlers/tx.ts、client/WorkerThreadTransport.ts 三处登记 sessions.createAuthorized；ipc/sessions.ts 项目绑定创建的最终持久化回调；现有sessionsUpdate测试补真实入口反例或单独新增专用入口测试。最多8个主实现/测试文件，派发测试按需与现有结构复用。输入存在不同字节时不盲目覆盖。

在sessions:create任何异步准备之前捕获同一个DbClient和可信actor，保持现有账号代次assertCurrent、renderer来源校验、工作区锁、provisional清理与广播。只替换projectId非空时的最后INSERT；无项目的普通创建沿原路径，不顺带变更行为。结果未知或账号在派发后变化时不自动在新账号重试，不发成功通知，不宣称已回滚已经提交的旧账号事务。

原子核心测试夹具在旧树额外添加project_binding_revision；新树schema已有该列，须按实际schema调整夹具，不能重复造列或删掉生产列。新增修正记录为集成差异，不能冒称复制后hash未变。

必要验证：原真实sessions:create正常/撤权两组反例由1失败变为全通过；模型准备期间归档/删除项目；非项目普通创建回归；失败零session/零成功广播、provisional清理；同账号不同kind身份；真实dispatcher和inline RPC成功与拒绝；整树类型检查。派发后账号切换记录真实“写入可能已提交但不能向新账号交付”的边界，禁止伪造零写入。

运行仅隔离测试库，不启动模型或操作真实用户数据；不提交推送/合并。完成后独立复验原入口，之后才关闭此缺陷。
