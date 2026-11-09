// @vitest-environment jsdom
/**
 * Value: controlled list/create completions through the real snapshot component.
 * Rule: work-item changes invalidate old reads and write UI intent, including finally.
 * Gap: model/panel tests do not exercise contexts, picker or pending create lifecycle.
 * Minimal input: s1 request pending, switch to s2, finish requests out of order.
 * Tier: unit; fake service promises, no host/account/database. Separate DOM entry.
 * Standalone measurement: 2.36s wall, 377ms tests (2026-11-05).
 */
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaterialSnapshotSection as ActualSnapshot } from '../MaterialSnapshotSection';
import type { Material, MaterialContext, MaterialReferenceService } from '../materialReferenceView';
import {
  scope,
  material as makeMaterial,
  context as makeContext,
  bridge,
  install,
  list as currentList,
} from './referenceTestSupport';
import { createMaterialReferenceService } from '../materialReferenceService';

const env = vi.hoisted(() => ({
  list: vi.fn(),
  create: vi.fn(),
  success: vi.fn(),
  error: vi.fn(),
  owner: 1,
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({ t: (key: string) => key }),
}));
vi.mock('@/components/chat/FileLightbox', () => ({ FileLightbox: () => null }));
vi.mock('@/lib/toast', () => ({ toast: { success: env.success, error: env.error } }));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => env.owner,
  isDataOwnerGenerationCurrent: (owner: number) => owner === env.owner,
}));
vi.mock('@/components/ui/select', () => ({
  Select: (props: {
    label: string;
    value: string;
    options: { value: string; label: string }[];
    onValueChange: (value: string) => void;
    disabled?: boolean;
  }) => (
    <select
      aria-label={props.label}
      value={props.value}
      disabled={props.disabled}
      onChange={(e) => props.onValueChange(e.target.value)}
    >
      {props.options.map((o) => (
        <option key={o.value} value={o.value}>
          {o.label}
        </option>
      ))}
    </select>
  ),
}));
function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
const materials = [makeMaterial()];
const context = { ...makeContext(), purpose: 'recheck' as const };
const service = {
  listContexts: async (p: unknown) => ({ contexts: await env.list(p) }),
  createContext: async (p: unknown) => ({ context: await env.create(p) }),
  preview: vi.fn(),
} as unknown as MaterialReferenceService;
function MaterialSnapshotSection({
  workItemId,
  materials,
}: {
  workItemId: string;
  materials: Material[];
}) {
  return (
    <ActualSnapshot
      scope={scope(workItemId)}
      service={service}
      materials={materials.map((m) => ({
        ...m,
        reference: { ...m.reference, workItemId, id: `ref-${workItemId}` },
      }))}
      onInvalidate={() => {}}
    />
  );
}
const open = () =>
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.snapshot.create' }));
const confirm = () => screen.getByRole('button', { name: 'ccAgent.materials.snapshot.confirm' });
beforeEach(() => {
  vi.resetAllMocks();
  env.owner = 1;
  env.list.mockResolvedValue([]);
});
afterEach(cleanup);

it.each(['resolve', 'reject'] as const)(
  'ignores old list %s and finally while current list remains pending',
  async (completion) => {
    const old = deferred<MaterialContext[]>();
    const current = deferred<MaterialContext[]>();
    env.list.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const page = render(<MaterialSnapshotSection workItemId="s1" materials={[]} />);
    page.rerender(<MaterialSnapshotSection workItemId="s2" materials={[]} />);
    await act(async () => {
      if (completion === 'resolve') old.resolve([context]);
      else old.reject(new Error('old'));
    });
    expect(screen.queryByText('ccAgent.materials.snapshot.loading')).not.toBeNull();
    expect(screen.queryByText('ccAgent.materials.snapshot.purpose.recheck')).toBeNull();
    expect(screen.queryByText('ccAgent.materials.snapshot.loadFailed')).toBeNull();
    await act(async () => current.resolve([]));
    expect(screen.queryByText('ccAgent.materials.snapshot.empty')).not.toBeNull();
  },
);

