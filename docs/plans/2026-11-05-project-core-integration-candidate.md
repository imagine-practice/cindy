# 项目内核隔离候选装配 I1

本片把已经分别验证的代码装成一个可做整树检查的候选。用户要求完整主项目功能，并保留先审计后集成的边界；本片不合入 dev/main、不提交推送、不安装发布，也不接触真实用户数据库。协调负责检查，原执行任务负责装配代码。

## 唯一目标与输入

目标工作树：`.cindy-worktrees/project-core-rebase`，HEAD `1b18485d193812fa0a91a59939b0ab2aa2149707`。先读取实际状态与根/desktop AGENTS、Desktop开发、数据库迁移、Electron安全规则。已有未提交数据代码是输入，不可重置。数据作者当前仅做材料引用合同，当前数据字节冻结。

1. 基础M1/M2补丁：协调workspace `documents/2026-11-05-项目装配基础预检.patch`，SHA256 `BD0581E281E26F29463C378B2BCF8CD6884F095EB521EDAC5312DAE7E3947625`。69文件，已排除所有旧迁移、docs及目标已重建数据8文件；本轮再次 git apply --check 通过。应用前再次检查；不做整分支merge/cherry-pick。
2. 保留目标现有schema、0146/0147/0148及meta、共享projects/materials、事务projects/materials/progress、相应数据测试。先保存这些文件hash，装配前后核对；不从旧树覆盖这些文件。
3. m3-access 固定访问5文件与 W1 注册7文件：按实际源hash核对后覆盖对应基础版本；3个进度模块若目标已存在必须字节一致，仅检查不覆盖。`ipc/projects.ts` 使用新类型修复版 `DD0FCD8104643ACE7D8121919BB9AB72FA90120161332075068C666BF1215775`。W1其余hash见 `2026-11-05-project-progress-worker-wiring.md` 及协调续审记录/作者回执。
4. m2-materials-ui 的材料目录及测试使用 `artifacts/ui-check/materials-panel-WhdFlf/candidate-sha256.json` 的固定非locale文件；14项非locale已独立匹配。新建项目组件/测试与12语言后续增量以 `artifacts/ui-check/project-creator-member-ONfLAh/slice-files-sha256.json` 的After为准，14项已独立匹配。只把该树对 ProjectDetailPage.tsx/router.tsx 的材料入口增量应用到目标，不能覆盖上游无关更改。
5. m4-status 的进度组件、投影、测试、fixture与12语言增量，以 `apps/desktop/scripts/fixtures/project-progress/SHA256SUMS.txt` 为准，清单SHA256 `FDA6D590EC8097FA116EDC06622DD777FB995B3FF79385F18502F62C563E7AAC`，17项匹配。该组件仍只读，装配不能冒称生产读取已接通。

## 装配规则

- 每层记录来源hash、目标前后hash与文件清单。发现源漂移先核实，不读正在修改的候选。
- locale按原树HEAD→候选的语义增量合并：材料/创建表单与progress命名空间各自保留，目标其余key不变。不得整文件复制旧locale丢失新上游内容。
- 已存在且内容不匹配的文件，只在上述明确装配写域处理；未知脏文件不覆盖。保存准确diff供协调复核。
- 不重做产品设计、不做材料引用新schema、不实现进度新API，不用stub、any、删测试或放宽权限来通过检查。
- 必要的装配型修正允许：导入/类型衔接、真实生成迁移编号引用、测试fixture适配新可信actor契约。逐项说明；行为差异、权限缺口、需要改变冻结业务契约的修复退回原作者。
- 原切片工作树保持冻结。新的装配改动只写目标，防止再次分散成无法运行的多个候选。

## 必须实际检查

1. 完整 `pnpm --filter desktop typecheck`，以该目标整树结果为准，不替换成提取片段编译。
2. `db:validate`、migration replay 与项目/材料/进度/访问/dispatch定向回归。旧测试的迁移定位改为该目标真实产物，不能手工复制旧编号或降低断言。
3. 材料页面与快照、创建表单、进度组件的现有测试；root已有材料路由反例、表单→真实新事务联合反例可用于必要复验。
4. i18n结构、diff检查；全仓已知基线失败分列，不称全门禁通过。只在新增失败或集成改动影响时扩大测试。

交付唯一候选位置、所有装配文件及来源、真实输出、失败清单与未接线清单。本片成功意味着整树候选可继续接线和启动验收，不意味着完整项目管理已经完成。进度读写API/页面、材料多工作项引用、创建任务撤权竞态和后续业务流程分别保留，不能因编译通过静默关闭。
