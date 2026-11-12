import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { describe, expect, it, vi } from 'vitest';
import { createXdtHelperMcpServer } from '../lizi_xdtHelperMcpServer.js';
import type { EntityProjectMutationCallback } from '../xdt-helper/entity_project_mutations.js';
import type { LiziMcpSessionContext } from '../types.js';

/** Test value: public MCP transport -> real registry -> strict schema -> callback.
 * Project core v1 C1-C5 / agent-user-parity require identity isolation and exact
 * outcomes; existing entity read tests cannot cover writes or uncertain receipts.
 * Minimal failures: create with forged actor; callback throws after possible commit.
 * Tier: unit, in-memory transport and controlled host, no DB/model/network.
 */
const parse = (result: unknown) => JSON.parse((result as { content: { text: string }[] }).content[0].text);
async function connect(wired = true) {
  let context: LiziMcpSessionContext | undefined = { agentKind: 'pi', workingDir: '/repo', sessionId: 'trusted' };
  const mutate = vi.fn<EntityProjectMutationCallback>(async ({ intent }) => intent.action === 'recordProgress'
    ? { ok: true, projectId: intent.projectId, sessionId: intent.sessionId, progressReceipt: { eventId: 1, revision: 1, replayed: false } }
    : { ok: true, projectId: 'p1', sessionId: null });
  const server = createXdtHelperMcpServer(wired ? { entityProjectMutation: mutate } : {},
    { agentKind: 'pi', workingDir: '/repo', getSessionContext: () => context });
  const client = new Client({ name: 'mutations-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await Promise.all([client.connect(a), server.connect(b)]);
  return {
    mutate,
    setContext: (value: typeof context) => { context = value; },
    call: async (name: string, args: object = {}) => parse(await client.callTool({ name: 'call_tool', arguments: { name, args } })),
    discover: async () => parse(await client.callTool({ name: 'list_tools', arguments: { category: 'control' } })),
    close: async () => { await client.close(); await server.close(); },
  };
}
const intents = [
  { action: 'create', input: { name: 'Project', goal: 'Goal', owner: { kind: 'account', id: 'owner' },
    members: [{ kind: 'bot', id: 'same-name-1' }, { kind: 'bot', id: 'same-name-2' }, { kind: 'account', id: 'same-name-1' }, { kind: 'bot', id: 'same-name-1' }] } },
  { action: 'update', projectId: 'p1', name: 'Renamed', goal: null, status: 'archived' },
  { action: 'addMember', projectId: 'p1', subject: { kind: 'bot', id: 'b1' } },
  { action: 'removeMember', projectId: 'p1', subject: { kind: 'bot', id: 'b1' } },
  { action: 'transferOwner', projectId: 'p1', subject: { kind: 'account', id: 'a2' } },
  { action: 'createWorkItem', projectId: 'p1', sessionId: 'draft-task', title: 'Check', taskObjective: 'Verify the result', assignee: {kind:'account',id:'owner'} },
  { action: 'bindSession', sessionId: 's1', projectId: 'p1' },
  { action: 'setAssignee', sessionId: 's1', assignee: { kind: 'bot', id: 'b1' } },
  { action: 'bindSession', sessionId: 's1', projectId: null },
  { action: 'setAssignee', sessionId: 's1', assignee: null },
  { action: 'create', input: { name: 'Default owner' } },
  { action: 'recordProgress', projectId: 'p1', sessionId: 's1', expectedRevision: 0, expectedBindingRevision: 0, requestId: 'progress-request', to: 'doing' },
  { action: 'updateWorkItem', projectId: 'p1', sessionId: 's1', expectedBindingRevision: 0, expectedUpdatedAt: '2026-11-09T00:00:00.000Z', taskObjective: 'Clarified goal' },
];
describe('public entity mutations', () => {
  // A malformed/version-mismatched host success is not a committed progress receipt.
  it.each([
    { ok: true, projectId: 'p1', sessionId: 's1' },
    { ok: true, projectId: 'wrong', sessionId: 's1', progressReceipt: { eventId: 1, revision: 1, replayed: false } },
    { ok: true, projectId: 'p1', sessionId: 'wrong', progressReceipt: { eventId: 1, revision: 1, replayed: false } },
  ])('fails closed for an incomplete or mismatched progress receipt %j', async result => {
    const h = await connect();
    try {
      h.mutate.mockResolvedValueOnce(result as never);
      expect(await h.call('mutate_project_entity', { intent: intents.find(intent => intent.action === 'recordProgress') })).toMatchObject({
        ok: false, errorCode: 'WRITE_OUTCOME_UNKNOWN', data: { writeOutcome: 'unknown' },
      });
    } finally { await h.close(); }
  });
  it('passes all seven intents once with trusted caller, preserving stable subjects and nullable clearing', async () => {
    const h = await connect();
    try {
      expect((await h.discover()).tools.map((t: { name: string }) => t.name)).toContain('mutate_project_entity');
      for (const intent of intents) {
        expect(await h.call('mutate_project_entity', { intent })).toEqual(intent.action === 'recordProgress'
          ? { ok: true, projectId: 'p1', sessionId: 's1', progressReceipt: { eventId: 1, revision: 1, replayed: false } }
          : { ok: true, projectId: 'p1', sessionId: null });
        expect(h.mutate).toHaveBeenLastCalledWith({ callerSessionId: 'trusted', intent });
      }
      expect(h.mutate).toHaveBeenCalledTimes(intents.length);
      expect((await h.call('get_capabilities', { key: 'self-management' })).entityProjects).toMatchObject({ registered: false, mutationRegistered: true });
    } finally { await h.close(); }
  });
  it('does not register or advertise writes without the optional callback', async () => {
    const h = await connect(false);
    try {
      expect((await h.discover()).tools.map((t: { name: string }) => t.name)).not.toContain('mutate_project_entity');
      expect((await h.call('mutate_project_entity', { intent: intents[0] })).errorCode).toBe('UNKNOWN_TOOL');
      expect((await h.call('get_capabilities', { key: 'self-management' })).entityProjects.mutationRegistered).toBe(false);
      expect(h.mutate).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('rejects injected identity at every nesting level, paths, invalid limits and unsupported actions before callback', async () => {
    const h = await connect();
    try {
      const injected = ['actor', 'role', 'now', 'newId', 'callerSessionId', 'grant'].flatMap(key => [
        { intent: intents[0], [key]: 'forged' },
        { intent: { ...intents[0], [key]: 'forged' } },
        { intent: { action: 'create', input: { name: 'P', [key]: 'forged' } } },
        { intent: { action: 'create', input: { name: 'P', owner: { kind: 'account', id: 'a1', [key]: 'forged' } } } },
      ]);
      const invalid = [
        ...injected,
        ...['/repo', 'C:\\repo', 'device::id'].map(projectId => ({ intent: { action: 'update', projectId } })),
        { intent: { action: 'bindSession', sessionId: '/repo', projectId: 'p1' } },
        { intent: { action: 'create', input: { name: 'x'.repeat(121) } } },
        { intent: { action: 'update', projectId: 'p1', goal: 'x'.repeat(2001) } },
        { intent: { action: 'cancel', sessionId: 's1' } },
        { intent: { action: 'create', input: { name: 'P', members: [{ kind: 'bot', id: 'b1', role: 'owner' }] } } },
        // Bounded here instead of failing later inside the worker, where the same input
        // would be reported as an unknown write outcome.
        { intent: { action: 'recordProgress', projectId: 'p1', sessionId: 's1', expectedRevision: 0, expectedBindingRevision: 0, requestId: 'r1', to: 'done', completionNote: 'x'.repeat(4001) } },
        // `expectedUpdatedAt` is an equality observation: only the canonical form the host
        // returns from a read can round-trip through Date.parse/toISOString.
        { intent: { action: 'updateWorkItem', projectId: 'p1', sessionId: 's1', expectedBindingRevision: 0, expectedUpdatedAt: '2026-11-09T08:00:00+08:00', title: 'T' } },
        { intent: { action: 'updateWorkItem', projectId: 'p1', sessionId: 's1', expectedBindingRevision: 0, expectedUpdatedAt: '2026-11-09T00:00:00Z', title: 'T' } },
      ];
      for (const args of invalid) expect((await h.call('mutate_project_entity', args)).errorCode).toBe('INVALID_ARGS');
      expect(h.mutate).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('requires live local session context and never falls back from remote to local', async () => {
    const h = await connect();
    try {
      for (const context of [undefined, { agentKind: 'pi' as const, workingDir: '/repo', sessionId: 's', remoteHostId: 'remote' },
        { agentKind: 'pi' as const, workingDir: '/repo', sessionId: 's', vendorOptions: { orcaRemoteLead: true } }]) {
        h.setContext(context);
        expect(await h.call('mutate_project_entity', { intent: intents[0] })).toMatchObject({ ok: false, data: { writeOutcome: 'not-applied' } });
      }
      expect(h.mutate).not.toHaveBeenCalled();
    } finally { await h.close(); }
  });
  it('projects success, fixes errors and preserves uncertain outcomes without retry or exception leakage', async () => {
    const h = await connect();
    try {
      h.mutate.mockResolvedValueOnce({ ok: true, projectId: 'p1', sessionId: null, secret: '/private/token' } as never);
      expect(await h.call('mutate_project_entity', { intent: intents[0] })).toEqual({ ok: true, projectId: 'p1', sessionId: null });
      for (const writeOutcome of ['not-applied', 'unknown'] as const) {
        h.mutate.mockResolvedValueOnce({ ok: false, errorCode: 'PERMISSION_DENIED', writeOutcome, message: '/private/token' } as never);
        const result = await h.call('mutate_project_entity', { intent: intents[0] });
        expect(result).toMatchObject({ ok: false, errorCode: 'PERMISSION_DENIED', data: { writeOutcome } });
        expect(JSON.stringify(result)).not.toContain('/private/token');
      }
      h.mutate.mockRejectedValueOnce(new Error('/private/token'));
      expect(await h.call('mutate_project_entity', { intent: intents[0] })).toMatchObject({ errorCode: 'WRITE_OUTCOME_UNKNOWN', data: { writeOutcome: 'unknown' } });
      h.mutate.mockResolvedValueOnce({ ok: true } as never);
      expect(await h.call('mutate_project_entity', { intent: intents[0] })).toMatchObject({ errorCode: 'WRITE_OUTCOME_UNKNOWN', data: { writeOutcome: 'unknown' } });
      expect(h.mutate).toHaveBeenCalledTimes(5);
    } finally { await h.close(); }
  });
});
