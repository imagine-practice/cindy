import { vi } from 'vitest';
import type {
  Material,
  MaterialScope,
  MaterialVersion,
  MaterialContext,
} from '../../../../shared/materials';
export const scope = (workItemId = 's1', bindingRevision = 7, projectId = 'p1') => ({
  projectId,
  workItemId,
  bindingRevision,
});
export const version = (n = 1): MaterialVersion => ({
  id: `v${n}`,
  materialId: 'm1',
  version: n,
  sha256: `sha${n}`,
  sizeBytes: 5,
  mime: 'text/plain',
  storageKind: 'file',
  readState: 'ready',
  failureReason: null,
  createdAt: '2026-11-05T00:00:00Z',
});
export function material(s = scope(), n = 1, latest = 1): Material {
  return {
    id: 'm1',
    ...s,
    name: 'brief.pdf',
    status: 'active',
    createdByKind: 'account',
    createdById: 'creator',
    createdAt: '2026-11-05T00:00:00Z',
    updatedAt: '2026-11-05T00:00:00Z',
    currentVersion: n,
    latestVersion: latest,
    readState: 'ready',
    versions: Array.from({ length: latest }, (_, i) => version(i + 1)),
    reference: {
      ...s,
      id: `ref-${s.workItemId}-${s.bindingRevision}`,
      materialId: 'm1',
      version: n,
      status: 'active',
      createdByKind: 'account',
      createdById: 'creator',
      createdAt: '2026-11-05T00:00:00Z',
      updatedAt: '2026-11-05T00:00:00Z',
    },
  };
}
export const list = (s = scope(), materials: Material[] = [material(s)]) => ({
  referenceContract: 1 as const,
  scope: s,
  materials,
});
export const context = (s = scope()): MaterialContext => ({
  id: 'c1',
  ...s,
  purpose: 'reference',
  refs: [
    {
      referenceId: material(s).reference.id,
      materialId: 'm1',
      version: 1,
      readStateAtPin: 'ready',
    },
  ],
  createdByKind: 'account',
  createdById: 'creator',
  createdAt: '2026-11-05T00:00:00Z',
});
export const progress = (s = scope()) => ({
  projectId: s.projectId,
  items: [
    {
      sessionId: s.workItemId,
      projectId: s.projectId,
      title: `Task-${s.workItemId}`,
      sessionStatus: 'active',
      bindingRevision: s.bindingRevision,
      progress: null,
    },
  ],
  capabilities: { canRecord: true, canConfirmDone: false },
  history: [],
});
export const bridge = {
  materials: {
    list: vi.fn(),
    add: vi.fn(),
    addVersion: vi.fn(),
    removeReference: vi.fn(),
    preview: vi.fn(),
    retryRead: vi.fn(),
  },
  materialContexts: { list: vi.fn(), create: vi.fn() },
  projectProgress: { read: vi.fn() },
  projects: { onChanged: vi.fn() },
};
export function install() {
  bridge.materials.list.mockImplementation(async (s: MaterialScope) =>
    list(s as ReturnType<typeof scope>),
  );
  bridge.materials.add.mockImplementation(async (p) => ({
    referenceContract: 1,
    scope: { projectId: p.projectId, workItemId: p.workItemId, bindingRevision: p.bindingRevision },
    added: [],
    duplicates: [],
    rejected: [],
    references: [],
  }));
  bridge.materials.addVersion.mockImplementation(async (p) => ({
    referenceContract: 1,
    scope: { projectId: p.projectId, workItemId: p.workItemId, bindingRevision: p.bindingRevision },
    version: version(2),
    reference: { ...material().reference, version: 2 },
  }));
  bridge.materialContexts.list.mockImplementation(async (s) => ({
    referenceContract: 1,
    scope: s,
    contexts: [],
  }));
  bridge.materialContexts.create.mockResolvedValue({ referenceContract: 1, context: context() });
  bridge.projectProgress.read.mockResolvedValue(progress());
  bridge.projects.onChanged.mockReturnValue(() => {});
  Object.defineProperty(window, 'electronAPI', {
    configurable: true,
    value: { localDb: bridge, getFilePath: (file: File) => `/picked/${file.name}` },
  });
}
export function deferred<T>() {
  let resolve!: (v: T) => void;
  let reject!: (e: Error) => void;
  const promise = new Promise<T>((r, j) => {
    resolve = r;
    reject = j;
  });
  return { promise, resolve, reject };
}
