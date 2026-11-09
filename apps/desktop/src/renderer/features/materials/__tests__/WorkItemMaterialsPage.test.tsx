// @vitest-environment jsdom
/** Value: real page -> Panel/Snapshot -> strict service -> controlled preload.
 * R1/PM-AC2: binding tokens, independent version references and stale lifecycle publication.
 * Old service probes missed true read-before-write and child interactions. Minimal: delayed s1 then s2.
 * Tier unit: synthetic preload receipts; no SQLite/files/real permission or model claims.
 */
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { WorkItemMaterialsPage } from '../WorkItemMaterialsPage';
import {
  bridge,
  install,
  scope,
  material,
  list,
  progress,
  version,
  context,
  deferred,
} from './referenceTestSupport';
const env = vi.hoisted(() => ({ route: { projectId: 'p1', sessionId: 's1' }, owner: 1 }));
vi.mock('react-router-dom', () => ({ useParams: () => env.route, useNavigate: () => vi.fn() }));
vi.mock('@/contexts/AuthContext', () => ({
  useOptionalAuth: () => ({ dataOwnerId: `owner-${env.owner}`, dataOwnerGeneration: env.owner }),
  useOptionalDataOwnerGeneration: () => env.owner,
}));
vi.mock('@/contexts/dataOwnerGeneration', () => ({
  getDataOwnerGeneration: () => env.owner,
  isDataOwnerGenerationCurrent: (n: number) => n === env.owner,
}));
vi.mock('react-i18next', async (original) => ({
  ...(await original<typeof import('react-i18next')>()),
  useTranslation: () => ({
    t: (key: string, opts?: { version?: number }) =>
      key + (opts?.version ? `:${opts.version}` : ''),
  }),
}));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/chat/FileLightbox', () => ({ FileLightbox: () => null }));
beforeEach(() => {
  vi.resetAllMocks();
  env.owner = 1;
  env.route = { projectId: 'p1', sessionId: 's1' };
  install();
});
afterEach(cleanup);
// A page heading only establishes current-list readiness. A snapshot preview
// must be selected inside its named semantic region, after the pinned v1 badge.
const snapshotV1Preview = async (): Promise<HTMLElement> => {
  const snapshots = screen.getByRole('region', { name: 'ccAgent.materials.snapshot.title' });
  const pinned = await within(snapshots).findByText('ccAgent.materials.versionShort:1');
  const row = pinned.closest('li');
  if (!row) throw new Error('Pinned snapshot reference row missing');
  return within(row).getByRole('button', { name: 'ccAgent.materials.preview' });
};
const show = () => screen.findByRole('heading', { name: `Task-${env.route.sessionId}` });
const notify = async () => {
  await act(async () => bridge.projects.onChanged.mock.calls.at(-1)![0]());
};
const switchTo = (page: ReturnType<typeof render>, s = 's2', p = 'p2') => {
  env.route = { projectId: p, sessionId: s };
  bridge.projectProgress.read.mockResolvedValue(progress(scope(s, 9, p)));
  page.rerender(<WorkItemMaterialsPage />);
};
it.each(['resolve', 'reject'] as const)(
  'ignores late materials %s after route change',
  async (done) => {
    const old = deferred<ReturnType<typeof list>>();
    bridge.materials.list.mockReturnValueOnce(old.promise);
    const page = render(<WorkItemMaterialsPage />);
    await waitFor(() => expect(bridge.materials.list).toHaveBeenCalledTimes(1));
    switchTo(page);
    await show();
    await act(async () =>
      done === 'resolve' ? old.resolve(list()) : old.reject(new Error('old')),
    );
    expect(screen.queryByRole('heading', { name: 'Task-s1' })).toBeNull();
    expect(screen.queryByText('ccAgent.materials.loadFailed')).toBeNull();
    expect(bridge.materials.list.mock.calls[1][0]).toEqual(scope('s2', 9, 'p2'));
  },
);
it.each(['resolve', 'reject'] as const)(
  'ignores late progress read %s after route change',
  async (done) => {
    const old = deferred<ReturnType<typeof progress>>();
    bridge.projectProgress.read.mockReturnValueOnce(old.promise);
    const page = render(<WorkItemMaterialsPage />);
    switchTo(page);
    await show();
    await act(async () =>
      done === 'resolve' ? old.resolve(progress()) : old.reject(new Error('old')),
    );
    expect(screen.queryByRole('heading', { name: 'Task-s2' })).not.toBeNull();
    expect(bridge.materials.list).toHaveBeenCalledTimes(1);
  },
);
it.each(['resolve', 'reject'] as const)(
  'keeps latest same-route refresh against old %s',
  async (done) => {
    render(<WorkItemMaterialsPage />);
    await show();
    const old = deferred<ReturnType<typeof progress>>();
    bridge.projectProgress.read.mockReturnValueOnce(old.promise);
    await notify();
    await notify();
    await show();
    await act(async () =>
      done === 'resolve' ? old.resolve(progress(scope('s1', 99))) : old.reject(new Error('old')),
    );
    expect(screen.queryByRole('heading', { name: 'Task-s1' })).not.toBeNull();
    expect(bridge.materials.list.mock.calls.at(-1)![0]).toEqual(scope());
  },
);
it('does not restore old successful data after latest refresh failure', async () => {
  render(<WorkItemMaterialsPage />);
  await show();
  const old = deferred<ReturnType<typeof progress>>();
  bridge.projectProgress.read
    .mockReturnValueOnce(old.promise)
    .mockRejectedValueOnce(new Error('latest'));
  await notify();
  await notify();
  await act(async () => old.resolve(progress()));
  expect(screen.queryByRole('heading', { name: 'Task-s1' })).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.add' })).toBeNull();
});
it.each(['owner', 'unmount'] as const)('disposes on %s and ignores old callbacks', async (kind) => {
  const old = deferred<ReturnType<typeof list>>();
  bridge.materials.list.mockReturnValueOnce(old.promise);
  const page = render(<WorkItemMaterialsPage />);
  await waitFor(() => expect(bridge.materials.list).toHaveBeenCalledTimes(1));
  const callback = bridge.projects.onChanged.mock.calls[0][0];
  if (kind === 'owner') {
    env.owner = 2;
    page.rerender(<WorkItemMaterialsPage />);
    await show();
  } else page.unmount();
  const calls = bridge.projectProgress.read.mock.calls.length;
  await act(async () => {
    old.resolve(list());
    callback();
  });
  expect(bridge.projectProgress.read).toHaveBeenCalledTimes(calls);
});
it.each(['missing', 'forbidden', 'not-in-project', 'old-host'] as const)(
  'blocks all writes for %s authority',
  async (kind) => {
    if (kind === 'missing')
      bridge.projectProgress.read.mockResolvedValue({
        ...progress(),
        items: [{ ...progress().items[0], bindingRevision: undefined }],
      });
    if (kind === 'forbidden')
      bridge.projectProgress.read.mockResolvedValue({
        ...progress(),
        capabilities: { canRecord: false },
      });
    if (kind === 'not-in-project')
      bridge.projectProgress.read.mockResolvedValue({ ...progress(), items: [] });
    if (kind === 'old-host') bridge.materials.list.mockResolvedValue({ materials: [material()] });
    render(<WorkItemMaterialsPage />);
    await screen.findByRole('button', { name: 'ccAgent.materials.retryLoad' });
    expect(screen.queryByRole('button', { name: 'ccAgent.materials.add' })).toBeNull();
    expect(bridge.materials.add).not.toHaveBeenCalled();
    expect(bridge.materialContexts.create).not.toHaveBeenCalled();
  },
);
it('replaces binding scope, clears open preview and uses the independent token with null progress', async () => {
  render(<WorkItemMaterialsPage />);
  await show();
  bridge.materials.preview.mockResolvedValue({
    referenceContract: 1,
    materialId: 'm1',
    version: 1,
    kind: 'text',
    name: 'brief.pdf',
    mime: 'text/plain',
    size: 5,
    text: 'old-body',
  });
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.preview' }));
  await screen.findByText('old-body');
  bridge.projectProgress.read.mockResolvedValue(progress(scope('s1', 8)));
  await notify();
  await show();
  expect(screen.queryByText('old-body')).toBeNull();
  expect(bridge.materials.list.mock.calls.at(-1)![0]).toEqual(scope('s1', 8));
});
it('keeps task-selected v1 apart from catalogue v2, previews exact v1 and removes only its reference', async () => {
  bridge.materials.list.mockImplementation(async (s) =>
    list(s, [material(s, s.workItemId === 's1' ? 2 : 1, 2)]),
  );
  const page = render(<WorkItemMaterialsPage />);
  await show();
  switchTo(page, 's3', 'p1');
  await show();
  expect(screen.getByText('ccAgent.materials.latestVersion:2')).toBeTruthy();
  expect(screen.getByText('ccAgent.materials.versionShort:1')).toBeTruthy();
  bridge.materials.preview.mockResolvedValue({
    referenceContract: 1,
    materialId: 'm1',
    version: 1,
    kind: 'text',
    name: 'brief.pdf',
    mime: 'text/plain',
    size: 5,
    text: 'v1-body',
  });
  const trigger = screen.getByRole('button', { name: 'ccAgent.materials.preview' });
  trigger.focus();
  fireEvent.click(trigger);
  await screen.findByText('v1-body');
  expect(bridge.materials.preview).toHaveBeenCalledWith({
    ...scope('s3', 9),
    referenceId: 'ref-s3-9',
    materialId: 'm1',
    version: 1,
  });
  fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  expect(document.activeElement).toBe(trigger);
  bridge.materials.removeReference.mockResolvedValue({
    referenceContract: 1,
    scope: scope('s3', 9),
    ok: true,
    status: 'removed',
    reference: { ...material(scope('s3', 9)).reference, status: 'removed' },
  });
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.removeReference' }));
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.removeConfirmAction' }));
  await waitFor(() =>
    expect(bridge.materials.removeReference).toHaveBeenCalledExactlyOnceWith({
      ...scope('s3', 9),
      referenceId: 'ref-s3-9',
    }),
  );
});

