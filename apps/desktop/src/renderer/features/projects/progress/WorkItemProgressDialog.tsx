import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { allowedWorkItemTransitions, isWorkItemStatus, WORK_ITEM_STATUSES, type WorkItemStatus } from '../../../../shared/workItemStatus';
import type { WorkItemProgressIntent, WorkItemProgressResult, WorkItemProgressErrorCode } from '../../../../shared/workItemProgress';

/** An already-authorized read snapshot. Booleans are UI hints, never trusted actor/role inputs. */
export interface WorkItemProgressSnapshot {
  projectId: string;
  sessionId: string;
  title: string;
  bindingRevision: number;
  progressRevision: number;
  status: WorkItemStatus | null;
  reason?: string | null;
  unblockCondition?: string | null;
  canRecord: boolean;
  canConfirmDone: boolean;
}
export interface WorkItemProgressDialogProps {
  open: boolean;
  onOpenChange(open: boolean): void;
  snapshot: WorkItemProgressSnapshot;
  onSubmit(intent: WorkItemProgressIntent): Promise<WorkItemProgressResult>;
  onRefresh(): void;
  onSaved(result: WorkItemProgressResult): void;
}

export function WorkItemProgressDialog(props: WorkItemProgressDialogProps): React.ReactElement | null {
  const generation = useOptionalDataOwnerGeneration();
  const open = useRef(false);
  const trigger = useRef<HTMLElement | null>(null);
  if (props.open && !open.current) trigger.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  open.current = props.open;
  useEffect(() => { open.current = props.open; return () => { open.current = false; }; }, [props.open]);
  // Closing, authority changes and binding/revision changes discard local write intent immediately.
  return props.open ? <ProgressScope key={JSON.stringify([props.snapshot, generation, getDataOwnerGeneration()])} {...props}
    restoreFocus={() => { if (!open.current && trigger.current?.isConnected) trigger.current.focus(); }} /> : null;
}

const errorCodes: readonly WorkItemProgressErrorCode[] = [
  'INVALID_PARAMS', 'FORBIDDEN', 'NOT_FOUND', 'PROJECT_MISMATCH', 'SESSION_DELETED',
  'BINDING_CONFLICT', 'REVISION_CONFLICT', 'REQUEST_CONFLICT', 'REASON_REQUIRED',
  'UNBLOCK_CONDITION_REQUIRED', 'RESOLUTION_REQUIRED', 'COMPLETION_NOTE_REQUIRED', 'ILLEGAL_TRANSITION',
];
function errorCode(error: unknown): WorkItemProgressErrorCode | null {
  const raw = error as { code?: unknown; message?: unknown } | null;
  const code = typeof raw?.code === 'string' ? raw.code
    : typeof raw?.message === 'string' ? /^\[([A-Z_]+)\]/.exec(raw.message)?.[1] : null;
  return errorCodes.includes(code as WorkItemProgressErrorCode) ? code as WorkItemProgressErrorCode : null;
}

