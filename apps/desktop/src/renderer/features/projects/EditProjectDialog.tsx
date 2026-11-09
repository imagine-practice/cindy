import { useEffect, useRef, useState, type FormEvent, type ReactElement } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { useOptionalDataOwnerGeneration } from '@/contexts/AuthContext';
import {
  getDataOwnerGeneration,
  isDataOwnerGenerationCurrent,
} from '@/contexts/dataOwnerGeneration';
import {
  PROJECT_NAME_MAX_LENGTH,
  PROJECT_GOAL_MAX_LENGTH,
  type ProjectsAction,
} from '../../../shared/projects';

export type ProjectMetadataPatch = Pick<
  Extract<ProjectsAction, { action: 'update' }>,
  'projectId' | 'name' | 'goal'
>;
export interface EditProjectDialogProps {
  open: boolean;
  projectId: string;
  name: string;
  goal: string | null;
  /** Trusted parent view identity: replace on account/project/authorization snapshot changes. */
  scopeToken: string;
  /** Presentation hint only. The save host still checks real owner permissions. */
  canEdit: boolean;
  onOpenChange: (open: boolean) => void;
  /** Must reject on failure. Only the three public metadata fields are sent. */
  onSave: (patch: ProjectMetadataPatch) => Promise<void>;
  onSaved?: () => void;
}

