/**
 * 项目详情里的「已关联群」：只读列表，点一行跳到那个群。
 *
 * 关系来自 `local-db:project-group-links:list-project`（按项目一次读，见
 * `useProjectLinkedGroups`）：main 用当前账号 + 本机设备 + 项目成员资格封闭范围，
 * 只返回 `status: 'active'` 的行。重新读取由用户点。
 *
 * 读不到时如实说明（含「被截断，可能不完整」），不冒充「没有关联」，也不显示群成员、
 * 群消息或任何项目访问凭证。
 */
import { useState } from 'react';
import { ChevronRight, Users } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';

import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { useProjectLinkedGroups } from './useProjectLinkedGroups';

export function ProjectLinkedGroupsSection({ projectId }: { projectId: string }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [refreshToken, setRefreshToken] = useState(0);
  const result = useProjectLinkedGroups(projectId, refreshToken);

  // 旧宿主没有这条通道：整块不显示，也不假装「没有关联」。
  if (result.status === 'unavailable') return null;

  return <section className="flex flex-col gap-3">
    <div className="flex items-center justify-between gap-2">
      <h2 className="flex items-baseline gap-1.5 text-14 font-medium text-[var(--settings-section-title)]">
        {t('projectGroupLinks.projectTitle')}
        {result.status === 'ready' && result.groups.length > 0
          && <span className="text-12 font-normal tabular-nums text-[var(--text-tertiary)]">{result.groups.length}</span>}
      </h2>
      <Button variant="secondary" tone="quiet" size="xs" compact disabled={result.status === 'loading'}
        onClick={() => setRefreshToken(value => value + 1)}>{t('projectGroupLinks.reload')}</Button>
    </div>
    {result.status === 'loading' && <p className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]">
      <Spinner size={14} />{t('projectGroupLinks.loading')}
    </p>}
    {result.status === 'failed' && <p role="alert" className="text-13 leading-[1.42] text-[var(--danger-text)]">
      {t('projectGroupLinks.projectFailed')}
      {' '}{t(result.reasonKey)}
    </p>}
    {result.status === 'ready' && result.groups.length === 0 && <p className="text-13 text-[var(--settings-section-desc)]">
      {t('projectGroupLinks.projectEmpty')}
    </p>}
    {result.status === 'ready' && result.groups.length > 0 && <ul className="flex flex-col">
      {result.groups.map(group => <li key={group.id}>
        <button type="button" onClick={() => navigate(`/bots/groups/${encodeURIComponent(group.id)}`)}
          aria-label={`${t('projectGroupLinks.openGroup')}: ${group.name}`}
          className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-left outline-none hover:bg-[var(--surface-hover)] focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
          <Users size={14} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />
          <span className="min-w-0 flex-1 truncate text-13 leading-[1.43] text-[var(--text-primary)]">{group.name}</span>
          <ChevronRight size={14} aria-hidden className="shrink-0 text-[var(--text-tertiary)]" />
        </button>
      </li>)}
    </ul>}
    {result.status === 'ready' && result.truncated && <p role="status" className="text-12 leading-[1.42] text-[var(--text-secondary)]">
      {t('projectGroupLinks.projectPartial')}
    </p>}
    {/* 这句是"还没有关联"的引导；已经有群时再显示，会让人以为关联没生效。 */}
    {result.status === 'ready' && result.groups.length === 0 && (
      <p className="text-12 leading-[1.42] text-[var(--settings-section-desc)]">{t('projectGroupLinks.projectHint')}</p>
    )}
  </section>;
}
