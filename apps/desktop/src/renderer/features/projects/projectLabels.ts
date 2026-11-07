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

/** 头像 emoji：账号用中性人形，伙伴用档案里的头像。 */
export function projectSubjectAvatar(subject: ProjectSubject | null): string {
  if (!subject) return '👤';
  return subject.kind === 'account' ? '👤' : (subject.avatar ?? '🤖');
}
