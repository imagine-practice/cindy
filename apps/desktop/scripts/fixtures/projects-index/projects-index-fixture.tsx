/** Fixture only: real page/controller/service/frozen dialog, synthetic authorized project list. */
import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectsPage } from '../../../src/renderer/features/projects/ProjectsPage';
import type { ProjectRecord, ProjectMember, ProjectsAction } from '../../../src/shared/projects';
const time = '2026-11-05T12:00:00Z';
function member(
  kind: 'account' | 'bot',
  id: string,
  displayName: string,
  role: 'owner' | 'member' = 'owner',
): ProjectMember {
  return {
    subject: { kind, id, displayName, avatar: null, avatarColor: null },
    role,
    addedAt: time,
  };
}
const record = (
  id: string,
  name: string,
  goal: string | null,
  members: ProjectMember[],
  status: 'active' | 'archived' = 'active',
): ProjectRecord => ({
  id,
  name,
  goal,
  members,
  status,
  ownerId: 'creator',
  taskCount: id === 'p-archived' ? 0 : 7,
  createdAt: time,
  updatedAt: time,
});
declare global {
  interface Window {
    __indexOpened?: string[];
    __indexWrites?: ProjectsAction[];
  }
}
mountPage({
  host: (ctx) => {
    window.__indexOpened = [];
    window.__indexWrites = [];
    let records =
      ctx.case === 'empty'
        ? []
        : [
            record(
              'p1',
              'Cindy desktop',
              '把项目目标、成员和任务组织在一起。卡片只展示真实列表信息，进入项目查看进度。',
              [member('account', 'same-id', 'Alex'), member('bot', 'same-id', 'Alex', 'member')],
            ),
            record(
              'p2',
              'Cindy desktop',
              '相同名称，独立的稳定项目 ID。伙伴负责人来自 owner 成员记录。',
              [member('bot', 'same-id', 'Alex'), member('account', 'same-id', 'Alex', 'member')],
            ),
            record(
              'p-long',
              ctx.locale === 'de'
                ? 'Projektübersicht-mit-einem-sehr-langen-ununterbrochenen-Projektnamen-für-die-Prüfung-schmaler-Bildschirme'
                : 'Long-project-name-with-unbroken-material-reference-and-project-membership-details',
              'A longer project goal explains what this project should achieve. Goals remain project information; they do not imply acceptance, publication or measured completion. '.repeat(
                2,
              ),
              [member('account', 'owner', 'A very long account display name for narrow layouts')],
            ),
            record(
              'p-archived',
              'Archived research',
              null,
              [member('bot', 'researcher', 'Research partner')],
              'archived',
            ),
          ];
    let tries = 0;
    const projects = {
      onChanged: subscription('projectsChanged'),
      list: async () => {
        if (ctx.case === 'loading') return new Promise(() => {});
        if (ctx.case === 'error' && tries++ === 0) throw new Error('Fixture connection failure');
        if (ctx.case === 'forbidden') throw new Error('[NOT_PROJECT_MEMBER] Fixture access denied');
        return records;
      },
      mutate: async (action: ProjectsAction) => {
        window.__indexWrites!.push(action);
        if (action.action === 'create')
          records = [
            ...records,
            record('new-id', action.input.name, action.input.goal ?? null, [
              member('account', 'creator', 'Example creator'),
            ]),
          ];
        return { ok: true, projectId: 'new-id', sessionId: null };
      },
    };
    return { localDb: { projects: ctx.case === 'old-host' ? undefined : projects } };
  },
  render: () => <ProjectsPage onOpenProject={(id) => window.__indexOpened!.push(id)} />,
});
