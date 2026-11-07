/**
 * 项目内核 M1 界面证据：侧栏项目段 / 项目详情 / 新建项目 / 新建任务归属项目。
 *
 * 全部渲染真实产品组件（含 `groupSessions` 真实分组、`ProjectDetailPage` 真实路由），
 * 只把 main 的 IPC 投影替换成场景数据。任务绑定与成员规则的真实校验在服务层单测
 * (`apps/desktop/src/main/localDb/__tests__/projects.test.ts`) 里验证。
 */
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import { MemoryRouter, Route, Routes } from 'react-router-dom';

import { mountPage, subscription } from '../../ui-page/harness';
import { groupSessions } from '../../../src/renderer/features/cc-agent/lib/projectGrouping';
import { EntityProjectsSection } from '../../../src/renderer/features/projects/EntityProjectsSection';
import { NewProjectDialog } from '../../../src/renderer/features/projects/NewProjectDialog';
import { ProjectBindingSelect } from '../../../src/renderer/features/projects/ProjectBindingSelect';
import { ProjectDetailPage } from '../../../src/renderer/features/projects/ProjectDetailPage';
import type { Session } from '../../../src/renderer/lib/ccAgent.types';
import type { ProjectDetail, ProjectRecord, ProjectsAction } from '../../../src/shared/projects';

let seq = 0;
function task(partial: Partial<Session> & { projectId?: string | null }): Session {
  seq += 1;
  return {
    id: partial.id ?? `task-${seq}`,
    userId: '',
    title: partial.title ?? `任务 ${seq}`,
    workingDir: partial.workingDir ?? '/Users/chris/Projects/cindy',
    projectDir: null,
    projectId: partial.projectId ?? null,
    assigneeKind: partial.assigneeKind,
    assigneeId: partial.assigneeId,
    workspaceKind: 'project',
    model: 'claude-sonnet-4-6',
    effort: 'high' as Session['effort'],
    permissionMode: 'ask' as Session['permissionMode'],
    sdkSessionId: null,
    totalTokenUsage: 0,
    totalCostUsd: 0,
    contextTokens: 0,
    contextWindow: 0,
    fastMode: false,
    clearedAt: null,
    pinnedAt: null,
    userSendAt: partial.updatedAt ?? '2026-11-05T08:00:00.000Z',
    status: partial.status ?? 'active',
    agentKind: partial.agentKind ?? 'cc',
    extraDirs: [],
    createdAt: partial.createdAt ?? '2026-11-04T08:00:00.000Z',
    updatedAt: partial.updatedAt ?? '2026-11-05T08:00:00.000Z',
    _count: partial._count ?? { messages: 4 },
    ...partial,
  } as Session;
}

const account = { kind: 'account' as const, id: 'acc-1', displayName: 'Chris', avatar: null, avatarColor: null };
const filo = { kind: 'bot' as const, id: 'bot-filo', displayName: 'Filo', avatar: '🦊', avatarColor: 'orange' };
const scout = { kind: 'bot' as const, id: 'bot-scout', displayName: 'Scout', avatar: '🛰️', avatarColor: 'blue' };

const projects: ProjectRecord[] = [
  {
    id: 'p-core',
    name: 'Cindy 项目内核',
    goal: '把项目做成一等实体：成员、负责人、任务绑定都落在数据里，替代按目录归组。',
    ownerId: 'acc-1',
    status: 'active',
    members: [
      { subject: account, role: 'owner', addedAt: '2026-11-01T02:00:00.000Z' },
      { subject: filo, role: 'member', addedAt: '2026-11-01T02:05:00.000Z' },
      { subject: scout, role: 'member', addedAt: '2026-11-02T02:05:00.000Z' },
    ],
    taskCount: 3,
    dirs: [{ dirKey: 'local:F:/sourcecode/anber/cindy', dirPath: 'F:/sourcecode/anber/cindy' }],
    createdAt: '2026-11-01T02:00:00.000Z',
    updatedAt: '2026-11-05T07:40:00.000Z',
  },
  {
    id: 'p-design',
    name: '设计系统迁移',
    goal: '半径与字号统一，视觉门禁先落地。',
    ownerId: 'bot-filo',
    status: 'active',
    members: [
      { subject: filo, role: 'owner', addedAt: '2026-10-28T02:00:00.000Z' },
      { subject: account, role: 'member', addedAt: '2026-10-28T02:10:00.000Z' },
    ],
    taskCount: 1,
    dirs: [{ dirKey: 'local:F:/sourcecode/anber/cindy-design', dirPath: 'F:/sourcecode/anber/cindy-design' }],
    createdAt: '2026-10-28T02:00:00.000Z',
    updatedAt: '2026-11-04T09:10:00.000Z',
  },
  {
    id: 'p-empty',
    name: '材料与版本（待启动）',
    goal: null,
    ownerId: 'acc-1',
    status: 'active',
    members: [{ subject: account, role: 'owner', addedAt: '2026-11-05T06:00:00.000Z' }],
    taskCount: 0,
    dirs: [],
    createdAt: '2026-11-05T06:00:00.000Z',
    updatedAt: '2026-11-05T06:00:00.000Z',
  },
];

