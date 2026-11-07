/**
 * MaterialsPanel — 工作项详情里的「参考材料」面板（M2-B）。
 *
 * 界面职责（契约 §2/§4）：
 *   - 列出材料：名称 / 类型 / 大小 / 当前版本 / 读取状态；已移除引用单独折叠，仍可追溯。
 *   - 添加：文件选择、拖拽、粘贴三条入口，全部交给 `materials:add` 批量接口；
 *     逐项结果分三类处理——成功刷新、同内容「已沿用」提示、失败逐项提示并单独重试
 *     （任何一项失败都不回滚已成功项，与契约一致）。
 *   - 同名不同内容：先弹选择（新建独立材料 / 补充为新版本），未选择不提交（R4）。
 *   - 移除当前引用：只改软状态，文案明确说字节与旧版本仍保留（R5）。
 *   - 预览：图片 / 文本 / 不支持正文三态，全部来自 `materials:preview`（R8）。
 *
 * 面板不缓存字节、不伪造版本、不推断权限：拿不到就说拿不到。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ImagePlus, Paperclip, Plus, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/ui/confirm-dialog';
import { FileLightbox } from '@/components/chat/FileLightbox';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Spinner } from '@/components/ui/spinner';
import { toast } from '@/lib/toast';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import { cn } from '@/lib/utils';
import {
  CONFLICT_CANCELLED,
  NO_LOCAL_PATH,
  currentVersionNumber,
  findNameConflicts,
  materialErrorKey,
  splitMaterials,
  type Material,
  type MaterialAddResult,
  type MaterialDuplicateNotice,
  type MaterialFileInput,
  type PendingMaterialFile,
  type NameConflict,
  type MaterialScope,
  type MaterialReferenceService,
  isScopeInvalidation,
  MaterialWritePendingError,
} from './materialReferenceView';
import { MaterialReferenceRefreshError } from './materialReferenceService';
import { computeFileSha256, localFilePathOf, materialErrorCode } from './materialReferenceView';
import { MaterialRow } from './MaterialRow';
import { MaterialPreviewDialog, type PreviewTarget } from './MaterialPreviewDialog';

export interface MaterialsPanelProps {
  scope: MaterialScope;
  service: MaterialReferenceService;
  writeBlocked?: boolean;
  onCurrent: (current: import('../../../shared/materials').MaterialsListResult) => void;
  onInvalidate: (error: unknown) => void;
  materials: Material[];
  loading: boolean;
  loadError: unknown;
  onReload: () => Promise<void>;
}

interface RejectedItem {
  name: string;
  code: string;
  /** 有路径才能单独重试；纯剪贴板位图永远没有。 */
  path: string | null;
  retryable?: boolean;
  /** Selected but not dispatched after an earlier operation needs confirmation. */
  notSubmitted?: boolean;
  operation?:
    | { kind: 'add'; file: MaterialFileInput }
    | { kind: 'version'; materialId: string; referenceId: string; file: MaterialFileInput };
}

type Busy =
  | null
  | 'add'
  | 'remove'
  | 'conflict'
  | { kind: 'retryRead'; materialId: string }
  | { kind: 'retryRejected'; index: number }
  | { kind: 'relink'; materialId: string };

export function MaterialsPanel(props: MaterialsPanelProps): React.ReactElement {
  return (
    <MaterialsPanelScope key={JSON.stringify([props.scope, getDataOwnerGeneration()])} {...props} />
  );
}

