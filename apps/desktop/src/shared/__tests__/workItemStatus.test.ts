import { describe, expect, it } from 'vitest';

import {
  WORK_ITEM_STATUSES,
  allowedWorkItemTransitions,
  nextWorkItemStatus,
  normalizeWorkItemBlockReason,
  summarizeWorkItems,
  toWorkItemStatus,
  workItemTransitionNeedsReason,
  type WorkItemSessionSignals,
  type WorkItemStatus,
} from '../workItemStatus';

const ACTIVE_AT = '2026-11-05T09:30:00.000Z';

/** Unit regression: previous mapping counted unfinished archives/deletions as done.
 * Exercise production projection and aggregation, without IO or real waits.
 */
describe('toWorkItemStatus', () => {
  it.each([
    [{ status: 'archived', explicitStatus: 'doing' }, 'doing'],
    [{ status: 'archived', blocked: true }, 'blocked'],
    [{ status: 'archived' }, null],
    [{ status: 'deleted', blocked: true }, 'blocked'],
    [{ status: 'deleted', explicitStatus: 'done' }, 'done'],
    [{ status: 'active', running: false, lastActivityAt: ACTIVE_AT }, 'doing'],
    [{ status: 'archived', explicitStatus: 'done' }, 'done'],
    [{ status: 'active', explicitStatus: 'done' }, 'done'],
    [{ status: 'active', completedAwaitingReview: true }, 'review'],
    [{ status: 'archived', explicitStatus: 'review' }, 'review'],
    [{ status: 'active', blocked: true, running: true }, 'blocked'],
    [{ status: 'active', running: true }, 'doing'],
    [{ status: 'active', userSendAt: ACTIVE_AT }, 'doing'],
    [{ status: 'active', lastActivityAt: Date.parse(ACTIVE_AT) }, 'doing'],
    [{ status: 'active', running: false, userSendAt: null, lastActivityAt: null }, 'todo'],
    [{ status: 'active' }, null],
    [{ status: 'active', running: false }, null],
    [{ status: 'active', userSendAt: '', lastActivityAt: 0 }, null],
    [{ status: 'active', lastActivityAt: 'not-a-date' }, null],
    [{ status: 'paused', running: true }, null],
    [{ status: 'paused', blocked: true }, 'blocked'],
  ] as const)('projects %j as %s', (session, expected) => {
    expect(toWorkItemStatus(session)).toBe(expected);
  });

  it('excludes failed deletion and preserves archived progress through aggregation', () => {
    const sessions: WorkItemSessionSignals[] = [
      { status: 'archived', explicitStatus: 'doing' },
      { status: 'deleted', blocked: true },
      { status: 'deleted', explicitStatus: 'done' },
      { status: 'active', running: false, lastActivityAt: ACTIVE_AT },
      { status: 'archived', explicitStatus: 'done' },
      { status: 'archived' },
    ];
    expect(
      summarizeWorkItems(
        sessions.map((session) => ({
          sessionStatus: session.status,
          status: toWorkItemStatus(session),
        })),
      ),
    ).toEqual({
      total: 4,
      counts: { todo: 0, doing: 2, blocked: 0, review: 0, done: 1 },
      unknownCount: 1,
      blockedItems: [],
    });
  });
});

