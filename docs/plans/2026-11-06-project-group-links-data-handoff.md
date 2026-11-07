# 群—项目关联 B：本地数据片交接

2026-11-06。独立 project-group-link-data 分支，基线 1b18485d193812fa0a91a59939b0ab2aa2149707。只实现本地意图／回执、两表、worker 和生成迁移；没有 A 群权限适配、main/public 注册、preload、群发送或 UI。

输入：外部冻结的《2026-11-06-群项目关联持久化最小合同.md》，SHA256 F845E00D0B0B06CD621871C74749BEEB38FCC0DF10ACB776E027CA93320CE0B1。依赖从 R1 固定回执 2D7DC7D2AC7308704D14C0D1A8ECD0EA7FCE2696C7367E75C1EE7817CE4F77C8 的 23 文件白名单逐 hash 继承，不复制 resolver 旧 0148 链，不读 I1 进行中字节。

## 固定共享合同（先行给 C/UI）

[projectGroupLinks.ts](../../apps/desktop/src/shared/projectGroupLinks.ts) SHA256：76B3F8A1B758A9356430EAFAF28DE3E44493E0B446CCF538273079E7C531EF6D。先行回传后未修改。

```ts
parseProjectGroupLinksIntent(value: unknown): ProjectGroupLinksIntent | null
normalizeProjectGroupLinkEndpoint(value: unknown): string | null
// intent.action = 'list' | 'link' | 'unlink'
// group = { endpoint, roomId }
// target = { accountId, deviceId, projectId }
```

- list：group、includeRemoved?、cursor?、limit?（默认 50，上限 100）。
- link：requestId、group、target、显式 expectedRevision；首次创建 0。
- unlink：link 的身份/CAS 字段，加 relationId。
- list 成功：ok、contractRevision:1、links、nextCursor；无过滤总数或隐藏数量。
- mutation 成功：ok、contractRevision:1、requestId、replayed、change、commit={relationId,revision,statusAtCommit}、current=当前 ProjectGroupLink。
- current/list row 仅 relationId/group/target/status/revision/createdAt/updatedAt。时间是 ISO 字符串；不含标题、成员、材料、路径或授权对象。
- failure 共享模型含固定 errorCode/message/commitState。worker 拒绝抛固定码通用异常；main 根据实际 ACK／传输结果生成 failure，不能将未知提交冒称未提交。

public parser 严格拒绝 actor/grant/canManage/ownerVerified 等未知字段；不接受缺 revision、非法整数、非 UUID 房间、超长定位、凭据/query/fragment URL。endpoint 使用既有配置 parser 的 trim/去尾斜杠，路径不转小写；仅 UUID 房间作小写规范化，设备 ID 保留不透明字符串。不声明服务器有任何新能力。

## Worker 精确接口与可信边界

[projectGroupLinksTx.ts](../../apps/desktop/src/main/localDb/worker/opHandlers/projectGroupLinksTx.ts)：

```ts
runProjectGroupLinksTransaction(db: Database.Database, raw: unknown): ProjectGroupLinksResult
interface ProjectGroupLinksTxContext {
  actor: { kind: 'account' | 'bot'; id: string };
  accountId: string; deviceId: string;
  group: { endpoint: string; roomId: string };
  now: number;
}
// envelope = { intent, context, newRelationId? }
```

context 是封闭 main 的身份／资源／目标群绑定输入，不是 group grant，不向 public 暴露。link 每次必须提供 main 新分配的 newRelationId，已有关系／恢复／重放时可以不用这个 ID；list/unlink 不接受它。worker 拒绝 context 中额外的 grant／canManage 等字段。

**B 不验证真实账号登录、设备在线或远端群配置权限**：它依赖 main 捕获真实 actor、DB owner、设备身份和 A 已校验的群。worker 只检查 public target/group 与该可信 context 完全一致，并在同一 SQLite immediate transaction 里核项目 owner 的精确 kind/id。测试中换 context 是模拟受控资源身份，不是证明 SQLite 能鉴权另一账号。public 不能直达这个事务；A/C/唯一集成者未封闭入口并实现刷新前，不开放写操作。

事务 self-contained，运行期无外部 helper 捕获，兼容现有 inline/native worker 装载方式。测试实际将同一函数序列化后再执行并与正常调用重放对接；没有修改中央 dispatcher/client types/WorkerThreadTransport 或公共注册。以后由唯一集成者注册独立事务名，不让 renderer 或工具参数传 context。

## 两表与迁移

Drizzle 命令 pnpm --filter desktop db:generate 生成 [0150_curvy_bloodstrike.sql](../../apps/desktop/drizzle/0150_curvy_bloodstrike.sql)、0150 snapshot 和 journal 新条目；纯 DDL，无新 companion，不手改 SQL/journal/序号。重新 fetch 后 origin/main 仍为指定基线。0146..0149 SQL/snapshot/companion 原字节不动。

