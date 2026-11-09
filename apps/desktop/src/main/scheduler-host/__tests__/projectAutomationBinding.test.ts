/**
 * 自动化绑定项目实体（docs/plans/2026-11-06-automation-project-binding.md）。
 *
 * 这个文件只测一件事：**同一个判定口径**在保存期与运行期都成立，而且运行期被拒时
 * 绝不创建会话（不能产生无归属或错误归属的任务）。
 *
 * 覆盖：
 *   - 判定本身（活跃成员通过 / 非成员 / 已归档 / 项目不存在）与它给出的原因文案；
 *   - runner 真实 fire 入口：项目归档、创建者被移出成员 → 本轮失败并带原因，
 *     `maker.createSession` 一次都没被调用（A3 / A4）；
 *   - 新建任务时把 `projectId` 传给 createSession，绑定既有任务时不下传（A1 / A7）。
 *
 * 用真实 runner.fire + 真实内存 SQLite 读取，不 mock 被测函数本身。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';

import type { AgentEvent, Maker, Session, SessionSendResult } from '@cindy/maker-core';
import type { FireContext, Logger, Notifier, Schedule } from '@cindy/maker-scheduler';

const mocks = vi.hoisted(() => ({
  createMessage: vi.fn(),
  getSessionRowSnapshot: vi.fn(),
  touchUserSendInDb: vi.fn(),
  ensureDialogueWorkspaceDir: vi.fn(),
  wireSessionToIpc: vi.fn(),
  resolveWorkingDir: vi.fn(),
  backfillSessionMeta: vi.fn(),
}));

vi.mock('../../localDb/ipc/messages.js', () => ({ createMessage: mocks.createMessage }));
vi.mock('../../localDb/ipc/sessions.js', () => ({
  getSessionRowSnapshot: mocks.getSessionRowSnapshot,
  getSessionFsSnapshot: mocks.getSessionRowSnapshot,
  touchUserSendInDb: mocks.touchUserSendInDb,
}));
vi.mock('../../localDb/dialogueWorkspace', () => ({
  ensureDialogueWorkspaceDir: mocks.ensureDialogueWorkspaceDir,
}));
vi.mock('../../maker-ipc/register.js', () => ({
  wireSessionToIpc: mocks.wireSessionToIpc,
  isSessionInTurn: () => false,
  noteSilentStopUserSend: vi.fn(),
  onSilentStopSettled: vi.fn(() => () => {}),
}));
vi.mock('../workdir-resolver', () => ({ resolveWorkingDir: mocks.resolveWorkingDir }));
vi.mock('../runners/_shared', () => ({ backfillSessionMeta: mocks.backfillSessionMeta }));

import { MakerScheduleRunner } from '../runner';
import { clearCurrentDbClient, setCurrentDbClient } from '../../localDb/client/current';
import type { DbClient } from '../../localDb/client/DbClient';
import {
  assertScheduleProjectBinding,
  checkScheduleProjectBinding,
  describeScheduleProjectRejection,
} from '../projectBinding';
import type { SchedulerDrizzleDb } from '../storage';

const schema = await import('../../localDb/schema');

const OWNER = { kind: 'account' as const, id: 'owner-account' };

function freshDb(): Database.Database {
  const raw = new Database(':memory:');
  // 只建判定用到的三张表的最小形状；生产 schema 由迁移负责，这里验证的是查询口径。
  raw.exec(`
    CREATE TABLE projects (id TEXT PRIMARY KEY, status TEXT NOT NULL);
    CREATE TABLE project_members (
      project_id TEXT NOT NULL, subject_kind TEXT NOT NULL, subject_id TEXT NOT NULL,
      role TEXT NOT NULL, added_at INTEGER NOT NULL,
      PRIMARY KEY (project_id, subject_kind, subject_id));
    INSERT INTO projects VALUES ('p-active', 'active'), ('p-archived', 'archived');
    INSERT INTO project_members VALUES
      ('p-active', 'account', 'owner-account', 'owner', 1),
      ('p-archived', 'account', 'owner-account', 'owner', 1),
      ('p-active', 'account', 'teammate', 'member', 1);
  `);
  return raw;
}

type SessionSendOptions = Parameters<Session['send']>[1];
type SendImpl = (
  message: Parameters<Session['send']>[0],
  opts?: SessionSendOptions,
) => Promise<SessionSendResult>;

function createLogger(): Logger {
  return { warn: vi.fn(), info: vi.fn(), debug: vi.fn(), error: vi.fn() };
}

function baseSchedule(overrides: Partial<Schedule> = {}): Schedule {
  return {
    id: 'schedule-1',
    name: 'project follow-up',
    prompt: 'check the project status',
    jobType: 'prompt',
    source: 'user',
    kind: 'cron',
    cronExpr: '*/10 * * * *',
    timezone: 'Asia/Shanghai',
    recurring: true,
    manual: false,
    agentKind: 'codex',
    model: 'gpt-6-astra',
    workspaceKind: 'project',
    workingDir: '/repo/project',
    useWorktree: false,
    notify: { desktop: true, feishu: false },
    status: 'active',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
    ...overrides,
  };
}

