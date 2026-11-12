/**
 * 项目写动作的调用层(契约 §4)。
 *
 * - 请求带稳定 `requestId`:同一动作 + 同一输入重试复用同一个 id,宿主按键重放返回首次结果,
 *   不会重复写;输入变了或上一次已成功就换新 id。
 * - 成功返回 `{ ok: true }`,由页面统一重读详情(契约 §6 选择「控制器重读」这一种,不再消费
 *   返回的 resource)。
 * - 拒绝与网络失败都返回 `{ ok: false, error }`;文案由页面按宿主码翻译,不在这一层写死。
 */
import type { RemoteResourceRef } from '@cindy/device-link';
import { invokeRemoteResourceAction, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import type { RemoteInvoke } from '@/device-link/mobileMakerTransport';
import { PROJECT_COLLECTION_ID } from './projectModel';

export type ProjectActionOutcome = { ok: true } | { ok: false; error: unknown };

export interface ProjectActionRunnerOptions {
  invoke: RemoteInvoke;
  host: RemoteResourceHostTarget;
  resourceRef: RemoteResourceRef;
  locale?: string;
  newRequestId(): string;
}

export interface ProjectActionRunner {
  submit(actionId: string, input: Record<string, unknown>): Promise<ProjectActionOutcome>;
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}

export function createProjectActionRunner(options: ProjectActionRunnerOptions): ProjectActionRunner {
  const pending = new Map<string, { fingerprint: string; requestId: string }>();
  return {
    async submit(actionId, input) {
      const fingerprint = JSON.stringify([actionId, input]);
      const previous = pending.get(actionId);
      const requestId = previous?.fingerprint === fingerprint ? previous.requestId : options.newRequestId();
      // Kept until the round-trip succeeds: a retry of the same attempt replays, never duplicates.
      pending.set(actionId, { fingerprint, requestId });
      try {
        const response = await invokeRemoteResourceAction(options.invoke, options.host, {
          collectionId: options.resourceRef.collectionId || PROJECT_COLLECTION_ID,
          actionId,
          resourceRef: options.resourceRef,
          input: { ...input, requestId },
        }, options.locale);
        // 契约 §4 的拒绝形状是 resolve 出 `{ ok: false, errorCode }`;旧被控端直接抛错。
        const raw = record(response);
        if (raw?.ok === false) {
          return { ok: false, error: new Error(String(raw.errorCode ?? 'PRECONDITION_FAILED')) };
        }
        pending.delete(actionId);
        return { ok: true };
      } catch (error) {
        return { ok: false, error };
      }
    },
  };
}
