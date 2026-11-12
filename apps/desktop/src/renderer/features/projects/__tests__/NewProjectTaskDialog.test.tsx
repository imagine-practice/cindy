// @vitest-environment jsdom
// Value: the project "new task" dialog must never trap the user on a pending creation that can
// no longer succeed (task deleted, project archived, membership revoked). It also must not let a
// retry mint a second task: the retained request keeps its sessionId until it is explicitly
// discarded. Minimal failure: a terminal rejection leaves the form frozen forever, or a retry
// creates a second task row instead of replaying the first one.
// Tier: unit (dialog + real pendingProjectTask storage); IPC is stubbed at projectService.
// Not covered here: the real IPC/DB path (covered by entityProjectMutation.test.ts) and the
// page that mounts this dialog (ProjectDetailPage.test.tsx).
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewProjectTaskDialog } from '../NewProjectTaskDialog';
import { pendingProjectTaskKey, type PendingProjectTask } from '../pendingProjectTask';

const env = vi.hoisted(() => ({ mutate: vi.fn(), created: vi.fn() }));

vi.mock('../projectService', () => ({ mutateProject: (request: unknown) => env.mutate(request) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: 'acct-1' }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => ({ dataOwnerId: 'acct-1', generation: 1 }),
  isDataOwnerGenerationCurrent: () => true,
}));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
// The dialog body is the unit here; primitives and the modal shell only need to render.
vi.mock('@radix-ui/react-dialog', () => ({
  Root: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Portal: ({ children }: { children: React.ReactNode }) => <>{children}</>,
  Overlay: () => null,
  Content: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
  Title: ({ children }: { children: React.ReactNode }) => <h2>{children}</h2>,
  Description: ({ children }: { children: React.ReactNode }) => <p>{children}</p>,
}));
vi.mock('@/components/ui/form-field', () => ({
  FormField: ({ label, children }: { label: string; children: (control: object) => React.ReactNode }) =>
    <label>{label}{children({})}</label>,
}));
vi.mock('@/components/ui/input', () => ({
  Input: (props: React.InputHTMLAttributes<HTMLInputElement>) => <input {...props} onChange={event => props.onChange?.(event as never)} />,
  Textarea: (props: React.TextareaHTMLAttributes<HTMLTextAreaElement>) => <textarea {...props} onChange={event => props.onChange?.(event as never)} />,
}));
vi.mock('@/components/ui/select', () => ({
  Select: ({ label, value, disabled, options, onValueChange }: {
    label: string; value: string; disabled?: boolean;
    options: { value: string; label: string }[]; onValueChange(value: string): void;
  }) => <select aria-label={label} value={value} disabled={disabled}
    onChange={event => onValueChange(event.target.value)}>
    {options.map(option => <option key={option.value} value={option.value}>{option.label}</option>)}
  </select>,
}));

const PROJECT = 'p1';
const KEY = pendingProjectTaskKey('acct-1', PROJECT);
const retained: PendingProjectTask = { action: 'createWorkItem', projectId: PROJECT, sessionId: 'kept-session',
  title: 'Draft task', taskObjective: 'Draft goal', assignee: null };

function seed() {
  localStorage.setItem(`${KEY}.${retained.sessionId}`, JSON.stringify(retained));
}

function rejection(code: string) {
  return Object.assign(new Error(code), { code });
}

function renderDialog() {
  return render(<NewProjectTaskDialog projectId={PROJECT} members={[]} labelOf={() => ''}
    onClose={() => {}} onCreated={env.created} />);
}

beforeEach(() => {
  vi.clearAllMocks();
  localStorage.clear();
  // The receipt must echo the request's own session id; anything else is an invalid receipt.
  env.mutate.mockImplementation(async (request: PendingProjectTask) => ({ projectId: request.projectId, sessionId: request.sessionId }));
});
afterEach(cleanup);

it('M1 lets the user discard a pending creation that can never succeed, then create a new task', async () => {
  seed();
  env.mutate.mockRejectedValueOnce(rejection('PRECONDITION_FAILED'));
  renderDialog();
  fireEvent.click(screen.getByText('ccAgent.projectCore.taskCreate.submit'));
  await waitFor(() => expect(env.mutate).toHaveBeenCalledTimes(1));
  // The retained request keeps its identity on retry: replaying it is what prevents a second row.
  expect((env.mutate.mock.calls[0]![0] as PendingProjectTask).sessionId).toBe('kept-session');
  // Still frozen: an unknown/terminal failure must not silently drop the record.
  expect(localStorage.getItem(`${KEY}.kept-session`)).not.toBeNull();
  // The explicit way out: discard needs a second confirmation, then unlocks the form.
  fireEvent.click(await screen.findByText('ccAgent.projectCore.taskCreate.discardPending'));
  expect(localStorage.getItem(`${KEY}.kept-session`)).not.toBeNull();
  fireEvent.click(screen.getByText('ccAgent.projectCore.taskCreate.discardPendingConfirm'));
  await waitFor(() => expect(localStorage.getItem(`${KEY}.kept-session`)).toBeNull());
  fireEvent.click(screen.getByText('ccAgent.projectCore.taskCreate.submit'));
  await waitFor(() => expect(env.mutate).toHaveBeenCalledTimes(2));
  const next = env.mutate.mock.calls[1]![0] as PendingProjectTask;
  expect(next.sessionId).not.toBe('kept-session');
  expect(next.title).toBe('Draft task');
  await waitFor(() => expect(env.created).toHaveBeenCalledWith(next.sessionId));
});

it('M1 replays the retained request with the same session id until it is discarded', async () => {
  seed();
  env.mutate.mockRejectedValueOnce(rejection('PRECONDITION_FAILED'))
    .mockRejectedValueOnce(rejection('PRECONDITION_FAILED'));
  renderDialog();
  fireEvent.click(screen.getByText('ccAgent.projectCore.taskCreate.submit'));
  await waitFor(() => expect(env.mutate).toHaveBeenCalledTimes(1));
  fireEvent.click(screen.getByText('ccAgent.projectCore.taskCreate.submit'));
  await waitFor(() => expect(env.mutate).toHaveBeenCalledTimes(2));
  const [first, second] = env.mutate.mock.calls.map(call => call[0] as PendingProjectTask);
  expect(second!.sessionId).toBe(first!.sessionId);
  expect(second).toEqual(first);
});
