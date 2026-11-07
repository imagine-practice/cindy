import type { WorkItemStatus } from './workItemStatus';

/** Client intent only. Identity, role, timestamps and evidence IDs are not client inputs. */
export interface WorkItemProgressIntent {
  projectId: string;
  sessionId: string;
  expectedRevision: number;
  /** Observed sessions.project_binding_revision; concurrency token, not identity. */
  expectedBindingRevision: number;
  requestId: string;
  to: WorkItemStatus;
  reason?: string | null;
  unblockCondition?: string | null;
  resolution?: string | null;
  completionNote?: string | null;
}

/** Main must derive this from the authenticated execution context, never from intent. */
export interface WorkItemProgressContext {
  actor: { kind: 'account' | 'bot'; id: string };
  now: number;
}

export interface WorkItemProgressRecord {
  sessionId: string;
  projectId: string;
  status: WorkItemStatus | null;
  revision: number;
  bindingRevision: number;
  reason: string | null;
  unblockCondition: string | null;
  /** Same-transaction owner progress confirmation; not business acceptance or release. */
  completionEventId: number | null;
  updatedBy: WorkItemProgressContext['actor'];
  updatedAt: number;
}

export interface WorkItemProgressResult {
  record: WorkItemProgressRecord;
  eventId: number;
  revision: number;
  replayed: boolean;
}

export type WorkItemProgressErrorCode =
  | 'INVALID_PARAMS'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'PROJECT_MISMATCH'
  | 'SESSION_DELETED'
  | 'BINDING_CONFLICT'
  | 'REVISION_CONFLICT'
  | 'REQUEST_CONFLICT'
  | 'REASON_REQUIRED'
  | 'UNBLOCK_CONDITION_REQUIRED'
  | 'RESOLUTION_REQUIRED'
  | 'COMPLETION_NOTE_REQUIRED'
  | 'ILLEGAL_TRANSITION';
