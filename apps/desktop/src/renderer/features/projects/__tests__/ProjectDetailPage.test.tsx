// @vitest-environment jsdom
// Value: real page -> controlled route/owner/broadcast and mutation completion ordering.
// Minimal regressions: p1 pending -> p2 ready -> old p1 completion; two same-project refreshes.
// Gap: materials/E1 suites do not exercise this page's reads/subscriptions/mutations.
// Tier: unit; no host/account writes or proof of real permission isolation.
// Standalone measurement: 30 cases, 6.3s wall / 2.0s tests (2026-11-06, delete gate cases added).
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectDetailPage } from '../ProjectDetailPage';
import type { ProjectDetail } from '../../../../shared/projects';
const env = vi.hoisted(() => ({
  realBridge: false, route: { projectId: 'p1' }, read: vi.fn(), navigate: vi.fn(),
  changed: undefined as (() => void) | undefined,
  listeners: [] as (() => void)[], generation: 1, unsubscribed: vi.fn(), toast: vi.fn(),
  toastSuccess: vi.fn(), confirm: vi.fn(), deleteProject: vi.fn(),
  rename: vi.fn(), add: vi.fn(), remove: vi.fn(), transfer: vi.fn(), assign: vi.fn(),
}));
vi.mock('react-router-dom', () => ({ useParams: () => env.route, useNavigate: () => env.navigate }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: `owner-${env.generation}`, dataOwnerGeneration: env.generation }), useOptionalDataOwnerGeneration: () => env.generation }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => env.generation,
  isDataOwnerGenerationCurrent: (owner: number) => owner === env.generation }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [] }));
vi.mock('../projectLabels', () => ({ useProjectSubjectLabel: () => (subject: { id: string }) => subject.id, projectSubjectAvatar: () => 'X', projectSubjectVisual: (subject: { kind: 'account' | 'bot' }, name: string) => ({ kind: subject.kind, name }) }));
vi.mock('@/components/ui/select', () => ({ Select: (props: { label: string; value: string; disabled?: boolean;
  options: { value: string; label: string }[]; onValueChange(value: string): void }) =>
  <select aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onValueChange(event.target.value)}>{props.options.map(o =>
      <option key={o.value} value={o.value}>{o.label}</option>)}</select> }));
vi.mock('@/lib/toast', () => ({ toast: { error: env.toast, success: env.toastSuccess } }));
// 删除的二次确认走基座共享对话框：这里只控制「用户确认了没有」。
vi.mock('@/components/ui/confirm-dialog-provider', async importOriginal => ({
  ...await importOriginal<typeof import('@/components/ui/confirm-dialog-provider')>(),
  useConfirmDialog: () => ({ confirm: env.confirm }),
}));
vi.mock('../projectService', async importOriginal => {
  const real = await importOriginal<typeof import('../projectService')>();
  return {
  readProjectDetail: (id: string) => env.realBridge ? real.readProjectDetail(id) : env.read(id),
  onProjectsChanged: (cb: () => void) => {
    if (env.realBridge) return real.onProjectsChanged(cb);
    env.changed = cb; env.listeners.push(cb);
    return () => { if (env.changed === cb) env.changed = undefined; env.unsubscribed(cb); };
  },
  addProjectMember: env.add, removeProjectMember: env.remove,
  deleteProject: (id: string) => env.deleteProject(id),
  renameProject: (id: string, patch: Parameters<typeof real.renameProject>[1]) => env.realBridge ? real.renameProject(id, patch) : env.rename(id, patch),
  setSessionAssignee: env.assign, transferProjectOwner: env.transfer,
}; } );
function detail(id: string, name = id): ProjectDetail {
  return { project: { id, name, goal: null, status: 'active', ownerId: 'owner', members: [],
    taskCount: 0, dirs: [], createdAt: '', updatedAt: '' }, workItems: [] };
}
function pending<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
beforeEach(() => {
  vi.resetAllMocks(); env.realBridge = false; env.route = { projectId: 'p1' }; env.changed = undefined; env.listeners = []; env.generation = 1;
  for (const action of [env.rename, env.add, env.remove, env.transfer, env.assign]) action.mockResolvedValue(undefined);
  env.deleteProject.mockResolvedValue(undefined);
  env.confirm.mockResolvedValue(false);
});
afterEach(cleanup);

