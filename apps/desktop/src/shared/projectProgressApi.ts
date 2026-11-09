import type { WorkItemStatus } from './workItemStatus';
import type { WorkItemProgressRecord } from './workItemProgress';

/** Renderer intent only; identity is supplied separately by main. */
export interface ProjectProgressReadRequest {
  projectId: string;
  beforeEventId?: number;
}

export interface ProjectProgressReadContext {
  actor: { kind: 'account' | 'bot'; id: string };
}

/** Structurally compatible with the read-only view, without importing renderer code. */
export interface ProjectProgressApiItem {
  sessionId: string;
  projectId: string;
  title: string;
  sessionStatus: string;
  bindingRevision: number;
  progress: WorkItemProgressRecord | null;
  /**
   * 这项工作项的处理人（`sessions.assignee_kind` / `assignee_id`）。
   *
   * **必填且绝不回落负责人**：`null` 就是明确的「未分配」，不是「没读到」。
   * 只给 kind/id，名字由消费方按自己的已知主体解析（main 没有账号昵称的权威来源）；
   * 解析不到名字时显示 id，不猜一个像人名的东西。
   */
  assignee: { kind: 'account' | 'bot'; id: string } | null;
  /**
   * 这个工作项是不是某条自动化运行时创建的，以及是哪条自动化。
   * 反查口径：`schedule_runs.session_id` → `schedules`，且该 schedule 的
   * `schedules.project_id` 与本项目一致。null = 不是自动化创建（或来源自动化已被删除）。
   * 只有真实会话才会命中：没有会话就没有 run 行，也就不会出现这个标记。
   *
   * **刻意可选**：来源是"可能没有"的附加信息，不是每条工作项都必须作答的字段。
   * 写成必填会逼所有生产者（含历史夹具、手机端投影、旧宿主）显式传 null，以后每加一个
   * 可选来源都要再改一遍夹具。消费侧一律按"缺省 = 不是自动化创建"处理；
   * 本机主进程投影仍**总是显式给值**（`null` 或对象），新旧两端都不含糊。
   */
  automation?: { scheduleId: string; scheduleName: string } | null;
}

export interface ProjectProgressApiHistoryEntry {
  eventId: number;
  projectId: string;
  sessionId: string;
  bindingRevision: number;
  from: WorkItemStatus | null;
  to: WorkItemStatus;
  actor: { kind: 'account' | 'bot'; id: string; displayName: string | null };
  createdAt: number;
  reason: string | null;
  unblockCondition: string | null;
  resolution: string | null;
  completionNote: string | null;
}

export interface ProjectProgressReadResult {
  projectId: string;
  /** Complete effective work-item set, independent of history pagination. */
  items: ProjectProgressApiItem[];
  history: ProjectProgressApiHistoryEntry[];
  /** UI hints only. Every mutation must independently recheck current authority. */
  capabilities: { canRecord: boolean; canConfirmDone: boolean };
  historyPage: { limit: 100; hasMore: boolean; nextBeforeEventId: number | null };
}
