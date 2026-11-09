/**
 * Test value (unit): G0 §3.1/3.2, G-02/04/05/11/12/13. Real public build/parse
 * entries must preserve account/device/source/epoch and reject unsafe or unsupported cards.
 * Existing quote/task tests cover message snapshots, not private project locators. Minimal
 * failure: same project UUID on another account/device, or missing bindingRevision.
 * JSON roundtrip is local wire encoding, not proof of Chat Server persistence or old UI rendering.
 */
import { describe, expect, it } from 'vitest';
import {
  buildProjectGroupReferenceCard, readProjectGroupReferenceCard, parseProjectGroupReference,
  projectGroupReferenceKey, normalizeProjectGroupEndpoint,
  type ProjectGroupReference,
} from '../projectGroupReference';
import { parseClientEndpointManifest } from '../clientEndpointSchema';
import { readBotGroupQuoteCard } from '../botGroupQuote';
import { readBotGroupTaskCard } from '../botGroupTask';
import { readBotGroupProcessCard } from '../botGroupProcess';

const project = (): ProjectGroupReference => ({ kind: 'project',
  locator: { accountId: 'account-a', deviceId: 'device:opaque_A-1', projectId: 'same-uuid' },
  source: { endpoint: 'https://chat.example/CaseSensitive/API/', roomId: 'room-a', threadRootId: null } });
const task = (): ProjectGroupReference => ({ ...project(), kind: 'work-item',
  locator: { ...project().locator, sessionId: 'session-a', bindingRevision: 7 } });
const wire = (reference: ProjectGroupReference) => JSON.parse(JSON.stringify(buildProjectGroupReferenceCard(reference)));

