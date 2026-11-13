import type { ProjectMember } from '../../../../shared/projects';
import { useProjectSubjectName } from '../projectLabels';
import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { WORK_ITEM_STATUSES, type WorkItemStatus } from '../../../../shared/workItemStatus';
import type { WorkItemExecutionEntry } from '../../../../shared/projectWorkItemExecutionRequest';
import {
  projectProgressView,
  type ProjectProgressItem,
  type ProjectProgressHistoryEntry,
} from './progressProjection';

export type ProjectProgressState =
  | { status: 'loading' | 'error' | 'forbidden' }
  | {
      status: 'ready';
      projectId: string;
      items: readonly ProjectProgressItem[];
      history: readonly ProjectProgressHistoryEntry[];
    };

export type ProjectProgressFilter = 'all' | 'unknown' | WorkItemStatus;

export interface ProjectProgressViewProps {
  /** Members of this project: the only offline source of another account's display name. */
  members?: readonly ProjectMember[];
  projectId: string;
  state: ProjectProgressState;
  onOpenWorkItem: (sessionId: string) => void;
  onRefresh: () => void;
  onEditWorkItem?: (sessionId: string) => void;
  /** Keyed by sessionId; absent = entry stays hidden (never guessed from progress data). */
  execution?: Readonly<Record<string, WorkItemExecutionEntry>>;
  executionUnavailable?: boolean;
  filter?: ProjectProgressFilter;
  onFilterChange?: (filter: ProjectProgressFilter) => void;
}

const PREFIX = 'ccAgent.projectCore.progress';

/** Composable read-only view. No bridge, router, persistence, or permission decisions. */
export function ProjectProgressView(props: ProjectProgressViewProps) {
  // Unmount viewing state on project AND readiness changes; old filters/body cannot survive.
  return (
    <ProgressContent
      key={`${props.projectId}:${props.state.status}:${props.state.status === 'ready' ? props.state.projectId : ''}`}
      {...props}
    />
  );
}

