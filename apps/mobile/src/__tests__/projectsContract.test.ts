/**
 * 测试价值
 * - 生产入口与可观察结果:`projectRowView` / `projectDetailView` / `progressInput` /
 *   `assigneeInput` / `projectErrorKey` / `createProjectActionRunner`。手机端项目页拿到的
 *   字段、未知 primitive 的回落、写动作请求体与重试期间的 requestId 都由它们决定。
 * - Bug／规则依据:`documents/2026-11-11-手机端项目页接口契约.md` §2/§3/§4/§5;宿主
 *   `workItemProgressTx` 对多余字段判 INVALID_PARAMS、blocked/done 的备注必填。
 * - 现有覆盖缺口:`remoteResources.test.ts` 只覆盖集合发现;项目 block 投影与写请求体
 *   此前没有任何覆盖。
 * - 最小失败输入:徽标只有 `label` 没有 `accessibilityLabel`、未知 primitive、
 *   `to=blocked` 缺 `unblockCondition`、宿主 resolve 出 `{ ok:false, errorCode }`、
 *   同一请求重试两次。
 * - tier:unit(node,无 React/DOM)。
 */
import { beforeEach, expect, it, vi } from 'vitest';

const h = vi.hoisted(() => ({ invoke: vi.fn() }));
vi.mock('@/device-link/remoteResources', () => ({ invokeRemoteResourceAction: (...args: unknown[]) => h.invoke(...args) }));

import { createProjectActionRunner } from '../projects/projectActions';
import {
  assigneeInput,
  canRecordStage,
  emptyProgressDraft,
  projectDetailView,
  projectErrorKey,
  projectRowView,
  progressInput,
  progressMissingFields,
  progressRequirements,
  readableSubjectName,
  type ProgressDraft,
} from '../projects/projectModel';
import type { RemoteResource } from '@cindy/device-link';

beforeEach(() => {
  vi.clearAllMocks();
});

const ref = { collectionId: 'projects', kind: 'project', id: 'p1' };

function resource(blocks: RemoteResource['blocks'], actions: RemoteResource['actions'] = []): RemoteResource {
  return { ref, revision: '7', links: [], display: { title: 'Cindy' }, blocks, actions };
}

it('放映列表摘要:徽标只给可见文案时仍然显示成员/任务数,归档按 neutral 判定', () => {
  const row = projectRowView({
    ref,
    revision: '7',
    links: [],
    display: {
      title: 'Cindy 手机端',
      subtitle: '把项目页跑通',
      status: { label: { fallback: '已归档' }, tone: 'neutral' },
      timestamp: 1_700_000_000_000,
      badges: [{ label: '3 位成员', accessibilityLabel: '3 位成员,查看成员' }, { accessibilityLabel: '无可见文案' }],
    },
  }, 'zh-CN');
  expect(row).toMatchObject({
    title: 'Cindy 手机端',
    goal: '把项目页跑通',
    statusLabel: '已归档',
    archived: true,
    badges: ['3 位成员'],
    updatedAt: 1_700_000_000_000,
  });
});

it('按契约 §3 投影五个 block 的字段', () => {
  const view = projectDetailView(resource([
    {
      id: 'summary', primitive: 'project-summary', fallbackMarkdown: 'fallback summary',
      data: { projectId: 'p1', name: '项目甲', goal: '跑通链路', owner: { kind: 'account', id: 'a1', name: '小明' }, status: 'archived', updatedAt: 11 },
    },
    {
      id: 'progress', primitive: 'project-progress', fallbackMarkdown: 'fallback progress',
      data: {
        counts: { todo: 1, doing: 2, blocked: 0, review: 1, done: 3 },
        events: [{ id: 9, sessionId: 's1', title: '写页面', from: 'doing', to: 'review', at: 12, actorName: '小红', note: '等确认' }],
      },
    },
    {
      id: 'items', primitive: 'project-work-items', fallbackMarkdown: 'fallback items',
      data: { items: [{ sessionId: 's1', title: '写页面', taskObjective: '列表页', status: 'review', assignee: { kind: 'bot', id: 'b1', name: '阿蓝' }, bindingRevision: 4, updatedAt: 13 }] },
    },
    {
      id: 'members', primitive: 'project-members', fallbackMarkdown: 'fallback members',
      data: { members: [{ kind: 'account', id: 'a1', name: '小明', role: 'owner' }] },
    },
    {
      id: 'group', primitive: 'project-group-link', fallbackMarkdown: 'fallback group',
      data: { groupName: '项目群', status: 'active', revision: '3' },
    },
  ]), 'zh-CN');

  expect(view.sections.map((section) => section.kind)).toEqual(['summary', 'progress', 'work-items', 'members', 'group-link']);
  expect(view.sections[0]).toMatchObject({ kind: 'summary', view: { name: '项目甲', goal: '跑通链路', archived: true, owner: { name: '小明' } } });
  expect(view.sections[1]).toMatchObject({
    kind: 'progress',
    view: { counts: { todo: 1, doing: 2, blocked: 0, review: 1, done: 3 }, events: [{ id: '9', from: 'doing', to: 'review', actorName: '小红', note: '等确认' }] },
  });
  expect(view.workItems).toEqual([{
    sessionId: 's1', title: '写页面', objective: '列表页', status: 'review',
    assignee: { kind: 'bot', id: 'b1', name: '阿蓝' }, bindingRevision: 4, progressRevision: null, updatedAt: 13,
  }]);
  expect(view.members).toEqual([{ kind: 'account', id: 'a1', name: '小明', role: 'owner' }]);
  expect(view.sections[4]).toMatchObject({ kind: 'group-link', view: { groupName: '项目群', status: 'active' } });
});