/** No service, storage or host writes here; parent connects the frozen update service. */
export function EditProjectDialog(props: EditProjectDialogProps): ReactElement | null {
  useOptionalDataOwnerGeneration();
  const owner = getDataOwnerGeneration();
  const wasOpen = useRef(false);
  const focusReturnTarget = useRef<HTMLElement | null>(null);
  if (props.open && !wasOpen.current)
    focusReturnTarget.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null;
  wasOpen.current = props.open;
  return props.open ? (
    <EditProjectScope
      key={JSON.stringify([props.projectId, props.scopeToken, owner])}
      {...props}
      focusReturnTarget={focusReturnTarget.current}
    />
  ) : null;
}
function EditProjectScope(
  props: EditProjectDialogProps & { focusReturnTarget: HTMLElement | null },
): ReactElement {
  const { t } = useTranslation();
  const label = (key: string) => t(`ccAgent.projectCore.metadataEdit.${key}`);
  const baseline = useRef({ name: props.name.trim(), goal: props.goal?.trim() || null });
  const [name, setName] = useState(props.name);
  const [goal, setGoal] = useState(props.goal ?? '');
  const [validation, setValidation] = useState<string | null>(null);
  const [error, setError] = useState(false);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const composing = useRef(false);
  const mounted = useRef(false);
  const ticket = useRef(0);
  const owner = useRef(getDataOwnerGeneration());
  const input = useRef<HTMLInputElement>(null);
  const cancel = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      ticket.current++;
    };
  }, []);
  const validScope = () => mounted.current && isDataOwnerGenerationCurrent(owner.current);
  const identityValid = !!props.projectId.trim() && !!props.scopeToken.trim();
  const cleanName = name.trim();
  const cleanGoal = goal.trim() || null;
  const changed = cleanName !== baseline.current.name || cleanGoal !== baseline.current.goal;
  const disabled = busy || !props.canEdit || !identityValid;
  const submit = async (event: FormEvent) => {
    event.preventDefault();
    if (busyRef.current || composing.current || !validScope() || !identityValid || !props.canEdit)
      return;
    if (!cleanName) {
      setValidation('nameRequired');
      input.current?.focus();
      return;
    }
    if (cleanName.length > PROJECT_NAME_MAX_LENGTH) {
      setValidation('nameTooLong');
      return;
    }
    if ((cleanGoal?.length ?? 0) > PROJECT_GOAL_MAX_LENGTH) {
      setValidation('goalTooLong');
      return;
    }
    if (!changed) return;
    const patch: ProjectMetadataPatch = { projectId: props.projectId };
    if (cleanName !== baseline.current.name) patch.name = cleanName;
    if (cleanGoal !== baseline.current.goal) patch.goal = cleanGoal;
    busyRef.current = true;
    const request = ++ticket.current;
    const valid = () => validScope() && ticket.current === request;
    setBusy(true);
    setError(false);
    setValidation(null);
    try {
      await props.onSave(patch);
      if (!valid()) return;
      props.onOpenChange(false);
      props.onSaved?.();
    } catch {
      if (valid()) setError(true);
    } finally {
      if (valid()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };
  return (
    <Dialog.Root
      open={props.open}
      onOpenChange={(next) => {
        if (!busyRef.current && validScope()) props.onOpenChange(next);
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          data-project-metadata-editor=""
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col p-4 outline-none"
          onPointerDownOutside={(event) => event.preventDefault()}
          onInteractOutside={(event) => event.preventDefault()}
          onEscapeKeyDown={(event) => {
            if (event.isComposing || event.keyCode === 229 || composing.current || busyRef.current)
              event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            if (input.current && !input.current.disabled) input.current.focus();
            else cancel.current?.focus();
          }}
          onCloseAutoFocus={(event) => {
            event.preventDefault();
            if (!document.querySelector('[data-project-metadata-editor]') && props.focusReturnTarget?.isConnected)
              props.focusReturnTarget.focus();
          }}
        >
          <form
            noValidate
            className="flex min-h-0 flex-col"
            onSubmit={(event) => void submit(event)}
            onCompositionStart={() => {
              composing.current = true;
            }}
            onCompositionEnd={() => {
              composing.current = false;
            }}
            onKeyDown={(event) => {
              if (
                event.key === 'Enter' &&
                (composing.current || event.nativeEvent.isComposing || event.keyCode === 229)
              )
                event.preventDefault();
            }}
          >
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
              {label('title')}
            </Dialog.Title>
            <Dialog.Description className="mt-2 text-13 leading-5 text-[var(--confirm-desc)]">
              {label('description')}
            </Dialog.Description>
            <div className="mt-4 -mx-1 -mb-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-1">
              <FormField
                label={label('name')}
                required
                error={
                  validation === 'nameRequired' || validation === 'nameTooLong'
                    ? label(validation)
                    : undefined
                }
              >
                {(control) => (
                  <Input
                    {...control}
                    inputRef={input}
                    value={name}
                    disabled={disabled}
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    onChange={(value) => {
                      setName(value);
                      setValidation(null);
                      setError(false);
                    }}
                  />
                )}
              </FormField>
              <FormField
                label={label('goal')}
                error={validation === 'goalTooLong' ? label(validation) : undefined}
              >
                {(control) => (
                  <Textarea
                    {...control}
                    value={goal}
                    disabled={disabled}
                    maxLength={PROJECT_GOAL_MAX_LENGTH}
                    rows={4}
                    onChange={(value) => {
                      setGoal(value);
                      setValidation(null);
                      setError(false);
                    }}
                  />
                )}
              </FormField>
              {(!props.canEdit || !identityValid) && (
                <p role="status" className="text-13 leading-5 text-[var(--text-secondary)]">
                  {label(identityValid ? 'readOnly' : 'unavailable')}
                </p>
              )}
              {error && (
                <p role="alert" className="text-13 leading-5 text-[var(--text-secondary)]">
                  {label('failed')}
                </p>
              )}
            </div>
            <div className="mt-4 flex flex-wrap justify-end gap-2">
              <Button
                ref={cancel}
                variant="secondary"
                type="button"
                palette="confirmation"
                disabled={busy}
                onClick={() => {
                  if (!busyRef.current && validScope()) props.onOpenChange(false);
                }}
              >
                {label('cancel')}
              </Button>
              <Button
                type="submit"
                variant="primary"
                palette="confirmation"
                disabled={disabled || !changed}
                loading={busy}
              >
                {label(busy ? 'saving' : 'save')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
