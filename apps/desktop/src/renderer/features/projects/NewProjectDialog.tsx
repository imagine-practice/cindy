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
import { FolderKanban } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { FormField } from '@/components/ui/form-field';
import { Input, Textarea } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { useBotProfiles } from '@/features/bots/botStore';
import {
  PROJECT_GOAL_MAX_LENGTH,
  PROJECT_NAME_MAX_LENGTH,
  type ProjectDir,
  type ProjectSubjectRef,
} from '../../../shared/projects';
import { projectIdentityKey } from '../../../shared/projectKeys';
import { ProjectSubjectAvatar, type ProjectSubjectVisual } from './ProjectSubjectAvatar';
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
  const [ownerError, setOwnerError] = useState(false);
  const [memberKeys, setMemberKeys] = useState<string[]>([]);
  const [dirs, setDirs] = useState<ProjectDir[]>([]);
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
  // 账号没有登录昵称时显示「当前账号」：绝不能退化成「负责人」——那是角色，
  // 会让负责人列表里凭空多出一个叫「负责人」的人。
  const accountLabel = user?.name || t('ccAgent.projectCore.form.currentAccount');

  /** 可选主体：当前账号 + 全部未删除的伙伴。 */
  const candidates = useMemo(() => {
    const list: Array<{ key: string; ref: ProjectSubjectRef; visual: ProjectSubjectVisual }> = [];
    if (dataOwnerId) {
      list.push({
        key: `account:${dataOwnerId}`,
        ref: { kind: 'account', id: dataOwnerId },
        visual: { kind: 'account', name: accountLabel },
      });
    }
    for (const bot of bots) {
      if (bot.status === 'deleting') continue;
      list.push({
        key: `bot:${bot.id}`,
        ref: { kind: 'bot', id: bot.id },
        visual: {
          kind: 'bot',
          name: bot.name,
          avatar: bot.avatar,
          avatarColor: bot.avatarColor,
        },
      });
    }
    return list;
  }, [accountLabel, bots, dataOwnerId]);

  // 每次打开都从默认状态开始：负责人 = 当前账号，成员 = 空。
  useEffect(() => {
    if (!open) return;
    setName('');
    setGoal('');
    // 负责人不预选：默认替用户认领一个负责人，等于替用户做了业务决定。
    setOwnerKey('');
    setMemberKeys([]);
    setDirs([]);
    setNameError(false);
    setOwnerError(false);
    setSubmitError(null);
  }, [accountKey, open]);

  const selectedOwner = ownerKey;

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
      setOwnerError(true);
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
        dirs,
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

  /** 原生目录选择：只认本地目录，目录键与侧栏分组同一口径（local:<path>）。 */
  const pickDir = async (): Promise<void> => {
    const picked = await window.electronAPI.showOpenDirectoryDialog().catch(() => null);
    if (!picked || picked.canceled || !picked.path) return;
    const dirPath = picked.path;
    const dirKey = projectIdentityKey('local', dirPath, null);
    // 一个项目只绑一个目录：再选一次就是「更换」，不是追加。
    setDirs([{ dirKey, dirPath }]);
    setSubmitError(null);
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

              {/* 负责人：不预选、用行列表而不是下拉——头像和名字要一起看见，
                  下拉只能塞字符串，内部哨兵值会直接漏到界面上。 */}
              <div className="flex min-w-0 flex-col gap-2">
                <div className="flex items-center justify-between gap-2">
                  <span className="text-13 font-medium text-[var(--settings-section-title)]">
                    {t('ccAgent.projectCore.form.dirs')}
                  </span>
                  <Button type="button" variant="secondary" size="sm" compact onClick={() => void pickDir()}>
                    {t(dirs.length > 0
                      ? 'ccAgent.projectCore.detail.changeDir'
                      : 'ccAgent.projectCore.form.dirsPick')}
                  </Button>
                </div>
                <p className="text-12 leading-normal text-[var(--settings-section-desc)]">
                  {t('ccAgent.projectCore.form.dirsHint')}
                </p>
                {dirs.length === 0 ? (
                  <p className="text-12 text-[var(--settings-section-desc)]">
                    {t('ccAgent.projectCore.form.dirsEmpty')}
                  </p>
                ) : (
                  <ul className="flex flex-col gap-1">
                    {dirs.map((dir) => (
                      <li key={dir.dirKey} className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--surface-chip)] px-2 py-1.5">
                        <FolderKanban size={14} strokeWidth={1.8} className="shrink-0 text-[var(--folder-item-icon)]" />
                        <span className="min-w-0 flex-1 truncate text-12 text-[var(--text-primary)]" title={dir.dirPath}>
                          {dir.dirPath}
                        </span>
                        <Button
                          type="button"
                          variant="secondary"
                          size="xxs"
                          tone="quiet"
                          compact
                          aria-label={t('ccAgent.projectCore.form.dirRemove')}
                          onClick={() => setDirs((current) => current.filter((item) => item.dirKey !== dir.dirKey))}
                        >
                          {t('ccAgent.projectCore.form.dirRemove')}
                        </Button>
                      </li>
                    ))}
                  </ul>
                )}
              </div>

              <FormField
                label={t('ccAgent.projectCore.form.owner')}
                error={ownerError ? t('ccAgent.projectCore.form.ownerRequired') : undefined}
                required
              >
                {(control) => (
                  <ul
                    role="radiogroup"
                    aria-label={t('ccAgent.projectCore.form.owner')}
                    aria-required
                    aria-invalid={ownerError || undefined}
                    aria-describedby={control['aria-describedby']}
                    className="flex max-h-[168px] flex-col gap-0.5 overflow-y-auto"
                  >
                    {candidates.map((candidate) => {
                      const selected = candidate.key === selectedOwner;
                      return (
                        <li key={candidate.key}>
                          <label
                            className={cn(
                              'flex h-9 min-w-0 cursor-pointer items-center gap-2 rounded-lg px-2',
                              'text-13 text-[var(--text-primary)] transition-colors',
                              selected
                                ? 'bg-[var(--surface-chip)]'
                                : 'hover:bg-[var(--surface-hover)]',
                            )}
                          >
                            <input
                              type="radio"
                              name={control.id}
                              className="size-3.5 accent-[var(--text-primary)]"
                              checked={selected}
                              onChange={() => {
                                setOwnerKey(candidate.key);
                                setMemberKeys((current) =>
                                  current.includes(candidate.key) || candidate.key === accountKey
                                    ? current
                                    : [...current, candidate.key],
                                );
                                setOwnerError(false);
                                setSubmitError(null);
                              }}
                            />
                            <ProjectSubjectAvatar subject={candidate.visual} />
                            <span className="truncate">{candidate.visual.name}</span>
                            {selected && (
                              <span className="ml-auto shrink-0 rounded-full bg-[var(--surface-chip)] px-2 text-11 text-[var(--text-secondary)]">
                                {t('ccAgent.projectCore.detail.ownerBadge')}
                              </span>
                            )}
                          </label>
                        </li>
                      );
                    })}
                  </ul>
                )}
              </FormField>

              <div className="flex min-w-0 flex-col gap-2">
                <span className="text-13 font-medium text-[var(--settings-section-title)]">
                  {t('ccAgent.projectCore.form.members')}
                </span>
                <ul className="flex max-h-[180px] flex-col gap-0.5 overflow-y-auto">
                  {candidates.filter((candidate) => candidate.key !== selectedOwner).map((candidate) => {
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
                          <ProjectSubjectAvatar subject={candidate.visual} />
                          <span className="truncate">{candidate.visual.name}</span>
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
