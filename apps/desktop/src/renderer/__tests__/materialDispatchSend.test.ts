/**
 * Renderer -> Main send boundary: the queued item carries exactly the durable selector.
 *
 * M1/M2 of the slice live here: attaching a context adds `materialDispatch` (selector +
 * first-intent revision) to the existing input envelope, removing it sends nothing, and
 * the persisted user body is byte-identical either way (Main hashes it for attach).
 * M3 adds replacement: the mount read at send time wins, so a superseded context never
 * rides a later send. M4 adds Main's own rejection: a replaced/frozen revision and a prior
 * attempt state different reasons (`intent-stale` vs `already-sent`), nothing reads as sent,
 * and nothing is retried automatically.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AgentInputProjection, AgentInputQueuedMessage } from '../../shared/agentInputQueue';
import type { MaterialDispatchSelector } from '../../shared/materialDispatch';
import { remoteProjectsStore } from '@/features/device-link/remoteProjectsStore';
import { __resetStickySessionOriginForTest } from '@/features/device-link/stickySessionOrigin';

vi.mock('@/lib/messageService', () => ({
  list: vi.fn(async () => ({ items: [], hasMore: false, oldestId: null })),
  create: vi.fn(async () => ({}) as unknown),
  updateContent: vi.fn(async () => ({}) as unknown),
}));

vi.mock('@/lib/sessionService', () => ({
  touchUserSend: vi.fn(async () => {}),
  update: vi.fn(async () => ({})),
  get: vi.fn(async () => null),
}));

vi.mock('@/lib/sessionsBus', () => ({
  emitPatch: vi.fn(),
}));

vi.mock('@/lib/userPromptStore', () => ({
  getUserPrompt: () => 'test user prompt',
}));

vi.mock('@/lib/memorySettingsStore', () => ({
  getMakerMemoryEnabled: () => true,
}));

vi.mock('@/lib/logger', () => ({
  createLogger: () => ({
    debug: vi.fn(),
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
  }),
}));

vi.mock('@/lib/imageRef', () => ({
  parseUserContent: vi.fn((c: string) => ({ text: c, images: [], files: [] })),
  stringifyUserContent: vi.fn((text: string, images = [], files = []) =>
    JSON.stringify({ text, images, files }),
  ),
}));

vi.mock('@/lib/composerDraftStore', () => ({
  saveDraft: vi.fn(),
  setRemoteOptimisticAttachmentUrls: vi.fn(),
  plainTextToTiptapDoc: (s: string) => ({
    type: 'doc',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: s }] }],
  }),
}));

import { makerChatStore } from '@/lib/makerChatStore';
import { i18n } from '@/i18n';
import {
  clearMaterialDispatchMount,
  getMaterialDispatchMount,
  materialDispatchSendIntent,
  mountMaterialDispatch,
} from '@/features/materials/materialDispatchMount';

const MODEL = 'claude-opus-4-7';
const EFFORT = 'medium';
const PERM = 'default';
const WD = 'C:\\workspace';
const SESSION = 'task-material-send';
const SELECTOR: MaterialDispatchSelector = {
  contextId: 'context-1',
  projectId: 'project-1',
  workItemId: SESSION,
  bindingRevision: 3,
  purpose: 'reference',
};

/** Two distinct pinned contexts on the same task: only one mount may be live at a time. */
const SELECTOR_A: MaterialDispatchSelector = {
  contextId: 'context-a',
  projectId: 'project-1',
  workItemId: SESSION,
  bindingRevision: 3,
  purpose: 'reference',
};
const SELECTOR_B: MaterialDispatchSelector = {
  contextId: 'context-b',
  projectId: 'project-1',
  workItemId: SESSION,
  bindingRevision: 4,
  purpose: 'reference',
};

function mountContext(selector: MaterialDispatchSelector, refName: string): void {
  mountMaterialDispatch({
    sessionId: SESSION,
    selector,
    expectedRevision: 0,
    purpose: selector.purpose,
    bindingRevision: selector.bindingRevision,
    refsKey: '[]',
    refs: [{ name: refName, version: 2, readState: 'ready' }],
    mountedAt: '2026-11-06T00:00:00.000Z',
  });
}

