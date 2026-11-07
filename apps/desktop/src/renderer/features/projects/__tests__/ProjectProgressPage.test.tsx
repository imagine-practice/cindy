// @vitest-environment jsdom
/** T1 unit: actual page/container/read service -> controlled preload promises.
 * Gap: isolated read-only views cannot detect cursor stitching, revoked page content or late responses.
 * Minimal failures: p1 late response after p2, old pagination after refresh, revoked latest refresh.
 * No Host/DB/account calls, real waits, module resets or production fixture data.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { beforeEach, afterEach, expect, it, vi } from 'vitest';
import { ProjectDetailPage } from '../ProjectDetailPage';
import type { ProjectDetail } from '../../../../shared/projects';
import type { ProjectProgressReadResult, ProjectProgressApiHistoryEntry } from '../../../../shared/projectProgressApi';
const h = vi.hoisted(() => ({ route: { projectId: 'p1' }, generation: 1,
  detail: vi.fn(), progress: vi.fn(), navigate: vi.fn(), changed: undefined as undefined | (() => void) }));
vi.mock('react-router-dom', () => ({ useParams: () => h.route, useNavigate: () => h.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'en' } }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: 'owner', dataOwnerGeneration: h.generation }), useOptionalDataOwnerGeneration: () => h.generation }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => h.generation,
  isDataOwnerGenerationCurrent: (value: number) => value === h.generation }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../projectLabels', () => ({ useProjectSubjectLabel: () => (value: { id: string }) => value.id, projectSubjectAvatar: () => 'X' }));
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
    members: [], taskCount: 0, createdAt: '2026-11-05', updatedAt: '2026-11-05' }, workItems: [] };
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
  vi.clearAllMocks(); h.route = { projectId: 'p1' }; h.generation = 1;
  h.detail.mockImplementation(async (id: string) => detail(id)); h.progress.mockResolvedValue(result());
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { projectProgress: { read: h.progress } } } });
});
afterEach(cleanup);

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
  fireEvent.click(screen.getByRole('button', { name: 'p1 task 119' }));
  expect(h.navigate).toHaveBeenCalledWith('/cc-agent/task-119');
});
it('never stitches a late p1 progress response into the p2 detail', async () => {
  const old = pending<ProjectProgressReadResult>(); h.progress.mockReturnValueOnce(old.promise).mockResolvedValueOnce(result('p2'));
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Project p1' });
  h.route = { projectId: 'p2' }; page.rerender(<ProjectDetailPage />);
  await screen.findByRole('button', { name: 'p2 task 0' });
  await act(async () => old.resolve(result('p1', 1, [event(55)])));
  expect(screen.queryByText('event-55')).toBeNull(); expect(screen.queryByRole('button', { name: 'p1 task 0' })).toBeNull();
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
  render(<ProjectDetailPage />); await screen.findByRole('button', { name: 'p1 task 0' }); await broadcast(); await broadcast();
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
  expect(screen.queryByRole('button', { name: 'p2 task 0' })).toBeNull();
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
