// @vitest-environment jsdom
// Value: 群设置「关联项目」页与项目详情「已关联群」经真实 renderer 客户端走 preload 回执。
// Minimal regressions: 空态只显示说明；一次点击只发一次 link；REVISION_CONFLICT 只重读不重发；
// 无权限不隐藏整块；解除关联必须先确认且只解除关联；重试复用 requestId、换 revision 是新动作。
// Gap: 未覆盖真实 main 协调器、真实群权限 HTTP 往返与真实 Chat Server。
// Tier: unit; 只用受控 preload 桩，不写宿主或账号。
// Standalone measurement: 9 cases, 1.8s wall / 296ms tests (2026-11-06, Windows).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
import type { ProjectGroupLink } from '../../../../shared/projectGroupLinks';
import type { ProjectRecord } from '../../../../shared/projects';
import { GroupLinkedProjects } from '../GroupLinkedProjects';
import { ProjectLinkedGroupsSection } from '../ProjectLinkedGroupsSection';
import { linkProjectToGroup, resetProjectGroupLinkRequestIds } from '../projectGroupLinkClient';

const env = vi.hoisted(() => ({
  list: vi.fn(), listProject: vi.fn(), link: vi.fn(), unlink: vi.fn(), deviceId: vi.fn(), projects: vi.fn(),
  confirm: vi.fn(), navigate: vi.fn(),
  groups: [] as Array<{ id: string; name: string; serverBacked?: boolean; conversationKind?: string }>,
  loaded: true,
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    t: (key: string, options?: { name?: string }) =>
      options && typeof options.name === 'string' ? `${key}:${options.name}` : key,
  }),
}));
vi.mock('react-router-dom', () => ({ useNavigate: () => env.navigate }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'acct-1', generation: 1 }),
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useConfirmDialog: () => ({ confirm: env.confirm }) }));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    label: string; value: string; disabled?: boolean;
    options: { value: string; label: string }[]; onValueChange(value: string): void;
  }) => <select aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onValueChange(event.target.value)}>
    <option value="" />
    {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock('@/features/bots/botGroupStore', () => ({
  useBotGroupList: () => ({ groups: env.groups, loaded: env.loaded }),
  refreshBotGroups: () => {},
}));
vi.mock('../projectService', () => ({ listProjects: () => env.projects() }));

const ROOM = '11111111-2222-4333-8444-555555555555';
const ENDPOINT = 'https://chat.example.com';

function group(overrides: Partial<BotGroupSummary> = {}): BotGroupSummary {
  return {
    id: ROOM, name: 'Design room', replyMode: 'mentioned', speakingMode: 'auto', members: [],
    organizerBotId: null, projectDir: null, lastMessage: null, speakingBotIds: [],
    planningBotId: null, openPlan: null, createdAt: 0, updatedAt: 0,
    serverBacked: true, conversationKind: 'group', ...overrides,
  } as BotGroupSummary;
}

function linkRow(overrides: Partial<ProjectGroupLink> = {}): ProjectGroupLink {
  return {
    relationId: 'rel-1',
    group: { endpoint: ENDPOINT, roomId: ROOM },
    target: { accountId: 'acct-1', deviceId: 'dev-1', projectId: 'p1' },
    status: 'active', revision: 3, createdAt: '', updatedAt: '',
    ...overrides,
  };
}

function listOf(links: ProjectGroupLink[]) {
  return { ok: true as const, contractRevision: 1 as const, links, nextCursor: null };
}

function mutationOf(link: ProjectGroupLink, change: 'linked' | 'unlinked' | 'unchanged') {
  return {
    ok: true as const, contractRevision: 1 as const, requestId: 'r', replayed: false, change,
    commit: { relationId: link.relationId, revision: link.revision, statusAtCommit: link.status },
    current: link,
  };
}

function failed(code: string, commitState: 'not-committed' | 'committed' | 'unknown' = 'not-committed') {
  return { ok: false as const, errorCode: code, message: 'rejected', commitState };
}

function project(id: string, name: string): ProjectRecord {
  return {
    id, name, goal: null, ownerId: 'acct-1', status: 'active', taskCount: 0, createdAt: '', updatedAt: '',
    members: [{
      subject: { kind: 'account', id: 'acct-1', displayName: null, avatar: null, avatarColor: null },
      role: 'owner', addedAt: '',
    }],
  };
}

function installBridge(): void {
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    clientEndpoints: { websiteUrl: '', chatApiBaseUrl: `${ENDPOINT}/` },
    getDeviceId: () => env.deviceId(),
    localDb: {
      projectGroupLinks: {
        list: (...args: unknown[]) => env.list(...args),
        listProject: (...args: unknown[]) => env.listProject(...args),
        link: (...args: unknown[]) => env.link(...args),
        unlink: (...args: unknown[]) => env.unlink(...args),
      },
    },
  };
}

