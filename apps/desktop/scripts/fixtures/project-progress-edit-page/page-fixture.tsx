import { MemoryRouter, Routes, Route } from 'react-router-dom';
import { mountPage, subscription } from '../../ui-page/harness';
import { ProjectDetailPage } from '../../../src/renderer/features/projects/ProjectDetailPage';
import type { ProjectDetail } from '../../../src/shared/projects';
import type { ProjectProgressReadResult } from '../../../src/shared/projectProgressApi';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../src/shared/workItemProgress';
const subject = { kind: 'account' as const, id: 'acc-1', displayName: 'Chris', avatar: null, avatarColor: null };
const detail: ProjectDetail = { project: { id: 'p', name: 'Progress project', goal: 'Record work progress; completion is not business acceptance.',
 ownerId: 'acc-1', status: 'active', createdAt: '2026-11-05', updatedAt: '2026-11-05', taskCount: 1, dirs: [],
 members: [{ subject, role: 'owner', addedAt: '2026-11-05' }] }, workItems: [] };
mountPage({ host: ctx => {
 const initial = ctx.case === 'done' ? 'review' as const : null;
 let snapshot: ProjectProgressReadResult = { projectId: 'p', items: [{ projectId: 'p', sessionId: 'task-1', title: 'Review current evidence',
  sessionStatus: 'active', bindingRevision: 7, assignee: { kind: 'account' as const, id: 'acc-1' }, progress: initial ? { projectId: 'p', sessionId: 'task-1', bindingRevision: 7,
   status: initial, revision: 3, reason: null, unblockCondition: null, completionEventId: null,
   updatedBy: { kind: 'account', id: 'acc-1' }, updatedAt: 1793850000000 } : null }], history: [],
  capabilities: { canRecord: true, canConfirmDone: true }, historyPage: { limit: 100, hasMore: false, nextBeforeEventId: null } };
 const receipts = new Map<string, WorkItemProgressResult>();
 const calls: WorkItemProgressIntent[] = [];
 Object.assign(window, { __progressWriteCalls: calls });
 return { localDb: { projects: { detail: async () => detail, onChanged: subscription('projects') }, projectProgress: {
  read: async () => snapshot,
  update: async (intent: WorkItemProgressIntent) => {
   calls.push(structuredClone(intent));
   if (ctx.case === 'saving') return new Promise<WorkItemProgressResult>(() => {});
   if (ctx.case === 'conflict') throw new Error('[REVISION_CONFLICT] fixture');
   const cached = receipts.get(intent.requestId); if (cached) return { ...cached, replayed: true };
   const record = { projectId: 'p', sessionId: 'task-1', bindingRevision: 7, status: intent.to,
    revision: intent.expectedRevision + 1, reason: intent.reason ?? null, unblockCondition: intent.unblockCondition ?? null,
    completionEventId: intent.to === 'done' ? 1 : null, updatedBy: { kind: 'account' as const, id: 'acc-1' }, updatedAt: 1793850000001 };
   const result = { record, eventId: 1, revision: record.revision, replayed: false }; receipts.set(intent.requestId, result);
   snapshot = { ...snapshot, items: [{ ...snapshot.items[0], progress: record }] };
   if (ctx.case === 'uncertain') throw new Error('[DB_TRANSPORT_OUTCOME_UNKNOWN] fixture');
   return result;
  }
 } } };
}, render: () => <MemoryRouter initialEntries={['/cc-agent/projects/p']}><Routes>
 <Route path="/cc-agent/projects/:projectId" element={<ProjectDetailPage />} />
</Routes></MemoryRouter> });
