// @vitest-environment jsdom
/** Value: real ProjectsPage/controller -> existing projectService -> controlled preload, plus frozen NewProjectDialog.
 * Rule: global project card entry, stable kind/id, honest lifecycle/progress and owner/epoch/latest authority.
 * Gap: tree/detail/dialog tests cannot observe list discovery, filters, no-host empty fallback or list publication.
 * Minimal inputs: two equal names/different ids, account/bot sharing an id; delayed list across owner/notification.
 * Tier unit: synthetic bridge only; no DB/access-proof/real account data. One module load, no real sleeps.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { ProjectsPage } from '../ProjectsPage';
import { ProjectsIndexRoute } from '../ProjectsIndexRoute';
import { EntityProjectsSection } from '../EntityProjectsSection';
import { MemoryRouter, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import type { ProjectRecord, ProjectMember } from '../../../../shared/projects';
vi.mock('../../cc-agent/sidebar/SessionEntryList', () => ({ SessionEntryList: () => null }));
const env = vi.hoisted(() => ({ account: 'creator', epoch: 1 }));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({
    dataOwnerId: env.account,
    dataOwnerGeneration: env.epoch,
    user: { name: env.account },
  }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => env.epoch,
  isDataOwnerGenerationCurrent: (epoch: number) => epoch === env.epoch,
}));
vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    i18n: { language: 'en' },
    t: (key: string, values?: Record<string, unknown>) =>
      key +
      (values
        ? ' ' +
          Object.entries(values)
            .map(([k, v]) => `${k}=${v}`)
            .join(' ')
        : ''),
  }),
}));
vi.mock('@/features/bots/botStore', () => ({
  useBotProfiles: () => [{ id: 'creator', name: 'Bot owner', status: 'active', avatar: 'B' }],
}));
vi.mock('@/components/ui/select', () => ({
  Select: (p: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (v: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label={p.label}
      disabled={p.disabled}
      value={p.value}
      onChange={(e) => p.onValueChange(e.target.value)}
    >
      {p.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
const api = { list: vi.fn(), mutate: vi.fn(), onChanged: vi.fn(), detail: vi.fn() };
const openProject = vi.fn();
function member(
  kind: 'account' | 'bot' = 'account',
  id = 'creator',
  role: 'owner' | 'member' = 'owner',
): ProjectMember {
  return {
    subject: { kind, id, displayName: 'Same owner', avatar: null, avatarColor: null },
    role,
    addedAt: '2026-11-05T00:00:00Z',
  };
}
function project(id = 'p1', patch: Partial<ProjectRecord> = {}): ProjectRecord {
  return {
    id,
    name: 'Twin',
    goal: 'Build a useful notebook',
    ownerId: 'creator',
    status: 'active',
    members: [member(), member('bot', 'creator', 'member'), member('bot', 'creator', 'member')],
    taskCount: 4,
    dirs: [],
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    ...patch,
  };
}
function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const key = (s: string) => 'ccAgent.projectCore.index.' + s;
const cards = () => screen.queryAllByRole('button', { name: /index.openProject/ });
const ready = () => screen.findByText(key('resultCount') + ' count=1');
const newButton = () =>
  screen.getAllByRole<HTMLButtonElement>('button', { name: 'ccAgent.projectCore.newProject' })[0];
async function notify() {
  await act(async () => api.onChanged.mock.calls.at(-1)![0]());
}
beforeEach(() => {
  vi.resetAllMocks();
  env.account = 'creator';
  env.epoch = 1;
  api.list.mockResolvedValue([project()]);
  api.mutate.mockResolvedValue({ ok: true, projectId: 'created', sessionId: null });
  api.onChanged.mockReturnValue(() => {});
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { projects: api } },
  });
});
afterEach(cleanup);
it('reads list once, keeps equal-name IDs distinct and navigates by their stable ids without detail N+1', async () => {
  api.list.mockResolvedValue([project(), project('p2')]);
  render(<ProjectsPage onOpenProject={openProject} />);
  await screen.findByText(key('resultCount') + ' count=2');
  const entries = cards();
  expect(entries).toHaveLength(2);
  fireEvent.click(entries[1]);
  expect(openProject).toHaveBeenCalledExactlyOnceWith('p2');
  expect(api.list.mock.calls).toEqual([[]]);
  expect(api.detail).not.toHaveBeenCalled();
  expect(within(entries[0]).getByText(key('memberCount') + ' count=2 bots=1')).toBeTruthy();
  // 卡片只写名字：不再出现「账号 / 伙伴」这层内部模型词。
  expect(within(entries[0]).getByText(key('owner'), { exact: false })).toBeTruthy();
  expect(within(entries[0]).queryByText(key('account'))).toBeNull();
  expect(within(entries[0]).queryByText(key('bot'))).toBeNull();
  expect(screen.getAllByText(key('progressHint'))).toHaveLength(2);
  expect(entries[0].querySelector('button,a,input')).toBeNull();
});
it('uses the unique owner member kind/id rather than creator ownerId', async () => {
  api.list.mockResolvedValue([
    project('p1', {
      members: [member('bot', 'creator'), member('account', 'creator', 'member')],
      ownerId: 'different-creator',
    }),
  ]);
  render(<ProjectsPage onOpenProject={openProject} />);
  await ready();
  // 卡片只写名字，不再暴露「账号 / 伙伴」这种内部模型词。
  expect(screen.getByText(key('owner') + ' · Same owner')).toBeTruthy();
});
it('searches both name and goal and filters active/archived without treating archive as completion', async () => {
  api.list.mockResolvedValue([
    project(),
    project('p2', { name: 'Archive sample', goal: 'Unique objective', status: 'archived' }),
  ]);
  render(<ProjectsPage onOpenProject={openProject} />);
  await ready();
  fireEvent.change(screen.getByRole('combobox', { name: key('filterLabel') }), {
    target: { value: 'archived' },
  });
  expect(cards()[0].getAttribute('data-project-id')).toBe('p2');
  fireEvent.change(screen.getByRole('textbox', { name: key('searchLabel') }), {
    target: { value: 'unique objective' },
  });
  expect(cards()).toHaveLength(1);
  fireEvent.change(screen.getByRole('textbox', { name: key('searchLabel') }), {
    target: { value: 'absent' },
  });
  expect(screen.getByText(key('noMatches'))).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: key('clearFilters') }));
  expect(cards()).toHaveLength(2);
  expect(api.list).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/0%|100%|accepted|released/i)).toBeNull();
});
it('shows genuine authorized empty only after list resolves and cancellation writes nothing', async () => {
  const pending = deferred<ProjectRecord[]>();
  api.list.mockReturnValue(pending.promise);
  render(<ProjectsPage onOpenProject={openProject} />);
  expect(screen.getByText(key('loading'))).toBeTruthy();
  expect(screen.queryByText(key('emptyTitle'))).toBeNull();
  await act(async () => pending.resolve([]));
  await screen.findByText(key('emptyTitle'));
  fireEvent.click(newButton());
  await screen.findByRole('dialog');
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.cancel' }));
  expect(api.mutate).not.toHaveBeenCalled();
});
it.each(['list', 'subscription', 'response'] as const)(
  'reports unavailable/malformed %s instead of empty and never writes',
  async (missing) => {
    if (missing === 'list')
      Object.defineProperty(window, 'electronAPI', {
        configurable: true,
        value: { localDb: { projects: { onChanged: api.onChanged } } },
      });
    if (missing === 'subscription')
      api.onChanged.mockImplementation(() => {
        throw new Error('missing');
      });
    if (missing === 'response') api.list.mockResolvedValue(undefined);
    render(<ProjectsPage onOpenProject={openProject} />);
    await screen.findByRole('alert');
    expect(screen.queryByText(key('emptyTitle'))).toBeNull();
    expect(newButton().disabled).toBe(true);
    expect(api.mutate).not.toHaveBeenCalled();
  },
);
it('reports read-only create capability honestly while allowing authorized cards', async () => {
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { projects: { list: api.list, onChanged: api.onChanged } } },
  });
  render(<ProjectsPage onOpenProject={openProject} />);
  await ready();
  expect(newButton().disabled).toBe(true);
  expect(screen.getByText(key('createUnavailable'))).toBeTruthy();
  fireEvent.click(cards()[0]);
  expect(openProject).toHaveBeenCalledWith('p1');
});
it.each(['FORBIDDEN', 'NOT_PROJECT_MEMBER'])(
  'retries %s list errors and clears formerly visible names immediately on revocation',
  async (code) => {
    api.list.mockRejectedValueOnce(new Error(`[${code}] denied`));
    render(<ProjectsPage onOpenProject={openProject} />);
    await screen.findByText(key('forbidden'));
    fireEvent.click(screen.getByRole('button', { name: key('retry') }));
    await ready();
    const pending = deferred<ProjectRecord[]>();
    api.list.mockReturnValueOnce(pending.promise);
    await notify();
    expect(cards()).toHaveLength(0);
    await act(async () => pending.reject(new Error(`[${code}] revoked`)));
    expect(screen.getByText(key('forbidden'))).toBeTruthy();
    expect(screen.queryByText('Twin')).toBeNull();
  },
);
it.each(['resolve', 'reject'] as const)(
  'latest notification wins over old list %s and finally',
  async (outcome) => {
    const old = deferred<ProjectRecord[]>();
    const latest = deferred<ProjectRecord[]>();
    api.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(latest.promise);
    render(<ProjectsPage onOpenProject={openProject} />);
    await notify();
    await act(async () => latest.resolve([project('new', { name: 'New scope' })]));
    await ready();
    await act(async () =>
      outcome === 'resolve'
        ? old.resolve([project('old', { name: 'Old scope' })])
        : old.reject(new Error('old failure')),
    );
    expect(screen.queryByText('New scope')).not.toBeNull();
    expect(screen.queryByText('Old scope')).toBeNull();
    expect(screen.queryByRole('alert')).toBeNull();
  },
);
it.each(['account', 'epoch'] as const)(
  'clears query/dialog and ignores old reads after %s change',
  async (change) => {
    const old = deferred<ProjectRecord[]>();
    api.list.mockReturnValueOnce(old.promise);
    const page = render(<ProjectsPage onOpenProject={openProject} />);
    if (change === 'account') env.account = 'other';
    else env.epoch++;
    api.list.mockResolvedValue([project('new', { name: 'Fresh' })]);
    page.rerender(<ProjectsPage onOpenProject={openProject} />);
    await ready();
    await act(async () => old.resolve([project('old', { name: 'Private old' })]));
    expect(screen.queryByText('Private old')).toBeNull();
    expect(screen.getByText('Fresh')).toBeTruthy();
  },
);
it('old subscription and pending list cannot publish or start reads after unmount', async () => {
  const pending = deferred<ProjectRecord[]>();
  api.list.mockReturnValueOnce(pending.promise);
  const page = render(<ProjectsPage onOpenProject={openProject} />);
  const callback = api.onChanged.mock.calls[0][0];
  page.unmount();
  await act(async () => {
    callback();
    pending.resolve([project()]);
  });
  expect(api.list).toHaveBeenCalledTimes(1);
});
it('uses frozen real dialog -> real create service, then rereads only on confirmed success', async () => {
  render(<ProjectsPage onOpenProject={openProject} />);
  await ready();
  fireEvent.click(newButton());
  fireEvent.change(await screen.findByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'), {
    target: { value: 'Created project' },
  });
  fireEvent.click(screen.getByRole('radio', { name: /Bot owner/ }));
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.submit' }));
  await waitFor(() => expect(api.list).toHaveBeenCalledTimes(2));
  expect(api.mutate).toHaveBeenCalledExactlyOnceWith({
    action: 'create',
    input: {
      name: 'Created project',
      goal: null,
      owner: { kind: 'bot', id: 'creator' },
      members: [{ kind: 'account', id: 'creator' }],
      dirs: [],
    },
  });
});
it('never preselects an owner and refuses to submit without one', async () => {
  render(<ProjectsPage onOpenProject={openProject} />);
  await ready();
  fireEvent.click(newButton());
  fireEvent.change(await screen.findByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'), {
    target: { value: 'No owner yet' },
  });
  const radios = screen.getAllByRole('radio');
  expect(radios.length).toBeGreaterThan(0);
  expect(radios.every((radio) => !(radio as HTMLInputElement).checked)).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.submit' }));
  await waitFor(() => expect(screen.getByText('ccAgent.projectCore.form.ownerRequired')).toBeTruthy());
  expect(api.mutate).not.toHaveBeenCalled();
});
it.each(['resolve', 'reject'] as const)(
  'old create %s after epoch change cannot reload/close current form or show old error',
  async (outcome) => {
    const pending = deferred<unknown>();
    api.mutate.mockReturnValueOnce(pending.promise);
    const page = render(<ProjectsPage onOpenProject={openProject} />);
    await ready();
    fireEvent.click(newButton());
    fireEvent.change(
      await screen.findByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'),
      { target: { value: 'Old draft' } },
    );
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.submit' }));
    env.epoch++;
    page.rerender(<ProjectsPage onOpenProject={openProject} />);
    await ready();
    fireEvent.click(newButton());
    fireEvent.change(
      await screen.findByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'),
      { target: { value: 'New draft' } },
    );
    const reads = api.list.mock.calls.length;
    await act(async () =>
      outcome === 'resolve'
        ? pending.resolve({ ok: true })
        : pending.reject(new Error('old create error')),
    );
    expect(api.list).toHaveBeenCalledTimes(reads);
    expect(screen.getByRole('dialog')).toBeTruthy();
    expect(screen.queryByRole('alert')).toBeNull();
    expect(
      (screen.getByPlaceholderText('ccAgent.projectCore.form.namePlaceholder') as HTMLInputElement)
        .value,
    ).toBe('New draft');
  },
);
it('parent-owned new dialog callback receives an owner-scoped successful-create refresh', async () => {
  const start = vi.fn();
  const page = render(<ProjectsPage onOpenProject={openProject} onNewProject={start} />);
  await ready();
  fireEvent.click(newButton());
  expect(start).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('dialog')).toBeNull();
  const created = start.mock.calls[0][0];
  env.epoch++;
  page.rerender(<ProjectsPage onOpenProject={openProject} onNewProject={start} />);
  await ready();
  const reads = api.list.mock.calls.length;
  await act(async () => created());
  expect(api.list).toHaveBeenCalledTimes(reads);
});

it('an older successful read cannot replace a newer permission failure', async () => {
  const old = deferred<ProjectRecord[]>();
  api.list
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error('[NOT_PROJECT_MEMBER] denied'));
  render(<ProjectsPage onOpenProject={openProject} />);
  await notify();
  await screen.findByText(key('forbidden'));
  await act(async () => old.resolve([project()]));
  expect(cards()).toHaveLength(0);
  expect(screen.getByText(key('forbidden'))).toBeTruthy();
});
it('changing host identity during a pending read rejects that reply rather than displaying its cards', async () => {
  const old = deferred<ProjectRecord[]>();
  api.list.mockReturnValueOnce(old.promise);
  render(<ProjectsPage onOpenProject={openProject} />);
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: { projects: { ...api, list: vi.fn() } } },
  });
  await act(async () => old.resolve([project()]));
  await screen.findByText(key('hostUnavailable'));
  expect(cards()).toHaveLength(0);
});

it('unknown group membership records are rejected as malformed, never promoted to project access or empty success', async () => {
  api.list.mockResolvedValue([
    project('p1', {
      members: [{ ...member(), subject: { ...member().subject, kind: 'group' as 'account' } }],
    }),
  ]);
  render(<ProjectsPage onOpenProject={openProject} />);
  await screen.findByText(key('invalidResponse'));
  expect(cards()).toHaveLength(0);
  expect(screen.queryByText(key('emptyTitle'))).toBeNull();
  expect(newButton().disabled).toBe(true);
});

// Integration gap: page callbacks alone cannot prove the global entry and real route adapter connect.
// Unit: real header -> memory router -> page/controller/service -> controlled preload, no Host/DB.
it('opens the project card index from its global header and routes equal-name cards by stable id', async () => {
  api.list.mockResolvedValue([project(), project('p2')]);
  function Entry() {
    const navigate = useNavigate();
    return <EntityProjectsSection projects={[]} collapsed={new Set()} runningSessionIds={new Set()}
      attachedSessionIds={new Set()} notifications={new Set()} scheduleSessionIndex={new Map()}
      onToggleProject={() => {}} onOpenProject={() => {}} onNewProject={() => {}}
      onOpenProjects={() => navigate('/cc-agent/projects')} onSessionClick={() => {}}
      onAction={() => {}} onRename={() => {}} onTogglePin={() => {}} onScheduleAction={() => {}} />;
  }
  function DetailLocator() { return <p>opened:{useParams().projectId}</p>; }
  render(<MemoryRouter initialEntries={['/entry']}><Routes>
    <Route path="/entry" element={<Entry />} />
    <Route path="/cc-agent/projects" element={<ProjectsIndexRoute />} />
    <Route path="/cc-agent/projects/:projectId" element={<DetailLocator />} />
  </Routes></MemoryRouter>);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.sectionTitle' }));
  await screen.findByText(key('resultCount') + ' count=2');
  fireEvent.click(cards()[1]);
  expect(await screen.findByText('opened:p2')).toBeTruthy();
  expect(api.list).toHaveBeenCalledTimes(1);
});
