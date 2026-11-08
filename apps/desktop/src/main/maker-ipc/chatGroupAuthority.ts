import { z } from 'zod';

/** Main-only trusted subject. The caller must bind this to its live UI/task authority,
 * including input and source execution lease; a locator is never that authority. */
export interface ChatGroupAuthorityCaller {
  readonly subject: { readonly kind: 'account' | 'bot'; readonly id: string };
  assertCurrent(): void;
}
export interface ChatGroupAuthorityFacts {
  readonly endpoint: string;
  readonly roomId: string;
  readonly ownerId: string;
  readonly selfActorId: string;
  readonly actorId: string;
  readonly role: string;
  readonly roomRevision: number;
  readonly accessRevision: number;
  readonly permission: 'read' | 'configure';
}
/** Not serializable authority: keep in main memory and refresh before a commit.
 * assertCurrent fences local lifetime only; remote revocation requires refresh. */
export interface CapturedChatGroupAuthority {
  readonly facts: Readonly<ChatGroupAuthorityFacts>;
  assertCurrent(): void;
  refresh(): Promise<CapturedChatGroupAuthority>;
}
export interface ChatGroupAuthorityService {
  capture(roomId: string, permission: 'read' | 'configure', caller: ChatGroupAuthorityCaller): Promise<CapturedChatGroupAuthority>;
}

const actor = z.object({ id: z.string().uuid(), kind: z.string(), externalId: z.string().min(1), disabled: z.boolean().optional() });
const member = z.object({ id: z.string().uuid(), kind: z.string(), ownerActorId: z.string().uuid(),
  state: z.string(), role: z.enum(['owner', 'admin', 'member', 'guest']), accessRevision: z.number().int().nonnegative() });
const snapshot = z.object({ room: z.object({ id: z.string().uuid(), kind: z.string(), revision: z.number().int().positive(),
  archived: z.boolean(), dissolved_at: z.string().nullable().optional() }), members: z.array(member) });

/** Same owner-first, then self, then owned administrator order as native settings. */
export function selectChatManagementActor<T extends { id: string; ownerActorId: string; state: string; role: string }>(members: readonly T[], self: string): T | undefined {
  const eligible = members.filter(m => m.ownerActorId === self && m.state === 'joined' && ['owner', 'admin'].includes(m.role));
  return eligible.find(m => m.role === 'owner') ?? eligible.find(m => m.id === self) ?? eligible[0];
}

/** Native transport supplies a captured authenticated GET and its strict lifetime fence.
 * No registration, mutation probes, caches, device IDs or renderer claims participate. */
export function createChatGroupAuthority(deps: {
  captureBoundary(): { endpoint: string; ownerId: string; assertCurrent(): void; resolveRoom(roomId: string, selfActorId: string): string; read(route: string, actorId?: string): Promise<unknown> };
}): ChatGroupAuthorityService {
  return { async capture(roomId, permission, caller) {
    roomId = z.string().uuid().parse(roomId);
    if (!caller || typeof caller.assertCurrent !== 'function') throw new Error('HOST_NOT_READY');
    const assertCallerCurrent = caller.assertCurrent.bind(caller);
    const subject = z.object({ kind: z.enum(['account', 'bot']), id: z.string().min(1) }).strict().parse(caller.subject);
    if (permission !== 'read' && permission !== 'configure') throw new Error('INVALID_PARAMS');
    const boundary = deps.captureBoundary();
    const assertCurrent = () => { boundary.assertCurrent(); assertCallerCurrent(); };
    let valid = true;
    const assertValid = () => { if (!valid) throw new Error('GROUP_AUTHORITY_EXPIRED'); assertCurrent(); };
    const read = async (route: string, as?: string) => {
      assertCurrent();
      const value = await boundary.read(route, as);
      assertCurrent();
      return value;
    };
    assertCurrent();
    const parse = <T>(schema: z.ZodType<T>, value: unknown): T => {
      const result = schema.safeParse(value);
      if (!result.success) throw new Error('UNSUPPORTED_CAPABILITY');
      return result.data;
    };
    const me = parse(z.object({ actor }), await read('/me')).actor;
    // 拒绝要能定位：以前所有失败都只抛一个 GROUP_ACCESS_DENIED，排查时分不清是
    // 账号身份不匹配、房间形态不对，还是没有可管理的成员。这里按条件打一行原因标记，
    // 不记录 token/正文，只记录是哪一条判定没过。
    const denyReason: (reason: string) => never = (reason) => {
      console.warn('[chatGroupAuthority] denied', { reason, subjectKind: subject.kind });
      throw new Error('GROUP_ACCESS_DENIED');
    };
    if (me.kind !== 'human' || me.disabled) denyReason('me-not-human');
    if (me.externalId !== boundary.ownerId) {
      // 只记录前缀与长度用于定位身份口径，不记录正文或凭证。
      console.warn('[chatGroupAuthority] identity', {
        meKind: me.kind,
        meExternal: String(me.externalId).slice(0, 8),
        ownerId: String(boundary.ownerId).slice(0, 8),
        meLength: String(me.externalId).length,
        ownerLength: String(boundary.ownerId).length,
      });
      denyReason('me-external-id-mismatch');
    }
    if (subject.kind === 'account' && subject.id !== boundary.ownerId) denyReason('subject-account-mismatch');
    const actors = parse(z.array(actor), await read('/actors'));
    const matches = subject.kind === 'bot' ? actors.filter(a => a.kind === 'bot' && a.externalId === subject.id && !a.disabled) : [];
    if (subject.kind === 'bot' && matches.length !== 1) denyReason('bot-actor-mismatch');
    const bot = matches[0];
    roomId = z.string().uuid().parse(boundary.resolveRoom(roomId, me.id));
    const s = parse(snapshot, await read(`/conversations/${roomId}/snapshot`, bot?.id));
    if (s.room.kind !== 'group' || s.room.id !== roomId || s.room.dissolved_at
      || (permission === 'configure' && s.room.archived)) denyReason('room-shape');
    // /actors is the authenticated owner's directory; membership must independently
    // confirm the owner of the exact actor, never equate account and bot IDs.
    const owned = s.members.filter(m => m.ownerActorId === me.id && m.state === 'joined'
      && ((m.kind === 'human' && m.id === me.id) || (m.kind === 'bot' && actors.some(a => a.id === m.id && a.kind === 'bot' && !a.disabled))));
    const selected = bot ? owned.find(m => m.kind === 'bot' && m.id === bot.id)
      : permission === 'configure' ? selectChatManagementActor(owned, me.id)
        : owned.find(m => m.id === me.id) ?? owned[0];
    if (!selected) denyReason('no-owned-actor');
    if (permission === 'configure' && !['owner', 'admin'].includes(selected.role)) throw new Error('GROUP_CONFIGURATION_REQUIRED');
    const facts = Object.freeze({ endpoint: boundary.endpoint, roomId: s.room.id, ownerId: boundary.ownerId,
      selfActorId: me.id, actorId: selected.id, role: selected.role, roomRevision: s.room.revision,
      accessRevision: selected.accessRevision, permission });
    assertCurrent();
    return Object.freeze({ facts, assertCurrent: assertValid, refresh: async () => {
      assertValid();
      valid = false; // A failed refresh must never leave the old grant usable.
      const next = await this.capture(roomId, permission, { subject, assertCurrent });
      if (next.facts.actorId !== facts.actorId || next.facts.role !== facts.role) throw new Error('GROUP_AUTHORITY_CHANGED');
      return next;
    } });
  } };
}
