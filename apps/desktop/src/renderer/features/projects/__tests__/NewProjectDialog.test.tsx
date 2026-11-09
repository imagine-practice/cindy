// @vitest-environment jsdom
/**
 * Value: real create dialog -> submitted owner/member intent, with controlled auth/Select/service.
 * Bug: selecting a bot owner omitted the creator account from members.
 * Gap: materials lifecycle tests do not exercise project creation; no existing dialog suite.
 * Minimal input: creator account + one bot selected as owner, submit a valid name.
 * Tier: unit. No DB/access predicate/IPC claims; backend author validates trusted actor separately.
 * Standalone measurement: 3.06s wall, 257ms tests (2026-11-05, four initial cases).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { NewProjectDialog } from '../NewProjectDialog';
const env = vi.hoisted(() => ({ create: vi.fn(), close: vi.fn(), account: 'creator', generation: 1, anonymous: false }));
vi.mock('../projectService', () => ({ createProject: env.create }));
vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/contexts/AuthContext', () => ({ useOptionalAuth: () => ({ dataOwnerId: env.account,
  dataOwnerGeneration: env.generation, user: env.anonymous ? null : { name: env.account } }) }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({ getDataOwnerGeneration: () => env.generation,
  isDataOwnerGenerationCurrent: (owner: number) => owner === env.generation }));
vi.mock('@/features/bots/botStore', () => ({ useBotProfiles: () => [
  { id: 'bot-one', name: 'Same name', status: 'active', avatar: 'A' },
  { id: 'bot-two', name: 'Same name', status: 'active', avatar: 'B' },
] }));
beforeEach(() => {
  vi.resetAllMocks();
  env.account = 'creator';
  env.generation = 1;
  env.anonymous = false;
  env.create.mockResolvedValue(undefined);
  (window as unknown as { electronAPI: unknown }).electronAPI = {
    showOpenDirectoryDialog: vi.fn(async () => ({ canceled: false, path: '/work/claimed' })),
  };
});
afterEach(cleanup);
function open() {
  render(<NewProjectDialog open onOpenChange={env.close} />);
  fireEvent.change(screen.getByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'), { target: { value: 'Project' } });
}
const radios = () => screen.getAllByRole('radio') as HTMLInputElement[];
/** 0 = creator account, 1 = bot-one, 2 = bot-two（候选按账号在前、伙伴在后）。 */
const owner = (index: number) => fireEvent.click(radios()[index]);
const submit = () => fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.submit' }));

it('shows creator as a required ordinary member for bot owner and submits matching intent', async () => {
  open(); owner(1);
  const creator = screen.getAllByRole('checkbox')[0] as HTMLInputElement;
  expect(creator.checked).toBe(true); expect(creator.disabled).toBe(true);
  expect(screen.queryByText('ccAgent.projectCore.form.creatorMember')).not.toBeNull();
  submit(); await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
  expect(env.create.mock.calls[0][0]).toEqual({ name: 'Project', goal: null,
    owner: { kind: 'bot', id: 'bot-one' }, members: [{ kind: 'account', id: 'creator' }], dirs: [] });
});

it('cancels without writes', () => {
  open(); owner(1);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.cancel' }));
  expect(env.close).toHaveBeenCalledWith(false); expect(env.create).not.toHaveBeenCalled();
});

it('keeps same-name stable IDs distinct and deduplicates repeated member toggles and submit', async () => {
  env.create.mockReturnValue(new Promise(() => {})); open(); owner(0);
  // 负责人已从成员列表里移除：剩下的复选框就是两个伙伴。
  const checks = screen.getAllByRole('checkbox');
  fireEvent.click(checks[0]); fireEvent.click(checks[1]); fireEvent.click(checks[0]); fireEvent.click(checks[0]);
  submit(); submit();
  expect(env.create).toHaveBeenCalledExactlyOnceWith({ name: 'Project', goal: null,
    owner: { kind: 'account', id: 'creator' }, members: [
      { kind: 'bot', id: 'bot-one' }, { kind: 'bot', id: 'bot-two' },
    ], dirs: [] });
});

it('switches owner while retaining selected members and deduplicates creator as account owner', async () => {
  open(); owner(1); owner(2); owner(0);
  submit(); await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
  expect(env.create.mock.calls[0][0]).toEqual({ name: 'Project', goal: null,
    owner: { kind: 'account', id: 'creator' }, members: [
      { kind: 'bot', id: 'bot-one' }, { kind: 'bot', id: 'bot-two' },
    ], dirs: [] });
});

it('preserves explicit membership across owner switches and submits only the selected bot as owner', async () => {
  open(); fireEvent.click(screen.getAllByRole('checkbox')[1]);
  owner(1); owner(2);
  submit(); await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
  expect(env.create.mock.calls[0][0]).toEqual({ name: 'Project', goal: null,
    owner: { kind: 'bot', id: 'bot-two' }, members: [
      { kind: 'account', id: 'creator' }, { kind: 'bot', id: 'bot-one' },
    ], dirs: [] });
});

