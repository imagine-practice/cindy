// @vitest-environment jsdom
// Value: 项目详情「同步到群」经真实组件/摘要逻辑/按项目关联群通道走既有群发送通道：
// 入口条件、确认后再发、每次确认换新发送标识（同内容可再发）、重试复用同一枚（不重复）、
// 连点只发一次、摘要含每个工作项的状态与处理人、如实结果与非成员不可用。
// Minimal failures: 没确认就发；同内容第二次发不出去（旧的内容幂等键）；同一次重试换成第二条；
// 连点发出两条；摘要里没有处理人或把未分配写成别人；没有记录时写出 0%/百分比；
// 发送失败却显示成功；非成员仍拿到摘要；群列表回到「按群逐个反查 + 60 秒缓存」。
// Gap: 未覆盖真实 Chat Server 往返与真实主进程 list-project 事务（后者由 main 侧测试覆盖），
// 也未做 320 宽/双主题目检。main 侧 (group, clientId) 去重由既有 botGroupChatService 测试覆盖。
// Tier: unit; 只桩 preload 边界与本机群列表，不写宿主或账号。
// Standalone measurement: 13 cases, 2.5s wall / 601ms tests (2026-11-06, Windows).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { BotGroupSummary } from '../../../../shared/botGroupChat';
import type { ProjectGroupLink } from '../../../../shared/projectGroupLinks';
import type { ProjectProgressApiHistoryEntry, ProjectProgressReadResult } from '../../../../shared/projectProgressApi';
import type { WorkItemProgressRecord } from '../../../../shared/workItemProgress';
import { ProjectProgressToGroupSection } from '../progress/ProjectProgressToGroupSection';
import { resetProjectProgressSyncReceipts } from '../progress/projectProgressSync';

const env = vi.hoisted(() => ({
  send: vi.fn(), read: vi.fn(), listProject: vi.fn(), confirm: vi.fn(),
  groups: [] as Array<{ id: string; name: string; serverBacked?: boolean; conversationKind?: string }>,
  links: [] as ProjectGroupLink[],
}));

vi.mock('react-i18next', () => ({
  useTranslation: () => ({
    // 把插值一并摊开，断言才能看到「真实数据进了摘要」。
    t: (key: string, options?: Record<string, unknown>) => {
      if (!options) return key;
      const parts = Object.entries(options).map(([name, value]) => `${name}=${String(value)}`);
      return `${key}[${parts.join(',')}]`;
    },
  }),
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'acct-1', generation: 1 }),
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('@/components/ui/confirm-dialog-provider', () => ({ useOptionalConfirmDialog: () => ({ confirm: env.confirm }) }));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    label: string; value: string; disabled?: boolean;
    options: { value: string; label: string }[]; onValueChange(value: string): void;
  }) => <select aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onValueChange(event.target.value)}>
    {props.options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));
vi.mock('@/features/bots/botGroupStore', () => ({
  useBotGroupList: () => ({ groups: env.groups, loaded: true }),
  refreshBotGroups: () => {},
  botGroupApi: () => ({ sendBotGroupMessage: env.send }),
}));
// 处理人名字由界面按已知主体解析：这里给一个确定的解析器，断言摘要里是**名字**而不是 id。
vi.mock('../projectLabels', () => ({
  useProjectSubjectLabel: () => (subject: { kind: 'account' | 'bot'; id: string } | null) => {
    if (!subject) return '';
    if (subject.kind === 'bot') return subject.id === 'bot-1' ? 'Bot Alpha' : subject.id;
    return subject.id === 'acct-1' ? 'Ana' : subject.id;
  },
}));
vi.mock('../progress/projectProgressService', () => ({ readProjectProgress: (request: unknown) => env.read(request) }));

const ROOM = '11111111-2222-4333-8444-555555555555';
const ROOM_2 = '22222222-3333-4444-8555-666666666666';
const ENDPOINT = 'https://chat.example.com';

function group(id: string, name: string): BotGroupSummary {
  return { id, name, replyMode: 'mentioned', speakingMode: 'auto', members: [], organizerBotId: null,
    projectDir: null, lastMessage: null, speakingBotIds: [], planningBotId: null, openPlan: null,
    createdAt: 0, updatedAt: 0, serverBacked: true, conversationKind: 'group' } as BotGroupSummary;
}

function link(roomId: string, projectId = 'p1'): ProjectGroupLink {
  return { relationId: `rel-${roomId}`, group: { endpoint: ENDPOINT, roomId },
    target: { accountId: 'acct-1', deviceId: 'dev-1', projectId }, status: 'active', revision: 1,
    createdAt: '', updatedAt: '' };
}

