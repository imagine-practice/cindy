import { useEffect, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProjectMember, ProjectSubject } from '../../../shared/projects';
import { mutateProject } from './projectService';
import { projectErrorKey } from './projectErrors';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { pendingProjectTaskKey, readPendingProjectTask, type PendingProjectTask } from './pendingProjectTask';

export function NewProjectTaskDialog({ projectId, members, labelOf, onClose, onCreated }: {
  projectId: string; members: readonly ProjectMember[]; labelOf: (subject: ProjectSubject | null) => string;
  onClose: () => void; onCreated: (id: string) => void;
}) {
  const { t } = useTranslation();
  const label = (key: string) => t(`ccAgent.projectCore.taskCreate.${key}`);
  const auth = useOptionalAuth();
  const [recovery] = useState(() => {
    try {
      const key = pendingProjectTaskKey(auth?.dataOwnerId, projectId);
      return { key, request: readPendingProjectTask(key, projectId), blocked: false };
    } catch { return { key: '', request: null, blocked: true }; }
  });
  const [title, setTitle] = useState(recovery.request?.title ?? ''), [goal, setGoal] = useState(recovery.request?.taskObjective ?? '');
  const [assignee, setAssignee] = useState(recovery.request?.assignee
    ? JSON.stringify([recovery.request.assignee.kind, recovery.request.assignee.id]) : 'none');
  const [busy, setBusy] = useState(false), [error, setError] = useState<string | null>(null);
  // `locked` is state, not a ref: discarding the retained request must unlock the form now.
  const [locked, setLocked] = useState(recovery.request !== null), [confirmDiscard, setConfirmDiscard] = useState(false);
  const pending = useRef(false), mounted = useRef(true), owner = useRef(getDataOwnerGeneration());
  // Retain the exact request on ambiguous failure; retry cannot create a second row.
  const request = useRef<PendingProjectTask | null>(recovery.request);
  const uncertain = useRef(recovery.request !== null);
  useEffect(() => { mounted.current = true; return () => { mounted.current = false; }; }, []);
  const valid = () => mounted.current && isDataOwnerGenerationCurrent(owner.current);
  const submit = async () => {
    if (pending.current || !valid()) return;
    if (recovery.blocked) { setError(t('ccAgent.projectCore.error.generic')); return; }
    if (!request.current) {
      if (!title.trim() || !goal.trim()) { setError(label('required')); return; }
      const member = members.find(item => JSON.stringify([item.subject.kind, item.subject.id]) === assignee);
      if (assignee !== 'none' && !member) { setError(t('ccAgent.projectCore.error.notMember')); return; }
      request.current = { action: 'createWorkItem', projectId, sessionId: Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join(''),
        title: title.trim(), taskObjective: goal.trim(), assignee: member ? { kind: member.subject.kind, id: member.subject.id } : null };
    }
    pending.current = true; setBusy(true); setError(null);
    try {
      // Write before dispatch. Failure to save the recovery identity must not
      // dispatch a request that a close/restart could turn into a duplicate.
      localStorage.setItem(`${recovery.key}.${request.current.sessionId}`, JSON.stringify(request.current));
      const result = await mutateProject(request.current);
      if (result.sessionId !== request.current.sessionId || result.projectId !== projectId)
        throw new Error('Creation receipt does not match the pending task');
      if (valid() && result.sessionId) {
        localStorage.removeItem(`${recovery.key}.${request.current.sessionId}`);
        onCreated(result.sessionId);
      }
    } catch (err) {
      if (valid()) {
        // Only definitive validation/transaction rejection permits editing a new
        // request. Unknown outcomes retain the original id and frozen payload.
        const code = (err as { code?: string } | null)?.code;
        const rejected = code && ['ASSIGNEE_NOT_MEMBER', 'PRECONDITION_FAILED', 'FORBIDDEN', 'NOT_PROJECT_MEMBER', 'NOT_PROJECT_OWNER', 'INVALID_PARAMS'].includes(code);
        if (rejected && !uncertain.current) {
          try { localStorage.removeItem(`${recovery.key}.${request.current!.sessionId}`); request.current = null; }
          catch { uncertain.current = true; }
        } else uncertain.current = true;
        setError(t(projectErrorKey(err)));
      }
    }
    finally { pending.current = false; if (valid()) setBusy(false); }
  };
  // The retained request may never be able to succeed (task deleted, project archived, membership
  // revoked). The user needs a way out that does not create a second row: drop the record and edit
  // a fresh task. Nothing already created is touched, so this stays a create-form decision.
  const discard = () => {
    const retained = request.current;
    if (!retained || pending.current) return;
    try {
      localStorage.removeItem(`${recovery.key}.${retained.sessionId}`);
    } catch {
      setError(t('ccAgent.projectCore.error.generic'));
      return;
    }
    request.current = null;
    uncertain.current = false;
    setLocked(false);
    setConfirmDiscard(false);
    setError(null);
  };
  // Frozen while a request is retained, whether it came from storage (`locked`, which the discard
  // action clears) or from an uncertain failure in this session (`request.current`).
  const frozen = busy || locked || request.current !== null;
  return <Dialog.Root open onOpenChange={open => { if (!open && !pending.current) onClose(); }}>
    <Dialog.Portal><Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
      <Dialog.Content className="modal-panel fixed inset-0 z-[71] m-auto h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] overflow-y-auto p-4"
        onEscapeKeyDown={event => { if (pending.current) event.preventDefault(); }}>
        <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">{t('ccAgent.projectCore.detail.newTask')}</Dialog.Title>
        <Dialog.Description className="mt-2 text-13 text-[var(--confirm-desc)]">{label('hint')}</Dialog.Description>
        <form className="mt-4 flex flex-col gap-4"
          onKeyDown={event => { if (event.key === 'Enter' && (event.nativeEvent.isComposing || event.keyCode === 229)) event.preventDefault(); }}
          onSubmit={event => { event.preventDefault(); void submit(); }}>
          <FormField label={label('name')} required>{control => <Input {...control} value={title} maxLength={120} disabled={frozen} onChange={setTitle} />}</FormField>
          <FormField label={label('goal')} required>{control => <Textarea {...control} value={goal} maxLength={2000} disabled={frozen} onChange={setGoal} />}</FormField>
          <Select label={t('ccAgent.projectCore.detail.assignee')} value={assignee} disabled={frozen} onValueChange={setAssignee}
            options={[{ value: 'none', label: t('ccAgent.projectCore.detail.unassigned') }, ...members.map(member => ({ value: JSON.stringify([member.subject.kind, member.subject.id]), label: labelOf(member.subject) }))]} />
          {error && <p role="alert" className="text-13 text-[var(--text-danger)]">{error}</p>}
          {locked && !busy && (confirmDiscard
            ? <div className="flex flex-col gap-2 rounded-lg bg-[var(--surface-chip)] p-3" role="alertdialog"
                aria-label={label('discardPending')}>
              <p className="text-12 leading-[1.42] text-[var(--text-secondary)]">{label('discardPendingNote')}</p>
              <div className="flex justify-end gap-2">
                <Button type="button" size="sm" compact onClick={() => setConfirmDiscard(false)}>
                  {t('ccAgent.projectCore.form.cancel')}
                </Button>
                <Button type="button" size="sm" compact variant="primary" onClick={discard}>
                  {label('discardPendingConfirm')}
                </Button>
              </div>
            </div>
            : <Button type="button" size="sm" compact className="self-start whitespace-normal"
                onClick={() => setConfirmDiscard(true)}>
              {label('discardPending')}
            </Button>)}
          <div className="flex justify-end gap-2"><Button type="button" disabled={busy} onClick={onClose}>{t('ccAgent.projectCore.form.cancel')}</Button>
            <Button type="submit" variant="primary" disabled={busy}>{label('submit')}</Button></div>
        </form>
      </Dialog.Content></Dialog.Portal>
  </Dialog.Root>;
}
