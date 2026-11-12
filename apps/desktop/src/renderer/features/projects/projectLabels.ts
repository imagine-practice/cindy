/**
 * 项目成员的展示名解析。
 *
 * main 只解析伙伴名（`bot_profiles`），账号主体的 `displayName` 是 null —— 账号昵称
 * 的权威来源在 renderer 的登录态里，所以这里补上。资料缺失时使用可读兜底，
 * 不将角色、内部 ID 或另一个主体的名字当作姓名。
 */
import { useTranslation } from 'react-i18next';

import { useOptionalAuth } from '@/contexts/AuthContext';
import { useBotProfiles } from '@/features/bots/botStore';
import type { ProjectSubject } from '../../../shared/projects';
import type { ProjectSubjectVisual } from './ProjectSubjectAvatar';

/**
 * 主体名；解析不到时返回 `null`。
 *
 * 两种语义必须分开：「这个人我们认不出来」（null）与「认识但资料没加载出来」
 * （由调用方决定怎么说）。群消息这类对外文本要用面向对方的话（「某位成员」），
 * 不能把内部的「资料暂不可用」发出去。
 */
export function useProjectSubjectName(): (subject: ProjectSubject | null) => string | null {
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const dataOwnerId = auth?.dataOwnerId ?? null;
  const bots = useBotProfiles();
  return (subject) => {
    if (!subject) return null;
    if (subject.kind === 'account') {
      if (dataOwnerId && subject.id === dataOwnerId) {
        return user?.name?.trim() || subject.displayName?.trim() || null;
      }
      return subject.displayName?.trim() || null;
    }
    const bot = bots.find((item) => item.id === subject.id);
    return subject.displayName?.trim() || bot?.name?.trim() || null;
  };
}

/** 界面内展示用：解析不到时用「资料暂不可用」这类内部状态说明。 */
export function useProjectSubjectLabel(): (subject: ProjectSubject | null) => string {
  const name = useProjectSubjectName();
  const dataOwnerId = useOptionalAuth()?.dataOwnerId ?? null;
  const { t } = useTranslation();
  return (subject) => {
    if (!subject) return '';
    if (subject.kind === 'account' && dataOwnerId && subject.id === dataOwnerId) {
      return name(subject) || t('ccAgent.projectCore.form.currentAccount');
    }
    return name(subject) || t('ccAgent.projectCore.detail.subjectUnavailable');
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
