import type { ProjectMember } from '../../../../shared/projects';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProjectProgressReadResult } from '../../../../shared/projectProgressApi';
import { ProjectProgressView, type ProjectProgressState, type ProjectProgressFilter } from './ProjectProgressView';
import { WorkItemProgressDialog, type WorkItemProgressSnapshot } from './WorkItemProgressDialog';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../../shared/workItemProgress';
import type { WorkItemExecutionEntry } from '../../../../shared/projectWorkItemExecutionRequest';
import { WORK_ITEM_STATUSES } from '../../../../shared/workItemStatus';
import { useSearchParams } from 'react-router-dom';
import {
  readProjectProgress,
  readProjectWorkItemExecution,
  updateProjectProgress,
} from './projectProgressService';

function assertProject(result: ProjectProgressReadResult, projectId: string): void {
  if (result.projectId !== projectId || result.items.some(item => item.projectId !== projectId)
    || result.history.some(event => event.projectId !== projectId)) throw new Error('INVALID_PROGRESS_SCOPE');
}

export function ProjectProgressSection({ projectId, refreshKey, onAccessLost, onOpenWorkItem, onStateChange, members = [] }: {
  projectId: string; refreshKey: number; onAccessLost: () => void; onOpenWorkItem: (id: string) => void;
  onStateChange?: (state: ProjectProgressState) => void;
  /** Project members: resolve history actors' names offline (Main sends kind/id only). */
  members?: readonly ProjectMember[];
}) {
  const { t } = useTranslation();
  const [searchParams, setSearchParams] = useSearchParams();
  const requestedFilter = searchParams.get('progress');
  const filter: ProjectProgressFilter = requestedFilter === 'unknown'
    || WORK_ITEM_STATUSES.some(status => status === requestedFilter)
    ? requestedFilter as ProjectProgressFilter : 'all';
  const changeFilter = (next: ProjectProgressFilter) => {
    setSearchParams(previous => {
      const params = new URLSearchParams(previous);
      if (next === 'all') params.delete('progress'); else params.set('progress', next);
      return params;
    }, { replace: true });
  };
  const [editor, setEditor] = useState<WorkItemProgressSnapshot | null>(null);
  const editorRef = useRef<WorkItemProgressSnapshot | null>(null);
  const selectEditor = (value: WorkItemProgressSnapshot | null) => { editorRef.current = value; setEditor(value); };
  const [execution, setExecution] = useState<Record<string, WorkItemExecutionEntry>>({});
  const [executionUnavailable, setExecutionUnavailable] = useState(false);
  const [state, setState] = useState<ProjectProgressState>({ status: 'loading' });
  useEffect(() => { onStateChange?.(state); }, [state, onStateChange]);
  const [page, setPage] = useState<ProjectProgressReadResult['historyPage'] | null>(null);
  const [loadingMore, setLoadingMore] = useState(false);
  const [moreError, setMoreError] = useState(false);
  const owner = useRef(getDataOwnerGeneration());
  const mounted = useRef(false);
  const sequence = useRef(0);
  const current = useRef<ProjectProgressReadResult | null>(null);
  const paging = useRef(false);
  const executionSequence = useRef(0);
  const pendingRuntimeRefresh = useRef(false);
  const scheduleRuntimeRefresh = useRef<(() => void) | undefined>(undefined);
  const loadExecutionRef = useRef<() => Promise<void>>(async () => {});
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
    if (pendingRuntimeRefresh.current) scheduleRuntimeRefresh.current?.();
  };
  const fail = (error: unknown) => {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    current.current = null; setPage(null); setMoreError(false); selectEditor(null);
    if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') {
      setState({ status: 'forbidden' }); onAccessLost();
    } else setState({ status: 'error' });
  };
  // The callbacks deliberately close over this mounted project scope only.
  loadExecutionRef.current = async () => {
    const ticket=++executionSequence.current;
    try {
      const value=await readProjectWorkItemExecution({projectId});
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current) || ticket!==executionSequence.current) return;
      if (value.projectId!==projectId) throw new Error('INVALID_PROJECT_SCOPE');
      const next:Record<string,WorkItemExecutionEntry>={};
      for (const entry of value.items) next[entry.sessionId]=entry;
      setExecution(next);setExecutionUnavailable(false);

    } catch {
      if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current) || ticket!==executionSequence.current) return;
      setExecution({});setExecutionUnavailable(true);
    }
  };
  const loadRef = useRef<() => Promise<void>>(async () => {});
  loadRef.current = async () => {
    const ticket = ++sequence.current;
    paging.current = false; current.current = null; setPage(null); setState({ status: 'loading' });
    setLoadingMore(false); setMoreError(false);
    // Execution state is always re-read from main; nothing here is cached across loads.
    const executionRead = loadExecutionRef.current();
    try {
      const result = await readProjectProgress({ projectId });
      if (!valid(ticket)) return;
      assertProject(result, projectId); publish(result);
    } catch (error) { if (valid(ticket)) fail(error); }
    await executionRead;
  };
  useEffect(() => {
    mounted.current = true; void loadRef.current();
    return () => { mounted.current = false; sequence.current += 1; executionSequence.current += 1; };
  }, [projectId, refreshKey]);
  useEffect(() => {
    let closed=false, scheduled=false;
    const currentScope=()=>!closed && mounted.current && isDataOwnerGenerationCurrent(owner.current);
    const schedule=()=>{
      if (scheduled || !currentScope()) return;
      scheduled=true;
      queueMicrotask(()=>{
        scheduled=false;
        if (!currentScope()) return;
        pendingRuntimeRefresh.current=false;
        void loadExecutionRef.current();
      });
    };
    scheduleRuntimeRefresh.current=schedule;
    const changed=(raw:unknown)=>{
      if (!currentScope() || !raw || typeof raw!=='object' || !('sessionId' in raw) || typeof raw.sessionId!=='string') return;
      if (!current.current) { pendingRuntimeRefresh.current=true;return; }
      if (current.current.items.some(item=>item.sessionId===raw.sessionId)) schedule();
    };
    const maker=window.electronAPI?.maker;
    const unsubscribes=[maker?.onInputProjection?.(changed),maker?.onStatusChanged?.(changed),
      maker?.onInteractionRequest?.(changed),maker?.onInteractionDismissed?.(changed)];
    return ()=>{closed=true;pendingRuntimeRefresh.current=false;scheduleRuntimeRefresh.current=undefined;
      for (const unsubscribe of unsubscribes) unsubscribe?.();};
  }, [projectId]);
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
  return <div className="flex min-w-0 flex-col gap-3">
    <ProjectProgressView projectId={projectId} members={members} state={state} onOpenWorkItem={onOpenWorkItem}
      onRefresh={() => void loadRef.current()}
      execution={execution} executionUnavailable={executionUnavailable}
      filter={filter} onFilterChange={changeFilter}
      onEditWorkItem={state.status === 'ready' && current.current?.capabilities.canRecord ? openEditor : undefined} />
    {state.status === 'ready' && page?.hasMore && <div className="flex min-w-0 flex-col items-start gap-2">
      {moreError && <p role="alert" className="text-13 text-[var(--text-danger)]">{t('ccAgent.projectCore.progress.earlierFailed')}</p>}
      <Button variant="secondary" className="whitespace-normal" disabled={loadingMore} onClick={() => void more()}>
        {t(`ccAgent.projectCore.progress.${loadingMore ? 'loadingEarlier' : 'loadEarlier'}`)}
      </Button>
    </div>}
    {editor && <WorkItemProgressDialog open snapshot={editor} onOpenChange={open => { if (!open) selectEditor(null); }}
      onSubmit={submit} onSaved={() => {}} onRefresh={() => { selectEditor(null); void loadRef.current(); }} />}
  </div>;
}
