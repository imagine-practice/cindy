// @vitest-environment jsdom
/**
 * Test value: real panel choices -> real service -> bridge payloads.
 * Regression: confirmed same-name creation previously sent ordinary add and was rejected.
 * Existing model tests cannot observe submitted writes or cancellation.
 * Minimal input: one active material and a same-name file with unknown fingerprint.
 * Tier: unit (DOM and fake bridge only); no account data or database.
 * Separate from the node-only model suite because this exercises DOM interaction.
 * Standalone vitest run: 2.31s wall time, 223ms tests (2026-11-05).
 */
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { MaterialsPanel } from '../MaterialsPanel';
import type { Material } from '../materialReferenceView';

vi.mock('react-i18next', () => ({ useTranslation: () => ({ t: (key: string) => key }) }));
vi.mock('@/lib/toast', () => ({ toast: { success: vi.fn(), info: vi.fn(), error: vi.fn() } }));
vi.mock('@/components/chat/FileLightbox', () => ({ FileLightbox: () => null }));
vi.mock('../MaterialRow', () => ({
  MaterialRow: (props: { onPreview: (version: number) => void }) => (
    <button onClick={() => props.onPreview(1)}>preview-probe</button>
  ),
}));
vi.mock('../MaterialPreviewDialog', () => ({
  MaterialPreviewDialog: (props: { target: { materialId: string } | null }) =>
    props.target ? <div>preview-{props.target.materialId}</div> : null,
}));

import { bridge as host, install, scope, material, list, version } from './referenceTestSupport';
import { createMaterialReferenceService } from '../materialReferenceService';
const bridge = host.materials;
const existing = material();
let service: ReturnType<typeof createMaterialReferenceService>;
beforeEach(async () => {
  vi.resetAllMocks();
  install();
  service = createMaterialReferenceService(scope());
  await service.list();
});

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function pick(materials: Material[] = [existing]): Promise<ReturnType<typeof render>> {
  const page = render(
    <MaterialsPanel
      scope={scope()}
      service={service}
      onCurrent={() => {}}
      onInvalidate={() => {}}
      materials={materials}
      loading={false}
      loadError={null}
      onReload={async () => {}}
    />,
  );
  fireEvent.change(page.container.querySelector('input[type="file"]')!, {
    target: { files: [new File(['new content'], 'brief.pdf', { type: 'application/pdf' })] },
  });
  if (materials.length) await screen.findByRole('alertdialog');
  return page;
}

it('passes explicit create-new to the bridge only after the separate-material choice', async () => {
  await pick();
  expect(bridge.add).not.toHaveBeenCalled();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.newMaterial' }));
  await waitFor(() =>
    expect(bridge.add).toHaveBeenCalledExactlyOnceWith({
      ...scope(),
      files: [{ name: 'brief.pdf', path: '/picked/brief.pdf', sameNameAction: 'create-new' }],
    }),
  );
  expect(bridge.addVersion).not.toHaveBeenCalled();
});

it('cancels a conflict without any bridge write', async () => {
  await pick();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(bridge.add).not.toHaveBeenCalled();
  expect(bridge.addVersion).not.toHaveBeenCalled();
});

it('keeps the version choice on addVersion without a create-new signal', async () => {
  await pick();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.newVersion' }));
  await waitFor(() =>
    expect(bridge.addVersion).toHaveBeenCalledExactlyOnceWith({
      ...scope(),
      referenceId: existing.reference.id,
      materialId: 'm1',
      file: { name: 'brief.pdf', path: '/picked/brief.pdf' },
      replaceCurrentReference: true,
    }),
  );
  expect(bridge.add).not.toHaveBeenCalled();
});

it('sends ordinary additions without default confirmation', async () => {
  await pick([]);
  await waitFor(() =>
    expect(bridge.add).toHaveBeenCalledExactlyOnceWith({
      ...scope(),
      files: [{ name: 'brief.pdf', path: '/picked/brief.pdf' }],
    }),
  );
  expect(bridge.addVersion).not.toHaveBeenCalled();
});

