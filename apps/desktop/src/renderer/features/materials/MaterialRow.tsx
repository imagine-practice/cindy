/**
 * MaterialRow — 一条材料：名称、类型、大小、当前版本、读取状态与行内操作。
 *
 * 读状态是**真实状态**，不是装饰：`pending` 不会被写成「已读」，`failed` 才显示原因与重试
 * （契约 R2/R7）。版本历史在行内展开，当前版本永远带标记，避免把旧版本当成现在生效的引用。
 */
import {
  ChevronDown,
  ChevronRight,
  File,
  FileText,
  Image as ImageIcon,
  type LucideIcon,
} from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { formatBytes } from '@/features/cc-agent/workdir-browse/lib/fileMeta';
import { cn } from '@/lib/utils';
import {
  currentVersionNumber,
  currentVersionOf,
  formatMaterialTime,
  materialFailureReason,
  materialReadState,
  readStateLabelKey,
  sourceIssueKey,
  versionHistory,
  type Material,
  type MaterialReadState,
} from './materialReferenceView';

export interface MaterialRowProps {
  material: Material;
  readOnly?: boolean;
  writeBlocked?: boolean;
  onUseVersion?: (version: number) => void;
  expanded: boolean;
  retrying: boolean;
  onToggleVersions: () => void;
  onPreview: (version: number) => void;
  onRetryRead: () => void;
  /** 原文件被改动/删除后重新指向一个文件（追加为该材料的新版本）。 */
  onRelink: () => void;
  onRemove: () => void;
}

