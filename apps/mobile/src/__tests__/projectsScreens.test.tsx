// @vitest-environment jsdom
/**
 * 测试价值
 * - 生产入口与可观察结果:手机端项目列表页与详情页(app/projects/index.tsx、
 *   app/projects/[projectId].tsx)。用户在列表看到项目名/目标/状态/数量/时间,在详情看到
 *   五个 block、未知 primitive 的回落文本、四个写动作按钮;归档二次确认、断线禁用、
 *   失败原因与「只有负责人能确认完成」提示都在这里。
 * - Bug／规则依据:`documents/2026-11-11-手机端项目页接口契约.md` §2/§3/§4/§7
 *   (二次确认、失败可读、断线禁用且说明)。
 * - 现有覆盖缺口:项目页此前不存在;契约投影与请求体的纯逻辑另见 projectsContract.test.ts,
 *   本文件只覆盖「页面把宿主数据与拒绝码呈现成什么」。
 * - 最小失败输入:未知 primitive 的 block、宿主 resolve/抛出的 { errorCode: 'NOT_PROJECT_OWNER' }、
 *   `status !== 'online'`、`to=done` 且未填完成说明。
 * - tier:unit(jsdom;react-native/expo-router 为进程内替身,无真实设备)。
 */
import { act, createElement as el, type ReactNode } from 'react';
import { createRoot, type Root } from 'react-dom/client';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({
  alert: vi.fn(),
  push: vi.fn(),
  get: vi.fn(),
  action: vi.fn(),
  refresh: vi.fn(),
  list: null as null | Record<string, unknown>,
  params: { projectId: 'p1', projectName: 'Cindy 手机端', deviceId: 'mac', deviceName: 'Mac' } as Record<string, string>,
  link: {
    invoke: vi.fn(), openLink: vi.fn(async () => {}), status: 'online',
    getPresenceAvailability: () => true as boolean | undefined, presenceVersion: 1,
    onRemoteResourceChanged: (callback: (deviceId: string, payload: unknown) => void) => { h.pushChanged = callback; return () => {}; },
  },
  uuid: 0,
  pushChanged: null as null | ((deviceId: string, payload: unknown) => void),
}));

