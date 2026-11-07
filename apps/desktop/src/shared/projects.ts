/**
 * 项目内核 v1（M1）跨进程契约。
 *
 * 项目是 Cindy 的一等实体：`projects` + `project_members` 落库，任务用
 * `sessions.project_id` 绑定项目，用 `assignee_kind` / `assignee_id` 记录处理人。
 * 旧的「按 workingDir 归组」完全保留——`project_id` 为空的任务继续走
 * `project_dir ?? working_dir` 分组，不做回填。
 *
 * 规则由 main 的服务层（`worker/opHandlers/projectsTx.ts` + `ipc/projects.ts`）
 * 强制，renderer 只读投影：
 *   - 负责人必须是成员且唯一；移除负责人必须先转交。
 *   - 处理人为空 = 未分配，绝不由负责人推断；非成员不可被指派。
 *   - 成员按稳定 ID 去重，`subject_kind` 显式区分账号与伙伴。
 *   - 删除项目是真删除，只有负责人可发起；项目自身的记录一并清掉，任务与自动化只置为
 *     「无项目」。成员数量等业务数据不设上限（字段长度校验保留）。
 */

/** 项目内的主体命名空间。账号 id 与伙伴 id 可能撞字符串，靠 kind 区分。 */
export type ProjectSubjectKind = 'account' | 'bot';

export type ProjectStatus = 'active' | 'archived';

export type ProjectMemberRole = 'owner' | 'member';

export interface ProjectSubjectRef {
  kind: ProjectSubjectKind;
  id: string;
}

export interface ProjectSubject extends ProjectSubjectRef {
  /**
   * 展示名。伙伴由 main 从 `bot_profiles.display_name` 解析；账号主体为 null，
   * 由 renderer 用当前登录账号资料补全（main 不持有账号昵称）。
   */
  displayName: string | null;
  /** 伙伴头像 emoji / 颜色；账号主体为 null。 */
  avatar: string | null;
  avatarColor: string | null;
}

export interface ProjectMember {
  subject: ProjectSubject;
  role: ProjectMemberRole;
  addedAt: string;
}

/**
 * 项目目录：把「按工作目录归组」的目录认领到项目上。
 *
 * 身份只用 `dirKey`（`local:<path>` / `remote:<host>:<path>` / `device:<id>:<path>`，
 * 与侧栏分组同一个口径）；`dirPath` 只用于展示，不参与判定。一个目录同时只能属于
 * 一个项目，由 `uniq_project_dirs_dir_key` 保证；项目可以有多条目录。
 */
export interface ProjectDir {
  dirKey: string;
  dirPath: string;
}

export interface ProjectRecord {
  id: string;
  name: string;
  goal: string | null;
  ownerId: string;
  status: ProjectStatus;
  members: ProjectMember[];
  /** 绑定到本项目的任务数（不含已删除任务）。 */
  taskCount: number;
  /** 认领的工作目录；在该目录下新建的任务默认归属本项目。 */
  dirs: ProjectDir[];
  createdAt: string;
  updatedAt: string;
}

/** 工作项 = 绑定到该项目的任务（`sessions.project_id`）。 */
export interface ProjectWorkItem {
  sessionId: string;
  title: string;
  status: string;
  /** null = 未分配。不会回落到项目负责人。 */
  assignee: ProjectSubject | null;
  updatedAt: string;
}

export interface ProjectDetail {
  project: ProjectRecord;
  workItems: ProjectWorkItem[];
}

export interface ProjectCreateInput {
  name: string;
  goal?: string | null;
  /** 负责人；缺省由 main 填成当前账号。 */
  owner?: ProjectSubjectRef;
  /** 其余成员。负责人会被去重剔除，不会重复插入。 */
  members?: ProjectSubjectRef[];
  /** 要认领的工作目录；已被别的项目认领的目录会让整次创建失败。 */
  dirs?: ProjectDir[];
}

/**
 * 项目写操作（renderer → main 的线上形状）。一次只带一个 action。
 *
 * id 与时间戳**不在**这里：main 侧 `toMutation` 注入 `newId` / `now`，事务保持确定性，
 * renderer 也就无从伪造时间或覆盖别人的项目 id。
 */
export type ProjectsAction =
  | { action: 'create'; input: ProjectCreateInput }
  | {
      action: 'update';
      projectId: string;
      name?: string;
      goal?: string | null;
      status?: ProjectStatus;
    }
  | { action: 'addMember'; projectId: string; subject: ProjectSubjectRef }
  | { action: 'removeMember'; projectId: string; subject: ProjectSubjectRef }
  | { action: 'transferOwner'; projectId: string; subject: ProjectSubjectRef }
  /** 认领一个工作目录。只能认领未被别的项目认领的目录。 */
  | { action: 'addDir'; projectId: string; dirKey: string; dirPath: string }
  | { action: 'removeDir'; projectId: string; dirKey: string }
  | { action: 'bindSession'; sessionId: string; projectId: string | null }
  | { action: 'setAssignee'; sessionId: string; assignee: ProjectSubjectRef | null }
  /**
   * 真删除（不做软删）。只有负责人可删；成员、材料、群关联、进度记录一并清掉，
   * 任务与自动化保留但置为「无项目」。级联范围见 `projectsTx.ts` 的 delete 分支。
   */
  | { action: 'delete'; projectId: string };

/** 事务参数 = action + main 注入的 id / 时间戳。 */
// Main-only envelope: actor must come from host identity after rebuilding the client intent.
export type ProjectsMutation = ProjectsAction & { actor: ProjectSubjectRef; now: number; newId?: string };

export interface ProjectsMutationResult {
  ok: true;
  projectId: string | null;
  /** 受影响的任务（bindSession / setAssignee），main 用它广播任务补丁。 */
  sessionId: string | null;
  /**
   * 被 delete 解绑的任务 id。任务本身保留，只是回到「无项目」分组；main 逐个广播
   * 任务补丁，避免侧栏与其他窗口继续显示一个已经不存在的项目。
   */
  unboundSessionIds?: string[];
}

export const PROJECTS_CHANGED_CHANNEL = 'local-db:projects:changed';

export const PROJECTS_LIST_CHANNEL = 'local-db:projects:list';
export const PROJECTS_DETAIL_CHANNEL = 'local-db:projects:detail';
export const PROJECTS_MUTATE_CHANNEL = 'local-db:projects:mutate';

/** 项目名上限：侧栏单行可读，同时挡住误把整段说明粘进名称。 */
export const PROJECT_NAME_MAX_LENGTH = 120;
export const PROJECT_GOAL_MAX_LENGTH = 2000;
/** 目录键上限：Windows 长路径 + 远端前缀仍留足余量，只挡异常超长输入。 */
export const PROJECT_DIR_KEY_MAX_LENGTH = 4096;
export const PROJECT_DIR_PATH_MAX_LENGTH = 4096;

export function isProjectSubjectKind(value: unknown): value is ProjectSubjectKind {
  return value === 'account' || value === 'bot';
}

export function isProjectStatus(value: unknown): value is ProjectStatus {
  return value === 'active' || value === 'archived';
}

/** 只比较身份，不比较展示名——成员去重的唯一口径。 */
export function projectSubjectKey(subject: ProjectSubjectRef): string {
  return `${subject.kind}:${subject.id}`;
}
