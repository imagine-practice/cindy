/**
 * ProjectBindingSelect — 新建任务时的「归属项目」选择器（项目内核 M1）。
 *
 * 归属只听用户的显式选择：不按工作目录推断，也不在没选项目时补一个默认值。
 * 选项来自 projectsStore（与侧栏同一份快照），所以刚建好的项目立刻可选。
 */
import { useSyncExternalStore, useEffect } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/ui/select';
import { projectsStore } from './projectsStore';

export interface ProjectBindingSelectProps {
  /** null = 不归属项目。 */
  value: string | null;
  onChange: (projectId: string | null) => void;
  disabled?: boolean;
  className?: string;
}

export function ProjectBindingSelect({
  value,
  onChange,
  disabled = false,
  className,
}: ProjectBindingSelectProps): React.ReactElement | null {
  const { t } = useTranslation();
  const projects = useSyncExternalStore(projectsStore.subscribe, projectsStore.getIndex);
  useEffect(() => {
    void projectsStore.ensure().catch(() => undefined);
  }, []);
  if (projects.length === 0) return null;
  return (
    <div className={className ? `flex items-center gap-2 ${className}` : 'flex items-center gap-2'}>
      <span className="shrink-0 text-12 text-[var(--settings-section-desc)]">
        {t('ccAgent.projectCore.detail.projectLabel')}
      </span>
      <Select
        label={t('ccAgent.projectCore.badge')}
        value={value ?? ''}
        disabled={disabled}
        options={[
          { value: '', label: t('ccAgent.projectCore.detail.noProject') },
          ...projects.map((project) => ({ value: project.id, label: project.name })),
        ]}
        onValueChange={(next) => onChange(next === '' ? null : next)}
        className="w-[240px]"
      />
    </div>
  );
}