function progress(status: 'todo' | 'doing' | 'blocked' | 'review' | 'done', extra: Partial<WorkItemProgressRecord> = {}): WorkItemProgressRecord {
  return { sessionId: 'task', projectId: 'p1', status, revision: 2, bindingRevision: 7,
    reason: null, unblockCondition: null, completionEventId: status === 'done' ? 9 : null,
    updatedBy: { kind: 'account', id: 'acct-1' }, updatedAt: 1_760_000_000_000, ...extra };
}

function result(items: ProjectProgressReadResult['items'], history: ProjectProgressApiHistoryEntry[] = []): ProjectProgressReadResult {
  return { projectId: 'p1', items, history, capabilities: { canRecord: true, canConfirmDone: false },
    historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } };
}

function item(
  sessionId: string,
  title: string,
  record: WorkItemProgressRecord | null,
  assignee: ProjectProgressReadResult['items'][number]['assignee'] = null,
): ProjectProgressReadResult['items'][number] {
  // 记录必须与工作项同 sessionId / bindingRevision，否则投影会按「状态未知」处理（不是这里要测的）。
  return { sessionId, projectId: 'p1', title, sessionStatus: 'active', bindingRevision: 7,
    assignee, progress: record ? { ...record, sessionId, bindingRevision: 7 } : null };
}

const action = 'projectProgressToGroup.action';
const sentKey = 'projectProgressToGroup.sent';
const alreadyKey = 'projectProgressToGroup.alreadySent';

function renderSection() {
  return render(<ProjectProgressToGroupSection projectId="p1" projectName="Coffee" refreshKey={0} />);
}

/** 摘要文本由确认框显示；这里取出同一段文本作为「将发送的完整内容」。 */
function confirmedText(): string {
  const options = env.confirm.mock.calls.at(-1)?.[0] as { content: { props: { children: string } } };
  return options.content.props.children;
}

async function clickSync(): Promise<void> {
  const button = await screen.findByRole('button', { name: new RegExp(action) });
  // 入口先出现再变可用（进展读取完成）；只在真正可点时点。
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  await waitFor(() => expect(env.confirm).toHaveBeenCalled());
}

function clientIds(): string[] {
  return env.send.mock.calls.map(call => (call[0] as { clientId: string }).clientId);
}

beforeEach(() => {
  vi.clearAllMocks();
  resetProjectProgressSyncReceipts();
  env.groups = [group(ROOM, 'Design room')];
  env.links = [link(ROOM)];
  env.listProject.mockImplementation(async (request: { action: string; projectId: string }) => {
    expect(request).toEqual({ action: 'list-project', projectId: 'p1' });
    return { ok: true, contractRevision: 1, truncated: false, links: env.links };
  });
  // 页面只通过真实 renderer 客户端访问宿主：桩在 preload 边界，与生产路径一致。
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    clientEndpoints: { chatApiBaseUrl: `${ENDPOINT}/` },
    getDeviceId: async () => 'dev-1',
    localDb: { projectGroupLinks: { listProject: (...args: unknown[]) => env.listProject(...args) } },
  };
  env.read.mockResolvedValue(result([item('task-a', 'Write copy', progress('doing'))]));
  env.confirm.mockResolvedValue(true);
  env.send.mockResolvedValue({ ok: true, messageId: 'm-1' });
});
afterEach(cleanup);

