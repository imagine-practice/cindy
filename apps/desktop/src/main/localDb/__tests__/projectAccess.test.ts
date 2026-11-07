import { setCurrentDbClient, clearCurrentDbClient } from '../client/current';
/**
 * 项目级访问判定 M3-A：`ipc/projects.ts` / `ipc/materials.ts` 的成员与负责人边界。
 *
 * 测试价值
 * - 生产入口与可观察结果：`listProjects` / `readProjectDetail` / `listMaterials` /
 *   `previewMaterial` / `mutateProjects`。renderer 与伙伴侧工具看到的是空集合、
 *   `NOT_PROJECT_MEMBER` / `NOT_PROJECT_OWNER` / R1 材料 `FORBIDDEN`，而不是项目名、工作项、文件名、
 *   sha256 或受管地址。
 * - Bug／规则依据：`docs/plans/2026-11-05-project-core-m3-m4.md` §1 M3-A（验收 P1–P4）。
 * - 现有覆盖缺口：`projects.test.ts` / `materials.test.ts` 只测事务层不变式（负责人唯一、
 *   处理人必须是成员），从不经过 IPC 入口，也没有「调用方主体」这个维度；M3-A 的判定
 *   恰好只在这一层，事务层没有任何关于「谁在调用」的知识。
 * - 最小失败输入：非成员伙伴对 `previewMaterial` 请求一个真实存在、内容可读的版本；
 *   去掉入口判定就会读到源文件并返回正文（本文件第一条用例就是它）。
 * - R1 integration adaptation: explicit observed scope/reference ID, 0149 DDL, and final verified-buffer read hook.
 * - tier：db —— 真 SQLite（内存库）+ 真 migration 产物，DbClient 用进程内实现替代
 *   transport，不启动 Electron。
 * - 实测耗时：约 2.6s（Windows，单独运行 `npx vitest run src/main/localDb/__tests__/projectAccess.test.ts`）。
 */
