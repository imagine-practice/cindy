import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProjectProgressReadResult } from '../../../../shared/projectProgressApi';
import { ProjectProgressView, type ProjectProgressState } from './ProjectProgressView';
import { WorkItemProgressDialog, type WorkItemProgressSnapshot } from './WorkItemProgressDialog';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../../shared/workItemProgress';
import type {
  WorkItemExecutionEntry,
  WorkItemFollowupAction,
  ProjectWorkItemFollowupIntent,
  ProjectWorkItemFollowupResult,
} from '../../../../shared/projectWorkItemExecutionRequest';
import { useProviders } from '@/hooks/useProviders';
import {
  readProjectProgress,
  readProjectWorkItemExecution,
  requestProjectWorkItemExecution,
  requestProjectWorkItemFollowup,
  updateProjectProgress,
} from './projectProgressService';

function assertProject(result: ProjectProgressReadResult, projectId: string): void {
  if (result.projectId !== projectId || result.items.some(item => item.projectId !== projectId)
    || result.history.some(event => event.projectId !== projectId)) throw new Error('INVALID_PROGRESS_SCOPE');
}

/** 投递结果 → 界面文案叶子。代码名不当作文案，i18n 只消费这里的固定枚举。 */
function noticeKey(code: unknown): 'requested' | 'alreadyRequested' | 'unknown' | 'dispatchFailed'
  | 'hostNotReady' | 'unavailable' | 'generic' {
  switch (code) {
    case 'OUTCOME_UNKNOWN': return 'unknown';
    case 'DISPATCH_FAILED': return 'dispatchFailed';
    case 'HOST_NOT_READY': return 'hostNotReady';
    case 'UNASSIGNED':
    case 'ASSIGNEE_NOT_BOT':
    case 'EXECUTOR_INACTIVE':
    case 'EXECUTOR_NOT_MEMBER':
    case 'PROJECT_ARCHIVED':
      return 'unavailable';
    default: return 'generic';
  }
}

type FollowupNotice = { sessionId: string; key: string; vars?: Record<string, string | number> };

/** 后续动作回执 → 界面文案叶子。main 的真实原因（换模型失败等）作为插值展示。 */
export function followupNoticeKey(
  result: ProjectWorkItemFollowupResult,
): Omit<FollowupNotice, 'sessionId'> {
  if (!result.ok) {
    switch (result.code) {
      case 'FOLLOWUP_UNAVAILABLE': return { key: 'unavailable' };
      case 'CONFIRMATION_STALE': return { key: 'confirmationStale' };
      case 'MODEL_CHANGE_FAILED': return { key: 'modelFailed', vars: { detail: result.message } };
      case 'IDEMPOTENCY_CONFLICT': return { key: 'idempotencyConflict' };
      case 'HOST_NOT_READY': return { key: 'hostNotReady' };
      case 'DISPATCH_FAILED': return { key: 'dispatchFailed' };
      default: return { key: 'generic' };
    }
  }
  if (result.action === 'approve') return { key: 'approved' };
  if (result.action === 'model')
    return { key: result.model?.status === 'deferred' ? 'modelDeferred' : 'modelChanged' };
  if (result.wakeKind === 'queued')
    return result.queuedPosition === null
      ? { key: 'queuedUnknownPosition' }
      : { key: 'queued', vars: { position: result.queuedPosition } };
  return { key: result.replayed ? 'alreadySent' : 'continued' };
}