it.each(['resolve', 'reject'] as const)(
  'resets picker intent and ignores old create %s/finally',
  async (completion) => {
    const old = deferred<MaterialContext>();
    const current = deferred<MaterialContext>();
    env.create.mockReturnValueOnce(old.promise).mockReturnValueOnce(current.promise);
    const page = render(<MaterialSnapshotSection workItemId="s1" materials={materials} />);
    await screen.findByText('ccAgent.materials.snapshot.empty');
    open();
    fireEvent.change(screen.getByLabelText('ccAgent.materials.snapshot.pickerPurpose'), {
      target: { value: 'redecompose' },
    });
    fireEvent.click(confirm());
    page.rerender(
      <MaterialSnapshotSection
        workItemId="s2"
        materials={[{ ...materials[0], id: 'm2', workItemId: 's2' }]}
      />,
    );
    expect(screen.queryByRole('alertdialog')).toBeNull();
    await screen.findByText('ccAgent.materials.snapshot.empty');
    open();
    fireEvent.click(confirm());
    open();
    expect(env.create.mock.calls[1]).toEqual([
      {
        ...scope('s2'),
        purpose: 'reference',
        refs: [{ referenceId: 'ref-s2', materialId: 'm2', version: 1 }],
      },
    ]);
    await act(async () => {
      if (completion === 'resolve') old.resolve(context);
      else old.reject(new Error('old'));
    });
    expect(confirm().hasAttribute('disabled')).toBe(true);
    expect(env.success).not.toHaveBeenCalled();
    expect(env.error).not.toHaveBeenCalled();
    expect(env.list).toHaveBeenCalledTimes(2);
    await act(async () => current.resolve({ ...context, workItemId: 's2' }));
    expect(env.success).toHaveBeenCalledTimes(1);
  },
);

it('keeps latest list refresh when an older retry returns last', async () => {
  const old = deferred<MaterialContext[]>();
  const latest = deferred<MaterialContext[]>();
  env.list
    .mockRejectedValueOnce(new Error('initial'))
    .mockReturnValueOnce(old.promise)
    .mockReturnValueOnce(latest.promise);
  render(<MaterialSnapshotSection workItemId="s1" materials={materials} />);
  const retry = await screen.findByRole('button', { name: 'ccAgent.materials.retryLoad' });
  fireEvent.click(retry);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.referenceHistory' }));
  await act(async () => latest.resolve([]));
  await act(async () => old.resolve([context]));
  expect(screen.queryByText('ccAgent.materials.snapshot.empty')).not.toBeNull();
  expect(screen.queryByText('ccAgent.materials.snapshot.purpose.recheck')).toBeNull();
});

it('clears visible old contexts on work-item change and ignores unmounted create completion', async () => {
  const pending = deferred<MaterialContext>();
  env.create.mockReturnValue(pending.promise);
  env.list.mockResolvedValueOnce([context]).mockResolvedValue([]);
  const page = render(<MaterialSnapshotSection workItemId="s1" materials={materials} />);
  await screen.findByText('ccAgent.materials.snapshot.purpose.recheck');
  page.rerender(<MaterialSnapshotSection workItemId="s2" materials={materials} />);
  expect(screen.queryByText('ccAgent.materials.snapshot.purpose.recheck')).toBeNull();
  await screen.findByText('ccAgent.materials.snapshot.empty');
  open();
  fireEvent.click(confirm());
  page.unmount();
  await act(async () => pending.resolve(context));
  expect(env.success).not.toHaveBeenCalled();
  expect(env.list).toHaveBeenCalledTimes(2);
});

it('ignores owner-invalid list completions and blocks an old scope creating a snapshot', async () => {
  const pending = deferred<MaterialContext[]>();
  env.list.mockReturnValue(pending.promise);
  render(<MaterialSnapshotSection workItemId="s1" materials={materials} />);
  env.owner = 2;
  await act(async () => pending.resolve([context]));
  expect(screen.queryByText('ccAgent.materials.snapshot.purpose.recheck')).toBeNull();
  open();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(env.create).not.toHaveBeenCalled();
});