function createFireContext(): FireContext {
  return {
    runId: 'run-1',
    firedAt: 1_700_000_000_100,
    signal: new AbortController().signal,
    onSessionBound: vi.fn(async () => undefined),
  };
}

function acceptingSend(): SendImpl {
  return async (_message, opts) => {
    await opts?.onAccepted?.();
    return { accepted: true };
  };
}

function createSessionHarness(sendImpl: SendImpl) {
  const listeners: Array<(event: AgentEvent) => void> = [];
  const session = {
    id: 'scheduler-session',
    agentKind: 'codex',
    stablePermissionModeState: { mode: 'ask', generation: 0 },
    stablePlanModeState: { enabled: false, generation: 0 },
    send: vi.fn<SendImpl>(sendImpl),
    onEvent(listener: (event: AgentEvent) => void) {
      listeners.push(listener);
      return vi.fn(() => {
        listeners.splice(0, listeners.length);
      });
    },
    abort: vi.fn(async () => undefined),
    close: vi.fn(async () => undefined),
  } as unknown as Session;
  return {
    session,
    emit(event: AgentEvent) {
      for (const listener of [...listeners]) listener(event);
    },
  };
}

let raw: Database.Database;
let db: SchedulerDrizzleDb;

beforeEach(() => {
  vi.clearAllMocks();
  mocks.createMessage.mockResolvedValue(undefined);
  mocks.touchUserSendInDb.mockResolvedValue(undefined);
  mocks.backfillSessionMeta.mockResolvedValue(undefined);
  mocks.resolveWorkingDir.mockResolvedValue({ ok: true, path: '/repo/project' });
  raw = freshDb();
  db = drizzle(raw, { schema }) as unknown as SchedulerDrizzleDb;
  // 运行期再校验的主体是当前登录账号：本地库就是该账号的库。
  setCurrentDbClient({ drizzle: db } as unknown as DbClient, OWNER.id);
});

afterEach(() => {
  clearCurrentDbClient();
});

function createRunnerHarness(session: Session, opts: { sessionMeta?: Record<string, unknown> | null } = {}) {
  const logger = createLogger();
  const notifier: Notifier = { notify: vi.fn(async () => undefined) };
  const maker = {
    createSession: vi.fn(async () => session),
    getSessionMeta: vi.fn(async () => opts.sessionMeta ?? null),
    isSessionAlive: vi.fn(() => false),
    closeSession: vi.fn(async () => undefined),
  } as unknown as Maker;
  const runner = new MakerScheduleRunner({
    maker,
    getDb: () => db,
    notifier,
    logger,
  });
  return { runner, logger, notifier, maker };
}

