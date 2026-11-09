/**
 * 测试价值
 * - 生产入口与可观察结果：`findNameConflicts`、`currentVersionNumber` / `materialReadState`、
 *   `contextRefViews` 被材料面板与快照区直接消费。它们决定用户会看到「已沿用」还是被要求
 *   选择保存方式（R3/R4）、界面报告的是哪一版及哪一版的读取状态（R2/R7）、旧快照是否
 *   仍标 v1 并说明当前可读性（A5/A8）。
 * - Bug／规则依据：契约 `docs/plans/2026-11-05-materials-contract-draft.md` R2/R3/R4/R7 与
 *   验收 A4/A5/A8。历史风险是把「最新版本」当成「已绑定版本」，或同名不同内容静默落库。
 * - 现有覆盖缺口：本片是新增写域，main 侧行为由 M2-A 单测覆盖；renderer 侧没有相邻测试。
 * - 最小失败输入：材料在 v1 被移除引用后又出现 v2 时把 v2 当成快照版本；同名但 sha256
 *   不同的文件被直接交给 add。
 * - tier：unit（纯函数，无 DOM / IPC / 计时）；实测耗时见 PR 说明。
 */
import { describe, expect, it } from 'vitest';

import {
  contextRefViews,
  currentVersionNumber,
  currentVersionOf,
  findNameConflicts,
  materialReadState,
  splitMaterials,
  type Material,
  type MaterialVersion,
} from '../materialsModel';

function version(partial: Partial<MaterialVersion> & { version: number }): MaterialVersion {
  return {
    id: `mv-${partial.version}`,
    materialId: 'm1',
    sha256: 'sha-old',
    sizeBytes: 100,
    mime: 'text/plain',
    storageKind: 'media',
    readState: 'ready',
    failureReason: null,
    createdAt: '2026-11-05T09:00:00.000Z',
    ...partial,
  };
}

function material(partial: Partial<Material> & { id: string }): Material {
  return {
    projectId: 'p1',
    workItemId: 'w1',
    name: 'notes.md',
    status: 'active',
    createdByKind: 'account',
    createdById: 'acc',
    createdAt: '2026-11-05T09:00:00.000Z',
    updatedAt: '2026-11-05T09:30:00.000Z',
    currentVersion: 0,
    readState: 'pending',
    versions: [],
    ...partial,
  };
}

describe('findNameConflicts', () => {
  const existing = material({
    id: 'same-name',
    name: 'brief.pdf',
    currentVersion: 1,
    versions: [version({ version: 1, sha256: 'sha-known' })],
  });

  it('only asks when an active material shares the name with different content', () => {
    const conflicts = findNameConflicts(
      [existing],
      [
        { name: 'brief.pdf', path: '/tmp/a', sha256: 'sha-known' },
        { name: 'brief.pdf', path: '/tmp/b', sha256: 'sha-other' },
        { name: 'other.pdf', path: '/tmp/c', sha256: 'sha-other' },
      ],
    );
    expect(conflicts.map((conflict) => conflict.index)).toEqual([1]);
    expect(conflicts[0]?.material.id).toBe('same-name');
  });

  it('does not block a name whose only material was removed', () => {
    const removed = material({ ...existing, status: 'removed' });
    expect(
      findNameConflicts([removed], [{ name: 'brief.pdf', path: '/tmp/b', sha256: 'sha-other' }]),
    ).toEqual([]);
  });

  it('asks rather than silently creating a second material when the fingerprint is unknown', () => {
    const conflicts = findNameConflicts(
      [existing],
      [{ name: 'brief.pdf', path: '/tmp/huge', sha256: null }],
    );
    expect(conflicts).toHaveLength(1);
  });
});

describe('current version and read state', () => {
  it('derives the highest version when the list projection omits currentVersion / readState', () => {
    const item = {
      ...material({
        id: 'm-derive',
        versions: [
          version({ version: 1, readState: 'failed' }),
          version({ version: 2, readState: 'ready' }),
        ],
      }),
      readState: undefined,
    } as unknown as Material;
    expect(currentVersionNumber(item)).toBe(2);
    expect(materialReadState(item)).toBe('ready');
  });

  it('keeps an explicitly bound older version instead of falling forward to the latest', () => {
    const item = material({
      id: 'm-pinned',
      currentVersion: 1,
      readState: 'failed',
      versions: [
        version({ version: 1, readState: 'failed', failureReason: 'timeout' }),
        version({ version: 2, readState: 'ready' }),
      ],
    });
    expect(currentVersionOf(item)?.version).toBe(1);
    expect(materialReadState(item)).toBe('failed');
  });

  it('never reports pending as readable when no version was projected', () => {
    expect(materialReadState(material({ id: 'm-empty', readState: 'pending' }))).toBe('pending');
  });
});

describe('contextRefViews', () => {
  const pinned = material({
    id: 'm-pinned',
    name: 'spec.md',
    status: 'removed',
    currentVersion: 2,
    versions: [version({ version: 1 }), version({ version: 2 })],
  });

  it('keeps a removed material pinned to v1 and reports its current readability (A5)', () => {
    const [view] = contextRefViews(
      [{ materialId: 'm-pinned', version: 1, readStateAtPin: 'ready' }],
      [pinned],
    );
    expect(view?.ref.readStateAtPin).toBe('ready');
    expect(view?.availability).toBe('materialRemoved');
    expect(view?.currentReadState).toBe('ready');
  });

  it('marks a version that no longer exists instead of inventing another one', () => {
    const [view] = contextRefViews(
      [{ materialId: 'm-pinned', version: 9, readStateAtPin: 'ready' }],
      [pinned],
    );
    expect(view?.availability).toBe('materialRemoved');
    expect(view?.version).toBeNull();
  });

  it('marks a material that left the work item', () => {
    const [view] = contextRefViews(
      [{ materialId: 'gone', version: 1, readStateAtPin: 'pending' }],
      [pinned],
    );
    expect(view?.availability).toBe('materialMissing');
    expect(view?.material).toBeNull();
  });
});

describe('splitMaterials', () => {
  it('keeps removed references visible but separate from the active list', () => {
    const materials = [
      material({ id: 'b', name: 'b.md' }),
      material({ id: 'a', name: 'a.md', status: 'removed' }),
    ];
    const split = splitMaterials(materials);
    expect(split.active.map((item) => item.id)).toEqual(['b']);
    expect(split.removed.map((item) => item.id)).toEqual(['a']);
  });
});
