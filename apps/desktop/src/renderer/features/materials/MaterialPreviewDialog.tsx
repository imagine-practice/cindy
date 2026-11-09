/**
 * MaterialPreviewDialog — 材料预览（契约 §3 `materials:preview`）。
 *
 * 三态都是真实结果，不互相冒充：
 *   - `image`：用服务层给的 url 真解码；拿不到 url 就报错，不放占位图冒充成功。
 *   - `text`：显示服务层返回的真实正文，可选中复制。
 *   - `unsupported`：PDF 有受控来源时交给既有 PdfPreview；其他类型明确不支持正文。
 *
 * 预览是媒体查看器而不是表单：点遮罩、Esc、右上角 × 都能关（DESIGN.md §4 Dialog & Modal
 * 对媒体查看器的例外），不存在「未保存内容被误关」的风险。
 */
import { lazy, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { FileQuestion, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { isProtectedMaterialUrl, protectedPdfSource } from './protectedPreviewBytes';
import { Button } from '@/components/ui/button';
import { Spinner } from '@/components/ui/spinner';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { cn } from '@/lib/utils';
import { materialErrorKey, type MaterialPreviewPayload } from './materialReferenceView';
import {
  materialErrorCode,
  materialSourceIssue,
  isScopeInvalidation,
  type MaterialScope,
  type MaterialReferenceService,
} from './materialReferenceView';

const PdfPreview = lazy(() => import('@/features/cc-agent/workdir-browse/PdfPreview').then(module => ({ default: module.PdfPreview })));

export type PreviewTarget = (
  { referenceId: string; contextId?: never } | { contextId: string; referenceId?: never }
) & {
  materialId: string;
  version: number;
  name: string;
};

export interface PreviewFailure {
  /** 通用错误文案 key。 */
  errorKey: string;
  /** 原文件已改/已删时的专用说明 key；普通失败为 null。 */
  sourceIssueKey: string | null;
}

export interface MaterialPreviewDialogProps {
  service: MaterialReferenceService;
  scope: MaterialScope;
  onInvalidate: (error: unknown) => void;
  target: PreviewTarget | null;
  onClose: () => void;
  /** Legacy callback retained for caller compatibility; protected PDFs stay in this dialog. */
  onOpenInApp: (filePath: string, name: string) => void;
  /** 源文件变更被记成新版本后通知外层刷新列表（版本号变了）。 */
  onVersionRecorded?: () => void;
}

type PreviewState =
  | { status: 'loading' }
  | { status: 'ready'; payload: MaterialPreviewPayload }
  | { status: 'failed'; failure: PreviewFailure };

export function MaterialPreviewDialog(props: MaterialPreviewDialogProps): React.ReactElement {
  const ownerGeneration = useOptionalDataOwnerGeneration();
  const key = JSON.stringify([ownerGeneration, props.scope.projectId, props.scope.workItemId,
    props.scope.bindingRevision, props.target]);
  return <MaterialPreviewContent key={key} {...props} />;
}

function MaterialPreviewContent({
  target,
  service,
  scope,
  onInvalidate,
  onClose,
  onVersionRecorded,
}: MaterialPreviewDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const titleId = useId();
  const [state, setState] = useState<PreviewState>({ status: 'loading' });
  const [reloadToken, setReloadToken] = useState(0);
  const [recording, setRecording] = useState(false);
  const [recordError, setRecordError] = useState<string | null>(null);
  /** 记录新版本后，预览要跟着落到新版本上，而不是继续盯着已过期的旧版本。 */
  const [recordedVersion, setRecordedVersion] = useState<number | null>(null);
  const [pdfOpen, setPdfOpen] = useState(false);
  const [imageFailed, setImageFailed] = useState(false);
  const requestSeq = useRef(0);
  const trigger = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!target) return;
    const seq = ++requestSeq.current;
    const generation = recordedVersion === null ? target : { ...target, version: recordedVersion };
    setState({ status: 'loading' });
    setPdfOpen(false);
    setImageFailed(false);
    void service
      .preview(
        generation.contextId
          ? {
              contextId: generation.contextId,
              materialId: generation.materialId,
              version: generation.version,
            }
          : {
              ...scope,
              referenceId: generation.referenceId!,
              materialId: generation.materialId,
              version: generation.version,
            },
      )
      .then(
        (payload) => {
          if (requestSeq.current !== seq) return;
          setState({ status: 'ready', payload });
        },
        (error: unknown) => {
          if (requestSeq.current !== seq) return;
          if (isScopeInvalidation(error)) {
            onInvalidate(error);
            return;
          }
          const issue = materialSourceIssue(error);
          setState({
            status: 'failed',
            failure: {
              errorKey: materialErrorKey(materialErrorCode(error)),
              sourceIssueKey:
                issue === 'SOURCE_CHANGED'
                  ? 'ccAgent.materials.sourceChanged'
                  : issue === 'SOURCE_MISSING'
                    ? 'ccAgent.materials.sourceMissing'
                    : null,
            },
          });
        },
      );
    return () => {
      // 关闭或换目标后，迟到的响应不再落盘到界面。
      requestSeq.current += 1;
    };
  }, [target, service, reloadToken, recordedVersion]);

  const readyPayload = state.status === 'ready' ? state.payload : null;
  const pdfUrl = readyPayload?.mime === 'application/pdf' && isProtectedMaterialUrl(readyPayload.url) ? readyPayload.url : null;
  const pdfSource = useMemo(() => pdfUrl ? protectedPdfSource(pdfUrl) : undefined, [pdfUrl]);
  if (!target) return <></>;

  const payload = state.status === 'ready' ? state.payload : null;
  const meta = payload
    ? [payload.mime || null, payload.size > 0 ? formatBytes(payload.size) : null]
    : [];


  return (
    <Dialog.Root open onOpenChange={(next) => !next && onClose()}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" onClick={onClose} />
        <Dialog.Content
          onOpenAutoFocus={() => {
            trigger.current = document.activeElement as HTMLElement;
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (trigger.current?.isConnected) trigger.current.focus();
          }}
          // 预览窗自己铺满可用区域，点内容不关闭；点遮罩关闭由 Overlay 负责。
          onClick={(event) => event.stopPropagation()}
          className="modal-panel fixed inset-4 z-[71] m-auto flex h-fit max-h-[calc(100vh-32px)] w-fit max-w-[min(1100px,calc(100vw-32px))] flex-col p-4 outline-none"
          aria-labelledby={titleId}
          aria-describedby={undefined}
        >
          <div className="flex shrink-0 items-start gap-3">
            <div className="min-w-0 flex-1">
              <Dialog.Title
                title={target.name}
                id={titleId}
                className="truncate text-14 font-medium text-[var(--msg-assistant-text)]"
              >
                {target.name}
              </Dialog.Title>
              <p className="mt-1 text-11 text-[var(--text-secondary)]">
                {t('ccAgent.materials.versionShort', { version: target.version })}
                {meta.length > 0 && ` · ${meta.filter(Boolean).join(' · ')}`}
              </p>
            </div>
            <Button
              variant="secondary"
              size="sm"
              tone="quiet"
              compact
              aria-label={t('ccAgent.materials.previewClose')}
              onClick={onClose}
            >
              <X size={14} strokeWidth={1.75} aria-hidden />
            </Button>
          </div>

          <div className="mt-3 flex min-h-[120px] min-w-0 flex-col">
            {pdfOpen && pdfSource && payload && <div className="h-[calc(100vh-200px)] min-h-[200px] w-[min(960px,calc(100vw-64px))] min-w-0 overflow-hidden">
              <Suspense fallback={<Spinner size={14} />}><PdfPreview source={pdfSource} name={target.name} size={payload.size} mtimeMs={0} /></Suspense>
            </div>}
            {state.status === 'loading' && (
              <div className="flex items-center justify-center gap-2 py-10 text-12 text-[var(--text-secondary)]">
                <Spinner size={14} />
                {t('ccAgent.materials.previewLoading')}
              </div>
            )}
            {state.status === 'failed' && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <FileQuestion
                  size={22}
                  strokeWidth={1.5}
                  className="text-[var(--text-secondary)]"
                  aria-hidden
                />
                <p className="text-13 text-[var(--error-fg)]">
                  {t(state.failure.sourceIssueKey ?? state.failure.errorKey)}
                </p>
                {state.failure.sourceIssueKey ? (
                  <>
                    <p className="max-w-[420px] text-11 leading-normal text-[var(--text-secondary)]">
                      {t('ccAgent.materials.relinkHint')}
                    </p>
                    {state.failure.sourceIssueKey === 'ccAgent.materials.sourceChanged' &&
                      target?.referenceId && (
                        <Button
                          variant="primary"
                          size="sm"
                          loading={recording}
                          disabled={recording}
                          onClick={() => {
                            void (async () => {
                              if (!target.referenceId) return;
                              setRecording(true);
                              setRecordError(null);
                              try {
                                const recorded = await service.recordSourceVersion({
                                  referenceId: target.referenceId,
                                  materialId: target.materialId,
                                });
                                // 切到刚记录的新版本再重新加载；否则旧版本仍会报“原文件已修改”。
                                setRecordedVersion(recorded.version);
                                setReloadToken((value) => value + 1);
                                onVersionRecorded?.();
                              } catch (error) {
                                // 失败必须说出来：静默失败会让人以为已经记了新版本。
                                setRecordError(t(materialErrorKey(materialErrorCode(error))));
                              } finally {
                                setRecording(false);
                              }
                            })();
                          }}
                        >
                          {t('ccAgent.materials.recordVersion')}
                        </Button>
                      )}
                    {recordError && (
                      <p className="text-11 text-[var(--error-fg)]">{recordError}</p>
                    )}
                  </>
                ) : (
                  <p className="text-11 text-[var(--text-secondary)]">
                    {t('ccAgent.materials.previewFailedHint')}
                  </p>
                )}
              </div>
            )}
            {payload?.kind === 'image' &&
              (payload.url && !imageFailed ? (
                <img
                  key={payload.url}
                  onError={() => setImageFailed(true)}
                  src={payload.url}
                  alt={target.name}
                  className="max-h-[calc(100vh-220px)] max-w-full self-center rounded-lg object-contain"
                  draggable={false}
                />
              ) : (
                // 契约给了 image 却没给地址：如实报错，不用破图或占位图冒充。
                <div className="flex flex-col items-center gap-2 py-10 text-center">
                  <FileQuestion
                    size={22}
                    strokeWidth={1.5}
                    className="text-[var(--text-secondary)]"
                    aria-hidden
                  />
                  <p className="text-13 text-[var(--error-fg)]">
                    {t(imageFailed ? 'ccAgent.materials.error.notReadable' : 'ccAgent.materials.previewImageMissing')}
                  </p>
                </div>
              ))}
            {payload?.kind === 'text' && (
              <pre
                className={cn(
                  'max-h-[calc(100vh-220px)] w-[min(880px,calc(100vw-96px))] overflow-auto',
                  'whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-chip)] p-3',
                  'font-mono text-12 leading-normal text-[var(--text-primary)] select-text',
                )}
              >
                {payload.text ?? ''}
              </pre>
            )}
            {payload?.kind === 'unsupported' && !pdfOpen && (
              <div className="flex flex-col items-center gap-2 py-10 text-center">
                <FileQuestion
                  size={22}
                  strokeWidth={1.5}
                  className="text-[var(--text-secondary)]"
                  aria-hidden
                />
                {!pdfSource && <p className="text-13 font-medium text-[var(--text-primary)]">
                  {t('ccAgent.materials.previewUnsupportedTitle')}
                </p>}
                {!pdfSource && <p className="max-w-[420px] text-11 leading-normal text-[var(--text-secondary)]">
                  {t('ccAgent.materials.previewUnsupportedDesc')}
                </p>}
                {pdfSource && (
                  <Button
                    variant="secondary"
                    size="sm"
                    className="mt-2"
                    onClick={() => setPdfOpen(true)}
                  >
                    {t('ccAgent.materials.previewOpenInApp')}
                  </Button>
                )}
              </div>
            )}
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