// Regression: rejected rows must retain the selected write, not reconstruct ordinary add.
it.each(['throw', 'rejected'] as const)(
  'retries explicit create-new after %s failure',
  async (failure) => {
    if (failure === 'throw')
      bridge.add.mockRejectedValueOnce(new Error('[SOURCE_MISSING] missing'));
    else
      bridge.add.mockResolvedValueOnce({
        referenceContract: 1,
        scope: scope(),
        references: [],
        added: [],
        duplicates: [],
        rejected: [{ name: 'brief.pdf', code: 'MEDIA_WRITE_FAILED' }],
      });
    await pick();
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.newMaterial' }));
    fireEvent.click(await screen.findByRole('button', { name: 'ccAgent.materials.retryAdd' }));
    await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(2));
    expect(bridge.add.mock.calls[1]).toEqual(bridge.add.mock.calls[0]);
    expect(bridge.add.mock.calls[1][0].files[0].sameNameAction).toBe('create-new');
    expect(bridge.addVersion).not.toHaveBeenCalled();
  },
);

it('retries the same version target and preserves host revalidation failures', async () => {
  bridge.addVersion
    .mockRejectedValueOnce(new Error('[SOURCE_MISSING] missing'))
    .mockRejectedValueOnce(new Error('[SOURCE_CHANGED] changed'));
  await pick();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.newVersion' }));
  fireEvent.click(await screen.findByRole('button', { name: 'ccAgent.materials.retryAdd' }));
  await screen.findByText('ccAgent.materials.error.sourceChanged');
  expect(bridge.addVersion).toHaveBeenCalledTimes(2);
  expect(bridge.addVersion.mock.calls[1]).toEqual(bridge.addVersion.mock.calls[0]);
  expect(bridge.addVersion.mock.calls[1][0]).toEqual({
    ...scope(),
    referenceId: existing.reference.id,
    materialId: 'm1',
    file: { name: 'brief.pdf', path: '/picked/brief.pdf' },
    replaceCurrentReference: true,
  });
  expect(bridge.add).not.toHaveBeenCalled();
});

it('retries ordinary add without inheriting a conflict choice', async () => {
  bridge.add.mockRejectedValueOnce(new Error('[SOURCE_MISSING] missing'));
  await pick([]);
  fireEvent.click(await screen.findByRole('button', { name: 'ccAgent.materials.retryAdd' }));
  await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(2));
  expect(bridge.add.mock.calls[1][0].files).toEqual([
    { name: 'brief.pdf', path: '/picked/brief.pdf' },
  ]);
});

it('drops conflict, rejected retry and preview intent when switching work items', async () => {
  const page = await pick();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.cancel' }));
  fireEvent.click(screen.getByText('preview-probe'));
  expect(screen.queryByText('preview-m1')).not.toBeNull();
  page.rerender(
    <MaterialsPanel
      scope={scope('s2', 8, 'p2')}
      service={createMaterialReferenceService(scope('s2', 8, 'p2'))}
      onCurrent={() => {}}
      onInvalidate={() => {}}
      materials={[]}
      loading={false}
      loadError={null}
      onReload={async () => {}}
    />,
  );
  expect(screen.queryByText('preview-m1')).toBeNull();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('alertdialog')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.retryAdd' })).toBeNull();
  expect(bridge.add).not.toHaveBeenCalled();
});

it('discards an open conflict and late write failure after switching work items', async () => {
  let reject!: (error: Error) => void;
  bridge.add.mockReturnValueOnce(
    new Promise((_resolve, fail) => {
      reject = fail;
    }),
  );
  const page = await pick();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.newMaterial' }));
  page.rerender(
    <MaterialsPanel
      scope={scope('s2', 8, 'p2')}
      service={createMaterialReferenceService(scope('s2', 8, 'p2'))}
      onCurrent={() => {}}
      onInvalidate={() => {}}
      materials={[]}
      loading={false}
      loadError={null}
      onReload={async () => {}}
    />,
  );
  expect(screen.queryByRole('alertdialog')).toBeNull();
  await act(async () => reject(new Error('[SOURCE_MISSING] old')));
  expect(screen.queryByRole('alert')).toBeNull();
  expect(screen.queryByRole('button', { name: 'ccAgent.materials.retryAdd' })).toBeNull();
});

