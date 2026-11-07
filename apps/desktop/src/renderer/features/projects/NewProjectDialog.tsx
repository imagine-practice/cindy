/**
 * NewProjectDialog — 新建项目（项目内核 M1）。
 *
 * 字段：名称（必填）、目标、负责人（默认当前账号）、成员多选。
 * 负责人唯一；创建账号为必选成员，账号自己负责时从额外成员中去重。
 * 负责人始终勾选；切换负责人时保留原有成员选择。
 *
 * 规则校验在 main 的服务层；这里只做「名称非空」这种提交前的最小提示，
 * 失败原因一律按 IPC 错误码翻成用户能懂的一句话。
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useBotProfiles } from '@/features/bots/botStore';
import {
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectSubjectRef,
} from '../../../shared/projects';
import { createProject } from './projectService';
import { projectErrorKey } from './projectErrors';

interface NewProjectDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** 创建成功后由上层刷新项目快照（列表/侧栏共用同一份 store）。 */
  onCreated?: () => void;
}

export function NewProjectDialog(props: NewProjectDialogProps): React.ReactElement | null {
  const auth = useOptionalAuth();
  return props.open ? <NewProjectDialogScope
    key={JSON.stringify([auth?.dataOwnerId, auth?.dataOwnerGeneration, getDataOwnerGeneration()])}
    {...props}
  /> : null;
}

