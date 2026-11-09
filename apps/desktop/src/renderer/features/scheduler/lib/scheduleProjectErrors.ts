/**
 * 自动化项目绑定被拒 → 用户可读文案的 i18n key 映射。
 *
 * main 侧对「为什么不能绑定」用项目内核既有错误码回答（非成员 / 已归档 / 项目没了），
 * 报错文本是英文的运维口径；界面不该把它直接抛给用户，也不该压成一句「保存失败」。
 * 未命中的错误码返回 null，调用方继续走既有的通用错误展示。
 */
import { extractIpcError } from '@/utils/ipcError';

export function scheduleProjectErrorKey(error: unknown): string | null {
  const code = extractIpcError(error)?.code;
  switch (code) {
    case 'NOT_PROJECT_MEMBER':
      return 'scheduler.editor.projectBinding.errors.notMember';
    case 'PROJECT_NOT_FOUND':
      return 'scheduler.editor.projectBinding.errors.notFound';
    case 'PROJECT_ARCHIVED':
      // 只有明确的 PROJECT_ARCHIVED 才说「已归档」。不要用 PRECONDITION_FAILED 之类的
      // 通用码去猜：账号切换 / 未登录也会走通用码，猜错就是把用户骗去恢复一个没归档的项目。
      return 'scheduler.editor.projectBinding.errors.archived';
    case 'ACCOUNT_UNAVAILABLE':
      return 'scheduler.editor.projectBinding.errors.accountUnavailable';
    default:
      return null;
  }
}
