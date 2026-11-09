/**
 * 自动化绑定项目实体：**唯一**的判定口径。
 *
 * 规格见 `docs/plans/2026-11-06-automation-project-binding.md`。三处调用点必须是同一套
 * 判定，不能各写一份：
 *   1. `Scheduler` 的 `validateProjectBinding` 钩子 —— 创建/更新时拒绝非成员、已归档；
 *   2. runner 每次 fire 前 —— 保存之后项目被归档或成员被移除，本轮必须失败并留下原因；
 *   3. 会话落库的授权事务（`authorizedSessionCreateTx`）—— 真正写入时的原子兜底。
 *
 * 判定主体是**当前登录账号**：本地库就是该账号的库，定时任务也只属于它。空主体
 * （未登录 / 账号切换中）一律拒绝，绝不因为「没传身份」就当成有权限。
 *
 * 这里只做判定与错误构造，不做写入；错误码复用项目内核既有错误码，UI 可以按码
 * 给出本地化文案（`features/scheduler/lib/scheduleProjectErrors.ts`）。
 */

import { and, eq } from 'drizzle-orm';

import { createIpcError } from '../../shared/ipc-errors';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { projectMembers, projects } from '../localDb/schema';

import type { SchedulerDrizzleDb } from './storage';

export interface ScheduleProjectBindingActor {
  /** 与 `project_members.subject_kind` 同口径；自动化只以登录账号身份运行。 */
  kind: 'account';
  id: string;
}

/** 记忆一次判定的结果，方便调用方把「为什么被拒」原样交给用户。 */
export type ScheduleProjectBindingVerdict =
  | { ok: true; projectId: string }
  | { ok: false; code: 'PROJECT_NOT_FOUND' | 'PROJECT_ARCHIVED' | 'NOT_PROJECT_MEMBER' | 'ACCOUNT_UNAVAILABLE'; message: string };

/** 当前账号主体；未登录 / 账号边界切换中返回 null。 */
export function currentScheduleProjectActor(): ScheduleProjectBindingActor | null {
  const userId = getCurrentDbClientSnapshot()?.userId;
  return userId ? { kind: 'account', id: userId } : null;
}

function rejection(
  code: Extract<ScheduleProjectBindingVerdict, { ok: false }>['code'],
  message: string,
): ScheduleProjectBindingVerdict {
  return { ok: false, code, message };
}

/**
 * 判定某个项目现在能不能接收自动化运行。
 *
 * 顺序是「存在 → 未归档 → 是成员」：项目不存在和不属于你必须是两种回答，
 * 否则用户看到「不是成员」会去申请人，而项目其实已经没了。
 */
export async function checkScheduleProjectBinding(
  db: SchedulerDrizzleDb,
  projectId: string,
  actor: ScheduleProjectBindingActor | null = currentScheduleProjectActor(),
): Promise<ScheduleProjectBindingVerdict> {
  const id = projectId.trim();
  if (!id) return rejection('PROJECT_NOT_FOUND', 'Automation project binding is empty');
  if (!actor) {
    return rejection(
      'ACCOUNT_UNAVAILABLE',
      'Automation project binding needs a signed-in account; sign in and retry',
    );
  }
  const [project] = await db
    .select({ status: projects.status })
    .from(projects)
    .where(eq(projects.id, id))
    .limit(1);
  if (!project) {
    return rejection('PROJECT_NOT_FOUND', 'This project no longer exists');
  }
  if (project.status !== 'active') {
    return rejection('PROJECT_ARCHIVED', 'This project is archived; restore it before binding an automation');
  }
  const [member] = await db
    .select({ role: projectMembers.role })
    .from(projectMembers)
    .where(and(
      eq(projectMembers.projectId, id),
      eq(projectMembers.subjectKind, actor.kind),
      eq(projectMembers.subjectId, actor.id),
    ))
    .limit(1);
  if (!member) {
    return rejection(
      'NOT_PROJECT_MEMBER',
      'Binding an automation requires project membership; ask the project owner to add you',
    );
  }
  return { ok: true, projectId: id };
}

/**
 * 拒绝码 → IPC 错误码，让 renderer 能按码给**不臆测**的文案。
 *
 * 四个起因必须各自成一个码：项目没了、项目归档、不是成员、账号不可用。压成
 * `PRECONDITION_FAILED` 会让「账号切换中」显示成「项目已归档」，把用户骗去恢复一个
 * 根本没归档的项目（与会话创建那里「别把账号切换报成非成员」同一类问题）。
 */
function ipcCodeFor(code: Extract<ScheduleProjectBindingVerdict, { ok: false }>['code']) {
  switch (code) {
    case 'PROJECT_NOT_FOUND':
      return 'PROJECT_NOT_FOUND' as const;
    case 'NOT_PROJECT_MEMBER':
      return 'NOT_PROJECT_MEMBER' as const;
    case 'PROJECT_ARCHIVED':
      return 'PROJECT_ARCHIVED' as const;
    case 'ACCOUNT_UNAVAILABLE':
      return 'ACCOUNT_UNAVAILABLE' as const;
  }
}

/**
 * 创建/更新路径的断言：通过则什么都不做，被拒则抛出带 IPC 错误码的 Error，
 * 让 GUI / MCP 两条入口都拿到同一条可读原因。
 */
export async function assertScheduleProjectBinding(
  db: SchedulerDrizzleDb,
  projectId: string,
  actor?: ScheduleProjectBindingActor | null,
): Promise<void> {
  const verdict = await checkScheduleProjectBinding(db, projectId, actor);
  if (verdict.ok) return;
  throw createIpcError(ipcCodeFor(verdict.code), verdict.message);
}

/**
 * runner fire 路径的断言：返回可读原因而不是直接抛，调用方要先把原因写成
 * `schedule_runs.error_msg` 并投递失败通知，再让本轮失败（不能只记日志）。
 */
export async function describeScheduleProjectRejection(
  db: SchedulerDrizzleDb,
  projectId: string,
): Promise<string | null> {
  const verdict = await checkScheduleProjectBinding(db, projectId);
  return verdict.ok ? null : verdict.message;
}

/**
 * 会话授权插入被项目绑定门拦下的错误形状。
 *
 * `authorizedSessionCreateTx` 抛的是 `[FORBIDDEN] Session creation rejected` /
 * `[PRECONDITION_FAILED] Session creation rejected`（同一事务里复核成员资格与项目
 * 状态），这里把它翻回运行期复核用的同一条可读原因，避免用户看到只有内部码的报错。
 */
const SESSION_CREATE_REJECTED_ERROR = /^\[(FORBIDDEN|PRECONDITION_FAILED)\] Session creation rejected/;

export function isProjectBindingRejection(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error ?? '');
  return SESSION_CREATE_REJECTED_ERROR.test(message);
}

/**
 * 落库事务拒绝时的**兜底**措辞：只在没法按同一份判定重查时使用（如账号边界切换中读不到库）。
 *
 * 刻意不点名「不是成员」或「已归档」：事务只回 FORBIDDEN / PRECONDITION_FAILED，
 * 前者也可能是账号已不可用，后者也可能不是归档。说不准就说不准，别把用户引去恢复
 * 一个没归档的项目。
 */
export function projectBindingRejectionMessage(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error ?? '');
  const code = SESSION_CREATE_REJECTED_ERROR.exec(message)?.[1];
  if (code === 'FORBIDDEN') {
    return 'the current account is no longer allowed to write into this project';
  }
  if (code === 'PRECONDITION_FAILED') {
    return 'the project no longer accepts new tasks from this automation';
  }
  return message;
}
