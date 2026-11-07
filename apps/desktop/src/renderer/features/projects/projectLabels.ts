/**
 * 项目成员的展示名解析。
 *
 * main 只解析伙伴名（`bot_profiles`），账号主体的 `displayName` 是 null —— 账号昵称
 * 的权威来源在 renderer 的登录态里，所以这里补上。未解析到的 id 直接显示 id 本身，
 * 绝不猜一个「大概是同一个人」的名字。
 */
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '@/contexts/AuthContext';
import { useBotProfiles } from '@/features/bots/botStore';
import type { ProjectSubject } from '../../../shared/projects';
import type { ProjectSubjectVisual } from './ProjectSubjectAvatar';

export function useProjectSubjectLabel(): (subject: ProjectSubject | null) => string {
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const dataOwnerId = auth?.dataOwnerId ?? null;
  const bots = useBotProfiles();
  const { t } = useTranslation();
  return (subject) => {
    if (!subject) return '';
    if (subject.kind === 'account') {
      if (dataOwnerId && subject.id === dataOwnerId) {
        return user?.name || t('ccAgent.projectCore.detail.ownerBadge');
      }
      return subject.displayName ?? subject.id;
    }
    const bot = subject.displayName ? undefined : bots.find((item) => item.id === subject.id);
    return subject.displayName ?? bot?.name ?? subject.id;
  };
}

/**
 * 头像主体：账号无头像资源，伙伴沿用档案里的头像值（可能是预设哨兵或托管图片）。
 * 渲染一律交给 ProjectSubjectAvatar，不要把 `avatar` 字符串拼进文本。
 */
export function projectSubjectVisual(
  subject: ProjectSubject | null,
  name: string,
): ProjectSubjectVisual {
  if (!subject) return { kind: 'account', name };
  return {
    kind: subject.kind,
    name,
    avatar: subject.avatar ?? null,
    avatarColor: subject.avatarColor ?? null,
  };
}

/** @deprecated 仅保留给旧调用点与测试替身；新代码用 ProjectSubjectAvatar。 */
export function projectSubjectAvatar(subject: ProjectSubject | null): string {
  if (!subject) return '👤';
  return subject.kind === 'account' ? '👤' : (subject.avatar ?? '🤖');
}