function projection(
  sessionId: string,
  patch: Partial<AgentInputProjection> = {},
): AgentInputProjection {
  return {
    sessionId,
    pendingQueue: [],
    steeringQueueClientIds: [],
    queuePaused: false,
    queueExpanded: false,
    queueInteractionLocks: [],
    queueEditLocks: [],
    queueAbortPending: false,
    error: null,
    recovery: null,
    errorRetryText: null,
    credentialSwitchWait: null,
    ...patch,
  };
}

const enqueue = vi.fn((sessionId: string, item: AgentInputQueuedMessage) =>
  Promise.resolve(projection(sessionId, { pendingQueue: [item] })),
);
const retryLastError = vi.fn((sessionId: string) => Promise.resolve(projection(sessionId)));
const resume = vi.fn((sessionId: string) => Promise.resolve(projection(sessionId)));
const steer = vi.fn((_sessionId: string, _item: AgentInputQueuedMessage) => Promise.resolve(true));

function installElectronBridge(): void {
  const w = globalThis as unknown as { window?: Record<string, unknown> };
  if (!w.window) w.window = {};
  w.window.electronAPI = {
    maker: {
      input: { enqueue, retryLastError, resume, steer },
      onInputProjection: vi.fn(() => vi.fn()),
      onEvent: vi.fn(() => vi.fn()),
      onStatusChanged: vi.fn(() => vi.fn()),
      onInteractionRequest: vi.fn(() => vi.fn()),
      onInteractionDismissed: vi.fn(() => vi.fn()),
      send: vi.fn(async () => {}),
      steer: vi.fn(async () => {}),
      generateTitle: vi.fn(async () => ({ title: 't' })),
      abortSession: vi.fn(async () => {}),
      closeSession: vi.fn(async () => {}),
      listActive: vi.fn(async () => []),
    },
    localDb: { messages: { onCreated: vi.fn(() => vi.fn()) } },
    deviceLink: { invoke: vi.fn().mockResolvedValue(undefined) },
  };
}

const flushPromises = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
  await Promise.resolve();
};

beforeEach(() => {
  vi.clearAllMocks();
  remoteProjectsStore.clear();
  __resetStickySessionOriginForTest();
  makerChatStore.__teardownGlobalListeners();
  clearMaterialDispatchMount(SESSION);
  installElectronBridge();
});

afterEach(() => {
  makerChatStore.__teardownGlobalListeners();
  remoteProjectsStore.clear();
  __resetStickySessionOriginForTest();
});

