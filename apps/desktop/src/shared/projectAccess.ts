/**
 * 项目级访问判定（M3-A）纯函数。
 *
 * 契约正本：`docs/plans/2026-11-05-project-core-m3-m4.md` §1 M3-A。规则只有一条主线：
 * **成员身份决定能不能看、能不能写**，负责人再决定能不能改成员。
 *
 *   - 非成员：一律不可看——项目详情、工作项、材料列表、材料预览都不返回正文、文件名、
 *     sha256 或 `storageRef`。
 *   - 成员：可看，可建任务（绑项目）、可设处理人、可加材料。
 *   - 负责人：额外可增删成员、转交负责人，以及改项目元数据（改名 / 目标 / 归档）与删除项目。
 *
 * 这里只做判定，不碰 IPC、DB 与错误抛出：调用方自己决定「拒绝」是返回空集合还是报
 * `NOT_PROJECT_MEMBER` / `NOT_PROJECT_OWNER`（`projectAccessErrorCode`）。
 *
 * 「主体」是 `{kind, id}`：账号与伙伴的 id 字符串可能撞车，所以比较必须带 `kind`，
 * 只看 id 会把同名的另一个主体当成成员。空主体（未登录 / 未传）永远是 `none`——
 * **绝不因为「没传身份」就当成负责人**。
 */

import type { ProjectMemberRole, ProjectSubjectRef } from './projects';

/** 判定结论。`none` = 非成员，`member` = 普通成员，`owner` = 负责人。 */
export type ProjectAccessLevel = 'none' | 'member' | 'owner';

/** 判定只需要 (kind, id, role)：`ProjectMember` 与 `project_members` 行都能直接喂进来。 */
export interface ProjectAccessMember extends ProjectSubjectRef {
  role: ProjectMemberRole;
}

/** 判定所需的项目快照；不读其它字段，避免判定依赖展示数据。 */
export interface ProjectAccessProject {
  ownerId: string;
  members: readonly ProjectAccessMember[];
}

/**
 * 项目动作。名字按「动作语义」而不是按 IPC channel 起：
 * `manageMaterials` 同时覆盖加材料、补版本、移除引用与重试读取。
 */
export type ProjectAccessAction =
  | 'viewProject'
  | 'readWorkItems'
  | 'readMaterials'
  | 'previewMaterial'
  | 'manageWorkItems'
  | 'manageMaterials'
  | 'updateProject'
  | 'addMember'
  | 'removeMember'
  | 'transferOwner'
  /** 删除整个项目（真删除）：项目级设置，只有负责人能做。 */
  | 'deleteProject'
  /** 认领 / 取消工作目录会改变此后新任务的默认归属，属于项目级设置。 */
  | 'manageDirs';

/**
 * 动作 → 所需角色（最小权限约定）。
 *
 * 成员能做的只有「看 + 推进工作」：建任务、绑项目、设处理人、加材料。
 * 改成员、转交负责人、改项目元数据（含归档）都是项目级设置，只有负责人能做。
 */
const ACTION_ACCESS: Record<ProjectAccessAction, Exclude<ProjectAccessLevel, 'none'>> = {
  viewProject: 'member',
  readWorkItems: 'member',
  readMaterials: 'member',
  previewMaterial: 'member',
  manageWorkItems: 'member',
  manageMaterials: 'member',
  updateProject: 'owner',
  addMember: 'owner',
  removeMember: 'owner',
  transferOwner: 'owner',
  deleteProject: 'owner',
  manageDirs: 'owner',
};

/** 该动作需要的最低角色。未知动作按最严处理（负责人），避免新动作默认放行。 */
export function requiredAccess(action: ProjectAccessAction): ProjectAccessLevel {
  return ACTION_ACCESS[action] ?? 'owner';
}

/** 拒绝该动作时应报的错误码；两块 IPC 都靠它保证语义一致。 */
export function projectAccessErrorCode(
  action: ProjectAccessAction,
): 'NOT_PROJECT_MEMBER' | 'NOT_PROJECT_OWNER' {
  return requiredAccess(action) === 'owner' ? 'NOT_PROJECT_OWNER' : 'NOT_PROJECT_MEMBER';
}

function isUsableSubject(
  subject: ProjectSubjectRef | null | undefined,
): subject is ProjectSubjectRef {
  return (
    !!subject &&
    (subject.kind === 'account' || subject.kind === 'bot') &&
    typeof subject.id === 'string' &&
    subject.id.length > 0
  );
}

function isSameSubject(
  member: ProjectSubjectRef,
  subject: ProjectSubjectRef,
): boolean {
  // kind 必须一起比：账号与伙伴的 id 命名空间是分开的。
  return member.kind === subject.kind && member.id === subject.id;
}

/** Membership (kind, id, role) is authoritative; a missing owner row grants no ownership. */
export function projectRoleOf(
  project: ProjectAccessProject,
  subject: ProjectSubjectRef | null | undefined,
): ProjectAccessLevel {
  if (!isUsableSubject(subject)) return 'none';
  const member = project.members.find((candidate) => isSameSubject(candidate, subject));
  if (!member) return 'none';
  if (member.role === 'owner') return 'owner';
  return 'member';
}

/**
 * 能不能看这个项目。只看成员表——负责人一定是成员，所以不需要额外的负责人分支。
 * 空主体返回 false：未登录或没传身份的调用方不是成员。
 */
export function canViewProject(
  members: readonly ProjectAccessMember[],
  subject: ProjectSubjectRef | null | undefined,
): boolean {
  if (!isUsableSubject(subject)) return false;
  return members.some((member) => isSameSubject(member, subject));
}

/** 能不能写这个项目（建任务 / 设处理人 / 加材料）：成员即可。 */
export function canManageProject(
  project: ProjectAccessProject,
  subject: ProjectSubjectRef | null | undefined,
): boolean {
  return projectRoleOf(project, subject) !== 'none';
}

/** 能不能改成员与转交负责人：只有负责人。 */
export function canEditMembers(
  subject: ProjectSubjectRef | null | undefined,
  project: ProjectAccessProject,
): boolean {
  return projectRoleOf(project, subject) === 'owner';
}

/**
 * 能不能设处理人。成员级权限；被指派的人是否也是成员由事务层另外强制
 * （`ASSIGNEE_NOT_MEMBER`），两件事不能合并成一次判定。
 */
export function canAssign(
  subject: ProjectSubjectRef | null | undefined,
  project: ProjectAccessProject,
): boolean {
  return projectRoleOf(project, subject) !== 'none';
}

/** 动作级判定：`requiredAccess` 与 `projectRoleOf` 的唯一组合口径。 */
export function canPerformProjectAction(
  action: ProjectAccessAction,
  project: ProjectAccessProject | null | undefined,
  subject: ProjectSubjectRef | null | undefined,
): boolean {
  if (!project) return false;
  const role = projectRoleOf(project, subject);
  if (role === 'none') return false;
  return requiredAccess(action) === 'owner' ? role === 'owner' : true;
}