export function MaterialRow({
  material,
  readOnly,
  writeBlocked,
  onUseVersion,
  expanded,
  retrying,
  onToggleVersions,
  onPreview,
  onRetryRead,
  onRelink,
  onRemove,
}: MaterialRowProps): React.ReactElement {
  const { t } = useTranslation();
  const currentVersion = currentVersionOf(material);
  const readState = materialReadState(material);
  const failureReason = materialFailureReason(material);
  const issueKey = sourceIssueKey(failureReason);
  const fileBacked = currentVersion?.storageKind === 'file';
  const versionNumber = currentVersionNumber(material);
  const versions = versionHistory(material);
  const removed = material.reference.status === 'removed';
  const locked = removed || readOnly;
  const historyId = `material-versions-${material.reference.id}`;
  const Icon = iconForMime(currentVersion?.mime ?? '');
  const typeLabel = typeLabelFor(material.name, currentVersion?.mime ?? '');
  const sizeLabel = currentVersion ? formatBytes(currentVersion.sizeBytes) : null;

  return (
    <li className="border-b border-[var(--cmd-palette-border)] last:border-b-0">
      <div className="flex flex-wrap items-start gap-3 py-2.5">
        <span
          className="mt-0.5 flex size-8 shrink-0 items-center justify-center rounded-lg bg-[var(--surface-chip)] text-[var(--text-secondary)]"
          aria-hidden
        >
          <Icon size={15} strokeWidth={1.75} />
        </span>

        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className={cn(
                'min-w-0 truncate text-13',
                removed ? 'text-[var(--text-tertiary)]' : 'text-[var(--text-primary)]',
              )}
              title={material.name}
            >
              {material.name}
            </span>
            {removed && (
              <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 text-11 leading-none text-[var(--text-secondary)]">
                {t('ccAgent.materials.removedBadge')}
              </span>
            )}
          </div>

          <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11 text-[var(--text-secondary)]">
            <span>{typeLabel}</span>
            {sizeLabel && <span aria-hidden>·</span>}
            {sizeLabel && <span>{sizeLabel}</span>}
            {versionNumber > 0 && (
              <span className="rounded-full bg-[var(--surface-chip)] px-1.5 py-0.5 leading-none text-[var(--text-secondary)]">
                {t('ccAgent.materials.versionShort', { version: versionNumber })}
              </span>
            )}
            {material.latestVersion !== versionNumber && (
              <span>
                {t('ccAgent.materials.latestVersion', { version: material.latestVersion })}
              </span>
            )}
            {fileBacked && (
              <span className="leading-none text-[var(--text-tertiary)]">
                {t('ccAgent.materials.storageFile')}
              </span>
            )}
            <ReadStateLabel state={readState} />
            <FailureNote reason={failureReason} />
          </div>
        </div>

        <div className="flex w-full flex-wrap items-center gap-1 pl-11 sm:w-auto sm:justify-end sm:pl-0">
          <Button
            variant="secondary"
            size="xs"
            tone="quiet"
            compact
            aria-expanded={expanded}
            aria-controls={historyId}
            onClick={onToggleVersions}
          >
            {expanded ? (
              <ChevronDown size={13} strokeWidth={1.75} aria-hidden />
            ) : (
              <ChevronRight size={13} strokeWidth={1.75} aria-hidden />
            )}
            {t('ccAgent.materials.versionHistory', { count: versions.length })}
          </Button>
          {!readOnly && currentVersion && readState === 'ready' && (
            <Button
              variant="secondary"
              size="xs"
              tone="quiet"
              compact
              onClick={() => onPreview(currentVersion.version)}
            >
              {t('ccAgent.materials.preview')}
            </Button>
          )}
          {!locked && readState === 'failed' && !issueKey && (
            <Button
              variant="secondary"
              size="xs"
              tone="quiet"
              compact
              disabled={writeBlocked}
              loading={retrying}
              onClick={onRetryRead}
            >
              {t('ccAgent.materials.retryRead')}
            </Button>
          )}
          {!locked && issueKey && (
            // 重试对「原文件变了/没了」没有意义；只有重新关联才能修好（0.1）。
            <Button
              variant="secondary"
              size="xs"
              tone="quiet"
              compact
              disabled={writeBlocked}
              onClick={onRelink}
            >
              {t('ccAgent.materials.relink')}
            </Button>
          )}
          {!locked && (
            <Button
              variant="secondary"
              size="xs"
              tone="danger"
              compact
              disabled={writeBlocked}
              onClick={onRemove}
            >
              {t('ccAgent.materials.removeReference')}
            </Button>
          )}
        </div>
      </div>

      {expanded && (
        <div id={historyId} className="mb-3 ml-11 rounded-lg bg-[var(--surface-chip)] px-3 py-2">
          {removed && (
            <p className="mb-2 text-11 leading-normal text-[var(--text-secondary)]">
              {t('ccAgent.materials.removedNote')}
            </p>
          )}
          <ul className="flex flex-col gap-1">
            {versions.map((version) => (
              <li
                key={`${version.id || version.version}`}
                className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 text-11 text-[var(--text-secondary)]"
              >
                <span className="shrink-0 font-medium text-[var(--text-primary)]">
                  {t('ccAgent.materials.versionShort', { version: version.version })}
                </span>
                {version.version === versionNumber && (
                  <span className="shrink-0 rounded-full bg-[var(--surface-elevated)] px-1.5 py-0.5 leading-none text-[var(--text-secondary)]">
                    {t('ccAgent.materials.currentVersionBadge')}
                  </span>
                )}
                <span>{formatBytes(version.sizeBytes)}</span>
                <ReadStateLabel state={version.readState} />
                {version.readState === 'failed' && <FailureNote reason={version.failureReason} />}
                {!locked && version.version !== versionNumber && (
                  <Button
                    variant="secondary"
                    size="xs"
                    compact
                    disabled={writeBlocked}
                    onClick={() => onUseVersion?.(version.version)}
                  >
                    {t('ccAgent.materials.useVersion')}
                  </Button>
                )}
                <span className="ml-auto shrink-0">{formatMaterialTime(version.createdAt)}</span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </li>
  );
}

/**
 * 失败原因：原文件被改动/删除是「需要重新关联」而不是普通解析失败，
 * 用专用文案说清，不拿「读取失败」笼统覆盖（契约 0.1）。
 */
function FailureNote({ reason }: { reason: string | null }): React.ReactElement | null {
  const { t } = useTranslation();
  if (!reason) return null;
  const issue = sourceIssueKey(reason);
  return (
    <span className="min-w-0 break-words text-[var(--error-fg)]">
      {issue ? t(issue) : t('ccAgent.materials.failureReason', { reason })}
    </span>
  );
}

/** 读状态文字本身就是语义；颜色只做辅助，不用颜色单独表达状态。 */
function ReadStateLabel({ state }: { state: MaterialReadState }): React.ReactElement {
  const { t } = useTranslation();
  return (
    <span
      className={cn(
        'rounded-full px-1.5 py-0.5 leading-none',
        state === 'failed'
          ? 'bg-[var(--error-bg)] text-[var(--error-fg)]'
          : 'bg-[var(--surface-chip)] text-[var(--text-secondary)]',
      )}
    >
      {t(readStateLabelKey(state))}
    </span>
  );
}

function iconForMime(mime: string): LucideIcon {
  if (mime.startsWith('image/')) return ImageIcon;
  if (mime.startsWith('text/') || mime.includes('json') || mime.includes('xml')) return FileText;
  return File;
}

/** 「类型」是展示信息：有扩展名就用扩展名，没有才回落到 mime 子类型。 */
export function typeLabelFor(name: string, mime: string): string {
  const dot = name.lastIndexOf('.');
  if (dot > 0 && dot < name.length - 1) return name.slice(dot + 1).toUpperCase();
  const slash = mime.indexOf('/');
  if (slash > 0) return mime.slice(slash + 1).toUpperCase();
  return '—';
}
