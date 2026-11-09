import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
const fixture = vi.hoisted(() => ({ download: vi.fn(), packaged: true, urls: [] as string[], wsUrls: [] as string[], exists: vi.fn(), config: '', endpoint: 'https://chat.cindy.app', token: 'test-token', user: 'account-1', handle: vi.fn(), profiles: [] as unknown[], sockets: [] as import('ws').WebSocket[] }));
vi.mock('../../authManager.js', () => ({ getAccessToken: () => fixture.token, getCurrentUserId: () => fixture.user, getActiveAuthRealm: () => 'global', refresh: vi.fn(async () => true) }));
vi.mock('../../clientEndpointsService.js', () => ({ getClientEndpoint: () => fixture.endpoint }));
vi.mock('../chatServerMedia.js', () => ({ createChatMedia: () => ({ upload: vi.fn(async () => []), download: fixture.download }) }));
vi.mock('../chatServerWorkspaces.js', () => ({ chatServerWorkspaces: () => ({ read: () => null, save: vi.fn() }) }));
vi.mock('../chatMigrationReceipts.js', () => ({ chatMigrationReceipts: () => ({
  read: (id: string) => id === '10000000-0000-4000-8000-000000000099' ? { roomId: '10000000-0000-4000-8000-000000000001' } : null,
  save: vi.fn(),
}) }));
// These transport/lifecycle fixtures isolate native disk IO; actual snapshot and
// journal persistence is exercised through chatPersistence.test.ts and chatServer.test.ts.
vi.mock('../chatLocalHistory.js', () => ({ chatLocalHistory: () => ({ read: () => null, save: vi.fn(), forget: vi.fn() }) }));
vi.mock('../chatSendJournal.js', () => ({ chatSendJournal: () => ({ read: () => null, save: vi.fn(), confirm: vi.fn(), forgetRoom: vi.fn() }) }));
vi.mock('electron', () => ({ app: { get isPackaged() { return fixture.packaged; }, getPath: () => '/isolated' } }));
vi.mock('node:fs', () => ({ existsSync: fixture.exists, readFileSync: () => fixture.config || '{"baseUrl":"https://example.com","token":"test"}' }));
vi.mock('../botGroupChatService.js', () => ({ readPersistedReplyText: vi.fn() }));
// These are unrelated upload/planning side effects, not authorization seams.
vi.mock('../../profileEdit.js', () => ({ validateAvatarUpload: vi.fn() }));
vi.mock('../../ossPublicUpload.js', () => ({ uploadPublicAsset: vi.fn() }));
vi.mock('../botGroupDivision.js', () => ({ buildPlanStepBrief: vi.fn(), draftPlanSteps: vi.fn() }));
vi.mock('../../companion-cloud/runtime.js', () => ({ startCompanionCloud: vi.fn() }));
const db = {};
vi.mock('../../localDb/client/current.js', () => ({ getDbClient: () => db }));
vi.mock('node:http', async () => {
  const { EventEmitter } = await import('node:events');
  return { request: (url: string, options: { method: string; headers: Record<string, string> }, callback: (response: unknown) => void) => {
    fixture.urls.push(String(url));
    const req = Object.assign(new EventEmitter(), {
      end: (data?: string) => {
        void Promise.resolve().then(() => fixture.handle(new URL(url).pathname.slice(3) + new URL(url).search, options.method, data ? JSON.parse(data) : undefined, options.headers))
          .then(result => {
            const response = Object.assign(new EventEmitter(), { statusCode: result?.status ?? 200 });
            callback(response);
            response.emit('data', Buffer.from(JSON.stringify(result?.body ?? {})));
            response.emit('end');
          }, error => req.emit('error', error));
      },
      destroy: (error: Error) => req.emit('error', error),
    });
    return req;
  } };
});
vi.mock('node:https', async () => ({ request: (await import('node:http')).request }));
vi.mock('ws', async () => {
  const { EventEmitter } = await import('node:events');
  return { default: class extends EventEmitter {
    static OPEN = 1; readyState = 0; send = vi.fn();
    constructor(url: URL) { super(); fixture.wsUrls.push(String(url)); fixture.sockets.push(this as unknown as import('ws').WebSocket); }
    close() { this.emit('close'); }
  } };
});
import { withChatServer } from '../chatServer.js';
import type { BotGroupChatService, BotGroupChatServiceDeps } from '../botGroupChatService.js';