describe('nextWorkItemStatus 流转规则', () => {
  it.each(WORK_ITEM_STATUSES)('从 %s 出发，图上每条边都放行', (from) => {
    for (const to of allowedWorkItemTransitions(from)) {
      expect(nextWorkItemStatus(from, to, { reason: '等接口联调' })).toEqual({ ok: true });
    }
  });

  it('done 可以回退到 doing（返工），但不能直接退成 todo', () => {
    expect(nextWorkItemStatus('done', 'doing')).toEqual({ ok: true });
    expect(nextWorkItemStatus('done', 'todo')).toEqual({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('blocked 必须先解除，不能直接进入 review / done', () => {
    expect(nextWorkItemStatus('blocked', 'review', { reason: '解除了' })).toEqual({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
    expect(nextWorkItemStatus('blocked', 'done', { reason: '解除了' })).toEqual({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('图外的其它跳跃都被拒（todo/review 不缺路径，但不存在捷径）', () => {
    expect(nextWorkItemStatus('todo', 'review')).toEqual({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
    expect(nextWorkItemStatus('review', 'todo')).toEqual({
      ok: false,
      code: 'ILLEGAL_TRANSITION',
    });
  });

  it('进入 blocked 缺原因被拒：undefined / null / 纯空白都算没给', () => {
    expect(nextWorkItemStatus('doing', 'blocked')).toEqual({ ok: false, code: 'REASON_REQUIRED' });
    expect(nextWorkItemStatus('doing', 'blocked', { reason: null })).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
    expect(nextWorkItemStatus('doing', 'blocked', { reason: ' \n\t ' })).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });

  it('进入 blocked 带原因即放行', () => {
    expect(nextWorkItemStatus('doing', 'blocked', { reason: '等设计稿确认' })).toEqual({
      ok: true,
    });
  });

  it('同状态是幂等 no-op（双击 / 重试不报错，包括 done → done 不需原因）', () => {
    for (const status of WORK_ITEM_STATUSES) {
      expect(nextWorkItemStatus(status, status, { reason: 'existing reason' })).toEqual({
        ok: true,
      });
    }
    expect(nextWorkItemStatus('blocked', 'blocked')).toEqual({
      ok: false,
      code: 'REASON_REQUIRED',
    });
  });

  it('不认识的状态先于一切被拒（脏 payload 不能靠 from === to 混过）', () => {
    const junk = 'weird' as WorkItemStatus;
    expect(nextWorkItemStatus(junk, junk)).toEqual({ ok: false, code: 'UNKNOWN_STATUS' });
    expect(nextWorkItemStatus(junk, 'doing')).toEqual({ ok: false, code: 'UNKNOWN_STATUS' });
    expect(nextWorkItemStatus('doing', junk)).toEqual({ ok: false, code: 'UNKNOWN_STATUS' });
  });

  it('只有 blocked 需要原因；allowedWorkItemTransitions 与校验用同一张图', () => {
    expect(workItemTransitionNeedsReason('blocked')).toBe(true);
    expect(
      (['todo', 'doing', 'review', 'done'] as const).filter((status) =>
        workItemTransitionNeedsReason(status),
      ),
    ).toEqual([]);
    expect(allowedWorkItemTransitions('doing')).toEqual(['todo', 'blocked', 'review', 'done']);
    expect(allowedWorkItemTransitions('done')).toEqual(['doing']);
    // 菜单来源与校验必须一致：图里有的才放行，图里没有的一律 ILLEGAL_TRANSITION。
    for (const from of WORK_ITEM_STATUSES) {
      const allowed = allowedWorkItemTransitions(from);
      for (const to of WORK_ITEM_STATUSES) {
        if (to === from || allowed.includes(to)) continue;
        expect(nextWorkItemStatus(from, to, { reason: 'x' })).toEqual({
          ok: false,
          code: 'ILLEGAL_TRANSITION',
        });
      }
    }
  });

  it('阻塞原因口径：去空白后为空即「没给」', () => {
    expect(normalizeWorkItemBlockReason('  等审批  ')).toBe('等审批');
    expect(normalizeWorkItemBlockReason('   ')).toBeNull();
    expect(normalizeWorkItemBlockReason(undefined)).toBeNull();
  });
});

describe('summarizeWorkItems 计数', () => {
  const items = [
    { id: 'a', status: 'todo' },
    { id: 'b', status: 'blocked' },
    { id: 'c', status: 'doing' },
    { id: 'd', status: 'blocked' },
    { id: 'e', status: 'review' },
    { id: 'f', status: 'done' },
    { id: 'g', status: 'done' },
  ];

  it('按状态计数，并保持输入顺序列出阻塞项', () => {
    const summary = summarizeWorkItems(items);
    expect(summary.counts).toEqual({ todo: 1, doing: 1, blocked: 2, review: 1, done: 2 });
    expect(summary.total).toBe(items.length);
    expect(summary.total).toBe(Object.values(summary.counts).reduce((sum, n) => sum + n, 0));
    expect(summary.blockedItems.map((item) => item.id)).toEqual(['b', 'd']);
  });

  it('空输入返回全 0 与空列表，不返回 undefined', () => {
    const summary = summarizeWorkItems([]);
    expect(summary.counts).toEqual({ todo: 0, doing: 0, blocked: 0, review: 0, done: 0 });
    expect(summary.total).toBe(0);
    expect(summary.unknownCount).toBe(0);
    expect(summary.blockedItems).toEqual([]);
  });

  it('keeps unknown progress in the effective total', () => {
    const summary = summarizeWorkItems([
      { id: 'a', status: 'todo' },
      { id: 'b', status: 'legacy-status' },
      { id: 'c', status: '' },
    ]);
    expect(summary.counts).toEqual({ todo: 1, doing: 0, blocked: 0, review: 0, done: 0 });
    expect(summary.total).toBe(3);
    expect(summary.unknownCount).toBe(2);
    expect(summary.blockedItems).toEqual([]);
  });
});
