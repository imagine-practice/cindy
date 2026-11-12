/**
 * The task card of a V1 teammate background task ("delegation"). V2 teammates open ordinary tasks
 * with send_to_session; nothing creates or advances these any more. Hosts still list the existing
 * rows read-only (`maker:bot-delegations:list`) so old task cards and glance outputs stay readable.
 * Older hosts answer the same shape live.
 *
 *   queued → running ⇄ waiting → completed | failed | cancelled
 *
 * A row that was still queued/running/waiting at upgrade keeps that stored status; its child is an
 * ordinary task now, so clients show its real runtime state instead.
 */
export type BotDelegationStatus =
  | 'queued'
  | 'running'
  | 'waiting'
  | 'completed'
  | 'failed'
  | 'cancelled'
  /** Timeouts were stored as failed + a TIMEOUT error; the view reports them as timed out. */
  | 'timed-out';

/** What a waiting task was waiting for. Hosts without live tasks send null. */
export interface BotDelegationPendingInteraction {
  requestId: string;
  kind: 'permission' | 'ask_user_question' | 'plan_review';
  summary: string;
  raisedAt: number;
}

/** A file the child task produced (relative path + absolute path on its host). */
export interface BotDelegationArtifact {
  path: string;
  absolutePath: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
}

export interface BotDelegationView {
  id: string;
  requestingBotId: string;
  /** null = an ordinary Cindy task. */
  targetBotId: string | null;
  targetBotName: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  /** The actual child Session title, including a caller-supplied task name. */
  title: string;
  objective: string;
  contextRefs: string[];
  permissionSnapshot: Record<string, unknown>;
  lineage: string[];
  targetProfileVersion: number | null;
  depth: number;
  status: BotDelegationStatus;
  pendingInteraction: BotDelegationPendingInteraction | null;
  resultSummary: string | null;
  /** Remote task cards omit host-only absolute paths. Local artifacts retain them. */
  artifacts: Array<Omit<BotDelegationArtifact, 'absolutePath'> & { absolutePath?: string }>;
  lastError: string | null;
  createdAt: number;
  acceptedAt: number | null;
  completedAt: number | null;
  updatedAt: number;
}

export type BotDelegationListResult =
  | { ok: true; delegations: BotDelegationView[] }
  | { ok: false; errorCode: string; message: string };

/*
 * COMPAT (frozen V1 delegation layer): the write-path plan/change types upstream removed
 * with V1 teammate delegation. Re-added because the retained V1 isolation layer
 * (apps/desktop botDelegationService.ts, used by project work-item execution) still
 * parses and emits them. Delete with the V1 layer after V2 send_to_session migration.
 * See apps/desktop/docs/dev-rules/v1-delegation-compat-layer.md.
 */
export interface BotDelegationCapabilitySnapshot {
  profileVersion: number;
  agentKind: 'cc' | 'codex' | 'pi';
  model: string;
  capabilitiesSha256: string;
  identitySha256: string;
  skills: string[];
  skillMode: 'inherit' | 'allowlist';
  mcpServers: string[];
  mcpMode: 'inherit' | 'allowlist';
  toolsets: string[];
  toolsetMode: 'inherit' | 'allowlist';
  memoryEnabled: boolean;
}

export interface BotDelegationPlanSnapshot {
  version: 1;
  createdAt: number;
  targetBotId: string | null;
  targetCanonicalSessionId?: string;
  target?: BotDelegationCapabilitySnapshot;
  access: { contextRefs: string[] };
  completionTarget: { parentSessionId: string };
  limits: { maxDepth: number; timeoutMs: number; deadlineAt: number };
  permission: { mode: string; requesterMode: string | null; targetConfigured: 'ask' | 'trusted' };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}
function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === 'string');
}
function isCapabilitySnapshot(target: unknown): target is BotDelegationCapabilitySnapshot {
  if (!isRecord(target)) return false;
  return (
    typeof target.profileVersion === 'number'
    && (target.agentKind === 'cc' || target.agentKind === 'codex' || target.agentKind === 'pi')
    && typeof target.model === 'string'
    && typeof target.capabilitiesSha256 === 'string'
    && typeof target.identitySha256 === 'string'
    && isStringArray(target.skills)
    && (target.skillMode === 'inherit' || target.skillMode === 'allowlist')
    && isStringArray(target.mcpServers)
    && (target.mcpMode === 'inherit' || target.mcpMode === 'allowlist')
    && isStringArray(target.toolsets)
    && (target.toolsetMode === 'inherit' || target.toolsetMode === 'allowlist')
    && typeof target.memoryEnabled === 'boolean'
  );
}

/** Strict parser: malformed or pre-v1 plans are never silently reinterpreted. */
export function parseBotDelegationPlanSnapshot(
  value: string | Record<string, unknown> | null | undefined,
): BotDelegationPlanSnapshot | null {
  let parsed: unknown = value;
  if (typeof value === 'string') {
    try { parsed = JSON.parse(value) as unknown; } catch { return null; }
  }
  if (!isRecord(parsed) || parsed.version !== 1) return null;
  const access = parsed.access;
  const limits = parsed.limits;
  const permission = parsed.permission;
  const completionTarget = parsed.completionTarget;
  if (
    typeof parsed.createdAt !== 'number'
    || (parsed.targetBotId !== null && typeof parsed.targetBotId !== 'string')
    || !isRecord(access) || !isRecord(limits) || !isRecord(permission) || !isRecord(completionTarget)
    || typeof completionTarget.parentSessionId !== 'string'
  ) return null;
  if (
    parsed.targetCanonicalSessionId !== undefined
    && (typeof parsed.targetCanonicalSessionId !== 'string' || parsed.targetCanonicalSessionId.length === 0)
  ) return null;
  if (parsed.targetBotId !== null && !isCapabilitySnapshot(parsed.target)) return null;
  if (parsed.targetBotId === null && parsed.target !== undefined) return null;
  if (!isStringArray(access.contextRefs)) return null;
  if (
    typeof limits.maxDepth !== 'number' || typeof limits.timeoutMs !== 'number' || typeof limits.deadlineAt !== 'number'
    || typeof permission.mode !== 'string' || permission.mode.length === 0
    || (permission.requesterMode !== null && typeof permission.requesterMode !== 'string')
    || (permission.targetConfigured !== 'ask' && permission.targetConfigured !== 'trusted')
  ) return null;
  return parsed as unknown as BotDelegationPlanSnapshot;
}

export interface BotDelegationChangedPayload {
  delegationId: string;
  parentSessionId: string | null;
  childSessionId: string | null;
  status: BotDelegationStatus;
  pendingInteraction?: BotDelegationPendingInteraction | null;
}