import { readdirSync, readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import os from 'node:os';
import path from 'node:path';
import fs from 'node:fs/promises';

import { ScriptTarget, transpileModule } from 'typescript';
import * as projectBroadcast from '../../device-link/broadcast-tap';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type Database from 'better-sqlite3';

import { createBetterSqliteDatabase } from '../betterSqliteFactory';
import type { DbClient } from '../client/DbClient';
import { dispatch } from '../worker/dispatcher';
import { broadcastSessionPatched } from '../ipc/sessions';
import { readProjectProgress } from '../ipc/projectProgress';
import {
  assertProjectBindable,
  listProjects,
  mutateProjects,
  readProjectDetail,
} from '../ipc/projects';
import * as materialSource from '../../cindy-media/materialSource';
import * as materialIo from '../ipc/materialReferenceIo';
import { addMaterials, addMaterialVersion, removeMaterialReference, retryMaterialRead, createMaterialContext, listMaterialContexts, listMaterials, previewMaterial } from '../ipc/materials';
import { projectRoleOf, canEditMembers } from '../../../shared/projectAccess';
import { PROJECTS_LIST_CHANNEL, PROJECTS_DETAIL_CHANNEL, PROJECTS_MUTATE_CHANNEL, PROJECTS_CHANGED_CHANNEL, type ProjectSubjectRef, type ProjectDetail } from '../../../shared/projects';

/** 当前登录账号：不是任何项目的成员。用来证明「不传 actor ≠ 负责人」。 */
const CURRENT_ACCOUNT_ID = 'acc-current';
const boundary = vi.hoisted(() => ({ generation: 0, legacyUserId: 'acc-current' as string | null }));
vi.mock('../../device-link/broadcast-tap', async (importOriginal) => ({
  ...await importOriginal<typeof import('../../device-link/broadcast-tap')>(),
  captureDataOwnerBroadcastScope: () => ({ generation: boundary.generation, ownerScopeKey: `access-fixture:${boundary.generation}` }),
  isDataOwnerBroadcastScopeCurrent: (scope: { generation: number }) => scope.generation === boundary.generation,
}));

vi.mock('../index', () => ({
  getCurrentUserId: () => boundary.legacyUserId,
}));
// 写路径会广播任务补丁；单测只需要提交成功，不需要窗口投递。
vi.mock('../ipc/sessions', () => ({ broadcastSessionPatched: vi.fn() }));

const DRIZZLE_DIR = path.resolve(__dirname, '../../../../drizzle');

function migrationSql(prefix: string): string {
  const file = readdirSync(DRIZZLE_DIR)
    .filter((name) => name.startsWith(prefix) && name.endsWith('.sql'))
    .sort()
    .at(-1);
  if (!file) throw new Error(`${prefix} migration not found`);
  return readFileSync(path.join(DRIZZLE_DIR, file), 'utf8')
    .split('--> statement-breakpoint')
    .join(';');
}

const OWNER: ProjectSubjectRef = { kind: 'account', id: 'acc-1' };
const MEMBER_ACCOUNT: ProjectSubjectRef = { kind: 'account', id: 'acc-2' };
const MEMBER_BOT: ProjectSubjectRef = { kind: 'bot', id: 'bot-1' };
const ADDED_BOT: ProjectSubjectRef = { kind: 'bot', id: 'bot-2' };
const OUTSIDER_ACCOUNT: ProjectSubjectRef = { kind: 'account', id: 'acc-3' };
const OUTSIDER_BOT: ProjectSubjectRef = { kind: 'bot', id: 'bot-9' };

const MATERIAL_NAME = 'payment-spec.txt';
const MATERIAL_BODY = 'settlement window is T+1';
// R1 fixture observes the real first bind generation and names a current reference.
const MATERIAL_SCOPE = { projectId: 'proj-1', workItemId: 'task-1', bindingRevision: 1 } as const;
const MATERIAL_LOCATOR = { ...MATERIAL_SCOPE, referenceId: 'ref-1', materialId: 'mat-1', version: 1 };

/**
 * 测试用 DbClient：真 SQLite + 真事务实现，只把 transport 换成进程内调用。
 * `tx` 的重载签名无法用字面量对象逐条实现，所以在边界处做一次断言式转换。
 */
function createTestClient(db: Database.Database): DbClient {
  const client = {
    query: async (sql: string, params: unknown[] = []) => db.prepare(sql).all(...params),
    queryOne: async (sql: string, params: unknown[] = []) => db.prepare(sql).get(...params),
    exec: async (sql: string, params: unknown[] = []) => {
      const result = db.prepare(sql).run(...params);
      return { changes: result.changes, lastInsertRowid: result.lastInsertRowid };
    },
    tx: async (name: string, args: unknown) => dispatch('tx', { name, args }, db),
    // 被测入口不碰 drizzle（只有媒体形态的字节写入会用到），给一个占位即可。
    drizzle: undefined as never,
    vecAvailable: false,
    dispose: async () => undefined,
  };
  return client as unknown as DbClient;
}

async function expectIpcCode(promise: Promise<unknown>, code: string): Promise<void> {
  await expect(promise).rejects.toThrow(`[${code}]`);
}

describe('project access (M3-A)', () => {
  let db: Database.Database;
  let client: DbClient;
  let materialDir: string;
  let materialPath: string;
  let materialSha: string;

  beforeEach(async () => {
    boundary.legacyUserId = CURRENT_ACCOUNT_ID;
    db = createBetterSqliteDatabase(':memory:');
    db.pragma('foreign_keys=ON');
    db.exec(
      `CREATE TABLE sessions (
         id TEXT PRIMARY KEY,
         title TEXT,
         status TEXT NOT NULL DEFAULT 'active',
         updated_at INTEGER NOT NULL DEFAULT 1
       );
       INSERT INTO sessions (id, title) VALUES
         ('task-1', '工时表导出'),
         ('task-2', '对账口径'),
         ('task-3', '未绑定任务');
       CREATE TABLE bot_profiles (
         id TEXT PRIMARY KEY,
         display_name TEXT NOT NULL DEFAULT '',
         avatar TEXT NOT NULL DEFAULT '',
         avatar_color TEXT NOT NULL DEFAULT ''
       );
       INSERT INTO bot_profiles (id, display_name) VALUES ('bot-1', '测试伙伴'), ('bot-2', '新伙伴');`,
    );
    db.exec(migrationSql('0146_'));
    db.exec(migrationSql('0147_'));
    db.exec(migrationSql('0148_'));
    db.exec(migrationSql('0149_'));
    db.exec(migrationSql('0150_'));
    // 删项目的级联要把定时任务的 project_id 置空；schedules 由项目之外的 migration
    // 建立，这里按它在本级联里用到的列最小建表（与 sessions 同一处理方式）。
    db.exec('CREATE TABLE schedules (id TEXT PRIMARY KEY, project_id TEXT)');

    client = createTestClient(db);
    setCurrentDbClient(client, CURRENT_ACCOUNT_ID);

    // 材料原文放在临时目录：`file` 形态预览会重算源文件 sha256。
    materialDir = await fs.mkdtemp(path.join(os.tmpdir(), 'm3-access-'));
    materialPath = path.join(materialDir, 'payment-spec.txt');
    await fs.writeFile(materialPath, MATERIAL_BODY, 'utf8');
    materialSha = createHash('sha256').update(MATERIAL_BODY).digest('hex');

    await client.tx('projects.execute', {
      actor: OWNER,
      action: 'create',
      newId: 'proj-1',
      now: 1_000,
      input: {
        name: '遥测网关',
        goal: 'M3 访问判定',
        owner: OWNER,
        members: [MEMBER_ACCOUNT, MEMBER_BOT],
      },
    });
    await client.tx('projects.execute', {
      actor: OWNER,
      action: 'bindSession',
      sessionId: 'task-1',
      projectId: 'proj-1',
      now: 1_100,
    });
    await client.tx('materials.execute', {
      action: 'add',
      projectId: 'proj-1',
      workItemId: 'task-1',
      bindingRevision: 1,
      actor: { kind: 'account', id: OWNER.id },
      now: 1_200,
      files: [
        {
          referenceId: 'ref-1',
          versionId: 'ver-1',
          materialId: 'mat-1',
          name: MATERIAL_NAME,
          sha256: materialSha,
          sizeBytes: Buffer.byteLength(MATERIAL_BODY),
          mime: 'text/plain',
          storageKind: 'file',
          storageRef: materialPath,
          sourceMtime: 1_500,
        },
      ],
    });
  });

  afterEach(async () => {
    clearCurrentDbClient();
    vi.restoreAllMocks();
    db.close();
    await fs.rm(materialDir, { recursive: true, force: true });
  });

  // Host regression: worker client is ready in local Profile while legacy inproc DB is not opened.
  // Real services/transactions on generated 0146..0149 SQLite; no UI or real Host claim.
  it('uses the captured local Profile actor for create, list, detail, progress and material reads with no legacy DB user', async () => {
    boundary.legacyUserId = null;
    setCurrentDbClient(client, 'local-v1');
    const result = await mutateProjects({ action: 'create', actor: OUTSIDER_BOT, input: { name: 'Local project', members: [] } });
    expect(result.projectId).toEqual(expect.any(String));
    if (!result.projectId) throw Error('Project creation returned no id');
    const projectId = result.projectId;
    expect(db.prepare('SELECT subject_kind,subject_id,role FROM project_members WHERE project_id=?').all(projectId))
      .toEqual([{ subject_kind: 'account', subject_id: 'local-v1', role: 'owner' }]);
    expect((await listProjects()).map(item => item.id)).toEqual([projectId]);
    expect((await readProjectDetail(projectId)).project.ownerId).toBe('local-v1');
    const progress = await readProjectProgress({ projectId });
    expect(progress).toMatchObject({ projectId, items: [], capabilities: { canRecord: true, canConfirmDone: true } });
    expect((await listMaterials({ projectId, workItemId: null, bindingRevision: null })).materials).toEqual([]);
    await expectIpcCode(readProjectDetail(projectId, { kind: 'bot', id: 'local-v1' }), 'NOT_PROJECT_MEMBER');
    await expectIpcCode(mutateProjects({ action: 'addMember', projectId, subject: ADDED_BOT }, { kind: 'bot', id: 'local-v1' }), 'NOT_PROJECT_OWNER');
  });

  // DB: execute the production registration function in a controlled ipcMain, then
  // real metadata update/default Profile actor/transaction/read/broadcast. Not native Electron IPC.
  const registeredMetadata = () => {
    const handlers = new Map<string, (event: { trusted?: boolean }, argument?: unknown) => Promise<unknown>>();
    const source = readFileSync(path.resolve(__dirname, '../ipc/projects.ts'), 'utf8');
    const registration = source.slice(source.indexOf('export function registerProjectsIpc')).replace('export function', 'function');
    const compiled = transpileModule(registration + '\nregisterProjectsIpc();', { compilerOptions: { target: ScriptTarget.ES2022 } }).outputText;
    new Function('ipcMain', 'assertTrustedAppRendererEvent', 'listProjects', 'readProjectDetail', 'mutateProjects', 'requireString',
      'PROJECTS_LIST_CHANNEL', 'PROJECTS_DETAIL_CHANNEL', 'PROJECTS_MUTATE_CHANNEL', compiled)(
      { handle: (channel: string, handler: (event: { trusted?: boolean }, arg?: unknown) => Promise<unknown>) => handlers.set(channel, handler) },
      (event: { trusted?: boolean }) => { if (!event.trusted) throw new Error('UNTRUSTED_RENDERER'); },
      listProjects, readProjectDetail, mutateProjects, (value: unknown) => { if (typeof value !== 'string') throw new Error('INVALID_PARAMS'); return value; },
      PROJECTS_LIST_CHANNEL, PROJECTS_DETAIL_CHANNEL, PROJECTS_MUTATE_CHANNEL);
    return handlers;
  };
  it('registered metadata update persists only name/goal and publishes successful changes', async () => {
    const handlers = registeredMetadata(); setCurrentDbClient(client, OWNER.id);
    const notify = vi.spyOn(projectBroadcast, 'tapWindowBroadcast').mockImplementation(() => undefined);
    await handlers.get(PROJECTS_MUTATE_CHANNEL)!({ trusted: true }, { action: 'update', projectId: 'proj-1', name: 'Edited name' });
    let next = await handlers.get(PROJECTS_DETAIL_CHANNEL)!({ trusted: true }, 'proj-1') as ProjectDetail;
    expect(next.project).toMatchObject({ name: 'Edited name', goal: 'M3 访问判定', status: 'active', ownerId: OWNER.id });
    await handlers.get(PROJECTS_MUTATE_CHANNEL)!({ trusted: true }, { action: 'update', projectId: 'proj-1', goal: null });
    next = await handlers.get(PROJECTS_DETAIL_CHANNEL)!({ trusted: true }, 'proj-1') as ProjectDetail;
    expect(next.project).toMatchObject({ name: 'Edited name', goal: null, status: 'active', ownerId: OWNER.id });
    expect(notify).toHaveBeenCalledTimes(2);
    expect(notify.mock.calls.every(([channel]) => channel === PROJECTS_CHANGED_CHANNEL)).toBe(true);
  });
  it('registered metadata update rejects forged sender/actor and same-ID bot identity with zero write or success notice', async () => {
    const handlers = registeredMetadata();
    const notify = vi.spyOn(projectBroadcast, 'tapWindowBroadcast').mockImplementation(() => undefined);
    setCurrentDbClient(client, OWNER.id);
    await expect(handlers.get(PROJECTS_MUTATE_CHANNEL)!({}, { action: 'update', projectId: 'proj-1', name: 'Untrusted' })).rejects.toThrow('UNTRUSTED_RENDERER');
    for (const user of [MEMBER_ACCOUNT.id, MEMBER_BOT.id]) {
      setCurrentDbClient(client, user);
      await expectIpcCode(handlers.get(PROJECTS_MUTATE_CHANNEL)!({ trusted: true }, {
        action: 'update', projectId: 'proj-1', name: 'Forbidden', goal: null, actor: OWNER, role: 'owner',
      }), 'NOT_PROJECT_OWNER');
    }
    expect((await readProjectDetail('proj-1', OWNER, client)).project).toMatchObject({ name: '遥测网关', goal: 'M3 访问判定' });
    expect(notify).not.toHaveBeenCalled();
  });

  it('does not borrow a stale legacy DB user or another client when resolving default identity', async () => {
    boundary.legacyUserId = OWNER.id;
    // Current Profile is a nonmember even when the legacy inproc DB names the owner.
    expect(await listProjects()).toEqual([]);
    await expectIpcCode(mutateProjects({ action: 'addMember', projectId: 'proj-1', subject: ADDED_BOT, actor: OWNER }), 'NOT_PROJECT_OWNER');
    setCurrentDbClient(client, OWNER.id);
    expect((await listProjects()).map(item => item.id)).toEqual(['proj-1']);
    const otherClient = { ...client };
    expect(await listProjects(undefined, otherClient)).toEqual([]);
    await expectIpcCode(mutateProjects({ action: 'create', input: { name: 'Wrong client', owner: OWNER } }, undefined, otherClient), 'PRECONDITION_FAILED');
    clearCurrentDbClient();
    expect(await listProjects(undefined, client)).toEqual([]);
    await expectIpcCode(mutateProjects({ action: 'create', input: { name: 'No Profile', owner: OWNER } }, undefined, client), 'PRECONDITION_FAILED');
  });

  // Negative service tests: real DB and file; inject owner switch/revocation at I/O completion.
  it('rejects a file preview when the owner changes during verify or text read', async () => {
    const verify = materialSource.verifyMaterialSource;
    const read = materialIo.readVerifiedMaterialText;
    const verifySpy = vi.spyOn(materialSource, 'verifyMaterialSource').mockImplementation(async (input) => {
      const result = await verify(input);
      boundary.generation++;
      return result;
    });
    await expectIpcCode(
      previewMaterial(MATERIAL_LOCATOR, MEMBER_BOT, client),
      'PRECONDITION_FAILED',
    );
    verifySpy.mockRestore();
    vi.spyOn(materialIo, 'readVerifiedMaterialText').mockImplementation(async (input) => {
      const result = await read(input);
      boundary.generation++;
      return result;
    });
    await expectIpcCode(
      previewMaterial(MATERIAL_LOCATOR, MEMBER_BOT, client),
      'PRECONDITION_FAILED',
    );
  });

  it('rejects in-flight preview after membership revocation and ignores payload actor', async () => {
    const read = materialIo.readVerifiedMaterialText;
    vi.spyOn(materialIo, 'readVerifiedMaterialText').mockImplementation(async (input) => {
      const result = await read(input);
      db.prepare('DELETE FROM project_members WHERE project_id = ? AND subject_id = ?').run('proj-1', MEMBER_BOT.id);
      return result;
    });
    await expectIpcCode(
      previewMaterial(MATERIAL_LOCATOR, MEMBER_BOT, client),
      'FORBIDDEN',
    );
    await expectIpcCode(
      listMaterialContexts(MATERIAL_SCOPE, MEMBER_BOT, client),
      'FORBIDDEN',
    );
    await expectIpcCode(listMaterials({ ...MATERIAL_SCOPE, actor: OWNER }, undefined, client), 'FORBIDDEN');
    await expectIpcCode(
      previewMaterial({ ...MATERIAL_LOCATOR, actor: OWNER }, undefined, client),
      'FORBIDDEN',
    );
    await expectIpcCode(
      mutateProjects({ action: 'addMember', projectId: 'proj-1', subject: ADDED_BOT, actor: OWNER }, undefined, client),
      'NOT_PROJECT_OWNER',
    );
  });

  it('denies material writes and snapshot access to an outsider at service entry', async () => {
    const file = { path: materialPath, name: MATERIAL_NAME };
    for (const request of [
      () => addMaterials({ ...MATERIAL_SCOPE, files: [file] }, OUTSIDER_BOT, client),
      () => addMaterialVersion({ ...MATERIAL_SCOPE, referenceId: 'ref-1', materialId: 'mat-1', file }, OUTSIDER_BOT, client),
      () => removeMaterialReference({ ...MATERIAL_SCOPE, referenceId: 'ref-1' }, OUTSIDER_BOT, client),
      () => retryMaterialRead(MATERIAL_LOCATOR, OUTSIDER_BOT, client),
      () => createMaterialContext({ ...MATERIAL_SCOPE, purpose: 'reference', refs: [] }, OUTSIDER_BOT, client),
      () => listMaterialContexts(MATERIAL_SCOPE, OUTSIDER_BOT, client),
    ]) {
      await expectIpcCode(request(), 'FORBIDDEN');
    }
    expect(db.prepare('SELECT status FROM materials WHERE id = ?').get('mat-1')).toEqual({ status: 'active' });
    expect(db.prepare('SELECT COUNT(*) AS n FROM material_versions').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM material_contexts').get()).toEqual({ n: 0 });
  });

  it('rejects missing, unbound, deleted and cross-project attachment targets and snapshot refs', async () => {
    const add = (workItemId: string, bindingRevision: number) => addMaterials({ projectId: 'proj-1', workItemId, bindingRevision, files: [{ name: 'new.txt', path: materialPath }] }, OWNER, client);
    await expectIpcCode(add('missing', 0), 'PRECONDITION_FAILED');
    await expectIpcCode(add('task-2', 0), 'REFERENCE_MISMATCH');
    db.prepare("UPDATE sessions SET status = 'deleted' WHERE id = 'task-2'").run();
    await expectIpcCode(add('task-2', 0), 'PRECONDITION_FAILED');
    await client.tx('projects.execute', { actor: OWNER, action: 'create', newId: 'proj-2', now: 2000, input: { name: 'Other', owner: OWNER, members: [] } });
    await client.tx('projects.execute', { actor: OWNER, action: 'bindSession', sessionId: 'task-3', projectId: 'proj-2', now: 2001 });
    await expectIpcCode(add('task-3', 1), 'REFERENCE_MISMATCH');
    await expectIpcCode(createMaterialContext({ ...MATERIAL_SCOPE, workItemId: 'task-3', purpose: 'reference', refs: [{ referenceId: 'ref-1', materialId: 'mat-1', version: 1 }] }, OWNER, client), 'REFERENCE_MISMATCH');
    expect(db.prepare('SELECT COUNT(*) AS n FROM materials').get()).toEqual({ n: 1 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM material_contexts').get()).toEqual({ n: 0 });
  });

  it('validates create-new, keeps default conflict and dedup, and forwards the explicit choice', async () => {
    const file = { name: MATERIAL_NAME, path: materialPath };
    const add = (files: unknown[]) => addMaterials({ ...MATERIAL_SCOPE, files }, OWNER, client);
    await expectIpcCode(add([{ ...file, sameNameAction: 'overwrite' }]), 'INVALID_PARAMS');
    expect((await add([{ ...file, sameNameAction: 'create-new' }])).duplicates).toHaveLength(1);
    await fs.writeFile(materialPath, 'different content');
    expect((await add([file])).rejected).toEqual([{ name: MATERIAL_NAME, code: 'DUPLICATE_CONTENT' }]);
    // A owns the transaction; verify the service transport contract without claiming end-to-end success.
    const execute = client.tx.bind(client);
    const tx = vi.spyOn(client, 'tx').mockImplementation(async (name, args) => {
      if (args && typeof args === 'object' && 'action' in args && args.action === 'add') throw new Error('transaction-boundary');
      return execute(name, args);
    });
    await expect(add([{ ...file, sameNameAction: 'create-new' }])).rejects.toThrow('transaction-boundary');
    expect(tx).toHaveBeenCalledWith('materials.execute', expect.objectContaining({
      files: [expect.objectContaining({ name: MATERIAL_NAME, sameNameAction: 'create-new', storageKind: 'file' })],
    }));
  });

  it('records the trusted main bot actor while renderer intent cannot grant membership', async () => {
    await fs.writeFile(materialPath, 'new material bytes');
    const payload = {
      ...MATERIAL_SCOPE, actor: OWNER,
      files: [{ name: 'new-material.txt', path: materialPath, sameNameAction: 'create-new' }],
    };
    const result = await addMaterials(payload, MEMBER_BOT, client);
    expect(result.added).toHaveLength(1);
    expect(db.prepare('SELECT created_by_kind AS kind, created_by_id AS id FROM materials WHERE id = ?').get(result.added[0].materialId)).toEqual(MEMBER_BOT);
    // Caller intent is allowed, but is never the caller identity, even with an owner-looking raw.actor.
    await expectIpcCode(addMaterials(payload, OUTSIDER_BOT, client), 'FORBIDDEN');
    await expectIpcCode(addMaterials(payload, undefined, client), 'FORBIDDEN');
    await expectIpcCode(addMaterials(payload, null, client), 'PRECONDITION_FAILED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM materials').get()).toEqual({ n: 2 });
  });

  it('does not promote a same-id bot member when the owner row is absent', () => {
    const subject = { kind: 'bot' as const, id: 'same-id' };
    const project = { ownerId: 'same-id', members: [{ ...subject, role: 'member' as const }] };
    expect(projectRoleOf(project, subject)).toBe('member');
    expect(canEditMembers(subject, project)).toBe(false);
  });

  it('bridges all project actions with trusted main actor, ignoring raw actor and role', async () => {
    const tx = vi.spyOn(client, 'tx').mockRejectedValue(new Error('project-bridge'));
    const actions = [
      { action: 'create', input: { name: 'New', owner: MEMBER_BOT } },
      { action: 'update', projectId: 'proj-1', name: 'Updated' },
      { action: 'addMember', projectId: 'proj-1', subject: ADDED_BOT },
      { action: 'removeMember', projectId: 'proj-1', subject: MEMBER_BOT },
      { action: 'transferOwner', projectId: 'proj-1', subject: MEMBER_BOT },
      { action: 'bindSession', sessionId: 'task-2', projectId: 'proj-1' },
      { action: 'setAssignee', sessionId: 'task-1', assignee: MEMBER_BOT },
      { action: 'delete', projectId: 'proj-1' },
    ];
    for (const action of actions) {
      tx.mockClear();
      await expect(mutateProjects({ ...action, actor: OUTSIDER_BOT, role: 'owner' }, OWNER, client)).rejects.toThrow('project-bridge');
      expect(tx).toHaveBeenCalledOnce();
      const [name, envelope] = tx.mock.calls[0];
      expect(name).toBe('projects.execute');
      expect(envelope).toMatchObject({ action: action.action, actor: OWNER });
      expect(envelope).not.toHaveProperty('role');
      tx.mockClear();
      await expectIpcCode(mutateProjects({ ...action, actor: OWNER }, null, client), 'PRECONDITION_FAILED');
      expect(tx).not.toHaveBeenCalled();
    }
    await expect(mutateProjects({ action: 'bindSession', sessionId: 'task-2', projectId: 'proj-1', actor: OWNER }, MEMBER_BOT, client)).rejects.toThrow('project-bridge');
    expect(tx).toHaveBeenLastCalledWith('projects.execute', expect.objectContaining({ actor: MEMBER_BOT }));
    await expect(mutateProjects({ action: 'create', input: { name: 'New' }, actor: OWNER }, undefined, client)).rejects.toThrow('project-bridge');
    expect(tx).toHaveBeenLastCalledWith('projects.execute', expect.objectContaining({ actor: { kind: 'account', id: CURRENT_ACCOUNT_ID } }));
  });

  it('denies every read path to non-members without leaking any content (P1)', async () => {
    expect(await listProjects(OUTSIDER_BOT, client)).toEqual([]);
    await expectIpcCode(readProjectDetail('proj-1', OUTSIDER_BOT, client), 'NOT_PROJECT_MEMBER');

    const denied = listMaterials(MATERIAL_SCOPE, OUTSIDER_BOT, client);
    await expectIpcCode(denied, 'FORBIDDEN');
    const materials = await denied.catch(error => String(error));
    // R1 拒绝响应不得泄露文件名、sha256、正文或原文件路径。
    expect(JSON.stringify(materials)).not.toContain(MATERIAL_NAME);
    expect(JSON.stringify(materials)).not.toContain(materialSha);
    expect(JSON.stringify(materials)).not.toContain(MATERIAL_BODY);
    expect(JSON.stringify(materials)).not.toContain(materialPath);
    expect(JSON.stringify(materials)).not.toContain('storageRef');

    // 版本内容真实可读：这里能拒，说明判定发生在读字节之前，不是靠「读不到」碰巧挡住。
    await expectIpcCode(
      previewMaterial(MATERIAL_LOCATOR, OUTSIDER_BOT, client),
      'FORBIDDEN',
    );
  });

  it('lets members read the project, its work items, materials and text preview', async () => {
    for (const member of [MEMBER_ACCOUNT, MEMBER_BOT]) {
      const detail = await readProjectDetail('proj-1', member, client);
      expect(detail.project.name).toBe('遥测网关');
      expect(detail.workItems.map((item) => item.title)).toEqual(['工时表导出']);

      const { materials } = await listMaterials(MATERIAL_SCOPE, member, client);
      expect(materials).toHaveLength(1);
      expect(materials[0]).toMatchObject({
        id: 'mat-1',
        name: MATERIAL_NAME,
        currentVersion: 1,
      });
      expect(materials[0].versions[0].sha256).toBe(materialSha);
      // `storageRef` 不出 main：投影里没有原文件路径这一列。
      expect(materials[0].versions[0]).not.toHaveProperty('storageRef');
    }

    const preview = await previewMaterial(MATERIAL_LOCATOR, MEMBER_ACCOUNT, client);
    expect(preview).toEqual({
      referenceContract: 1,
      materialId: 'mat-1',
      version: 1,
      kind: 'text',
      text: MATERIAL_BODY,
      name: MATERIAL_NAME,
      mime: 'text/plain',
      size: Buffer.byteLength(MATERIAL_BODY),
    });
  });

  it('judges subjects by (kind, id) and never treats a missing actor as the owner (P1)', async () => {
    // 伙伴 id 与负责人账号 id 撞字符串：它是另一个主体，不是成员。
    expect(await listProjects({ kind: 'bot', id: OWNER.id }, client)).toEqual([]);
    // 反向同理：账号 id 与成员伙伴 id 相同，也不算成员。
    expect(await listProjects({ kind: 'account', id: MEMBER_BOT.id }, client)).toEqual([]);

    expect((await listProjects(OWNER, client)).map((project) => project.id)).toEqual(['proj-1']);
    expect((await listProjects(MEMBER_BOT, client)).map((project) => project.id)).toEqual(['proj-1']);
    expect(await listProjects(OUTSIDER_ACCOUNT, client)).toEqual([]);

    // 不传 actor = 当前登录账号（不是成员），不得因为「默认是本人」就当成负责人。
    expect(await listProjects(undefined, client)).toEqual([]);
    await expectIpcCode(readProjectDetail('proj-1', undefined, client), 'NOT_PROJECT_MEMBER');
  });

  it('lets members bind and assign work items while outsiders stay out (P2)', async () => {
    await mutateProjects(
      { action: 'bindSession', sessionId: 'task-2', projectId: 'proj-1' },
      MEMBER_ACCOUNT,
      client,
    );
    await mutateProjects(
      { action: 'setAssignee', sessionId: 'task-2', assignee: MEMBER_BOT },
      MEMBER_ACCOUNT,
      client,
    );
    expect(
      db
        .prepare('SELECT project_id AS projectId, assignee_id AS assigneeId FROM sessions WHERE id = ?')
        .get('task-2'),
    ).toEqual({ projectId: 'proj-1', assigneeId: 'bot-1' });

    await expectIpcCode(
      mutateProjects(
        { action: 'bindSession', sessionId: 'task-3', projectId: 'proj-1' },
        OUTSIDER_BOT,
        client,
      ),
      'NOT_PROJECT_MEMBER',
    );
    await expectIpcCode(
      mutateProjects(
        { action: 'setAssignee', sessionId: 'task-1', assignee: OUTSIDER_BOT },
        OUTSIDER_BOT,
        client,
      ),
      'NOT_PROJECT_MEMBER',
    );
    // 建任务（新建任务时绑项目）也走同一道门。
    await expectIpcCode(assertProjectBindable('proj-1', OUTSIDER_BOT, client), 'NOT_PROJECT_MEMBER');
    await expect(assertProjectBindable('proj-1', MEMBER_ACCOUNT, client)).resolves.toBeUndefined();
    // 解绑同样要判：否则非成员能把别人的任务从项目里摘出去。
    await expectIpcCode(
      mutateProjects({ action: 'bindSession', sessionId: 'task-1', projectId: null }, OUTSIDER_BOT, client),
      'NOT_PROJECT_MEMBER',
    );
    expect(
      db.prepare('SELECT project_id AS projectId FROM sessions WHERE id = ?').get('task-1'),
    ).toEqual({ projectId: 'proj-1' });
  });

  it('refuses member edits and ownership transfer from a plain member (P3)', async () => {
    await expectIpcCode(
      mutateProjects(
        { action: 'addMember', projectId: 'proj-1', subject: ADDED_BOT },
        MEMBER_ACCOUNT,
        client,
      ),
      'NOT_PROJECT_OWNER',
    );
    await expectIpcCode(
      mutateProjects(
        { action: 'removeMember', projectId: 'proj-1', subject: MEMBER_BOT },
        MEMBER_ACCOUNT,
        client,
      ),
      'NOT_PROJECT_OWNER',
    );
    await expectIpcCode(
      mutateProjects(
        { action: 'transferOwner', projectId: 'proj-1', subject: MEMBER_BOT },
        MEMBER_ACCOUNT,
        client,
      ),
      'NOT_PROJECT_OWNER',
    );

    expect(
      db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE subject_id = 'bot-2'").get(),
    ).toEqual({ n: 0 });
    expect(db.prepare('SELECT owner_id AS ownerId FROM projects WHERE id = ?').get('proj-1')).toEqual({
      ownerId: 'acc-1',
    });
  });

  // 用户裁决：项目可以删（真删除，需二次确认），而「能删」只能属于负责人。
  // 生产入口：`mutateProjects` → `projects.execute` → 真 SQLite，无 mock 权限旁路。
  it('deletes only as owner and publishes every unbound task with the project change', async () => {
    const notify = vi.spyOn(projectBroadcast, 'tapWindowBroadcast').mockImplementation(() => undefined);
    const patch = vi.mocked(broadcastSessionPatched);
    patch.mockClear();
    await expectIpcCode(mutateProjects({ action: 'delete', projectId: 'proj-1' }, MEMBER_ACCOUNT, client), 'NOT_PROJECT_OWNER');
    // 非成员也是同一个码：驱动码按「所需角色」给出，不泄露「你是不是成员」。
    await expectIpcCode(mutateProjects({ action: 'delete', projectId: 'proj-1' }, OUTSIDER_ACCOUNT, client), 'NOT_PROJECT_OWNER');
    await expectIpcCode(mutateProjects({ action: 'delete', projectId: 'missing' }, OWNER, client), 'NOT_FOUND');
    expect(db.prepare("SELECT COUNT(*) AS n FROM projects WHERE id = 'proj-1'").get()).toEqual({ n: 1 });
    expect(patch).not.toHaveBeenCalled();

    expect(await mutateProjects({ action: 'delete', projectId: 'proj-1' }, OWNER, client))
      .toEqual({ ok: true, projectId: 'proj-1', sessionId: null, unboundSessionIds: ['task-1'] });
    // 任务保留但回到「无项目」；其他账号的列表不再拿得到这个项目。
    expect(db.prepare("SELECT project_id FROM sessions WHERE id = 'task-1'").get())
      .toEqual({ project_id: null });
    expect(await listProjects(OWNER, client)).toEqual([]);
    expect(patch.mock.calls).toEqual([[
      'task-1', { projectId: null, assigneeKind: null, assigneeId: null }, expect.anything(),
    ]]);
    expect(notify.mock.calls.filter(([channel]) => channel === PROJECTS_CHANGED_CHANNEL)).toHaveLength(1);
  });

  it('keeps owner-only power with the owner and moves it immediately on transfer (P3)', async () => {
    await mutateProjects(
      { action: 'addMember', projectId: 'proj-1', subject: ADDED_BOT },
      OWNER,
      client,
    );
    // 新成员立刻可见，不需要重新拉项目列表。
    expect((await listProjects(ADDED_BOT, client)).map((project) => project.id)).toEqual(['proj-1']);

    await mutateProjects(
      { action: 'transferOwner', projectId: 'proj-1', subject: MEMBER_BOT },
      OWNER,
      client,
    );
    expect(db.prepare('SELECT owner_id AS ownerId FROM projects WHERE id = ?').get('proj-1')).toEqual({
      ownerId: 'bot-1',
    });

    // 旧负责人降级为普通成员：不再能改成员，但仍然看得见项目。
    await expectIpcCode(
      mutateProjects(
        { action: 'addMember', projectId: 'proj-1', subject: OUTSIDER_BOT },
        OWNER,
        client,
      ),
      'NOT_PROJECT_OWNER',
    );
    expect((await listProjects(OWNER, client)).map((project) => project.id)).toEqual(['proj-1']);

    // 新负责人接管后才允许移除成员。
    await mutateProjects(
      { action: 'removeMember', projectId: 'proj-1', subject: MEMBER_ACCOUNT },
      MEMBER_BOT,
      client,
    );
    expect(await listProjects(MEMBER_ACCOUNT, client)).toEqual([]);
  });

  it('revokes access the moment a member is removed, while members still see the data (P4)', async () => {
    expect((await listMaterials(MATERIAL_SCOPE, MEMBER_BOT, client)).materials).toHaveLength(1);

    await mutateProjects(
      { action: 'removeMember', projectId: 'proj-1', subject: MEMBER_BOT },
      OWNER,
      client,
    );

    // 撤出立即生效：同一个 client、同一份数据，下一次调用就被拒。
    expect(await listProjects(MEMBER_BOT, client)).toEqual([]);
    await expectIpcCode(readProjectDetail('proj-1', MEMBER_BOT, client), 'NOT_PROJECT_MEMBER');
    await expectIpcCode(
      previewMaterial(MATERIAL_LOCATOR, MEMBER_BOT, client),
      'FORBIDDEN',
    );
    // 被撤出的人也不能继续写。
    await expectIpcCode(
      mutateProjects(
        { action: 'setAssignee', sessionId: 'task-1', assignee: MEMBER_BOT },
        MEMBER_BOT,
        client,
      ),
      'NOT_PROJECT_MEMBER',
    );

    // 数据本身不动：成员仍能看到工作项与材料（撤出 ≠ 删除）。
    const detail = await readProjectDetail('proj-1', OWNER, client);
    expect(detail.workItems.map((item) => item.title)).toEqual(['工时表导出']);
    expect((await listMaterials(MATERIAL_SCOPE, OWNER, client)).materials).toHaveLength(1);
  });

  // 生产入口：真实的 listProjects / readProjectDetail，真 SQLite；只把「异步查询完成后
  // 多一个微任务」这一段纳入控制，用来在查询与组装之间插入一次已提交的撤权。
  it('discards in-flight list and detail content when the member row disappears or the owner epoch moves', async () => {
    const query = client.query.bind(client);
    let onQuery: ((sql: string) => void) | null = null;
    vi.spyOn(client, 'query').mockImplementation(async (sql: string, params: unknown[] = []) => {
      const rows = await query(sql, params);
      // 一次微任务 = 真实 transport 的往返：撤权在这段时间里提交。
      if (onQuery) { await Promise.resolve(); onQuery(sql); }
      return rows;
    });
    const onceMatching = (needle: string, effect: () => void) => (sql: string) => {
      if (!sql.includes(needle)) return;
      onQuery = null;
      effect();
    };
    const removeMember = () =>
      db
        .prepare("DELETE FROM project_members WHERE project_id = 'proj-1' AND subject_kind = 'bot' AND subject_id = ?")
        .run(MEMBER_BOT.id);
    const restoreMember = () =>
      mutateProjects({ action: 'addMember', projectId: 'proj-1', subject: MEMBER_BOT }, OWNER, client);

    // 1) 列表：成员行已复制到内存、任务数已聚合之后才提交撤权。
    onQuery = onceMatching('FROM project_members', removeMember);
    expect(await listProjects(MEMBER_BOT, client)).toEqual([]);
    expect(db.prepare("SELECT COUNT(*) AS n FROM project_members WHERE subject_id = ?").get(MEMBER_BOT.id)).toEqual({ n: 0 });

    // 2) 详情：工作项标题已读出、响应尚未组装时提交撤权——标题不得离开 main。
    await restoreMember();
    onQuery = onceMatching('SELECT id AS sessionId', removeMember);
    const detail = readProjectDetail('proj-1', MEMBER_BOT, client);
    await expectIpcCode(detail, 'NOT_PROJECT_MEMBER');
    const rejected = await detail.catch((error) => String(error));
    expect(rejected).not.toContain('工时表导出');
    expect(rejected).not.toContain('遥测网关');

    // 3) owner epoch 在最后一次查询之后跳走：同一批内容整体作废（账号切换，不是撤权）。
    //    列表侧钩在终段成员复核之后，详情侧钩在最后一次内容读取之后——两个窗口各测一次。
    await restoreMember();
    onQuery = onceMatching('FROM project_members WHERE subject_kind', () => { boundary.generation++; });
    await expectIpcCode(listProjects(MEMBER_BOT, client), 'NOT_FOUND');
    onQuery = onceMatching('SELECT id AS sessionId', () => { boundary.generation++; });
    await expectIpcCode(readProjectDetail('proj-1', MEMBER_BOT, client), 'NOT_FOUND');

    // 4) 收口不是一律拒绝：正常成员照旧能读。
    expect((await listProjects(MEMBER_BOT, client)).map((project) => project.id)).toEqual(['proj-1']);
    expect((await readProjectDetail('proj-1', MEMBER_BOT, client)).workItems.map((item) => item.title)).toEqual(['工时表导出']);
  });
});
