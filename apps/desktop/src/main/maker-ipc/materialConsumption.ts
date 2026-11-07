import { createHash, randomUUID } from 'node:crypto';
import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { MaterialDispatchPreparation } from '../../shared/materialDispatch';
import { getCurrentDbClientSnapshot } from '../localDb/client/current';
import { createMaterialDispatchQueue } from '../localDb/materialDispatchQueue';
import { materialDispatchPreparationFromItems } from '../localDb/materialDispatchPreparation';
import { prepareMaterialExecutionInput } from './materialExecutionInput';

/** Wire-only blocks appended to the provider payload. The persisted user content is never
 * rewritten: `messages.content` must keep matching the queued content SHA or attach fails. */
export interface MaterialWireBlock {
  type: string;
  [key: string]: unknown;
}

export interface MaterialConsumptionHandle {
  /** Appended after the user's own blocks, in pinned reference order. */
  readonly blocks: MaterialWireBlock[];
  /** Real provider consumption boundary. Prepares + begins one pending attempt before
   * any provider side effect; never records a success. Rejection blocks the dispatch. */
  consume(turnGeneration: number): Promise<void>;
}

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const reject = (code: string): never => {
  throw new Error(`[${code}] Material input is unavailable`);
};

function blocksFor(items: readonly PreparedItem[]): MaterialWireBlock[] {
  const blocks: MaterialWireBlock[] = [];
  for (const item of items) {
    if (item.status !== 'prepared') continue;
    if (item.content.kind === 'text') {
      blocks.push({ type: 'text', text: item.content.text });
      continue;
    }
    blocks.push({
      type: 'image',
      base64: item.content.file.base64,
      mimeType: item.content.file.mimeType,
    });
  }
  return blocks;
}

type PreparedSuccess = Extract<Awaited<ReturnType<typeof prepareMaterialExecutionInput>>, { ok: true }>;
type PreparedItem = PreparedSuccess['items'][number];

/** Only value crossing into the provider payload. Attachment bodies never enter the ledger. */
function materialPayload(items: readonly PreparedItem[], blocks: readonly MaterialWireBlock[]): {
  referenceIds: string[]; payloadSha256: string;
} {
  // 有任何一项准备失败就整单不发：源文件被改动（SOURCE_CHANGED）、缺失或不可读时，
  // 静默跳过会让用户以为"材料发出去了"，而实际发的是不完整/过期内容。
  const blocked = items.find(item => item.status !== 'prepared');
  if (blocked) return reject(('code' in blocked && blocked.code) || 'VERSION_NOT_READABLE');
  const selected = items;
  return {
    referenceIds: selected.map(item => item.referenceId),
    payloadSha256: digest(JSON.stringify(blocks)),
  };
}

/**
 * Minimal consumer adapter for the existing material dispatch ledger.
 *
 * It reuses the frozen preparation entry (`prepareMaterialExecutionInput`) and the
 * Main-only queue service; it adds no table, migration, queue field or provider protocol.
 * The prepared bytes ride in the ordinary user-message blocks (text/image), exactly like
 * a user-pasted attachment, so no vendor-side format changes.
 */
export function createMaterialConsumptionConnector() {
  return {
    /**
     * Returns null for ordinary input. Throws a stable `[CODE]` rejection when a selected
     * material context cannot be prepared, so the coordinator keeps the queue head and
     * persists nothing (no half message).
     */
    async prepare(sessionId: string, item: AgentInputQueuedMessage): Promise<MaterialConsumptionHandle | null> {
      if (!item.materialDispatch) return null;
      const revision = item.materialDispatchRevision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision < 1) {
        return reject('PRECONDITION_FAILED');
      }
      const owner = getCurrentDbClientSnapshot();
      if (!owner?.userId) return reject('PRECONDITION_FAILED');
      const assertCurrent = () => {
        if (getCurrentDbClientSnapshot() !== owner) reject('PRECONDITION_FAILED');
      };
      const prepared = await prepareMaterialExecutionInput(item.materialDispatch.selector, {
        client: owner.client,
        actor: { kind: 'account', id: owner.userId },
        assertCurrent,
      });
      if (!prepared.ok) return reject(prepared.code);
      const blocks = blocksFor(prepared.items);
      const { referenceIds, payloadSha256 } = materialPayload(prepared.items, blocks);
      const preparation: MaterialDispatchPreparation = materialDispatchPreparationFromItems(
        prepared.preparationKey,
        prepared.items,
      );
      const key = { sessionId, clientId: item.clientId };
      const attemptId = randomUUID();
      let consumed = false;

      const consume = async (turnGeneration: number): Promise<void> => {
        if (consumed) return;
        if (!Number.isSafeInteger(turnGeneration) || turnGeneration < 1) return reject('PRECONDITION_FAILED');
        // Final authorization boundary: the same one-SQL snapshot is re-read and compared
        // immediately before the provider call. No clock or latest-version guessing.
        await prepared.revalidate();
        assertCurrent();
        const queue = createMaterialDispatchQueue({
          client: owner.client,
          actor: { kind: 'account', id: owner.userId },
          assertCurrent,
        });
        await queue.prepare(key, preparation, revision);
        await queue.beginProvider(key, {
          revision,
          attemptId,
          turnGeneration,
          preparationKey: prepared.preparationKey,
          referenceIds,
          payloadSha256,
        });
        consumed = true;
      };

      return { blocks, consume };
    },
  };
}
