/** Real snapshot + strict service + preview; synthetic bridge only, no actual files or users. */
import { useEffect, useRef, useState } from 'react';
import { mountPage, type UiPageContext } from '../../ui-page/harness';
import { MaterialSnapshotSection } from '../../../src/renderer/features/materials/MaterialSnapshotSection';
import { createMaterialReferenceService } from '../../../src/renderer/features/materials/materialReferenceService';
import { setDataOwnerGeneration } from '../../../src/renderer/contexts/dataOwnerGeneration';
import type {
  Material,
  MaterialContext,
  MaterialScope,
  MaterialPreviewParams,
  MaterialsListParams,
  MaterialContextListParams,
} from '../../../src/shared/materials';
const time = '2026-11-06T00:00:00Z';
const original = { projectId: 'fixture-project', workItemId: 'fixture-task', bindingRevision: 9 };
declare global {
  interface Window {
    __snapshotLabelReads: MaterialsListParams[];
    __snapshotLabelPreviews: MaterialPreviewParams[];
    __snapshotLabelWrites: number;
  }
}
function Fixture({ ctx }: { ctx: UiPageContext }) {
  const scope = { ...original, bindingRevision: ctx.case === 'rebind' ? 10 : 9 };
  const real = useRef<ReturnType<typeof createMaterialReferenceService> | null>(null);
  if (!real.current) real.current = createMaterialReferenceService(scope);
  const [ready, setReady] = useState(false);
  const [denied, setDenied] = useState(false);
  useEffect(() => {
    void real.current!.list().then(() => setReady(true));
    return () => real.current?.dispose();
  }, []);
  return (
    <div className="app-wallpaper-surface h-full min-w-0 overflow-y-auto bg-[hsl(var(--content-area))] px-4 py-5">
      <div className="mx-auto w-full max-w-[720px]">
        {ready && !denied && (
          <MaterialSnapshotSection
            scope={scope}
            service={real.current}
            materials={[]}
            onInvalidate={() => setDenied(true)}
          />
        )}{' '}
        {denied && <p role="alert">Unavailable</p>}
      </div>
    </div>
  );
}
mountPage({
  host: (ctx) => {
    setDataOwnerGeneration('fixture-owner', 1);
    window.__snapshotLabelReads = [];
    window.__snapshotLabelPreviews = [];
    window.__snapshotLabelWrites = 0;
    const filename =
      ctx.locale === 'zh-CN'
        ? '项目需求与参考资料——重启后保留历史版本名称.txt'
        : 'project-requirements-and-material-reference-original-snapshot-v1.txt';
    const material: Material = {
      id: 'fixture-material',
      projectId: original.projectId,
      workItemId: original.workItemId,
      name: filename,
      status: 'removed',
      createdByKind: 'account',
      createdById: 'fixture-owner',
      createdAt: time,
      updatedAt: time,
      currentVersion: 2,
      latestVersion: 2,
      readState: 'ready',
      versions: [1, 2].map((n) => ({
        id: `version-${n}`,
        materialId: 'fixture-material',
        version: n,
        sha256: `fixture-sha-${n}`,
        sizeBytes: 32,
        mime: 'text/plain',
        storageKind: 'file',
        readState: ctx.case === 'unreadable' && n === 1 ? 'failed' : 'ready',
        failureReason: ctx.case === 'unreadable' && n === 1 ? 'SOURCE_MISSING' : null,
        createdAt: time,
      })),
      reference: {
        ...original,
        id: 'fixture-original-reference',
        materialId: 'fixture-material',
        version: 2,
        status: 'removed',
        createdByKind: 'account',
        createdById: 'fixture-owner',
        createdAt: time,
        updatedAt: time,
      },
    };
    const context: MaterialContext = {
      id: 'fixture-context-v1',
      ...original,
      purpose: 'reference',
      refs: [
        {
          referenceId: 'fixture-original-reference',
          materialId: 'fixture-material',
          version: 1,
          readStateAtPin: 'ready',
        },
      ],
      createdByKind: 'account',
      createdById: 'fixture-owner',
      createdAt: time,
    };
    const write = () => {
      window.__snapshotLabelWrites++;
      throw new Error('Unexpected fixture write');
    };
    return {
      localDb: {
        materials: {
          list: async (p: MaterialsListParams) => {
            window.__snapshotLabelReads.push(p);
            if ('history' in p) {
              if (ctx.case === 'metadata-error') throw new Error('metadata unavailable');
              if (ctx.case === 'revoked')
                throw Object.assign(new Error('denied'), { code: 'FORBIDDEN' });
              return { referenceContract: 1, ...p, materials: [material] };
            }
            return { referenceContract: 1, scope: p, materials: [] };
          },
          preview: async (p: MaterialPreviewParams) => {
            window.__snapshotLabelPreviews.push(p);
            if (ctx.case === 'unreadable')
              throw Object.assign(new Error('missing'), { code: 'SOURCE_MISSING' });
            return {
              referenceContract: 1,
              materialId: p.materialId,
              version: p.version,
              kind: 'text',
              text: 'Fixture immutable snapshot v1',
              name: filename,
              mime: 'text/plain',
              size: 32,
            };
          },
          add: write,
          addVersion: write,
          removeReference: write,
          retryRead: write,
        },
        materialContexts: {
          list: async (p: MaterialContextListParams) =>
            'history' in p
              ? { referenceContract: 1, ...p, contexts: [context] }
              : {
                  referenceContract: 1,
                  scope: p,
                  contexts: ctx.case === 'rebind' ? [] : [context],
                },
          create: write,
        },
      },
    };
  },
  render: (ctx) => <Fixture ctx={ctx} />,
});
