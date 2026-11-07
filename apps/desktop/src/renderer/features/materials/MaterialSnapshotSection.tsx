/**
 * MaterialSnapshotSection — 参考快照（契约 §1 material_contexts / §2 R3、R5）。
 *
 * 快照是不可变的绑定记录：执行与候选验收只记录 `material_context_id`，所以这里
 * 只做两件可见的事——
 *   1. 创建快照前让用户逐项选择版本（默认显示当前版本，但必须显式确认才写库）；
 *   2. 列出已有快照，并把「绑定时是什么状态」与「现在还能不能读」分开写清楚：
 *      之后补版本、重试成功、移除引用都不会改写历史快照里的版本（A4/A5/A8）。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Layers } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  bindableMaterials,
  contextRefViews,
  currentVersionNumber,
  formatMaterialTime,
  materialErrorKey,
  purposeLabelKey,
  readStateLabelKey,
  versionHistory,
  type ContextRefAvailability,
  type Material,
  type MaterialContext,
  type MaterialContextPurpose,
} from './materialReferenceView';
import {
  materialErrorCode,
  isScopeInvalidation,
  type TaskMaterialScope,
  type MaterialReferenceService,
} from './materialReferenceView';
import { MaterialPreviewDialog, type PreviewTarget } from './MaterialPreviewDialog';
import { FileLightbox } from '@/components/chat/FileLightbox';
import {
  clearMaterialDispatchMount,
  getMaterialDispatchMount,
  materialDispatchConsumptionKey,
  materialDispatchStateKey,
  mountFromContext,
  mountMaterialDispatch,
  readMaterialDispatchStatus,
  subscribeMaterialDispatchMount,
  type MaterialDispatchMount,
} from './materialDispatchMount';
import type { MaterialDispatchStatusItem } from '../../../shared/materialDispatch';

/** Display metadata only: exact pinned reference + original context scope + pinned version.
 * The reference may now select v2; the v1 catalogue entry must still exist.
 * Historical rows never enter the write candidate list below.
 */
function snapshotMaterial(
  context: MaterialContext,
  ref: MaterialContext['refs'][number],
  current: readonly Material[],
  historical: readonly Material[],
): Material | null {
  const matches = (material: Material): boolean =>
    !!ref.referenceId &&
    material.id === ref.materialId &&
    material.reference.materialId === ref.materialId &&
    material.reference.id === ref.referenceId &&
    material.reference.projectId === context.projectId &&
    material.reference.workItemId === context.workItemId &&
    material.reference.bindingRevision === context.bindingRevision &&
    material.versions.some(
      (version) => version.materialId === ref.materialId && version.version === ref.version,
    );
  const active = current.filter(matches);
  if (active.length) return active.length === 1 ? active[0] : null;
  const history = historical.filter(matches);
  return history.length === 1 ? history[0] : null;
}

const PURPOSES: MaterialContextPurpose[] = ['reference', 'redecompose', 'recheck'];

export interface MaterialSnapshotSectionProps {
  scope: TaskMaterialScope;
  service: MaterialReferenceService;
  writeBlocked?: boolean;
  onInvalidate: (error: unknown) => void;
  materials: Material[];
}

export function MaterialSnapshotSection(props: MaterialSnapshotSectionProps): React.ReactElement {
  return (
    <MaterialSnapshotScope
      key={JSON.stringify([props.scope, getDataOwnerGeneration()])}
      {...props}
    />
  );
}

