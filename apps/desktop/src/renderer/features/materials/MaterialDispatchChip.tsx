/**
 * Composer chip for the material context that will ride with the next send.
 *
 * It shows exactly what Main already holds (pinned context + versions) and nothing else:
 * no preparation result, no consumption claim. A stale mount states why it cannot be sent.
 */
import { Layers, X } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { purposeLabelKey } from './materialReferenceView';
import {
  type MaterialDispatchMount,
  type MaterialDispatchSendRejection,
} from './materialDispatchMount';
import { materialDispatchRejectionKey } from './materialDispatchRejection';

export { materialDispatchRejectionKey, type MaterialDispatchRejectionI18nKey } from './materialDispatchRejection';

export interface MaterialDispatchChipProps {
  mount: MaterialDispatchMount;
  /** Set only after a real pre-send read rejected the mount. */
  blocked?: MaterialDispatchSendRejection | null;
  onRemove: () => void;
}

export function MaterialDispatchChip({
  mount,
  blocked = null,
  onRemove,
}: MaterialDispatchChipProps): React.ReactElement {
  const { t } = useTranslation();
  const visible = mount.refs.slice(0, 2);
  const hidden = mount.refs.length - visible.length;
  return (
    <div
      className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1 rounded-xl border border-[var(--border-default)] bg-[var(--surface-elevated)] px-2.5 py-1.5"
      data-material-dispatch-chip={mount.selector.contextId}
    >
      <Layers size={13} strokeWidth={1.75} className="shrink-0 text-[var(--text-secondary)]" aria-hidden />
      <span className="text-12 text-[var(--text-primary)]">
        {t('ccAgent.materials.dispatch.attached')}
      </span>
      <span className="text-11 text-[var(--text-secondary)]">
        {t(purposeLabelKey(mount.purpose))}
      </span>
      {visible.map((ref) => (
        <span
          key={`${ref.name}-${ref.version}`}
          title={ref.name}
          className="min-w-0 max-w-[180px] truncate rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-none text-[var(--text-primary)]"
        >
          {ref.name}
          {' · '}
          {t('ccAgent.materials.versionShort', { version: ref.version })}
        </span>
      ))}
      {hidden > 0 && (
        <span className="text-11 text-[var(--text-secondary)]">
          {t('ccAgent.materials.dispatch.moreRefs', { count: hidden })}
        </span>
      )}
      {blocked && (
        <span className="text-11 text-[var(--warning-fg)]">{t(materialDispatchRejectionKey(blocked))}</span>
      )}
      <span className="ml-auto text-11 text-[var(--text-secondary)]">
        {t('ccAgent.materials.dispatch.once')}
      </span>
      <Button
        variant="secondary"
        tone="quiet"
        size="xs"
        compact
        aria-label={t('ccAgent.materials.dispatch.remove')}
        onClick={onRemove}
      >
        <X size={12} strokeWidth={2} aria-hidden />
      </Button>
    </div>
  );
}
