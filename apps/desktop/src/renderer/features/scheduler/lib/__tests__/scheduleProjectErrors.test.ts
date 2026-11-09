/**
 * 自动化表单的拒绝码 → 文案映射（回归）。
 *
 * 曾经把 PROJECT_ARCHIVED 与 ACCOUNT_UNAVAILABLE 都映成 PRECONDITION_FAILED，界面又把
 * PRECONDITION_FAILED 一律说成「项目已归档」—— 用户换号后保存自动化，被引导去恢复一个
 * 根本没归档的项目。这里锁住「一个起因一个码、一个码一句话」，并保证通用码不猜归档。
 */
import { describe, expect, it } from 'vitest';

import { createIpcError } from '../../../../../shared/ipc-errors';
import { scheduleProjectErrorKey } from '../scheduleProjectErrors';

const keyOf = (code: Parameters<typeof createIpcError>[0]) =>
  scheduleProjectErrorKey(createIpcError(code, 'rejected'));

describe('schedule project binding error copy', () => {
  it('names each cause separately instead of guessing from a generic error', () => {
    expect(keyOf('NOT_PROJECT_MEMBER')).toBe('scheduler.editor.projectBinding.errors.notMember');
    expect(keyOf('PROJECT_ARCHIVED')).toBe('scheduler.editor.projectBinding.errors.archived');
    expect(keyOf('PROJECT_NOT_FOUND')).toBe('scheduler.editor.projectBinding.errors.notFound');
    expect(keyOf('ACCOUNT_UNAVAILABLE')).toBe(
      'scheduler.editor.projectBinding.errors.accountUnavailable',
    );
  });

  it('never calls a generic failure "archived"', () => {
    // 通用码可能来自账号切换、库未就绪等；猜成「已归档」会误导用户去恢复项目。
    expect(keyOf('PRECONDITION_FAILED')).toBeNull();
    expect(keyOf('NOT_FOUND')).toBeNull();
    expect(scheduleProjectErrorKey(new Error('plain failure'))).toBeNull();
  });
});
