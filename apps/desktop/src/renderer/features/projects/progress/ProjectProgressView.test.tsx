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
import { followupNoticeKey } from './ProjectProgressSection';
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
const mount = (state: ProjectProgressState, projectId = 'p') => {
  const onOpen = vi.fn(),
    onRefresh = vi.fn();
  const element = (next: ProjectProgressState, id = projectId) => (
    <I18nextProvider i18n={i18n}>
      <ProjectProgressView
        projectId={id}
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
    'keeps stable kind/id identity for missing or shared name %j',
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
      for (const actor of actors)
        expect(screen.getByText(`${actor.kind}:${actor.id}`)).toBeTruthy();
      expect(screen.getAllByText(displayName || 'Unknown actor')).toHaveLength(5);
    },
  );
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
    fireEvent.click(screen.getAllByRole('button', { name: 'Same title' })[1]);
    expect(ui.onOpen).toHaveBeenCalledWith('second');
    fireEvent.click(screen.getByRole('button', { name: 'Unknown · 1' }));
    expect(screen.getAllByRole('button', { name: 'Same title' })).toHaveLength(1);
    fireEvent.click(screen.getByRole('button', { name: 'Confirmed complete · 1' }));
    fireEvent.click(screen.getByRole('button', { name: 'Same title' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'Unknown · 0' }));
    ui.update(ready([item()]), 'q');
    expect(screen.queryByText('Same title')).toBeNull();
    ui.update(ready([item({ projectId: 'q', progress: null })], 'q'), 'q');
    expect(screen.getByRole('button', { name: 'All · 1' }).getAttribute('aria-pressed')).toBe(
      'true',
    );
    expect(screen.getByRole('button', { name: 'Same title' })).toBeTruthy();
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

/** 「请该伙伴执行」入口：执行者、禁用原因、六档状态与重发规则的呈现。 */
describe('project work-item execution entry', () => {
  const mountExecution = (
    entry: WorkItemExecutionEntry | null,
    notice: { sessionId: string; key: string } | null = null,
  ) => {
    const onRequest = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ProjectProgressView
          projectId="p"
          state={ready([item()])}
          onOpenWorkItem={vi.fn()}
          onRefresh={vi.fn()}
          execution={entry ? { s: entry } : {}}
          executionNotice={notice}
          onRequestExecution={onRequest}
        />
      </I18nextProvider>,
    );
    return { onRequest };
  };

  it('names the assignee teammate and delivers on click', () => {
    const ui = mountExecution(executionEntry());
    fireEvent.click(screen.getByRole('button', { name: 'Ask Nova to execute' }));
    expect(ui.onRequest).toHaveBeenCalledTimes(1);
    expect(ui.onRequest).toHaveBeenCalledWith('s');
  });

  it('disables the entry without an assignee and never falls back to another executor', () => {
    const ui = mountExecution(
      executionEntry({
        executor: null,
        unavailableReason: 'UNASSIGNED',
        canRequest: false,
      }),
    );
    expect(screen.getByText('Set an assignee first')).toBeTruthy();
    // A disabled control (not a hidden one) and no invented executor name.
    const button = screen.getByRole('button', {
      name: 'Ask the assignee to execute',
    }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
    expect(ui.onRequest).not.toHaveBeenCalled();
  });

  it.each([
    ['requested', 'Request delivered', 'Delivered and waiting for the teammate; it is not sent twice.'],
    ['accepted', 'Teammate accepted', null],
    ['running', 'Teammate running', null],
    ['completed', 'Completed', null],
  ] as const)('separates %s from the other stages', (state, label, hint) => {
    mountExecution(executionEntry({ state, canRequest: state === 'completed' }));
    expect(screen.getByText(label)).toBeTruthy();
    if (hint) expect(screen.getByText(hint)).toBeTruthy();
  });

  it('keeps an unknown outcome visible, disabled, and reconcile-only', () => {
    mountExecution(executionEntry({ state: 'unknown', canRequest: false }));
    expect(screen.getByText('Outcome unknown')).toBeTruthy();
    expect(
      screen.getByText('Outcome unknown; reconcile only, nothing is sent again.'),
    ).toBeTruthy();
    const button = screen.getByRole('button', { name: 'Ask Nova to execute' }) as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    fireEvent.click(button);
  });

  it('reports a replayed request without claiming a second turn', () => {
    mountExecution(executionEntry({ state: 'requested', canRequest: false }), {
      sessionId: 's',
      key: 'alreadyRequested',
    });
    expect(
      screen.getByText('The request is already with this teammate; nothing was sent again.'),
    ).toBeTruthy();
  });
});