// Independent account-switch regression, then the same ticket/finally boundary for epoch and open rounds.
function pending() { let resolve!: () => void; let reject!: (error: Error) => void;
  const promise = new Promise<void>((r, j) => { resolve = r; reject = j; }); return { promise, resolve, reject }; }
const name = (value: string) => fireEvent.change(screen.getByPlaceholderText('ccAgent.projectCore.form.namePlaceholder'), { target: { value } });
it.each(['account', 'epoch', 'reopen', 'unmount'].flatMap(scope => ['success', 'failure'].map(outcome => ({ scope, outcome }))))(
  'isolates old $outcome/finally after $scope while the new form is busy', async ({ scope, outcome }) => {
    const old = pending(); const fresh = pending(); const created = vi.fn();
    env.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(fresh.promise);
    const props = { open: true, onOpenChange: env.close, onCreated: created };
    const page = render(<NewProjectDialog {...props} />); name('Old project'); owner(1); submit();
    expect(env.create).toHaveBeenCalledTimes(1);
    if (scope === 'account' || scope === 'epoch') { env.generation++; if (scope === 'account') env.account = 'next-account'; page.rerender(<NewProjectDialog {...props} />); }
    else if (scope === 'reopen') { page.rerender(<NewProjectDialog {...props} open={false} />); page.rerender(<NewProjectDialog {...props} />); }
    else { page.unmount(); render(<NewProjectDialog {...props} />); }
    expect((screen.getByPlaceholderText('ccAgent.projectCore.form.namePlaceholder') as HTMLInputElement).value).toBe('');
    name('New project'); owner(1); submit(); expect(env.create).toHaveBeenCalledTimes(2);
    await act(async () => { if (outcome === 'success') old.resolve(); else old.reject(new Error('[FORBIDDEN] obsolete account')); });
    expect(env.close).not.toHaveBeenCalled(); expect(created).not.toHaveBeenCalled(); expect(screen.queryByRole('alert')).toBeNull();
    submit(); expect(env.create).toHaveBeenCalledTimes(2);
    await act(async () => fresh.resolve());
    expect(env.close).toHaveBeenCalledExactlyOnceWith(false); expect(created).toHaveBeenCalledTimes(1);
  },
);

it('suppresses an old failure while the switched account form is idle', async () => {
  const old = pending(); env.create.mockReturnValueOnce(old.promise); const created = vi.fn();
  const props = { open: true, onOpenChange: env.close, onCreated: created };
  const page = render(<NewProjectDialog {...props} />); name('Old'); owner(1); submit();
  env.account = 'next-account'; env.generation++; page.rerender(<NewProjectDialog {...props} />);
  await act(async () => old.reject(new Error('[FORBIDDEN] old')));
  expect(screen.queryByRole('alert')).toBeNull(); expect(created).not.toHaveBeenCalled(); expect(env.close).not.toHaveBeenCalled();
});

it('lists the selected owner only once and never labels the account as a role', async () => {
  // 未登录昵称时账号行显示「当前账号」，不再退化成「负责人」。
  env.anonymous = true;
  open();
  expect(screen.getAllByText('ccAgent.projectCore.form.currentAccount').length).toBeGreaterThan(0);
  expect(screen.queryByText('ccAgent.projectCore.detail.ownerBadge')).toBeNull();
  owner(1);
  // 负责人（bot-one）不再出现在成员复选列表里。
  expect(screen.getAllByRole('checkbox')).toHaveLength(2);
});

it('claims a picked folder with the same key vocabulary as the sidebar and submits it', async () => {
  open(); owner(0);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.projectCore.form.dirsPick' }));
  await waitFor(() => expect(screen.getByText('/work/claimed')).toBeTruthy());
  submit(); await waitFor(() => expect(env.create).toHaveBeenCalledTimes(1));
  expect(env.create.mock.calls[0][0].dirs).toEqual([
    { dirKey: 'local:/work/claimed', dirPath: '/work/claimed' },
  ]);
});

it('never preselects an owner and reports the missing owner instead of submitting', async () => {
  open();
  expect(radios().every((radio) => !radio.checked)).toBe(true);
  submit();
  await waitFor(() => expect(screen.getByText('ccAgent.projectCore.form.ownerRequired')).toBeTruthy());
  expect(env.create).not.toHaveBeenCalled();
});

it('keeps IME Enter from submitting the form', () => {
  open(); const input = screen.getByPlaceholderText('ccAgent.projectCore.form.namePlaceholder');
  expect(fireEvent.keyDown(input, { key: 'Enter', keyCode: 229, isComposing: true })).toBe(false);
  expect(env.create).not.toHaveBeenCalled();
});
