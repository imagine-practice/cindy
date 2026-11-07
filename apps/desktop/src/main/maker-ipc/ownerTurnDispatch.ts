/**
 * owner → 伙伴回合的窄化投递面。
 *
 * 真正的新回合只有一条主机通路（`register.ts` 里的 `sendToSessionInternal`）：会话恢复、
 * 繁忙排队、消息落库与费用行为都和主人亲自在聊天框发送一致。`register.ts` 把它注入这里，
 * 需要「替主人问一句伙伴」的服务只拿到这个窄面，不 import register，也不新造执行授权。
 *
 * 复用先例：例行任务结果回投（`routines/deliveryDispatch.ts`）、伙伴邀请开场白
 * （`botInvitation.ts`）都走同一个 `dispatchBotSessionMessage`。
 */

export interface OwnerTurnDispatchInput {
  /** 目标伙伴的任务（canonical lane），必须是它自己的活跃任务。 */
  targetSessionId: string;
  /** 稳定请求键 = 落库的 `messages.client_id`；同一个键最多一个回合。 */
  clientId: string;
  /** 送给模型的文本。 */
  message: string;
  /** 落库/界面展示的文本；默认与 message 相同。 */
  persistedContent: string;
  /**
   * 冷会话按落库权限档恢复，不沿用 main 侧通路的缺省 bypass。
   * 主人代发属于同一类来源，因此固定要求该策略。
   */
  resumeWithStoredPermissionMode: true;
  authorizationGuard?: { validate(): Promise<void>; assertCurrent(): void };
}

export type OwnerTurnDispatchResult =
  | { ok: true; targetSessionId: string; wakeKind: string; queuedMessageId?: string }
  | { ok: false; errorCode?: string; message: string };

export type OwnerTurnDispatch = (
  input: OwnerTurnDispatchInput,
) => Promise<OwnerTurnDispatchResult>;

/**
 * 执行后续（继续 / 批准 / 排队 / 换模型）需要的三个宿主能力。
 *
 * 全部走已有能力，不新造授权：
 *   - `readSessionBusy` / `readQueuedPosition` 读既有的输入协调器（真实内存边界与队列）；
 *   - `approveInteraction` 复用既有的 owner 确认通道（同一个 requestId 解析器）；
 *   - `setSessionModel` 复用既有的 SET_MODEL 语义（只改后续回合路由，历史不动）。
 */
export interface OwnerTurnHost extends OwnerTurnDispatch {
  /** 会话是否在跑回合；undefined = 该宿主没有这项信息，调用方回落到真实列。 */
  readSessionBusy?(sessionId: string): boolean | undefined;
  /** 排在该会话队列里的位置（1 起）；不在队列中为 null。 */
  readQueuedPosition?(sessionId: string, clientId: string): number | null;
  /** 把某个已挂起的确认按 owner 的同意解开；只接受 permission / plan_review。 */
  approveInteraction?(input: {
    sessionId: string;
    requestId: string;
    kind: 'permission' | 'plan_review';
  }): { accepted: boolean };
  /** 只改该会话后续回合的模型。失败返回真实原因，绝不回退默认模型或换账号。 */
  setSessionModel?(input: {
    sessionId: string;
    model: string;
    providerId?: string | null;
  }): Promise<
    | { ok: true; status: 'applied' | 'deferred'; model: string; providerId: string | null }
    | { ok: false; message: string }
  >;
}

let dispatch: OwnerTurnHost | undefined;

/** 由 maker-ipc 注册期注入；重复注入只替换引用。 */
export function setOwnerTurnDispatch(value: OwnerTurnHost): void {
  dispatch = value;
}

export function getOwnerTurnDispatch(): OwnerTurnHost | undefined {
  return dispatch;
}