/** P1 2026-11-06: R1 rejected has only a name, so two paths with that name have no batch identity.
 * Real Panel -> strict service -> controlled bridge; old cases only selected one file per name.
 * Legal minimum: /folder-a/brief.pdf and /folder-b/brief.pdf, both MEDIA_WRITE_FAILED.
 * No response/request positional assumption: mixed receipt arrays deliberately differ in order.
 */
async function pickPaths(paths: string[], materials: Material[] = []) {
  const files = paths.map(
    (path, index) =>
      new File([`bytes-${index}`], path.split('/').at(-1)!, { type: 'application/pdf' }),
  );
  const byFile = new Map(files.map((file, index) => [file, paths[index]]));
  vi.spyOn(window.electronAPI, 'getFilePath').mockImplementation((file) => byFile.get(file) ?? '');
  const page = render(
    <MaterialsPanel
      scope={scope()}
      service={service}
      onCurrent={() => {}}
      onInvalidate={() => {}}
      materials={materials}
      loading={false}
      loadError={null}
      onReload={async () => {
        await service.list();
      }}
    />,
  );
  fireEvent.change(page.container.querySelector('input[type="file"]')!, { target: { files } });
  return page;
}
function rejectedFiles(files: { name: string; path: string }[]) {
  return {
    referenceContract: 1,
    scope: scope(),
    added: [],
    duplicates: [],
    references: [],
    rejected: files.map((file) => ({ name: file.name, code: 'MEDIA_WRITE_FAILED' })),
  };
}
it('retries A then B by their exact original paths after two legal same-name failures', async () => {
  bridge.add.mockImplementation(async (p) => rejectedFiles(p.files));
  await pickPaths(['/folder-a/brief.pdf', '/folder-b/brief.pdf']);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })).toHaveLength(2),
  );
  fireEvent.click(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })[0]);
  await waitFor(() =>
    expect(bridge.add.mock.calls.at(-1)![0].files).toEqual([
      { name: 'brief.pdf', path: '/folder-a/brief.pdf' },
    ]),
  );
  expect(bridge.add).toHaveBeenCalledTimes(3);
  fireEvent.click(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })[0]);
  await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(4));
  expect(bridge.add.mock.calls[3][0].files).toEqual([
    { name: 'brief.pdf', path: '/folder-b/brief.pdf' },
  ]);
});

