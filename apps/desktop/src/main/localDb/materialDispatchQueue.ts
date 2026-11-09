import { createHash } from 'node:crypto';
import type { DbClient } from './client/DbClient';
import type { MaterialDispatchHost } from './worker/opHandlers/materialDispatchTx';
import { parseMaterialDispatchSelector, type MaterialDispatchMessageKey, type MaterialDispatchReadResult, type MaterialDispatchWriteResult, type MaterialDispatchPreparation } from '../../shared/materialDispatch';
import type { MaterialDispatchSessionReadResult } from './worker/opHandlers/materialDispatchTx';

/** Main-only authority. Never deserialize from a queue, public request or tool arguments. */
export interface MaterialQueueAuthority {
  readonly client: DbClient;
  readonly actor: MaterialDispatchHost['actor'];
  assertCurrent(): void;
}

/** Passed only through createMessage's independent third argument, never its public body. */
export interface MaterialMessageWriteAuthority extends MaterialQueueAuthority {
  readonly revision: number;
  readonly key: Readonly<MaterialDispatchMessageKey>;
}

const digest = (content: string) => createHash('sha256').update(content).digest('hex');
const reject = (code: string): never => { throw new Error(`[${code}] Material queue request rejected`); };

/** Durable metadata/recovery only. This service never sends, prepares or confirms consumption.
 * The caller must supply a fresh trusted actor even when recovering an old key.
 */
export function createMaterialDispatchQueue(authority: MaterialQueueAuthority) {
  if (!authority?.client || !authority.actor || (authority.actor.kind !== 'account' && authority.actor.kind !== 'bot')
    || typeof authority.actor.id !== 'string' || !authority.actor.id || typeof authority.assertCurrent !== 'function') reject('FORBIDDEN');
  const client = authority.client;
  // A mutable caller object cannot change identity after an await.
  const actor = Object.freeze({ kind: authority.actor.kind, id: authority.actor.id });
  const currentGuard = authority.assertCurrent.bind(authority);
  const assertCurrent = () => currentGuard();
  const host = () => ({ actor, now: Date.now() });
  const keyOf = (key: MaterialDispatchMessageKey) => Object.freeze({ sessionId: key.sessionId, clientId: key.clientId });

  async function recover(key: MaterialDispatchMessageKey): Promise<MaterialDispatchReadResult> {
    const captured = keyOf(key);
    assertCurrent();
    const result = await client.tx('materialDispatch.execute', { action: 'read', key: captured, host: host() });
    assertCurrent();
    if (!('revisions' in result)) return reject('INTERNAL');
    return result;
  }

  return {
    recover,
    async queue(key: MaterialDispatchMessageKey, rawSelector: unknown, serializedContent: string, expectedRevision: number): Promise<MaterialDispatchWriteResult> {
      const selector = parseMaterialDispatchSelector(rawSelector);
      if (!selector || typeof serializedContent !== 'string' || !Number.isSafeInteger(expectedRevision) || expectedRevision < 0) return reject('INVALID_PARAMS');
      const captured = keyOf(key);
      assertCurrent();
      const result = await client.tx('materialDispatch.execute', { action: 'queue', key: captured, selector,
        contentSha256: digest(serializedContent), expectedRevision, host: host() });
      assertCurrent();
      if (!('replayed' in result) || !('revision' in result)) return reject('INTERNAL');
      return { revision: result.revision, replayed: result.replayed };
    },
    /** Exact caller precondition, never inferred from latest revision or latest context. */
    async messageAuthority(key: MaterialDispatchMessageKey, serializedContent: string, expectedRevision: number): Promise<MaterialMessageWriteAuthority> {      if (!Number.isSafeInteger(expectedRevision) || expectedRevision < 1 || typeof serializedContent !== 'string') return reject('INVALID_PARAMS');
      const captured = keyOf(key);
      const result = await recover(captured);
      const revision = result.revisions.find(item => item.revision === expectedRevision);
      if (result.currentRevision !== expectedRevision || !revision) return reject('REVISION_CONFLICT');
      if (revision.state === 'cancelled' || revision.state === 'superseded') return reject('CANCELLED');
      if (revision.contentSha256 !== digest(serializedContent)) return reject('MESSAGE_MISMATCH');
      assertCurrent();
      return Object.freeze({ client, actor, assertCurrent, revision: expectedRevision, key: captured });
    },

    /** Immutable preparation metadata for an attached revision. Never a dispatch or a receipt. */
    async prepare(key: MaterialDispatchMessageKey, preparation: MaterialDispatchPreparation, revision: number): Promise<void> {
      if (!preparation || typeof preparation.preparationKey !== 'string' || !Array.isArray(preparation.items)
        || !Number.isSafeInteger(revision) || revision < 1) return reject('INVALID_PARAMS');
      const captured = keyOf(key);
      assertCurrent();
      await client.tx('materialDispatch.execute', { action: 'prepare', key: captured, revision, preparation, host: host() });
      assertCurrent();
    },

    /** Pending consumer attempt. Durable BEFORE the provider boundary; never a success receipt. */
    async beginProvider(key: MaterialDispatchMessageKey, input: {
      revision: number; attemptId: string; turnGeneration: number;
      preparationKey: string; referenceIds: string[]; payloadSha256: string;
    }): Promise<{ started: boolean }> {
      if (!Number.isSafeInteger(input.revision) || input.revision < 1
        || typeof input.attemptId !== 'string' || !input.attemptId
        || !Number.isSafeInteger(input.turnGeneration) || input.turnGeneration < 1
        || typeof input.preparationKey !== 'string' || !input.preparationKey
        || !Array.isArray(input.referenceIds) || input.referenceIds.length === 0
        || typeof input.payloadSha256 !== 'string' || !/^[0-9a-f]{64}$/.test(input.payloadSha256)) return reject('INVALID_PARAMS');
      const captured = keyOf(key);
      assertCurrent();
      const result = await client.tx('materialDispatch.execute', { action: 'begin', key: captured, consumer: 'provider', host: host(),
        revision: input.revision, attemptId: input.attemptId, turnGeneration: input.turnGeneration,
        preparationKey: input.preparationKey, referenceIds: input.referenceIds, payloadSha256: input.payloadSha256 });
      assertCurrent();
      if (!result || typeof result !== 'object' || !('started' in result)) return reject('INTERNAL');
      return { started: result.started === true };
    },

    /** Session-scoped read for the work-item UI; membership-filtered per revision project. */
    async readSession(sessionId: string, history = false): Promise<MaterialDispatchSessionReadResult> {
      if (typeof sessionId !== 'string' || !sessionId) return reject('INVALID_PARAMS');
      assertCurrent();
      const result = await client.tx('materialDispatch.execute', { action: 'readSession', sessionId, history, host: host() });
      assertCurrent();
      if (!result || typeof result !== 'object' || !('messages' in result) || !('sessionId' in result)) return reject('INTERNAL');
      return { sessionId: result.sessionId as string, messages: result.messages as MaterialDispatchSessionReadResult['messages'] };
    },
  };
}
