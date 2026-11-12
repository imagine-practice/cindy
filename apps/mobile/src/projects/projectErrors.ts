/** 写动作失败时的可读原因:先查宿主拒绝码,认不出才走通用远端错误文案。 */
import { humanizeRemoteError } from '@/device-link/remoteStatus';
import { projectErrorKey } from './projectModel';

type Translate = (key: string, options?: Record<string, unknown>) => string;

export function projectActionErrorText(t: Translate, error: unknown): string {
  const key = projectErrorKey(error);
  if (key) return t(key);
  return humanizeRemoteError(error);
}
