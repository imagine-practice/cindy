/**
 * 项目工作项「请该伙伴执行」：renderer ↔ main 的线上形状（只读投影 + 投递意图）。
 *
 * 这里只有**入口**语义，没有执行授权：
 *   - 执行者只能来自工作项的处理人（`sessions.assignee_kind/assignee_id`），
 *     处理人为空或不是伙伴时入口禁用，绝不回退负责人或默认伙伴；
 *   - renderer 不能指定执行者、不能生成请求键、不能调用 `execute_project_work_item`；
 *   - main 把请求投递给该伙伴的一次真实 owner 回合，伙伴在回合内自己调用执行工具，
 *     caller 仍是它自己的活跃任务。所以这里既没有新授权，也没有伪造 caller。
 */

export const PROJECT_WORK_ITEM_EXECUTION_READ_CHANNEL = 'local-db:project-execution:read';
export const PROJECT_WORK_ITEM_EXECUTION_REQUEST_CHANNEL = 'local-db:project-execution:request';

/**
 * 幂等键前缀。main 在首次点击时生成稳定键并作为投递回合的 `messages.client_id` 落库：
 * 键随消息行持久化，`uniq_messages_session_client` 保证同一键最多一行、也就最多一个回合。
 * 键形状：`project-workitem-execute:v1:<digest>:<round>`。
 */
export const WORK_ITEM_EXECUTION_CLIENT_ID_PREFIX = 'project-workitem-execute:v1:';

/**
 * 工作项执行状态。前六档是任务要求的语义分档，`completed` 用来区分「伙伴已跑完」
 * 与「已受理 / 执行中」，否则「投递 / 受理 / 完成」三档文案无法区分。
 *
 * `requested` ≠ `accepted` ≠ `running` ≠ `completed`：只投递到伙伴回合不等于它受理了
 * 执行请求，受理也不等于有结果。`unknown` 表示执行结果无法确定，只能对账。
 */
export type WorkItemExecutionState =
  | 'none'
  | 'requested'
  | 'accepted'
  | 'running'
  | 'failed'
  | 'unknown'
  | 'completed';

/** 入口不可用的原因。全部由 main 判定，renderer 只负责显示。 */
export type WorkItemExecutionUnavailableReason =
  | 'UNASSIGNED'
  | 'ASSIGNEE_NOT_BOT'
  | 'EXECUTOR_INACTIVE'
  | 'EXECUTOR_NOT_MEMBER'
  | 'PROJECT_ARCHIVED';

/** Renderer intent：只给项目与工作项，其余身份由 main 从真实数据解析。 */
export interface ProjectWorkItemExecutionReadRequest {
  projectId: string;
}

export interface WorkItemExecutionEntry {
  sessionId: string;
  /** 处理人（= 执行者）。null = 没有可执行的处理人，入口禁用。 */
  executor: { botId: string; displayName: string } | null;
  unavailableReason: WorkItemExecutionUnavailableReason | null;
  state: WorkItemExecutionState;
  /** 当前执行的请求键；null = 还没有投递过。 */
  requestKey: string | null;
  requestRound: number | null;
  delegationId: string | null;
  requestedAt: number | null;
  /** 本轮显式重新发起是否允许；false 时按钮禁用，界面给原因。 */
  canRequest: boolean;
  /**
   * 执行后续（继续 / 批准 / 排队 / 换模型）的可用性，每次读取都由 main 现读真实行。
   * 不进任何缓存：刷新即重读，界面不得自己判定「已完成 / 已批准」。
   */
  followup: WorkItemFollowupProjection;
}

export interface ProjectWorkItemExecutionReadResult {
  projectId: string;
  items: WorkItemExecutionEntry[];
}

/** 投递意图。执行者不从 renderer 进来，所以这里没有 botId。 */
export interface ProjectWorkItemExecutionRequestIntent {
  projectId: string;
  sessionId: string;
}

export type WorkItemExecutionRequestErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL'
  | 'UNASSIGNED'
  | 'ASSIGNEE_NOT_BOT'
  | 'EXECUTOR_INACTIVE'
  | 'EXECUTOR_NOT_MEMBER'
  | 'PROJECT_ARCHIVED'
  | 'HOST_NOT_READY'
  /** 已投递或已在执行：不开新回合，返回现有请求。 */
  | 'ALREADY_REQUESTED'
  /** 结果未知：只能对账，不得重发。 */
  | 'OUTCOME_UNKNOWN'
  /** 投递被宿主拒绝（伙伴暂停、会话不可用等）。 */
  | 'DISPATCH_FAILED';

export type ProjectWorkItemExecutionRequestResult =
  | {
      ok: true;
      sessionId: string;
      state: WorkItemExecutionState;
      /** null = 这次执行不是由本入口投递的（例如伙伴在自己的对话里发起）。 */
      requestKey: string | null;
      requestRound: number | null;
      /** true = 复用了已有请求，没有新回合。 */
      replayed: boolean;
      wakeKind: string | null;
    }
  | {
      ok: false;
      code: WorkItemExecutionRequestErrorCode;
      state: WorkItemExecutionState;
      requestKey: string | null;
      message: string;
    };

/** `requested` / `accepted` / `running` / `unknown` 都不允许再投递一次。 */
export function workItemExecutionBlocksNewRequest(state: WorkItemExecutionState): boolean {
  return state === 'requested' || state === 'accepted' || state === 'running' || state === 'unknown';
}

/* ───────────────────────── 执行后续：继续 / 批准 / 排队 / 换模型 ───────────────────────── */

/**
 * 后续动作的投递通道。与「请该伙伴执行」共用同一套 owner → 后备回合窄面，
 * 不新造授权：renderer 只说「做哪个动作」，执行者、请求键、模型合法性全部由 main 解析。
 */
export const PROJECT_WORK_ITEM_EXECUTION_FOLLOWUP_CHANNEL =
  'local-db:project-execution:followup';

/**
 * 后续动作的幂等键前缀。键形状：
 * `project-workitem-followup:v1:<摘要>:<动作>:<round>`。
 *
 * `<摘要>` 是**意图摘要**：项目 + 工作项 + 执行伙伴 + 动作 + 规范化后的追加输入。
 * 把动作与文本都放进去，是为了让「改了指令内容」天然成为新意图、新键：否则同一个
 * round 里改过内容会撞上同一个 clientId，被消息层去重静默吞掉（界面显示已发送，
 * 实际发的是旧内容）。它独立于入口键的摘要（那里只看项目/工作项/伙伴）。
 *
 * round 只在同一意图上一轮后续已被目标会话真正消费（产出了 assistant/tool 行）后
 * 前进，因此同文本连点仍然落在同一个键上，只投递一次。
 */
export const WORK_ITEM_FOLLOWUP_CLIENT_ID_PREFIX = 'project-workitem-followup:v1:';

/** 四个后续动作。分开的键，不共用一个「继续」。 */
export type WorkItemFollowupAction = 'continue' | 'approve' | 'queue' | 'model';

/**
 * 后续动作不可用的原因。全部由 main 判定（读真实行），renderer 只负责显示。
 *
 * `EXECUTOR_UNAVAILABLE`：处理人停用 / 非伙伴 / 非项目成员 / 项目归档。
 * `OUTCOME_UNKNOWN`：执行结果未知，只可对账，四个动作一律禁用。
 * `NO_TERMINAL_EXECUTION`：既没到 completed/failed，也没有待确认项，没有可继续的东西。
 * `NO_PENDING_CONFIRMATION`：没有待确认项。
 * `CONFIRMATION_NOT_APPROVABLE`：待确认项是提问（ask_user_question），需要回答而不是同意。
 * `NOT_BUSY`：执行回合没在忙，「排队」没有意义。
 * `MODEL_UNAVAILABLE`：读不到执行会话的模型/引擎，不能换模型。
 */
export type WorkItemFollowupUnavailableReason =
  | 'EXECUTOR_UNAVAILABLE'
  | 'OUTCOME_UNKNOWN'
  | 'NO_TERMINAL_EXECUTION'
  | 'NO_PENDING_CONFIRMATION'
  | 'CONFIRMATION_NOT_APPROVABLE'
  | 'NOT_BUSY'
  | 'MODEL_UNAVAILABLE';