function MaterialSnapshotScope({
  scope,
  service,
  writeBlocked,
  onInvalidate,
  materials,
}: MaterialSnapshotSectionProps): React.ReactElement {
  const { t } = useTranslation();
  const workItemId = scope.workItemId!;
  const [history, setHistory] = useState(false);
  const [uncertain, setUncertain] = useState(false);
  const [dispatchMount, setDispatchMount] = useState<MaterialDispatchMount | null>(() =>
    getMaterialDispatchMount(workItemId),
  );
  const [dispatchStatus, setDispatchStatus] = useState<MaterialDispatchStatusItem[] | null>(null);
  const [dispatchStatusError, setDispatchStatusError] = useState(false);
  const [dispatchStatusLoading, setDispatchStatusLoading] = useState(true);
  const [preview, setPreview] = useState<PreviewTarget | null>(null);
  const [inApp, setInApp] = useState<{ path: string; name: string } | null>(null);
  const [historicalMaterials, setHistoricalMaterials] = useState<Material[]>([]);
  const [metadataError, setMetadataError] = useState(false);
  const [contexts, setContexts] = useState<MaterialContext[]>([]);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<unknown>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [purpose, setPurpose] = useState<MaterialContextPurpose>('reference');
  const [selection, setSelection] = useState<Record<string, string>>({});
  const [creating, setCreating] = useState(false);
  const creatingRef = useRef(false);
  const mounted = useRef(false);
  const scopeOwner = useRef(getDataOwnerGeneration());
  const loadRequest = useRef(0);

  // Mount state is shared with the composer: one context per task, replaced on switch.
  useEffect(() => {
    const sync = (): void => setDispatchMount(getMaterialDispatchMount(workItemId));
    sync();
    return subscribeMaterialDispatchMount(sync);
  }, [workItemId]);

  // Post-send state always comes from the ledger read, never from optimistic UI state.
  const loadDispatchStatus = useCallback(async (): Promise<void> => {
    if (!mounted.current || !isDataOwnerGenerationCurrent(scopeOwner.current)) return;
    setDispatchStatusLoading(true);
    try {
      const messages = await readMaterialDispatchStatus(workItemId);
      if (!mounted.current || !isDataOwnerGenerationCurrent(scopeOwner.current)) return;
      setDispatchStatus(messages);
      setDispatchStatusError(false);
    } catch {
      if (!mounted.current || !isDataOwnerGenerationCurrent(scopeOwner.current)) return;
      setDispatchStatus(null);
      setDispatchStatusError(true);
    } finally {
      if (mounted.current) setDispatchStatusLoading(false);
    }
  }, [workItemId]);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      loadRequest.current += 1;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    if (!mounted.current || !isDataOwnerGenerationCurrent(scopeOwner.current)) return;
    const request = ++loadRequest.current;
    const owner = getDataOwnerGeneration();
    const valid = (): boolean =>
      mounted.current && request === loadRequest.current && isDataOwnerGenerationCurrent(owner);
    setLoading(true);
    setContexts([]);
    setHistoricalMaterials([]);
    setMetadataError(false);
    setPreview(null);
    setInApp(null);
    setPickerOpen(false);
    setSelection({});
    setLoadError(null);
    try {
      const next = await service.listContexts(
        history
          ? { projectId: scope.projectId, workItemId, history: true }
          : { ...scope, workItemId },
      );
      if (!valid()) return;
      let historical: Material[] = [];
      let failedMetadata = false;
      if (
        next.contexts.some(
          (context) =>
            context.projectId === scope.projectId &&
            context.workItemId === workItemId &&
            context.bindingRevision !== null &&
            context.refs.some(
              (ref) => !!ref.referenceId && !snapshotMaterial(context, ref, materials, []),
            ),
        )
      ) {
        try {
          const result = await service.list({
            projectId: scope.projectId,
            workItemId,
            history: true,
          });
          if (!valid()) return;
          historical = result.materials;
        } catch (error: unknown) {
          if (!valid()) return;
          if (isScopeInvalidation(error)) throw error;
          // Keep the authorized snapshot and generic label, never an old cached name.
          failedMetadata = true;
        }
      }
      if (!valid()) return;
      setHistoricalMaterials(historical);
      setMetadataError(failedMetadata);
      setContexts(next.contexts);
      setUncertain(false);
      setLoadError(null);
    } catch (error: unknown) {
      if (!valid()) return;
      setContexts([]);
      setHistoricalMaterials([]);
      setPreview(null);
      setInApp(null);
      setLoadError(error);
      setPickerOpen(false);
      setSelection({});
      if (isScopeInvalidation(error)) {
        onInvalidate(error);
        return;
      }
    } finally {
      if (valid()) setLoading(false);
    }
  }, [service, history, materials]);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    void loadDispatchStatus();
  }, [loadDispatchStatus]);

  const candidates = useMemo(() => bindableMaterials(materials), [materials]);
  const contextViews = (context: MaterialContext) =>
    context.refs.map((ref) => {
      const material = snapshotMaterial(context, ref, materials, historicalMaterials);
      return contextRefViews([ref], material ? [material] : [])[0];
    });
  const unavailable = materialErrorCode(loadError) === 'MATERIALS_UNAVAILABLE';

  const openPicker = (): void => {
    if (
      candidates.length === 0 ||
      writeBlocked ||
      uncertain ||
      history ||
      loading ||
      loadError ||
      metadataError
    )
      return;
    const initial: Record<string, string> = {};
    for (const material of candidates) {
      const current = currentVersionNumber(material);
      if (current > 0) initial[material.reference.id] = String(current);
    }
    setSelection(initial);
    setPurpose('reference');
    setPickerOpen(true);
  };

  const refs = useMemo(
    () =>
      candidates.flatMap((material) => {
        const chosen = Number(selection[material.reference.id] ?? '');
        return Number.isFinite(chosen) && chosen > 0
          ? [{ referenceId: material.reference.id, materialId: material.id, version: chosen }]
          : [];
      }),
    [candidates, selection],
  );

  const submit = async (): Promise<void> => {
    if (
      writeBlocked ||
      uncertain ||
      history ||
      loading ||
      loadError ||
      metadataError ||
      creatingRef.current ||
      refs.length === 0 ||
      !mounted.current ||
      !isDataOwnerGenerationCurrent(scopeOwner.current)
    )
      return;
    const owner = getDataOwnerGeneration();
    const valid = (): boolean => mounted.current && isDataOwnerGenerationCurrent(owner);
    creatingRef.current = true;
    setCreating(true);
    try {
      await service.createContext({ ...scope, workItemId, purpose, refs });
      if (!valid()) return;
      toast.success(t('ccAgent.materials.snapshot.created', { count: refs.length }));
      setPickerOpen(false);
      await load();
    } catch (error: unknown) {
      if (!valid()) return;
      if (isScopeInvalidation(error)) {
        onInvalidate(error);
        return;
      }
      if (materialErrorCode(error) === 'UNKNOWN') {
        setUncertain(true);
        setPickerOpen(false);
      }
      toast.error(t(materialErrorKey(materialErrorCode(error))));
    } finally {
      if (valid()) {
        creatingRef.current = false;
        setCreating(false);
      }
    }
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="work-item-snapshots-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="work-item-snapshots-title"
            className="text-14 font-medium text-[var(--settings-section-title)]"
          >
            {t('ccAgent.materials.snapshot.title')}
          </h2>
          <p className="mt-1 max-w-[560px] text-12 leading-normal text-[var(--settings-section-desc)]">
            {t('ccAgent.materials.snapshot.desc')}
          </p>
        </div>
        <Button
          variant="secondary"
          size="sm"
          disabled={
            candidates.length === 0 ||
            !!writeBlocked ||
            uncertain ||
            history ||
            loading ||
            !!loadError ||
            metadataError
          }
          onClick={openPicker}
        >
          <Layers size={13} strokeWidth={1.75} aria-hidden />
          {t('ccAgent.materials.snapshot.create')}
        </Button>
      </div>

      <Button
        variant="secondary"
        size="sm"
        disabled={creating}
        onClick={() => {
          loadRequest.current++;
          setLoading(true);
          setContexts([]);
          setPickerOpen(false);
          setSelection({});
          setHistory((value) => !value);
        }}
      >
        {t('ccAgent.materials.referenceHistory')}
      </Button>
      {history && (
        <p className="text-12 text-[var(--text-secondary)]">
          {t('ccAgent.materials.historyReadOnly')}
        </p>
      )}
      {metadataError && !loading && !loadError && (
        <Button variant="secondary" size="sm" onClick={() => void load()}>
          {t('ccAgent.materials.retryLoad')}
        </Button>
      )}
      {uncertain && (
        <ErrorNotice
          message={t('ccAgent.materials.pendingConfirmation')}
          actions={
            <Button variant="secondary" size="sm" onClick={() => void load()}>
              {t('ccAgent.materials.confirmRefresh')}
            </Button>
          }
        />
      )}
      {loadError && unavailable ? (
        <div className="flex flex-col items-start gap-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-6">
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('ccAgent.materials.unavailableTitle')}
          </p>
          <p className="max-w-[560px] text-12 leading-normal text-[var(--text-secondary)]">
            {t('ccAgent.materials.unavailableDesc')}
          </p>
        </div>
      ) : loadError ? (
        <ErrorNotice
          message={t('ccAgent.materials.snapshot.loadFailed')}
          details={loadError instanceof Error ? loadError.message : undefined}
          actions={
            <Button variant="secondary" size="sm" loading={loading} onClick={() => void load()}>
              {t('ccAgent.materials.retryLoad')}
            </Button>
          }
        />
      ) : loading && contexts.length === 0 ? (
        <div className="flex items-center justify-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] py-8 text-12 text-[var(--text-secondary)]">
          <Spinner size={14} />
          {t('ccAgent.materials.snapshot.loading')}
        </div>
      ) : contexts.length === 0 ? (
        <div className="flex flex-col items-center gap-2 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-8 text-center">
          <Layers
            size={22}
            strokeWidth={1.5}
            className="text-[var(--text-secondary)]"
            aria-hidden
          />
          <p className="text-13 font-medium text-[var(--text-primary)]">
            {t('ccAgent.materials.snapshot.empty')}
          </p>
          <p className="max-w-[420px] text-12 leading-normal text-[var(--text-secondary)]">
            {t('ccAgent.materials.snapshot.emptyDesc')}
          </p>
        </div>
      ) : (
        <ul className="flex flex-col gap-2">
          {contexts.map((context) => (
            <li
              key={context.id}
              className="rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4 py-3"
            >
              <div className="flex flex-wrap items-center gap-2">
                <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-none text-[var(--text-secondary)]">
                  {t(purposeLabelKey(context.purpose))}
                </span>
                <span className="text-11 text-[var(--text-secondary)]">
                  {t('ccAgent.materials.snapshot.boundCount', { count: context.refs.length })}
                </span>
                <span className="ml-auto text-11 text-[var(--text-secondary)]">
                  {t('ccAgent.materials.snapshot.createdAt')}{' '}
                  {formatMaterialTime(context.createdAt)}
                </span>
              </div>
              {(context.bindingRevision === null ||
                context.bindingRevision !== scope.bindingRevision) && (
                <p className="text-11 text-[var(--text-secondary)]">
                  {t(
                    context.bindingRevision === null
                      ? 'ccAgent.materials.unknownBinding'
                      : 'ccAgent.materials.historyReadOnly',
                  )}
                </p>
              )}
              {!history &&
                !loadError &&
                !writeBlocked &&
                context.projectId === scope.projectId &&
                context.bindingRevision === scope.bindingRevision &&
                (() => {
                  const attached = dispatchMount?.selector.contextId === context.id;
                  const replaced =
                    !attached &&
                    dispatchMount !== null &&
                    dispatchMount.selector.projectId === context.projectId;
                  return (
                    <div className="mt-2 flex flex-wrap items-center gap-2">
                      <Button
                        variant="secondary"
                        tone={attached ? undefined : 'quiet'}
                        size="xs"
                        onClick={() => {
                          if (attached) {
                            clearMaterialDispatchMount(workItemId);
                            return;
                          }
                          mountMaterialDispatch(
                            mountFromContext(
                              workItemId,
                              context,
                              contextViews(context).map((view) => ({
                                name:
                                  view.material?.name ??
                                  t('ccAgent.materials.snapshot.refUnknown'),
                                version: view.ref.version,
                                readState: view.ref.readStateAtPin,
                              })),
                            ),
                          );
                        }}
                      >
                        {t(
                          attached
                            ? 'ccAgent.materials.dispatch.mounted'
                            : 'ccAgent.materials.dispatch.mount',
                        )}
                      </Button>
                      {attached && (
                        <span className="text-11 text-[var(--text-secondary)]">
                          {t('ccAgent.materials.dispatch.mountedSummary', {
                            count: context.refs.length,
                          })}
                        </span>
                      )}
                      {replaced && (
                        <span className="text-11 text-[var(--text-secondary)]">
                          {t('ccAgent.materials.dispatch.replacesPrevious')}
                        </span>
                      )}
                    </div>
                  );
                })()}
              <ul className="mt-2 flex flex-col gap-1">
                {contextViews(context).map((view) => (
                  <li
                    key={`${view.ref.referenceId ?? view.ref.materialId}-${view.ref.version}`}
                    className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-12"
                  >
                    <span
                      title={view.material?.name ?? t('ccAgent.materials.snapshot.refUnknown')}
                      className="min-w-0 truncate text-[var(--text-primary)]"
                    >
                      {view.material?.name ?? t('ccAgent.materials.snapshot.refUnknown')}
                    </span>
                    <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 leading-none text-[var(--text-secondary)]">
                      {t('ccAgent.materials.versionShort', { version: view.ref.version })}
                    </span>
                    <span className="text-11 text-[var(--text-secondary)]">
                      {t('ccAgent.materials.snapshot.pinState')}
                      {' · '}
                      {t(readStateLabelKey(view.ref.readStateAtPin))}
                    </span>
                    <Button
                      variant="secondary"
                      size="xs"
                      compact
                      onClick={() =>
                        setPreview({
                          contextId: context.id,
                          materialId: view.ref.materialId,
                          version: view.ref.version,
                          name: view.material?.name ?? t('ccAgent.materials.snapshot.refUnknown'),
                        })
                      }
                    >
                      {t('ccAgent.materials.preview')}
                    </Button>
                    <AvailabilityNote availability={view.availability} material={view.material} />
                    {view.currentReadState && view.currentReadState !== view.ref.readStateAtPin && (
                      <span className="text-11 text-[var(--text-secondary)]">
                        {t('ccAgent.materials.snapshot.currentState')}
                        {' · '}
                        {view.currentIssueKey
                          ? t(view.currentIssueKey)
                          : t(readStateLabelKey(view.currentReadState))}
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            </li>
          ))}
        </ul>
      )}

      <section className="flex flex-col gap-2" aria-labelledby="work-item-dispatch-status-title">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="min-w-0">
            <h3
              id="work-item-dispatch-status-title"
              className="text-13 font-medium text-[var(--settings-section-title)]"
            >
              {t('ccAgent.materials.dispatch.statusTitle')}
            </h3>
            <p className="mt-0.5 max-w-[560px] text-11 leading-normal text-[var(--text-secondary)]">
              {t('ccAgent.materials.dispatch.statusDesc')}
            </p>
          </div>
          <Button
            variant="secondary"
            size="xs"
            disabled={dispatchStatusLoading}
            onClick={() => void loadDispatchStatus()}
          >
            {t('ccAgent.materials.dispatch.refresh')}
          </Button>
        </div>
        {dispatchStatusLoading && dispatchStatus === null ? (
          <div className="flex items-center gap-2 text-12 text-[var(--text-secondary)]">
            <Spinner size={12} />
            {t('ccAgent.materials.dispatch.loading')}
          </div>
        ) : dispatchStatusError ? (
          <p className="text-12 text-[var(--warning-fg)]">
            {t('ccAgent.materials.dispatch.statusError')}
          </p>
        ) : !dispatchStatus || dispatchStatus.length === 0 ? (
          <p className="text-12 text-[var(--text-secondary)]">
            {t('ccAgent.materials.dispatch.statusEmpty')}
          </p>
        ) : (
          <ul className="flex flex-col gap-1.5">
            {dispatchStatus.map((item) => (
              <li
                key={item.clientId}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-3 py-2 text-12"
              >
                <span className="rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-none text-[var(--text-primary)]">
                  {t(materialDispatchStateKey(item.state))}
                </span>
                <span className="text-11 text-[var(--text-secondary)]">
                  {t('ccAgent.materials.dispatch.revisionLabel', { revision: item.revision })}
                  {item.referenceCount > 0
                    ? ` · ${t('ccAgent.materials.dispatch.refCount', { count: item.referenceCount })}`
                    : ''}
                </span>
                <span className="text-11 text-[var(--text-secondary)]">
                  {t('ccAgent.materials.dispatch.consumptionLabel')}
                  {' · '}
                  {item.consumption
                    ? t(materialDispatchConsumptionKey(item.consumption.consumer, item.consumption.outcome))
                    : t('ccAgent.materials.dispatch.consumptionNone')}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <ConfirmDialog
        open={pickerOpen}
        onOpenChange={(next) => {
          if (!next && !creating) setPickerOpen(false);
        }}
        maxWidth={520}
        title={t('ccAgent.materials.snapshot.pickerTitle')}
        description={t('ccAgent.materials.snapshot.pickerDesc')}
        confirmText={t('ccAgent.materials.snapshot.confirm')}
        cancelText={t('ccAgent.materials.snapshot.cancel')}
        confirmDisabled={refs.length === 0}
        loading={creating}
        onConfirm={() => void submit()}
        onCancel={() => setPickerOpen(false)}
        content={
          <div className="flex flex-col gap-3">
            <Select
              label={t('ccAgent.materials.snapshot.pickerPurpose')}
              value={purpose}
              options={PURPOSES.map((item) => ({
                value: item,
                label: t(purposeLabelKey(item)),
              }))}
              onValueChange={(value) => {
                if (value === 'reference' || value === 'redecompose' || value === 'recheck') {
                  setPurpose(value);
                }
              }}
              disabled={creating}
            />
            <div className="flex flex-col gap-1.5">
              <span className="text-12 font-medium text-[var(--settings-section-title)]">
                {t('ccAgent.materials.snapshot.pickerVersions')}
              </span>
              <ul className="flex flex-col gap-1.5">
                {candidates.map((material) => {
                  const options = versionHistory(material).map((version) => ({
                    value: String(version.version),
                    label: `${t('ccAgent.materials.versionShort', { version: version.version })} · ${t(
                      readStateLabelKey(version.readState),
                    )}`,
                  }));
                  return (
                    <li key={material.reference.id} className="flex items-center gap-2">
                      <span
                        className="min-w-0 flex-1 truncate text-12 text-[var(--text-primary)]"
                        title={material.name}
                      >
                        {material.name}
                      </span>
                      <Select
                        label={material.name}
                        value={selection[material.reference.id] ?? ''}
                        options={[
                          { value: '', label: t('ccAgent.materials.snapshot.pickerVersionNone') },
                          ...options,
                        ]}
                        onValueChange={(value) =>
                          setSelection((current) => ({
                            ...current,
                            [material.reference.id]: value,
                          }))
                        }
                        className="w-[160px]"
                        disabled={creating}
                      />
                    </li>
                  );
                })}
              </ul>
            </div>
            <p className="text-11 leading-normal text-[var(--text-secondary)]">
              {t('ccAgent.materials.snapshot.pickerHint')}
            </p>
          </div>
        }
      />
      <MaterialPreviewDialog
        target={preview}
        service={service}
        scope={scope}
        onInvalidate={onInvalidate}
        onClose={() => setPreview(null)}
        onOpenInApp={(path, name) => setInApp({ path, name })}
        onVersionRecorded={() => void load()}
      />
      {inApp && (
        <FileLightbox filePath={inApp.path} fileName={inApp.name} onClose={() => setInApp(null)} />
      )}
    </section>
  );
}

function AvailabilityNote({
  availability,
  material,
}: {
  availability: ContextRefAvailability;
  material: Material | null;
}): React.ReactElement | null {
  const { t } = useTranslation();
  switch (availability) {
    case 'bound':
      return null;
    case 'materialRemoved':
      return (
        <span className="text-11 text-[var(--warning-fg)]">
          {t('ccAgent.materials.snapshot.materialRemoved')}
        </span>
      );
    case 'materialMissing':
      return (
        <span className="text-11 text-[var(--warning-fg)]">
          {t('ccAgent.materials.snapshot.materialMissing')}
        </span>
      );
    case 'versionMissing':
      return (
        <span className="text-11 text-[var(--warning-fg)]">
          {material?.status === 'removed'
            ? t('ccAgent.materials.snapshot.materialRemoved')
            : t('ccAgent.materials.snapshot.versionMissing')}
        </span>
      );
    default:
      return null;
  }
}
