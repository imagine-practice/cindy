/**
 * ProjectSubjectAvatar — 项目主体（账号 / 伙伴）唯一头像入口。
 *
 * 为什么单独抽出来：项目的负责人选择、成员列表、添加成员下拉都要画同一份身份，
 * 之前三处各自把 `bot.avatar` 字符串拼进 label，导致下拉里出现
 * `cindy://avatar/preset/cindy Cindy` 这种内部哨兵值。
 *
 * 规则：
 *   - 伙伴一律走 BotAvatar（它已经处理预设头像、托管图片、单个字素和未知哨兵的兜底）；
 *   - 当前账号没有头像资源，用与 BotAvatar xs 同尺寸（20px）的图标圆点，
 *     保证「账号 + 伙伴」列表里两行视觉重量一致。
 */
import { UserRound } from 'lucide-react';

import { cn } from '@/lib/utils';
import { BotAvatar } from '@/features/bots/BotAvatar';

export interface ProjectSubjectVisual {
  kind: 'account' | 'bot';
  name: string;
  avatar?: string | null;
  avatarColor?: string | null;
  avatarUrl?: string | null;
  deviceId?: string;
}

export function ProjectSubjectAvatar({
  subject,
  className,
}: {
  subject: ProjectSubjectVisual;
  className?: string;
}): React.ReactElement {
  if (subject.kind === 'bot') {
    return (
      <BotAvatar
        bot={{
          name: subject.name,
          avatar: subject.avatar ?? null,
          avatarColor: subject.avatarColor ?? null,
          avatarUrl: subject.avatarUrl ?? null,
          deviceId: subject.deviceId,
        }}
        size="xs"
        className={cn('shrink-0', className)}
      />
    );
  }
  return (
    <span
      aria-hidden
      className={cn(
        'flex size-5 shrink-0 items-center justify-center rounded-full',
        'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
        className,
      )}
    >
      <UserRound size={13} strokeWidth={1.8} />
    </span>
  );
}