export function ProjectProgressSection({ projectId, refreshKey, onAccessLost, onOpenWorkItem }: {
  projectId: string; refreshKey: number; onAccessLost: () => void; onOpenWorkItem: (id: string) => void;
}) {
  const { t } = useTranslation();
  // 换模型候选来自宿主模型目录（本机已连接、未停用的来源）。
  const { providers } = useProviders();
  const [editor, setEditor] = useState<WorkItemProgressSnapshot | null>(null);
  const editorRef = useRef<WorkItemProgressSnapshot | null>(null);
  const selectEditor = (value: WorkItemProgressSnapshot | null) => { editorRef.current = value; setEditor(value); };
  const [execution, setExecution] = useState<Record<string, WorkItemExecutionEntry>>({});
  const [executionUnavailable, setExecutionUnavailable] = useState(false);
  const [executionBusySessionId, setExecutionBusySessionId] = useState<string | null>(null);
  const [executionNotice, setExecutionNotice] = useState<{ sessionId: string; key: string } | null>(null);
  const [followupBusy, setFollowupBusy] = useState<{ sessionId: string; action: WorkItemFollowupAction } | null>(null);
  const followupBusyRef = useRef(false);
  const [followupNotice, setFollowupNotice] = useState<FollowupNotice | null>(null);
  const [state, setState] = useState<ProjectProgressState>({ status: 'loading' });
  const [page, setPage] = useState<ProjectProgressReadResult['historyPage'] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const owner = useRef(getDataOwnerGeneration());
  const mounted = useRef(false);
  const sequence = useRef(0);
  const current = useRef<ProjectProgressReadResult | null>(null);
  const paging = useRef(false);
  const valid = useCallback((ticket: number) => mounted.current && sequence.current === ticket
    && isDataOwnerGenerationCurrent(owner.current), []);
  const publish = (result: ProjectProgressReadResult) => {
    const selected = editorRef.current;
    if (selected) {
      const item = result.items.find(value => value.sessionId === selected.sessionId);
      if (!item || item.bindingRevision !== selected.bindingRevision
        || (item.progress?.revision ?? 0) !== selected.progressRevision
        || result.capabilities.canRecord !== selected.canRecord
        || result.capabilities.canConfirmDone !== selected.canConfirmDone) selectEditor(null);
    }
    current.current = result; setPage(result.historyPage);
    setState({ status: 'ready', projectId, items: result.items, history: result.history });
  };
  const fail = (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    current.current = null; setPage(null); setMoreError(false); selectEditor(null);
    if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') {
      setState({ status: 'forbidden' }); onAccessLost();
    } else setState({ status: 'error' });
  };
  // The callbacks deliberately close over this mounted project scope only.
  const loadRef = useRef<() => Promise<void>>(async () => {});
  loadRef.current = async () => {
    const ticket = ++sequence.current;
    paging.current = false; current.current = null; setPage(null); setState({ status: 'loading' });
    setLoadingMore(false); setMoreError(false);
    // Execution state is always re-read from main; nothing here is cached across loads.
    const executionRead = readProjectWorkItemExecution({ projectId }).then(
      value => ({ ok: true as const, value }),
      error => ({ ok: false as const, error }),
    );
    try {
      const result = await readProjectProgress({ projectId });
      if (!valid(ticket)) return;
      assertProject(result, projectId); publish(result);
    } catch (error) { if (valid(ticket)) fail(error); }
    const projection = await executionRead;
    if (!valid(ticket)) return;
    if (!projection.ok || projection.value.projectId !== projectId) {
      // The entry itself is missing; keep progress visible and say so instead of guessing.
      setExecution({}); setExecutionUnavailable(true);
      return;
    }
    const next: Record<string, WorkItemExecutionEntry> = {};
    for (const entry of projection.value.items) next[entry.sessionId] = entry;
    setExecution(next); setExecutionUnavailable(false);
  };
  useEffect(() => {
    mounted.current = true; void loadRef.current();
    return () => { mounted.current = false; sequence.current += 1; };
  }, [projectId, refreshKey]);
  const more = async () => {
    const base = current.current;
    if (!base || paging.current || !base.historyPage.hasMore || base.historyPage.nextBeforeEventId === null) return;
    const ticket = sequence.current; paging.current = true; setLoadingMore(true); setMoreError(false);
    try {
      const result = await readProjectProgress({ projectId, beforeEventId: base.historyPage.nextBeforeEventId });
      if (!valid(ticket) || current.current !== base) return;
      assertProject(result, projectId);
      if (JSON.stringify(base.items) !== JSON.stringify(result.items)) {
        await loadRef.current(); return; // Never mix a new binding/current-progress snapshot into an old page.
      }
      const unique = new Map(base.history.map(event => [event.eventId, event]));
      for (const event of result.history) if (!unique.has(event.eventId)) unique.set(event.eventId, event);
      publish({ ...base, capabilities: result.capabilities, history: [...unique.values()].sort((a, b) => b.eventId - a.eventId), historyPage: result.historyPage });
    } catch (error) {
      if (!valid(ticket)) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') fail(error); else setMoreError(true);
    } finally {
      if (valid(ticket)) { paging.current = false; setLoadingMore(false); }
    }
  };
  const openEditor = (sessionId: string) => {
    const data = current.current;
    const item = data?.items.find(value => value.sessionId === sessionId);
    if (!data || !item || !data.capabilities.canRecord) return;
    if (!Number.isSafeInteger(item.bindingRevision) || item.bindingRevision < 0
      || (item.progress && (!Number.isSafeInteger(item.progress.revision) || item.progress.revision < 0))) {
      fail(new Error('INVALID_PROGRESS_SNAPSHOT')); return;
    }
    selectEditor({ projectId, sessionId, title: item.title, bindingRevision: item.bindingRevision,
      progressRevision: item.progress === null ? 0 : item.progress.revision,
      status: item.progress?.status ?? null, reason: item.progress?.reason, unblockCondition: item.progress?.unblockCondition,
      canRecord: data.capabilities.canRecord, canConfirmDone: data.capabilities.canConfirmDone });
  };
  const submit = async (intent: WorkItemProgressIntent) => {
    let result: WorkItemProgressResult;
    try { result = await updateProjectProgress(intent); }
    catch (error) {
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (mounted.current && isDataOwnerGenerationCurrent(owner.current)
        && (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER')) fail(error);
      throw error;
    }
    // Closing the dialog does not cancel persistence. Refresh a still-current page after its receipt.
    if (mounted.current && isDataOwnerGenerationCurrent(owner.current) && !editorRef.current) void loadRef.current();
    return result;
  };
  const requestExecution = async (sessionId: string) => {
    if (executionBusySessionId) return;
    setExecutionBusySessionId(sessionId); setExecutionNotice(null);
    const ticket = sequence.current;
    try {
      const result = await requestProjectWorkItemExecution({ projectId, sessionId });
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
      setExecutionNotice({
        sessionId,
        key: result.ok ? (result.replayed ? 'alreadyRequested' : 'requested') : noticeKey(result.code),
      });
      // Read the real state again instead of trusting the reply (or any local cache).
      if (ticket === sequence.current) await loadRef.current();
    } catch (error) {
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') { fail(error); return; }
      setExecutionNotice({ sessionId, key: noticeKey(code) });
    } finally {
      if (mounted.current) setExecutionBusySessionId(null);
    }
  };
  const modelChoices = useMemo(() => {
    const byAgent: Record<string, { model: string; providerId: string | null; label: string }[]> = {};
    for (const agentKind of ['claude-code', 'codex', 'pi'] as const) {
      const seen = new Set<string>();
      const list: { model: string; providerId: string | null; label: string }[] = [];
      for (const provider of providers) {
        if (!provider.connected || provider.suspended) continue;
        if (!provider.agents?.includes(agentKind)) continue;
        for (const model of provider.models?.[agentKind] ?? []) {
          if (model.disabled) continue;
          const key = `${provider.id}::${model.id}`;
          if (seen.has(key)) continue;
          seen.add(key);
          list.push({
            model: model.id,
            providerId: provider.id,
            label: `${model.name ?? model.id} · ${provider.name}`,
          });
        }
      }
      byAgent[agentKind] = list;
    }
    return byAgent;
  }, [providers]);

  const followup = async (
    sessionId: string,
    action: WorkItemFollowupAction,
    payload?: { text?: string; model?: string; providerId?: string | null },
  ) => {
    // 同一个动作连点只走一次：在飞期间直接忽略，main 侧还有同键去重兜底。
    if (followupBusyRef.current) return;
    followupBusyRef.current = true;
    setFollowupBusy({ sessionId, action });
    setFollowupNotice(null);
    try {
      const intent: ProjectWorkItemFollowupIntent = action === 'model'
        ? { projectId, sessionId, action, model: payload?.model ?? '', providerId: payload?.providerId ?? null }
        : action === 'approve'
          ? { projectId, sessionId, action }
          : { projectId, sessionId, action, ...(payload?.text ? { text: payload.text } : {}) };
      const result = await requestProjectWorkItemFollowup(intent);
      if (!valid(sequence.current)) return;
      setFollowupNotice({ sessionId, ...followupNoticeKey(result) });
      // 状态、可用性与待确认项一律重新读；界面不保留「已批准 / 已完成」的印象。
      await loadRef.current();
    } catch (error) {
      if (!valid(sequence.current)) return;
      const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
      if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') { fail(error); return; }
      setFollowupNotice({ sessionId, key: 'generic' });
    } finally {
      followupBusyRef.current = false;
      if (mounted.current) setFollowupBusy(null);
    }
  };

  return <div className="flex min-w-0 flex-col gap-3">
    <ProjectProgressView projectId={projectId} state={state} onOpenWorkItem={onOpenWorkItem}
      onRefresh={() => void loadRef.current()}
      execution={execution} executionUnavailable={executionUnavailable}
      executionBusySessionId={executionBusySessionId} executionNotice={executionNotice}
      followupBusy={followupBusy} followupNotice={followupNotice} modelChoices={modelChoices}
      onRequestExecution={id => void requestExecution(id)}
      onFollowup={(id, action, payload) => void followup(id, action, payload)}
      onEditWorkItem={state.status === 'ready' && current.current?.capabilities.canRecord ? openEditor : undefined} />
    {state.status === 'ready' && page?.hasMore && <div className="flex min-w-0 flex-col items-start gap-2">
      {moreError && <p role="alert" className="text-13 text-[var(--danger-text)]">{t('ccAgent.projectCore.progress.earlierFailed')}</p>}
      <Button variant="secondary" className="whitespace-normal" disabled={loadingMore} onClick={() => void more()}>
        {t(`ccAgent.projectCore.progress.${loadingMore ? 'loadingEarlier' : 'loadEarlier'}`)}
      </Button>
    </div>}
    {editor && <WorkItemProgressDialog open snapshot={editor} onOpenChange={open => { if (!open) selectEditor(null); }}
      onSubmit={submit} onSaved={() => {}} onRefresh={() => { selectEditor(null); void loadRef.current(); }} />}
  </div>;
}
