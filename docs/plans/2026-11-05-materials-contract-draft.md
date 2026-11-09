# M2-A/B 契约：材料与版本（已冻结）

2026-11-05 · 用户已确认冻结（“按建议冻结契约”）。M1 三项审计已通过。契约冻结后 M2-A（主进程）与 M2-B（界面）并行。

## 0. 已冻结的三项决定

| 议题 | 决定 |
| --- | --- |
| 工作项载体 | 直接复用 `sessions.id` 作为 `work_item_id`（工作项 = 任务）；M4 再评估是否独立成表 |
| 去重范围 | 同一 `project_id` 内查重；跨项目不查重 |
| 移除语义 | 软状态 `status='removed'`，可追溯、可恢复；不提供硬删记录（只提供“清理已无引用字节”的后续能力） |

下游不得自行改变这三项；确有冲突先停下报告。

## 0.1 修订 A1（2026-11-05，M2-A 实现中发现）

**问题**：原文 R1 要求所有材料字节经 `cindy-media` 并持有 `media_ref`，但仓库规则明确规定媒体仓只收图片/音视频/3D，`docx`/`PDF`/`zip` 等非媒体不得入仓，且“不要仅为预览就复制一份”。文本与文档材料因此无法满足 R1。

**修订**：材料按真实字节分两种存储形态，**仍然只有一个媒体仓、不新增第二套字节存储**：

| 形态 | 判定 | 存储 | 引用 |
| --- | --- | --- | --- |
| `storage_kind='media'` | 图片/音视频/glb（命中 cindy-media 白名单） | `cindy-media` 内容寻址仓，写 blob + 记账 + 挂引用 | 受管 media ref |
| `storage_kind='file'` | 文本、PDF、Office、其他非媒体 | **不复制**，引用用户原文件；记录绝对路径、添加时计算的 sha256、size、mtime | 原路径，经既有 `xdt-file://` 受控通道预览 |

配套规则：

- R1 改为“不得把非媒体字节写入媒体仓，也不得为预览复制一份”；媒体形态仍必须经 cindy-media 单一写入者。
- `material_versions` 的 `media_ref` 改名为 `storage_ref`，新增 `storage_kind`；`READ` 失败原因区分 `SOURCE_MISSING`（原文件不存在）与 `SOURCE_CHANGED`（sha256 与添加时不一致）。
- `file` 形态在预览前必须重算 sha256；不一致即 `VERSION_NOT_READABLE`，并提示重新关联，不得用旧内容冒充。
- 不承诺 `file` 形态跨设备可用、不承诺原文件被删除后仍可读。

其余条款（版本不可变、去重、软移除、context 绑定）不变。

## 1. 数据模型

### materials（材料本体）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | text pk | |
| project_id | text not null | 指向 `projects.id` |
| work_item_id | text null | 工作项归属；null 表示项目级材料 |
| name | text not null | 用户原始文件名，只作展示 |
| status | text not null | `active` / `removed`（移除当前引用，非物理删除） |
| created_by_kind | text not null | `account` / `bot` |
| created_by_id | text not null | 稳定身份 ID |
| created_at / updated_at | integer not null | |

索引：`(project_id, status)`、`(work_item_id)`。

### material_versions（不可变版本）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | text pk | |
| material_id | text not null | |
| version | integer not null | 从 1 递增，`(material_id, version)` 唯一 |
| sha256 | text not null | 内容指纹，按真实字节 |
| size_bytes | integer not null | |
| mime | text not null | 按字节探测 |
| storage_kind | text not null | `media` / `file`（见 0.1） |
| storage_ref | text not null | `media`：cindy-media 引用；`file`：绝对路径 |
| source_mtime | integer null | 仅 `file` 形态，用于判断原文件是否被改动 |
| read_state | text not null | `pending` / `ready` / `failed` |
| failure_reason | text null | 含 `SOURCE_MISSING` / `SOURCE_CHANGED` / 解析失败原因 |
| created_by_kind / created_by_id | text not null | |
| created_at | integer not null | |

索引：`(material_id, version)` 唯一、`(sha256)`（项目范围内查重用）。

### material_contexts（参考快照，不可变）

| 列 | 类型 | 说明 |
| --- | --- | --- |
| id | text pk | |
| work_item_id | text not null | |
| purpose | text not null | `reference` / `redecompose` / `recheck` |
| refs_json | text not null | `[{materialId, version, readStateAtPin}]` |
| created_by_kind / created_by_id | text not null | |
| created_at | integer not null | |

执行与候选验收只记录 `material_context_id`，不记录"当前材料"，从而保证后补版本不倒改旧依据。

## 2. 行为规则（服务层强制）

