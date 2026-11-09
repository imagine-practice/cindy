# 项目内核迁移链重建方案

2026-11-05。处理最新上游与未发布项目迁移的编号冲突。仅准备可审阅的独立候选；不合并到dev，不推送，不连接日常用户数据库。

## 已核实冲突与基线

- 原项目/材料候选161e483607使用0145_fresh_exodus及0146_amazing_stryfe。
- 最新origin/main为 `1b18485d193812fa0a91a59939b0ab2aa2149707`，已有0145_bizarre_tinkerer。
- 上游0145 SQL虽为SELECT 1，其companion实际补session_pr_refs的provider/host并更新唯一索引，不能当作无效占位删除。最新schema也包含这些字段。
- 协调已新建 `.cindy-worktrees/project-core-rebase`，分支cindy/project-core-rebase，基于上述精确上游提交。所有旧工作树与dirty文件保留，不重置、不变基它们。

## 候选准备步骤

1. 在新工作树核对AGENTS及environment-setup、database-and-migrations。按仓库要求安装其自身依赖，不链接/复制其它工作树node_modules。不要复用用户profile。
2. 仅移植旧候选的项目/材料schema意图，不整文件覆盖最新schema。差异来源分别为77153376ba相对其父的schema，以及161e483607相对77153376ba的schema；保留上游session_pr_refs字段及索引。
3. 在完整上游迁移链之后，用Drizzle依次生成项目基础、材料基础、B1进度与绑定代次迁移，实际编号以工具结果为准。旧候选的0145/0146 SQL、snapshot、journal均不复制、不改名；新候选只使用上游历史和新生成文件。
4. B1结构输入为主目录项目进度契约与其增量；进度消费任务的在途实现不作为可随意复制的稳定产物。此片只需目标两表/绑定列及真实绑定入口。
5. 为数据回归明确移植最小依赖：shared/projects.ts、shared/materials.ts、projectsTx.ts、materialsTx.ts及对应projects/materials测试。材料修复源来自原m2-materials-core的固定三文件，原始文件保持不变；新候选测试只按实际新迁移名称调整fixture加载，必须列出相对固定来源的差异。projectsTx添加B1绑定代次，两个材料生产模块保持固定逻辑。
6. 在新候选的migrationReplay测试中添加项目/材料/进度结构与数据保全回放，不整文件覆盖上游新版测试。补p→q→p、解绑往返、同项目no-op、setAssignee不增代次反例。要确认实际生成migration可升级原上游旧库，而非只靠手写测试表。

## 写域

唯一执行者为原材料数据任务，在新目录工作；宿主原注册目录仍是旧目录，所以每次命令必须显式设置新working directory，并在回执写清两个目录的状态。

允许新候选：schema、Drizzle新产物与自动生成meta、上述shared/事务模块及必要项目材料/迁移测试、B1绑定入口。禁止移植整批74文件或先接入renderer/IPC/preload；禁止抢写其他任务工作树；禁止merge/rebase/cherry-pick旧提交整包带入迁移。

旧材料修复、进度消费修复、权限、页面继续各自冻结与审核。此新候选仅解决迁移和数据基线，不代表M1/M2产品已经完成新版整合。跨工作项材料引用改动保持下一片，不混入此次迁移目标。

## 验收与交接

- 基线提交和上游历史迁移hash前后相同；生成SQL无无关删除/回退provider/host。
- db:validate、migrationReplay、projects与materials测试，相关严格类型和卫生检查。
- 比对材料固定生产文件，列出所有移植差异及确切新迁移名；新旧临时数据库回放，不连接用户库。
- 报告完成范围及剩余注册/IPC/页面接线；无提交、推送、合并、发布。若发现新的上游迁移推进，列出冲突再协调，不通过手工编号绕过。