/** 执行后续：四个动作的可用性来自 main 的现读投影，界面不自己推断。 */
describe('project work-item execution follow-ups', () => {
  const mountFollowup = (
    entry: WorkItemExecutionEntry,
    options: {
      busy?: { sessionId: string; action: 'continue' | 'approve' | 'queue' | 'model' } | null;
      notice?: { sessionId: string; key: string; vars?: Record<string, string | number> } | null;
      modelChoices?: Record<string, { model: string; providerId: string | null; label: string }[]>;
    } = {},
  ) => {
    const onFollowup = vi.fn();
    render(
      <I18nextProvider i18n={i18n}>
        <ProjectProgressView
          projectId="p"
          state={ready([item()])}
          onOpenWorkItem={vi.fn()}
          onRefresh={vi.fn()}
          execution={{ s: entry }}
          followupBusy={options.busy ?? null}
          followupNotice={options.notice ?? null}
          modelChoices={options.modelChoices}
          onFollowup={onFollowup}
        />
      </I18nextProvider>,
    );
    return { onFollowup };
  };
  const button = (name: string) =>
    screen.getByRole('button', { name }) as HTMLButtonElement;

  it('keeps every follow-up disabled on an unknown outcome and says to reconcile', () => {
    mountFollowup(
      executionEntry({
        state: 'unknown',
        canRequest: false,
        followup: followup({
          actions: {
            continue: { allowed: false, reason: 'OUTCOME_UNKNOWN' },
            approve: { allowed: false, reason: 'OUTCOME_UNKNOWN' },
            queue: { allowed: false, reason: 'OUTCOME_UNKNOWN' },
            model: { allowed: false, reason: 'OUTCOME_UNKNOWN' },
          },
        }),
      }),
    );
    for (const name of ['Continue', 'Approve', 'Queue here', 'Change model'])
      expect(button(name).disabled).toBe(true);
    expect(
      screen.getByText(
        'Outcome unknown: reconcile the original request only. No follow-up action is available.',
      ),
    ).toBeTruthy();
  });

  it('approves only when a real confirmation is waiting, and shows what is being approved', () => {
    const idle = mountFollowup(executionEntry());
    expect(button('Approve').disabled).toBe(true);
    expect(screen.getByText('Nothing is waiting for your approval.')).toBeTruthy();
    fireEvent.click(button('Approve'));
    expect(idle.onFollowup).not.toHaveBeenCalled();
    cleanup();

    const waiting = mountFollowup(
      executionEntry({
        state: 'running',
        followup: followup({
          pending: {
            requestId: 'r1',
            kind: 'permission',
            summary: 'Allow npm install',
            raisedAt: 1,
          },
          actions: {
            continue: { allowed: true, reason: null },
            approve: { allowed: true, reason: null },
            queue: { allowed: false, reason: 'NOT_BUSY' },
            model: { allowed: true, reason: null },
          },
        }),
      }),
    );
    expect(screen.getByText('Waiting for you: Allow npm install')).toBeTruthy();
    fireEvent.click(button('Approve'));
    expect(waiting.onFollowup).toHaveBeenCalledWith('s', 'approve', undefined);
  });

  it('sends continue with the typed instruction into the same task', () => {
    const ui = mountFollowup(executionEntry({ state: 'completed' }));
    fireEvent.click(button('Continue'));
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'Fix the retry path.' } });
    fireEvent.click(button('Send'));
    expect(ui.onFollowup).toHaveBeenCalledTimes(1);
    expect(ui.onFollowup).toHaveBeenCalledWith('s', 'continue', { text: 'Fix the retry path.' });
  });

  it('queues only while the teammate is running, and blocks a second click while in flight', () => {
    const idle = mountFollowup(executionEntry({ state: 'running' }));
    expect(button('Queue here').disabled).toBe(true);
    fireEvent.click(button('Queue here'));
    expect(idle.onFollowup).not.toHaveBeenCalled();
    cleanup();

    const ui = mountFollowup(
      executionEntry({
        state: 'running',
        followup: followup({
          busy: true,
          actions: {
            continue: { allowed: false, reason: 'NO_TERMINAL_EXECUTION' },
            approve: { allowed: false, reason: 'NO_PENDING_CONFIRMATION' },
            queue: { allowed: true, reason: null },
            model: { allowed: true, reason: null },
          },
        }),
      }),
      { busy: { sessionId: 's', action: 'queue' } },
    );
    const inFlight = button('Sending…');
    expect(inFlight.disabled).toBe(true);
    fireEvent.click(inFlight);
    expect(ui.onFollowup).not.toHaveBeenCalled();
  });

  it('maps an idempotency conflict to "changed, send again" instead of a delivered claim', () => {
    expect(
      followupNoticeKey({
        ok: false,
        sessionId: 's',
        action: 'continue',
        code: 'IDEMPOTENCY_CONFLICT',
        reason: null,
        message: 'This key already holds a different instruction; nothing new was delivered',
        requestKey: 'k',
      }),
    ).toEqual({ key: 'idempotencyConflict' });
    // 界面把 key 渲染成明确文案：不是「已发送」。
    mountFollowup(executionEntry({ state: 'completed' }), {
      notice: { sessionId: 's', key: 'idempotencyConflict' },
    });
    expect(
      screen.getByText(
        'The instruction sent with this key was different. Nothing new was delivered; refresh and send it again.',
      ),
    ).toBeTruthy();
  });

  it('changes the model through the host choices and reports the real failure text', () => {
    const ui = mountFollowup(
      executionEntry({
        state: 'completed',
        followup: followup({
          model: { current: 'model-a', providerId: 'p1', agentKind: 'claude-code' },
        }),
      }),
      {
        modelChoices: {
          'claude-code': [{ model: 'model-b', providerId: 'p2', label: 'Model B · Provider 2' }],
        },
        notice: { sessionId: 's', key: 'modelFailed', vars: { detail: 'still working' } },
      },
    );
    expect(screen.getByText('Current model: model-a')).toBeTruthy();
    expect(screen.getByText('The model was not changed: still working')).toBeTruthy();
    fireEvent.click(button('Change model'));
    fireEvent.click(screen.getByRole('combobox'));
    fireEvent.click(screen.getByText('Model B · Provider 2'));
    fireEvent.click(button('Use this model'));
    expect(ui.onFollowup).toHaveBeenCalledWith('s', 'model', { model: 'model-b', providerId: 'p2' });
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