function NewProjectDialogScope({
  open,
  onOpenChange,
  onCreated,
}: NewProjectDialogProps): React.ReactElement {
  const { t } = useTranslation();
  const auth = useOptionalAuth();
  const user = auth?.user ?? null;
  const dataOwnerId = auth?.dataOwnerId ?? null;
  const bots = useBotProfiles();
  const [name, setName] = useState('');
  const [goal, setGoal] = useState('');
  const [ownerKey, setOwnerKey] = useState('');
  const [memberKeys, setMemberKeys] = useState<string[]>([]);
  const [nameError, setNameError] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const busyRef = useRef(false);
  const nameInputRef = useRef<HTMLInputElement>(null);
  const mounted = useRef(false);
  const scopeOwner = useRef(getDataOwnerGeneration());
  const requestTicket = useRef(0);
  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; requestTicket.current += 1; };
  }, []);

  const accountKey = dataOwnerId ? `account:${dataOwnerId}` : '';
  const accountLabel = user?.name || t('ccAgent.projectCore.detail.ownerBadge');

  /** 可选主体：当前账号 + 全部未删除的伙伴。 */
  const candidates = useMemo(() => {
    const list: Array<{ key: string; ref: ProjectSubjectRef; label: string; avatar: string }> = [];
    if (dataOwnerId) {
      list.push({
        key: `account:${dataOwnerId}`,
        ref: { kind: 'account', id: dataOwnerId },
        label: accountLabel,
        avatar: '👤',
      });
    }
    for (const bot of bots) {
      if (bot.status === 'deleting') continue;
      list.push({
        key: `bot:${bot.id}`,
        ref: { kind: 'bot', id: bot.id },
        label: bot.name,
        avatar: bot.avatar || '🤖',
      });
    }
    return list;
  }, [accountLabel, bots, dataOwnerId]);

  // 每次打开都从默认状态开始：负责人 = 当前账号，成员 = 空。
  useEffect(() => {
    if (!open) return;
    setName('');
    setGoal('');
    setOwnerKey(accountKey);
    setMemberKeys([]);
    setNameError(false);
    setSubmitError(null);
  }, [accountKey, open]);

  const selectedOwner = ownerKey || accountKey;

  const submit = async (event: React.FormEvent): Promise<void> => {
    event.preventDefault();
    if (busyRef.current || !mounted.current || !isDataOwnerGenerationCurrent(scopeOwner.current)) return;
    const trimmedName = name.trim();
    if (!trimmedName) {
      setNameError(true);
      return;
    }
    const owner = candidates.find((candidate) => candidate.key === selectedOwner);
    if (!owner) {
      setSubmitError(t('ccAgent.projectCore.error.generic'));
      return;
    }
    const members = candidates
      .filter((candidate) => candidate.key === accountKey || memberKeys.includes(candidate.key))
      .filter((candidate) => candidate.key !== owner.key)
      .map((candidate) => candidate.ref);
    busyRef.current = true;
    const ticket = ++requestTicket.current;
    const valid = (): boolean => mounted.current && ticket === requestTicket.current
      && isDataOwnerGenerationCurrent(scopeOwner.current);
    setBusy(true);
    setSubmitError(null);
    try {
      await createProject({
        name: trimmedName,
        goal: goal.trim() ? goal.trim() : null,
        owner: owner.ref,
        members,
      });
      if (!valid()) return;
      onOpenChange(false);
      onCreated?.();
    } catch (error: unknown) {
      if (valid()) setSubmitError(t(projectErrorKey(error)));
    } finally {
      if (valid()) {
        busyRef.current = false;
        setBusy(false);
      }
    }
  };

  const toggleMember = (key: string): void => {
    if (key === accountKey || key === selectedOwner) return;
    setMemberKeys((current) =>
      current.includes(key) ? current.filter((item) => item !== key) : [...current, key],
    );
  };

  return (
    <Dialog.Root open={open} onOpenChange={(next) => !busyRef.current && onOpenChange(next)}>
      <Dialog.Portal>
        <Dialog.Overlay className="modal-scrim fixed inset-0 z-[70]" />
        <Dialog.Content
          onEscapeKeyDown={(event) => {
            if (event.isComposing || busyRef.current) event.preventDefault();
          }}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            nameInputRef.current?.focus();
          }}
          className="modal-panel fixed inset-0 z-[71] m-auto flex h-fit max-h-[85vh] w-[min(480px,calc(100vw-32px))] flex-col p-4 outline-none"
        >
          <form className="flex min-h-0 flex-col" onSubmit={(event) => void submit(event)} noValidate>
            <Dialog.Title className="text-18 font-medium text-[var(--confirm-title)]">
              {t('ccAgent.projectCore.newProject')}
            </Dialog.Title>
            <div className="mt-4 -mx-1 -mb-1 flex min-h-0 flex-col gap-4 overflow-y-auto px-1 pb-1">
              <FormField
                label={t('ccAgent.projectCore.form.name')}
                error={nameError ? t('ccAgent.projectCore.form.nameRequired') : undefined}
                required
              >
                {(control) => (
                  <Input
                    {...control}
                    inputRef={nameInputRef}
                    size="md"
                    value={name}
                    maxLength={PROJECT_NAME_MAX_LENGTH}
                    placeholder={t('ccAgent.projectCore.form.namePlaceholder')}
                    onChange={(value) => {
                      setName(value);
                      if (value.trim()) setNameError(false);
                      setSubmitError(null);
                    }}
                    onKeyDown={(event) => {
                      // CJK IME: confirming a candidate must not submit the form.
                      if (
                        event.key === 'Enter' &&
                        (event.nativeEvent.isComposing || event.keyCode === 229)
                      ) {
                        event.preventDefault();
                      }
                    }}
                  />
                )}
              </FormField>

              <FormField label={t('ccAgent.projectCore.form.goal')}>
                {(control) => (
                  <Textarea
                    {...control}
                    value={goal}
                    maxLength={PROJECT_GOAL_MAX_LENGTH}
                    rows={3}
                    placeholder={t('ccAgent.projectCore.form.goalPlaceholder')}
                    onChange={(value) => setGoal(value)}
                  />
                )}
              </FormField>

              <FormField label={t('ccAgent.projectCore.form.owner')}>
                {(control) => (
                  <Select
                    {...control}
                    label={t('ccAgent.projectCore.form.owner')}
                    value={selectedOwner}
                    options={candidates.map((candidate) => ({
                      value: candidate.key,
                      label: `${candidate.avatar} ${candidate.label}`,
                    }))}
                    onValueChange={(value) => {
                      setOwnerKey(value);
                      setMemberKeys((current) =>
                        current.includes(value) ? current : [...current, value],
                      );
                      setSubmitError(null);
                    }}
                  />
                )}
              </FormField>

              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-13 font-medium text-[var(--settings-section-title)]">
                  {t('ccAgent.projectCore.form.members')}
                </span>
                <ul className="flex max-h-[180px] flex-col gap-1 overflow-y-auto">
                  {candidates.map((candidate) => {
                    const isOwner = candidate.key === selectedOwner;
                    const isCreatorMember = candidate.key === accountKey && !isOwner;
                    const checked = isOwner || isCreatorMember || memberKeys.includes(candidate.key);
                    return (
                      <li key={candidate.key}>
                        <label
                          className={cn(
                            'flex h-8 min-w-0 items-center gap-2 rounded-lg px-2 text-13',
                            'text-[var(--text-primary)]',
                            isOwner || isCreatorMember
                              ? 'opacity-100'
                              : 'cursor-pointer hover:bg-[var(--surface-hover)]',
                          )}
                        >
                          <input
                            type="checkbox"
                            className="size-3.5 accent-[var(--text-primary)]"
                            checked={checked}
                            disabled={isOwner || isCreatorMember}
                            onChange={() => toggleMember(candidate.key)}
                          />
                          <span className="shrink-0">{candidate.avatar}</span>
                          <span className="truncate">{candidate.label}</span>
                          {isOwner && (
                            <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-chip)] px-2 text-11 text-[var(--text-secondary)]">
                              {t('ccAgent.projectCore.detail.ownerBadge')}
                            </span>
                          )}
                          {isCreatorMember && (
                            <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-chip)] px-2 text-11 text-[var(--text-secondary)]">
                              {t('ccAgent.projectCore.form.creatorMember')}
                            </span>
                          )}
                        </label>
                      </li>
                    );
                  })}
                </ul>
              </div>

              {submitError && (
                <p className="text-13 text-[var(--danger-text)]" role="alert">
                  {submitError}
                </p>
              )}
            </div>

            <div className="mt-5 flex shrink-0 items-center justify-end gap-2">
              <Button
                type="button"
                variant="secondary"
                size="md"
                disabled={busy}
                onClick={() => onOpenChange(false)}
              >
                {t('ccAgent.projectCore.form.cancel')}
              </Button>
              <Button type="submit" variant="primary" size="md" loading={busy}>
                {t('ccAgent.projectCore.form.submit')}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
