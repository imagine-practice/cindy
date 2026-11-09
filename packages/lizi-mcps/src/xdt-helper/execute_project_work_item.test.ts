/**
 * Unit: the tool's error-code projection for a caller-side refusal.
 *
 * Rule/bug basis (冲突报告 §4.4): `captureEntityProjectAuthority` rejects with
 * `TASK_UNAVAILABLE` when the caller task is not live — a refusal that happens before any
 * admission, so it cannot have written anything. The tool's allow-list did not contain it,
 * so the definite rejection was relabelled `OUTCOME_UNKNOWN`, which tells the model "it may have
 * been admitted; reconcile only" for a request that certainly never started.
 *
 * Minimal failure input: callback returns `{ok:false, errorCode:'TASK_UNAVAILABLE', state:'rejected'}`.
 * Tier: unit — real registry/tool handler; the host callback is the seam (the host mapping itself
 * is covered by the desktop authority tests).
 */
import { describe, expect, it } from 'vitest';
import { XdtHelperToolRegistry } from '../lizi_xdtHelperToolRegistry';
import { registerProjectWorkItemExecutionTool, type ProjectWorkItemExecuteResult } from './execute_project_work_item';

const call = async (result: ProjectWorkItemExecuteResult) => {
  const registry = new XdtHelperToolRegistry();
  registerProjectWorkItemExecutionTool(registry, {
    getSessionContext: () => ({ sessionId: 'caller', local: true } as never),
    execute: async () => result,
  });
  const response = await registry.call('execute_project_work_item', {
    intent: {
      action: 'start',
      projectId: 'p',
      sessionId: 'w1',
      expectedBindingRevision: 3,
      objective: 'ship it',
    },
  });
  const block = response.content[0];
  if (block?.type !== 'text') throw new Error('expected a text payload');
  return JSON.parse(block.text) as {
    ok: boolean;
    errorCode?: string;
    data: { state?: string; errorCode?: string };
  };
};

describe('execute_project_work_item error projection', () => {
  it('keeps a definite caller-side refusal as a rejection, not an unknown outcome', async () => {
    const payload = await call({
      ok: false,
      errorCode: 'TASK_UNAVAILABLE',
      state: 'rejected',
      requestToken: null,
    });
    expect(payload.ok).toBe(false);
    expect(payload.errorCode).toBe('TASK_UNAVAILABLE');
    expect(payload.data.state).toBe('rejected');
    expect(payload.errorCode).not.toBe('OUTCOME_UNKNOWN');
  });

  it('still folds an unlisted code into an unknown outcome', async () => {
    const payload = await call({
      ok: false,
      errorCode: 'SOMETHING_NEW',
      state: 'unknown',
      requestToken: null,
    });
    expect(payload.errorCode).toBe('OUTCOME_UNKNOWN');
  });
});
