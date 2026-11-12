import type { AgentInputQueuedMessage } from '../../shared/agentInputQueue.js';
import { getCurrentDbClientSnapshot } from '../localDb/client/current.js';
import { saveCancelledInputDelivery } from '../localDb/agentInputQueueSnapshots.js';
import { TaskActionAuthorizationError } from './taskActionAuthorization.js';

const isWorkItemInput = (item: AgentInputQueuedMessage) => item.clientId.startsWith('project-workitem-input:');

/** Shared by register's live and restored coordinator paths. */
export async function validateWorkItemInputBeforePersistence(sessionId: string, item: AgentInputQueuedMessage): Promise<void> {
  if (!isWorkItemInput(item)) return;
  const owner = getCurrentDbClientSnapshot();
  if (!owner) throw new Error('HOST_NOT_READY');
  const valid = await owner.client.tx('projects.validateWorkItemDelivery', { sessionId, inputId: item.clientId });
  if (getCurrentDbClientSnapshot() !== owner || !valid.ok) throw new TaskActionAuthorizationError();
}

/** Use the ordinary durable cancellation namespace. Its unique client ID cannot
 * overwrite an accepted user row, and its write precedes queue snapshot removal.
 */
export async function settleDiscardedInputDelivery(sessionId: string, item: AgentInputQueuedMessage): Promise<void> {
  if (item.durableDelivery !== true && !isWorkItemInput(item)) return;
  await saveCancelledInputDelivery(sessionId, item.clientId);
}