const sessions: Session[] = [
  task({ id: 't1', title: '项目 schema 与 migration', projectId: 'p-core', updatedAt: '2026-11-05T07:40:00.000Z' }),
  task({ id: 't2', title: '负责人守卫与转交', projectId: 'p-core', updatedAt: '2026-11-05T05:20:00.000Z' }),
  task({ id: 't3', title: '侧栏按实体项目归组', projectId: 'p-core', updatedAt: '2026-11-04T10:00:00.000Z', status: 'archived' }),
  task({ id: 't4', title: '迁移设计系统半径 token', projectId: 'p-design', updatedAt: '2026-11-04T09:10:00.000Z' }),
  // 没有实体绑定的旧任务：仍然按目录分组（互不吞并）。
  task({ id: 't5', title: '旧的目录分组任务', updatedAt: '2026-11-03T09:10:00.000Z' }),
];

const detail: ProjectDetail = {
  project: projects[0],
  workItems: [
    { sessionId: 't1', title: '项目 schema 与 migration', status: 'active', assignee: account, updatedAt: '2026-11-05T07:40:00.000Z' },
    { sessionId: 't2', title: '负责人守卫与转交', status: 'active', assignee: filo, updatedAt: '2026-11-05T05:20:00.000Z' },
    { sessionId: 't3', title: '侧栏按实体项目归组', status: 'archived', assignee: null, updatedAt: '2026-11-04T10:00:00.000Z' },
  ],
};

const noop = (): void => undefined;
const emptySet = new Set<string>();
const emptyMap = new Map();

mountPage({
  cases: ['sidebar', 'detail', 'create', 'binding', 'metadata', 'metadata-wide'],
  host: () => { setDataOwnerGeneration('acc-1', 1); return ({
    localDb: {
      projects: {
        list: async () => projects,
        detail: async () => detail,
        // Only this isolated fixture backend changes; production service/metadata intent is real.
        mutate: async (intent: ProjectsAction) => {
          if (intent.action === 'update') {
            if (intent.name !== undefined) detail.project.name = intent.name;
            if (intent.goal !== undefined) detail.project.goal = intent.goal;
          }
          return { ok: true, projectId: 'p-core', sessionId: null };
        },
        onChanged: subscription('projects'),
      },
      projectProgress: { read: async () => ({ projectId: 'p-core', items: [], history: [],
        capabilities: { canRecord: true, canConfirmDone: true },
        historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } }) },
    },
  }); },
  render: (ctx) => {
    if (ctx.case === 'detail' || ctx.case.startsWith('metadata')) {
      return (
        <MemoryRouter initialEntries={['/cc-agent/projects/p-core']}>
          <Routes>
            <Route path="/cc-agent/projects/:projectId" element={<ProjectDetailPage />} />
          </Routes>
        </MemoryRouter>
      );
    }
    if (ctx.case === 'create') {
      return (
        <MemoryRouter initialEntries={['/cc-agent']}>
          <NewProjectDialog open onOpenChange={noop} />
        </MemoryRouter>
      );
    }
    if (ctx.case === 'binding') {
      return (
        <MemoryRouter initialEntries={['/cc-agent']}>
        <div className="flex h-full w-full justify-center bg-[hsl(var(--content-area))] pt-24">
          <div className="w-[min(720px,calc(100vw-48px))] rounded-xl border border-[var(--cmd-palette-border)] bg-[var(--cmd-palette-bg)] p-4">
            <ProjectBindingSelect value="p-core" onChange={noop} />
            <div className="mt-3 rounded-lg border border-[var(--cmd-palette-border)] px-3 py-6 text-13 text-[var(--settings-section-desc)]">
              项目「Cindy 项目内核」· 新建的任务会直接归到该项目下
            </div>
          </div>
        </div>
        </MemoryRouter>
      );
    }
    const nodes = groupSessions(sessions, {
      entityProjects: projects.map((project) => ({
        id: project.id,
        name: project.name,
        updatedAt: project.updatedAt,
      })),
    }).projects.filter((project) => project.entityProjectId);
    return (
      <MemoryRouter initialEntries={['/cc-agent']}>
      <div className="h-full w-full bg-[hsl(var(--content-area))] py-2">
        <EntityProjectsSection
          projects={nodes}
          collapsed={emptySet}
          activeSessionId="t1"
          runningSessionIds={emptySet}
          attachedSessionIds={emptySet}
          notifications={emptySet}
          scheduleSessionIndex={emptyMap}
          onToggleProject={noop}
          onOpenProject={noop}
          onNewProject={noop}
          onSessionClick={noop}
          onAction={noop}
          onRename={noop}
          onTogglePin={noop}
          onScheduleAction={noop}
        />
        <p className="mt-3 px-4 text-12 text-[var(--settings-section-desc)]">
          旧目录分组仍在下方（此处未渲染 ProjectsSection）
        </p>
      </div>
      </MemoryRouter>
    );
  },
});