function requestId(): string {
  if (typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  // getRandomValues also works in non-secure preview origins; the contract accepts opaque IDs.
  return `progress-${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
}

function ProgressScope({ snapshot, onOpenChange, onSubmit, onRefresh, onSaved, restoreFocus }: WorkItemProgressDialogProps & { restoreFocus(): void }): React.ReactElement {
  const { t } = useTranslation();
  const tr = (key: string): string => t(`ccAgent.projectCore.progressEdit.${key}`);
  const [to, setTo] = useState<WorkItemStatus | ''>(snapshot.status === 'done' && !snapshot.canConfirmDone ? '' : snapshot.status ?? '');
  const [reason, setReason] = useState(snapshot.reason ?? '');
  const [condition, setCondition] = useState(snapshot.unblockCondition ?? '');
  const [resolution, setResolution] = useState('');
  const [note, setNote] = useState('');
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [locked, setLocked] = useState(false);
  const [hidden, setHidden] = useState(!snapshot.canRecord);
  const [uncertain, setUncertain] = useState(false);
  const mounted = useRef(false);
  const busyRef = useRef(false);
  const owner = useRef(getDataOwnerGeneration());
  const last = useRef<{ fingerprint: string; intent: WorkItemProgressIntent } | null>(null);
  const firstControl = useRef<HTMLButtonElement>(null);
  const content = useRef<HTMLDivElement>(null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const valid = (): boolean => mounted.current && isDataOwnerGenerationCurrent(owner.current);
  const allowed = snapshot.status === null ? WORK_ITEM_STATUSES
    : [snapshot.status, ...allowedWorkItemTransitions(snapshot.status)];
  const options = allowed.filter(status => status !== 'done' || snapshot.canConfirmDone);
  const disabled = busy || locked || hidden;
  const edit = (): void => { setError(null); setUncertain(false); };

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (!valid() || busyRef.current || locked || hidden) return;
    if (!isWorkItemStatus(to) || !options.includes(to)) { setError('chooseStatus'); return; }
    const clean = { reason: reason.trim(), unblockCondition: condition.trim(), resolution: resolution.trim(), completionNote: note.trim() };
    if (Object.values(clean).some(value => value.length > 4000)) { setError('tooLong'); return; }
    if (to === 'blocked' && !clean.reason) { setError('REASON_REQUIRED'); return; }
    if (to === 'blocked' && !clean.unblockCondition) { setError('UNBLOCK_CONDITION_REQUIRED'); return; }
    if (snapshot.status === 'blocked' && to !== 'blocked' && !clean.resolution) { setError('RESOLUTION_REQUIRED'); return; }
    if (to === 'done' && !clean.completionNote) { setError('COMPLETION_NOTE_REQUIRED'); return; }
    if (to === 'done' && !confirmed) { setError('confirmRequired'); return; }
    const body: Omit<WorkItemProgressIntent, 'requestId'> = {
      projectId: snapshot.projectId, sessionId: snapshot.sessionId,
      expectedRevision: snapshot.progressRevision, expectedBindingRevision: snapshot.bindingRevision, to,
      ...(to === 'blocked' ? { reason: clean.reason, unblockCondition: clean.unblockCondition } : {}),
      ...(snapshot.status === 'blocked' && to !== 'blocked' ? { resolution: clean.resolution } : {}),
      ...(to === 'done' ? { completionNote: clean.completionNote } : {}),
    };
    const fingerprint = JSON.stringify(body);
    const intent = last.current?.fingerprint === fingerprint ? last.current.intent
      : { ...body, requestId: requestId() };
    last.current = { fingerprint, intent };
    busyRef.current = true; setBusy(true); setError(null);
    let result: WorkItemProgressResult;
    try {
      result = await onSubmit({ ...intent });
    } catch (failure: unknown) {
      if (!valid()) return;
      const code = errorCode(failure);
      setError(code ?? 'uncertain'); setUncertain(code === null);
      if (['FORBIDDEN', 'NOT_FOUND', 'PROJECT_MISMATCH', 'SESSION_DELETED'].includes(code ?? '')) {
        setHidden(true); setLocked(true);
      } else if (['BINDING_CONFLICT', 'REVISION_CONFLICT', 'REQUEST_CONFLICT'].includes(code ?? '')) setLocked(true);
      return;
    } finally {
      if (valid()) { busyRef.current = false; setBusy(false); }
    }
    if (!valid()) return;
    if (result.record.projectId !== intent.projectId || result.record.sessionId !== intent.sessionId
      || result.record.bindingRevision !== intent.expectedBindingRevision) {
      setLocked(true); setError('stale'); return;
    }
    onSaved(result); onRefresh(); onOpenChange(false);
  };

  return <Dialog.Root open onOpenChange={onOpenChange}>
    <Dialog.Portal>
      <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
      <Dialog.Content ref={content} className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col p-4 outline-none"
        onPointerDownOutside={event => event.preventDefault()}
        onOpenAutoFocus={event => { event.preventDefault(); (content.current?.querySelector<HTMLElement>('[role="combobox"]:not([disabled]), textarea:not([disabled]), input:not([disabled])') ?? firstControl.current)?.focus(); }}
        onCloseAutoFocus={event => { event.preventDefault(); restoreFocus(); }}
        onEscapeKeyDown={event => { if (event.isComposing) event.preventDefault(); }}>
        <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{tr('title')}</Dialog.Title>
        <Dialog.Description className="mt-2 text-12 text-[var(--text-secondary)]">{tr('meaning')}</Dialog.Description>
        <form onSubmit={event => void submit(event)} className="mt-4 flex min-h-0 flex-col gap-4" noValidate>
          <div className="flex min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-1">
            {!hidden && <>
              <p className="break-words text-13 text-[var(--text-primary)]">{snapshot.title}</p>
              <p className="text-12 text-[var(--text-secondary)]">{tr('current')}: {tr(`status.${snapshot.status ?? 'unknown'}`)}</p>
              {snapshot.status === 'blocked' && <dl className="break-words text-12 text-[var(--text-secondary)]">
                <dt>{tr('reason')}</dt><dd className="whitespace-pre-wrap">{snapshot.reason || tr('missing')}</dd>
                <dt>{tr('condition')}</dt><dd className="whitespace-pre-wrap">{snapshot.unblockCondition || tr('missing')}</dd>
              </dl>}
              <FormField label={tr('target')} required error={error === 'chooseStatus' ? tr('error.chooseStatus') : undefined}>
                {control => <Select {...control} label={tr('target')} value={to} disabled={disabled}
                  options={[...(snapshot.status === null || (snapshot.status === 'done' && !snapshot.canConfirmDone) ? [{ value: '', label: tr('chooseStatus'), disabled: true }] : []),
                    ...options.map(value => ({ value, label: tr(`status.${value}`) }))]}
                  onValueChange={value => { if (isWorkItemStatus(value) && options.includes(value)) { setTo(value); setConfirmed(false); edit(); } }} />}
              </FormField>
              {(['reason', 'condition', 'resolution', 'note'] as const).filter(field =>
                (to === 'blocked' && (field === 'reason' || field === 'condition'))
                || (snapshot.status === 'blocked' && to !== 'blocked' && field === 'resolution')
                || (to === 'done' && field === 'note')).map(field => {
                const values = { reason, condition, resolution, note };
                const setters = { reason: setReason, condition: setCondition, resolution: setResolution, note: setNote };
                const code = { reason: 'REASON_REQUIRED', condition: 'UNBLOCK_CONDITION_REQUIRED', resolution: 'RESOLUTION_REQUIRED', note: 'COMPLETION_NOTE_REQUIRED' }[field];
                return <FormField key={field} label={tr(field)} required error={error === code ? tr(`error.${code}`) : undefined}>
                  {control => <Textarea {...control} value={values[field]} disabled={disabled} rows={3} maxLength={4000}
                    onChange={value => { setters[field](value); edit(); }} />}
                </FormField>;
              })}
              {to === 'done' && <label className="flex items-start gap-2 text-13 text-[var(--text-primary)]">
                <input type="checkbox" className="mt-1 size-3.5 shrink-0 accent-[var(--text-primary)]" disabled={disabled}
                  checked={confirmed} onChange={event => { setConfirmed(event.target.checked); edit(); }} />{tr('confirmDone')}
              </label>}
            </>}
            {hidden && <p role="alert" className="text-13 text-[var(--text-secondary)]">{tr('unavailable')}</p>}
            {error && <p role="alert" className="break-words text-13 text-[var(--danger-text)]">{tr(`error.${error}`)}</p>}
            {busy && <p role="status" className="text-12 text-[var(--text-secondary)]">{tr('inFlight')}</p>}
          </div>
          <div className="flex shrink-0 flex-wrap justify-end gap-2">
            <Button ref={firstControl} variant="secondary" type="button" onClick={() => onOpenChange(false)}>{tr(busy ? 'close' : 'cancel')}</Button>
            {(locked || hidden) && <Button variant="secondary" type="button" onClick={onRefresh}>{tr('refresh')}</Button>}
            {!hidden && <Button type="submit" variant="primary" loading={busy} disabled={disabled}>{tr(uncertain ? 'retry' : 'save')}</Button>}
          </div>
        </form>
      </Dialog.Content>
    </Dialog.Portal>
  </Dialog.Root>;
}
