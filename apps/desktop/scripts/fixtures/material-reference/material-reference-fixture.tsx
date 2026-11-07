/** Real R3-B page and UI. Only preload read/write receipts are synthetic; no uploads/DB/model. */
import { Route, Routes } from 'react-router-dom';
import { mountPage, subscription } from '../../ui-page/harness';
import { WorkItemMaterialsPage } from '../../../src/renderer/features/materials/WorkItemMaterialsPage';
import type {
  Material,
  MaterialVersion,
  MaterialContext,
  MaterialScope,
  MaterialsListParams,
  MaterialsAddParams,
  MaterialAddVersionParams,
  MaterialRemoveReferenceParams,
  MaterialRetryReadParams,
  MaterialPreviewParams,
  MaterialContextListParams,
  MaterialContextCreateParams,
} from '../../../src/shared/materials';
const scope = { projectId: 'p', workItemId: 't3', bindingRevision: 9 };
const time = '2026-11-05T09:30:00Z';
const v = (id: string, n: number, mime = 'text/plain'): MaterialVersion => ({
  id: `${id}-v${n}`,
  materialId: id,
  version: n,
  sha256: `${id}-${n}`,
  sizeBytes: 1024,
  mime,
  storageKind: 'file',
  readState: 'ready',
  failureReason: null,
  createdAt: time,
});
function row(id: string, name: string, n = 1, latest = 1, mime = 'text/plain'): Material {
  return {
    id,
    projectId: 'p',
    workItemId: 't3',
    name,
    status: 'active',
    createdByKind: 'account',
    createdById: 'creator',
    createdAt: time,
    updatedAt: time,
    currentVersion: n,
    latestVersion: latest,
    versions: Array.from({ length: latest }, (_, i) => v(id, i + 1, mime)),
    readState: 'ready',
    reference: {
      ...scope,
      id: `ref-${id}`,
      materialId: id,
      version: n,
      status: 'active',
      createdByKind: 'account',
      createdById: 'creator',
      createdAt: time,
      updatedAt: time,
    },
  };
}
mountPage({
  route: '/cc-agent/projects/p/items/t3',
  host: (ctx) => {
    let rows =
      ctx.case === 'empty'
        ? []
        : [
            row(
              'brief',
              ctx.locale === 'de'
                ? 'Projektanforderungen-und-Referenzmaterialien-mit-einem-sehr-langen-Dateinamen.pdf'
                : 'project-requirements-and-material-reference-version-history.pdf',
              1,
              2,
            ),
            row('image', 'homepage.png', 1, 1, 'image/png'),
            row('other', 'budget.xlsx', 1, 1, 'application/octet-stream'),
          ];
    let contexts: MaterialContext[] =
      ctx.case === 'empty'
        ? []
        : [
            {
              id: 'ctx-v1',
              ...scope,
              purpose: 'reference',
              refs: [
                {
                  referenceId: 'ref-brief',
                  materialId: 'brief',
                  version: 1,
                  readStateAtPin: 'ready',
                },
              ],
              createdByKind: 'account',
              createdById: 'creator',
              createdAt: time,
            },
          ];
    const reply = (s: MaterialScope) => ({ referenceContract: 1, scope: s, materials: rows });
    return {
      getFilePath: (file: File) => `/fixture/${file.name}`,
      localDb: {
        projects: { onChanged: subscription('projectsChanged') },
        projectProgress: {
          read: async () => ({
            projectId: 'p',
            items: [
              {
                sessionId: 't3',
                projectId: 'p',
                title: 'Reference material versions',
                sessionStatus: 'active',
                bindingRevision: 9,
                progress: null,
              },
            ],
            capabilities: { canRecord: true, canConfirmDone: false },
            history: [],
          }),
        },
        materials: {
          list: async (p: MaterialsListParams) =>
            'history' in p ? { referenceContract: 1, ...p, materials: rows } : reply(p),
          add: async (p: MaterialsAddParams) => {
            if (p.existing) {
              rows = rows.map((r) =>
                r.id === p.existing[0].materialId
                  ? {
                      ...r,
                      currentVersion: p.existing[0].version,
                      reference: { ...r.reference, version: p.existing[0].version },
                    }
                  : r,
              );
              return {
                referenceContract: 1,
                scope,
                added: [],
                duplicates: [],
                rejected: [],
                references: [rows[0].reference],
              };
            }
            const added = p.files.map((f, i) => row(`add-${i}`, f.name));
            rows = [...rows, ...added];
            return {
              referenceContract: 1,
              scope,
              added: added.map((r) => r.versions[0]),
              duplicates: [],
              rejected: [],
              references: added.map((r) => r.reference),
            };
          },
          addVersion: async (p: MaterialAddVersionParams) => {
            const target = rows.find((r) => r.id === p.materialId)!;
            const next = v(target.id, target.latestVersion + 1);
            target.versions.push(next);
            target.latestVersion = next.version;
            target.currentVersion = next.version;
            target.reference.version = next.version;
            return { referenceContract: 1, scope, version: next, reference: target.reference };
          },
          removeReference: async (p: MaterialRemoveReferenceParams) => {
            const target = rows.find((r) => r.reference.id === p.referenceId)!;
            target.status = 'removed';
            target.reference.status = 'removed';
            rows = rows.filter((r) => r.status === 'active');
            return {
              referenceContract: 1,
              scope,
              ok: true,
              status: 'removed',
              reference: target.reference,
            };
          },
          retryRead: async (p: MaterialRetryReadParams) => ({
            referenceContract: 1,
            version: v(p.materialId, p.version),
          }),
          preview: async (p: MaterialPreviewParams) => ({
            referenceContract: 1,
            materialId: p.materialId,
            version: p.version,
            name: rows.find((r) => r.id === p.materialId)?.name ?? 'Historical version',
            mime: 'text/plain',
            size: 1024,
            ...(p.materialId === 'image'
              ? {
                  kind: 'image',
                  url:
                    'data:image/svg+xml,' +
                    encodeURIComponent(
                      '<svg xmlns="http://www.w3.org/2000/svg" width="300" height="180"><rect width="300" height="180" fill="gray"/><text x="30" y="90">Fixture image v1</text></svg>',
                    ),
                }
              : p.materialId === 'other'
                ? { kind: 'unsupported', url: 'xdt-file://local/?path=%2Ffixture%2Fbudget.xlsx' }
                : {
                    kind: 'text',
                    text: `Fixture material version ${p.version}\nSaved versions do not automatically enter a model.`,
                  }),
          }),
        },
        materialContexts: {
          list: async (p: MaterialContextListParams) =>
            'history' in p
              ? { referenceContract: 1, ...p, contexts }
              : { referenceContract: 1, scope, contexts },
          create: async (p: MaterialContextCreateParams) => {
            const context: MaterialContext = {
              id: 'ctx-new',
              ...scope,
              purpose: p.purpose,
              refs: p.refs.map((r) => ({ ...r, readStateAtPin: 'ready' })),
              createdByKind: 'account',
              createdById: 'creator',
              createdAt: time,
            };
            contexts = [context, ...contexts];
            return { referenceContract: 1, context };
          },
        },
      },
    };
  },
  render: () => (
    <Routes>
      <Route
        path="/cc-agent/projects/:projectId/items/:sessionId"
        element={<WorkItemMaterialsPage />}
      />
    </Routes>
  ),
});
