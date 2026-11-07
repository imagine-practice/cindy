import { MemoryRouter, Routes, Route, useParams, useNavigate } from 'react-router-dom';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectDetailPage } from '../../../src/renderer/features/projects/ProjectDetailPage';
import { Button } from '../../../src/renderer/components/ui/button';
import type { ProjectDetail } from '../../../src/shared/projects';
import type { ProjectProgressReadResult } from '../../../src/shared/projectProgressApi';
const subject = { kind: 'account' as const, id: 'acc-1', displayName: 'Chris', avatar: null, avatarColor: null };
const detail: ProjectDetail = { project: { id: 'p', name: '春季项目', goal: '核对最新进度与阻塞原因，按记录继续工作。',
  ownerId: 'acc-1', status: 'active', createdAt: '2026-11-05T08:00:00Z', updatedAt: '2026-11-05T08:00:00Z', taskCount: 3,
  members: [{ subject, role: 'owner', addedAt: '2026-11-05T08:00:00Z' }] },
  workItems: [{ sessionId: 'task-1', title: '核对材料', status: 'active', assignee: null, updatedAt: '2026-11-05T08:00:00Z' }] };
const snapshot: ProjectProgressReadResult = { projectId: 'p', items: ['核对材料', '整理交付记录', '已归档但未确认进度'].map((title, i) => ({
  sessionId: `task-${i+1}`, projectId: 'p', title, sessionStatus: i === 2 ? 'archived' : 'active', bindingRevision: 7,
  assignee: i === 1 ? { kind: 'bot' as const, id: 'bot-1' } : null,
  progress: i ? null : { sessionId: 'task-1', projectId: 'p', bindingRevision: 7, status: 'blocked', revision: 1,
    reason: '等待补齐最新材料后继续核对。', unblockCondition: '收到更新材料', completionEventId: null,
    updatedBy: { kind: 'account', id: 'acc-1' }, updatedAt: 1793850000000 },
})), history: [3,2].map(eventId => ({ eventId, projectId: 'p', sessionId: 'task-1', bindingRevision: 7,
  from: 'doing', to: 'blocked', actor: { kind: 'account', id: 'acc-1', displayName: 'Chris' }, createdAt: 1793850000000 + eventId,
  reason: '等待更新材料', unblockCondition: '收到更新材料', resolution: null, completionNote: null })),
  capabilities: { canRecord: true, canConfirmDone: true }, historyPage: { limit: 100, hasMore: true, nextBeforeEventId: 2 } };
function TaskTarget() { const { sessionId } = useParams(); const navigate = useNavigate(); return <div>
  <output aria-label="fixture-target">{sessionId}</output><Button onClick={() => navigate(-1)}>返回模拟项目</Button></div>; }
mountPage({ host: ctx => ({ localDb: { projects: { detail: async () => detail, onChanged: subscription('projects') },
  projectProgress: { read: async (request: { beforeEventId?: number }) => {
    if (ctx.case === 'loading') return new Promise(() => {});
    if (ctx.case === 'forbidden') throw new Error('[FORBIDDEN] fixture');
    if (ctx.case === 'error') throw new Error('[INTERNAL] fixture');
    if (ctx.case === 'empty') return { ...snapshot, items: [], history: [], historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } };
    if (request.beforeEventId) return { ...snapshot, history: [{ ...snapshot.history[0], eventId: 1 }],
      historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } };
    return snapshot;
  } } } }), render: () => <MemoryRouter initialEntries={['/cc-agent/projects/p']}><Routes>
    <Route path="/cc-agent/projects/:projectId" element={<ProjectDetailPage />} />
    <Route path="/cc-agent/:sessionId" element={<TaskTarget />} />
  </Routes></MemoryRouter> });