it('control: renders the requested project normally', async () => {
  env.read.mockResolvedValue(detail('p1', 'Coffee'));
  render(<ProjectDetailPage />);
  expect(await screen.findByRole('heading', { name: 'Coffee' })).toBeTruthy();
});

it('keeps p2 after the pending p1 request resolves late', async () => {
  const old = pending<ProjectDetail>();
  env.read.mockImplementation((id: string) => id === 'p1' ? old.promise : Promise.resolve(detail('p2', 'Token')));
  const page = render(<ProjectDetailPage />);
  env.route = { projectId: 'p2' }; page.rerender(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: 'Token' });
  await act(async () => old.resolve(detail('p1', 'Coffee')));
  expect(screen.queryByRole('heading', { name: 'Token' })).not.toBeNull();
  expect(screen.queryByRole('heading', { name: 'Coffee' })).toBeNull();
});

it('keeps the latest same-project refresh after an older refresh rejects', async () => {
  const old = pending<ProjectDetail>();
  env.read.mockResolvedValueOnce(detail('p1', 'Initial')).mockReturnValueOnce(old.promise)
    .mockResolvedValueOnce(detail('p1', 'Latest'));
  render(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: 'Initial' });
  await act(async () => env.changed?.());
  await act(async () => env.changed?.());
  await screen.findByRole('heading', { name: 'Latest' });
  await act(async () => old.reject(new Error('obsolete request failed')));
  expect(screen.queryByRole('heading', { name: 'Latest' })).not.toBeNull();
  expect(screen.queryByRole('heading', { name: 'ccAgent.projectCore.detail.loadFailed' })).toBeNull();
});

it('ignores an old route failure and clears the prior project immediately on a route change', async () => {
  const pendingP2 = pending<ProjectDetail>(); const old = pending<ProjectDetail>();
  env.read.mockResolvedValueOnce(detail('p1', 'Old')).mockReturnValueOnce(old.promise).mockReturnValueOnce(pendingP2.promise);
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Old' });
  await act(async () => env.changed?.());
  env.route = { projectId: 'p2' }; page.rerender(<ProjectDetailPage />);
  expect(screen.queryByRole('heading', { name: 'Old' })).toBeNull();
  await act(async () => pendingP2.resolve(detail('p2', 'New')));
  await act(async () => old.reject(Object.assign(new Error('old'), { code: 'NOT_FOUND' })));
  expect(screen.queryByRole('heading', { name: 'New' })).not.toBeNull();
  expect(screen.queryByText('ccAgent.projectCore.detail.notFound')).toBeNull();
});

it('ignores an older successful refresh after the latest refresh has failed', async () => {
  const old = pending<ProjectDetail>();
  env.read.mockResolvedValueOnce(detail('p1', 'Initial')).mockReturnValueOnce(old.promise).mockRejectedValueOnce(new Error('latest'));
  render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Initial' });
  await act(async () => env.changed?.()); await act(async () => env.changed?.());
  await screen.findByText('ccAgent.projectCore.detail.loadFailed');
  await act(async () => old.resolve(detail('p1', 'Old success')));
  expect(screen.queryByRole('heading', { name: 'Old success' })).toBeNull();
  expect(screen.queryByText('ccAgent.projectCore.detail.loadFailed')).not.toBeNull();
});