| 表 | 结构与约束 |
| --- | --- |
| project_group_links | 14 列：id、resource_account_id/device_id、project_id、group_endpoint/room_id、status、revision、created/updated_by_kind/id、created/updated_at。完整五元键唯一；group+status+id 读取索引和 project+status 索引；project 外键不级联删历史；状态/角色枚举及 revision 1..MAX_SAFE_INTEGER CHECK |
| project_group_link_requests | 9 列：actor_kind/id/request_id 复合主键、canonical_intent、relation_id、commit_revision、status_at_commit、change、created_at。关系外键不级联；按 relation/revision 索引；状态/角色/change/revision CHECK。成功请求账本不含私有正文或群授权快照 |

唯一键包含资源账号、设备、项目、规范 endpoint 与 UUID room；不是全群服务器关系库。不存 threadRootId 或工作项绑定：关系是项目级，工作项卡仍由其固定 locator/bindingRevision 与 resolver 校验。没有从旧 projectDir、群名字或工作目录推导关联，新表初始为空。

## 权限、CAS、重放和分页

1. main-only context 与 public scope 相等后，变更首先 JOIN projects/project_members，要求精确 kind/id 的 owner。缺项目／缺成员／同 ID 不同 kind 或 demotion 均拒绝；不使用 projects.owner_id 字符串补权。
2. 然后查当前 actor 的 requestId 账本。同一规范意图返回历史 commit 与当前关系；不同意图 REQUEST_CONFLICT。命中重放不再次要求旧 expectedRevision 等于最新 revision，但始终重新核 owner。
3. 未命中才做 CAS。创建显式 0；修改匹配当前 revision。状态变化才递增；同状态有效 CAS 返回 unchanged、关系 revision 不变，但登记一次成功请求。
4. link r1 → unlink r2 → 重放旧 link，commit 仍 active/r1，current 必须 removed/r2。新 requestId+expectedRevision=2 才恢复原 relationId 到 r3。旧 unlink 回执也不能删掉后来的 r3。
5. 关系更新和请求账本同事务；账本 INSERT 失败时关系也回滚。worker 只存已成功本地提交结果；外部 ACK 丢失后同意图重放恢复，不产生第二次状态变化。
6. list 在 SQL JOIN 当前精确成员并过滤后才 LIMIT+1；默认 active owner/member，includeRemoved 仅当前 owner。无隐藏计数；游标只取最后可见行，绑定账号/设备/endpoint/room/actor/includeRemoved，不能当权限。它是有界 base64url 元数据，不是密文或授权 token；每页重新鉴权。

测试证明的是本地事务与读快照。群权限必须由 A/main 真实检查；它与本地 COMMIT 不在同一个远端事务。B 的成功不等于当前群仍允许配置，也不表示发布、群消息或执行已成功。main 在提交前后都要刷新来源／owner/群权限；实际 committed/unknown 必须如实交付，不应盲目补偿删除别人的新 revision。

## 验证与输入保护

- public parser 14 项；worker/真实 SQLite 19 项；与固定材料/项目/B1/状态测试合计 169/169，3.00s。
- 完整 migration replay 31/31，22.05s（迁移 tier）。新增用例从实际 0149 升级，制造部分 DDL 失败，验证回滚/重试，再关闭重开文件 DB 重放丢 ACK 的旧 link，保留 removed/r2，最后新请求恢复 r3。
- db:validate 6/6；完整 Desktop typecheck exit 0、lint、文档检查 10/10 和测试卫生检查通过。完整产物指纹随固定 manifest 提供。
- 首次回放 5 项因旧测试预期止于 0149 而失败，只补齐预期中的 0150，没有删除或弱化旧数据断言。
- 23 个继承输入中仅本候选 schema（追加两表）、journal（Drizzle 追加）与 migrationReplay.test.ts（新用例/头部序列适配）发生允许的增量；其余 20 文件 hash 不变。旧冻结工作树全部只读。

本片含真实内存及隔离临时文件 SQLite、生产 worker/项目事务和实际生成迁移；没有账号凭据、真实群、模型或用户库。没有真实并发 worker/network ACK 故障测试；顺序竞争 CAS、丢 ACK 后的持久重放和实际重启回放分别测，不能冒称远端 exactly-once。

下一步由 A/C 校验实际群权限、构建可信 context、处理 owner/input/lease 与 DB 回包变化，UI 只消费固定 public 模型；唯一集成者接 dispatcher/preload/发现出口。关系不授 ACL，普通 @ 讨论不受影响，不派发执行。作者自查不等于验收，本片只冻结本地数据合同。
