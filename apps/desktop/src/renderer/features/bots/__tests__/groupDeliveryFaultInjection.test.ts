/**
 * 群投递异常注入（自动化层，B 轨）。被测生产入口：
 * `sendProjectProgressSummary` → `sendBotGroupTextThroughOutbox` → Main 的
 * `createBotGroupOutboxStorage`（真实的 command/send 受理代码，只有「服务端」被替换）。
 *
 * 覆盖四类可控故障在**数据与回执**上的可观察结果：
 * F1 断网（整条链路拒发）→ 不丢消息、不越过队头、恢复后按序各补一次、回执由时间线收口；
 * F2 丢回执（Main 已提交但回答丢失）→ 项目层不写回执、不换发送标识，重放同一枚标识拿回同一条；
 * F3 无应答（超时）→ 在飞期间重放/重试不产生第二条投递，原应答到达后只留一条；
 * F4 重复请求（同一 requestId 并发重放）→ 只受理一次，服务端只收到一条。
 *
 * 测试价值
 * - 生产入口与可观察结果：上列的公开函数 + 真实 Main 受理层；用户看到的是「发送中/已发送/失败可重试」
 *   与群里到底有几条消息、本机是否记下回执。
 * - Bug／规则依据：`docs/dev-rules/engineering-conventions.md` §3.2；投递幂等口径来自
 *   `docs/plans/2026-11-06-project-progress-to-group.md`（同内容可再发，未知重试复用同一枚标识）。
 * - 现有覆盖缺口：`botGroupOutbox.test.ts` 覆盖了重连恢复（重启后整队重放）、丢失 **enqueue** 回答、
 *   丢失 **send** 回答后的重试对账；`ProjectProgressToGroup.test.tsx` 覆盖的是无 coordinator 的直发路径。
 *   缺口是：coordinator 在飞门禁（BUSY / ALREADY_CLAIMED / NOT_CLAIMABLE）、在飞期间的重放与重试、
 *   断网时的队头门禁、以及 Coordinator 路径上「丢了回答但 Main 已提交」之后项目层回执如何补齐。
 * - 最小失败输入：发送链路在 claim 之后抛错/不回答、或 Main 提交后回答丢失；旧行为下会
 *   要么出现第二条消息、要么把未知当成功写回执、要么越过队头乱序补发。
 * - tier：unit（node 环境；真实 Main 受理代码 + 临时目录 + 内存 mock 服务端，无网络、无 Electron 窗口）。
 * - 实测耗时：见本次交付文档；`pnpm --dir apps/desktop exec vitest run <本文件>`。
 */
import { EventEmitter } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import type { WebContents } from 'electron';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type {
  BotGroupOutboxCommandRequest,
  BotGroupOutboxCommandResult,
  BotGroupOutboxExecution,
  BotGroupOutboxStorageRequest,
  BotGroupOutboxStoredEntry,
} from '../../../../shared/botGroupOutboxStorage';
import type { BotGroupSendInput, BotGroupSendResult } from '../../../../shared/botGroupChat';

vi.mock('../../../../main/appSessionState.js', () => ({
  getActiveAppSession: () => ({ dataOwnerId: null, generation: 0 }),
  isAppSessionBoundaryPending: () => false,
  ownerScopedUserDataPath: () => '',
  onAppSessionInvalidated: () => () => {},
}));
vi.mock('../../../../main/localDb/client/current.js', () => ({ getDbClient: () => ({ drizzle: {} }) }));
vi.mock('../../../../main/cindy-media/blobStore.js', () => ({ parseBlobUrl: () => null }));
vi.mock('../../../../main/cindy-media/ledger.js', () => ({}));
import { createBotGroupOutboxStorage } from '../../../../main/maker-ipc/botGroupOutboxStorage';

import {
  getBotGroupOutbox,
  resetBotGroupOutboxForTests,
  retryBotGroupSend,
  sendBotGroupTextThroughOutbox,
  startBotGroupOutbox,
  type BotGroupOutboxSendInput,
} from '../botGroupOutbox';
import {
  projectProgressClientId,
  resetProjectProgressSyncReceipts,
  sendProjectProgressSummary,
} from '../../projects/progress/projectProgressSync';

const mocks = vi.hoisted(() => ({
  /** 数据所有者账号；null 表示登录边界的空档。 */
  owner: 1 as number | null,
  generation: 0,
  /** 「服务端」群发送：故障注入点之一（抛错 / 不回答 / 正常回答）。 */
  service: vi.fn<(input: BotGroupSendInput) => Promise<BotGroupSendResult>>(),
  getBotGroup: vi.fn(),
  list: { groups: [] as Array<{ id: string }>, loaded: false },
  listListeners: new Set<() => void>(),
  storage: undefined as undefined | ((request: BotGroupOutboxStorageRequest) => Promise<BotGroupOutboxStoredEntry[]>),
  command: undefined as undefined | ((request: BotGroupOutboxCommandRequest) => Promise<BotGroupOutboxCommandResult>),
  /** renderer 眼里的 IPC 发送入口：故障注入点之二（回答丢失）。 */
  mainSend: undefined as undefined | ((input: BotGroupSendInput, execution?: BotGroupOutboxExecution) => Promise<BotGroupSendResult>),
}));

vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: mocks.owner === null ? null : `account-${mocks.owner}`, generation: mocks.generation }),
  isDataOwnerGenerationCurrent: (owner: { dataOwnerId: string | null; generation: number }) =>
    owner.dataOwnerId === (mocks.owner === null ? null : `account-${mocks.owner}`) && owner.generation === mocks.generation,
}));
vi.mock('../botGroupStore', () => ({
  botGroupApi: () => ({
    sendBotGroupMessage: (input: BotGroupSendInput, execution?: BotGroupOutboxExecution) =>
      mocks.mainSend ? mocks.mainSend(input, execution) : mocks.service(input),
    getBotGroup: mocks.getBotGroup,
    botGroupOutbox: mocks.storage,
    botGroupOutboxCommand: mocks.command,
  }),
  getBotGroupListSnapshot: () => mocks.list,
  subscribeBotGroups: (listener: () => void) => {
    mocks.listListeners.add(listener);
    return () => mocks.listListeners.delete(listener);
  },
}));
vi.mock('@/lib/annotationBurnIn', () => ({
  isAnnotationBurnInError: () => false,
  materializeAnnotatedAttachmentsForSend: async (files: readonly unknown[]) => [...files],
}));
vi.mock('@/lib/composerDraftStore', () => ({ setBotGroupOutboxAttachmentUrls: () => {} }));
vi.mock('@/lib/chatAttachmentStageCleanup', () => ({ cleanupStagedChatAttachmentFiles: () => {} }));

const GROUP = '11111111-2222-4333-8444-555555555555';
const RECEIPT_KEY = 'cindy.projectProgressSync.receipts.v2';
const summary = { projectId: 'p1', text: '项目进展摘要：2 项进行中' };

function input(clientId: string): BotGroupOutboxSendInput {
  return { groupId: GROUP, clientId, text: `进展 ${clientId}`, mentions: { all: false, botIds: [] } };
}

/** 一次还没有答案的服务端调用；测试决定何时、如何回答。 */
function deferred() {
  let resolve!: (result: BotGroupSendResult) => void;
  const promise = new Promise<BotGroupSendResult>((res) => { resolve = res; });
  return { promise, resolve };
}

const flush = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

interface Bridge {
  main: ReturnType<typeof createBotGroupOutboxStorage>;
  sender: WebContents;
  owner: () => { dataOwnerId: string; generation: number };
  snapshot: () => Promise<BotGroupOutboxStoredEntry[]>;
}

const tempRoots: string[] = [];

/** 真实的 Main 受理层（command/send 都是生产代码），只有群服务被 mocks.service 替换。 */
function createBridge(): Bridge {
  const root = mkdtempSync(path.join(tmpdir(), 'cindy-group-delivery-fault-'));
  tempRoots.push(root);
  const owner = () => ({ dataOwnerId: `account-${mocks.owner ?? 1}`, generation: mocks.generation });
  const main = createBotGroupOutboxStorage({
    currentOwner: owner,
    boundaryPending: () => mocks.owner === null,
    ownerRoot: () => path.join(root, String(mocks.owner)),
    retain: async () => async () => {},
    release: async () => {},
  });
  const sender = Object.assign(new EventEmitter(), { isDestroyed: () => false }) as unknown as WebContents;
  mocks.storage = (request) => main.access(request);
  mocks.command = (request) => main.command(sender, request);
  mocks.mainSend = (incoming, execution) => main.send(sender, incoming, execution, mocks.service);
  return {
    main, sender, owner,
    snapshot: async () => (await main.command(sender, { action: 'snapshot', owner: owner() })).entries,
  };
}

const store = new Map<string, string>();

beforeEach(() => {
  mocks.owner = 1;
  mocks.generation = 0;
  mocks.storage = undefined;
  mocks.command = undefined;
  mocks.mainSend = undefined;
  mocks.service.mockReset();
  mocks.getBotGroup.mockReset().mockResolvedValue({ ok: true, group: { messages: [], hasMoreBefore: false } });
  mocks.list = { groups: [], loaded: false };
  store.clear();
  vi.stubGlobal('localStorage', {
    getItem: (key: string) => store.get(key) ?? null,
    setItem: (key: string, value: string) => { store.set(key, value); },
    removeItem: (key: string) => { store.delete(key); },
  });
  resetProjectProgressSyncReceipts();
  resetBotGroupOutboxForTests();
});