const pathsAB = ['/folder-a/brief.pdf', '/folder-b/brief.pdf'];
function oneSuccess() {
  return {
    referenceContract: 1,
    scope: scope(),
    added: [version()],
    duplicates: [],
    rejected: [],
    references: [existing.reference],
  };
}
it.each(pathsAB)(
  'retries only failed %s and never resends the same-name successful selection',
  async (failed) => {
    bridge.add.mockImplementation(async (p) => {
      const failures = p.files.filter((f: { path: string }) => f.path === failed);
      const successful = p.files.length - failures.length;
      return {
        ...rejectedFiles(failures),
        added: Array.from({ length: successful }, () => version()),
        references: Array.from({ length: successful }, () => existing.reference),
      };
    });
    await pickPaths(pathsAB);
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })).toHaveLength(1),
    );
    await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(2));
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.retryAdd' }));
    await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(3));
    expect(
      bridge.add.mock.calls.map(([p]) => p.files.map((f: { path: string }) => f.path)),
    ).toEqual([[pathsAB[0]], [pathsAB[1]], [failed]]);
    expect(bridge.addVersion).not.toHaveBeenCalled();
    expect(
      bridge.add.mock.calls.every(([p]) =>
        p.files.every((f: { sameNameAction?: string }) => f.sameNameAction === undefined),
      ),
    ).toBe(true);
  },
);
it('cancels both same-name conflicts without sending either selected path', async () => {
  await pickPaths(pathsAB, [existing]);
  await screen.findByRole('alertdialog');
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.cancel' }));
  expect(screen.getByRole('alertdialog')).toBeTruthy();
  fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.conflict.cancel' }));
  await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull());
  expect(bridge.add).not.toHaveBeenCalled();
  expect(bridge.addVersion).not.toHaveBeenCalled();
  expect(screen.getAllByText('ccAgent.materials.error.conflictCancelled')).toHaveLength(2);
});
it.each(['newMaterial', 'newVersion'] as const)(
  'preserves exact A path and %s confirmation intent across two failed same-name choices',
  async (choice) => {
    bridge.add.mockImplementation(async (p) => rejectedFiles(p.files));
    bridge.addVersion.mockRejectedValue(new Error('[SOURCE_MISSING] missing source'));
    await pickPaths(pathsAB, [existing]);
    for (let count = 1; count <= 2; count++) {
      fireEvent.click(
        await screen.findByRole('button', { name: 'ccAgent.materials.conflict.' + choice }),
      );
      await waitFor(() =>
        expect(
          screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd', hidden: true }),
        ).toHaveLength(count),
      );
    }
    const method = choice === 'newMaterial' ? bridge.add : bridge.addVersion;
    expect(method).toHaveBeenCalledTimes(2);
    fireEvent.click(
      screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd', hidden: true })[0],
    );
    await waitFor(() => expect(method).toHaveBeenCalledTimes(3));
    expect(method.mock.calls[2]).toEqual(method.mock.calls[0]);
    if (choice === 'newMaterial')
      expect(method.mock.calls[2][0].files).toEqual([
        { name: 'brief.pdf', path: pathsAB[0], sameNameAction: 'create-new' },
      ]);
    else
      expect(method.mock.calls[2][0]).toEqual({
        ...scope(),
        referenceId: existing.reference.id,
        materialId: existing.id,
        file: { name: 'brief.pdf', path: pathsAB[0] },
        replaceCurrentReference: true,
      });
  },
);
it('keeps unique-name multi-select batched and matches reversed rejected names rather than response indices', async () => {
  bridge.add.mockImplementation(async (p) =>
    p.files.length === 3
      ? {
          ...oneSuccess(),
          rejected: [
            { name: 'b.pdf', code: 'MEDIA_WRITE_FAILED' },
            { name: 'a.pdf', code: 'MEDIA_WRITE_FAILED' },
          ],
        }
      : rejectedFiles(p.files),
  );
  await pickPaths(['/folder/a.pdf', '/folder/b.pdf', '/folder/success.pdf']);
  await waitFor(() =>
    expect(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })).toHaveLength(2),
  );
  expect(bridge.add).toHaveBeenCalledTimes(1);
  expect(bridge.add.mock.calls[0][0].files).toHaveLength(3);
  fireEvent.click(screen.getAllByRole('button', { name: 'ccAgent.materials.retryAdd' })[0]);
  await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(2));
  expect(bridge.add.mock.calls[1][0].files).toEqual([{ name: 'b.pdf', path: '/folder/b.pdf' }]);
});
it.each(['unknown', 'refresh'] as const)(
  'pauses unsent B after %s outcome, retains it visibly and never replays A',
  async (failure) => {
    bridge.add.mockImplementation(async (p) => {
      if (p.files[0].path === pathsAB[1]) return rejectedFiles(p.files);
      if (failure === 'unknown') throw new Error('Response was lost');
      return oneSuccess();
    });
    if (failure === 'refresh') bridge.list.mockRejectedValueOnce(new Error('Refresh was lost'));
    await pickPaths(pathsAB);
    await screen.findByText('ccAgent.materials.pendingConfirmation');
    expect(bridge.add).toHaveBeenCalledTimes(1);
    expect(screen.getByText('ccAgent.materials.addedNone')).toBeTruthy();
    expect(
      screen.getByRole('button', { name: 'ccAgent.materials.retryAdd' }).hasAttribute('disabled'),
    ).toBe(true);
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.confirmRefresh' }));
    await waitFor(() =>
      expect(screen.queryByText('ccAgent.materials.pendingConfirmation')).toBeNull(),
    );
    fireEvent.click(screen.getByRole('button', { name: 'ccAgent.materials.retryAdd' }));
    await waitFor(() => expect(bridge.add).toHaveBeenCalledTimes(2));
    expect(
      bridge.add.mock.calls.map(([p]) => p.files.map((f: { path: string }) => f.path)),
    ).toEqual([[pathsAB[0]], [pathsAB[1]]]);
  },
);
