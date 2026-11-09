// @vitest-environment jsdom
// Renderer unit integration: real Radix dialog/primitives -> controlled callback.
// Contract: metadata-only minimal patch, immutable scope/open epoch, no stale save publication.
// Prior create dialog tests do not cover edit diff/null semantics or this component lifecycle.
// Minimal adverse inputs: same-name projects, deferred save + scope switch, full outside click.
import { useState } from 'react';
import { act, cleanup, fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInstance } from 'i18next';
import { I18nextProvider } from 'react-i18next';
import en from '../../../i18n/locales/en/common.json';
import { setDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import {
  EditProjectDialog,
  type EditProjectDialogProps,
  type ProjectMetadataPatch,
} from '../EditProjectDialog';
vi.mock('@/contexts/AuthContext', () => ({ useOptionalDataOwnerGeneration: () => 0 }));
const i18n = createInstance();
void i18n.init({
  lng: 'en',
  resources: { en: { translation: en } },
  initAsync: false,
  interpolation: { escapeValue: false },
});
const save = vi.fn<(patch: ProjectMetadataPatch) => Promise<void>>();
const change = vi.fn();
const saved = vi.fn();
const base: EditProjectDialogProps = {
  open: true,
  projectId: 'p1',
  name: 'Same name',
  goal: 'Old goal',
  scopeToken: 'view-1',
  canEdit: true,
  onSave: save,
  onOpenChange: change,
  onSaved: saved,
};
const tree = (patch: Partial<EditProjectDialogProps> = {}) => (
  <I18nextProvider i18n={i18n}>
    <EditProjectDialog {...base} {...patch} />
  </I18nextProvider>
);
const name = () => screen.getByRole('textbox', { name: /Name/ }) as HTMLInputElement;
const goal = () => screen.getByRole('textbox', { name: 'Goal' }) as HTMLTextAreaElement;
const saveButton = () => screen.getByRole('button', { name: 'Save' });
const edit = (field: HTMLElement, value: string) => fireEvent.change(field, { target: { value } });
const submit = () => fireEvent.submit(name().closest('form')!);
async function settle() {
  await act(async () => {
    await Promise.resolve();
  });
}
function deferred() {
  let resolve!: () => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<void>((a, b) => {
    resolve = a;
    reject = b;
  });
  return { promise, resolve, reject };
}
beforeEach(() => {
  setDataOwnerGeneration('owner-a', 1);
  save.mockReset().mockResolvedValue(undefined);
  change.mockReset();
  saved.mockReset();
});
afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});
it.each([
  ['name', '  Renamed  ', { projectId: 'p1', name: 'Renamed' }],
  ['goal', '  New goal  ', { projectId: 'p1', goal: 'New goal' }],
  ['goal', '  ', { projectId: 'p1', goal: null }],
] as const)(
  'submits only changed %s, trimmed with explicit null clearing',
  async (field, value, patch) => {
    render(tree());
    edit(field === 'name' ? name() : goal(), value);
    fireEvent.click(saveButton());
    await settle();
    expect(save).toHaveBeenCalledExactlyOnceWith(patch);
    expect(change).toHaveBeenCalledExactlyOnceWith(false);
    expect(saved).toHaveBeenCalledTimes(1);
  },
);
it('normalizes unchanged whitespace to zero writes and omits unchanged fields', async () => {
  render(tree());
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  edit(name(), ' Same name ');
  edit(goal(), ' Old goal ');
  submit();
  await settle();
  expect(save).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
});
it.each([
  ['name', '   ', 'Enter a project name.'],
  ['name', 'x'.repeat(121), 'Use 120 characters or fewer.'],
  ['goal', 'x'.repeat(2001), 'Use 2000 characters or fewer.'],
])('validates %s without relying only on native maxlength', async (field, value, error) => {
  render(tree());
  edit(field === 'name' ? name() : goal(), value);
  submit();
  await settle();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByText(error)).toBeTruthy();
});
it('cancel before submission is zero calls', () => {
  render(tree());
  edit(name(), 'Draft');
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
  expect(save).not.toHaveBeenCalled();
});
it('guards repeated submission and every busy dismissal while keeping the original payload', async () => {
  const pending = deferred();
  save.mockReturnValueOnce(pending.promise);
  render(tree());
  edit(name(), 'Renamed');
  submit();
  submit();
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  fireEvent.keyDown(name(), { key: 'Escape', code: 'Escape' });
  expect(save).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  pending.resolve();
  await settle();
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
});
it('a permission rejection retains edits, hides raw error text and allows explicit retry', async () => {
  save.mockRejectedValueOnce(
    Object.assign(new Error('Private server details'), { code: 'NOT_PROJECT_OWNER' }),
  );
  render(tree());
  edit(name(), 'My draft');
  submit();
  await settle();
  expect(name().value).toBe('My draft');
  expect(screen.getByRole('alert').textContent).toContain('edits are kept');
  expect(screen.queryByText('Private server details')).toBeNull();
  expect(change).not.toHaveBeenCalled();
  fireEvent.click(saveButton());
  await settle();
  expect(save).toHaveBeenCalledTimes(2);
  expect(save.mock.calls[1][0]).toEqual(save.mock.calls[0][0]);
});
it('canEdit is a presentation hint and disabled submit cannot create a write', () => {
  render(tree({ canEdit: false }));
  submit();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('status').textContent).toContain('owner');
  expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
});
it.each(['project', 'account', 'epoch', 'token', 'reopen'] as const)(
  'late success/error/finally cannot affect the new %s scope',
  async (mode) => {
    const first = deferred();
    const next = deferred();
    save.mockReturnValueOnce(first.promise).mockReturnValueOnce(next.promise);
    const view = render(tree());
    edit(name(), 'Old draft');
    submit();
    let props: Partial<EditProjectDialogProps> = {};
    if (mode === 'project') props = { projectId: 'p2' };
    if (mode === 'account') setDataOwnerGeneration('owner-b', 2);
    if (mode === 'epoch') setDataOwnerGeneration('owner-a', 2);
    if (mode === 'token') props = { scopeToken: 'view-2' };
    if (mode === 'reopen') {
      view.rerender(tree({ open: false }));
    }
    view.rerender(tree(props));
    expect(name().value).toBe('Same name');
    {
      edit(name(), 'New draft');
      submit();
      expect(save).toHaveBeenCalledTimes(2);
    }
    first.resolve();
    await settle();
    expect(change).not.toHaveBeenCalled();
    expect(saved).not.toHaveBeenCalled();
    expect(screen.queryByRole('alert')).toBeNull();
    {
      expect(screen.getByRole('button', { name: 'Saving…' }).hasAttribute('disabled')).toBe(true);
      expect(name().value).toBe('New draft');
      next.resolve();
      await settle();
      expect(change).toHaveBeenCalledExactlyOnceWith(false);
    }
  },
);
it.each(['project', 'reopen', 'epoch'] as const)(
  'old failure does not show in a new %s form',
  async (mode) => {
    const pending = deferred();
    save.mockReturnValueOnce(pending.promise);
    const view = render(tree());
    edit(name(), 'Old');
    submit();
    if (mode === 'reopen') view.rerender(tree({ open: false }));
    if (mode === 'epoch') setDataOwnerGeneration('owner-a', 2);
    view.rerender(tree(mode === 'project' ? { projectId: 'p2' } : {}));
    edit(name(), 'New');
    pending.reject(new Error('denied'));
    await settle();
    expect(name().value).toBe('New');
    expect(screen.queryByRole('alert')).toBeNull();
    expect(change).not.toHaveBeenCalled();
    expect(saveButton().hasAttribute('disabled')).toBe(false);
  },
);
it('same-named project IDs are never inferred from title', async () => {
  const view = render(tree());
  view.rerender(tree({ projectId: 'p2' }));
  edit(goal(), 'Other');
  submit();
  await settle();
  expect(save).toHaveBeenCalledExactlyOnceWith({ projectId: 'p2', goal: 'Other' });
});
it('same-scope parent refresh cannot replace a local draft', () => {
  const view = render(tree());
  edit(name(), 'Keep this draft');
  view.rerender(tree({ name: 'Server update', goal: 'Server goal' }));
  expect(name().value).toBe('Keep this draft');
  expect(goal().value).toBe('Old goal');
});
it('unmount prevents late callbacks without pretending the write was canceled', async () => {
  const pending = deferred();
  save.mockReturnValueOnce(pending.promise);
  const view = render(tree());
  edit(name(), 'New');
  submit();
  view.unmount();
  pending.resolve();
  await settle();
  expect(save).toHaveBeenCalledTimes(1);
  expect(change).not.toHaveBeenCalled();
  expect(saved).not.toHaveBeenCalled();
});
it('invalid trusted identity fails closed', () => {
  render(tree({ projectId: '', scopeToken: '' }));
  submit();
  expect(save).not.toHaveBeenCalled();
  expect(screen.getByRole('status')).toBeTruthy();
});
it('full outside mouse click cannot close, Escape and Cancel close and restore trigger focus', async () => {
  vi.useFakeTimers();
  vi.stubGlobal(
    'PointerEvent',
    class extends MouseEvent {
      pointerType: string;
      constructor(type: string, init: PointerEventInit = {}) {
        super(type, init);
        this.pointerType = init.pointerType ?? 'mouse';
      }
    },
  );
  function Harness() {
    const [open, setOpen] = useState(false);
    return (
      <>
        <button onClick={() => setOpen(true)}>Edit trigger</button>
        <EditProjectDialog
          {...base}
          open={open}
          onOpenChange={(value) => {
            change(value);
            setOpen(value);
          }}
        />
      </>
    );
  }
  render(
    <I18nextProvider i18n={i18n}>
      <Harness />
    </I18nextProvider>,
  );
  const trigger = screen.getByRole('button', { name: 'Edit trigger' });
  trigger.focus();
  fireEvent.click(trigger);
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(document.activeElement).toBe(name());
  const overlay = document.querySelector('.modal-scrim')!;
  for (const pointerType of ['mouse', 'touch']) {
    fireEvent.pointerDown(overlay, { button: 0, buttons: 1, pointerType });
    fireEvent.pointerUp(overlay, { button: 0, buttons: 0, pointerType });
    fireEvent.click(overlay, { button: 0 });
    await act(async () => {
      vi.runOnlyPendingTimers();
    });
    expect(change).not.toHaveBeenCalled();
    expect(screen.getByRole('dialog')).toBeTruthy();
  }
  fireEvent.keyDown(name(), { key: 'Escape', code: 'Escape' });
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(change).toHaveBeenCalledExactlyOnceWith(false);
  expect(document.activeElement).toBe(trigger);
  fireEvent.click(trigger);
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
  await act(async () => {
    vi.runOnlyPendingTimers();
  });
  expect(document.activeElement).toBe(trigger);
  expect(save).not.toHaveBeenCalled();
});
it('IME confirmation never submits or dismisses; ordinary Enter submits once, textarea Enter is a newline', async () => {
  const user = userEvent.setup();
  render(tree());
  edit(name(), 'Renamed');
  name().focus();
  fireEvent.compositionStart(name());
  await user.keyboard('{Enter}{Escape}');
  expect(save).not.toHaveBeenCalled();
  expect(change).not.toHaveBeenCalled();
  fireEvent.compositionEnd(name());
  goal().focus();
  await user.keyboard('{Enter}');
  expect(save).not.toHaveBeenCalled();
  name().focus();
  await user.keyboard('{Enter}');
  await settle();
  expect(save).toHaveBeenCalledTimes(1);
});

// canEdit is a hint, not a new form identity or a reason to erase rejected edits.
it('a read-only hint after rejection preserves the current draft and disables another save', async () => {
  const pending = deferred();
  save.mockReturnValueOnce(pending.promise);
  const view = render(tree());
  edit(name(), 'Keep rejected draft');
  submit();
  view.rerender(tree({ canEdit: false }));
  pending.reject(new Error('denied'));
  await settle();
  expect(name().value).toBe('Keep rejected draft');
  expect(screen.getByRole('alert')).toBeTruthy();
  expect(saveButton().hasAttribute('disabled')).toBe(true);
  expect(change).not.toHaveBeenCalled();
});