// 2026-11-06 client repro: current list empty after removing v2; legal v1 snapshot
// still previews bytes, but loses name/title. Real DOM + strict service + controlled bridge.
// No actual DB, bytes, permissions or account. Existing lifecycle tests above use a fake service.
const archivedMaterial = (s = scope(), name = 'original-brief.txt') => {
  const m = makeMaterial(s, 2, 2);
  return {
    ...m,
    name,
    status: 'removed' as const,
    reference: { ...m.reference, status: 'removed' as const },
  };
};
async function historyHarness(
  s = scope(),
  pin = makeContext(s),
  archive: Material[] = [archivedMaterial(s)],
) {
  install();
  bridge.materials.list.mockImplementation(async (p) =>
    p.history === true
      ? {
          referenceContract: 1,
          projectId: s.projectId,
          workItemId: s.workItemId,
          history: true,
          materials: archive,
        }
      : currentList(s, []),
  );
  bridge.materialContexts.list.mockImplementation(async (p) =>
    p.history === true
      ? {
          referenceContract: 1,
          projectId: s.projectId,
          workItemId: s.workItemId,
          history: true,
          contexts: [pin],
        }
      : {
          referenceContract: 1,
          scope: s,
          contexts: pin.bindingRevision === s.bindingRevision ? [pin] : [],
        },
  );
  bridge.materials.preview.mockImplementation(async (p) => ({
    referenceContract: 1,
    materialId: p.materialId,
    version: p.version,
    kind: 'text',
    text: 'IMMUTABLE V1',
    name: 'original-brief.txt',
    mime: 'text/plain',
    size: 12,
  }));
  const real = createMaterialReferenceService(s);
  await real.list();
  const invalidate = vi.fn();
  const node = (materials: Material[] = []) => (
    <ActualSnapshot scope={s} service={real} materials={materials} onInvalidate={invalidate} />
  );
  return { real, node, invalidate, pin };
}
async function settleHistory() {
  await act(async () => {
    await Promise.resolve();
  });
}
const snapshotPreview = () =>
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.preview' }));
it('restores removed v2 history name and original v1 preview title with an empty current list', async () => {
  const h = await historyHarness();
  render(h.node());
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  expect(
    screen
      .getByRole('button', { name: 'ccAgent.materials.snapshot.create' })
      .hasAttribute('disabled'),
  ).toBe(true);
  expect(bridge.materials.list).toHaveBeenCalledWith({
    projectId: 'p1',
    workItemId: 's1',
    history: true,
  });
  snapshotPreview();
  await settleHistory();
  expect(screen.getByRole('dialog', { name: 'original-brief.txt' })).toBeTruthy();
  expect(screen.getByText('IMMUTABLE V1')).toBeTruthy();
  expect(bridge.materials.preview).toHaveBeenCalledExactlyOnceWith({
    contextId: 'c1',
    materialId: 'm1',
    version: 1,
  });
  expect(bridge.materialContexts.create).not.toHaveBeenCalled();
  expect(bridge.materials.add).not.toHaveBeenCalled();
});
it('cold component/service rebuild after removal re-reads the authorized history instead of using a name cache', async () => {
  let h = await historyHarness();
  const first = render(h.node());
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  first.unmount();
  h.real.dispose();
  h = await historyHarness();
  const second = render(h.node());
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  expect(bridge.materials.list.mock.calls.some(([p]) => p.history === true)).toBe(true);
  second.unmount();
});
it.each(['reference', 'version', 'binding'] as const)(
  'does not borrow a name from a mismatched %s history row',
  async (kind) => {
    let m = archivedMaterial();
    if (kind === 'reference') m = { ...m, reference: { ...m.reference, id: 'another-ref' } };
    if (kind === 'binding') m = { ...m, reference: { ...m.reference, bindingRevision: 99 } };
    if (kind === 'version') m = { ...m, versions: m.versions.filter((v) => v.version === 2) };
    const h = await historyHarness(scope(), makeContext(), [m]);
    render(h.node());
    await settleHistory();
    expect(screen.queryByText('original-brief.txt')).toBeNull();
    expect(screen.getByText('ccAgent.materials.snapshot.refUnknown')).toBeTruthy();
    snapshotPreview();
    await settleHistory();
    expect(
      screen.getByRole('dialog', { name: 'ccAgent.materials.snapshot.refUnknown' }),
    ).toBeTruthy();
    expect(screen.queryByRole('dialog', { name: 'm1' })).toBeNull();
    expect(bridge.materials.preview.mock.calls[0][0]).toEqual({
      contextId: 'c1',
      materialId: 'm1',
      version: 1,
    });
  },
);
it('matches an old context binding rather than the current binding and same-material last-row wins', async () => {
  const old = scope('s1', 7);
  const now = scope('s1', 8);
  const wrong = archivedMaterial(now, 'WRONG TITLE');
  const h = await historyHarness(now, makeContext(old), [archivedMaterial(old), wrong]);
  render(h.node());
  await settleHistory();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.referenceHistory' }));
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  expect(screen.queryByText('WRONG TITLE')).toBeNull();
  expect(
    screen
      .getByRole('button', { name: 'ccAgent.materials.snapshot.create' })
      .hasAttribute('disabled'),
  ).toBe(true);
});
it('history failure and subsequent refresh never retain a previous authorized name; preview title stays generic', async () => {
  const h = await historyHarness();
  render(h.node());
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  bridge.materials.list.mockRejectedValue(new Error('temporary'));
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.referenceHistory' }));
  await settleHistory();
  expect(screen.queryByText('original-brief.txt')).toBeNull();
  expect(screen.getByText('ccAgent.materials.snapshot.refUnknown')).toBeTruthy();
  expect(h.invalidate).not.toHaveBeenCalled();
  snapshotPreview();
  await settleHistory();
  expect(
    screen.getByRole('dialog', { name: 'ccAgent.materials.snapshot.refUnknown' }),
  ).toBeTruthy();
});
it('a denied newer history read clears data and an older success cannot resurrect it', async () => {
  const h = await historyHarness();
  const pending = deferred<unknown>();
  bridge.materials.list
    .mockReturnValueOnce(pending.promise)
    .mockRejectedValueOnce(Object.assign(new Error('denied'), { code: 'FORBIDDEN' }));
  render(h.node());
  await settleHistory();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.referenceHistory' }));
  await settleHistory();
  expect(h.invalidate).toHaveBeenCalledTimes(1);
  await act(async () =>
    pending.resolve({
      referenceContract: 1,
      history: true,
      projectId: 'p1',
      workItemId: 's1',
      materials: [archivedMaterial()],
    }),
  );
  expect(screen.queryByText('original-brief.txt')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.preview' })).toBeNull();
});
it('an owner/scope replacement cannot publish a late old history name or release the new loading state', async () => {
  const h = await historyHarness();
  const old = deferred<unknown>();
  bridge.materials.list.mockReturnValueOnce(old.promise);
  const view = render(h.node());
  await settleHistory();
  env.owner = 2;
  const s = scope('s2', 11, 'p2');
  const fresh = await historyHarness(s, makeContext(s), []);
  view.rerender(fresh.node());
  await settleHistory();
  await act(async () =>
    old.resolve({
      referenceContract: 1,
      projectId: 'p1',
      workItemId: 's1',
      history: true,
      materials: [archivedMaterial()],
    }),
  );
  expect(screen.queryByText('original-brief.txt')).toBeNull();
  expect(screen.getByText('ccAgent.materials.snapshot.refUnknown')).toBeTruthy();
  expect(fresh.invalidate).not.toHaveBeenCalled();
});
it('resolved historical names do not add removed references to new-context write candidates', async () => {
  const h = await historyHarness();
  const active = makeMaterial();
  active.id = 'm2';
  active.name = 'Allowed current.txt';
  active.reference = { ...active.reference, id: 'active-m2', materialId: 'm2' };
  active.versions = active.versions.map((v) => ({ ...v, materialId: 'm2' }));
  bridge.materialContexts.create.mockImplementation(async (p) => ({
    referenceContract: 1,
    context: {
      ...makeContext(),
      refs: p.refs.map((r: { referenceId: string; materialId: string; version: number }) => ({
        ...r,
        readStateAtPin: 'ready',
      })),
    },
  }));
  render(h.node([active]));
  await settleHistory();
  expect(screen.getByText('original-brief.txt')).toBeTruthy();
  open();
  const picker = screen.getByRole('alertdialog');
  expect(within(picker).queryByText('original-brief.txt')).toBeNull();
  fireEvent.click(confirm());
  await settleHistory();
  expect(bridge.materialContexts.create.mock.calls[0][0].refs).toEqual([
    { referenceId: 'active-m2', materialId: 'm2', version: 1 },
  ]);
});
it('keeps the pinned unreadable v1 state and removed note despite a readable latest v2', async () => {
  const m = archivedMaterial();
  m.versions[0] = { ...m.versions[0], readState: 'failed', failureReason: 'SOURCE_MISSING' };
  const h = await historyHarness(scope(), makeContext(), [m]);
  render(h.node());
  await settleHistory();
  expect(screen.getByText('ccAgent.materials.snapshot.materialRemoved')).toBeTruthy();
  expect(screen.getByText(/ccAgent\.materials\.sourceMissingShort/)).toBeTruthy();
});