describe('material dispatch rides the existing send envelope', () => {
  it('M1: queued item carries the exact selector and first-intent revision', async () => {
    mountMaterialDispatch({
      sessionId: SESSION,
      selector: SELECTOR,
      expectedRevision: 0,
      purpose: 'reference',
      bindingRevision: SELECTOR.bindingRevision,
      refsKey: '[]',
      refs: [{ name: 'notes.txt', version: 2, readState: 'ready' }],
      mountedAt: '2026-11-06T00:00:00.000Z',
    });

    await makerChatStore.sendMessage(SESSION, 'use the pinned material', MODEL, EFFORT, PERM, WD, undefined, undefined, {
      materialDispatch: { selector: SELECTOR, expectedRevision: 0 },
    });
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const item = enqueue.mock.calls[0][1];
    expect(item.materialDispatch).toEqual({ selector: SELECTOR, expectedRevision: 0 });
    // Main hashes this exact string for the queued intent; the selector never touches it.
    expect(item.persistedContent).toBe(JSON.stringify({ text: 'use the pinned material', images: [], files: [] }));
  });

  it('M2: without a mount nothing is attached, and the body is identical', async () => {
    await makerChatStore.sendMessage(SESSION, 'plain send', MODEL, EFFORT, PERM, WD);
    await flushPromises();

    const item = enqueue.mock.calls[0][1];
    expect(item.materialDispatch).toBeUndefined();
    expect(item.persistedContent).toBe(JSON.stringify({ text: 'plain send', images: [], files: [] }));
  });

  it('M3: replacing the mount sends context B with B\'s own intent, never A', async () => {
    mountContext(SELECTOR_A, 'notes-a.txt');
    // 用户先挂 A、还没发就换成 B:同一任务只保留一个挂载。
    mountContext(SELECTOR_B, 'notes-b.txt');

    // 视图在发送时读当前挂载(不缓存旧快照)。
    const current = getMaterialDispatchMount(SESSION);
    expect(current?.selector.contextId).toBe('context-b');

    await makerChatStore.sendMessage(
      SESSION,
      'use the replaced material',
      MODEL,
      EFFORT,
      PERM,
      WD,
      undefined,
      undefined,
      { materialDispatch: materialDispatchSendIntent(current!) },
    );
    await flushPromises();

    expect(enqueue).toHaveBeenCalledTimes(1);
    const item = enqueue.mock.calls[0][1];
    // B 的选择器(含它的新绑定代次)与 B 自己首次意图的修订号一起出发;
    // 被替换的 A 连上下文 ID 都不出现在信封里。
    expect(item.materialDispatch).toEqual({ selector: SELECTOR_B, expectedRevision: 0 });
    expect(item.materialDispatch?.selector.bindingRevision).toBe(4);
    expect(item.materialDispatch?.expectedRevision).toBe(current?.expectedRevision);
    // 耐久修订号由 Main 在入队时分配,渲染端不自造也不继承旧的那一份。
    expect(item.materialDispatchRevision).toBeUndefined();
    expect(JSON.stringify(item)).not.toContain('context-a');
    expect(item.persistedContent).toBe(
      JSON.stringify({ text: 'use the replaced material', images: [], files: [] }),
    );
  });

  it.each([
    // 修订被替换/冻结:引用已失效,并没有发出去。
    ['REVISION_CONFLICT', 'ccAgent.materials.dispatch.rejectedStale'],
    ['INTENT_CONFLICT', 'ccAgent.materials.dispatch.rejectedStale'],
    ['INTENT_FROZEN', 'ccAgent.materials.dispatch.rejectedStale'],
    // 只有已附加/已产生尝试才是真的"已发送"。
    ['OUTCOME_UNRESOLVED', 'ccAgent.materials.dispatch.rejectedSent'],
  ] as const)(
    'M4: a Main %s rejection is never shown as sent, states the reason and does not retry',
    async (code, copyKey) => {
      mountContext(SELECTOR_B, 'notes-b.txt');
      // Electron 包装后的 IPC 错误形态。
      enqueue.mockRejectedValueOnce(
        new Error(
          `Error invoking remote method maker:input:enqueue: Error: [${code}] Material input unavailable`,
        ),
      );

      const accepted = await makerChatStore.sendMessage(
        SESSION,
        'stale material send',
        MODEL,
        EFFORT,
        PERM,
        WD,
        undefined,
        undefined,
        { materialDispatch: materialDispatchSendIntent(getMaterialDispatchMount(SESSION)!) },
      );
      await flushPromises();

      expect(accepted).toBe(false);
      const clientId = enqueue.mock.calls[0][1].clientId;
      const state = makerChatStore.getSnapshot(SESSION);
      // 不显示为已发送:乐观气泡被撤下,队列里也没有留下它。
      expect(state.messages.some((message) => message.clientId === clientId)).toBe(false);
      expect(state.pendingQueue.some((message) => message.clientId === clientId)).toBe(false);
      // 按既有拒绝文案给出原因,不把 bracket code 漏给用户。
      expect(state.error).toBe(i18n.t(copyKey));
      expect(state.error).not.toContain(code);
      // 不自动重试:只入队一次,也没有触发重发或插话。
      expect(enqueue).toHaveBeenCalledTimes(1);
      expect(retryLastError).not.toHaveBeenCalled();
      expect(steer).not.toHaveBeenCalled();
      // 挂载仍在:B 没有被当成已发出,由用户重新挂载后再发。
      expect(getMaterialDispatchMount(SESSION)?.selector.contextId).toBe('context-b');
    },
  );

  it('M4: an unmapped material rejection keeps the existing error path', async () => {
    mountContext(SELECTOR_B, 'notes-b.txt');
    enqueue.mockRejectedValueOnce(new Error('[NOT_READY] Material input unavailable'));

    const accepted = await makerChatStore.sendMessage(
      SESSION,
      'unmapped material send',
      MODEL,
      EFFORT,
      PERM,
      WD,
      undefined,
      undefined,
      { materialDispatch: materialDispatchSendIntent(getMaterialDispatchMount(SESSION)!) },
    );
    await flushPromises();

    expect(accepted).toBe(false);
    // 未映射的码不被改写成材料拒绝文案,也不被吞掉:仍走既有解码路径。
    expect(makerChatStore.getSnapshot(SESSION).error).toContain('NOT_READY');
  });
});