it('keeps latest same-project success when an old successful refresh returns last', async () => {
  const old = pending<ProjectDetail>();
  env.read.mockResolvedValueOnce(detail('p1', 'Initial')).mockReturnValueOnce(old.promise).mockResolvedValueOnce(detail('p1', 'Latest'));
  render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Initial' });
  await act(async () => env.changed?.()); await act(async () => env.changed?.());
  await screen.findByRole('heading', { name: 'Latest' });
  await act(async () => old.resolve(detail('p1', 'Old success')));
  expect(screen.queryByRole('heading', { name: 'Latest' })).not.toBeNull();
});

it.each(['resolve', 'reject'])('clears on owner switch and ignores old %s and old subscriptions', async completion => {
  const old = pending<ProjectDetail>(); const fresh = pending<ProjectDetail>();
  env.read.mockResolvedValueOnce(detail('p1', 'Old owner')).mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Old owner' });
  const oldListener = env.changed!; await act(async () => oldListener());
  env.generation++;
  // Published owner invalidation blocks even a retained callback before React rerenders.
  await act(async () => oldListener()); expect(env.read).toHaveBeenCalledTimes(2);
  page.rerender(<ProjectDetailPage />); expect(screen.queryByRole('heading', { name: 'Old owner' })).toBeNull();
  expect(env.unsubscribed).toHaveBeenCalledTimes(1);
  await act(async () => fresh.resolve(detail('p1', 'New owner')));
  await act(async () => { if (completion === 'resolve') old.resolve(detail('p1', 'Obsolete')); else old.reject(new Error('old')); oldListener(); });
  expect(env.read).toHaveBeenCalledTimes(3);
  expect(screen.queryByRole('heading', { name: 'New owner' })).not.toBeNull();
});

it.each(['resolve', 'reject'])('unsubscribes on unmount and ignores pending %s and retained callbacks', async completion => {
  const old = pending<ProjectDetail>(); env.read.mockReturnValue(old.promise);
  const page = render(<ProjectDetailPage />); const listener = env.changed!; page.unmount();
  await act(async () => { listener(); if (completion === 'resolve') old.resolve(detail('p1')); else old.reject(new Error('old')); });
  expect(env.read).toHaveBeenCalledTimes(1); expect(env.unsubscribed).toHaveBeenCalledTimes(1); expect(env.toast).not.toHaveBeenCalled();
});

it('continues refreshing from current broadcasts and blocks a retained old-route subscription', async () => {
  env.read.mockResolvedValueOnce(detail('p1', 'Old')).mockResolvedValueOnce(detail('p2', 'New')).mockResolvedValueOnce(detail('p2', 'Broadcast'));
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Old' }); const oldListener = env.changed!;
  env.route = { projectId: 'p2' }; page.rerender(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'New' });
  await act(async () => oldListener()); expect(env.read).toHaveBeenCalledTimes(2);
  await act(async () => env.changed?.()); await screen.findByRole('heading', { name: 'Broadcast' });
  expect(env.read.mock.calls).toEqual([['p1'], ['p2'], ['p2']]);
});

function populated(id: string): ProjectDetail {
  const item = detail(id, id);
  item.project.members = [
    // 当前账号必须是负责人，否则负责人专属的成员操作按钮会被正确隐藏（那正是本轮的行为）。
    { subject: { kind: 'account', id: `owner-${env.generation}`, displayName: 'Owner', avatar: null, avatarColor: null }, role: 'owner', addedAt: '' },
    { subject: { kind: 'bot', id: 'partner', displayName: 'Partner', avatar: null, avatarColor: null }, role: 'member', addedAt: '' },
  ];
  item.workItems = [{ sessionId: 's1', title: 'Work item', status: 'active', assignee: null, updatedAt: '' }];
  return item;
}