it('S1 keeps the entry disabled and says which group setting to use when no group has linked the project', async () => {
  env.links = [];
  renderSection();
  const button = await screen.findByRole('button', { name: new RegExp(action) });
  await waitFor(() => expect(screen.getByText('projectProgressToGroup.noGroup')).toBeTruthy());
  expect((button as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(button);
  expect(env.confirm).not.toHaveBeenCalled();
  expect(env.send).not.toHaveBeenCalled();
});

it('C reads this project\'s linked groups once through the by-project channel instead of scanning every group', async () => {
  env.groups = [group(ROOM, 'Ops room'), group(ROOM_2, 'Design room'), group('33333333-4444-4555-8666-777777777777', 'Other room')];
  env.links = [link(ROOM), link(ROOM_2), link('33333333-4444-4555-8666-777777777777', 'p-other')];
  renderSection();
  const select = await screen.findByLabelText('projectProgressToGroup.target');
  await waitFor(() => expect(select.querySelectorAll('option')).toHaveLength(2));
  // 只列关联了 p1 的群（按名称排序），另一个项目的群不出现。
  expect(select.textContent).toBe('Design roomOps room');
  // 一次按项目查询，没有「每个群读一次」的批量请求。
  expect(env.listProject).toHaveBeenCalledTimes(1);
  fireEvent.change(select, { target: { value: ROOM } });
  await clickSync();
  await waitFor(() => expect(env.send).toHaveBeenCalled());
  expect((env.send.mock.calls[0][0] as { groupId: string }).groupId).toBe(ROOM);
});

it('C re-reads on every mount so a link made after an earlier visit is visible', async () => {
  env.links = [];
  const first = renderSection();
  await waitFor(() => expect(screen.getByText('projectProgressToGroup.noGroup')).toBeTruthy());
  first.unmount();
  // 群设置里刚刚关联了项目：重新打开详情页时入口必须可用（不能再吃 60 秒前的快照）。
  env.links = [link(ROOM)];
  renderSection();
  const button = await screen.findByRole('button', { name: new RegExp(action) });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  expect(screen.queryByText('projectProgressToGroup.noGroup')).toBeNull();
  expect(env.listProject).toHaveBeenCalledTimes(2);
});

it('C says so when this account may not read the links and never offers a target', async () => {
  env.listProject.mockResolvedValue({ ok: false, errorCode: 'NOT_PROJECT_MEMBER', message: 'no', commitState: 'not-committed' });
  renderSection();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('projectGroupLinks.projectFailed');
  expect(alert.textContent).toContain('projectGroupLinks.errors.notProjectMember');
  expect(screen.queryByLabelText('projectProgressToGroup.target')).toBeNull();
  expect(((await screen.findByRole('button', { name: new RegExp(action) })) as HTMLButtonElement).disabled).toBe(true);
});

it('S2 confirms with the full text first, then sends as the account and never when cancelled', async () => {
  renderSection();
  env.confirm.mockResolvedValueOnce(false);
  await clickSync();
  expect(env.send).not.toHaveBeenCalled();

  await clickSync();
  const text = confirmedText();
  await waitFor(() => expect(env.send).toHaveBeenCalled());
  const input = env.send.mock.calls[0][0] as { groupId: string; text: string; mentions: unknown };
  expect(input.groupId).toBe(ROOM);
  expect(input.text).toBe(text);
  // 只是普通用户消息：不 @ 任何人、不冒充伙伴、不带附件。
  expect(input.mentions).toEqual({ all: false, botIds: [] });
  expect(await screen.findByText(sentKey)).toBeTruthy();
});

it('A sends the same text again as a new message once the user confirms again', async () => {
  renderSection();
  await clickSync();
  await screen.findByText(sentKey);
  const firstText = confirmedText();
  await clickSync();
  await screen.findByText(sentKey);
  expect(confirmedText()).toBe(firstText);
  const ids = clientIds();
  expect(ids).toHaveLength(2);
  // 内容一样、click 不同 → 新的发送标识（旧的内容幂等键会把它挡住）。
  expect(ids[0]).not.toBe(ids[1]);
  expect(ids[0]).toMatch(/^project-progress-sync-[0-9a-f]{16}$/u);
  expect(screen.queryByText(alreadyKey)).toBeNull();
});

it('A never sends twice from one click, even if the button is hit twice', async () => {
  let finish: (value: { ok: true; messageId: string }) => void = () => {};
  env.send.mockImplementation(() => new Promise((resolve) => { finish = resolve; }));
  renderSection();
  const button = await screen.findByRole('button', { name: new RegExp(action) });
  await waitFor(() => expect((button as HTMLButtonElement).disabled).toBe(false));
  fireEvent.click(button);
  fireEvent.click(button);
  await waitFor(() => expect(env.send).toHaveBeenCalled());
  expect(env.confirm).toHaveBeenCalledTimes(1);
  expect(env.send).toHaveBeenCalledTimes(1);
  // 发送中再点一次也不会多出第二条。
  fireEvent.click(button);
  expect(env.send).toHaveBeenCalledTimes(1);
  finish({ ok: true, messageId: 'm-1' });
  await screen.findByText(sentKey);
});

it('A retries an unknown outcome with the same send id so the group never gets a second copy', async () => {
  env.send.mockRejectedValueOnce(new Error('ack lost')).mockResolvedValueOnce({ ok: true, messageId: 'm-9' });
  renderSection();
  await clickSync();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('projectProgressToGroup.failed[detail=projectProgressToGroup.unknownOutcome]');
  fireEvent.click(screen.getByRole('button', { name: 'projectProgressToGroup.retry' }));
  // 同一枚标识：main 的 (group, clientId) 唯一约束保证这次重试不会留下第二条。
  await screen.findByText(sentKey);
  const ids = clientIds();
  expect(ids[0]).toBe(ids[1]);
});

it('S4 builds one line per work item with its real status, assignee and blocking details', async () => {
  env.read.mockResolvedValue(result([
    item('task-a', 'Write copy', progress('doing'), { kind: 'bot', id: 'bot-1' }),
    item('task-b', 'Ship it', progress('blocked', {
      sessionId: 'task-b', reason: 'Waiting for legal', unblockCondition: 'Legal approves',
    })),
    item('task-c', 'Unknown state', null, { kind: 'account', id: 'acct-1' }),
  ], [{ eventId: 4, projectId: 'p1', sessionId: 'task-b', bindingRevision: 7, from: 'doing', to: 'blocked',
    actor: { kind: 'account', id: 'acct-1', displayName: 'Owner Name' }, createdAt: 1_760_000_123_000,
    reason: 'Waiting for legal', unblockCondition: 'Legal approves', resolution: null, completionNote: null }]));
  renderSection();
  await clickSync();
  const text = confirmedText();
  expect(text).toContain('projectProgressToGroup.summary.heading[name=Coffee]');
  // 顶部保留计数。
  expect(text).toContain('projectProgressToGroup.summary.count[status=ccAgent.projectCore.progress.doing,count=1]');
  expect(text).toContain('projectProgressToGroup.summary.count[status=ccAgent.projectCore.progress.blocked,count=1]');
  expect(text).toContain('projectProgressToGroup.summary.unknown[count=1]');
  // 每个工作项一行：状态 + 标题 + 处理人（人/伙伴名）。
  expect(text).toContain('projectProgressToGroup.summary.item[status=ccAgent.projectCore.progress.doing,title=Write copy]'
    + ' · projectProgressToGroup.summary.assignee[name=Bot Alpha]');
  expect(text).toContain('projectProgressToGroup.summary.item[status=ccAgent.projectCore.progress.blocked,title=Ship it]'
    + ' · projectProgressToGroup.summary.assignee[name=projectProgressToGroup.summary.unassigned]');
  expect(text).toContain('projectProgressToGroup.summary.item[status=projectProgressToGroup.summary.statusUnknown,title=Unknown state]'
    + ' · projectProgressToGroup.summary.assignee[name=Ana]');
  // 阻塞项附原因与解除条件。
  expect(text).toContain('projectProgressToGroup.summary.blockedReason[reason=Waiting for legal]');
  expect(text).toContain('projectProgressToGroup.summary.blockedUnblock[condition=Legal approves]');
  expect(text).toContain('projectProgressToGroup.summary.latest[');
  // 事件记录里的姓名、凭证与材料正文都不进摘要。
  expect(text).not.toContain('Owner Name');
  expect(text).not.toContain('%');
});

it('S4 writes 暂无记录 and no percentage when the project has no work item at all', async () => {
  env.read.mockResolvedValue(result([]));
  renderSection();
  await clickSync();
  const text = confirmedText();
  expect(text).toContain('projectProgressToGroup.summary.empty');
  expect(text).not.toContain('%');
  expect(text).not.toContain('projectProgressToGroup.summary.count');
  expect(text).not.toContain('projectProgressToGroup.summary.item[');
});

it('S5 reports the real failure, shows no success, and retries with the same send id', async () => {
  env.send.mockResolvedValueOnce({ ok: false, errorCode: 'SERVICE_ERROR', message: 'boom' });
  renderSection();
  await clickSync();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('projectProgressToGroup.failed[detail=bots.groupChat.errors.serviceError]');
  expect(screen.queryByText(sentKey)).toBeNull();
  expect(screen.queryByText(alreadyKey)).toBeNull();

  env.send.mockResolvedValueOnce({ ok: true, messageId: 'm-2' });
  fireEvent.click(screen.getByRole('button', { name: 'projectProgressToGroup.retry' }));
  await screen.findByText(sentKey);
  const ids = clientIds();
  expect(ids[0]).toBe(ids[1]);
});

it('S5 names a generic reason instead of leaking an unmapped error code', async () => {
  env.send.mockResolvedValueOnce({ ok: false, errorCode: 'INTERNAL', message: 'raw detail' });
  renderSection();
  await clickSync();
  const alert = await screen.findByRole('alert');
  expect(alert.textContent).toContain('projectProgressToGroup.failed[detail=projectProgressToGroup.sendFailed]');
  expect(alert.textContent).not.toContain('raw detail');
});

it('S6 renders nothing when the project progress cannot be read by this account', async () => {
  env.read.mockRejectedValue(Object.assign(new Error('forbidden'), { code: 'FORBIDDEN' }));
  renderSection();
  await waitFor(() => expect(env.read).toHaveBeenCalled());
  expect(screen.queryByText('projectProgressToGroup.title')).toBeNull();
  expect(screen.queryByRole('button', { name: new RegExp(action) })).toBeNull();
});