const addButton = () => screen.getByRole('button', { name: 'projectGroupLinks.add' });
const chooseProject = (id: string) =>
  fireEvent.change(screen.getByRole('combobox', { name: 'projectGroupLinks.add' }), { target: { value: id } });

beforeEach(() => {
  vi.resetAllMocks();
  resetProjectGroupLinkRequestIds();
  env.deviceId.mockResolvedValue('dev-1');
  env.confirm.mockResolvedValue(false);
  env.groups = [{ id: ROOM, name: 'Design room', serverBacked: true, conversationKind: 'group' }];
  env.loaded = true;
  installBridge();
});
afterEach(cleanup);

it('shows the empty explanation and no fake row when nothing is linked', async () => {
  env.list.mockResolvedValue(listOf([]));
  env.projects.mockResolvedValue([]);
  render(<GroupLinkedProjects group={group()} canManage />);
  expect(await screen.findByText('projectGroupLinks.emptyTitle')).toBeTruthy();
  expect(screen.getByText('projectGroupLinks.emptyHint')).toBeTruthy();
  expect(screen.queryByRole('button', { name: /unlinkTarget/ })).toBeNull();
});

it('links one project with one request and renders the re-read list', async () => {
  env.list.mockResolvedValueOnce(listOf([])).mockResolvedValue(listOf([linkRow()]));
  env.projects.mockResolvedValue([project('p1', 'Coffee')]);
  env.link.mockResolvedValue(mutationOf(linkRow(), 'linked'));
  render(<GroupLinkedProjects group={group()} canManage />);
  await screen.findByText('projectGroupLinks.emptyTitle');
  await waitFor(() => expect((screen.getByRole('combobox', { name: 'projectGroupLinks.add' }) as HTMLSelectElement).disabled)
    .toBe(false));
  chooseProject('p1');
  fireEvent.click(addButton());
  fireEvent.click(addButton());
  await screen.findByRole('button', { name: 'projectGroupLinks.unlinkTarget:Coffee' });
  expect(env.link).toHaveBeenCalledTimes(1);
  const intent = env.link.mock.calls[0][0] as {
    action: string; requestId: string; expectedRevision: number;
    group: { endpoint: string; roomId: string };
    target: { accountId: string; deviceId: string; projectId: string };
  };
  expect(intent.action).toBe('link');
  expect(intent.expectedRevision).toBe(0);
  expect(intent.group).toEqual({ endpoint: ENDPOINT, roomId: ROOM });
  expect(intent.target).toEqual({ accountId: 'acct-1', deviceId: 'dev-1', projectId: 'p1' });
  expect(intent.requestId.length).toBeGreaterThan(0);
  // 列表是重新读的，不是回执里的 current 冒充的。
  expect(env.list.mock.calls.length).toBeGreaterThan(1);
});

it('reports a changed list after REVISION_CONFLICT without resending the action', async () => {
  env.list.mockResolvedValue(listOf([]));
  env.projects.mockResolvedValue([project('p1', 'Coffee')]);
  env.link.mockResolvedValue(failed('REVISION_CONFLICT'));
  render(<GroupLinkedProjects group={group()} canManage />);
  await screen.findByText('projectGroupLinks.emptyTitle');
  const reads = env.list.mock.calls.length;
  chooseProject('p1');
  fireEvent.click(addButton());
  expect(await screen.findByText('projectGroupLinks.conflictNotice')).toBeTruthy();
  expect(screen.getByText('projectGroupLinks.errors.revisionConflict')).toBeTruthy();
  expect(env.link).toHaveBeenCalledTimes(1);
  // 只重读真实列表，不重发这次动作。
  await waitFor(() => expect(env.list.mock.calls.length).toBeGreaterThan(reads));
  expect(env.link).toHaveBeenCalledTimes(1);
});

it('keeps the block and names the role when only the project owner may link', async () => {
  env.list.mockResolvedValue(listOf([]));
  env.projects.mockResolvedValue([project('p1', 'Coffee')]);
  env.link.mockResolvedValue(failed('NOT_PROJECT_OWNER'));
  render(<GroupLinkedProjects group={group()} canManage />);
  await screen.findByText('projectGroupLinks.emptyTitle');
  chooseProject('p1');
  fireEvent.click(addButton());
  expect(await screen.findByText('projectGroupLinks.errors.notProjectOwner')).toBeTruthy();
  expect(screen.getByText('projectGroupLinks.emptyTitle')).toBeTruthy();
  expect(env.list.mock.calls.length).toBe(1);
});

