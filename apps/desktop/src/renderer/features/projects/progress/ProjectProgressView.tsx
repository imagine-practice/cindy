import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/input';
import { WORK_ITEM_STATUSES, type WorkItemStatus } from '../../../../shared/workItemStatus';
import type {
  WorkItemExecutionEntry,
  WorkItemFollowupAction,
  WorkItemFollowupProjection,
} from '../../../../shared/projectWorkItemExecutionRequest';
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

export interface ProjectProgressViewProps {
  projectId: string;
  state: ProjectProgressState;
  onOpenWorkItem: (sessionId: string) => void;
  onRefresh: () => void;
  onEditWorkItem?: (sessionId: string) => void;
  /** Keyed by sessionId; absent = entry stays hidden (never guessed from progress data). */
  execution?: Readonly<Record<string, WorkItemExecutionEntry>>;
  executionUnavailable?: boolean;
  executionBusySessionId?: string | null;
  /** Localized outcome key of the last delivery attempt, e.g. 'requested' | 'alreadyRequested'. */
  executionNotice?: { sessionId: string; key: string } | null;
  onRequestExecution?: (sessionId: string) => void;
  /** 后续动作的在飞状态（每个会话同时只允许一个动作在飞）。 */
  followupBusy?: { sessionId: string; action: WorkItemFollowupAction } | null;
  followupNotice?: { sessionId: string; key: string; vars?: Record<string, string | number> } | null;
  /** 后续动作意图；payload 只带用户自己填的内容，执行者/键/模型合法性都由 main 判定。 */
  onFollowup?: (
    sessionId: string,
    action: WorkItemFollowupAction,
    payload?: { text?: string; model?: string; providerId?: string | null },
  ) => void;
  /** 换模型候选（来自宿主模型目录），按执行会话的引擎分组。 */
  modelChoices?: Readonly<
    Record<string, readonly { model: string; providerId: string | null; label: string }[]>
  >;
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
  state,
  onOpenWorkItem,
  onRefresh,
  onEditWorkItem,
  execution,
  executionUnavailable,
  executionBusySessionId,
  executionNotice,
  onRequestExecution,
  followupBusy,
  followupNotice,
  onFollowup,
  modelChoices,
}: ProjectProgressViewProps) {
  const { t, i18n } = useTranslation();
  const label = (key: string) => t(`${PREFIX}.${key}`);
  const [filter, setFilter] = useState<'all' | 'unknown' | WorkItemStatus>('all');
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
            onClick={() => setFilter(status)}
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
              // Disabled entry must always say why; the reason comes from main's projection.
              const executionHint = !executionEntry
                ? null
                : executionEntry.unavailableReason
                  ? t(`${PREFIX}.execution.unavailable.${executionEntry.unavailableReason}`)
                  : executionEntry.state === 'unknown'
                    ? t(`${PREFIX}.execution.hint.unknown`)
                    : executionEntry.state === 'requested'
                      ? t(`${PREFIX}.execution.hint.requested`)
                      : null;
              return (
              <li key={item.sessionId} className="flex min-w-0 flex-col gap-2 py-3">
                <div className="flex min-w-0 flex-wrap items-center justify-between gap-2">
                  <Button
                    variant="secondary"
                    tone="quiet"
                    className="min-w-0 max-w-full justify-start text-left"
                    onClick={() => onOpenWorkItem(item.sessionId)}
                  >
                    <span className="whitespace-normal break-words [overflow-wrap:anywhere]">
                      {item.title || label('untitled')}
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
                  <div className="flex min-w-0 flex-col gap-2 pl-3">
                    <p className="text-12 text-[var(--text-secondary)]">
                      {label(`execution.state.${executionEntry.state}`)}
                    </p>
                    {executionEntry.executor && (
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Button
                          variant="secondary"
                          className="whitespace-normal"
                          disabled={
                            !executionEntry.canRequest ||
                            !onRequestExecution ||
                            executionBusySessionId === item.sessionId
                          }
                          onClick={() => onRequestExecution?.(item.sessionId)}
                        >
                          {t(`${PREFIX}.execution.action`, {
                            name: executionEntry.executor.displayName,
                          })}
                        </Button>
                      </div>
                    )}
                    {!executionEntry.executor && (
                      // 没有可执行的处理人时不给可点控件，也不编造一个执行者名字。
                      <div className="flex min-w-0 flex-wrap items-center gap-2">
                        <Button variant="secondary" className="whitespace-normal" disabled>
                          {t(`${PREFIX}.execution.actionUnnamed`)}
                        </Button>
                      </div>
                    )}
                    {executionHint && (
                      <p className="text-12 text-[var(--text-secondary)]">{executionHint}</p>
                    )}
                    {executionNotice?.sessionId === item.sessionId && (
                      <p role="status" className="text-12 text-[var(--text-secondary)]">
                        {t(`${PREFIX}.execution.notice.${executionNotice.key}`)}
                      </p>
                    )}
                    {/* 没有可执行处理人时，后续动作（继续/批准/排队/换模型）全都做不了：
                        只留上面那句「先指定处理人」，不再摆一排永远不可用的按钮。 */}
                    {executionEntry.executor && (
                      <FollowupControls
                        sessionId={item.sessionId}
                        entry={executionEntry}
                        busy={followupBusy?.sessionId === item.sessionId ? followupBusy.action : null}
                        notice={followupNotice?.sessionId === item.sessionId ? followupNotice : null}
                        onFollowup={onFollowup}
                        modelChoices={modelChoices}
                      />
                    )}
                  </div>
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
                  <span>{event.actor.displayName?.trim() || label('unknownActor')}</span>{' '}
                  <span>
                    {event.actor.kind}:{event.actor.id}
                  </span>{' '}
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

const FOLLOWUP_ORDER: readonly WorkItemFollowupAction[] = ['continue', 'approve', 'queue', 'model'];

/**
 * 执行后续的四个动作。
 *
 * 可用性、待确认项与模型全部来自 main 的现读投影；这里不推断、不缓存，
 * 也不乐观地把按钮翻成「已完成 / 已批准」：动作返回后由外层重新读一次。
 */
function FollowupControls({
  sessionId,
  entry,
  busy,
  notice,
  onFollowup,
  modelChoices,
}: {
  sessionId: string;
  entry: WorkItemExecutionEntry;
  busy: WorkItemFollowupAction | null;
  notice: { sessionId: string; key: string; vars?: Record<string, string | number> } | null;
  onFollowup?: ProjectProgressViewProps['onFollowup'];
  modelChoices?: ProjectProgressViewProps['modelChoices'];
}) {
  const { t } = useTranslation();
  const label = (key: string, vars?: Record<string, unknown>) =>
    t(`${PREFIX}.execution.followup.${key}`, vars);
  const projection: WorkItemFollowupProjection = entry.followup;
  const [draft, setDraft] = useState<'continue' | 'model' | null>(null);
  const [instruction, setInstruction] = useState('');
  const [choice, setChoice] = useState('');
  // 同一个会话同时只允许一个后续动作在飞；避免连点产生第二个回合。
  const blocked = busy !== null || !onFollowup;
  const allowed = (action: WorkItemFollowupAction) => projection.actions[action].allowed && !blocked;
  const reasons = [...new Set(FOLLOWUP_ORDER.map((action) => projection.actions[action].reason).filter(
    (reason): reason is NonNullable<typeof reason> => reason !== null,
  ))];
  const options = projection.model ? (modelChoices?.[projection.model.agentKind] ?? []) : [];
  const selected = choice || (projection.model ? `${projection.model.providerId ?? ''}::${projection.model.current}` : '');
  const send = (action: WorkItemFollowupAction, payload?: Parameters<NonNullable<ProjectProgressViewProps['onFollowup']>>[2]) => {
    if (blocked) return;
    setDraft(null);
    onFollowup?.(sessionId, action, payload);
  };
  return (
    // 只是一条分隔线与一组控件：不额外套卡片（避免卡片套卡片），圆角只由控件自己承担。
    <div className="flex min-w-0 flex-col gap-2 border-t border-[var(--border-default)] pt-2">
      <p className="text-12 font-medium text-[var(--text-secondary)]">{label('title')}</p>
      {projection.pending && (
        <p className="whitespace-pre-wrap break-words text-12 text-[var(--text-primary)]">
          {label('pending', { summary: projection.pending.summary })}
        </p>
      )}
      {projection.model && (
        <p className="break-words text-12 text-[var(--text-secondary)]">
          {label('currentModel', { model: projection.model.current })}
        </p>
      )}
      <div className="flex min-w-0 flex-wrap gap-2">
        <Button
          variant="secondary"
          className="whitespace-normal"
          disabled={!allowed('continue')}
          aria-pressed={draft === 'continue'}
          onClick={() => setDraft(draft === 'continue' ? null : 'continue')}
        >
          {label(busy === 'continue' ? 'inFlight' : 'action.continue')}
        </Button>
        <Button
          variant="secondary"
          className="whitespace-normal"
          disabled={!allowed('approve')}
          onClick={() => send('approve')}
        >
          {label(busy === 'approve' ? 'inFlight' : 'action.approve')}
        </Button>
        <Button
          variant="secondary"
          className="whitespace-normal"
          disabled={!allowed('queue')}
          onClick={() => send('queue')}
        >
          {label(busy === 'queue' ? 'inFlight' : 'action.queue')}
        </Button>
        <Button
          variant="secondary"
          className="whitespace-normal"
          disabled={!allowed('model') || options.length === 0}
          aria-pressed={draft === 'model'}
          onClick={() => setDraft(draft === 'model' ? null : 'model')}
        >
          {label(busy === 'model' ? 'inFlight' : 'action.model')}
        </Button>
      </div>
      {projection.actions.model.allowed && options.length === 0 && (
        <p className="text-12 text-[var(--text-secondary)]">{label('modelChoicesUnavailable')}</p>
      )}
      {draft === 'continue' && (
        <div className="flex min-w-0 flex-col gap-2">
          <label className="text-12 text-[var(--text-secondary)]" htmlFor={`followup-text-${sessionId}`}>
            {label('instruction')}
          </label>
          <Textarea
            id={`followup-text-${sessionId}`}
            value={instruction}
            rows={3}
            maxLength={4000}
            placeholder={label('instructionPlaceholder')}
            onChange={(value) => setInstruction(value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="whitespace-normal"
              disabled={busy !== null || !onFollowup}
              onClick={() => send('continue', instruction.trim() ? { text: instruction.trim() } : undefined)}
            >
              {label('send')}
            </Button>
            <Button variant="secondary" className="whitespace-normal" onClick={() => setDraft(null)}>
              {label('cancel')}
            </Button>
          </div>
        </div>
      )}
      {draft === 'model' && (
        <div className="flex min-w-0 flex-col gap-2">
          <Select
            label={label('chooseModel')}
            value={selected}
            disabled={busy !== null}
            options={options.map((option) => ({
              value: `${option.providerId ?? ''}::${option.model}`,
              label: option.label,
            }))}
            onValueChange={(value) => setChoice(value)}
          />
          <div className="flex flex-wrap gap-2">
            <Button
              variant="primary"
              className="whitespace-normal"
              disabled={busy !== null || !selected || selected === `${projection.model?.providerId ?? ''}::${projection.model?.current ?? ''}`}
              onClick={() => {
                const option = options.find((value) => `${value.providerId ?? ''}::${value.model}` === selected);
                if (!option) return;
                send('model', { model: option.model, providerId: option.providerId });
              }}
            >
              {label('applyModel')}
            </Button>
            <Button variant="secondary" className="whitespace-normal" onClick={() => setDraft(null)}>
              {label('cancel')}
            </Button>
          </div>
        </div>
      )}
      {reasons.map((reason) => (
        <p key={reason} className="text-12 text-[var(--text-secondary)]">
          {label(`reason.${reason}`)}
        </p>
      ))}
      {notice && (
        <p role="status" className="break-words text-12 text-[var(--text-secondary)]">
          {label(`notice.${notice.key}`, notice.vars)}
        </p>
      )}
    </div>
  );
}