function MaterialsPanelScope({
  scope,
  service,
  writeBlocked,
  onCurrent,
  onInvalidate,
  materials,
  loading,
  loadError,
  onReload,
}: MaterialsPanelProps): React.ReactElement {
  const { t } = useTranslation();
  const projectId = scope.projectId;
  const workItemId = scope.workItemId;
  const mounted = useRef(false);
  const owner = useRef(getDataOwnerGeneration());
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);
  const valid = () => mounted.current && isDataOwnerGenerationCurrent(owner.current);
  const [pendingConfirmation, setPendingConfirmation] = useState(false);
  const [history, setHistory] = useState<Material[]>([]);
  const [historyError, setHistoryError] = useState<unknown>(null);
  const uncertain = (error: unknown) =>
    error instanceof MaterialReferenceRefreshError ||
    error instanceof MaterialWritePendingError ||
    materialErrorCode(error) === 'UNKNOWN';
  const handleFailure = (error: unknown) => {
    if (!valid()) return;
    if (isScopeInvalidation(error)) onInvalidate(error);
    else if (uncertain(error)) setPendingConfirmation(true);
  };
  const addMaterials = async (
    _project: string,
    _work: string | null,
    files: MaterialFileInput[],
  ) => {
    const result = await service.add({ ...scope, files });
    if (valid() && result.current) onCurrent(result.current);
    return result.receipt;
  };
  const addMaterialVersion = async (
    materialId: string,
    referenceId: string,
    file: MaterialFileInput,
  ) => {
    const reply = await service.addVersion({
      ...scope,
      materialId,
      referenceId,
      file,
      replaceCurrentReference: true,
    });
    try {
      await onReload();
    } catch (error) {
      if (isScopeInvalidation(error)) throw error;
      throw new MaterialWritePendingError();
    }
    return reply.version;
  };
  const removeMaterialReference = async (referenceId: string) =>
    service.removeReference({ ...scope, referenceId });
  const retryMaterialRead = async (material: Material, version: number) =>
    (
      await service.retryRead({
        ...scope,
        referenceId: material.reference.id,
        materialId: material.id,
        version,
      })
    ).version;

  const [busy, setBusy] = useState<Busy>(null);
  const busyRef = useRef(false);
  const [duplicates, setDuplicates] = useState<MaterialDuplicateNotice[]>([]);
  const [rejected, setRejected] = useState<RejectedItem[]>([]);
  const [conflicts, setConflicts] = useState<NameConflict[]>([]);
  const [removeTarget, setRemoveTarget] = useState<Material | null>(null);
  const [relinkTarget, setRelinkTarget] = useState<Material | null>(null);
  const [previewTarget, setPreviewTarget] = useState<PreviewTarget | null>(null);
  const [inAppFile, setInAppFile] = useState<{ path: string; name: string } | null>(null);
  const [expanded, setExpanded] = useState<Set<string>>(new Set());
  const [dragActive, setDragActive] = useState(false);
  const [showRemoved, setShowRemoved] = useState(false);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const relinkInputRef = useRef<HTMLInputElement>(null);
  const dragDepth = useRef(0);

  const { active } = useMemo(() => splitMaterials(materials), [materials]);
  const removed = history;
  const unavailable = materialErrorCode(loadError) === 'MATERIALS_UNAVAILABLE';
  const actionLocked = busy !== null || !!writeBlocked || pendingConfirmation;

  const begin = useCallback(
    (next: Busy): boolean => {
      if (busyRef.current || writeBlocked || pendingConfirmation || !valid()) return false;
      busyRef.current = true;
      setBusy(next);
      return true;
    },
    [writeBlocked, pendingConfirmation],
  );

  const end = useCallback((): void => {
    if (!valid()) return;
    busyRef.current = false;
    setBusy(null);
  }, []);

  const applyAddResult = useCallback(
    (result: MaterialAddResult, files: MaterialFileInput[]): void => {
      if (!valid()) return;
      // Every request has unique names (same-name selections use single-file operations).
      // Match only an unambiguous input, never a response position or last-write-wins map.
      const inputFor = (name: string): MaterialFileInput | undefined => {
        const matches = files.filter((file) => file.name === name);
        return matches.length === 1 ? matches[0] : undefined;
      };
      if (result.rejected.length > 0) {
        setRejected((current) => [
          ...current,
          ...result.rejected.map((item): RejectedItem => ({
            name: item.name,
            code: item.code,
            path: inputFor(item.name)?.path ?? null,
            operation: inputFor(item.name)
              ? { kind: 'add', file: inputFor(item.name)! }
              : undefined,
          })),
        ]);
      }
      if (result.duplicates.length > 0) {
        // 同内容沿用：提示即可，默认不新建（R3）。
        setDuplicates((current) => [...current, ...result.duplicates]);
      }
      if (result.added.length > 0) {
        toast.success(t('ccAgent.materials.added', { count: result.added.length }));
        return;
      }
      if (result.duplicates.length === 0 && result.rejected.length === 0) {
        toast.info(t('ccAgent.materials.addedNone'));
      }
    },
    [t],
  );

  /** 文件 → 服务层输入。没有本机路径的（剪贴板位图）当场如实拒绝，不伪造路径。 */
  const addFiles = useCallback(
    async (files: File[]): Promise<void> => {
      if (files.length === 0 || !begin('add')) return;
      try {
        const localRejected: RejectedItem[] = [];
        const pending: PendingMaterialFile[] = [];
        for (const file of files) {
          const path = localFilePathOf(file);
          if (!path) {
            localRejected.push({ name: file.name, code: NO_LOCAL_PATH, path: null });
            continue;
          }
          pending.push({ name: file.name, path, sha256: await computeFileSha256(file) });
        }
        if (!valid()) return;
        if (localRejected.length > 0) setRejected((current) => [...current, ...localRejected]);
        if (pending.length === 0) return;

        const nameConflicts = findNameConflicts(materials, pending);
        const conflictIndexes = new Set(nameConflicts.map((conflict) => conflict.index));
        const direct = pending.filter((_file, index) => !conflictIndexes.has(index));
        if (nameConflicts.length > 0) setConflicts((current) => [...current, ...nameConflicts]);
        if (direct.length === 0) return;

        const selected: MaterialFileInput[] = direct.map(({ name, path }) => ({ name, path }));
        // R1 rejected carries only name. Keep ordinary multi-select batched; if names
        // collide, each selected file owns a separate request/receipt and retry intent.
        const batches =
          new Set(selected.map((file) => file.name)).size === selected.length
            ? [selected]
            : selected.map((file) => [file]);
        for (let batchIndex = 0; batchIndex < batches.length; batchIndex += 1) {
          if (!valid()) return;
          const inputs = batches[batchIndex];
          try {
            const result = await addMaterials(projectId, workItemId, inputs);
            if (!valid()) return;
            applyAddResult(result, inputs);
          } catch (error: unknown) {
            if (!valid()) return;
            handleFailure(error);
            if (isScopeInvalidation(error)) return;
            if (error instanceof MaterialReferenceRefreshError) {
              // Retain the received successes; never turn them into retryable failures.
              applyAddResult(error.receipt, inputs);
            } else {
              const code = materialErrorCode(error);
              setRejected((current) => [
                ...current,
                ...inputs.map((file): RejectedItem => ({
                  name: file.name,
                  code,
                  path: file.path,
                  retryable: !uncertain(error),
                  operation: { kind: 'add', file },
                })),
              ]);
            }
            if (uncertain(error)) {
              // Do not send further writes while outcome/refresh is unresolved. Keep
              // unsent selections visible and explicitly retryable after a fresh read.
              const remaining = batches.slice(batchIndex + 1).flat();
              setRejected((current) => [
                ...current,
                ...remaining.map((file): RejectedItem => ({
                  name: file.name,
                  code: materialErrorCode(error),
                  path: file.path,
                  retryable: true,
                  notSubmitted: true,
                  operation: { kind: 'add', file },
                })),
              ]);
              return;
            }
          }
        }
      } finally {
        end();
      }
    },
    [applyAddResult, begin, end, materials, onReload, projectId, workItemId],
  );

  const resolveConflict = useCallback(
    async (mode: 'version' | 'newMaterial'): Promise<void> => {
      const conflict = conflicts[0];
      if (!conflict || !begin('conflict')) return;
      const file: MaterialFileInput = { name: conflict.file.name, path: conflict.file.path };
      try {
        if (mode === 'version') {
          const addedVersion = await addMaterialVersion(
            conflict.material.id,
            conflict.material.reference.id,
            file,
          );
          if (!valid()) return;
          toast.success(
            t('ccAgent.materials.addedVersion', {
              name: conflict.material.name,
              version: addedVersion.version,
            }),
          );
        } else {
          file.sameNameAction = 'create-new';
          const result = await addMaterials(projectId, workItemId, [file]);
          if (!valid()) return;
          applyAddResult(result, [file]);
        }
      } catch (error: unknown) {
        if (!valid()) return;
        handleFailure(error);
        if (error instanceof MaterialReferenceRefreshError) {
          applyAddResult(error.receipt, [file]);
          return;
        }
        setRejected((current) => [
          ...current,
          {
            name: file.name,
            code: materialErrorCode(error) ?? 'UNKNOWN',
            path: file.path,
            retryable: !uncertain(error),
            operation:
              mode === 'version'
                ? {
                    kind: 'version',
                    materialId: conflict.material.id,
                    referenceId: conflict.material.reference.id,
                    file,
                  }
                : { kind: 'add', file },
          },
        ]);
      } finally {
        if (valid()) setConflicts((current) => current.slice(1));
        end();
      }
    },
    [applyAddResult, begin, conflicts, end, onReload, projectId, t, workItemId],
  );

  const cancelConflict = useCallback((): void => {
    const conflict = conflicts[0];
    if (!conflict) return;
    // 未选择不提交：文件不落库，也不假装它进了材料。
    setRejected((current) => [
      ...current,
      { name: conflict.file.name, code: CONFLICT_CANCELLED, path: null },
    ]);
    setConflicts((current) => current.slice(1));
  }, [conflicts]);

  const retryRejected = useCallback(
    async (item: RejectedItem, index: number): Promise<void> => {
      if (!item.path || !begin({ kind: 'retryRejected', index })) return;
      try {
        const operation = item.operation ?? {
          kind: 'add' as const,
          file: { name: item.name, path: item.path },
        };
        // Replay the chosen operation through the host: source/content/permission checks still apply.
        if (operation.kind === 'version') {
          await addMaterialVersion(operation.materialId, operation.referenceId, operation.file);
          if (!valid()) return;
          setRejected((current) => current.filter((_entry, position) => position !== index));
        } else {
          const result = await addMaterials(projectId, workItemId, [operation.file]);
          if (!valid()) return;
          setRejected((current) => current.filter((_entry, position) => position !== index));
          applyAddResult(result, [operation.file]);
        }
      } catch (error: unknown) {
        if (!valid()) return;
        handleFailure(error);
        const code = materialErrorCode(error) ?? 'UNKNOWN';
        setRejected((current) =>
          current.map((entry, position) =>
            position === index
              ? { ...entry, code, notSubmitted: false, retryable: !uncertain(error) }
              : entry,
          ),
        );
      } finally {
        end();
      }
    },
    [applyAddResult, begin, end, onReload, projectId, workItemId],
  );

  const retryRead = useCallback(
    async (material: Material): Promise<void> => {
      const version = currentVersionNumber(material);
      if (version <= 0 || !begin({ kind: 'retryRead', materialId: material.id })) return;
      try {
        // 重试只更新同一版本的 read_state，不新建版本（R7）。
        const next = await retryMaterialRead(material, version);
        await onReload();
        if (!valid()) return;
        if (next.readState === 'ready') {
          toast.success(t('ccAgent.materials.retryReadDone', { name: material.name }));
        } else if (next.readState === 'failed') {
          toast.error(t('ccAgent.materials.retryReadFailed', { name: material.name }));
        }
      } catch (error: unknown) {
        if (!valid()) return;
        handleFailure(error);
        toast.error(t(materialErrorKey(materialErrorCode(error))));
      } finally {
        end();
      }
    },
    [begin, end, onReload, t],
  );

  /**
   * 重新关联：原文件被改动或删除后，只能由用户重新指向一个文件；
   * 走 `add-version` 追加为该材料的新版本（版本不可变，不覆盖旧版本）。
   */
  const relink = useCallback(
    (material: Material): void => {
      if (busyRef.current || actionLocked || !valid()) return;
      setRelinkTarget(material);
      relinkInputRef.current?.click();
    },
    [actionLocked],
  );

  const onRelinkPicked = useCallback(
    async (files: File[]): Promise<void> => {
      const target = relinkTarget;
      const file = files[0];
      setRelinkTarget(null);
      if (!target || !file) return;
      const path = localFilePathOf(file);
      if (!path) {
        setRejected((current) => [
          ...current,
          { name: file.name, code: NO_LOCAL_PATH, path: null },
        ]);
        return;
      }
      if (!begin({ kind: 'relink', materialId: target.id })) return;
      try {
        await addMaterialVersion(target.id, target.reference.id, { name: file.name, path });
        if (!valid()) return;
        toast.success(t('ccAgent.materials.relinkDone', { name: target.name }));
      } catch (error: unknown) {
        if (!valid()) return;
        handleFailure(error);
        setRejected((current) => [
          ...current,
          {
            name: file.name,
            path,
            code: materialErrorCode(error),
            retryable: !uncertain(error),
            operation: {
              kind: 'version',
              materialId: target.id,
              referenceId: target.reference.id,
              file: { name: file.name, path },
            },
          },
        ]);
        toast.error(t(materialErrorKey(materialErrorCode(error))));
      } finally {
        end();
      }
    },
    [begin, end, onReload, relinkTarget, t],
  );

  const confirmRemove = useCallback(async (): Promise<void> => {
    if (!removeTarget || !begin('remove')) return;
    try {
      await removeMaterialReference(removeTarget.reference.id);
      if (!valid()) return;
      toast.success(t('ccAgent.materials.removedToast', { name: removeTarget.name }));
      setRemoveTarget(null);
      await onReload();
    } catch (error: unknown) {
      if (!valid()) return;
      handleFailure(error);
      toast.error(t(materialErrorKey(materialErrorCode(error))));
    } finally {
      end();
    }
  }, [begin, end, onReload, removeTarget, t]);

  // 粘贴：只在工作项页面生效；目标在输入框/可编辑区域里时让浏览器自己处理。
  useEffect(() => {
    const onPaste = (event: ClipboardEvent): void => {
      if (actionLocked) return;
      const target = event.target as HTMLElement | null;
      if (target?.closest('input, textarea, [contenteditable="true"]') !== null) return;
      // 弹窗打开时粘贴可能是在和弹窗交互，不往面板里塞文件。
      if (document.querySelector('[role="dialog"], [role="alertdialog"]')) return;
      const files = Array.from(event.clipboardData?.files ?? []);
      if (files.length === 0) return;
      event.preventDefault();
      void addFiles(files);
    };
    window.addEventListener('paste', onPaste);
    return () => window.removeEventListener('paste', onPaste);
  }, [actionLocked, addFiles]);

  const useVersion = async (material: Material, version: number) => {
    if (!begin('add')) return;
    try {
      const result = await service.add({
        ...scope,
        existing: [{ materialId: material.id, version }],
      });
      if (valid() && result.current) onCurrent(result.current);
    } catch (error) {
      handleFailure(error);
    } finally {
      end();
    }
  };
  const toggleVersions = (materialId: string): void => {
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(materialId)) next.delete(materialId);
      else next.add(materialId);
      return next;
    });
  };

  const onDrop = (event: React.DragEvent<HTMLElement>): void => {
    event.preventDefault();
    dragDepth.current = 0;
    setDragActive(false);
    const files = Array.from(event.dataTransfer.files ?? []);
    if (files.length > 0) void addFiles(files);
  };

  return (
    <section className="flex min-w-0 flex-col gap-3" aria-labelledby="work-item-materials-title">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <h2
            id="work-item-materials-title"
            className="text-14 font-medium text-[var(--settings-section-title)]"
          >
            {t('ccAgent.materials.sectionTitle')}
          </h2>
          <p className="mt-1 max-w-[560px] text-12 leading-normal text-[var(--settings-section-desc)]">
            {t('ccAgent.materials.sectionDesc')}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <input
            ref={fileInputRef}
            type="file"
            multiple
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (files.length > 0) void addFiles(files);
            }}
          />
          <input
            ref={relinkInputRef}
            type="file"
            className="hidden"
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = '';
              if (files.length > 0) void onRelinkPicked(files);
            }}
          />
          <Button
            variant="secondary"
            size="sm"
            disabled={unavailable || actionLocked}
            loading={busy === 'add'}
            onClick={() => fileInputRef.current?.click()}
          >
            <Plus size={13} strokeWidth={1.75} aria-hidden />
            {t('ccAgent.materials.add')}
          </Button>
        </div>
      </div>

      {loadError && !unavailable ? (
        <ErrorNotice
          message={t('ccAgent.materials.loadFailed')}
          details={loadError instanceof Error ? loadError.message : undefined}
          actions={
            <Button
              variant="secondary"
              size="sm"
              loading={loading}
              onClick={() => void onReload().catch(() => {})}
            >
              {t('ccAgent.materials.retryLoad')}
            </Button>
          }
        />
      ) : (
        <div
          className={cn(
            'relative rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-4',
            dragActive && 'ring-2 ring-[var(--focus-ring)]',
          )}
          onDragEnter={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            dragDepth.current += 1;
            setDragActive(true);
          }}
          onDragOver={(event) => {
            if (!event.dataTransfer.types.includes('Files')) return;
            event.preventDefault();
            event.dataTransfer.dropEffect = 'copy';
          }}
          onDragLeave={() => {
            dragDepth.current = Math.max(0, dragDepth.current - 1);
            if (dragDepth.current === 0) setDragActive(false);
          }}
          onDrop={onDrop}
        >
          {dragActive && (
            <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center rounded-xl bg-[var(--surface-elevated)] text-13 text-[var(--text-primary)]">
              {t('ccAgent.materials.dropActive')}
            </div>
          )}

          {unavailable ? (
            <div className="flex flex-col items-start gap-1 py-6">
              <p className="text-13 font-medium text-[var(--text-primary)]">
                {t('ccAgent.materials.unavailableTitle')}
              </p>
              <p className="max-w-[560px] text-12 leading-normal text-[var(--text-secondary)]">
                {t('ccAgent.materials.unavailableDesc')}
              </p>
            </div>
          ) : loading && materials.length === 0 ? (
            <div className="flex items-center justify-center gap-2 py-10 text-12 text-[var(--text-secondary)]">
              <Spinner size={14} />
              {t('ccAgent.materials.loading')}
            </div>
          ) : active.length === 0 && removed.length === 0 ? (
            <div className="flex flex-col items-center gap-2 px-4 py-10 text-center">
              <ImagePlus
                size={22}
                strokeWidth={1.5}
                className="text-[var(--text-secondary)]"
                aria-hidden
              />
              <p className="text-13 font-medium text-[var(--text-primary)]">
                {t('ccAgent.materials.emptyTitle')}
              </p>
              <p className="max-w-[420px] text-12 leading-normal text-[var(--text-secondary)]">
                {t('ccAgent.materials.emptyDesc')}
              </p>
              <Button
                variant="secondary"
                size="sm"
                className="mt-2"
                disabled={actionLocked}
                onClick={() => fileInputRef.current?.click()}
              >
                <Plus size={13} strokeWidth={1.75} aria-hidden />
                {t('ccAgent.materials.add')}
              </Button>
            </div>
          ) : (
            <ul className="flex flex-col">
              {active.map((material) => (
                <MaterialRow
                  key={material.reference.id}
                  material={material}
                  expanded={expanded.has(material.reference.id)}
                  retrying={
                    typeof busy === 'object' &&
                    busy !== null &&
                    busy.kind === 'retryRead' &&
                    busy.materialId === material.id
                  }
                  onToggleVersions={() => toggleVersions(material.reference.id)}
                  onPreview={(version) =>
                    setPreviewTarget({
                      referenceId: material.reference.id,
                      materialId: material.id,
                      version,
                      name: material.name,
                    })
                  }
                  onRetryRead={() => void retryRead(material)}
                  onRelink={() => relink(material)}
                  writeBlocked={actionLocked}
                  onUseVersion={(version) => void useVersion(material, version)}
                  onRemove={() => setRemoveTarget(material)}
                />
              ))}
            </ul>
          )}

          {removed.length > 0 && (
            <div className="border-t border-[var(--cmd-palette-border)] py-2">
              <Button
                variant="secondary"
                size="xs"
                tone="quiet"
                compact
                aria-expanded={showRemoved}
                onClick={() => setShowRemoved((current) => !current)}
              >
                {showRemoved
                  ? t('ccAgent.materials.hideRemoved')
                  : t('ccAgent.materials.showRemoved', { count: removed.length })}
              </Button>
              {showRemoved && (
                <div>
                  <p className="text-11 text-[var(--text-secondary)]">
                    {t('ccAgent.materials.historyReadOnly')}
                  </p>
                  <ul className="mt-1 flex flex-col">
                    {removed.map((material) => (
                      <MaterialRow
                        key={material.reference.id}
                        material={material}
                        expanded={expanded.has(material.reference.id)}
                        retrying={false}
                        onToggleVersions={() => toggleVersions(material.reference.id)}
                        onPreview={() => undefined}
                        onRetryRead={() => void retryRead(material)}
                        onRelink={() => relink(material)}
                        readOnly
                        onRemove={() => undefined}
                      />
                    ))}
                  </ul>
                </div>
              )}
            </div>
          )}
        </div>
      )}

      <p className="text-11 leading-normal text-[var(--text-secondary)]">
        {t('ccAgent.materials.addHint')}
      </p>

      {pendingConfirmation && (
        <ErrorNotice
          message={t('ccAgent.materials.pendingConfirmation')}
          actions={
            <Button
              variant="secondary"
              size="sm"
              onClick={() =>
                void onReload().then(() => {
                  if (valid()) setPendingConfirmation(false);
                }, handleFailure)
              }
            >
              {t('ccAgent.materials.confirmRefresh')}
            </Button>
          }
        />
      )}
      <Button
        variant="secondary"
        size="xs"
        disabled={loading}
        onClick={() =>
          void service
            .list({ projectId: scope.projectId, workItemId: scope.workItemId, history: true })
            .then(
              (result) => {
                if (valid()) {
                  setHistory(result.materials);
                  setShowRemoved(true);
                  setHistoryError(null);
                }
              },
              (error) => {
                if (valid()) {
                  setHistoryError(error);
                  handleFailure(error);
                }
              },
            )
        }
      >
        {t('ccAgent.materials.referenceHistory')}
      </Button>
      {!!historyError && <p role="alert">{t(materialErrorKey(materialErrorCode(historyError)))}</p>}
      {(duplicates.length > 0 || rejected.length > 0) && (
        <div className="flex flex-col gap-1 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
          {duplicates.map((duplicate, index) => (
            <div
              key={`duplicate-${duplicate.materialId}-${duplicate.version}-${index}`}
              role="status"
              className="flex min-w-0 items-center gap-2 text-11 text-[var(--text-secondary)]"
            >
              <Paperclip size={12} strokeWidth={1.75} aria-hidden />
              <span className="min-w-0 break-words">
                {t('ccAgent.materials.duplicateNotice', {
                  name: duplicate.name,
                  version: duplicate.version,
                })}
              </span>
              <button
                type="button"
                className="ml-auto shrink-0 rounded-full p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-label={t('ccAgent.materials.dismiss')}
                onClick={() =>
                  setDuplicates((current) =>
                    current.filter((_entry, position) => position !== index),
                  )
                }
              >
                <X size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ))}
          {rejected.map((item, index) => (
            <div
              key={`rejected-${item.name}-${index}`}
              role="alert"
              className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11"
            >
              <span className="min-w-0 break-words text-[var(--text-primary)]">{item.name}</span>
              <span className="min-w-0 break-words text-[var(--error-fg)]">
                {t(item.notSubmitted ? 'ccAgent.materials.addedNone' : materialErrorKey(item.code))}
              </span>
              {item.path && item.retryable !== false && (
                <Button
                  variant="secondary"
                  size="xs"
                  tone="quiet"
                  compact
                  loading={
                    typeof busy === 'object' &&
                    busy !== null &&
                    busy.kind === 'retryRejected' &&
                    busy.index === index
                  }
                  disabled={actionLocked}
                  onClick={() => void retryRejected(item, index)}
                >
                  {t('ccAgent.materials.retryAdd')}
                </Button>
              )}
              <button
                type="button"
                className="ml-auto shrink-0 rounded-full p-0.5 text-[var(--text-secondary)] hover:text-[var(--text-primary)] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]"
                aria-label={t('ccAgent.materials.dismiss')}
                onClick={() =>
                  setRejected((current) => current.filter((_entry, position) => position !== index))
                }
              >
                <X size={12} strokeWidth={1.75} aria-hidden />
              </button>
            </div>
          ))}
        </div>
      )}

      <ConfirmDialog
        open={conflicts.length > 0}
        onOpenChange={(next) => {
          // Radix Action closes synchronously, before the busy state rerenders.
          if (!next && !busyRef.current) cancelConflict();
        }}
        maxWidth={460}
        title={t('ccAgent.materials.conflict.title')}
        description={
          conflicts[0]
            ? t('ccAgent.materials.conflict.desc', {
                name: conflicts[0].file.name,
                existing: conflicts[0].material.name,
                version: currentVersionNumber(conflicts[0].material),
              })
            : undefined
        }
        content={
          conflicts.length > 1 ? (
            <p className="text-12 text-[var(--text-secondary)]">
              {t('ccAgent.materials.conflict.pending', { count: conflicts.length - 1 })}
            </p>
          ) : undefined
        }
        confirmText={t('ccAgent.materials.conflict.newVersion')}
        tertiaryText={t('ccAgent.materials.conflict.newMaterial')}
        cancelText={t('ccAgent.materials.conflict.cancel')}
        loading={busy === 'conflict'}
        onConfirm={() => void resolveConflict('version')}
        onTertiary={() => void resolveConflict('newMaterial')}
      />

      <ConfirmDialog
        open={removeTarget !== null}
        onOpenChange={(next) => {
          if (!next && busy !== 'remove') setRemoveTarget(null);
        }}
        maxWidth={420}
        title={t('ccAgent.materials.removeConfirmTitle', { name: removeTarget?.name ?? '' })}
        description={t('ccAgent.materials.removeConfirmDesc')}
        confirmText={t('ccAgent.materials.removeConfirmAction')}
        cancelText={t('ccAgent.materials.cancel')}
        loading={busy === 'remove'}
        onConfirm={() => void confirmRemove()}
        onCancel={() => setRemoveTarget(null)}
      />

      <MaterialPreviewDialog
        target={previewTarget}
        service={service}
        scope={scope}
        onInvalidate={onInvalidate}
        onClose={() => setPreviewTarget(null)}
        onOpenInApp={(path, name) => setInAppFile({ path, name })}
      />

      {inAppFile && (
        // 非媒体材料交给宿主既有的应用内查看器（预览通道给的 xdt-file 地址 → 路径）。
        <FileLightbox
          filePath={inAppFile.path}
          fileName={inAppFile.name}
          onClose={() => setInAppFile(null)}
        />
      )}
    </section>
  );
}
