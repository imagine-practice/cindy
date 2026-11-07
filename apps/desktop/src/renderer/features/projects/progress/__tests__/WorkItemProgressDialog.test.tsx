// @vitest-environment jsdom
/**
 * Value: real Radix dialog/forms -> controlled onSubmit intent and delayed receipts.
 * Rule: E1 progress-editor slice, B1 binding epoch, frozen shared graph/types.
 * Gap: no editor exists at the M1 baseline. Pure graph tests cannot observe writes or stale callbacks.
 * Minimal cases: unknown progress, blocked/done notes, uncertain result and scope changes mid-submit.
 * Tier: unit; Select is a native DOM adapter, auth and submission are controlled. No IPC/DB authority claim.
 * Standalone: 31 tests, 2.66s wall / 1079ms tests on 2026-11-05.
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkItemProgressDialog, type WorkItemProgressDialogProps, type WorkItemProgressSnapshot } from '../WorkItemProgressDialog';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../../../shared/workItemProgress';

const env = vi.hoisted(() => ({ generation: 1, submit: vi.fn(), saved: vi.fn(), refresh: vi.fn(), close: vi.fn() }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key.split('progressEdit.')[1] ?? key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => env.generation }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => env.generation,
  isDataOwnerGenerationCurrent: (owner: number) => env.generation === owner }));
vi.mock('@/components/ui/select', () => ({ Select: (props: { id?: string; label: string; value: string;
  disabled?: boolean; options: { value: string; label: string; disabled?: boolean }[]; onValueChange(value: string): void }) =>
  <select id={props.id} aria-label={props.label} value={props.value} disabled={props.disabled}
    onChange={event => props.onValueChange(event.target.value)}>{props.options.map(option =>
      <option key={option.value} value={option.value} disabled={option.disabled}>{option.label}</option>)}</select> }));
const base: WorkItemProgressSnapshot = { projectId: 'p1', sessionId: 's1', title: 'Task one',
  bindingRevision: 3, progressRevision: 4, status: 'doing', canRecord: true, canConfirmDone: true };
function result(intent: WorkItemProgressIntent): WorkItemProgressResult {
  return { eventId: 10, revision: intent.expectedRevision + 1, replayed: false,
    record: { projectId: intent.projectId, sessionId: intent.sessionId, status: intent.to,
      revision: intent.expectedRevision + 1, bindingRevision: intent.expectedBindingRevision,
      reason: null, unblockCondition: null, completionEventId: null,
      updatedBy: { kind: 'account', id: 'trusted-host-fixture' }, updatedAt: 1 } };
}
function deferred<T>() {
  let resolve!: (value: T) => void; let reject!: (reason: Error) => void;
  const promise = new Promise<T>((r, j) => { resolve = r; reject = j; });
  return { promise, resolve, reject };
}
function open(snapshot: WorkItemProgressSnapshot = base) {
  let props: WorkItemProgressDialogProps = { open: true, snapshot, onOpenChange: env.close,
    onSubmit: env.submit, onSaved: env.saved, onRefresh: env.refresh };
  const view = render(<WorkItemProgressDialog {...props} />);
  return { ...view, update: (patch: Partial<WorkItemProgressDialogProps>) => {
    props = { ...props, ...patch }; view.rerender(<WorkItemProgressDialog {...props} />);
  } };
}
const choose = (value: string) => fireEvent.change(screen.getByRole('combobox'), { target: { value } });
const fill = (name: string, value: string) => fireEvent.change(screen.getByLabelText(name, { exact: false }), { target: { value } });
const save = () => fireEvent.click(screen.getByRole('button', { name: /^(save|retry)$/ }));
beforeEach(() => { vi.resetAllMocks(); env.generation = 1; env.submit.mockImplementation(async (intent: WorkItemProgressIntent) => result(intent)); });
afterEach(() => { cleanup(); vi.unstubAllGlobals(); });

// Radix defers mouse pointer-down-outside until click; a pointerdown-only probe is insufficient.
it.each(['idle', 'busy'])('keeps populated form open after a complete scrim click while %s', async phase => {
  vi.useFakeTimers();
  try {
    if (phase === 'busy') env.submit.mockReturnValue(new Promise(() => {}));
    open(); choose('blocked'); fill('reason', 'Retain my draft'); fill('condition', 'Ready');
    if (phase === 'busy') save();
    await act(async () => { vi.runOnlyPendingTimers(); });
    const scrim = document.querySelector('.modal-scrim')!;
    fireEvent(scrim, new MouseEvent('pointerdown', { bubbles: true, button: 0 }));
    fireEvent(scrim, new MouseEvent('pointerup', { bubbles: true, button: 0 }));
    fireEvent.click(scrim, { button: 0 });
    await act(async () => { vi.runOnlyPendingTimers(); });
    expect(env.close).not.toHaveBeenCalled();
    expect((screen.getByLabelText('reason', { exact: false }) as HTMLTextAreaElement).value).toBe('Retain my draft');
    expect(env.submit).toHaveBeenCalledTimes(phase === 'busy' ? 1 : 0);
    fireEvent.click(screen.getByRole('button', { name: phase === 'busy' ? 'close' : 'cancel' }));
    expect(env.close).toHaveBeenCalledExactlyOnceWith(false);
  } finally { vi.useRealTimers(); }
});

it('records a normal same-status intent using only observed tokens and allowed intent fields', async () => {
  open(); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit).toHaveBeenCalledExactlyOnceWith({ projectId: 'p1', sessionId: 's1', expectedRevision: 4,
    expectedBindingRevision: 3, to: 'doing', requestId: expect.any(String) });
  expect(env.refresh).toHaveBeenCalledTimes(1); expect(env.close).toHaveBeenCalledWith(false);
});

it('leaves unknown progress explicit and requires a first choice at revision zero', async () => {
  open({ ...base, status: null, progressRevision: 0 });
  expect(screen.getByText(/status.unknown/)).toBeTruthy(); save(); expect(env.submit).not.toHaveBeenCalled();
  choose('todo'); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit.mock.calls[0][0]).toMatchObject({ expectedRevision: 0, to: 'todo' });
});

it('requires trimmed reason and condition for blocked and omits unrelated fields', async () => {
  open(); choose('blocked'); fill('reason', '   '); save();
  expect(screen.getByRole('alert').textContent).toBe('error.REASON_REQUIRED');
  fill('reason', '  waiting  '); save(); expect(screen.getByRole('alert').textContent).toBe('error.UNBLOCK_CONDITION_REQUIRED');
  fill('condition', '  approval  '); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit.mock.calls[0][0]).toEqual({ projectId: 'p1', sessionId: 's1', expectedRevision: 4,
    expectedBindingRevision: 3, to: 'blocked', reason: 'waiting', unblockCondition: 'approval', requestId: expect.any(String) });
});

it('uses the blocked graph and requires resolution before returning to doing', async () => {
  open({ ...base, status: 'blocked', reason: 'old reason', unblockCondition: 'old condition' });
  expect(screen.queryByRole('option', { name: 'status.done' })).toBeNull();
  expect(screen.queryByRole('option', { name: 'status.review' })).toBeNull();
  choose('doing'); save(); expect(env.submit).not.toHaveBeenCalled();
  fill('resolution', '  resolved  '); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit.mock.calls[0][0]).toMatchObject({ to: 'doing', resolution: 'resolved' });
  expect(env.submit.mock.calls[0][0]).not.toHaveProperty('reason');
});

it('does not offer done to a non-confirming member', () => {
  open({ ...base, canConfirmDone: false }); expect(screen.queryByRole('option', { name: 'status.done' })).toBeNull();
});

it('requires owner completion note and explicit work-completion confirmation', async () => {
  open(); choose('done'); save(); expect(env.submit).not.toHaveBeenCalled();
  fill('note', '  finished  '); save(); expect(screen.getByRole('alert').textContent).toBe('error.confirmRequired');
  fireEvent.click(screen.getByRole('checkbox')); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit.mock.calls[0][0]).toMatchObject({ to: 'done', completionNote: 'finished' });
});

it('enforces the normalized 4000-character note boundary', async () => {
  open(); choose('blocked'); fill('condition', 'ready'); fill('reason', 'a'.repeat(4001)); save();
  expect(screen.getByRole('alert').textContent).toBe('error.tooLong'); expect(env.submit).not.toHaveBeenCalled();
  fill('reason', 'a'.repeat(4000)); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
});

it('cancels without writes and guards double submit while pending', async () => {
  const pending = deferred<WorkItemProgressResult>(); env.submit.mockReturnValue(pending.promise);
  open(); fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
  expect(env.submit).not.toHaveBeenCalled(); expect(env.close).toHaveBeenCalledWith(false);
  save(); fireEvent.submit(document.querySelector('form')!); expect(env.submit).toHaveBeenCalledTimes(1);
  expect(screen.getByRole('status').textContent).toBe('inFlight');
  fireEvent.click(screen.getByRole('button', { name: 'close' })); expect(env.close).toHaveBeenCalledWith(false);
});

it('reuses the original request ID after unknown results and uses a new ID only for a changed intent', async () => {
  env.submit.mockRejectedValue(new Error('transport disconnected')); open(); save(); await screen.findByText('error.uncertain');
  save(); await waitFor(() => expect(env.submit).toHaveBeenCalledTimes(2));
  expect(env.submit.mock.calls[1][0]).toEqual(env.submit.mock.calls[0][0]);
  choose('todo'); save(); await waitFor(() => expect(env.submit).toHaveBeenCalledTimes(3));
  expect(env.submit.mock.calls[2][0].requestId).not.toBe(env.submit.mock.calls[0][0].requestId);
  expect(env.saved).not.toHaveBeenCalled();
});

it.each(['REVISION_CONFLICT', 'BINDING_CONFLICT', 'REQUEST_CONFLICT'])('requires refresh after %s without auto-resubmit', async code => {
  env.submit.mockRejectedValue(new Error(`[${code}] rejected`)); open(); save(); await screen.findByText(`error.${code}`);
  expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
  fireEvent.click(screen.getByRole('button', { name: 'refresh' })); expect(env.refresh).toHaveBeenCalledTimes(1);
  expect(env.submit).toHaveBeenCalledTimes(1); expect(env.saved).not.toHaveBeenCalled();
});

it.each(['FORBIDDEN', 'NOT_FOUND', 'PROJECT_MISMATCH', 'SESSION_DELETED'])('hides stale form body and stops writes after %s', async code => {
  env.submit.mockRejectedValue(new Error(`[${code}] rejected`));
  open({ ...base, status: 'blocked', reason: 'private old note', unblockCondition: 'private condition' });
  save(); await screen.findByText(`error.${code}`);
  expect(screen.queryByText('private old note')).toBeNull(); expect(screen.queryByText('Task one')).toBeNull();
  expect(screen.queryByRole('button', { name: 'save' })).toBeNull(); expect(env.saved).not.toHaveBeenCalled();
});

it.each(['project', 'session', 'binding', 'account', 'reopen', 'revision'].flatMap(scope =>
  ['resolve', 'reject'].map(completion => ({ scope, completion }))))('invalidates old $completion/finally after $scope changes', async ({ scope, completion }) => {
  const old = deferred<WorkItemProgressResult>(); const fresh = deferred<WorkItemProgressResult>();
  env.submit.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
  const page = open(); save(); const intent = env.submit.mock.calls[0][0];
  if (scope === 'reopen') { page.update({ open: false }); page.update({ open: true }); }
  else if (scope === 'account') { env.generation++; page.update({}); }
  else page.update({ snapshot: { ...base,
    ...(scope === 'project' ? { projectId: 'p2' } : scope === 'session' ? { sessionId: 's2' }
      : scope === 'binding' ? { bindingRevision: 5 } : { progressRevision: 9 }) } });
  save(); expect(env.submit).toHaveBeenCalledTimes(2);
  await act(async () => { if (completion === 'resolve') old.resolve(result(intent)); else old.reject(new Error('[FORBIDDEN] old scope')); });
  expect(env.saved).not.toHaveBeenCalled(); expect(env.close).not.toHaveBeenCalled(); expect(env.refresh).not.toHaveBeenCalled();
  expect(screen.queryByRole('alert')).toBeNull();
  expect((screen.getByRole('button', { name: 'save' }) as HTMLButtonElement).disabled).toBe(true);
  await act(async () => fresh.reject(new Error('current failure'))); await screen.findByText('error.uncertain');
});

it('discards form content and pending intent when the read authority snapshot changes', async () => {
  const pending = deferred<WorkItemProgressResult>(); env.submit.mockReturnValue(pending.promise);
  const page = open(); save();
  page.update({ snapshot: { ...base, canRecord: false } });
  expect(screen.queryByText('Task one')).toBeNull(); expect(screen.queryByRole('combobox')).toBeNull();
  await act(async () => pending.resolve(result(env.submit.mock.calls[0][0])));
  expect(env.saved).not.toHaveBeenCalled(); expect(env.close).not.toHaveBeenCalled();
});

it('can submit from a preview origin without crypto.randomUUID', async () => {
  const getRandomValues = crypto.getRandomValues.bind(crypto);
  vi.stubGlobal('crypto', { getRandomValues });
  open(); save(); await waitFor(() => expect(env.saved).toHaveBeenCalledTimes(1));
  expect(env.submit.mock.calls[0][0].requestId).toMatch(/^progress-[0-9a-f]{32}$/);
});

it('ignores old failures on close/reopen and refuses a mismatched success receipt', async () => {
  const pending = deferred<WorkItemProgressResult>(); env.submit.mockReturnValueOnce(pending.promise);
  const page = open(); save(); const intent = env.submit.mock.calls[0][0];
  page.update({ open: false }); page.update({ open: true });
  await act(async () => pending.reject(new Error('[FORBIDDEN] old')));
  expect(screen.queryByRole('alert')).toBeNull(); expect(screen.queryByText('Task one')).not.toBeNull();
  env.submit.mockResolvedValue(result({ ...intent, sessionId: 'wrong' })); save(); await screen.findByText('error.stale');
  expect(env.saved).not.toHaveBeenCalled(); expect(env.refresh).not.toHaveBeenCalled();
});