function ProgressContent({
  projectId,
  members = [],
  state,
  onOpenWorkItem,
  onRefresh,
  onEditWorkItem,
  execution,
  executionUnavailable,
  filter: controlledFilter,
  onFilterChange,
}: ProjectProgressViewProps) {
  const { t, i18n } = useTranslation();
  const label = (key: string) => t(`${PREFIX}.${key}`);
  const subjectName = useProjectSubjectName();
  /** History actors are kind/id only from Main; resolve a readable name, never print the id. */
  const actorName = (actor: ProjectProgressHistoryEntry['actor']): string => {
    const named = actor.displayName?.trim();
    if (named) return named;
    const member = members.find(
      (item) => item.subject.kind === actor.kind && item.subject.id === actor.id,
    );
    return subjectName(member?.subject ?? { kind: actor.kind, id: actor.id, displayName: null, avatar: null, avatarColor: null })
      ?? label('unknownActor');
  };
  const [localFilter, setLocalFilter] = useState<ProjectProgressFilter>('all');
  const filter = controlledFilter ?? localFilter;
  const [expanded, setExpanded] = useState(false);
  if (state.status !== 'ready' || state.projectId !== projectId) {
    const status = state.status === 'ready' ? 'loading' : state.status;
    return (
      <section
        aria-label={label('title')}
        className="flex min-w-0 flex-col gap-3 text-13 text-[var(--text-secondary)]"
      >
        <p role={status === 'error' ? 'alert' : 'status'}>{label(status)}</p>
        {status === 'error' && (
          <Button variant="secondary" className="self-start" onClick={onRefresh}>
            {label('retry')}
          </Button>
        )}
      </section>
    );
  }
  let view: ReturnType<typeof projectProgressView>;
  try {
    view = projectProgressView(projectId, state.items, state.history);
  } catch {
    return (
      <section aria-label={label('title')} className="flex min-w-0 flex-col gap-3">
        <p role="alert" className="text-13 text-[var(--text-secondary)]">
          {label('dataError')}
        </p>
        <Button variant="secondary" className="self-start" onClick={onRefresh}>
          {label('retry')}
        </Button>
      </section>
    );
  }
  const statuses = ['all', ...WORK_ITEM_STATUSES, 'unknown'] as const;
  const visible = view.items.filter(
    (item) => filter === 'all' || (item.status ?? 'unknown') === filter,
  );
  const count = (status: (typeof statuses)[number]) =>
    status === 'all'
      ? view.summary.total
      : status === 'unknown'
        ? view.summary.unknownCount
        : view.summary.counts[status];
  const missing = (value: string | null) => value?.trim() || label('notRecorded');
  const detailClass =
    'whitespace-pre-wrap break-words [overflow-wrap:anywhere] text-13 text-[var(--text-secondary)]';
  return (
    <section
      aria-label={label('title')}
      className="flex min-w-0 flex-col gap-5 text-[var(--text-primary)]"
    >
      <header className="flex min-w-0 flex-col gap-2">
        <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
          {label('title')}
        </h2>
        <p className="text-12 leading-normal text-[var(--settings-section-desc)]">
          {label('completionMeaning')}
        </p>
      </header>
      {/* 状态筛选：整行小药丸，与应用其它列表页同款高度（28px），不占半屏。 */}
      <div
        role="group"
        aria-label={label('filter')}
        className="flex flex-wrap items-center gap-1.5"
      >
        {statuses.map((status) => (
          <Button
            key={status}
            variant="secondary"
            size="sm"
            compact
            aria-pressed={filter === status}
            className={cn(
              'min-w-0',
              // 选中态用反色而不是「浅灰 chip」：亮色主题下浅灰与未选中几乎同色。
              filter === status &&
                '[--button-face-bg:var(--text-primary)] [--button-face-border:var(--text-primary)] text-[var(--surface-elevated)] hover:[--button-face-bg:var(--text-primary)]',
            )}
            onClick={() => { setLocalFilter(status); onFilterChange?.(status); }}
          >
            {label(status)} · {count(status)}
          </Button>
        ))}
      </div>
      <div className="flex min-w-0 flex-col gap-2">
        <h3 className="text-14 font-medium">{label('executionTitle')}</h3>
        {view.items.length === 0 ? (
          <p className={detailClass}>{label('empty')}</p>
        ) : visible.length === 0 ? (
          <p className={detailClass}>{label('noMatches')}</p>
        ) : (
          <ul className="min-w-0 divide-y divide-[var(--border-default)]">
            {visible.map((item) => {
              const executionEntry = execution?.[item.sessionId];
              return (
              <li key={item.sessionId} className="flex min-w-0 flex-col gap-2 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="secondary"
                    tone="quiet"
                    className="min-w-0 max-w-full justify-start text-left"
                    aria-label={t('chat.botStartedTasks.open', { title: item.title || label('untitled') })}
                    onClick={() => onOpenWorkItem(item.sessionId)}
                  >
                    <span className="whitespace-normal break-words [overflow-wrap:anywhere]">
                      {item.title || label('untitled')}
                    </span>
                    <span aria-hidden="true" className="text-12 text-[var(--text-secondary)]">
                      {t('chat.botTaskLetter.openTask')}
                    </span>
                  </Button>
                  {onEditWorkItem && <Button variant="secondary" className="whitespace-normal"
                    aria-label={`${t('ccAgent.projectCore.progressEdit.title')} — ${item.title || label('untitled')}`}
                    onClick={() => onEditWorkItem(item.sessionId)}>{t('ccAgent.projectCore.progressEdit.title')}</Button>}
                  {/* 由自动化创建的工作项：只在真的存在会话 + run + 来源自动化时出现。 */}
                  {item.automation && (
                    <span
                      className="text-12 text-[var(--text-secondary)]"
                      title={item.automation.scheduleName || undefined}
                    >
                      {item.automation.scheduleName
                        ? t(`${PREFIX}.automationOriginNamed`, { name: item.automation.scheduleName })
                        : label('automationOrigin')}
                    </span>
                  )}
                  <span className="text-12 text-[var(--text-secondary)]">
                    {label(item.status ?? 'unknown')}
                  </span>

                </div>
                {item.status === 'blocked' && (
                  <dl className="flex min-w-0 flex-col gap-1 pl-3">
                    <dt className="text-12 font-medium">{label('reason')}</dt>
                    <dd className={detailClass}>{missing(item.blockReason)}</dd>
                    <dt className="text-12 font-medium">{label('unblockCondition')}</dt>
                    <dd className={detailClass}>{missing(item.unblockCondition)}</dd>
                  </dl>
                )}
                {executionEntry && (
                  <p className="text-12 text-[var(--text-secondary)]">
                    {executionEntry.followup?.pending
                      ? t('ccAgent.sidebar.status.needsAttention')
                      : label(`execution.state.${executionEntry.state}`)}
                  </p>
                )}
              </li>
              );
            })}
          </ul>
        )}
        {/* 空项目没有执行状态可读：此时报「读不到」是假错误，只在真有工作项时提示。 */}
        {executionUnavailable && view.items.length > 0 && (
          <p role="status" className={detailClass}>
            {label('execution.unavailableState')}
          </p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-3">
        <h3 className="text-14 font-medium">{label('history')}</h3>
        {view.history.length === 0 ? (
          <p className={detailClass}>{label('noHistory')}</p>
        ) : (
          <ol className="min-w-0 divide-y divide-[var(--border-default)]">
            {(expanded ? view.history : view.history.slice(0, 5)).map((event) => (
              <li key={event.eventId} className="flex min-w-0 flex-col gap-2 py-3">
                <p className="text-13">
                  {label(event.from ?? 'unknown')} → {label(event.to)}
                  {event.historicalBinding && (
                    <span className="ml-2 text-12 text-[var(--text-secondary)]">
                      {label('historicalBinding')}
                    </span>
                  )}
                </p>
                <p className={detailClass}>
                  {/* Never print the raw subject id: it is an internal identifier, not a name. */}
                  <span>{actorName(event.actor)}</span>{' '}
                  ·{' '}
                  <time dateTime={new Date(event.createdAt).toISOString()}>
                    {new Date(event.createdAt).toLocaleString(i18n.language)}
                  </time>
                </p>
                <dl className="flex min-w-0 flex-col gap-1">
                  {(['reason', 'unblockCondition', 'resolution', 'completionNote'] as const).map(
                    (field) =>
                      event[field] && (
                        <div key={field}>
                          <dt className="text-12 font-medium">{label(field)}</dt>
                          <dd className={detailClass}>{event[field]}</dd>
                        </div>
                      ),
                  )}
                </dl>
              </li>
            ))}
          </ol>
        )}
        {view.history.length > 5 && (
          <Button
            variant="secondary"
            className="self-start"
            aria-expanded={expanded}
            onClick={() => setExpanded((value) => !value)}
          >
            {label(expanded ? 'showLess' : 'showAll')}
          </Button>
        )}
      </div>
    </section>
  );
}
