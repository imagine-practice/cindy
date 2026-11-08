import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { FolderKanban, Plus, ArrowUpRight } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import type { ProjectRecord } from '../../../shared/projects';
import { useProjectSubjectLabel } from './projectLabels';
import { useProjectsIndex } from './projectsIndexController';
import { NewProjectDialog } from './NewProjectDialog';

export interface ProjectsPageProps {
  onOpenProject: (projectId: string) => void;
  /** Optional parent-owned dialog. Invoke afterCreated only after its confirmed successful create. */
  onNewProject?: (afterCreated: () => void) => void;
}
export function ProjectsPage(props: ProjectsPageProps): React.ReactElement {
  const auth = useOptionalAuth();
  return (
    <ProjectsIndexScope
      key={JSON.stringify([auth?.dataOwnerId, auth?.dataOwnerGeneration, getDataOwnerGeneration()])}
      {...props}
    />
  );
}
function ProjectsIndexScope({
  onOpenProject,
  onNewProject,
}: ProjectsPageProps): React.ReactElement {
  const { t } = useTranslation();
  const { state, reload, live } = useProjectsIndex();
  const [query, setQuery] = useState('');
  const [status, setStatus] = useState('active');
  const [creating, setCreating] = useState(false);
  const trigger = useRef<HTMLButtonElement>(null);
  const restoreFocus = useRef(false);
  const loading = state.phase === 'loading';
  const writable = state.phase === 'ready' && state.canCreate;
  const index = (key: string, values?: Record<string, unknown>) =>
    t('ccAgent.projectCore.index.' + key, values);
  const visible = useMemo(() => {
    const text = query.trim().toLocaleLowerCase();
    return state.records
      .filter(
        (p) =>
          (status === 'all' || p.status === status) &&
          (!text || `${p.name}\n${p.goal ?? ''}`.toLocaleLowerCase().includes(text)),
      )
      .sort(
        (a, b) =>
          (Date.parse(b.updatedAt) || 0) - (Date.parse(a.updatedAt) || 0) ||
          a.id.localeCompare(b.id),
      );
  }, [state.records, status, query]);
  useEffect(() => {
    if (state.phase !== 'ready') setCreating(false);
  }, [state.phase]);
  useEffect(() => {
    if (!creating && state.phase === 'ready' && restoreFocus.current) {
      const frame = requestAnimationFrame(() => {
        if (live()) {
          trigger.current?.focus();
          restoreFocus.current = false;
        }
      });
      return () => cancelAnimationFrame(frame);
    }
  }, [creating, state.phase, live]);
  const afterCreated = () => {
    if (live()) {
      restoreFocus.current = true;
      void reload();
    }
  };
  const newProject = () => {
    if (!live() || !writable) return;
    if (onNewProject) onNewProject(afterCreated);
    else setCreating(true);
  };
  return (
    <main className="app-wallpaper-surface flex h-full min-w-0 flex-col bg-[hsl(var(--content-area))]">
      <header className="flex shrink-0 flex-wrap items-center justify-between gap-3 border-b border-[var(--cmd-palette-border)] px-4 py-5 sm:px-6">
        <div className="min-w-0">
          <h1 className="text-18 font-medium text-[var(--text-primary)]">
            {t('ccAgent.projectCore.sectionTitle')}
          </h1>
          <p className="mt-1 text-12 text-[var(--text-secondary)]">{index('description')}</p>
        </div>
        <Button variant="primary" size="md" ref={trigger} disabled={!writable} onClick={newProject}>
          <Plus size={14} aria-hidden />
          {t('ccAgent.projectCore.newProject')}
        </Button>
      </header>
      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="mx-auto flex w-full max-w-[1120px] flex-col gap-5">
          <div className="flex flex-wrap items-end gap-3">
            <label className="flex min-w-0 flex-1 basis-[240px] flex-col gap-1.5 text-12 text-[var(--text-secondary)]">
              <span>{index('searchLabel')}</span>
              <Input
                value={query}
                onChange={setQuery}
                placeholder={index('searchPlaceholder')}
                disabled={state.phase !== 'ready'}
                size="md"
              />
            </label>
            <Select
              label={index('filterLabel')}
              value={status}
              options={['active', 'archived', 'all'].map((value) => ({
                value,
                label: index(value),
              }))}
              onValueChange={(value) => {
                if (['active', 'archived', 'all'].includes(value)) setStatus(value);
              }}
              className="w-full sm:w-[180px]"
              disabled={state.phase !== 'ready'}
            />
          </div>
          {loading ? (
            <div
              role="status"
              className="flex items-center justify-center gap-2 py-16 text-13 text-[var(--text-secondary)]"
            >
              <Spinner size={15} />
              {index('loading')}
            </div>
          ) : state.phase === 'error' ? (
            <div
              role="alert"
              className="flex flex-col items-start gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-5"
            >
              <p className="text-13 text-[var(--text-primary)]">
                {index(state.error ?? 'loadFailed')}
              </p>
              <Button variant="secondary" size="sm" onClick={() => void reload()}>
                {index('retry')}
              </Button>
            </div>
          ) : (
            <>
              {!state.canCreate && (
                <p role="status" className="text-12 text-[var(--text-secondary)]">
                  {index('createUnavailable')}
                </p>
              )}
              <p role="status" className="text-12 text-[var(--text-secondary)]">
                {index('resultCount', { count: visible.length })}
              </p>
              {visible.length === 0 ? (
                <div className="flex flex-col items-center gap-3 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-12 text-center">
                  <FolderKanban size={26} className="text-[var(--text-secondary)]" aria-hidden />
                  <h2 className="text-14 font-medium text-[var(--text-primary)]">
                    {index(state.records.length ? 'noMatches' : 'emptyTitle')}
                  </h2>
                  <p className="max-w-[420px] text-12 leading-normal text-[var(--text-secondary)]">
                    {index(state.records.length ? 'noMatchesDesc' : 'emptyDesc')}
                  </p>
                  {state.records.length ? (
                    <Button
                      variant="secondary"
                      size="sm"
                      onClick={() => {
                        setQuery('');
                        setStatus('all');
                      }}
                    >
                      {index('clearFilters')}
                    </Button>
                  ) : (
                    <Button variant="secondary" size="sm" disabled={!writable} onClick={newProject}>
                      {t('ccAgent.projectCore.newProject')}
                    </Button>
                  )}
                </div>
              ) : (
                <ul className="grid min-w-0 grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
                  {visible.map((project) => (
                    <ProjectCard
                      key={project.id}
                      project={project}
                      onOpen={() => {
                        if (live() && state.phase === 'ready') onOpenProject(project.id);
                      }}
                    />
                  ))}
                </ul>
              )}
            </>
          )}
        </div>
      </div>
      <NewProjectDialog
        open={creating && writable}
        onOpenChange={(open) => {
          if (live()) {
            setCreating(open);
            if (!open) restoreFocus.current = true;
          }
        }}
        onCreated={afterCreated}
      />
    </main>
  );
}
function ProjectCard({
  project,
  onOpen,
}: {
  project: ProjectRecord;
  onOpen: () => void;
}): React.ReactElement {
  const descriptionId = useId();
  const { t, i18n } = useTranslation();
  const label = (key: string, values?: Record<string, unknown>) =>
    t('ccAgent.projectCore.index.' + key, values);
  const subjectLabel = useProjectSubjectLabel();
  const owner = project.members.find((m) => m.role === 'owner')!.subject;
  const bots = project.members.filter((m) => m.subject.kind === 'bot').length;
  const updated = Date.parse(project.updatedAt);
  return (
    <li className="flex min-w-0">
      <button
        type="button"
        data-project-id={project.id}
        onClick={onOpen}
        aria-label={label('openProject', { name: project.name })}
        aria-describedby={`${descriptionId}-goal ${descriptionId}-meta`}
        className="flex w-full min-w-0 flex-col gap-4 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] p-4 text-left transition-colors hover:bg-[var(--surface-hover)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
      >
        <span className="flex min-w-0 items-start gap-3">
          <FolderKanban
            size={18}
            strokeWidth={1.75}
            className="mt-0.5 shrink-0 text-[var(--text-secondary)]"
            aria-hidden
          />
          <span className="min-w-0 flex-1">
            <span
              role="heading"
              aria-level={2}
              className="block break-words text-14 font-medium text-[var(--text-primary)]"
            >
              {project.name}
            </span>
            <span className="mt-1 inline-block rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 text-[var(--text-secondary)]">
              {label(project.status)}
            </span>
          </span>
          <ArrowUpRight size={14} className="shrink-0 text-[var(--text-tertiary)]" aria-hidden />
        </span>
        <span
          id={`${descriptionId}-goal`}
          title={project.goal ?? undefined}
          className="line-clamp-3 min-w-0 break-words text-12 leading-normal text-[var(--text-secondary)]"
        >
          {project.goal || label('noGoal')}
        </span>
        <span
          id={`${descriptionId}-meta`}
          className="mt-auto flex min-w-0 flex-col gap-2 text-12 text-[var(--text-secondary)]"
        >
          <span className="min-w-0 break-words">
            {/* 只写名字：账号/伙伴是内部模型词，普通用户读起来是噪音。 */}
            {label('owner')} · {subjectLabel(owner)}
          </span>
          <span className="flex flex-wrap gap-x-3 gap-y-1">
            <span>{label('memberCount', { count: project.members.length, bots })}</span>
            <span>{label('taskCount', { count: project.taskCount })}</span>
          </span>
          <span className="min-w-0 break-words text-11 text-[var(--text-tertiary)]">
            {label('updated')} ·{' '}
            {Number.isFinite(updated)
              ? new Intl.DateTimeFormat(i18n?.language ?? 'en', { dateStyle: 'medium' }).format(
                  updated,
                )
              : label('unknownTime')}
          </span>
          <span className="text-11 text-[var(--text-secondary)]">{label('progressHint')}</span>
        </span>
      </button>
    </li>
  );
}