export interface WorkItemFollowupCapability {
  allowed: boolean;
  reason: WorkItemFollowupUnavailableReason | null;
}

/** 待确认项（来自 `bot_delegations` 的 waiting + pending_interaction_json）。 */
export interface WorkItemFollowupPending {
  requestId: string;
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  /** 伙伴自己写的等待摘要，只作展示；批准前必须先看到它。 */
  summary: string;
  raisedAt: number;
}

export interface WorkItemFollowupModelRoute {
  current: string;
  providerId: string | null;
  agentKind: 'claude-code' | 'codex' | 'pi';
}

/** 一个工作项的后续动作可用性。全部字段都是 main 现读的结果，不得缓存。 */
export interface WorkItemFollowupProjection {
  /** 执行会话当前是否在跑回合（决定「排队」是否可用）。 */
  busy: boolean;
  pending: WorkItemFollowupPending | null;
  model: WorkItemFollowupModelRoute | null;
  actions: Record<WorkItemFollowupAction, WorkItemFollowupCapability>;
}

/** 继续 / 排队带的可选追加输入上限，与其它输入面一致。 */
export const WORK_ITEM_FOLLOWUP_TEXT_MAX = 4000;

export type ProjectWorkItemFollowupIntent =
  | { projectId: string; sessionId: string; action: 'continue' | 'queue'; text?: string }
  | { projectId: string; sessionId: string; action: 'approve' }
  | {
      projectId: string;
      sessionId: string;
      action: 'model';
      model: string;
      providerId?: string | null;
    };

export type WorkItemFollowupErrorCode =
  | 'INVALID_PARAMS'
  | 'NOT_FOUND'
  | 'FORBIDDEN'
  | 'PRECONDITION_FAILED'
  | 'INTERNAL'
  /** 动作在当前真实状态下不可用，`reason` 给出原因。 */
  | 'FOLLOWUP_UNAVAILABLE'
  /** 宿主还没准备好（投递面未注入）。 */
  | 'HOST_NOT_READY'
  /** 投递被宿主拒绝。 */
  | 'DISPATCH_FAILED'
  /** 待确认项已经由别人处理或已经过期。 */
  | 'CONFIRMATION_STALE'
  /** 换模型失败；message 是真实原因，模型没有被改动。 */
  | 'MODEL_CHANGE_FAILED'
  /**
   * 同一个幂等键下已经存在**另一条**内容（摘要碰撞或别的写入方复用同键）。
   * 这时绝不把新内容显示成已投递，要求用户刷新后重新发起。
   */
  | 'IDEMPOTENCY_CONFLICT';

/** 批准审计：谁批的、批的哪一条、当时执行状态。 */
export interface WorkItemFollowupApprovalAudit {
  at: number;
  requestId: string;
  kind: WorkItemFollowupPending['kind'];
  summary: string;
  action: 'approve';
  actorKind: 'account';
  actorId: string;
  executionState: WorkItemExecutionState;
  projectId: string;
  sessionId: string;
}

export type ProjectWorkItemFollowupResult =
  | {
      ok: true;
      sessionId: string;
      action: WorkItemFollowupAction;
      /** 该动作的幂等键（换模型/批准没有投递回合，为 null）。 */
      requestKey: string | null;
      requestRound: number | null;
      /** true = 复用了已有键，没有产生第二个回合。 */
      replayed: boolean;
      /** 宿主回执：'queued' 表示进入该任务队列，其余为直接投递。 */
      wakeKind: string | null;
      /** 队列位置（1 起）；非排队或读不到时为 null。 */
      queuedPosition: number | null;
      /** 批准的审计回执；其它动作为 null。 */
      approval: WorkItemFollowupApprovalAudit | null;
      /** 换模型回执：deferred = 只登记，发送时生效。 */
      model:
        | { status: 'applied' | 'deferred'; model: string; providerId: string | null }
        | null;
    }
  | {
      ok: false;
      sessionId: string;
      action: WorkItemFollowupAction;
      code: WorkItemFollowupErrorCode;
      /** 不可用原因（code 为 FOLLOWUP_UNAVAILABLE 时非空）。 */
      reason: WorkItemFollowupUnavailableReason | null;
      message: string;
      requestKey: string | null;
    };
