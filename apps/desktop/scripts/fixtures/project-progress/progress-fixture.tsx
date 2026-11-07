import { useEffect, useState } from 'react';
import { mountPage } from '../../ui-page/harness';
import {
  ProjectProgressView,
  type ProjectProgressState,
} from '../../../src/renderer/features/projects/progress/ProjectProgressView';
import type {
  ProjectProgressItem,
  ProjectProgressHistoryEntry,
} from '../../../src/renderer/features/projects/progress/progressProjection';
import type { WorkItemProgressRecord } from '../../../src/shared/workItemProgress';

const record = (id: string, status: WorkItemProgressRecord['status']): WorkItemProgressRecord => ({
  sessionId: id,
  projectId: 'p',
  status,
  revision: 1,
  bindingRevision: 2,
  reason: 'Waiting for the owner to supply a readable source file. '.repeat(4),
  unblockCondition:
    'The owner supplies the source, then the assigned teammate confirms it is readable.',
  completionEventId: status === 'done' ? 42 : null,
  updatedBy: { kind: 'account', id: 'owner' },
  updatedAt: 1793865600000,
});
const item = (id: string, status: WorkItemProgressRecord['status']): ProjectProgressItem => ({
  sessionId: id,
  projectId: 'p',
  title: 'Same task',
  sessionStatus: 'active',
  bindingRevision: 2,
  progress: record(id, status),
});
const items: ProjectProgressItem[] = [
  item('blocked', 'blocked'),
  item('done', 'done'),
  item('unknown', null),
  item('doing', 'doing'),
  {
    ...item('old-binding', 'done'),
    progress: { ...record('old-binding', 'done'), bindingRevision: 0 },
  },
  { ...item('archived', 'review'), sessionStatus: 'archived' },
  { ...item('deleted', 'done'), sessionStatus: 'deleted' },
  { ...item('foreign', 'done'), projectId: 'other' },
];
const history: ProjectProgressHistoryEntry[] = Array.from({ length: 7 }, (_, i) => ({
  eventId: i + 1,
  projectId: 'p',
  sessionId: 'blocked',
  bindingRevision: i === 0 ? 0 : 2,
  from: 'blocked',
  to: 'doing',
  actor: { kind: 'account', id: 'owner', displayName: 'Project owner' },
  createdAt: 1793865600000 - i * 60000,
  reason: 'Source file unavailable',
  unblockCondition: 'Readable source received',
  resolution: 'Owner supplied the source file; the assigned teammate checked its contents.',
  completionNote: null,
}));

function Fixture({ scenario }: { scenario: string }) {
  const [projectId, setProjectId] = useState('p');
  const [state, setState] = useState<ProjectProgressState>(
    scenario === 'loading' || scenario === 'error' || scenario === 'forbidden'
      ? { status: scenario }
      : {
          status: 'ready',
          projectId: 'p',
          items:
            scenario === 'empty' ? [] : scenario === 'duplicate' ? [items[0], items[0]] : items,
          history: scenario === 'empty' ? [] : history,
        },
  );
  const [action, setAction] = useState('');
  useEffect(() => {
    const change = (event: Event) => {
      const next = (event as CustomEvent<{ projectId: string; state: ProjectProgressState }>)
        .detail;
      setProjectId(next.projectId);
      setState(next.state);
    };
    window.addEventListener('progress-fixture-state', change);
    return () => window.removeEventListener('progress-fixture-state', change);
  }, []);
  return (
    <main className="mx-auto min-w-0 max-w-3xl p-4">
      <ProjectProgressView
        projectId={projectId}
        state={state}
        onOpenWorkItem={setAction}
        onRefresh={() => setAction('retry')}
      />
      <output aria-label="fixture-action">{action}</output>
    </main>
  );
}
mountPage({ render: (ctx) => <Fixture scenario={ctx.case} /> });