describe('automation project binding verdict', () => {
  it('accepts an active project the actor belongs to and refuses the rest with a distinct reason', async () => {
    await expect(checkScheduleProjectBinding(db, 'p-active', OWNER)).resolves.toEqual({
      ok: true,
      projectId: 'p-active',
    });
    // 普通成员同样通过：绑定不是负责人特权。
    await expect(checkScheduleProjectBinding(db, 'p-active', { kind: 'account', id: 'teammate' }))
      .resolves.toEqual({ ok: true, projectId: 'p-active' });
    const outsider = await checkScheduleProjectBinding(db, 'p-active', {
      kind: 'account',
      id: 'not-a-member',
    });
    expect(outsider).toMatchObject({ ok: false, code: 'NOT_PROJECT_MEMBER' });
    // 已归档：先恢复项目，不是成员问题。
    await expect(checkScheduleProjectBinding(db, 'p-archived', OWNER))
      .resolves.toMatchObject({ ok: false, code: 'PROJECT_ARCHIVED' });
    // 项目没了，与"不是成员"必须是两种回答。
    await expect(checkScheduleProjectBinding(db, 'p-missing', OWNER))
      .resolves.toMatchObject({ ok: false, code: 'PROJECT_NOT_FOUND' });
    // 未登录 / 账号切换中不得当成有权限。
    await expect(checkScheduleProjectBinding(db, 'p-active', null))
      .resolves.toMatchObject({ ok: false, code: 'ACCOUNT_UNAVAILABLE' });
  });

  it('raises IPC-coded errors for the save path and returns the same text for the run path', async () => {
    await expect(assertScheduleProjectBinding(db, 'p-active', OWNER)).resolves.toBeUndefined();
    for (const [projectId, actor, code] of [
      ['p-active', { kind: 'account' as const, id: 'not-a-member' }, 'NOT_PROJECT_MEMBER'],
      // 四个起因必须各自成一个码：归档 / 项目没了 / 账号不可用 混成一个通用码时，
      // 界面只能猜，而猜错就是把换号的人骗去「恢复一个没归档的项目」。
      ['p-archived', OWNER, 'PROJECT_ARCHIVED'],
      ['p-missing', OWNER, 'PROJECT_NOT_FOUND'],
      ['p-active', null, 'ACCOUNT_UNAVAILABLE'],
    ] as const) {
      await expect(assertScheduleProjectBinding(db, projectId, actor)).rejects.toMatchObject({
        code,
      });
      // 运行期失败原因与保存期判定同源：同一主体、同一项目，两处是同一句话。
      if (actor) setCurrentDbClient({ drizzle: db } as unknown as DbClient, actor.id);
      else clearCurrentDbClient();
      const verdict = await checkScheduleProjectBinding(db, projectId, actor);
      expect(verdict.ok).toBe(false);
      expect(await describeScheduleProjectRejection(db, projectId)).toBe(
        verdict.ok ? null : verdict.message,
      );
    }
  });
});

describe('automation project binding at run time', () => {
  it('fails the run and creates no task when the project was archived after saving', async () => {
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, maker } = createRunnerHarness(h.session);

    await expect(
      runner.fire(baseSchedule({ projectId: 'p-archived' }), createFireContext()),
    ).rejects.toThrow(/archived/);

    expect(maker.createSession).not.toHaveBeenCalled();
    expect(mocks.createMessage).not.toHaveBeenCalled();
    // 失败必须留下可核对的原因（schedule_runs.error_msg / 通知同源）。
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'schedule-1' }),
      expect.objectContaining({
        status: 'failed',
        errorMsg: expect.stringContaining('archived'),
      }),
    );
  });

  it('fails the run and creates no task when the creator lost membership', async () => {
    raw.prepare("DELETE FROM project_members WHERE project_id='p-active'").run();
    const h = createSessionHarness(acceptingSend());
    const { runner, notifier, maker } = createRunnerHarness(h.session);

    await expect(
      runner.fire(baseSchedule({ projectId: 'p-active' }), createFireContext()),
    ).rejects.toThrow(/membership/);

    expect(maker.createSession).not.toHaveBeenCalled();
    expect(notifier.notify).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'schedule-1' }),
      expect.objectContaining({
        status: 'failed',
        errorMsg: expect.stringContaining('membership'),
      }),
    );
  });

  it('binds a freshly created task to the project and leaves a bound task untouched', async () => {
    const fresh = createSessionHarness(acceptingSend());
    const freshRun = createRunnerHarness(fresh.session);
    const firePromise = freshRun.runner.fire(
      baseSchedule({ projectId: 'p-active' }),
      createFireContext(),
    );
    await vi.waitFor(() => {
      expect(freshRun.maker.createSession).toHaveBeenCalledWith(
        expect.objectContaining({ projectId: 'p-active' }),
      );
    });
    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalled();
    });
    fresh.emit({ type: 'done', data: {} });
    await firePromise;

    // 绑定既有任务：运行不会新建会话，因此不能把项目归属下传（历史归属不变）。
    mocks.getSessionRowSnapshot.mockResolvedValue({
      status: 'active',
      permissionMode: 'ask',
      planModeEnabled: false,
    });
    const bound = createSessionHarness(acceptingSend());
    const boundRun = createRunnerHarness(bound.session, {
      sessionMeta: { sdkSessionId: 'sdk-1', workDir: '/repo/project' },
    });
    const boundFire = boundRun.runner.fire(
      baseSchedule({ projectId: 'p-active', targetSessionId: 'scheduler-session' }),
      createFireContext(),
    );
    await vi.waitFor(() => {
      expect(boundRun.maker.createSession).toHaveBeenCalled();
    });
    expect(boundRun.maker.createSession).toHaveBeenCalledWith(
      expect.not.objectContaining({ projectId: expect.anything() }),
    );
    await vi.waitFor(() => {
      expect(mocks.createMessage).toHaveBeenCalled();
    });
    bound.emit({ type: 'done', data: {} });
    await boundFire;
  });
});
