// @vitest-environment jsdom
/** Unit: read-only view contract V1. Real component/projection entry; previous pure
 * tests cannot detect stale body disclosure, wrong-ID navigation or filter resets.
 * Minimal failures: old-binding done, duplicate IDs, ready -> forbidden and project switch.
 * No bridge, database, module reload or real waits. Browser keyboard/layout use ui:check.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '@/i18n/locales/en/common.json';
import { ProjectProgressView, type ProjectProgressState } from './ProjectProgressView';
import type { ProjectMember } from '../../../../shared/projects';

type ProjectProgressViewMembers = readonly ProjectMember[];
import {
  projectProgressView,
  type ProjectProgressItem,
  type ProjectProgressHistoryEntry,
} from './progressProjection';
import type { WorkItemProgressRecord } from '../../../../shared/workItemProgress';
import type {
  WorkItemExecutionEntry,
  WorkItemFollowupProjection,
} from '../../../../shared/projectWorkItemExecutionRequest';

const i18n = createInstance();
await i18n.init({
  lng: 'en',
  resources: { en: { common: en } },
  defaultNS: 'common',
  initAsync: false,
});
afterEach(cleanup);

// Owner decision 2026-11-13: projects show progress/execution, while native task
// pages own dialogue, approval, queue and model controls. A completed work item
// must open the original task without offering a second execution surface.
it('opens the original work item and leaves task controls to its native page', () => {
  const onOpen = vi.fn();
  render(<I18nextProvider i18n={i18n}><ProjectProgressView projectId="p"
    state={ready([item()])} onOpenWorkItem={onOpen} onRefresh={vi.fn()}
    execution={{ s: executionEntry({ state: 'completed' }) }} /></I18nextProvider>);
  expect(screen.getByText('Completed')).toBeTruthy();
  expect(screen.queryByText('Follow up')).toBeNull();
  expect(screen.queryByText(/Current model:/)).toBeNull();
  expect(screen.queryByRole('button', { name: /Ask .* to execute|Continue|Approve|Queue here|Change model/ })).toBeNull();
  expect(screen.queryByRole('textbox')).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'Open task “Same title”' }));
  expect(onOpen).toHaveBeenCalledExactlyOnceWith('s');
});
const record = (patch: Partial<WorkItemProgressRecord> = {}): WorkItemProgressRecord => ({
  sessionId: 's',
  projectId: 'p',
  bindingRevision: 2,
  revision: 1,
  status: 'done',
  reason: null,
  unblockCondition: null,
  completionEventId: 1,
  updatedBy: { kind: 'account', id: 'owner' },
  updatedAt: 1000,
  ...patch,
});
const item = (patch: Partial<ProjectProgressItem> = {}): ProjectProgressItem => ({
  sessionId: 's',
  projectId: 'p',
  title: 'Same title',
  sessionStatus: 'active',
  bindingRevision: 2,
  progress: record(),
  ...patch,
});
const ready = (items: ProjectProgressItem[], projectId = 'p'): ProjectProgressState => ({
  status: 'ready',
  projectId,
  items,
  history: [],
});
const mount = (state: ProjectProgressState, projectId = 'p', members: ProjectProgressViewMembers = []) => {
  const onOpen = vi.fn(),
    onRefresh = vi.fn();
  const element = (next: ProjectProgressState, id = projectId) => (
    <I18nextProvider i18n={i18n}>
      <ProjectProgressView
        projectId={id}
        members={members}
        state={next}
        onOpenWorkItem={onOpen}
        onRefresh={onRefresh}
      />
    </I18nextProvider>
  );
  const result = render(element(state));
  return {
    ...result,
    onOpen,
    onRefresh,
    update: (next: ProjectProgressState, id = projectId) => result.rerender(element(next, id)),
  };
};

const followup = (patch: Partial<WorkItemFollowupProjection> = {}): WorkItemFollowupProjection => ({
  busy: false,
  pending: null,
  model: { current: 'model-a', providerId: 'p1', agentKind: 'claude-code' },
  actions: {
    continue: { allowed: true, reason: null },
    approve: { allowed: false, reason: 'NO_PENDING_CONFIRMATION' },
    queue: { allowed: false, reason: 'NOT_BUSY' },
    model: { allowed: true, reason: null },
  },
  ...patch,
});

const executionEntry = (patch: Partial<WorkItemExecutionEntry> = {}): WorkItemExecutionEntry => ({
  sessionId: 's',
  executor: { botId: 'bot1', displayName: 'Nova' },
  unavailableReason: null,
  state: 'none',
  requestKey: null,
  requestRound: null,
  delegationId: null,
  requestedAt: null,
  canRequest: true,
  followup: followup(),
  ...patch,
});

describe('project progress projection and component', () => {
  it.each([null, '', 'Same person'])(
    'shows a readable actor and never the raw kind:id for missing or shared name %j',
    (displayName) => {
      const actors: ProjectProgressHistoryEntry['actor'][] = [
        { kind: 'account', id: 'account-a', displayName },
        { kind: 'bot', id: 'bot-b', displayName },
        { kind: 'account', id: 'same-id', displayName },
        { kind: 'bot', id: 'same-id', displayName },
        { kind: 'bot', id: 'long-id-'.repeat(32), displayName },
      ];
      const history: ProjectProgressHistoryEntry[] = actors.map((actor, index) => ({
        eventId: index + 1,
        projectId: 'p',
        sessionId: 's',
        bindingRevision: 2,
        from: 'todo',
        to: 'doing',
        actor,
        createdAt: 1000 + index,
        reason: null,
        unblockCondition: null,
        resolution: null,
        completionNote: null,
      }));
      mount({ status: 'ready', projectId: 'p', items: [item()], history });
      // D-2: the history must never print the internal subject id (or its `kind:` prefix).
      for (const actor of actors) {
        expect(screen.queryByText(actor.id)).toBeNull();
        expect(screen.queryByText(`${actor.kind}:${actor.id}`)).toBeNull();
      }
      expect(screen.queryByText(/account:|bot:/)).toBeNull();
      expect(screen.getAllByText(displayName || 'Unknown actor')).toHaveLength(5);
    },
  );
  it('resolves account actors to readable names: different accounts differ, one person stays consistent', () => {
    // D-2: Main sends kind/id only. Dropping the raw id without resolving the name left every
    // account actor as "Unknown actor", so two different people looked identical.
    const members: ProjectMember[] = [
      { subject: { kind: 'account', id: 'account-a', displayName: 'Ana', avatar: null, avatarColor: null }, role: 'member', addedAt: '' },
      { subject: { kind: 'account', id: 'account-b', displayName: 'Ben', avatar: null, avatarColor: null }, role: 'member', addedAt: '' },
    ];
    const actors: Array<ProjectProgressHistoryEntry['actor']> = [
      { kind: 'account', id: 'account-a', displayName: null },
      { kind: 'account', id: 'account-b', displayName: null },
      { kind: 'account', id: 'account-a', displayName: null },
    ];
    const history: ProjectProgressHistoryEntry[] = actors.map((actor, index) => ({
      eventId: index + 1, projectId: 'p', sessionId: 's', bindingRevision: 2, from: 'todo', to: 'doing',
      actor, createdAt: 2000 + index,
      reason: null, unblockCondition: null, resolution: null, completionNote: null,
    }));
    mount({ status: 'ready', projectId: 'p', items: [item()], history }, 'p', members);
    expect(screen.getAllByText('Ana')).toHaveLength(2);
    expect(screen.getAllByText('Ben')).toHaveLength(1);
    expect(screen.queryByText(/account:|bot:/)).toBeNull();
    expect(screen.queryByText(/account-a|account-b/)).toBeNull();
    expect(screen.queryByText('Unknown actor')).toBeNull();
  });

  it.each([
    record({ bindingRevision: 0 }),
    record({ projectId: 'other' }),
    record({ sessionId: 'other' }),
    record({ completionEventId: null }),
  ])('does not count stale/mismatched/unconfirmed done', (progress) => {
    const result = projectProgressView('p', [item({ progress })], []);
    expect(result.summary).toMatchObject({ total: 1, unknownCount: 1, counts: { done: 0 } });
    expect(result.items[0].status).toBeNull();
  });
  it('excludes deleted and foreign items; archive retains explicit progress and unknown stays in total', () => {
    const result = projectProgressView(
      'p',
      [
        item(),
        item({ sessionId: 'deleted', sessionStatus: 'deleted' }),
        item({ sessionId: 'unknown', progress: null }),
        item({
          sessionId: 'archive',
          sessionStatus: 'archived',
          progress: record({ sessionId: 'archive', status: 'doing' }),
        }),
        item({ projectId: 'other' }),
      ],
      [],
    );
    expect(result.summary).toMatchObject({
      total: 3,
      unknownCount: 1,
      counts: { done: 1, doing: 1 },
    });
  });
  it('uses current observations rather than old-binding completion', () => {
    const result = projectProgressView(
      'p',
      [item({ progress: record({ bindingRevision: 0 }), signals: { running: true } })],
      [],
    );
    expect(result.items[0].status).toBe('doing');
  });
  it('rejects repeated stable IDs with a safe display error', () => {
    mount(ready([item(), item()]));
    expect(screen.getByRole('alert').textContent).toContain('inconsistent');
    expect(screen.queryByText('Same title')).toBeNull();
  });
  it('uses one list for counts/filtering and opens duplicate titles by stable ID', () => {
    const ui = mount(ready([item(), item({ sessionId: 'second', progress: null })]));
    fireEvent.click(screen.getAllByRole('button', { name: 'Open task “Same title”' })[1]);
    expect(ui.onOpen).toHaveBeenCalledWith('second');
    fireEvent.click(screen.getByRole('button', { name: 'Not recorded · 1' }));
    expect(screen.getAllByRole('button', { name: 'Open task “Same title”' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed complete · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Open task “Same title”' }));
    expect(ui.onOpen).toHaveBeenLastCalledWith('s');
  });
  it.each(['loading', 'forbidden', 'error'] as const)(
    'removes ready body when %s replaces it',
    (status) => {
      const ui = mount(ready([item()]));
      ui.update({ status });
      expect(screen.queryByText('Same title')).toBeNull();
      if (status === 'error') {
        fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
        expect(ui.onRefresh).toHaveBeenCalledTimes(1);
      }
    },
  );
  it('resets filters on project change and hides a stale ready response', () => {
    const ui = mount(ready([item()]));
    fireEvent.click(screen.getByRole('button', { name: 'Not recorded · 0' }));
    ui.update(ready([item()]), 'q');
    expect(screen.queryByText('Same title')).toBeNull();
    ui.update(ready([item({ projectId: 'q', progress: null })], 'q'), 'q');
    expect(screen.getByRole('button', { name: 'All · 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Open task “Same title”' })).toBeTruthy();
  });
  it('shows empty, no history, and missing block metadata without inventing reasons', () => {
    const ui = mount(ready([]));
    expect(screen.getByText('No work items')).toBeTruthy();
    expect(screen.getByText('No progress history')).toBeTruthy();
    ui.update(ready([item({ progress: record({ status: 'blocked' }) })]));
    expect(screen.getAllByText('Not recorded')).toHaveLength(2);
  });

  it('sorts authorized current-project history by time then stable ID and marks old binding', () => {
    const event = (
      eventId: number,
      patch: Partial<ProjectProgressHistoryEntry> = {},
    ): ProjectProgressHistoryEntry => ({
      eventId,
      projectId: 'p',
      sessionId: 's',
      bindingRevision: 2,
      from: 'blocked',
      to: 'doing',
      actor: { kind: 'account', id: 'owner', displayName: 'Owner' },
      createdAt: 1000,
      reason: 'Waiting',
      unblockCondition: 'Source arrives',
      resolution: 'Source received',
      completionNote: null,
      ...patch,
    });
    const history = [
      event(1),
      event(2, { bindingRevision: 0 }),
      event(3, { createdAt: 2000 }),
      event(4, { projectId: 'other', completionNote: 'Foreign secret' }),
    ];
    const result = projectProgressView('p', [item()], history);
    expect(result.history.map((entry) => entry.eventId)).toEqual([3, 2, 1]);
    expect(result.history[1].historicalBinding).toBe(true);
    const ui = mount({ status: 'ready', projectId: 'p', items: [item()], history });
    expect(screen.getByText('Historical binding')).toBeTruthy();
    expect(screen.queryByText('Foreign secret')).toBeNull();
    ui.update({ status: 'forbidden' });
    expect(screen.queryByText('Source received')).toBeNull();
    expect(screen.queryByText('Owner')).toBeNull();
  });

  it('expands history locally and resets expansion when switching projects', () => {
    const history: ProjectProgressHistoryEntry[] = Array.from({ length: 6 }, (_, index) => ({
      eventId: index + 1,
      projectId: 'p',
      sessionId: 's',
      bindingRevision: 2,
      from: null,
      to: 'doing',
      actor: { kind: 'bot', id: 'bot' },
      createdAt: 1000 + index,
      reason: `Reason ${index}`,
      unblockCondition: null,
      resolution: null,
      completionNote: null,
    }));
    const ui = mount({ status: 'ready', projectId: 'p', items: [item()], history });
    expect(screen.queryByText('Reason 0')).toBeNull();
    fireEvent.click(screen.getByRole('button', { name: 'Show all history' }));
    expect(screen.getByText('Reason 0')).toBeTruthy();
    ui.update(ready([], 'q'), 'q');
    ui.update({ status: 'ready', projectId: 'p', items: [item()], history }, 'p');
    expect(screen.queryByText('Reason 0')).toBeNull();
    expect(
      screen.getByRole('button', { name: 'Show all history' }).getAttribute('aria-expanded'),
    ).toBe('false');
  });
});

/** Owner decision: execution is a read-only summary, not another task controller. */
describe('read-only work-item execution', () => {
  it.each([
    ['none', 'Not executed'], ['requested', 'Request delivered'], ['accepted', 'Teammate accepted'],
    ['running', 'Teammate running'], ['completed', 'Completed'], ['failed', 'Execution failed'],
    ['unknown', 'Outcome unknown'],
  ] as const)('shows %s and opens the original task without execution controls', (state, text) => {
    const onOpen = vi.fn();
    render(<I18nextProvider i18n={i18n}><ProjectProgressView projectId="p"
      state={ready([item()])} onOpenWorkItem={onOpen} onRefresh={vi.fn()}
      execution={{ s: executionEntry({ state }) }} /></I18nextProvider>);
    expect(screen.getByText(text)).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: 'Open task “Same title”' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s');
    expect(screen.queryByRole('textbox')).toBeNull();
    expect(screen.queryByRole('combobox')).toBeNull();
    expect(screen.queryByText('Follow up')).toBeNull();
    if (state !== 'completed') expect(screen.queryByText('Completed')).toBeNull();
  });

  it.each([null, 'UNASSIGNED'] as const)('keeps navigation available without executable evidence: %s', reason => {
    const onOpen = vi.fn();
    render(<I18nextProvider i18n={i18n}><ProjectProgressView projectId="p"
      state={ready([item({ progress: null })])} onOpenWorkItem={onOpen} onRefresh={vi.fn()}
      execution={reason ? { s: executionEntry({ executor: null, unavailableReason: reason, canRequest: false }) } : {}}
      executionUnavailable={!reason} /></I18nextProvider>);
    fireEvent.click(screen.getByRole('button', { name: 'Open task “Same title”' }));
    expect(onOpen).toHaveBeenCalledExactlyOnceWith('s');
    expect(screen.getByText('Not recorded')).toBeTruthy();
    expect(screen.queryByText('Completed')).toBeNull();
    if (!reason) expect(screen.getByText('Execution state is unavailable right now; refresh to retry.')).toBeTruthy();
  });

  it('shows current pending work as read-only attention and leaves approval in the task', () => {
    render(<I18nextProvider i18n={i18n}><ProjectProgressView projectId="p"
      state={ready([item()])} onOpenWorkItem={vi.fn()} onRefresh={vi.fn()}
      execution={{ s: executionEntry({ state: 'running', followup: followup({
        pending: { requestId: 'permission', kind: 'permission', summary: 'Allow exec', raisedAt: 1 },
      }) }) }} /></I18nextProvider>);
    expect(screen.getByText('Awaiting your input')).toBeTruthy();
    expect(screen.queryByRole('button', { name: 'Approve' })).toBeNull();
    expect(screen.queryByText('Current model: model-a')).toBeNull();
    expect(screen.queryByText('Allow exec')).toBeNull();
  });
});

describe('automation origin badge', () => {
  // 这两条要成对断言：「出现」与「不出现」各测一次，否则把条件写反（永远显示 /
  // 永远不显示）时组件测试全绿而进度页全错。
  it('shows the badge with the automation name when the item carries an origin', () => {
    const linked = mount(
      ready([item({ automation: { scheduleId: 'sc-1', scheduleName: 'Nightly' } })]),
    );
    expect(linked.getByText('By automation · Nightly')).toBeTruthy();
    cleanup();
  });

  it('still marks the origin when the automation name is unknown', () => {
    const unnamed = mount(
      ready([item({ automation: { scheduleId: 'sc-1', scheduleName: '' } })]),
    );
    expect(unnamed.getByText('By automation')).toBeTruthy();
    cleanup();
  });

  it.each([undefined, null])(
    'shows no badge for a work item without an automation origin (%s)',
    (automation) => {
      const manual = mount(ready([item({ automation })]));
      expect(manual.queryByText(/By automation/)).toBeNull();
      cleanup();
    },
  );
});
