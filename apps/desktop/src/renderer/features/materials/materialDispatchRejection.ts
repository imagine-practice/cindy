/**
 * One vocabulary for "this material intent was not sent, here is why".
 *
 * Two boundaries use it: the pre-send read (`validateMaterialDispatchMount`) and Main's own
 * admission of the queued intent. Keeping the copy in one place means the chip, the toast and
 * the send-failure banner state the same reason instead of leaking a raw bracket code, and no
 * rejection ever reads as "sent" when nothing was sent.
 */
import type { MaterialDispatchSendRejection } from './materialDispatchMount';

export type MaterialDispatchRejectionI18nKey =
  | 'ccAgent.materials.dispatch.rejectedContext'
  | 'ccAgent.materials.dispatch.rejectedBinding'
  | 'ccAgent.materials.dispatch.rejectedPurpose'
  | 'ccAgent.materials.dispatch.rejectedRefs'
  | 'ccAgent.materials.dispatch.rejectedVersion'
  | 'ccAgent.materials.dispatch.rejectedStale'
  | 'ccAgent.materials.dispatch.rejectedSent';

export function materialDispatchRejectionKey(
  reason: MaterialDispatchSendRejection,
): MaterialDispatchRejectionI18nKey {
  switch (reason) {
    case 'context-missing':
      return 'ccAgent.materials.dispatch.rejectedContext';
    case 'binding-changed':
      return 'ccAgent.materials.dispatch.rejectedBinding';
    case 'purpose-changed':
      return 'ccAgent.materials.dispatch.rejectedPurpose';
    case 'version-unreadable':
      return 'ccAgent.materials.dispatch.rejectedVersion';
    case 'intent-stale':
      return 'ccAgent.materials.dispatch.rejectedStale';
    case 'already-sent':
      return 'ccAgent.materials.dispatch.rejectedSent';
    case 'refs-changed':
    default:
      return 'ccAgent.materials.dispatch.rejectedRefs';
  }
}

/** Main refuses an intent whose durable revision was replaced or frozen. Nothing was sent:
 * the references are stale, so the user re-attaches the material instead of resending it. */
const STALE_INTENT_CODES: readonly string[] = [
  'REVISION_CONFLICT',
  'INTENT_CONFLICT',
  'INTENT_FROZEN',
];

/** A prior attempt exists for this exact message key (attached row or started attempt). That
 * is the only case that legitimately reads as "already sent". */
const ALREADY_SENT_INTENT_CODES: readonly string[] = ['OUTCOME_UNRESOLVED'];

/**
 * Map an enqueue rejection to an existing send-rejection reason. Returns null for anything
 * else so unrelated failures keep their own handling. Electron wraps IPC errors, so the code
 * is matched anywhere in the message rather than only at the start.
 */
export function materialDispatchSendFailureReason(
  error: unknown,
): MaterialDispatchSendRejection | null {
  const message =
    error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  if (!message) return null;
  if (STALE_INTENT_CODES.some((code) => message.includes(`[${code}]`))) return 'intent-stale';
  if (ALREADY_SENT_INTENT_CODES.some((code) => message.includes(`[${code}]`))) return 'already-sent';
  return null;
}
