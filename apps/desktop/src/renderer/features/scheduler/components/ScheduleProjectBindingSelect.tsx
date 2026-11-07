/**
 * 自动化编辑器里的「归属项目」选择器（自动化绑定项目实体）。
 *
 * 归属只听用户的显式选择：不按工作目录推断，没选就真的不归属项目。选项来自
 * projectsStore（与侧栏同一份快照），所以刚建好的项目立刻可选。
 *
 * 和 `ProjectBindingSelect`（新建任务时的选择器）是同一份数据、两套文案：这里只用
 * 活跃项目（归档项目不能承接新运行），且当前绑定若已归档 / 已不可见，仍然把它列出来
 * 并标注为已归档 —— 不能因为项目被归档就让表单显示成「没有绑定」，那会误导用户
 * 以为运行会落到别处。
 */
import { useEffect, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';

import { Select } from '@/components/ui/select';
import { projectsStore } from '../../projects/projectsStore';

export interface ScheduleProjectBindingSelectProps {
  /** '' = 不归属任何项目。 */
  value: string;
  onChange: (projectId: string) => void;
  disabled?: boolean;
}

export function ScheduleProjectBindingSelect({
  value,
  onChange,
  disabled = false,
}: ScheduleProjectBindingSelectProps): React.ReactElement | null {
  const { t } = useTranslation();
  const projects = useSyncExternalStore(projectsStore.subscribe, projectsStore.get);
  useEffect(() => {
    void projectsStore.ensure().catch(() => undefined);
  }, []);
  const active = (projects ?? []).filter((project) => project.status === 'active');
  // 已归档 / 已不可见的当前绑定仍要显示：它是这条自动化真实的保存值。
  const boundButUnusable =
    !!value && !active.some((project) => project.id === value)
      ? (projects ?? []).find((project) => project.id === value)
      : undefined;
  if (active.length === 0 && !value) return null;
  return (
    <div className="flex items-center gap-2">
      <span className="shrink-0 text-xs leading-[1.33] text-[var(--cmd-palette-item-meta)] dark:text-[var(--settings-section-desc)]">
        {t('scheduler.editor.projectBinding.label')}
      </span>
      <Select
        label={t('scheduler.editor.projectBinding.label')}
        value={value}
        disabled={disabled}
        options={[
          { value: '', label: t('scheduler.editor.projectBinding.none') },
          ...active.map((project) => ({ value: project.id, label: project.name })),
          ...(boundButUnusable
            ? [{
                value: boundButUnusable.id,
                label: t('scheduler.editor.projectBinding.archivedOption', { name: boundButUnusable.name }),
              }]
            : []),
        ]}
        onValueChange={onChange}
        className="w-[220px]"
      />
    </div>
  );
}