it.each(['route', 'owner'].flatMap(scope => ['resolve', 'reject'].map(completion => ({ scope, completion }))))('blocks old mutation $completion/toast/finally after $scope changes', async ({ scope, completion }) => {
  const old = pending<void>(); const fresh = pending<void>();
  env.rename.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  env.read.mockImplementation(async (id: string) => populated(id));
  const page = render(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'p1' });
  const archive = () => fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.detail.archive' }));
  archive();
  if (scope === 'route') env.route = { projectId: 'p2' }; else env.generation++;
  page.rerender(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: scope === 'route' ? 'p2' : 'p1' }); archive();
  await act(async () => { if (completion === 'resolve') old.resolve(); else old.reject(new Error('old write failed')); });
  expect(env.toast).not.toHaveBeenCalled();
  expect((screen.getByRole('button', { name: 'ccAgent.projectCore.detail.removeMember' }) as HTMLButtonElement).disabled).toBe(true);
  archive(); expect(env.rename).toHaveBeenCalledTimes(2);
  await act(async () => fresh.resolve());
  expect((screen.getByRole('button', { name: 'ccAgent.projectCore.detail.removeMember' }) as HTMLButtonElement).disabled).toBe(false);
  expect(env.rename.mock.calls).toEqual([['p1', { status: 'archived' }], [scope === 'route' ? 'p2' : 'p1', { status: 'archived' }]]);
});

