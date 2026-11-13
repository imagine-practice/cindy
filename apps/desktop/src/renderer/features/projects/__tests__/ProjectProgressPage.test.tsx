// @vitest-environment jsdom
/** T1 unit: actual page/container/read service -> controlled preload promises.
 * Gap: isolated read-only views cannot detect cursor stitching, revoked page content or late responses.
 * Minimal failures: p1 late response after p2, old pagination after refresh, revoked latest refresh.
 * No Host/DB/account calls, real waits, module resets or production fixture data.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter, Routes, Route, useParams, useNavigate, useLocation } from 'react-router-dom';
import { ProjectDetailPage } from '../ProjectDetailPage';
import type { ProjectDetail } from '../../../../shared/projects';
import type { ProjectProgressReadResult, ProjectProgressApiHistoryEntry } from '../../../../shared/projectProgressApi';
const h = vi.hoisted(() => ({ route: { projectId: 'p1' }, generation: 1, realRouter: false, providers: vi.fn(),
  detail: vi.fn(), progress: vi.fn(), navigate: vi.fn(), changed: undefined as undefined | (() => void) }));
vi.mock('react-router-dom', async importOriginal => {
  const real = await importOriginal<typeof import('react-router-dom')>();
  const { useState } = await import('react');
  return { ...real,
    useParams: () => h.realRouter ? real.useParams() : h.route,
    useNavigate: () => h.realRouter ? real.useNavigate() : h.navigate,
    useSearchParams: () => {
      const [params, setParams] = useState(new URLSearchParams());
      return h.realRouter ? real.useSearchParams()
        : [params, (next: (p: URLSearchParams) => URLSearchParams) => setParams(next(params))];
    },
  };
});
vi.mock('@/hooks/useProviders', () => ({ useProviders: h.providers }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string,vars?:{model?:string}) =>
  key==='chat.botStartedTasks.open'?`${key}:${(vars as {title?:string})?.title}`:key==='newChat.chatInput.agentSwitch.deferred'?`${key}:${vars?.model}`:key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: 'owner', dataOwnerGeneration: h.generation }), useOptionalDataOwnerGeneration: () => h.generation }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.generation,
  isDataOwnerGenerationCurrent: (value: number) => value === h.generation,
  isDataOwnerPushCurrent: (stamp?:{dataOwnerId:string;ownerGeneration:number}) => stamp===undefined
    || (stamp.dataOwnerId==='owner'&&stamp.ownerGeneration===h.generation) }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [], useBotProfilesStatus: () => 'ready' }));
vi.mock('../projectLabels', async (importOriginal) => ({
  ...await importOriginal<typeof import('../projectLabels')>(),
  useProjectSubjectLabel: () => (subject: { id: string } | null) => subject?.id ?? '',
}));
// 页面里的转交负责人/移除成员要二次确认：这个 provider 在应用树外层，测试里给一个恒定的实现。
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: async () => false }),
  useOptionalConfirmDialog: () => ({ confirm: async () => false }) }));
vi.mock('@/components/ui/select', () => ({ Select: (props: { label: string; value: string; disabled?: boolean;
  options: { value: string; label: string; disabled?: boolean }[]; onValueChange(value: string): void }) =>
  <select aria-label={props.label} value={props.value} disabled={props.disabled} onChange={event => props.onValueChange(event.target.value)}>
    {props.options.map(option => <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}
  </select> }));
vi.mock('../projectService', () => ({ readProjectDetail: h.detail,
  onProjectsChanged: (callback: () => void) => { h.changed = callback; return () => { h.changed = undefined; }; },
  addProjectMember: vi.fn(), removeProjectMember: vi.fn(), renameProject: vi.fn(), setSessionAssignee: vi.fn(), transferProjectOwner: vi.fn(),
}));
const key = (name: string) => `ccAgent.projectCore.progress.${name}`;
function detail(id: string): ProjectDetail {
  return { project: { id, name: `Project ${id}`, goal: `Goal ${id}`, ownerId: 'owner', status: 'active',
    members: [], taskCount: 0, dirs: [], createdAt: '2026-11-05', updatedAt: '2026-11-05' }, workItems: [] };
}
function event(eventId: number, projectId = 'p1'): ProjectProgressApiHistoryEntry {
  return { eventId, projectId, sessionId: 'task-0', bindingRevision: 7, from: null, to: 'blocked',
    actor: { kind: 'account', id: 'owner', displayName: null }, createdAt: 1000 + eventId,
    reason: `event-${eventId}`, unblockCondition: 'condition', resolution: null, completionNote: null };
}
function result(projectId = 'p1', count = 1, history: ProjectProgressApiHistoryEntry[] = []): ProjectProgressReadResult {
  return { projectId, items: Array.from({ length: count }, (_, index) => ({ projectId, sessionId: `task-${index}`,
    title: `${projectId} task ${index}`, sessionStatus: index ? 'active' : 'archived', bindingRevision: 7, progress: null,
    assignee: null })),
    history, capabilities: { canRecord: true, canConfirmDone: false }, historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } };
}
function pending<T>() { let resolve!: (v: T) => void; let reject!: (e: Error) => void;
  const promise = new Promise<T>((yes, no) => { resolve = yes; reject = no; }); return { promise, resolve, reject }; }
async function broadcast() { await act(async () => h.changed?.()); }
beforeEach(() => {
  vi.resetAllMocks(); h.route = { projectId: 'p1' }; h.generation = 1; h.realRouter = false; h.providers.mockReturnValue({ providers: [] });
  h.detail.mockImplementation(async (id: string) => detail(id)); h.progress.mockResolvedValue(result());
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { projectProgress: { read: h.progress } } } });
});
afterEach(cleanup);

// Projects own read-only state; task pages own model/dialogue controls.
// Do not subscribe to model-only patches or load the provider catalogue here.
it('reads execution without loading a model catalogue or model-only subscriptions', async () => {
  const execution = vi.fn(async () => ({ projectId: 'p1', items: [executionEntry()] }));
  const patched = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: {
    projectProgress: { read: h.progress }, projectExecution: { read: execution }, sessionsPush: { onPatched: patched },
  } } });
  render(<ProjectDetailPage />);
  await screen.findByText(key('execution.state.completed'));
  expect(execution).toHaveBeenCalledOnce();
  expect(h.providers).not.toHaveBeenCalled();
  expect(patched).not.toHaveBeenCalled();
  expect(screen.queryByText(key('execution.followup.title'))).toBeNull();
});

function executionEntry(): import('../../../../shared/projectWorkItemExecutionRequest').WorkItemExecutionEntry {
  return {
    sessionId: 'task-0', executor: { botId: 'bot', displayName: 'Bot' }, state: 'completed', canRequest: true,
    unavailableReason: null, requestKey: 'original', requestRound: 0, requestedAt: 1, delegationId: null,
    followup: { busy: false, pending: null, model: { current: 'model-a', providerId: 'p', agentKind: 'codex' },
      actions: { continue: { allowed: true, reason: null }, approve: { allowed: false, reason: 'NO_PENDING_CONFIRMATION' },
        queue: { allowed: false, reason: 'NOT_BUSY' }, model: { allowed: true, reason: null } } },
  };
}

// Real page/container/read service with controlled preload runtime events. Old
// approval-button tests are replaced by read-only attention, preserving scope,
// owner-generation and unmount guards; Main approval/service tests stay intact.
it('refreshes read-only execution and attention while rejecting obsolete runtime events', async () => {
  let entry = { ...executionEntry(), state: 'requested' as const } as ReturnType<typeof executionEntry>;
  const execution = vi.fn(async () => ({ projectId: 'p1', items: [entry] }));
  let inputEvent: ((p: { sessionId: string }) => void) | undefined;
  let interactionEvent: typeof inputEvent;
  let dismissedEvent: typeof inputEvent;
  const unsubscribed = vi.fn();
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: {
    localDb: { projectProgress: { read: h.progress }, projectExecution: { read: execution } },
    maker: { onInputProjection: (fn: typeof inputEvent) => { inputEvent = fn; return unsubscribed; },
      onInteractionRequest: (fn: typeof inputEvent) => { interactionEvent = fn; return unsubscribed; },
      onInteractionDismissed: (fn: typeof inputEvent) => { dismissedEvent = fn; return unsubscribed; } },
  } });
  const page = render(<ProjectDetailPage />);
  await screen.findByText(key('execution.state.requested'));
  const initial = execution.mock.calls.length;
  entry = { ...entry, state: 'running', followup: { ...entry.followup, busy: true,
    pending: { requestId: 'exec', kind: 'permission', summary: 'Allow exec', raisedAt: 2 } } };
  await act(async () => { inputEvent?.({ sessionId: 'task-0' }); interactionEvent?.({ sessionId: 'task-0' }); });
  await screen.findByText('ccAgent.sidebar.status.needsAttention');
  expect(execution.mock.calls.length).toBeGreaterThan(initial);
  expect(screen.queryByRole('button', { name: key('execution.followup.action.approve') })).toBeNull();
  expect(h.progress).toHaveBeenCalledOnce();
  entry = { ...entry, followup: { ...entry.followup, pending: null } };
  await act(async () => dismissedEvent?.({ sessionId: 'task-0' }));
  await screen.findByText(key('execution.state.running'));
  expect(screen.queryByText('ccAgent.sidebar.status.needsAttention')).toBeNull();
  const after = execution.mock.calls.length;
  await act(async () => inputEvent?.({ sessionId: 'other-project-task' }));
  expect(execution).toHaveBeenCalledTimes(after);
  const old = pending<{ projectId: string; items: typeof entry[] }>();
  execution.mockReturnValueOnce(old.promise);
  await act(async () => inputEvent?.({ sessionId: 'task-0' }));
  h.generation++;
  await act(async () => old.resolve({ projectId: 'p1', items: [{ ...entry, state: 'completed' }] }));
  expect(screen.queryByText(key('execution.state.completed'))).toBeNull();
  const afterEpoch = execution.mock.calls.length;
  await act(async () => inputEvent?.({ sessionId: 'task-0' }));
  expect(execution).toHaveBeenCalledTimes(afterEpoch);
  const retained = inputEvent; page.unmount();
  await act(async () => retained?.({ sessionId: 'task-0' }));
  expect(execution).toHaveBeenCalledTimes(afterEpoch);
  expect(unsubscribed).toHaveBeenCalled();
});

// This route probe verifies navigation only, not native task-page capabilities.
// The production project -> native route keeps the same local renderer/bridge;
// no remote device or replacement session is introduced.
function NativeTaskRouteProbe() {
  const { sessionId } = useParams();
  const location = useLocation();
  const navigate = useNavigate();
  return <><output data-testid="native-task-target">{location.pathname}:{sessionId}</output>
    <button onClick={() => navigate(-1)}>Back to project</button></>;
}

it('opens assigned and unassigned original task IDs and preserves project filters on return', async () => {
  h.realRouter = true;
  const progress = result('p1', 3);
  progress.items[0].progress = { sessionId: 'task-0', projectId: 'p1', bindingRevision: 7, revision: 3,
    status: 'todo', reason: null, unblockCondition: null, completionEventId: null,
    updatedBy: { kind: 'account', id: 'owner' }, updatedAt: 1 };
  progress.items[1].assignee = { kind: 'bot', id: 'bot' };
  h.progress.mockResolvedValue(progress);
  const request = vi.fn(), followup = vi.fn(), create = vi.fn();
  const bridge = { localDb: { projectProgress: { read: h.progress },
    projectExecution: { read: async () => ({ projectId: 'p1', items: [] }), request, followup },
    sessions: { create } } };
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: bridge });
  render(<MemoryRouter initialEntries={['/cc-agent/projects/p1?from=qa']}><Routes>
    <Route path="/cc-agent/projects/:projectId" element={<ProjectDetailPage />} />
    <Route path="/cc-agent/:sessionId" element={<NativeTaskRouteProbe />} />
  </Routes></MemoryRouter>);
  fireEvent.click(await screen.findByRole('button', { name: `${key('unknown')} · 2` }));
  expect(screen.getByRole('button', { name: `${key('unknown')} · 2` }).getAttribute('aria-pressed')).toBe('true');
  expect(screen.queryByRole('button', { name: /p1 task 0/ })).toBeNull();
  for (const index of [1, 2]) {
    fireEvent.click(screen.getByRole('button', { name: `chat.botStartedTasks.open:p1 task ${index}` }));
    expect(await screen.findByTestId('native-task-target')).toHaveProperty('textContent', `/cc-agent/task-${index}:task-${index}`);
    expect(window.electronAPI).toBe(bridge);
    fireEvent.click(screen.getByRole('button', { name: 'Back to project' }));
    await screen.findByRole('button', { name: `chat.botStartedTasks.open:p1 task ${index}` });
    expect(screen.getByRole('button', { name: `${key('unknown')} · 2` }).getAttribute('aria-pressed')).toBe('true');
    expect(screen.queryByRole('button', { name: /p1 task 0/ })).toBeNull();
  }
  expect(screen.queryByRole('textbox')).toBeNull();
  expect(request).not.toHaveBeenCalled(); expect(followup).not.toHaveBeenCalled(); expect(create).not.toHaveBeenCalled();
});

it('reads through the actual service, counts 120 full items and deduplicates 101 history entries by cursor', async () => {
  const first = result('p1', 120, Array.from({ length: 100 }, (_, i) => event(101 - i)));
  first.historyPage = { limit: 100, hasMore: true, nextBeforeEventId: 2 };
  const second = { ...first, history: [event(2), event(1), event(2)], historyPage: { limit: 100 as const, hasMore: false, nextBeforeEventId: null } };
  h.progress.mockResolvedValueOnce(first).mockResolvedValueOnce(second);
  render(<ProjectDetailPage />);
  await screen.findByRole('button', { name: new RegExp('unknown.*120') });
  expect(screen.getByRole('button', { name: new RegExp('all.*120') })).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: key('showAll') }));
  fireEvent.click(screen.getByRole('button', { name: key('loadEarlier') }));
  await screen.findByText('event-1');
  expect(screen.getAllByText('event-2')).toHaveLength(1);
  expect(h.progress).toHaveBeenLastCalledWith({ projectId: 'p1', beforeEventId: 2 });
  expect(screen.queryByRole('button', { name: key('loadEarlier') })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'chat.botStartedTasks.open:p1 task 119' }));
  expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-119');
});
it('never stitches a late p1 progress response into the p2 detail', async () => {
  const old = pending<ProjectProgressReadResult>(); h.progress.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('p2'));
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Project p1' });
  h.route = { projectId: 'p2' }; page.rerender(<ProjectDetailPage />);
  await screen.findByRole('button', { name: 'chat.botStartedTasks.open:p2 task 0' });
  await act(async () => old.resolve(result('p1', 1, [event(55)])));
  expect(screen.queryByText('event-55')).toBeNull(); expect(screen.queryByRole('button', { name: 'chat.botStartedTasks.open:p1 task 0' })).toBeNull();
});
it('refresh replaces history and ignores old pagination completed after the latest refresh', async () => {
  const old = pending<ProjectProgressReadResult>(); const first = result('p1', 1, [event(10)]);
  first.historyPage = { limit: 100, hasMore: true, nextBeforeEventId: 10 };
  h.progress.mockResolvedValueOnce(first).mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('p1', 1, [event(20)]));
  render(<ProjectDetailPage />); await screen.findByText('event-10');
  fireEvent.click(screen.getByRole('button', { name: key('loadEarlier') })); await broadcast();
  await screen.findByText('event-20'); await act(async () => old.resolve(result('p1', 1, [event(1)])));
  expect(screen.queryByText('event-10')).toBeNull(); expect(screen.queryByText('event-1')).toBeNull();
});
it('drops an obsolete refresh failure after a newer successful refresh', async () => {
  const old = pending<ProjectProgressReadResult>(); h.progress.mockResolvedValueOnce(result()).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(result('p1', 1, [event(30)]));
  render(<ProjectDetailPage />); await screen.findByRole('button', { name: 'chat.botStartedTasks.open:p1 task 0' }); await broadcast(); await broadcast();
  await screen.findByText('event-30'); await act(async () => old.reject(new Error('obsolete')));
  expect(screen.queryByText(key('error'))).toBeNull();
});
it('clears the entire detail on revoked progress access and ignores the late main detail response', async () => {
  const oldDetail = pending<ProjectDetail>(); h.detail.mockResolvedValueOnce(detail('p1')).mockReturnValueOnce(oldDetail.promise);
  h.progress.mockResolvedValueOnce(result('p1', 1, [event(40)])).mockRejectedValueOnce(new Error('[FORBIDDEN] denied'));
  render(<ProjectDetailPage />); await screen.findByText('event-40'); await broadcast();
  await screen.findByRole('heading', { name: key('forbidden') }); await act(async () => oldDetail.resolve(detail('p1')));
  expect(screen.queryByText('event-40')).toBeNull(); expect(screen.queryByText('Goal p1')).toBeNull();
  expect(screen.queryByRole('heading', { name: 'Project p1' })).toBeNull();
});
it('invalidates pending data on the same-project owner epoch change', async () => {
  const old = pending<ProjectProgressReadResult>(); h.progress.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('p1', 1, [event(60)]));
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Project p1' });
  h.generation++; page.rerender(<ProjectDetailPage />); await screen.findByText('event-60');
  await act(async () => old.resolve(result('p1', 1, [event(50)]))); expect(screen.queryByText('event-50')).toBeNull();
});
it('shows loading/error/retry/empty and rejects a mismatched project envelope', async () => {
  const first = pending<ProjectProgressReadResult>(); h.progress.mockReturnValueOnce(first.promise).mockResolvedValueOnce(result('p2'))
    .mockResolvedValueOnce(result('p1', 0));
  render(<ProjectDetailPage />); await screen.findByText(key('loading'));
  await act(async () => first.reject(new Error('unavailable'))); await screen.findByRole('alert');
  fireEvent.click(screen.getByRole('button', { name: key('retry') })); await screen.findByRole('alert');
  expect(screen.queryByRole('button', { name: 'chat.botStartedTasks.open:p2 task 0' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: key('retry') })); await screen.findByText(key('empty'));
});
it('reloads the first page when a paginated response observes a new binding instead of merging epochs', async () => {
  const first = result('p1', 1, [event(70)]); first.historyPage = { limit: 100, hasMore: true, nextBeforeEventId: 70 };
  const moved = result('p1', 1, [event(1)]); moved.items[0].bindingRevision = 8;
  h.progress.mockResolvedValueOnce(first).mockResolvedValueOnce(moved).mockResolvedValueOnce(result('p1', 1, [event(80)]));
  render(<ProjectDetailPage />); await screen.findByText('event-70');
  fireEvent.click(screen.getByRole('button', { name: key('loadEarlier') })); await screen.findByText('event-80');
  expect(screen.queryByText('event-1')).toBeNull(); expect(h.progress).toHaveBeenLastCalledWith({ projectId: 'p1' });
});

// Independent regression: a pending history page can observe owner transfer with unchanged items.
// Exercise actual page/container/editor/service; capabilities must invalidate both downgrades and promotions.
it.each([['owner to member', true, false], ['member to owner', false, true]] as const)(
  'invalidates the editor and publishes latest %s capability from pending history pagination', async (_direction, previous, latest) => {
    const first = result('p1', 1, [event(70)]);
    first.capabilities = { canRecord: true, canConfirmDone: previous };
    first.historyPage = { limit: 100, hasMore: true, nextBeforeEventId: 70 };
    const second = result('p1', 1, [event(70), event(1), event(1)]);
    second.capabilities = { canRecord: true, canConfirmDone: latest };
    const older = pending<ProjectProgressReadResult>();
    h.progress.mockResolvedValueOnce(first).mockReturnValueOnce(older.promise);
    render(<ProjectDetailPage />); await screen.findByText('event-70');
    fireEvent.click(screen.getByRole('button', { name: key('loadEarlier') }));
    const trigger = () => screen.getByRole('button', { name: 'ccAgent.projectCore.progressEdit.title — p1 task 0' });
    const doneOption = () => within(screen.getByRole('dialog')).queryByRole('option', { name: 'ccAgent.projectCore.progressEdit.status.done' });
    fireEvent.click(trigger()); await screen.findByRole('dialog');
    expect(Boolean(doneOption())).toBe(previous);
    await act(async () => older.resolve(second));
    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getAllByText('event-70')).toHaveLength(1);
    expect(screen.getAllByText('event-1')).toHaveLength(1);
    expect(h.progress).toHaveBeenLastCalledWith({ projectId: 'p1', beforeEventId: 70 });
    fireEvent.click(trigger()); await screen.findByRole('dialog');
    expect(Boolean(doneOption())).toBe(latest);
  },
);
