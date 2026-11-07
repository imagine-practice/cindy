/** Unit: trusted Host input-consumption barriers on the real Session lifecycle.
 * Existing vision tests protect graceful bridge fallback, not authorization
 * between accepted/Git, vision and provider dispatch. Minimal failures: revoke
 * in onAccepted, or replace an old steer turn while its new guard is awaiting.
 * Controlled provider/vision only; no model, accounts, DB, IO, timers or resets.
 * All waits are explicit promise gates / real Session events.
 */
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { Session, type SessionSendOptions } from './session.js';
import { AUTO_REVIEW_USER_INTENT, type AgentSessionHandle, type SendOptions } from './agents/base-agent.js';
import type { AgentEvent } from './types/events.js';
import type { Capabilities } from './types/capabilities.js';
import type { Logger } from './interfaces/logger.js';
import type { UserMessage } from './types/common.js';
import type { VisionBridgeHook } from './types/vision-bridge.js';

function gate() {
  let resolve!: () => void;
  const promise = new Promise<void>(done => { resolve = done; });
  return { promise, resolve };
}
const sessions: Session[] = [];
afterEach(async () => { await Promise.all(sessions.splice(0).map(session => session.close())); });
function fixture() {
  const order: string[] = [];
  let running = false, closed = false;
  let wake: (() => void) | undefined;
  const queue: AgentEvent[] = [];
  const send = vi.fn(async (_message: UserMessage, _opts?: SendOptions) => { order.push('send'); running = true; });
  const steer = vi.fn(async (_message: UserMessage, _opts?: SendOptions) => { order.push('steer'); });
  const finish = async () => { closed = true; running = false; wake?.(); };
  const validate = vi.fn((_opts: SendOptions) => { order.push('validate'); });
  const handle: AgentSessionHandle = {
    id: 'controlled', agentKind: 'claude-code', model: 'controlled-model', send, steer,
    validateSendOptions: validate, abort: async () => { running = false; }, close: finish, detach: finish,
    isTurnRunning: () => running,
    async *events() {
      while (!closed) {
        if (!queue.length) await new Promise<void>(resolve => { wake = resolve; });
        const event = queue.shift(); if (event) yield event;
      }
    },
    getUsageSnapshot: () => ({ tokenUsage: 0, contextTokens: 0, contextWindow: 0, costUsd: 0 }),
    setInteractionResolver: () => undefined,
  };
  const yes = { supported: true } as const;
  const caps: Capabilities = { switchModel: yes, availableModels: [], hasFastMode: false, effort: yes, effortLevels: [], reasoningDisplay: [],
    permissionModes: [], setPermissionModeMidSession: yes, multimodal: { text: yes, image: yes, file: yes }, fork: yes, rewind: yes,
    abort: yes, sameTurnSteer: yes, memory: { supported: yes }, extraDirs: yes };
  const logger: Logger = { trace() {}, debug() {}, info() {}, warn: vi.fn(), error() {}, fatal() {}, child() { return logger; } };
  const bridge = vi.fn<VisionBridgeHook>(async message => { order.push('vision'); return { applied: false, message }; });
  const session = new Session({ id: 'input-consumption', agentKind: 'claude-code', workDir: path.join('fixture', 'workspace'),
    handle, capabilities: caps, logger, visionBridge: bridge, turnStallMs: 0 });
  sessions.push(session);
  const endTurn = async () => {
    const done = gate();
    const unsubscribe = session.onEvent(event => { if (event.type === 'done') done.resolve(); });
    running = false; queue.push({ type: 'done', data: {}, source: 'claude-code' }); wake?.();
    await done.promise; unsubscribe();
  };
  return { session, handle, send, steer, validate, bridge, order, endTurn, logger };
}
const image: UserMessage = { type: 'user', content: [{ type: 'image', path: path.join('fixture', 'material.png') }] };