it('asks before unlinking, then removes only the link', async () => {
  env.list.mockResolvedValueOnce(listOf([linkRow()])).mockResolvedValue(listOf([]));
  env.projects.mockResolvedValue([project('p1', 'Coffee')]);
  env.unlink.mockResolvedValue(mutationOf(linkRow({ status: 'removed', revision: 4 }), 'unlinked'));
  render(<GroupLinkedProjects group={group()} canManage />);
  const unlinkButton = await screen.findByRole('button', { name: 'projectGroupLinks.unlinkTarget:Coffee' });
  fireEvent.click(unlinkButton);
  await waitFor(() => expect(env.confirm).toHaveBeenCalledTimes(1));
  expect(env.confirm.mock.calls[0][0].description).toBe('projectGroupLinks.unlinkNote');
  expect(env.unlink).not.toHaveBeenCalled();
  env.confirm.mockResolvedValue(true);
  fireEvent.click(screen.getByRole('button', { name: 'projectGroupLinks.unlinkTarget:Coffee' }));
  await screen.findByText('projectGroupLinks.emptyTitle');
  expect(env.unlink).toHaveBeenCalledTimes(1);
  expect(screen.queryByText(/projectGroupLinks\.errors\./)).toBeNull();
  expect(env.unlink.mock.calls[0][0]).toMatchObject({
    action: 'unlink', relationId: 'rel-1', expectedRevision: 3,
    target: { accountId: 'acct-1', deviceId: 'dev-1', projectId: 'p1' },
  });
});

it('lists the groups that link this project through the by-project channel and opens one', async () => {
  // 按群 list 不再参与项目侧反查：这条通道只按项目读一次。
  env.list.mockResolvedValue(listOf([]));
  env.listProject.mockResolvedValue({ ok: true, contractRevision: 1, truncated: false, links: [linkRow()] });
  render(<ProjectLinkedGroupsSection projectId="p1" />);
  const open = await screen.findByRole('button', { name: 'projectGroupLinks.openGroup: Design room' });
  fireEvent.click(open);
  expect(env.navigate).toHaveBeenCalledWith(`/bots/groups/${ROOM}`);
  expect(env.listProject).toHaveBeenCalledWith({ action: 'list-project', projectId: 'p1' });
  expect(env.list).not.toHaveBeenCalled();
});

it("says the project's linked groups could not be read instead of showing an empty list", async () => {
  env.listProject.mockResolvedValue(failed('NOT_PROJECT_MEMBER'));
  render(<ProjectLinkedGroupsSection projectId="p1" />);
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('projectGroupLinks.projectFailed');
  expect(alert.textContent).toContain('projectGroupLinks.errors.notProjectMember');
  expect(screen.queryByText('projectGroupLinks.projectEmpty')).toBeNull();
});

it('marks a truncated by-project result as possibly incomplete', async () => {
  env.listProject.mockResolvedValue({ ok: true, contractRevision: 1, truncated: true, links: [linkRow()] });
  render(<ProjectLinkedGroupsSection projectId="p1" />);
  await screen.findByRole('button', { name: 'projectGroupLinks.openGroup: Design room' });
  expect(screen.getByText('projectGroupLinks.projectPartial')).toBeTruthy();
});

it('reuses the request id for a retry of the same intent and starts a new one for a newer revision', async () => {
  env.link.mockResolvedValue(mutationOf(linkRow(), 'linked'))
    .mockResolvedValueOnce(failed('INTERNAL', 'not-committed'));
  const base = { group: { endpoint: ENDPOINT, roomId: ROOM }, accountId: 'acct-1', deviceId: 'dev-1', projectId: 'p1' };
  await expect(linkProjectToGroup({ ...base, expectedRevision: 0 })).rejects.toThrow('project group link');
  await linkProjectToGroup({ ...base, expectedRevision: 0 });
  const [first, second] = env.link.mock.calls.map(call => call[0] as { requestId: string });
  expect(second.requestId).toBe(first.requestId);
  await linkProjectToGroup({ ...base, expectedRevision: 2 });
  const third = env.link.mock.calls[2][0] as { requestId: string };
  expect(third.requestId).not.toBe(first.requestId);
});
