/**
 * 项目错误码 → 用户可读文案的 i18n key 映射。
 *
 * 服务层用明确的错误码表达「为什么被拒」（必须转交负责人 / 非成员 / 任务未绑定），
 * UI 不该把这些压成一句「操作失败」。
 */
import { extractIpcError } from '@/utils/ipcError';

export function projectErrorKey(error: unknown): string {
  const code = extractIpcError(error)?.code;
  switch (code) {
    case 'MUST_TRANSFER_OWNER_FIRST':
      return 'ccAgent.projectCore.error.ownerMustTransfer';
    case 'ASSIGNEE_NOT_MEMBER':
      return 'ccAgent.projectCore.error.notMember';
    case 'PROJECT_TASK_UNBOUND':
      return 'ccAgent.projectCore.error.taskUnbound';
    case 'PROJECT_DIR_BOUND':
      return 'ccAgent.projectCore.error.dirBound';
    default:
      return 'ccAgent.projectCore.error.generic';
  }
}