it('列表标题/目标里的路径与原始 id 不进入展示字段', () => {
  const row = projectRowView({
    ref, revision: '1', links: [],
    display: { title: 'local-v1:p1', subtitle: '/Users/ming/secret' },
  }, 'zh-CN');
  expect(row).toMatchObject({ title: null, goal: null });
  expect(projectRowView({
    ref, revision: '1', links: [],
    display: { title: 'Cindy', subtitle: '把项目页跑通' },
  }, 'zh-CN')).toMatchObject({ title: 'Cindy', goal: '把项目页跑通' });
});

it('未知 primitive 与不合法的 data 都只回落到宿主的 fallbackMarkdown', () => {
  const view = projectDetailView(resource([
    { id: 'future', primitive: 'project-future', fallbackMarkdown: '给老控制器的说明' },
    { id: 'broken', primitive: 'project-work-items', fallbackMarkdown: '任务读取失败', data: { items: 'not-an-array' } },
    { id: 'empty', primitive: 'project-group-link', fallbackMarkdown: '' },
    // 群名是服务端点明文:按不合法 data 处理,只显示宿主写的回落文本。
    { id: 'leaky', primitive: 'project-group-link', fallbackMarkdown: '群信息不可用', data: { groupName: '!r1:chat.cindy.app' } },
  ]), 'zh-CN');
  expect(view.sections).toEqual([
    { kind: 'fallback', id: 'future', primitive: 'project-future', markdown: '给老控制器的说明' },
    { kind: 'fallback', id: 'broken', primitive: 'project-work-items', markdown: '任务读取失败' },
    { kind: 'fallback', id: 'empty', primitive: 'project-group-link', markdown: '' },
    { kind: 'fallback', id: 'leaky', primitive: 'project-group-link', markdown: '群信息不可用' },
  ]);
  expect(view.workItems).toEqual([]);
  expect(view.members).toEqual([]);
});

// 契约 §2/§3:手机端自己也要挡住内部 id、绝对路径、服务端点与 roomId 明文,
// 不能只依赖被控端过滤;挡不住的取值一律换成可读兜底。
it.each([
  'account:a1',
  'bot:b1',
  'bot-group:g1',
  'local-v1:abc',
  '/Users/ming/secret/work',
  'C:\\Users\\ming\\secret',
  '~/secret',
  'https://chat.cindy.app/room',
  '!room123:chat.cindy.app',
  '#alias:server',
  '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
  'bot_0123456789abcdef',
])('不把 %s 当作可读文案', (value) => {
  expect(readableSubjectName(value)).toBeNull();
});
it('正常名字照常展示', () => {
  expect(readableSubjectName('小明')).toBe('小明');
  expect(readableSubjectName('Cindy 手机端')).toBe('Cindy 手机端');
});