it('preserves materials/task navigation and member/assignee write inputs', async () => {
  env.read.mockResolvedValue(populated('p1')); render(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: 'p1' });
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.detail.back' }));
  expect(env.navigate).toHaveBeenCalledWith('/cc-agent/projects');
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.entry' }));
  expect(env.navigate).toHaveBeenCalledWith('/cc-agent/projects/p1/items/s1');
  fireEvent.click(screen.getByRole('button', { name: 'Work item' })); expect(env.navigate).toHaveBeenCalledWith('/cc-agent/s1');
  await act(async () => fireEvent.change(screen.getByRole('combobox', { name: 'ccAgent.projectCore.detail.assignee' }), { target: { value: 'bot:partner' } }));
  expect(env.assign).toHaveBeenCalledExactlyOnceWith('s1', { kind: 'bot', id: 'partner' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.detail.transferOwner' })));
  expect(env.transfer).toHaveBeenCalledExactlyOnceWith('p1', { kind: 'bot', id: 'partner' });
  await act(async () => fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.detail.removeMember' })));
  expect(env.remove).toHaveBeenCalledExactlyOnceWith('p1', { kind: 'bot', id: 'partner' });
});

// Real page + shared confirm dialog mock: cancel must not send, confirm must delete and return.
// Gap: metadata tests cover edits only; no case proved the destructive confirmation gate.
it('deletes only after the typed project-name confirmation and returns to the project list', async () => {
  env.read.mockResolvedValue(editable());
  env.confirm.mockResolvedValueOnce(false).mockResolvedValueOnce(true);
  render(<ProjectDetailPage />);
  const trigger = await screen.findByRole('button', { name: 'ccAgent.projectCore.deleteProject.action' });
  fireEvent.click(trigger);
  await waitFor(() => expect(env.confirm).toHaveBeenCalledTimes(1));
  expect(env.confirm.mock.calls[0][0]).toMatchObject({
    confirmVariant: 'destructive',
    requireTypedConfirmation: { expected: 'Project' },
  });
  // 取消（未输入项目名）不发请求、不跳转。
  expect(env.deleteProject).not.toHaveBeenCalled();
  expect(env.navigate).not.toHaveBeenCalled();

  fireEvent.click(trigger);
  await waitFor(() => expect(env.deleteProject).toHaveBeenCalledExactlyOnceWith('p1'));
  expect(env.toastSuccess).toHaveBeenCalledWith('ccAgent.projectCore.deleteProject.success');
  expect(env.navigate).toHaveBeenCalledWith('/cc-agent/projects');
});

it('hides owner-only actions from plain members and offers the ownership takeover instead', async () => {
  const member = populated('p1');
  member.project.members[0] = { ...member.project.members[0], role: 'member' };
  env.read.mockResolvedValue(member);
  render(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: 'p1' });
  expect(screen.queryByRole('button', { name: 'ccAgent.projectCore.deleteProject.action' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.projectCore.detail.removeMember' })).toBeNull();
  // 负责人可以被账号成员接管（负责人可能是不会点界面的伙伴）。
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.detail.claimOwner' }));
  expect(env.transfer).toHaveBeenCalledExactlyOnceWith('p1', { kind: 'account', id: `owner-${env.generation}` });
  expect(env.confirm).not.toHaveBeenCalled();
});

// Real page + fixed dialog + actual projectService -> controlled preload bridge.
// Gap: callback-only editor tests cannot prove owner hints, update intent or page rereads.
// Minimal failures: same-ID bot owner, late save across route/owner or revoked readable view.
// tier: unit (controlled bridge; no native IPC/DB/real account writes).
const metadata = (key: string) => `ccAgent.projectCore.metadataEdit.${key}`;
function editable(id = 'p1'): ProjectDetail {
  const row = detail(id, 'Project'); row.project.goal = 'Old goal';
  row.project.members = [{ subject: { kind: 'account', id: `owner-${env.generation}`, displayName: null, avatar: null, avatarColor: null }, role: 'owner', addedAt: '' }];
  return row;
}
function metadataBridge() {
  env.realBridge = true;
  const mutate = vi.fn<(intent: import('../../../../shared/projects').ProjectsAction) => Promise<void>>(async () => undefined);
  Object.defineProperty(window, 'electronAPI', { configurable: true, value: { localDb: { projects: {
    detail: env.read, mutate, onChanged: (callback: () => void) => {
      env.changed = callback; return () => { if (env.changed === callback) env.changed = undefined; };
    },
  } } } });
  return mutate;
}
async function openMetadata() {
  fireEvent.click(await screen.findByRole('button', { name: metadata('title') }));
  return screen.findByRole('dialog');
}
function setMetadata(field: 'name' | 'goal', value: string) {
  fireEvent.change(within(screen.getByRole('dialog')).getByRole('textbox', { name: new RegExp(`metadataEdit.${field}`) }), { target: { value } });
}
function saveMetadata() { fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: metadata('save') })); }

it('metadata entry sends only the changed name through the real service and rereads notified detail', async () => {
  const mutate = metadataBridge(); const row = editable();
  env.read.mockImplementation(async () => structuredClone(row));
  mutate.mockImplementation(async intent => {
    if (intent.action !== 'update') throw new Error('unexpected action');
    row.project.name = intent.name!;
    env.changed?.();
  });
  render(<ProjectDetailPage />); await openMetadata(); setMetadata('name', '  Renamed  '); saveMetadata();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await screen.findByRole('heading', { name: 'Renamed' });
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ action: 'update', projectId: 'p1', name: 'Renamed' });
});
it('metadata goal clear is explicit null and remains available for an archived owner', async () => {
  const mutate = metadataBridge(); const row = editable(); row.project.status = 'archived';
  env.read.mockImplementation(async () => structuredClone(row));
  mutate.mockImplementation(async intent => {
    if (intent.action !== 'update') throw new Error('unexpected action');
    row.project.goal = intent.goal ?? null; env.changed?.();
  });
  render(<ProjectDetailPage />); await openMetadata(); setMetadata('goal', ''); saveMetadata();
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mutate).toHaveBeenCalledExactlyOnceWith({ action: 'update', projectId: 'p1', goal: null });
  await screen.findByText('ccAgent.projectCore.detail.noGoal');
});
it.each(['same-id-bot', 'missing-owner-row', 'member'] as const)('metadata owner hint rejects %s without ownerId fallback', async scenario => {
  const mutate = metadataBridge(); const row = editable(); row.project.ownerId = 'owner-1';
  row.project.members[0].role = 'member';
  if (scenario !== 'missing-owner-row') row.project.members.push({
    subject: { kind: scenario === 'same-id-bot' ? 'bot' : 'account', id: scenario === 'same-id-bot' ? 'owner-1' : 'another', displayName: null, avatar: null, avatarColor: null }, role: 'owner', addedAt: '',
  });
  env.read.mockResolvedValue(row); render(<ProjectDetailPage />);
  await screen.findByRole('heading', { name: 'Project' });
  expect(screen.queryByRole('button', { name: metadata('title') })).toBeNull(); expect(mutate).not.toHaveBeenCalled();
});
it('metadata real service rejection keeps edits and retry remains explicit', async () => {
  const mutate = metadataBridge(); env.read.mockResolvedValue(editable());
  mutate.mockRejectedValueOnce(new Error('[NOT_PROJECT_OWNER] denied'));
  render(<ProjectDetailPage />); await openMetadata(); setMetadata('name', 'Kept draft'); saveMetadata();
  await screen.findByText(metadata('failed'));
  expect((within(screen.getByRole('dialog')).getByRole('textbox', { name: /metadataEdit.name/ }) as HTMLInputElement).value).toBe('Kept draft');
  expect(mutate).toHaveBeenCalledTimes(1);
  saveMetadata(); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mutate).toHaveBeenCalledTimes(2);
});
it.each(['route', 'owner'].flatMap(scope => ['resolve', 'reject'].map(completion => ({ scope, completion }))))('metadata late $completion cannot close or unlock the new $scope editor', async ({ scope, completion }) => {
  const mutate = metadataBridge(); const old = pending<void>(), fresh = pending<void>();
  mutate.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  env.read.mockImplementation(async id => editable(id));
  const page = render(<ProjectDetailPage />); await openMetadata(); setMetadata('name', 'Old draft'); saveMetadata();
  if (scope === 'route') env.route = { projectId: 'p2' }; else env.generation++;
  page.rerender(<ProjectDetailPage />); await screen.findByRole('heading', { name: 'Project' });
  expect(screen.queryByRole('dialog')).toBeNull();
  await openMetadata(); setMetadata('name', 'New draft'); saveMetadata();
  const reads = env.read.mock.calls.length;
  await act(async () => { if (completion === 'resolve') old.resolve(); else old.reject(new Error('old failure')); });
  expect((within(screen.getByRole('dialog')).getByRole('button', { name: metadata('saving') }) as HTMLButtonElement).disabled).toBe(true);
  expect(env.read).toHaveBeenCalledTimes(reads); expect(env.toast).not.toHaveBeenCalled();
  await act(async () => fresh.resolve()); await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(mutate.mock.calls.map(([intent]) => intent)).toEqual([
    { action: 'update', projectId: 'p1', name: 'Old draft' },
    { action: 'update', projectId: scope === 'route' ? 'p2' : 'p1', name: 'New draft' },
  ]);
});
it('metadata editor is removed on demotion and is not revived by a later identical owner snapshot', async () => {
  metadataBridge(); const row = editable(); env.read.mockImplementation(async () => structuredClone(row));
  render(<ProjectDetailPage />); await openMetadata(); setMetadata('name', 'Obsolete draft');
  row.project.members[0].role = 'member'; await act(async () => env.changed?.());
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(screen.queryByRole('button', { name: metadata('title') })).toBeNull();
  row.project.members[0].role = 'owner'; await act(async () => env.changed?.());
  await screen.findByRole('button', { name: metadata('title') }); expect(screen.queryByRole('dialog')).toBeNull();
  await openMetadata(); expect((within(screen.getByRole('dialog')).getByRole('textbox', { name: /metadataEdit.name/ }) as HTMLInputElement).value).toBe('Project');
});
it('metadata editor and sensitive detail clear when the current read is revoked', async () => {
  metadataBridge(); env.read.mockResolvedValueOnce(editable()).mockRejectedValueOnce(Object.assign(new Error('revoked'), { code: 'NOT_PROJECT_MEMBER' }));
  render(<ProjectDetailPage />); await openMetadata(); await act(async () => env.changed?.());
  await screen.findByRole('heading', { name: 'ccAgent.projectCore.progress.forbidden' });
  expect(screen.queryByRole('dialog')).toBeNull(); expect(screen.queryByText('Old goal')).toBeNull();
});