| 编号 | 规则 |
| --- | --- |
| R1 | 字节写入单一化：媒体形态必须经 cindy-media（写 blob + 记账 + 挂引用）；非媒体（文本/PDF/Office 等）**不得**写入媒体仓，也不得为预览复制一份，只引用用户原文件并记录 sha256/size/mtime（见 0.1）。DB 只存 `storage_kind`、`storage_ref`、`sha256`、`size`、`mime`，禁止 base64 |
| R2 | 类型以字节探测为准；探测失败即 `read_state=failed`，不得标成已读，也不得伪称正文已解析 |
| R3 | 版本不可变。新内容一律新 `version`；同 `sha256` 且项目内当前可读 → 提示沿用，默认不新建 |
| R4 | 同名不同内容不覆盖：必须由用户显式选"新建材料"或"原材料的下一版本"，未选不落库 |
| R5 | 移除当前引用只改 `status`，不删字节；旧 `version` 与旧 `context` 保持可追溯 |
| R6 | 材料版本持有媒体引用并 pin；recycler 不得回收仍被旧 context 引用的字节；删除时只删本业务名下引用 |
| R7 | 读取失败可重试，重试更新同一 `version` 的 `read_state`，不新建版本 |
| R8 | 所有预览走既有 `filePreview` 通道，不新开文件读取旁路；权限判定留给 M3，M2 只保证不绕过通道 |

## 3. IPC 契约

通道前缀沿用仓库约定 `local-db:`，失败统一 `throw new Error("[CODE] message")`。

| 通道 | 请求 | 响应 |
| --- | --- | --- |
| `local-db:materials:list` | `{projectId, workItemId?}` | `{materials: Material[]}`，含每个 material 的版本与当前 readState |
| `local-db:materials:add` | `{projectId, workItemId?, files: [{name, path}]}` | `{added: MaterialVersion[], duplicates: [{name, materialId, version}], rejected: [{name, code}]}` |
| `local-db:materials:add-version` | `{materialId, file: {name, path}, replaceCurrentReference?: boolean}` | `{version: MaterialVersion}` |
| `local-db:materials:remove-reference` | `{materialId}` | `{ok: true, status: 'removed'}` |
| `local-db:materials:retry-read` | `{materialId, version}` | `{version: MaterialVersion}` |
| `local-db:materials:preview` | `{materialId, version}` | `{kind: 'image'|'text'|'unsupported', url?, text?, name, mime, size}` |
| `local-db:material-contexts:create` | `{workItemId, purpose, refs: [{materialId, version}]}` | `{context: MaterialContext}` |
| `local-db:material-contexts:list` | `{workItemId}` | `{contexts: MaterialContext[]}` |

错误码：`MATERIAL_NOT_FOUND`、`VERSION_NOT_FOUND`、`VERSION_NOT_READABLE`、`DUPLICATE_CONTENT`、`UNSUPPORTED_FILE`、`MEDIA_WRITE_FAILED`、`SOURCE_MISSING`、`SOURCE_CHANGED`、`PROJECT_NOT_FOUND`。

约定：`add` 是批量接口，逐项返回三类结果，任何一项失败不整批回滚已成功项；界面按 `rejected` 逐项提示与重试。

## 4. 验收（M2）

| ID | 操作 | 预期 |
| --- | --- | --- |
| A1 添加 | 选两个文件加入同一工作项 | 各生成 material + v1；`read_state` 真实反映读取结果 |
| A2 同内容沿用 | 同字节改文件名重添 | 返回 `duplicates` 并提示沿用，不新增 material |
| A3 同名异内容 | 同名不同字节重添 | 需显式选择，未选择不落库；选择"新版本"后 v2 存在且 v1 不变 |
| A4 版本不可变 | 对已有材料补 v2，查看旧 context | 旧 context 仍指 v1，v2 不顶替 |
| A5 移除引用 | 移除当前引用后打开旧 context | 旧 context 仍标 v1 并说明当前可读性；字节未被删除 |
| A6 失败重试 | 造一个读取失败项并重试 | 同一 version 的 `read_state` 更新，不新增版本 |
| A7 预览 | 图片、UTF-8 文本、其他格式各一 | 图片真解码、文本真内容、其他给"不支持正文"且不伪造 |
| A8 绑定不漂移 | 用 context 绑定执行/候选，之后补 v2 | 旧绑定仍是 v1 |
| A9 持久与回收 | 重启；触发一次回收 | 记录仍在；被 context 引用的字节未被回收 |

## 5. 冻结状态

已冻结。三点决定见第 0 节。M2-A / M2-B 只能按本文件实现；需要偏离时先停下报告，不得自行改动契约。