it.each([
  { from: null, to: 'doing', required: { reason: false, unblockCondition: false, resolution: false, completionNote: false } },
  { from: 'doing', to: 'blocked', required: { reason: true, unblockCondition: true, resolution: false, completionNote: false } },
  { from: 'blocked', to: 'doing', required: { reason: false, unblockCondition: false, resolution: true, completionNote: false } },
  { from: 'review', to: 'done', required: { reason: false, unblockCondition: false, resolution: false, completionNote: true } },
] as const)('阶段 $from → $to 的必填项与请求体一致', ({ from, to, required }) => {
  expect(progressRequirements(from, to)).toEqual(required);
  const draft: ProgressDraft = {
    sessionId: 's1', to, reason: ' 缺文件 ', unblockCondition: '拿到文件', resolution: '已解除', completionNote: '已完成',
  };
  const item = {
    sessionId: 's1', title: '写页面', objective: null, status: from, assignee: null,
    bindingRevision: 4, progressRevision: 2, updatedAt: null,
  };
  expect(progressPresent(progressInput(draft, item))).toEqual(progressPresent({
    sessionId: 's1',
    to,
    expectedRevision: 2,
    expectedBindingRevision: 4,
    ...(required.reason ? { reason: '缺文件', unblockCondition: '拿到文件' } : {}),
    ...(required.resolution ? { resolution: '已解除' } : {}),
    ...(required.completionNote ? { completionNote: '已完成' } : {}),
  }));
  // 缺必填项时表单会拦住提交(不把注定被拒的请求发出去)。
  const empty = { ...emptyProgressDraft('s1', from), to };
  expect(progressMissingFields(empty, from).length).toBe(
    (required.reason ? 1 : 0) + (required.unblockCondition ? 1 : 0) + (required.resolution ? 1 : 0) + (required.completionNote ? 1 : 0),
  );
});

function progressPresent(input: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(Object.entries(input).sort(([a], [b]) => a.localeCompare(b)));
}

it('转移图与宿主冻结图一致:不能从 done 直接回到 review', () => {
  expect(canRecordStage('done', 'review')).toBe(false);
  expect(canRecordStage('done', 'doing')).toBe(true);
  expect(canRecordStage(null, 'done')).toBe(true);
});

it('处理人用成员引用,未分配用 null', () => {
  expect(assigneeInput('s1', { kind: 'bot', id: 'b1', name: '阿蓝' })).toEqual({ sessionId: 's1', assignee: { kind: 'bot', id: 'b1' } });
  expect(assigneeInput('s1', null)).toEqual({ sessionId: 's1', assignee: null });
});

it('宿主拒绝码翻成可读 key,未登记的码交给通用远端文案', () => {
  expect(projectErrorKey(new Error('[NOT_PROJECT_OWNER] only the owner confirms'))).toBe('projects.errors.NOT_PROJECT_OWNER');
  expect(projectErrorKey('IPC_ERROR PRECONDITION_FAILED')).toBe('projects.errors.PRECONDITION_FAILED');
  expect(projectErrorKey('DEVICE_OFFLINE')).toBeNull();
  expect(projectErrorKey(null)).toBeNull();
});

// ---------------------------------------------------------------- 写动作调用层

function runner() {
  let sequence = 0;
  return createProjectActionRunner({
    host: { deviceId: 'mac', deviceName: 'Mac' },
    invoke: vi.fn() as never,
    locale: 'zh-CN',
    newRequestId: () => `request-${++sequence}`,
    resourceRef: ref,
  });
}

it('写动作成功:请求带 requestId,成功后不再复用该 id', async () => {
  h.invoke.mockResolvedValue({ ok: true, effects: [] });
  const action = runner();
  expect(await action.submit('project.archive', {})).toEqual({ ok: true });
  expect(h.invoke).toHaveBeenLastCalledWith(expect.anything(), { deviceId: 'mac', deviceName: 'Mac' }, expect.objectContaining({
    collectionId: 'projects', actionId: 'project.archive', resourceRef: ref, input: { requestId: 'request-1' },
  }), 'zh-CN');
  await action.submit('project.archive', {});
  expect(h.invoke.mock.calls[1][2].input).toEqual({ requestId: 'request-2' });
});

it('同一动作同一输入重试复用 requestId;输入变了换新的', async () => {
  h.invoke.mockResolvedValueOnce({ ok: false, errorCode: 'UNAVAILABLE', message: 'busy' });
  const action = runner();
  expect(await action.submit('project.recordProgress', { sessionId: 's1', to: 'doing' })).toEqual({ ok: false, error: expect.any(Error) });
  await action.submit('project.recordProgress', { sessionId: 's1', to: 'doing' });
  expect(h.invoke.mock.calls[1][2].input).toEqual({ sessionId: 's1', to: 'doing', requestId: 'request-1' });
  await action.submit('project.recordProgress', { sessionId: 's1', to: 'review' });
  expect(h.invoke.mock.calls[2][2].input).toEqual({ sessionId: 's1', to: 'review', requestId: 'request-2' });
});

it('网络失败作为拒绝结果返回,便于页面保留已填内容', async () => {
  h.invoke.mockRejectedValue(new Error('DEVICE_OFFLINE'));
  expect(await runner().submit('project.setAssignee', { sessionId: 's1', assignee: null }))
    .toEqual({ ok: false, error: expect.objectContaining({ message: 'DEVICE_OFFLINE' }) });
});
