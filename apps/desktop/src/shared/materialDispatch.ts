import type { MaterialContextPurpose, MaterialSubjectKind } from './materials';

/** Durable metadata only. This selector is the sole value allowed through queue/public input. */
export interface MaterialDispatchSelector {
  contextId: string;
  projectId: string;
  workItemId: string;
  bindingRevision: number;
  purpose: MaterialContextPurpose;
}
export interface MaterialDispatchMessageKey { sessionId: string; clientId: string }
export type MaterialDispatchRevisionState = 'queued' | 'attached' | 'superseded' | 'cancelled';
export type MaterialDispatchConsumer = 'vision' | 'provider';
export type MaterialDispatchOutcome = 'pending' | 'confirmed' | 'not-consumed' | 'unknown';
/** Lossless fixed PDF producer evidence. Counts are not page IDs or visual coverage. */
export interface MaterialDispatchPdfCoverage {
  kind: 'extractable-text-only';
  numPages: number;
  pagesInspected: number;
  textPages: number;
  clipped: boolean;
  completeText: boolean;
  textSha256: string;
  textChars: number;
  characterLimit: number;
  pagesWithoutTextOrNotInspected: number;
  visualCoverage: 'not-assessed';
}
export interface MaterialDispatchPreparedItem {
  referenceId: string;
  materialId: string;
  version: number;
  versionId: string;
  expectedSha256: string;
  /** Null only on explicitly failed/unsupported items; never represents verified bytes. */
  verifiedSha256: string | null;
  readiness: 'ready' | 'partial' | 'unsupported' | 'failed';
  failureCode: string | null;
  representation: 'text' | 'image' | 'pdf-text' | 'unavailable';
  textSha256: string | null;
  coverage: MaterialDispatchPdfCoverage | null;
}
export interface MaterialDispatchPreparation {
  preparationKey: string;
  items: MaterialDispatchPreparedItem[];
}
export interface MaterialDispatchAttempt {
  attemptId: string;
  turnGeneration: number;
  consumer: MaterialDispatchConsumer;
  preparationKey: string;
  referenceIds: string[];
  /** Hash of the actual consumer payload; no body, path or base64 is retained. */
  payloadSha256: string;
  actor: { kind: MaterialSubjectKind; id: string };
  outcome: MaterialDispatchOutcome;
  /** Opaque evidence digest, not a grant or external request payload. */
  evidence: MaterialDispatchEvidence | null;
  observations: MaterialDispatchEvidence[];
  createdAt: string;
  updatedAt: string;
}
/** Main-only observation from the real consumer/host, never a tool/renderer claim.
 * 'confirmed' means accepted dispatch/result, not model understanding or acceptance. */
export interface MaterialDispatchEvidence {
  source: 'session-send-result' | 'vision-result' | 'host-undispatched' | 'reconciliation';
  outcome: Exclude<MaterialDispatchOutcome, 'pending'>;
  receiptSha256: string;
}
export interface MaterialDispatchRevision {
  revision: number;
  selector: MaterialDispatchSelector;
  contentSha256: string;
  state: MaterialDispatchRevisionState;
  preparation: MaterialDispatchPreparation | null;
  attempts: MaterialDispatchAttempt[];
}
export interface MaterialDispatchReadResult {
  key: MaterialDispatchMessageKey;
  currentRevision: number;
  messageId: string | null;
  /** Current plus authorized history only; no filtered count. */
  revisions: MaterialDispatchRevision[];
}
export interface MaterialDispatchWriteResult { revision: number; replayed: boolean }
export interface MaterialDispatchBeginResult {
  revision: number;
  /** Only true on newly persisted pending intent. False NEVER licenses another side effect. */
  started: boolean;
  attempt: MaterialDispatchAttempt;
}
export interface MaterialDispatchOutcomeResult { recorded: true; replayed: boolean }

/** Renderer-safe projection of one durable dispatch. No actor, hash, body or private locator:
 * Main projects it from the ledger read; the renderer never derives state from optimistic data.
 */
export interface MaterialDispatchStatusItem {
  clientId: string;
  revision: number;
  state: MaterialDispatchRevisionState;
  /** Latest consumer attempt only, or null when nothing was started (queued/attached). */
  consumption: null | { consumer: MaterialDispatchConsumer; outcome: MaterialDispatchOutcome };
  readiness: 'ready' | 'partial' | 'not-prepared' | null;
  referenceCount: number;
}
export interface MaterialDispatchStatusList {
  referenceContract: 1;
  sessionId: string;
  messages: MaterialDispatchStatusItem[];
}
/** Read-only. Sending needs no new channel: the existing input envelope already carries
 * the selector; only post-send ledger state had no renderer read path.
 */
export const MATERIAL_DISPATCH_STATUS_CHANNEL = 'local-db:material-dispatch:status';

/** Strict, five-field queue codec; no actor, attempt, evidence, body or authorization. */
export function parseMaterialDispatchSelector(value: unknown): MaterialDispatchSelector | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const v = value as Record<string, unknown>;
  const keys = ['contextId', 'projectId', 'workItemId', 'bindingRevision', 'purpose'];
  const id = (x: unknown): x is string => typeof x === 'string' && x.length > 0 && x.length <= 200 && !/\s/u.test(x)
    && !Array.from(x).some(c => c.charCodeAt(0) < 32 || c.charCodeAt(0) === 127);
  if (Object.keys(v).length !== keys.length || keys.some(k => !Object.prototype.hasOwnProperty.call(v, k))
    || !id(v.contextId) || !id(v.projectId) || !id(v.workItemId)
    || typeof v.bindingRevision !== 'number' || !Number.isSafeInteger(v.bindingRevision) || v.bindingRevision < 0
    || typeof v.purpose !== 'string' || !['reference', 'redecompose', 'recheck'].includes(v.purpose)) return null;
  return { contextId: v.contextId, projectId: v.projectId, workItemId: v.workItemId,
    bindingRevision: v.bindingRevision, purpose: v.purpose as MaterialContextPurpose };
}