it('adds multiple files then re-reads duplicate references in their original scope', async () => {
  bridge.materials.list.mockResolvedValueOnce(list(scope(), []));
  bridge.materials.add.mockResolvedValue({
    referenceContract: 1,
    scope: scope(),
    added: [version()],
    duplicates: [{ name: 'copy.pdf', materialId: 'm1', version: 1 }],
    rejected: [],
    references: [material().reference, material().reference],
  });
  const page = render(<WorkItemMaterialsPage />);
  await show();
  fireEvent.change(page.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['a'], 'brief.pdf'), new File(['a'], 'copy.pdf')] },
  });
  await screen.findByText('brief.pdf');
  expect(bridge.materials.add).toHaveBeenCalledExactlyOnceWith({
    ...scope(),
    files: [
      { name: 'brief.pdf', path: '/picked/brief.pdf' },
      { name: 'copy.pdf', path: '/picked/copy.pdf' },
    ],
  });
  expect(bridge.materials.list.mock.calls).toEqual([[scope()], [scope()]]);
  expect(screen.queryByRole('status')).not.toBeNull();
});
it('a received addVersion followed by failed reload cannot replay the version on retry', async () => {
  const page = render(<WorkItemMaterialsPage />);
  await show();
  bridge.materials.list.mockRejectedValueOnce(new Error('refresh unavailable'));
  fireEvent.change(page.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['new'], 'brief.pdf')] },
  });
  fireEvent.click(
    await screen.findByRole('button', { name: 'ccAgent.materials.conflict.newVersion' }),
  );
  await screen.findByText('ccAgent.materials.pendingConfirmation');
  expect(bridge.materials.addVersion).toHaveBeenCalledTimes(1);
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.retryAdd' })).toBeNull();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.confirmRefresh' }));
  await waitFor(() =>
    expect(screen.queryByText('ccAgent.materials.pendingConfirmation')).toBeNull(),
  );
  expect(bridge.materials.addVersion).toHaveBeenCalledTimes(1);
});
it('unknown write outcome blocks replay until an explicit read, including stale binding replacement', async () => {
  const pending = deferred<unknown>();
  bridge.materials.add.mockReturnValueOnce(pending.promise);
  const page = render(<WorkItemMaterialsPage />);
  await show();
  fireEvent.change(page.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['x'], 'new.pdf')] },
  });
  await waitFor(() => expect(bridge.materials.add).toHaveBeenCalledTimes(1));
  bridge.projectProgress.read.mockResolvedValue(progress(scope('s1', 8)));
  await notify();
  await show();
  await act(async () => pending.reject(new Error('lost response')));
  expect(screen.queryByText('ccAgent.materials.pendingConfirmation')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
});
it('keeps an old snapshot at v1 after current v2 and previews through its context locator', async () => {
  bridge.materials.list.mockResolvedValue(list(scope(), [material(scope(), 2, 2)]));
  bridge.materialContexts.list.mockResolvedValue({
    referenceContract: 1,
    scope: scope(),
    contexts: [context()],
  });
  render(<WorkItemMaterialsPage />);
  await show();
  const previewButton = await snapshotV1Preview();
  bridge.materials.preview.mockResolvedValue({
    referenceContract: 1,
    materialId: 'm1',
    version: 1,
    kind: 'text',
    text: 'pinned-v1',
    name: 'brief.pdf',
    mime: 'text/plain',
    size: 5,
  });
  fireEvent.click(previewButton);
  await screen.findByText('pinned-v1');
  expect(bridge.materials.preview).toHaveBeenCalledExactlyOnceWith({
    contextId: 'c1',
    materialId: 'm1',
    version: 1,
  });
});
it('permission failure in preview removes body, history and write controls', async () => {
  render(<WorkItemMaterialsPage />);
  await show();
  bridge.materials.preview.mockRejectedValue(new Error('[FORBIDDEN] lost permission'));
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.preview' }));
  await screen.findByRole('button', { name: 'ccAgent.materials.retryLoad' });
  expect(screen.queryByText('brief.pdf')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.snapshot.create' })).toBeNull();
  expect(bridge.materials.add).not.toHaveBeenCalled();
});
it('selects a catalogue version explicitly without allocating another version', async () => {
  bridge.materials.list.mockResolvedValue(list(scope(), [material(scope(), 1, 2)]));
  bridge.materials.add.mockImplementation(async () => {
    bridge.materials.list.mockResolvedValue(list(scope(), [material(scope(), 2, 2)]));
    return {
      referenceContract: 1,
      scope: scope(),
      added: [],
      duplicates: [],
      rejected: [],
      references: [material(scope(), 2, 2).reference],
    };
  });
  render(<WorkItemMaterialsPage />);
  await show();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.versionHistory' }));
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.useVersion' }));
  await waitFor(() =>
    expect(bridge.materials.add).toHaveBeenCalledExactlyOnceWith({
      ...scope(),
      existing: [{ materialId: 'm1', version: 2 }],
    }),
  );
  expect(bridge.materials.addVersion).not.toHaveBeenCalled();
});

it('confirms snapshot default v1 from the selected reference while catalogue latest is v2', async () => {
  bridge.materials.list.mockResolvedValue(list(scope(), [material(scope(), 1, 2)]));
  render(<WorkItemMaterialsPage />);
  await show();
  await screen.findByText('ccAgent.materials.snapshot.empty');
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.snapshot.create' }));
  expect(bridge.materialContexts.create).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.snapshot.confirm' }));
  await waitFor(() =>
    expect(bridge.materialContexts.create).toHaveBeenCalledExactlyOnceWith({
      ...scope(),
      purpose: 'reference',
      refs: [{ referenceId: 'ref-s1-7', materialId: 'm1', version: 1 }],
    }),
  );
});
it('lists unknown historical binding only as history and reports unverifiable context instead of body', async () => {
  render(<WorkItemMaterialsPage />);
  await show();
  await screen.findByText('ccAgent.materials.snapshot.empty');
  bridge.materialContexts.list.mockResolvedValue({
    referenceContract: 1,
    projectId: 'p1',
    workItemId: 's1',
    history: true,
    contexts: [{ ...context(), projectId: null, bindingRevision: null }],
  });
  fireEvent.click(
    screen.getAllByRole('button', { name: 'ccAgent.materials.referenceHistory' }).at(-1)!,
  );
  await screen.findByText('ccAgent.materials.unknownBinding');
  expect(
    screen
      .getByRole('button', { name: 'ccAgent.materials.snapshot.create' })
      .hasAttribute('disabled'),
  ).toBe(true);
  bridge.materials.preview.mockRejectedValue(new Error('[CONTEXT_SCOPE_UNKNOWN] cannot verify'));
  fireEvent.click(screen.getAllByRole('button', { name: 'ccAgent.materials.preview' }).at(-1)!);
  await screen.findByText('ccAgent.materials.error.contextScopeUnknown');
  expect(bridge.materials.preview).toHaveBeenCalledExactlyOnceWith({
    contextId: 'c1',
    materialId: 'm1',
    version: 1,
  });
  expect(bridge.materialContexts.create).not.toHaveBeenCalled();
});
it('received add success plus refresh failure retains outcome and offers only a read before further writes', async () => {
  bridge.materials.add.mockResolvedValue({
    referenceContract: 1,
    scope: scope(),
    added: [version()],
    duplicates: [],
    rejected: [],
    references: [material().reference],
  });
  const page = render(<WorkItemMaterialsPage />);
  await show();
  bridge.materials.list.mockRejectedValueOnce(new Error('read unavailable'));
  fireEvent.change(page.container.querySelector('input[type=file]')!, {
    target: { files: [new File(['new'], 'new.pdf')] },
  });
  await screen.findByText('ccAgent.materials.pendingConfirmation');
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.retryAdd' })).toBeNull();
  expect(bridge.materials.add).toHaveBeenCalledTimes(1);
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.confirmRefresh' }));
  await waitFor(() =>
    expect(screen.queryByText('ccAgent.materials.pendingConfirmation')).toBeNull(),
  );
  expect(bridge.materials.add).toHaveBeenCalledTimes(1);
});

it.each(['image', 'controlled-pdf', 'unsupported'] as const)(
  'renders actual %s preview receipt without fabricating body',
  async (kind) => {
    bridge.materials.preview.mockResolvedValue({
      referenceContract: 1,
      materialId: 'm1',
      version: 1,
      kind: kind === 'image' ? 'image' : 'unsupported',
      name: 'brief.pdf',
      mime: kind === 'image' ? 'image/png' : kind === 'controlled-pdf' ? 'application/pdf' : 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      size: 5,
      url:
        kind === 'image'
          ? 'data:image/png;base64,aA=='
          : kind === 'controlled-pdf' ? 'xdt-file://material/' + 'a'.repeat(64) : undefined,
    });
    render(<WorkItemMaterialsPage />);
    await show();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.preview' }));
    if (kind === 'image')
      expect((await screen.findByRole('img')).getAttribute('src')).toBe(
        'data:image/png;base64,aA==',
      );
    else if (kind === 'controlled-pdf') {
      expect(await screen.findByRole('button', { name: 'ccAgent.materials.previewOpenInApp' })).toBeTruthy();
      expect(screen.queryByText('ccAgent.materials.previewUnsupportedDesc')).toBeNull();
    } else {
      await screen.findByText('ccAgent.materials.previewUnsupportedDesc');
      expect(screen.queryByRole('button', { name: 'ccAgent.materials.previewOpenInApp' })).toBeNull();
    }
    expect(document.querySelector('pre')).toBeNull();
  },
);

it('a host without project change invalidation cannot unlock writes by retrying its read', async () => {
  bridge.projects.onChanged.mockImplementation(() => {
    throw new Error('old host');
  });
  render(<WorkItemMaterialsPage />);
  const retry = await screen.findByRole('button', { name: 'ccAgent.materials.retryLoad' });
  fireEvent.click(retry);
  expect(bridge.projectProgress.read).not.toHaveBeenCalled();
  expect(bridge.materials.add).not.toHaveBeenCalled();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.add' })).toBeNull();
});

it('replacement service at the same scope rejects old write UI results without invalidating the replacement',async()=>{
 const pending=deferred<unknown>();bridge.materials.add.mockReturnValueOnce(pending.promise);
 const page=render(<WorkItemMaterialsPage/>);await show();fireEvent.change(page.container.querySelector('input[type=file]')!,{target:{files:[new File(['x'],'new.pdf')]}});
 await waitFor(()=>expect(bridge.materials.add).toHaveBeenCalledTimes(1));await notify();await show();
 await act(async()=>pending.reject(new Error('[SOURCE_MISSING] late')));
 expect(screen.queryByRole('heading',{name:'Task-s1'})).not.toBeNull();expect(screen.queryByText('ccAgent.materials.error.sourceMissing')).toBeNull();expect(screen.queryByRole('alert')).toBeNull();
});

// R2 timing regression: the page heading/current-v2 control appears before the
// snapshot context (and optional historical metadata). A global last-button
// selector cannot identify a context preview. Tier: real Page/Snapshot/service -> controlled bridge.
it.each(['context', 'history'] as const)(
  'keeps snapshot preview selection on v1 while %s metadata is gated',
  async (stage) => {
    const contextsGate = deferred<unknown>();
    const historyGate = deferred<unknown>();
    const current = material(scope(), 2, 2);
    if (stage === 'history') {
      current.id = 'current-material';
      current.reference = { ...current.reference, id: 'current-reference', materialId: current.id };
      current.versions = current.versions.map((v) => ({
        ...v,
        id: `current-v${v.version}`,
        materialId: current.id,
        sha256: `current-${v.sha256}`,
      }));
    }
    bridge.materials.list.mockImplementation(async (p) =>
      p.history === true ? historyGate.promise : list(scope(), [current]),
    );
    bridge.materialContexts.list.mockReturnValue(contextsGate.promise);
    bridge.materials.preview.mockResolvedValue({
      referenceContract: 1,
      materialId: 'm1',
      version: 1,
      kind: 'text',
      text: 'gated-pinned-v1',
      name: 'brief.pdf',
      mime: 'text/plain',
      size: 5,
    });
    render(<WorkItemMaterialsPage />);
    await show();
    await waitFor(() => expect(bridge.materialContexts.list).toHaveBeenCalledTimes(1));
    expect(screen.getByText('ccAgent.materials.versionShort:2')).toBeTruthy();
    const snapshots = screen.getByRole('region', { name: 'ccAgent.materials.snapshot.title' });
    let selected: HTMLElement | null = null;
    const previewReady = snapshotV1Preview().then((button) => {
      selected = button;
      return button;
    });
    await act(async () => {
      await Promise.resolve();
    });
    expect(selected).toBeNull();
    expect(within(snapshots).queryByText('ccAgent.materials.versionShort:1')).toBeNull();
    expect(bridge.materials.preview).not.toHaveBeenCalled();
    await act(async () =>
      contextsGate.resolve({ referenceContract: 1, scope: scope(), contexts: [context()] }),
    );
    if (stage === 'history') {
      await waitFor(() =>
        expect(bridge.materials.list).toHaveBeenCalledWith({
          projectId: 'p1',
          workItemId: 's1',
          history: true,
        }),
      );
      expect(selected).toBeNull();
      expect(within(snapshots).queryByText('ccAgent.materials.versionShort:1')).toBeNull();
      expect(bridge.materials.preview).not.toHaveBeenCalled();
      const historical = material(scope(), 2, 2);
      historical.status = 'removed';
      historical.reference.status = 'removed';
      await act(async () =>
        historyGate.resolve({
          referenceContract: 1,
          history: true,
          projectId: 'p1',
          workItemId: 's1',
          materials: [historical],
        }),
      );
    }
    const button = await previewReady;
    expect(within(snapshots).getByText('ccAgent.materials.versionShort:1')).toBeTruthy();
    fireEvent.click(button);
    await screen.findByText('gated-pinned-v1');
    expect(bridge.materials.preview).toHaveBeenCalledExactlyOnceWith({
      contextId: 'c1',
      materialId: 'm1',
      version: 1,
    });
  },
);