describe('Session Host input consumption', () => {
  it('orders send barriers after acceptance and intent without leaking Host callbacks or changing the intent', async () => {
    const h = fixture();
    const oldGrant = vi.fn(async () => { h.order.push('beforeProviderStart'); });
    const barrier = vi.fn<NonNullable<SessionSendOptions['beforeInputConsumption']>>(async stage => { h.order.push(`guard-${stage}`); });
    let dispatchMicrotaskRan = false;
    const providerSend = h.send.getMockImplementation()!;
    h.send.mockImplementation(async (message, options) => { expect(dispatchMicrotaskRan).toBe(false); await providerSend(message, options); });
    h.session.setTurnLifecycleObserver({
      beforeProviderStart: () => { h.order.push('observer-prepare'); },
      onDispatching: () => { h.order.push('observer-dispatch'); },
      onUndispatched: vi.fn(), onTerminal: vi.fn(),
    });
    const outcome = await h.session.send(image, { beforeProviderStart: oldGrant, beforeInputConsumption: barrier,
      onAccepted: async () => { h.order.push('accepted/Git'); },
      resolveAutoReviewUserIntent: async () => { h.order.push('intent'); return 'preserve exact intent'; },
      onDispatching: () => { h.order.push('dispatch'); queueMicrotask(() => { dispatchMicrotaskRan = true; }); },
    });
    expect(outcome).toEqual({ accepted: true });
    expect(h.order).toEqual(['validate', 'observer-prepare', 'beforeProviderStart', 'accepted/Git', 'guard-vision', 'vision', 'intent', 'guard-provider', 'dispatch', 'observer-dispatch', 'send']);
    expect(barrier.mock.calls).toEqual([['vision'], ['provider']]); expect(oldGrant).toHaveBeenCalledOnce();
    expect(h.send.mock.calls[0][1]?.[AUTO_REVIEW_USER_INTENT]).toBe('preserve exact intent');
    expect(h.send.mock.calls[0][1]).not.toHaveProperty('beforeInputConsumption');
    expect(h.validate.mock.calls[0][0]).not.toHaveProperty('beforeInputConsumption');
  });
  it.each(['accepted', 'vision', 'intent'] as const)('send revocation during %s blocks its next consumer and permits the next valid send', async revokedAt => {
    const h = fixture(); let allowed = true;
    if (revokedAt === 'vision') h.bridge.mockImplementation(async message => { allowed = false; return { applied: false, message }; });
    const cleanup = vi.fn();
    h.session.setTurnLifecycleObserver({ beforeProviderStart: async () => undefined, onUndispatched: cleanup, onTerminal: vi.fn() });
    const barrier: NonNullable<SessionSendOptions['beforeInputConsumption']> = async () => { if (!allowed) throw new Error('MATERIAL_ACCESS_REVOKED'); };
    await expect(h.session.send(image, { beforeInputConsumption: barrier,
      origin: { kind: 'scheduler', scheduleId: 'old', scheduleName: 'old' },
      onAccepted: async () => { if (revokedAt === 'accepted') allowed = false; },
      resolveAutoReviewUserIntent: async () => { if (revokedAt === 'intent') allowed = false; return 'original intent'; },
    })).rejects.toThrow('MATERIAL_ACCESS_REVOKED');
    expect(h.send).not.toHaveBeenCalled(); expect(h.bridge).toHaveBeenCalledTimes(revokedAt === 'accepted' ? 0 : 1);
    expect(h.session.getCurrentTurnOrigin()).toBeNull(); expect(h.session.getTurnGeneration()).toBe(0); expect(cleanup).toHaveBeenCalledOnce();
    allowed = true; h.bridge.mockImplementation(async message => ({ applied: false, message }));
    expect(await h.session.send('legitimate next input', { beforeInputConsumption: barrier })).toEqual({ accepted: true });
    expect(h.send).toHaveBeenCalledOnce(); expect(h.session.getTurnGeneration()).toBe(1);
  });
  it('does not vision-fallback around a rejecting vision barrier', async () => {
    const h = fixture();
    await expect(h.session.send(image, { beforeInputConsumption: async () => { throw new Error('DENIED'); } })).rejects.toThrow('DENIED');
    expect(h.bridge).not.toHaveBeenCalled(); expect(h.send).not.toHaveBeenCalled(); expect(h.logger.warn).not.toHaveBeenCalled();
  });
  it('keeps the no-hook order and old callback counts unchanged, including bridge fallback', async () => {
    const h = fixture(); const oldGrant = vi.fn(async () => { h.order.push('old-grant'); });
    h.bridge.mockImplementation(async () => { h.order.push('vision'); throw new Error('ordinary vision service failure'); });
    await h.session.send(image, { beforeProviderStart: oldGrant, onAccepted: async () => { h.order.push('accepted'); },
      resolveAutoReviewUserIntent: async () => { h.order.push('intent'); return undefined; }, onDispatching: () => { h.order.push('dispatch'); } });
    expect(h.order).toEqual(['validate', 'old-grant', 'accepted', 'vision', 'intent', 'dispatch', 'send']);
    expect(oldGrant).toHaveBeenCalledOnce(); expect(h.send.mock.calls[0][0]).toBe(image);
  });
  it.each(['vision', 'provider'] as const)('send cancellation/detach while awaiting %s cannot dispatch', async stage => {
    for (const change of ['cancel', 'detach']) {
      const h = fixture(), entered = gate(), release = gate();
      const controller = new AbortController();
      const pending = h.session.send(image, { signal: controller.signal, beforeInputConsumption: async point => {
        if (point === stage) { entered.resolve(); await release.promise; }
      } });
      await entered.promise;
      const teardown = change === 'detach' ? h.session.detach({ reason: 'account-boundary' }) : undefined;
      if (change === 'cancel') controller.abort();
      release.resolve(); expect(await pending).toEqual({ accepted: false, reason: 'cancelled-before-dispatch' }); await teardown;
      expect(h.send).not.toHaveBeenCalled(); expect(h.session.getCurrentTurnOrigin()).toBeNull();
      expect(h.bridge).toHaveBeenCalledTimes(stage === 'vision' ? 0 : 1);
    }
  });
  it('orders steer guards around vision and the existing grant, and strips both Host options', async () => {
    const h = fixture(); await h.session.send('start'); h.order.length = 0;
    const oldGrant = vi.fn(async () => { h.order.push('old-grant'); });
    await h.session.steer(image, { beforeProviderStart: oldGrant, beforeInputConsumption: async stage => { h.order.push(`guard-${stage}`); } });
    expect(h.order).toEqual(['guard-vision', 'vision', 'old-grant', 'guard-provider', 'steer']);
    expect(oldGrant).toHaveBeenCalledOnce(); expect(h.steer.mock.calls[0][1]).not.toHaveProperty('beforeInputConsumption');
    expect(h.steer.mock.calls[0][1]).not.toHaveProperty('beforeProviderStart');
  });
  it.each(['vision', 'old-grant'] as const)('steer revocation during %s blocks provider consumption', async where => {
    const h = fixture(); await h.session.send('start'); let allowed = true; h.steer.mockClear();
    if (where === 'vision') h.bridge.mockImplementation(async message => { allowed = false; return { applied: false, message }; });
    const oldGrant = vi.fn(async () => { if (where === 'old-grant') allowed = false; });
    await expect(h.session.steer(image, { beforeProviderStart: oldGrant, beforeInputConsumption: async () => {
      if (!allowed) throw new Error('MATERIAL_ACCESS_REVOKED');
    } })).rejects.toThrow('MATERIAL_ACCESS_REVOKED');
    expect(oldGrant).toHaveBeenCalledOnce(); expect(h.steer).not.toHaveBeenCalled();
  });
  it.each(['vision', 'provider'] as const)('steer %s rejection never falls back or damages the running turn', async rejectedStage => {
    const h = fixture(); await h.session.send('start'); h.bridge.mockClear();
    await expect(h.session.steer(image, { beforeInputConsumption: async stage => { if (stage === rejectedStage) throw new Error('DENIED'); } })).rejects.toThrow('DENIED');
    expect(h.steer).not.toHaveBeenCalled(); expect(h.bridge).toHaveBeenCalledTimes(rejectedStage === 'vision' ? 0 : 1);
    expect(h.session.getTurnGeneration()).toBe(1);
    await h.session.steer('valid next input'); expect(h.steer).toHaveBeenCalledOnce();
  });
  it.each(['vision', 'provider'] as const)('steer checks cancellation, detach and real turn replacement after %s await', async stage => {
    for (const change of ['cancel', 'detach', 'next-turn']) {
      const h = fixture();
      await h.session.send('first', { origin: { kind: 'scheduler', scheduleId: 'first', scheduleName: 'first' } });
      const entered = gate(), release = gate(), controller = new AbortController();
      const pending = h.session.steer(image, { signal: controller.signal, beforeInputConsumption: async point => {
        if (point === stage) { entered.resolve(); await release.promise; }
      } });
      // Attach the rejection assertion before any teardown may reject the promise.
      const rejected = expect(pending).rejects.toThrow();
      await entered.promise;
      if (change === 'cancel') controller.abort();
      if (change === 'detach') await h.session.detach({ reason: 'account-boundary' });
      if (change === 'next-turn') {
        await h.endTurn();
        await h.session.send('second', { origin: { kind: 'scheduler', scheduleId: 'second', scheduleName: 'second' } });
      }
      release.resolve(); await rejected; expect(h.steer).not.toHaveBeenCalled();
      if (change === 'next-turn') {
        expect(h.session.getTurnGeneration()).toBe(2);
        expect(h.session.getCurrentTurnOrigin()).toMatchObject({ scheduleId: 'second' });
        const events: AgentEvent[] = []; h.session.onEvent(event => events.push(event)); await h.endTurn();
        expect(events.find(event => event.type === 'done')).toMatchObject({ sessionTurnGeneration: 2, turnOrigin: { scheduleId: 'second' } });
      }
    }
  });
});