vi.mock('expo-crypto', () => ({ randomUUID: () => `request-${++h.uuid}` }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key, i18n: { language: 'zh-CN' } }) }));
vi.mock('react-native', async () => {
  const { createElement } = await import('react');
  const view = ({ children, testID }: { children?: ReactNode; testID?: string }) => createElement('div', { 'data-testid': testID }, children);
  return {
    ActivityIndicator: ({ testID }: { testID?: string }) => createElement('i', { 'data-testid': testID }),
    Alert: { alert: (...args: unknown[]) => h.alert(...args) },
    AppState: { currentState: 'active', addEventListener: () => ({ remove() {} }) },
    FlatList: ({ data, renderItem, ListEmptyComponent, ListHeaderComponent, keyExtractor }: any) => {
      const rows = (data ?? []).map((item: unknown, index: number) => createElement('div', { key: keyExtractor ? keyExtractor(item) : index },
        renderItem({ item, index })));
      return createElement('div', {}, ListHeaderComponent ?? null, rows.length ? rows : (ListEmptyComponent ?? null));
    },
    Modal: ({ children }: { children?: ReactNode }) => createElement('div', {}, children),
    Pressable: ({ children, testID, disabled, onPress, accessibilityLabel }: any) =>
      createElement('button', { 'data-testid': testID, 'aria-label': accessibilityLabel, disabled, onClick: disabled ? undefined : onPress }, children),
    RefreshControl: () => null,
    ScrollView: view,
    StyleSheet: { create: (value: unknown) => value, hairlineWidth: 1 },
    TextInput: ({ value, onChangeText, testID, accessibilityLabel }: any) =>
      createElement('input', { 'data-testid': testID, 'aria-label': accessibilityLabel, value,
        onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
    View: view,
  };
});
vi.mock('expo-router', async () => {
  const { useEffect } = await import('react');
  return {
    Redirect: () => null,
    useFocusEffect: (effect: () => void | (() => void)) => useEffect(effect, [effect]),
    useLocalSearchParams: () => h.params,
    useRouter: () => ({ push: h.push, replace: h.push, back: vi.fn() }),
  };
});
vi.mock('react-native-safe-area-context', async () => {
  const { createElement } = await import('react');
  return { SafeAreaView: ({ children }: { children?: ReactNode }) => createElement('div', {}, children) };
});
vi.mock('@/components/AppText', async () => {
  const { createElement } = await import('react');
  return {
    Text: ({ children, testID, accessibilityRole }: any) => createElement('span', { 'data-testid': testID, role: accessibilityRole }, children),
    TextInput: ({ value, onChangeText, testID }: any) => createElement('input', { 'data-testid': testID, value,
      onChange: (event: { target: { value: string } }) => onChangeText(event.target.value) }),
  };
});
vi.mock('@/components/MobilePrimitives', async () => {
  const { createElement } = await import('react');
  return {
    MainWindowActionButton: ({ action }: any) => createElement('button', {
      'data-testid': action.testID, disabled: action.disabled || action.busy, onClick: action.onPress,
    }, action.label),
    MainWindowEmptyState: ({ copy, testID, title, children }: any) => createElement('div', { 'data-testid': testID }, title, copy, children),
    MainWindowMetric: ({ label, testID, value }: any) => createElement('span', { 'data-testid': testID }, `${label}:${value}`),
    MainWindowOptionButton: ({ label, onPress, selected, disabled, testID }: any) => createElement('button', {
      'data-testid': testID, disabled, 'aria-pressed': selected, onClick: disabled ? undefined : onPress,
    }, label),
    RemoteListSyncingPlaceholder: () => null,
  };
});
vi.mock('@/platform/chrome', () => ({
  SimpleStackHeader: () => null,
  simpleScreenSafeAreaEdges: () => [],
  simpleScrollInsetProps: {},
  simpleScrollScreenSafeAreaEdges: () => [],
}));
vi.mock('@/theme', async () => {
  const tokens = await import('@/theme/tokens');
  return {
    ...tokens,
    useTheme: () => ({ colors: tokens.lightColors }),
    useThemedStyles: (factory: (colors: typeof tokens.lightColors) => unknown) => factory(tokens.lightColors),
  };
});
vi.mock('@/theme/tokens', async () => await vi.importActual<typeof import('@/theme/tokens')>('@/theme/tokens'));
vi.mock('@/auth/AuthContext', () => ({ useAuth: () => ({ user: { id: 'owner' }, accountGeneration: 1 }) }));
vi.mock('@/utils/backGuard', () => ({ goBackGuarded: vi.fn() }));
vi.mock('@/utils/useGuardedPush', () => ({ useGuardedPush: () => h.push }));
vi.mock('@/device-link/DeviceLinkContext', () => ({ useDeviceLink: () => h.link }));
vi.mock('@/device-link/remoteResourceCache', () => ({ readRemoteResourceSnapshot: async () => ({ home: [], items: {} }) }));
vi.mock('@/device-link/remoteStatus', () => ({
  formatRemoteError: (error: unknown) => String((error as { message?: string })?.message ?? error),
  humanizeRemoteError: (error: unknown) => String((error as { message?: string })?.message ?? error),
  isAutoRecoveringRemoteError: () => false,
}));
vi.mock('@/device-link/remoteResources', async (importOriginal) => ({
  ...await importOriginal<typeof import('@/device-link/remoteResources')>(),
  getRemoteResource: (...args: unknown[]) => h.get(...args),
  invokeRemoteResourceAction: (...args: unknown[]) => h.action(...args),
}));
vi.mock('@/session/CompanionSheet', async () => {
  const { createElement } = await import('react');
  return {
    CompanionSheet: ({ children, title, testID, visible }: any) =>
      visible ? createElement('div', { 'data-testid': testID ?? 'sheet' }, title, children) : null,
  };
});
vi.mock('@/session/useRemoteResourceList', () => ({ useRemoteResourceList: () => h.list }));
vi.mock('lucide-react-native', () => ({ ChevronRight: () => null, RefreshCw: () => null, FolderKanban: () => null }));

import ProjectsScreen from '../../app/projects/index';
import ProjectDetailScreen from '../../app/projects/[projectId]';

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const projectRef = { collectionId: 'projects', kind: 'project', id: 'p1' };

function detailResource(overrides: Record<string, unknown> = {}) {
  return {
    ref: projectRef,
    revision: '8',
    links: [],
    display: { title: 'Cindy 手机端' },
    actions: [
      { id: 'project.recordProgress', label: '记录进度' },
      { id: 'project.setAssignee', label: '设置处理人' },
      { id: 'project.archive', label: '归档项目' },
      { id: 'project.unknownAction', label: '未知动作' },
    ],
    blocks: [
      { id: 's', primitive: 'project-summary', fallbackMarkdown: 'summary fallback',
        data: { projectId: 'p1', name: 'Cindy 手机端', goal: '把项目页跑通', owner: { kind: 'account', id: 'a1', name: '小明' }, status: 'active', updatedAt: 1_700_000_000_000 } },
      { id: 'p', primitive: 'project-progress', fallbackMarkdown: 'progress fallback',
        data: { counts: { todo: 1, doing: 2, blocked: 0, review: 1, done: 3 },
          events: [{ id: 'e1', sessionId: 's1', title: '写页面', from: 'doing', to: 'review', at: 1_700_000_100_000, actorName: '小红', note: '等确认' }] } },
      { id: 'w', primitive: 'project-work-items', fallbackMarkdown: 'items fallback',
        data: { items: [{ sessionId: 's1', title: '写页面', status: 'review', assignee: { kind: 'bot', id: 'b1', name: '阿蓝' }, bindingRevision: 4, progressRevision: 2, updatedAt: 1_700_000_100_000 }] } },
      { id: 'm', primitive: 'project-members', fallbackMarkdown: 'members fallback',
        data: { members: [{ kind: 'account', id: 'a1', name: '小明', role: 'owner' }, { kind: 'bot', id: 'b1', name: 'bot:b1', role: 'member' }] } },
      { id: 'g', primitive: 'project-group-link', fallbackMarkdown: 'group fallback', data: { groupName: '项目群', status: 'active' } },
      { id: 'future', primitive: 'project-timeline', fallbackMarkdown: '未来的时间线说明' },
    ],
    ...overrides,
  };
}

let container: HTMLDivElement;
let root: Root;
const $ = (testID: string) => container.querySelector<HTMLElement>(`[data-testid="${testID}"]`);
const click = async (testID: string) => {
  const node = $(testID);
  expect(node, `${testID} 应存在`).not.toBeNull();
  await act(async () => { node!.click(); });
};
const type = async (testID: string, value: string) => {
  const node = $(testID) as HTMLInputElement;
  await act(async () => {
    const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!;
    setter.call(node, value);
    node.dispatchEvent(new Event('input', { bubbles: true }));
  });
};

beforeEach(() => {
  vi.clearAllMocks();
  h.uuid = 0;
  h.link.status = 'online';
  h.link.getPresenceAvailability = () => true;
  container = document.createElement('div');
  root = createRoot(container);
});

afterEach(() => {
  act(() => root.unmount());
});

function listState(overrides: Record<string, unknown> = {}) {
  return {
    items: [{
      key: 'mac:p1',
      host: { deviceId: 'mac', deviceName: 'Mac' },
      item: {
        ref: projectRef, revision: '8', links: [],
        display: {
          title: 'Cindy 手机端',
          subtitle: '把项目页跑通',
          status: { label: '进行中', tone: 'positive' },
          timestamp: 1_700_000_000_000,
          badges: [{ label: '3 位成员', accessibilityLabel: '3 位成员,查看成员' }, { label: '5 个任务', accessibilityLabel: '5 个任务' }],
        },
      },
    }, {
      key: 'mac:p2',
      host: { deviceId: 'mac', deviceName: 'Mac' },
      item: {
        ref: { collectionId: 'projects', kind: 'project', id: 'p2' }, revision: '3', links: [],
        display: { title: 'local-v1:p2', subtitle: '/Users/ming/secret/work' },
      },
    }],
    loading: false, refreshing: false, error: null,
    isOnline: () => true, refresh: h.refresh,
    ...overrides,
  };
}

it('列表显示项目名、目标、状态、成员/任务数与更新时间,点按进入详情', async () => {
  h.list = listState();
  await act(async () => root.render(el(ProjectsScreen)));
  expect($('projects.item.p1')?.textContent).toContain('Cindy 手机端');
  expect($('projects.item.p1.goal')?.textContent).toBe('把项目页跑通');
  expect($('projects.item.p1')?.textContent).toContain('进行中');
  const meta = $('projects.item.p1.meta')?.textContent ?? '';
  expect(meta).toContain('3 位成员');
  expect(meta).toContain('5 个任务');
  // 契约 §2:绝对路径不进目标摘要,原始 id 不进标题(手机端自己兜一层,不依赖桌面过滤)。
  expect($('projects.item.p2.goal')?.textContent).toBe('projects.goal.none');
  expect($('projects.item.p2')?.textContent).toContain('projects.title');
  await click('projects.item.p1');
  expect(h.push).toHaveBeenCalledWith(expect.objectContaining({
    pathname: '/projects/[projectId]',
    params: expect.objectContaining({ projectId: 'p1', deviceId: 'mac', projectName: 'Cindy 手机端' }),
  }));
});

it('列表空态与失败态:失败给可读原因并能重试', async () => {
  h.list = listState({ items: [] });
  await act(async () => root.render(el(ProjectsScreen)));
  expect($('projects.empty')).not.toBeNull();
  await act(async () => root.render(el(ProjectsScreen)));
  act(() => root.unmount());
  root = createRoot(container);
  h.list = listState({ items: [], error: '电脑已离线' });
  await act(async () => root.render(el(ProjectsScreen)));
  expect($('projects.error')?.textContent).toContain('电脑已离线');
  await click('projects.retry');
  expect(h.refresh).toHaveBeenCalledWith(true);
});

it('列表里离线的电脑不能点开项目', async () => {
  h.list = listState({ isOnline: () => false });
  await act(async () => root.render(el(ProjectsScreen)));
  await click('projects.item.p1');
  expect(h.push).not.toHaveBeenCalled();
});

it('详情按契约顺序渲染五个 block,未知 primitive 走 fallbackMarkdown', async () => {
  h.get.mockResolvedValue(detailResource());
  await act(async () => root.render(el(ProjectDetailScreen)));
  expect($('projectDetail.summary')?.textContent).toContain('把项目页跑通');
  expect($('projectDetail.summary')?.textContent).toContain('小明');
  expect($('projectDetail.summary.status')?.textContent).toBe('projects.status.active');
  expect($('projectDetail.progress.count.done')?.textContent).toBe('projects.progress.stage.done:3');
  expect($('projectDetail.progress.event.e1')?.textContent).toContain('写页面');
  expect($('projectDetail.workItem.s1')?.textContent).toContain('阿蓝');
  expect($('projectDetail.member.account.a1')?.textContent).toContain('projects.members.owner');
  // 契约 §3:名称解析失败时给可读兜底,不把 `bot:` 原始 id 显示出来。
  expect($('projectDetail.member.bot.b1')?.textContent).toContain('projects.members.unknown');
  expect($('projectDetail.member.bot.b1')?.textContent).not.toContain('bot:b1');
  expect($('projectDetail.groupLink')?.textContent).toContain('项目群');
  expect($('projectDetail.fallback.project-timeline')?.textContent).toBe('未来的时间线说明');
  // 只渲染契约里的四个动作,未知动作不出现。
  expect($('projectDetail.action.project.archive')).not.toBeNull();
  expect($('projectDetail.action.project.unknownAction')).toBeNull();
});

it('归档必须二次确认,确认后带稳定 requestId 提交并重读详情', async () => {
  h.get.mockResolvedValue(detailResource());
  h.action.mockResolvedValue({ ok: true, effects: [] });
  await act(async () => root.render(el(ProjectDetailScreen)));
  h.get.mockClear();
  await click('projectDetail.action.project.archive');
  // 未确认前不发请求。
  expect(h.action).not.toHaveBeenCalled();
  expect(h.alert).toHaveBeenCalledTimes(1);
  const [title, body, buttons] = h.alert.mock.calls[0];
  expect(title).toBe('projects.confirm.archiveTitle');
  expect(body).toBe('projects.confirm.archiveBody');
  await act(async () => { buttons[1].onPress(); });
  expect(h.action).toHaveBeenCalledWith(h.link.invoke, { deviceId: 'mac', deviceName: 'Mac' }, expect.objectContaining({
    actionId: 'project.archive',
    resourceRef: projectRef,
    // 契约 §4:归档类动作的 `confirmation` 必填,只有界面上问过用户才会带上。
    input: { confirmation: true, requestId: 'request-1' },
  }), 'zh-CN');
  expect(h.get).toHaveBeenCalledTimes(1);
});

it('归档被拒时显示可读原因,已有内容不清空', async () => {
  h.get.mockResolvedValue(detailResource());
  h.action.mockRejectedValue(new Error('[NOT_PROJECT_OWNER] only the owner can archive'));
  await act(async () => root.render(el(ProjectDetailScreen)));
  await click('projectDetail.action.project.archive');
  await act(async () => { h.alert.mock.calls[0][2][1].onPress(); });
  expect($('projectDetail.actionError')?.textContent).toBe('projects.errors.NOT_PROJECT_OWNER');
  expect($('projectDetail.summary')?.textContent).toContain('把项目页跑通');
});

it('断线时动作禁用并说明原因', async () => {
  h.link.status = 'stopped';
  h.get.mockResolvedValue(detailResource());
  await act(async () => root.render(el(ProjectDetailScreen)));
  expect($('projectDetail.offline')?.textContent).toBe('projects.form.offline');
  expect($('projectDetail.action.project.recordProgress')?.hasAttribute('disabled')).toBe(true);
});

it('宿主的 REMOTE_RESOURCE_CHANGED 走既有刷新路径,与写后重读在途时合并为一次', async () => {
  h.get.mockResolvedValue(detailResource());
  await act(async () => root.render(el(ProjectDetailScreen)));
  expect(h.pushChanged).not.toBeNull();
  let release!: (value: unknown) => void;
  h.get.mockImplementationOnce(() => new Promise((resolve) => { release = resolve; }));
  await act(async () => {
    h.pushChanged!('mac', { collectionId: 'projects', resourceRefs: [projectRef] });
  });
  // 同一次写入的第二条推送落在在途请求上:不再发第二次 RPC。
  await act(async () => {
    h.pushChanged!('mac', { collectionId: 'projects', resourceRefs: [projectRef] });
  });
  expect(h.get).toHaveBeenCalledTimes(2);
  await act(async () => { release(detailResource({ revision: '9' })); });
  expect($('projectDetail.summary')).not.toBeNull();
});

it('记录进度:到 done 提示只有负责人能确认,补全说明后才能提交', async () => {
  h.get.mockResolvedValue(detailResource());
  h.action.mockResolvedValue({ ok: true, effects: [] });
  await act(async () => root.render(el(ProjectDetailScreen)));
  await click('projectDetail.action.project.recordProgress');
  expect($('projects.actionSheet')).not.toBeNull();
  // 只有一个任务时默认选中它;review → done 允许直接确认。
  await click('projects.form.stage.done');
  expect($('projects.form.doneOwnerOnly')?.textContent).toBe('projects.form.doneOwnerOnly');
  expect($('projects.form.submit')?.hasAttribute('disabled')).toBe(true);
  await type('projects.form.completionNote', '评审通过');
  await click('projects.form.submit');
  expect(h.action).toHaveBeenCalledWith(h.link.invoke, expect.anything(), expect.objectContaining({
    actionId: 'project.recordProgress',
    input: { sessionId: 's1', to: 'done', expectedRevision: 2, expectedBindingRevision: 4, completionNote: '评审通过', requestId: 'request-1' },
  }), 'zh-CN');
});

it('设置处理人:可以选「未分配」,请求带 assignee null', async () => {
  h.get.mockResolvedValue(detailResource());
  h.action.mockResolvedValue({ ok: true, effects: [] });
  await act(async () => root.render(el(ProjectDetailScreen)));
  await click('projectDetail.action.project.setAssignee');
  await click('projects.form.assignee.__none__');
  await click('projects.form.submit');
  expect(h.action).toHaveBeenCalledWith(h.link.invoke, expect.anything(), expect.objectContaining({
    actionId: 'project.setAssignee',
    input: { sessionId: 's1', assignee: null, requestId: 'request-1' },
  }), 'zh-CN');
});

it('写动作失败后保留表单内容并显示可读原因', async () => {
  h.get.mockResolvedValue(detailResource());
  h.action.mockRejectedValue(new Error('[PRECONDITION_FAILED] revision changed'));
  await act(async () => root.render(el(ProjectDetailScreen)));
  await click('projectDetail.action.project.recordProgress');
  await click('projects.form.stage.doing');
  await click('projects.form.submit');
  expect($('projects.form.error')?.textContent).toBe('projects.errors.PRECONDITION_FAILED');
  // 任务选择与阶段都还在,可以直接重试。
  expect($('projects.form.stage.doing')?.getAttribute('aria-pressed')).toBe('true');
  expect($('projects.form.submit')).not.toBeNull();
});
