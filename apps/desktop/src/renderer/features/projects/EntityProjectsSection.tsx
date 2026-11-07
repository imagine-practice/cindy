/**
 * EntityProjectsSection — 侧栏「项目」段（项目内核 M1）。
 *
 * 与旧的目录分组段（`ProjectsSection`）并存：
 *   - 本段只渲染实体项目（有 `projects` 记录、任务用 `sessions.project_id` 绑定）。
 *   - 目录分组继续由 `ProjectsSection` 按 `project_dir ?? working_dir` 归组，
 *     互不吞并（绑定任务已从目录分组里摘出，见 projectGrouping）。
 *
 * 项目行点名字进项目详情；任务行仍走侧栏统一的会话点击/菜单回调，
 * 所以右键菜单、重命名、置顶等行为与目录段完全一致。
 */
import { memo } from 'react';
import { ChevronDown, ChevronRight, FolderKanban, Plus } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { cn } from '@/lib/utils';
import { Button } from '@/components/ui/button';
import type { Session } from '@/lib/ccAgent.types';
import { SessionEntryList } from '../cc-agent/sidebar/SessionEntryList';
import type { SessionClickHandler } from '../cc-agent/sidebar/SessionItem';
import type { ProjectNode } from '../cc-agent/lib/projectGrouping';
import type {
  AutomationScheduleAction,
  AutomationScheduleSessionInfo,
  AutomationSessionGroup,
} from '../cc-agent/lib/automationSidebarGrouping';
import type { FolderPickerOption } from '@/components/new-chat/FolderPickerPopover';
import type { SessionMoveTarget } from '../cc-agent/sidebar/sessionMoveTarget';

export interface EntityProjectsSectionProps {
  projects: readonly ProjectNode[];
  collapsed: ReadonlySet<string>;
  activeSessionId?: string;
  viewedSessionId?: string | null;
  runningSessionIds: ReadonlySet<string>;
  attachedSessionIds: ReadonlySet<string>;
  notifications: ReadonlySet<string>;
  scheduleSessionIndex: ReadonlyMap<string, AutomationScheduleSessionInfo>;
  selectedSessionIds?: ReadonlySet<string>;
  onToggleProject: (projectKey: string) => void;
  onOpenProject: (projectId: string) => void;
  onNewProject: () => void;
  onOpenProjects: () => void;
  onSessionClick: SessionClickHandler;
  onAction: (id: string, action: 'delete' | 'archive' | 'archive-now' | 'unarchive') => void;
  onRename: (id: string, title: string) => void;
  onTogglePin: (id: string, currentlyPinned: boolean) => void;
  onMoveSession?: (id: string, target: SessionMoveTarget) => void;
  projectOptions?: readonly FolderPickerOption[];
  onScheduleAction: (group: AutomationSessionGroup, action: AutomationScheduleAction) => void;
}

export const EntityProjectsSection = memo(function EntityProjectsSection({
  projects,
  collapsed,
  activeSessionId,
  viewedSessionId,
  runningSessionIds,
  attachedSessionIds,
  notifications,
  scheduleSessionIndex,
  selectedSessionIds,
  onToggleProject,
  onOpenProject,
  onNewProject,
  onOpenProjects,
  onSessionClick,
  onAction,
  onRename,
  onTogglePin,
  onMoveSession,
  projectOptions,
  onScheduleAction,
}: EntityProjectsSectionProps): React.ReactElement | null {
  const { t } = useTranslation();
  if (projects.length === 0) {
    return (
      <section className="flex flex-col gap-1 px-2 pb-1">
        <SectionHeader label={t('ccAgent.projectCore.sectionTitle')} onNewProject={onNewProject} onOpenProjects={onOpenProjects} />
        <p className="px-2 text-12 text-[var(--settings-section-desc)]">
          {t('ccAgent.projectCore.emptyList')}
        </p>
      </section>
    );
  }

  return (
    <section className="flex flex-col gap-0.5 px-2 pb-1">
      <SectionHeader label={t('ccAgent.projectCore.sectionTitle')} onNewProject={onNewProject} onOpenProjects={onOpenProjects} />
      {projects.map((project) => {
        const isCollapsed = collapsed.has(project.projectKey);
        const sessions: readonly Session[] = project.sessions;
        return (
          <div key={project.projectKey} className="flex min-w-0 flex-col">
            <div className="group/project-row flex h-7 min-w-0 items-center gap-1 rounded-lg pr-1 hover:bg-[var(--sidebar-item-hover)]">
              <button
                type="button"
                onClick={() => onToggleProject(project.projectKey)}
                aria-label={project.displayName}
                aria-expanded={!isCollapsed}
                className="flex size-6 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-desc)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
              >
                {isCollapsed ? (
                  <ChevronRight size={14} strokeWidth={2} />
                ) : (
                  <ChevronDown size={14} strokeWidth={2} />
                )}
              </button>
              <FolderKanban
                size={14}
                strokeWidth={1.75}
                className="shrink-0 text-[var(--settings-section-desc)]"
              />
              <button
                type="button"
                onClick={() => onOpenProject(project.entityProjectId as string)}
                className="min-w-0 flex-1 truncate text-left text-13 font-medium text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                title={project.displayName}
              >
                {project.displayName}
              </button>
              <span className="shrink-0 text-11 text-[var(--settings-section-desc)]">
                {t('ccAgent.projectCore.taskCount', { count: sessions.length })}
              </span>
            </div>
            {!isCollapsed && sessions.length > 0 && (
              <div className="pt-0.5">
                <SessionEntryList
                  sessions={sessions}
                  activeSessionId={activeSessionId ?? (viewedSessionId ?? undefined)}
                  runningSessionIds={runningSessionIds}
                  attachedSessionIds={attachedSessionIds}
                  notifications={notifications}
                  scheduleSessionIndex={scheduleSessionIndex}
                  selectedSessionIds={selectedSessionIds}
                  onSessionClick={onSessionClick}
                  onAction={onAction}
                  onRename={onRename}
                  onTogglePin={onTogglePin}
                  onMoveSession={onMoveSession}
                  projectOptions={projectOptions}
                  onScheduleAction={onScheduleAction}
                  indented
                  showFirstDivider={false}
                />
              </div>
            )}
          </div>
        );
      })}
    </section>
  );
});

function SectionHeader({
  label,
  onNewProject,
  onOpenProjects,
}: {
  label: string;
  onNewProject: () => void;
  onOpenProjects: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  return (
    <div className="flex h-7 items-center justify-between gap-2 px-2">
      <button type="button" onClick={onOpenProjects}
        className="min-h-7 flex-1 rounded-lg text-left text-11 font-medium uppercase tracking-wide text-[var(--settings-section-desc)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]">
        {label}
      </button>
      <Button
        variant="secondary"
        size="xxs"
        tone="quiet"
        compact
        onClick={onNewProject}
        aria-label={t('ccAgent.projectCore.newProject')}
        className={cn('shrink-0')}
      >
        <Plus size={13} strokeWidth={2} />
      </Button>
    </div>
  );
}