afterEach(() => {
  resetBotGroupOutboxForTests();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  for (const root of tempRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('群投递异常注入', () => {
  it('F1 断网：不丢消息、不越过队头，恢复后按序各补一次，回执由时间线对账收口', async () => {
    const bridge = createBridge();
    vi.stubGlobal('window', new EventTarget());
    // 断网期间连群都读不到：恢复循环只能走重发分支，不能靠「读到了时间线」蒙混过去。
    mocks.getBotGroup.mockResolvedValue({ ok: false, errorCode: 'INTERNAL', message: '' });
    mocks.service.mockRejectedValueOnce(new Error('ENETDOWN'));

    const first = await sendBotGroupTextThroughOutbox(input('offline-a'));
    expect(first.messageId).toBeUndefined();
    expect(first.retryable).toBe(true);
    // 第二条排在失败的队头后面：断网期间一次都不尝试。
    const second = await sendBotGroupTextThroughOutbox(input('offline-b'));
    expect(second.messageId).toBeUndefined();
    expect(mocks.service.mock.calls.map(([sent]) => sent.clientId)).toEqual(['offline-a']);
    // 不丢消息：失败的这一条仍然在 Main 的durable 队列里，可重试。
    expect(await bridge.snapshot()).toEqual([
      expect.objectContaining({ status: 'failed', retryable: true, input: expect.objectContaining({ clientId: 'offline-a' }) }),
      expect.objectContaining({ status: 'sending', input: expect.objectContaining({ clientId: 'offline-b' }) }),
    ]);

    mocks.service.mockResolvedValue({ ok: true, messageId: 'm-a' });
    mocks.getBotGroup.mockResolvedValue({ ok: true, group: { messages: [], hasMoreBefore: false } });
    const stop = startBotGroupOutbox();
    try {
      // 网络恢复：一次 online 只推进队头一条，绝不越过它去发后面的。
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(2));
      expect(mocks.service.mock.calls.map(([sent]) => sent.clientId)).toEqual(['offline-a', 'offline-a']);
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(3));
      expect(mocks.service.mock.calls.map(([sent]) => sent.clientId)).toEqual(['offline-a', 'offline-a', 'offline-b']);
      expect((await bridge.snapshot()).map((row) => [row.input.clientId, row.status])).toEqual([
        ['offline-a', 'sent'], ['offline-b', 'sent'],
      ]);
      // 重发沿用同一枚标识：服务端 (group, clientId) 唯一约束下只可能是一条。
      expect(new Set(mocks.service.mock.calls.map(([sent]) => sent.clientId))).toEqual(new Set(['offline-a', 'offline-b']));

      // 恢复后对账补齐回执：时间线读到这两条，出队与 Main 的 durable 行一起收口，不再发第三次。
      mocks.getBotGroup.mockResolvedValue({ ok: true, group: { messages: [
        { id: 'm-a', sequence: 1 }, { id: 'm-b', sequence: 2 },
      ], hasMoreBefore: false } });
      window.dispatchEvent(new Event('online'));
      await vi.waitFor(async () => expect(await bridge.snapshot()).toEqual([]));
      expect(getBotGroupOutbox(GROUP)).toEqual([]);
      expect(mocks.service).toHaveBeenCalledTimes(3);
    } finally { stop(); }
  });

  it('F2 丢回执：项目层不写回执、不换标识；Main 已提交的那一条由重放/对账补齐', async () => {
    const bridge = createBridge();
    mocks.service.mockResolvedValue({ ok: true, messageId: 'm-lost-ack' });
    // IPC 边界丢回答的注入点：Main 已提交，renderer 只拿到一个异常。
    const admitted = mocks.mainSend!;
    mocks.mainSend = async (incoming, execution) => { await admitted(incoming, execution); throw new Error('ipc reply lost'); };

    const failed = await sendProjectProgressSummary({ groupId: GROUP, summary, sendId: 'send-1' });
    expect(failed).toMatchObject({ kind: 'failed', retryable: true,
      reasonKey: 'projectProgressToGroup.unknownOutcome' });
    // 结果未知 ≠ 已发送：本机不写回执，界面不能显示成功。
    expect(store.get(RECEIPT_KEY)).toBeUndefined();
    expect(mocks.service).toHaveBeenCalledTimes(1);

    // Main 的权威状态与 renderer 拿到的回答无关：这一枚已经入库并带上了服务端回执。
    await vi.waitFor(async () => expect(await bridge.snapshot()).toEqual([
      expect.objectContaining({ status: 'sent', messageId: 'm-lost-ack' }),
    ]));
    await vi.waitFor(() => expect(getBotGroupOutbox(GROUP).map((entry) => entry.status)).toEqual(['sent']));

    // 同一枚标识重放：拿回同一条消息，服务端不会多出第二条。
    const replay = await sendProjectProgressSummary({ groupId: GROUP, summary, sendId: 'send-1' });
    expect(replay).toEqual({ kind: 'sent', messageId: 'm-lost-ack' });
    expect(mocks.service).toHaveBeenCalledTimes(1);
    const clientId = projectProgressClientId(summary.projectId, summary.text, 'send-1');
    expect(JSON.parse(store.get(RECEIPT_KEY)!)).toEqual({ [`${GROUP}\u0000${clientId}`]: 'm-lost-ack' });
    // 回执补上以后再重放：如实说「已发送过」，仍然只有一条。
    expect(await sendProjectProgressSummary({ groupId: GROUP, summary, sendId: 'send-1' }))
      .toEqual({ kind: 'alreadySent', messageId: 'm-lost-ack' });
    expect(mocks.service).toHaveBeenCalledTimes(1);
  });

  it('F3 无应答（超时）：在飞期间重放与重试都不产生第二条，原应答到达后只留一条', async () => {
    const bridge = createBridge();
    const hung = deferred();
    mocks.service.mockReturnValueOnce(hung.promise);

    const first = sendBotGroupTextThroughOutbox(input('timeout-1'));
    await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(1));
    // 生产实现没有发送超时：断开的那条链路会一直停在「发送中」（能力缺口 G1，见交付文档）。
    // 但数据上不能因此重复投递——重试按钮与重放请求沿用同一枚标识，都只能等在飞的这一条。
    // （Main 层「另一个窗口抢 claim 被拒」由 botGroupOutboxStorage.test.ts 覆盖，这里不重复。）
    retryBotGroupSend(GROUP, 'timeout-1');
    const replay = sendBotGroupTextThroughOutbox(input('timeout-1'));
    let replaySettled = false;
    void replay.then(() => { replaySettled = true; }, () => { replaySettled = true; });
    await flush();
    expect(replaySettled).toBe(false);
    expect(mocks.service).toHaveBeenCalledTimes(1);
    expect(mocks.service.mock.calls.map(([sent]) => sent.clientId)).toEqual(['timeout-1']);

    hung.resolve({ ok: true, messageId: 'm-timeout' });
    expect(await first).toEqual({ messageId: 'm-timeout', retryable: false });
    expect(await replay).toEqual({ messageId: 'm-timeout', retryable: false });
    expect(await bridge.snapshot()).toEqual([expect.objectContaining({ status: 'sent', messageId: 'm-timeout' })]);
    // 结算之后再重放同一枚标识：仍是同一条，服务端没有被再调一次。
    expect(await sendBotGroupTextThroughOutbox(input('timeout-1'))).toEqual({ messageId: 'm-timeout', retryable: false });
    expect(mocks.service).toHaveBeenCalledTimes(1);
  });

  it('F4 同一 requestId 并发重放：只受理一次、只发一条，后到的那次可凭同一枚标识补齐回执', async () => {
    const bridge = createBridge();
    const slow = deferred();
    mocks.service.mockReturnValueOnce(slow.promise);

    // 两个入口（例如项目进度同步与另一处重放）带着同一枚标识同时发起。
    const first = sendBotGroupTextThroughOutbox(input('dup-1'));
    const second = sendBotGroupTextThroughOutbox(input('dup-1'));
    await vi.waitFor(() => expect(mocks.service).toHaveBeenCalledTimes(1));
    // 同一枚 enqueueOperationId 的第二次受理是幂等回执：不追加记录，也没有越过在飞的这一条再发一次。
    expect(mocks.service.mock.calls.map(([sent]) => sent.clientId)).toEqual(['dup-1']);
    expect(await bridge.snapshot()).toEqual([expect.objectContaining({
      status: 'sending', input: expect.objectContaining({ clientId: 'dup-1' }),
    })]);

    slow.resolve({ ok: true, messageId: 'm-dup' });
    const outcomes = await Promise.all([first, second]);
    // 这一次点击最多对应一条群消息：没有任何调用拿到第二个 messageId。
    expect([...new Set(outcomes.map((outcome) => outcome.messageId).filter(Boolean))]).toEqual(['m-dup']);
    expect(mocks.service).toHaveBeenCalledTimes(1);
    expect(await bridge.snapshot()).toEqual([expect.objectContaining({ status: 'sent', messageId: 'm-dup' })]);
    // 拿到「结果未知」的那一次既不换标识也不重发：用同一枚标识重放即可补回同一条回执
    // （当前实现里先到的那次仍可能报未知：它在本机乐观行上抢跑，见交付文档「能力缺口」）。
    expect(await sendBotGroupTextThroughOutbox(input('dup-1'))).toEqual({ messageId: 'm-dup', retryable: false });
    expect(mocks.service).toHaveBeenCalledTimes(1);
  });
});