// Contract: group/project minimum contract §§1/4/5; existing settings tests have
// no main-only capture path. Minimal failure: fresh member after cached admin.
// Unit tier: native withChatServer + authenticated HTTP request boundary; no IO,
// registration or timers advanced. Separate lifecycle fixture deliberately forbids DB access.
describe('native main-only group authority', () => {
  const room = '10000000-0000-4000-8000-000000000001';
  const self = '20000000-0000-4000-8000-000000000001';
  const bot = '30000000-0000-4000-8000-000000000001';
  let service: BotGroupChatService;
  let ownerCurrent: boolean;
  let callerCurrent: boolean;
  let role: string;
  let botRole: string;
  let state: string;
  let kind: string;
  let revision: number;
  let includeBot: boolean;
  const caller = (kind: 'account' | 'bot' = 'account') => ({ subject: { kind, id: 'account-1' },
    assertCurrent: () => { if (!callerCurrent) throw new Error('SOURCE_EXPIRED'); } });
  const capture = (kind: 'account' | 'bot' = 'account', permission: 'read' | 'configure' = 'configure') =>
    service.groupAuthority!.capture(room, permission, caller(kind));
  beforeEach(() => {
    vi.useFakeTimers();
    fixture.urls = []; fixture.handle.mockReset(); fixture.endpoint = 'https://chat.cindy.app';
    fixture.token = 'test-token'; fixture.user = 'account-1';
    ownerCurrent = callerCurrent = true; role = 'admin'; botRole = 'member'; state = 'joined'; kind = 'group'; revision = 1; includeBot = true;
    fixture.handle.mockImplementation((route, method, _data, headers) => {
      expect(method).toBe('GET');
      expect(headers.Authorization).toBe('Bearer test-token');
      if (route === '/me') return { body: { actor: { id: self, kind: 'human', externalId: 'account-1' } } };
      if (route === '/actors') return { body: includeBot ? [{ id: bot, kind: 'bot', externalId: 'account-1' }] : [] };
      if (route === `/conversations/${room}/snapshot`) return { body: {
        room: { id: room, kind, revision, archived: false },
        members: [ { id: self, kind: 'human', ownerActorId: self, state, role, accessRevision: 1 },
          { id: bot, kind: 'bot', ownerActorId: self, state, role: botRole, accessRevision: 2 } ],
      } };
      throw new Error('unexpected request');
    });
    service = withChatServer({ dispose: vi.fn() } as unknown as BotGroupChatService, {
      ensureLane: async () => { throw new Error('unexpected model lane'); },
      dispatch: async () => { throw new Error('unexpected model dispatch'); },
      abortLane: async () => { throw new Error('unexpected execution abort'); },
      captureOwnerScope: () => ({ ownerScopeKey: 'owner-generation-1', ownerStamp: { dataOwnerId: 'account-1', ownerGeneration: 1 } }),
      isOwnerScopeCurrent: () => ownerCurrent,
    });
  });
  afterEach(() => {
    service.dispose(); vi.useRealTimers();
    expect(fixture.handle.mock.calls.every(([, method, body]) => method === 'GET' && body === undefined)).toBe(true);
  });

  it.each(['owner', 'admin'])('captures %s via authenticated GETs and refreshes the server revision', async value => {
    role = value;
    const grant = await capture();
    expect(grant.facts).toMatchObject({ endpoint: fixture.endpoint, roomId: room, selfActorId: self, actorId: self, role: value });
    revision = 2;
    expect((await grant.refresh()).facts.roomRevision).toBe(2);
    expect(() => grant.assertCurrent()).toThrow('GROUP_AUTHORITY_EXPIRED');
    expect(fixture.handle.mock.calls.map(c => c[0])).toEqual(['/me', '/actors', `/conversations/${room}/snapshot`, '/me', '/actors', `/conversations/${room}/snapshot`]);
  });
  it('keeps member reads separate from configuration and supports an owned admin bot for the account', async () => {
    role = 'member';
    expect((await capture('account', 'read')).facts.actorId).toBe(self);
    await expect(capture()).rejects.toThrow('GROUP_ACCESS_DENIED');
    botRole = 'admin';
    expect((await capture()).facts.actorId).toBe(bot);
  });
  it('does not let a same-ID bot borrow the account role and sends the exact bot actor on its read', async () => {
    await expect(capture('bot')).rejects.toThrow('GROUP_CONFIGURATION_REQUIRED');
    botRole = 'admin';
    expect((await capture('bot')).facts.actorId).toBe(bot);
    expect(fixture.handle.mock.calls.at(-1)![3]['X-Chat-Actor']).toBe(bot);
    includeBot = false;
    await expect(capture('bot')).rejects.toThrow('GROUP_ACCESS_DENIED');
  });
  it('rejects fresh revocation instead of reusing an earlier admin snapshot', async () => {
    const grant = await capture(); role = 'member';
    await expect(grant.refresh()).rejects.toThrow();
    expect(() => grant.assertCurrent()).toThrow('GROUP_AUTHORITY_EXPIRED');
  });
  it.each(['left', 'direct', 'role-change'])('rejects %s on refresh', async change => {
    const grant = await capture();
    if (change === 'left') state = 'left';
    if (change === 'direct') kind = 'direct';
    if (change === 'role-change') role = 'owner';
    await expect(grant.refresh()).rejects.toThrow();
  });
  it.each(['owner', 'endpoint', 'token', 'source', 'dispose'])('invalidates captured %s lifetime', async change => {
    const grant = await capture();
    if (change === 'owner') ownerCurrent = false;
    if (change === 'endpoint') fixture.endpoint = 'https://other.example';
    if (change === 'token') fixture.token = 'replacement';
    if (change === 'source') callerCurrent = false;
    if (change === 'dispose') service.dispose();
    expect(() => grant.assertCurrent()).toThrow();
    await expect(grant.refresh()).rejects.toThrow();
  });
  it('checks the captured owner against fresh /me and requires owner hooks', async () => {
    fixture.handle.mockImplementation(() => ({ body: { actor: { id: self, kind: 'human', externalId: 'other-account' } } }));
    await expect(capture()).rejects.toThrow('GROUP_ACCESS_DENIED');
    service.dispose();
    service = withChatServer({ dispose: vi.fn() } as unknown as BotGroupChatService, {} as BotGroupChatServiceDeps);
    await expect(capture()).rejects.toThrow('HOST_NOT_READY');
  });
  it.each([401, 403, 404, 500])('fails closed on HTTP %s without refresh or writes', async status => {
    fixture.handle.mockImplementation(() => ({ status, body: { error: { code: 'AUTH_REQUIRED' } } }));
    await expect(capture()).rejects.toThrow();
    expect(fixture.handle).toHaveBeenCalledTimes(1);
  });
  it('fails closed on network errors and owner change while awaiting a response', async () => {
    fixture.handle.mockImplementation(() => { throw new Error('offline'); });
    await expect(capture()).rejects.toThrow('offline');
    fixture.handle.mockImplementation(() => { ownerCurrent = false; return { body: {} }; });
    await expect(capture()).rejects.toThrow();
  });
  it('rejects an actor belonging to a different owner and missing snapshot capability', async () => {
    const original = fixture.handle.getMockImplementation()!;
    fixture.handle.mockImplementation((...args) => {
      const result = original(...args);
      if (args[0].endsWith('/snapshot')) result.body.members[1].ownerActorId = bot;
      return result;
    });
    botRole = 'admin';
    await expect(capture('bot')).rejects.toThrow('GROUP_ACCESS_DENIED');
    fixture.handle.mockImplementation((...args) => args[0].endsWith('/snapshot') ? { body: {} } : original(...args));
    await expect(capture()).rejects.toThrow();
  });
  it('rejects a caller with no live guard before requesting any facts', async () => {
    await expect(service.groupAuthority!.capture(room, 'read', { subject: { kind: 'account', id: 'account-1' } } as never)).rejects.toThrow('HOST_NOT_READY');
    expect(fixture.handle).not.toHaveBeenCalled();
  });
  it('resolves a completed native migration receipt then authorizes its canonical room without migration writes', async () => {
    const grant = await service.groupAuthority!.capture('10000000-0000-4000-8000-000000000099', 'configure', caller());
    expect(grant.facts.roomId).toBe(room);
    expect(fixture.handle.mock.calls.at(-1)![0]).toBe(`/conversations/${room}/snapshot`);
  });
});