describe('private project group reference revision 1', () => {
  it.each([project, task])('roundtrips a locator without resolving or adding execution fields', make => {
    const original = make(), before = JSON.stringify(original), card = wire(original);
    expect(readProjectGroupReferenceCard(card)).toEqual(parseProjectGroupReference(original));
    expect(card.data.source.endpoint).toBe('https://chat.example/CaseSensitive/API');
    expect(JSON.stringify(original)).toBe(before);
    expect(Object.keys(card).sort()).toEqual(['data','fallback','namespace','schemaRevision','type']);
    expect(Object.keys(card.data).sort()).toEqual(['kind','locator','source']);
  });

  it('separates same-id entities by account, device and explicit project identity, never by name', () => {
    const a = project(), b = project(), c = project(), d = project();
    b.locator.accountId = 'account-b'; c.locator.deviceId = 'another-device'; d.locator.projectId = 'other-id';
    expect(new Set([a,b,c,d].map(projectGroupReferenceKey)).size).toBe(4);
    expect(parseProjectGroupReference({ ...a, title: 'same name' })).toBeNull();
    expect(parseProjectGroupReference({ ...a, locator: { name: 'same name', directory: '/same' } })).toBeNull();
  });

  it('keeps source endpoint, room and thread independent from resource identity', () => {
    const variants = [project(),project(),project(),project()];
    variants[1].source.endpoint = 'https://other.example/CaseSensitive/API';
    variants[2].source.roomId = 'room-b'; variants[3].source.threadRootId = 'root-a';
    expect(new Set(variants.map(projectGroupReferenceKey)).size).toBe(4);
    expect(variants.map(v => readProjectGroupReferenceCard(wire(v))?.locator)).toEqual(variants.map(v => v.locator));
    expect(parseProjectGroupReference({ ...project(), source: { endpoint: project().source.endpoint, roomId: 'room-a' } })).toBeNull();
  });

  it('preserves session and binding revision; no stale token is guessed or refreshed', () => {
    const a=task(), b=task(), c=task();
    if (b.kind !== 'work-item' || c.kind !== 'work-item') throw Error('fixture');
    b.locator.bindingRevision++; c.locator.sessionId = 'session-b';
    expect(new Set([a,b,c].map(projectGroupReferenceKey)).size).toBe(3);
    expect(readProjectGroupReferenceCard(wire(a))).toEqual(parseProjectGroupReference(a));
    // Structural parser cannot compare against the actual database binding; later resolver must.
    expect(parseProjectGroupReference({ ...a, locator: { ...project().locator, sessionId: 'session-a' } })).toBeNull();
  });

  it.each([-1, 1.5, Number.MAX_SAFE_INTEGER+1, NaN, Infinity, '7', null])('rejects invalid binding revision %s', bindingRevision => {
    expect(parseProjectGroupReference({ ...task(), locator: { ...task().locator, bindingRevision } })).toBeNull();
  });

  it('accepts explicit zero and maximum safe binding tokens without coercing them', () => {
    for (const bindingRevision of [0,Number.MAX_SAFE_INTEGER]) {
      const value={ ...task(), locator: { ...task().locator, sessionId:'s',bindingRevision } } as ProjectGroupReference;
      expect(readProjectGroupReferenceCard(wire(value))).toEqual(parseProjectGroupReference(value));
    }
  });

  it.each([0,2,'1',undefined])('fails an unsupported or missing feature revision %s', schemaRevision => {
    expect(readProjectGroupReferenceCard({ ...wire(task()),schemaRevision })).toBeNull();
  });

  it.each([null, [], {}, {kind:'follow-up'}, {kind:'directory-project'}])('rejects incomplete or unknown reference input %s', value => {
    expect(parseProjectGroupReference(value)).toBeNull();
    expect(() => buildProjectGroupReferenceCard(value as ProjectGroupReference)).toThrow('INVALID_PROJECT_GROUP_REFERENCE');
  });

  it('rejects private fields and claimed authority instead of copying them into a card or fallback', () => {
    const a=project();
    for (const field of ['title','summary','body','attachments','storageRef','path','actor','ownerVerified']) {
      const value={ ...a,[field]:'PRIVATE-SENTINEL' };
      expect(parseProjectGroupReference(value)).toBeNull();
      expect(() => buildProjectGroupReferenceCard(value)).toThrow('INVALID_PROJECT_GROUP_REFERENCE');
      expect(readProjectGroupReferenceCard({ ...wire(a), data: { ...a,[field]:'PRIVATE-SENTINEL' } })).toBeNull();
    }
    expect(readProjectGroupReferenceCard({ ...wire(a), fallback:'PRIVATE-SENTINEL' })).toBeNull();
    expect(readProjectGroupReferenceCard({ ...wire(a), text:'PRIVATE-SENTINEL' })).toBeNull();
    const card=wire(a), other=wire(task());
    expect(card.fallback).toBe(other.fallback);
    for (const value of Object.values(a.locator)) expect(card.fallback).not.toContain(value);
    expect(card.fallback).not.toContain(a.source.roomId);
  });

  it('bounds opaque IDs without UUID assumptions or truncation, and keeps project/session limits separate', () => {
    const value={ ...task(), locator: { accountId:'a'.repeat(200),deviceId:'d'.repeat(500),projectId:'p'.repeat(200),sessionId:'s'.repeat(200),bindingRevision:1 },
      source:{endpoint:'https://chat.example',roomId:'r'.repeat(500),threadRootId:'t'.repeat(500)} } as ProjectGroupReference;
    expect(readProjectGroupReferenceCard(wire(value))).toEqual(value);
    for (const [field,max] of [['accountId',200],['deviceId',500],['projectId',200],['sessionId',200]] as const) {
      expect(parseProjectGroupReference({ ...value,locator:{ ...value.locator,[field]:'x'.repeat(max+1) } })).toBeNull();
    }
    expect(parseProjectGroupReference({ ...value,source:{ ...value.source,roomId:'r'.repeat(501) } })).toBeNull();
    expect(parseProjectGroupReference({ ...value,source:{ ...value.source,threadRootId:'t'.repeat(501) } })).toBeNull();
    for (const deviceId of ['', 'device name', 'bad\u0000id']) expect(parseProjectGroupReference({ ...value,locator:{ ...value.locator,deviceId } })).toBeNull();
  });

  it('uses existing endpoint normalization and preserves case-sensitive URL paths', () => {
    for (const endpoint of [' https://Chat.Example/Case/API/// ', 'http://127.0.0.1:3018/']) {
      const existing=parseClientEndpointManifest(JSON.stringify({schemaVersion:1,chatApiBaseUrl:endpoint}),{allowHttp:true});
      expect(existing.ok).toBe(true);
      if(existing.ok) expect(normalizeProjectGroupEndpoint(endpoint)).toBe(existing.endpoints.chatApiBaseUrl);
    }
    expect(normalizeProjectGroupEndpoint('https://Chat.Example/Case/API')).not.toBe(normalizeProjectGroupEndpoint('https://Chat.Example/case/API'));
    expect(projectGroupReferenceKey(project())).toBe(projectGroupReferenceKey({ ...project(),source:{ ...project().source,endpoint:'https://chat.example/CaseSensitive/API///' } }));
  });

  it.each(['', 'not a URL','file:///private','https://user:secret@chat.example','https://chat.example?token=secret', 'https://chat.example/#secret', 'https://chat.example/'+ 'x'.repeat(2048)])('rejects invalid or secret-bearing endpoint %s', endpoint => {
    expect(normalizeProjectGroupEndpoint(endpoint)).toBeNull();
    expect(parseProjectGroupReference({ ...project(),source:{ ...project().source,endpoint } })).toBeNull();
  });

  it('remains unknown to existing shared card readers and preserves only a generic fallback in JSON', () => {
    const card=wire(task());
    expect(readBotGroupQuoteCard(card)).toBeNull();
    expect(readBotGroupTaskCard(card)).toBeNull();
    expect(readBotGroupProcessCard(card)).toBeNull();
    expect(card.fallback).toMatch(/authorized resolution required/);
    expect(readProjectGroupReferenceCard({ ...card,namespace:'cindy.unknown' })).toBeNull();
    // Actual old-client content projection and server persistence are later integration checks.
  });
});
