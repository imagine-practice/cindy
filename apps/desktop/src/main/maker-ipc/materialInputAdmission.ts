import { createHash } from 'node:crypto';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import { parseMaterialDispatchSelector } from '../../shared/materialDispatch';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { createMaterialDispatchQueue } from '../localDb/materialDispatchQueue';

const reject = (code: string): never => { throw new Error(`[${code}] Material input unavailable`); };
const sha = (content: string) => createHash('sha256').update(content).digest('hex');

/** Only data crosses the queue boundary. No actor, lease, preparation or outcome is accepted. */
export function parseQueuedMaterialIntent(raw: unknown): NonNullable<AgentInputQueuedMessage['materialDispatch']> {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return reject('INVALID_PARAMS');
  const value = raw as Record<string, unknown>;
  if (Object.keys(value).length !== 2 || !Object.hasOwn(value, 'selector') || !Object.hasOwn(value, 'expectedRevision')) return reject('INVALID_PARAMS');
  const selector = parseMaterialDispatchSelector(value.selector);
  const expectedRevision = value.expectedRevision;
  if (!selector || typeof expectedRevision !== 'number' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return reject('INVALID_PARAMS');
  return { selector, expectedRevision };
}

/** Main-owned bridge for the actual input coordinator; a reconstructed service reauthorizes
 * from the current Profile and the original key. Queue JSON never restores authority. */
export interface MaterialInputAdmissionOptions {
  /** Declared only by the real Main wiring that installs a provider-send consumer adapter.
   * Without it every material selector still fails closed (NOT_READY). */
  readonly consumerConnected?: boolean;
}
export function createMaterialInputAdmission(options: MaterialInputAdmissionOptions = {}) {
  const consumerConnected = options.consumerConnected === true;
  const capturedInputs = new Map<string, {
    owner: NonNullable<ReturnType<typeof getCurrentDbClientSnapshot>>;
    revision: number;
    contentSha256: string;
  }>();
  let observedOwner = getCurrentDbClientSnapshot();
  const keyOf = (sessionId: string, clientId: string) => JSON.stringify([sessionId, clientId]);
  const capture = (assertSource: () => void) => {
    assertSource();
    const owner = getCurrentDbClientSnapshot();
    if (owner !== observedOwner) { capturedInputs.clear(); observedOwner = owner; }
    if (!owner?.userId) return reject('PRECONDITION_FAILED');
    const assertCurrent = () => {
      if (getCurrentDbClientSnapshot() !== owner) return reject('PRECONDITION_FAILED');
      assertSource();
    };
    return { owner, assertCurrent, queue: createMaterialDispatchQueue({
      client: owner.client, actor: { kind: 'account', id: owner.userId }, assertCurrent,
    }) };
  };

  async function known(sessionId: string, clientId: string) {
    const { owner, assertCurrent } = capture(() => undefined);
    const row = await owner.client.queryOne<{ present: number }>(
      'SELECT 1 AS present FROM material_dispatch_messages WHERE session_id=? AND client_id=?', [sessionId, clientId]);
    assertCurrent();
    return !!row;
  }

  return {
    async admit(sessionId: string, item: AgentInputQueuedMessage, assertSource: () => void): Promise<void> {
      // A resend cannot strip its selector and become an ordinary input after queue narrowing.
      if (item.materialDispatch === undefined) {
        if (await known(sessionId, item.clientId)) return reject('INTENT_FROZEN');
        return;
      }
      const intent = parseQueuedMaterialIntent(item.materialDispatch);
      // enqueue/steer admit a new intent or replay that same intent. Editing a pending
      // row needs the separate coordinator+ledger CAS path, which is not wired here.
      if (intent.expectedRevision !== 0) return reject('INTENT_FROZEN');
      if (intent.selector.workItemId !== sessionId) return reject('SCOPE_MISMATCH');
      const { owner, assertCurrent, queue } = capture(assertSource);
      const key = { sessionId, clientId: item.clientId };
      const queued = await queue.queue(key, intent.selector, item.persistedContent, intent.expectedRevision);
      const recovered = await queue.recover(key);
      assertCurrent();
      // A prior irreversible attempt/attached row is reconciled, never dispatched a second time.
      if (recovered.messageId || recovered.revisions.some(row => row.attempts.length > 0)) return reject('OUTCOME_UNRESOLVED');
      if (recovered.currentRevision !== queued.revision) return reject('REVISION_CONFLICT');
      item.durableDelivery = true; // Require the existing queue snapshot ACK before UI acceptance.
      item.materialDispatch = intent;
      item.materialDispatchRevision = queued.revision;
      capturedInputs.set(keyOf(sessionId, item.clientId), { owner, revision: queued.revision, contentSha256: sha(item.persistedContent) });
    },

    async restore(sessionId: string, items: AgentInputQueuedMessage[]): Promise<AgentInputQueuedMessage[]> {
      for (const item of items) {
        if (!item.materialDispatch) {
          if (await known(sessionId, item.clientId)) return reject('INTENT_FROZEN');
          continue;
        }
        const intent = parseQueuedMaterialIntent(item.materialDispatch);
        const { owner, assertCurrent, queue } = capture(() => undefined);
        const read = await queue.recover({ sessionId, clientId: item.clientId });
        assertCurrent();
        const revision = read.revisions.find(row => row.revision === item.materialDispatchRevision);
        if (intent.selector.workItemId !== sessionId || !revision || read.currentRevision !== revision.revision ||
          JSON.stringify(revision.selector) !== JSON.stringify(intent.selector) || revision.contentSha256 !== sha(item.persistedContent)) return reject('REVISION_CONFLICT');
        if (read.messageId || revision.attempts.length > 0) return reject('OUTCOME_UNRESOLVED');
        if (revision.state !== 'queued') return reject('CANCELLED');
        // Read metadata does not authorize execution. Revalidate the unchanged intent in
        // the real write transaction (idempotent replay, no new revision or guessed CAS).
        const verified = await queue.queue({ sessionId, clientId: item.clientId }, intent.selector, item.persistedContent, intent.expectedRevision);
        assertCurrent();
        if (verified.revision !== revision.revision) return reject('REVISION_CONFLICT');
        capturedInputs.set(keyOf(sessionId, item.clientId), { owner, revision: revision.revision, contentSha256: revision.contentSha256 });
      }
      return items;
    },

    async messageAuthority(sessionId: string, clientId: string, content: string) {
      const entry = capturedInputs.get(keyOf(sessionId, clientId));
      if (!entry) {
        if (await known(sessionId, clientId)) return reject('PRECONDITION_FAILED');
        return undefined;
      }
      const { owner, queue } = capture(() => undefined);
      if (owner !== entry.owner || sha(content) !== entry.contentSha256) return reject('MESSAGE_MISMATCH');
      return queue.messageAuthority({ sessionId, clientId }, content, entry.revision);
    },

    /** Until the consumer adapter supplies actual payload/attempt evidence, material inputs
     * must not silently fall through to an ordinary text-only send or an implicit replay.
     * The criterion is unchanged: a declared consumer plus a live prepared handle, or nothing. */
    async assertConsumerConnected(
      sessionId: string,
      clientId: string,
      intent: { hasSelector?: boolean; prepared?: boolean } = {},
    ) {
      if (intent.hasSelector !== true) {
        if (await known(sessionId, clientId)) return reject('NOT_READY');
        return;
      }
      if (!consumerConnected || intent.prepared !== true) return reject('NOT_READY');
    },
  };
}
