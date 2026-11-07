import { ProjectProgressSection } from './progress/ProjectProgressSection';
import { ProjectProgressToGroupSection } from './progress/ProjectProgressToGroupSection';
/**
 * ProjectDetailPage — 实体项目详情（项目内核 M1）。
 *
 * 三块内容，对应 M1 的最小可用集：
 *   1. 概况：名称、状态、目标、创建时间、负责人
 *   2. 成员：负责人标记在前；可加成员、移除成员、转交负责人
 *      规则（负责人唯一、移除前必须转交、只能指派成员）全部由 main 强制，
 *      这里只负责把拒绝原因翻成人话。
 *   3. 任务：绑定该项目的任务列表，可设置/清空处理人，也可直接在本项目下新建任务。
 *
 * 数据来源：`local-db:projects:detail`。任何项目/成员/绑定变化都会触发
 * `projects:changed` 广播（含其他窗口与任务侧栏），本页据此重拉。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { ArrowLeft, FolderKanban, Plus, Trash2, UserMinus, UserPlus } from 'lucide-react';
import { useNavigate, useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { WINDOW_DRAG_STYLE, WINDOW_NO_DRAG_STYLE } from '@/components/layout/windowDrag';
import { useOptionalAuth } from '@/contexts/AuthContext';
import { isDataOwnerGenerationCurrent, getDataOwnerGeneration } from '@/contexts/dataOwnerGeneration';
import { useBotProfiles } from '@/features/bots/botStore';
import { cn } from '@/lib/utils';
import { toast } from '@/lib/toast';
import {
  projectSubjectKey,
  type ProjectDetail,
  type ProjectMember,
  type ProjectSubject,
  type ProjectSubjectRef,
  type ProjectWorkItem,
} from '../../../shared/projects';
import {
  addProjectDir,
  addProjectMember,
  deleteProject,
  onProjectsChanged,
  readProjectDetail,
  removeProjectDir,
  removeProjectMember,
  renameProject,
  setSessionAssignee,
  transferProjectOwner,
} from './projectService';
import { projectIdentityKey } from '../../../shared/projectKeys';
import { EditProjectDialog } from './EditProjectDialog';
import { ProjectLinkedGroupsSection } from './ProjectLinkedGroupsSection';
import { projectErrorKey } from './projectErrors';
import { projectSubjectVisual, useProjectSubjectLabel } from './projectLabels';
import { ProjectSubjectAvatar } from './ProjectSubjectAvatar';

// 非空哨兵：Radix Select 把空字符串当成「没有值」，会回退显示字段名（"处理人"）。
const UNASSIGNED = '__unassigned__';

export function ProjectDetailPage(): React.ReactElement {
  const { projectId = '' } = useParams();
  const auth = useOptionalAuth();
  return <ProjectDetailScope
    key={JSON.stringify([projectId, auth?.dataOwnerId, auth?.dataOwnerGeneration, getDataOwnerGeneration()])}
    projectId={projectId}
  />;
}

function ProjectDetailScope({ projectId }: { projectId: string }): React.ReactElement {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const confirmDialog = useConfirmDialog();
  const dataOwnerId = useOptionalAuth()?.dataOwnerId ?? null;
  const bots = useBotProfiles();
  const subjectLabel = useProjectSubjectLabel();
  const [detail, setDetail] = useState<ProjectDetail | null>(null);
  const [loadError, setLoadError] = useState<'notFound' | 'failed' | 'forbidden' | null>(null);
  const [progressRefresh, setProgressRefresh] = useState(0);
  const [metadataEditingScope, setMetadataEditingScope] = useState<string | null>(null);
  const metadataScope = useRef({ boundary: '', epoch: 0, token: '' });
  const accessLost = useCallback(() => { request.current += 1; setDetail(null); setLoadError('forbidden'); }, []);
  const [busyKey, setBusyKey] = useState<string | null>(null);
  const mounted = useRef(false);
  const request = useRef(0);
  const busy = useRef(false);
  const scopeOwner = useRef(getDataOwnerGeneration());
  const isCurrentScope = useCallback((): boolean =>
    mounted.current && isDataOwnerGenerationCurrent(scopeOwner.current), []);

  const load = useCallback(async (): Promise<void> => {
    if (!isCurrentScope()) return;
    const sequence = ++request.current;
    const valid = (): boolean => isCurrentScope() && request.current === sequence;
    try {
      const next = await readProjectDetail(projectId);
      if (!valid()) return;
      if (next.project.id !== projectId) throw new Error('INVALID_PROJECT_SCOPE');
      setDetail(next);
      setLoadError(null);
    } catch (error: unknown) {
      if (!valid()) return;
      const code = (error as { code?: string } | null)?.code;
      if (code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER') { setDetail(null); setLoadError('forbidden'); }
      else setLoadError(code === 'NOT_FOUND' ? 'notFound' : 'failed');
    }
  }, [isCurrentScope, projectId]);

  useEffect(() => {
    mounted.current = true;
    void load();
    const unsubscribe = onProjectsChanged(() => { void load(); setProgressRefresh(value => value + 1); });
    return () => {
      mounted.current = false;
      request.current += 1;
      unsubscribe();
    };
  }, [load]);

  const project = detail?.project ?? null;
  const members = project?.members ?? [];

  /** 可选主体：当前账号 + 全部未删除伙伴。 */
  const candidates = useMemo(() => {
    const list: Array<{ key: string; ref: ProjectSubjectRef; visual: ReturnType<typeof projectSubjectVisual> }> = [];
    if (dataOwnerId) {
      const accountSubject: ProjectSubject = { kind: 'account', id: dataOwnerId, displayName: null, avatar: null, avatarColor: null };
      list.push({
        key: `account:${dataOwnerId}`,
        ref: { kind: 'account', id: dataOwnerId },
        visual: projectSubjectVisual(accountSubject, subjectLabel(accountSubject)),
      });
    }
    for (const bot of bots) {
      if (bot.status === 'deleting') continue;
      const ref: ProjectSubjectRef = { kind: 'bot', id: bot.id };
      list.push({
        key: `bot:${bot.id}`,
        ref,
        visual: {
          kind: 'bot',
          name: bot.name,
          avatar: bot.avatar,
          avatarColor: bot.avatarColor,
        },
      });
    }
    return list;
  }, [bots, dataOwnerId, subjectLabel]);

  const memberKeys = useMemo(
    () => new Set(members.map((member) => projectSubjectKey(member.subject))),
    [members],
  );
  const addableCandidates = candidates.filter((candidate) => !memberKeys.has(candidate.key));
  // Member kind/id/role is authoritative for the presentation hint, including same-ID bots.
  // Main still enforces owner-only update at the actual transaction boundary.
  // 目录只影响新任务的默认归属，不授予访问：成员就能维护（归档后只读）。
  const canManageDirs = members.length > 0 && project?.status !== 'archived';
  // 负责人是伙伴时，账号成员可以把负责人接管给自己——伙伴不点界面。
  const selfMember = dataOwnerId
    ? members.find((member) => member.subject.kind === 'account' && member.subject.id === dataOwnerId)
    : undefined;
  const canClaimOwnership = !!dataOwnerId && !!selfMember && selfMember.role !== 'owner';
  const canEditMetadata = !!dataOwnerId && members.some(member =>
    member.subject.kind === 'account' && member.subject.id === dataOwnerId && member.role === 'owner');
  const metadataBoundary = JSON.stringify([projectId, project?.id ?? null, dataOwnerId,
    scopeOwner.current, loadError, members.map(member =>
      JSON.stringify([member.subject.kind, member.subject.id, member.role])).sort()]);
  if (metadataScope.current.boundary !== metadataBoundary) {
    const epoch = metadataScope.current.epoch + 1;
    metadataScope.current = { boundary: metadataBoundary, epoch, token: JSON.stringify([projectId, scopeOwner.current, epoch]) };
  }
  const metadataToken = metadataScope.current.token;
  useEffect(() => {
    // Do not revive an old editor when permission is lost and later restored to the same role.
    setMetadataEditingScope(current => current === metadataToken ? current : null);
  }, [metadataToken]);
  const metadataIsCurrent = () => isCurrentScope() && metadataScope.current.token === metadataToken;

  const run = async (key: string, action: () => Promise<void>): Promise<void> => {
    if (!isCurrentScope() || busy.current) return;
    busy.current = true;
    setBusyKey(key);
    try {
      await action();
    } catch (error: unknown) {
      if (isCurrentScope()) toast.error(t(projectErrorKey(error)));
    } finally {
      if (isCurrentScope()) {
        busy.current = false;
        setBusyKey(null);
      }
    }
  };

  /**
   * 删除项目：二次确认（逐字输入项目名）通过后才发请求，取消不发请求。
   * 删除后回到项目列表并提示结果；删除本身是真删除，没有撤销。
   */
  const deleteCurrentProject = async (target: { id: string; name: string }): Promise<void> => {
    if (!isCurrentScope() || busy.current) return;
    const confirmed = await confirmDialog.confirm({
      title: t('ccAgent.projectCore.deleteProject.confirmTitle', { name: target.name }),
      description: t('ccAgent.projectCore.deleteProject.confirmDescription'),
      confirmText: t('ccAgent.projectCore.deleteProject.confirm'),
      cancelText: t('ccAgent.projectCore.deleteProject.cancel'),
      confirmVariant: 'destructive',
      requireTypedConfirmation: {
        expected: target.name,
        label: t('ccAgent.projectCore.deleteProject.confirmTypeLabel'),
        placeholder: t('ccAgent.projectCore.deleteProject.confirmTypePlaceholder'),
      },
    });
    if (!confirmed || !isCurrentScope()) return;
    await run('delete', async () => {
      await deleteProject(target.id);
      if (!isCurrentScope()) return;
      toast.success(t('ccAgent.projectCore.deleteProject.success'));
      navigate('/cc-agent/projects');
    });
  };

  if (loadError) {
    return (
      <div className="flex h-full w-full flex-col bg-[hsl(var(--content-area))]">
        <header
          className="flex min-h-[68px] shrink-0 items-center gap-3 border-b border-[var(--cmd-palette-border)] px-6 py-4"
          style={WINDOW_DRAG_STYLE}
        >
          <BackButton onClick={() => navigate('/cc-agent/projects')} label={t('ccAgent.projectCore.detail.back')} />
          <h1 className="text-18 font-medium leading-none text-[var(--msg-assistant-text)]">
            {t(loadError === 'forbidden' ? 'ccAgent.projectCore.progress.forbidden' : loadError === 'notFound' ? 'ccAgent.projectCore.detail.notFound' : 'ccAgent.projectCore.detail.loadFailed')}
          </h1>
        </header>
      </div>
    );
  }

  if (!project) {
    // 本地数据走完异步取数再刷界面：不渲染 placeholder，避免空白帧。
    return <div className="h-full w-full bg-[hsl(var(--content-area))]" />;
  }

  const archived = project.status === 'archived';
  const ownerMember = members.find((member) => member.role === 'owner') ?? null;

  return (
    <div className="app-wallpaper-surface flex h-full w-full flex-col bg-[hsl(var(--content-area))]">
      <header
        className="flex min-h-[68px] shrink-0 items-center justify-between gap-4 flex-wrap sm:flex-nowrap border-b border-[var(--cmd-palette-border)] px-6 py-4"
        style={WINDOW_DRAG_STYLE}
      >
        <div className="flex min-w-0 items-center gap-3">
          <BackButton onClick={() => navigate('/cc-agent/projects')} label={t('ccAgent.projectCore.detail.back')} />
          <FolderKanban size={18} strokeWidth={1.75} className="shrink-0 text-[var(--settings-section-desc)]" />
          <div className="flex min-w-0 items-baseline gap-2.5">
            <h1 title={project.name} className="truncate text-18 font-medium leading-none text-[var(--msg-assistant-text)]">
              {project.name}
            </h1>
            <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-none text-[var(--text-secondary)]">
              {archived
                ? t('ccAgent.projectCore.detail.archived')
                : t('ccAgent.projectCore.taskCount', { count: project.taskCount })}
            </span>
          </div>
        </div>
        <div className="flex w-full shrink-0 flex-wrap items-center justify-end gap-2 sm:w-auto" style={WINDOW_NO_DRAG_STYLE}>
          {canClaimOwnership && dataOwnerId && (
            <Button
              variant="secondary"
              size="md"
              disabled={busyKey !== null}
              onClick={() =>
                void run('claim-owner', () =>
                  transferProjectOwner(project.id, { kind: 'account', id: dataOwnerId }),
                )
              }
            >
              {t('ccAgent.projectCore.detail.claimOwner')}
            </Button>
          )}
          {canEditMetadata && <Button variant="secondary" size="md" disabled={busyKey !== null}
            onClick={() => setMetadataEditingScope(metadataToken)}>
            {t('ccAgent.projectCore.metadataEdit.title')}
          </Button>}
          <Button
            variant="secondary"
            size="md"
            disabled={busyKey !== null}
            onClick={() =>
              void run('status', async () => {
                await renameProject(project.id, { status: archived ? 'active' : 'archived' });
              })
            }
          >
            {t(archived ? 'ccAgent.projectCore.detail.restore' : 'ccAgent.projectCore.detail.archive')}
          </Button>
          <Button
            variant="primary"
            size="md"
            disabled={archived}
            onClick={() =>
              navigate('/cc-agent/new', {
                state: {
                  projectId: project.id,
                  projectName: project.name,
                  // 项目认领了目录就用它当默认工作目录；没有目录由新建页回落到托管目录。
                  projectWorkingDir: project.dirs[0]?.dirPath ?? null,
                },
              })
            }
          >
            {t('ccAgent.projectCore.detail.newTask')}
          </Button>
        </div>
      </header>

      {metadataEditingScope === metadataToken && canEditMetadata && <EditProjectDialog open
        projectId={project.id} name={project.name} goal={project.goal} scopeToken={metadataToken}
        canEdit={canEditMetadata} onOpenChange={open => { if (!open) setMetadataEditingScope(null); }}
        onSave={async input => {
          if (!metadataIsCurrent() || !canEditMetadata || input.projectId !== projectId || busy.current)
            throw new Error('PROJECT_EDITOR_SCOPE_CHANGED');
          const patch: { name?: string; goal?: string | null } = {};
          if (input.name !== undefined) patch.name = input.name;
          if (input.goal !== undefined) patch.goal = input.goal;
          busy.current = true;
          setBusyKey('metadata');
          try {
            await renameProject(projectId, patch);
            if (!metadataIsCurrent()) throw new Error('PROJECT_EDITOR_SCOPE_CHANGED');
          } finally {
            if (isCurrentScope()) { busy.current = false; setBusyKey(null); }
          }
        }}
        onSaved={() => { if (metadataIsCurrent()) void load(); }} />}

      <div className="min-h-0 flex-1 overflow-y-auto px-4 py-5 sm:px-6">
        <div className="flex flex-col gap-6">
          <section className="flex flex-col gap-2">
            <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
              {t('ccAgent.projectCore.detail.goal')}
            </h2>
            <p className="whitespace-pre-wrap text-13 leading-normal text-[var(--text-primary)]">
              {project.goal || t('ccAgent.projectCore.detail.noGoal')}
            </p>
            <p className="text-12 text-[var(--settings-section-desc)]">
              {t('ccAgent.projectCore.detail.createdAt')}{' '}
              {new Date(project.createdAt).toLocaleString()}
            </p>
          </section>

          <ProjectProgressSection projectId={project.id} refreshKey={progressRefresh} onAccessLost={accessLost}
            onOpenWorkItem={id => navigate(`/cc-agent/${id}`)} />

          <ProjectProgressToGroupSection projectId={project.id} projectName={project.name} refreshKey={progressRefresh} />

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
                {t('ccAgent.projectCore.detail.dirs')}
              </h2>
              {canManageDirs && project.dirs.length === 0 && (
                <Button
                  variant="secondary"
                  size="sm"
                  compact
                  disabled={busyKey !== null}
                  onClick={() => {
                    void (async () => {
                      const picked = await window.electronAPI.showOpenDirectoryDialog().catch(() => null);
                      if (!picked || picked.canceled || !picked.path) return;
                      const dirPath = picked.path;
                      const dirKey = projectIdentityKey('local', dirPath, null);
                      await run('dir:add', () => addProjectDir(project.id, { dirKey, dirPath }));
                    })();
                  }}
                >
                  <Plus size={13} strokeWidth={1.75} className="mr-1" />
                  {t('ccAgent.projectCore.form.dirsPick')}
                </Button>
              )}
            </div>
            <p className="text-12 leading-normal text-[var(--settings-section-desc)]">
              {t('ccAgent.projectCore.detail.dirsHint')}
            </p>
            {project.dirs.length === 0 ? (
              <p className="text-13 text-[var(--settings-section-desc)]">
                {t('ccAgent.projectCore.detail.noDirs')}
              </p>
            ) : (
              <ul className="flex flex-col gap-1">
                {project.dirs.map((dir) => (
                  <li
                    key={dir.dirKey}
                    className="flex min-w-0 items-center gap-2 rounded-lg bg-[var(--surface-chip)] px-2 py-1.5 text-12"
                  >
                    <FolderKanban
                      size={14}
                      strokeWidth={1.8}
                      className="shrink-0 text-[var(--folder-item-icon)]"
                    />
                    <span className="min-w-0 flex-1 truncate text-[var(--text-primary)]" title={dir.dirPath}>
                      {dir.dirPath}
                    </span>
                    {canManageDirs && (
                      <>
                        <Button
                          variant="secondary"
                          size="xxs"
                          tone="quiet"
                          compact
                          disabled={busyKey !== null}
                          onClick={() => {
                            void (async () => {
                              const picked = await window.electronAPI.showOpenDirectoryDialog().catch(() => null);
                              if (!picked || picked.canceled || !picked.path) return;
                              const dirPath = picked.path;
                              const dirKey = projectIdentityKey('local', dirPath, null);
                              if (dirKey === dir.dirKey) return;
                              await run('dir:change', async () => {
                                await addProjectDir(project.id, { dirKey, dirPath });
                                await removeProjectDir(project.id, dir.dirKey);
                              });
                            })();
                          }}
                        >
                          {t('ccAgent.projectCore.detail.changeDir')}
                        </Button>
                        <Button
                          variant="secondary"
                          size="xxs"
                          tone="quiet"
                          compact
                          disabled={busyKey !== null}
                          onClick={() => void run(`dir:${dir.dirKey}`, () =>
                            removeProjectDir(project.id, dir.dirKey))}
                        >
                          {t('ccAgent.projectCore.detail.removeDir')}
                        </Button>
                      </>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>

          <section className="flex flex-col gap-3">
            <div className="flex items-center justify-between gap-2">
              <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
                {t('ccAgent.projectCore.detail.members')}
              </h2>
              {addableCandidates.length > 0 && (
                <Select
                  label={t('ccAgent.projectCore.detail.addMember')}
                  value=""
                  options={addableCandidates.map((candidate) => ({
                    value: candidate.key,
                    label: candidate.visual.name,
                    endAdornment: <ProjectSubjectAvatar subject={candidate.visual} />,
                  }))}
                  onValueChange={(value) => {
                    const candidate = addableCandidates.find((item) => item.key === value);
                    if (!candidate) return;
                    void run(`add:${candidate.key}`, () =>
                      addProjectMember(project.id, candidate.ref),
                    );
                  }}
                  disabled={busyKey !== null}
                  className="w-[200px]"
                />
              )}
            </div>
            <ul className="flex flex-col gap-1">
              {members.map((member) => (
                <MemberRow
                  key={projectSubjectKey(member.subject)}
                  member={member}
                  label={subjectLabel(member.subject)}
                  busy={busyKey !== null}
                  canManage={canEditMetadata}
                  onRemove={() =>
                    void run(`remove:${projectSubjectKey(member.subject)}`, () =>
                      removeProjectMember(project.id, {
                        kind: member.subject.kind,
                        id: member.subject.id,
                      }),
                    )
                  }
                  onTransfer={() =>
                    void run(`owner:${projectSubjectKey(member.subject)}`, () =>
                      transferProjectOwner(project.id, {
                        kind: member.subject.kind,
                        id: member.subject.id,
                      }),
                    )
                  }
                />
              ))}
              {ownerMember === null && (
                // 理论上不可达（负责人恒为成员）；宁可显示异常也不假装有负责人。
                <li className="text-13 text-[var(--danger-text)]">
                  {t('ccAgent.projectCore.error.ownerMustTransfer')}
                </li>
              )}
            </ul>
          </section>

          <section className="flex flex-col gap-3">
            <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
              {t('ccAgent.projectCore.detail.workItems')}
            </h2>
            {detail && detail.workItems.length === 0 ? (
              <div className="flex flex-col items-start gap-2">
                <p className="text-13 text-[var(--settings-section-desc)]">
                  {t('ccAgent.projectCore.detail.noWorkItems')}
                </p>
                {!archived && (
                  <Button
                    variant="primary"
                    size="sm"
                    onClick={() =>
                      navigate('/cc-agent/new', {
                        state: {
                  projectId: project.id,
                  projectName: project.name,
                  // 项目认领了目录就用它当默认工作目录；没有目录由新建页回落到托管目录。
                  projectWorkingDir: project.dirs[0]?.dirPath ?? null,
                },
                      })
                    }
                  >
                    {t('ccAgent.projectCore.detail.createFirstTask')}
                  </Button>
                )}
              </div>
            ) : (
              <ul className="flex flex-col">
                {detail?.workItems.map((item) => (
                  <WorkItemRow
                    key={item.sessionId}
                    item={item}
                    members={members}
                    busy={busyKey !== null}
                    onOpen={() => navigate(`/cc-agent/${item.sessionId}`)}
                    onOpenMaterials={() =>
                      navigate(`/cc-agent/projects/${project.id}/items/${item.sessionId}`)
                    }
                    onAssign={(key) => {
                      const target =
                        key === UNASSIGNED
                          ? null
                          : (members.find(
                              (member) => projectSubjectKey(member.subject) === key,
                            )?.subject ?? null);
                      void run(`assign:${item.sessionId}`, () =>
                        setSessionAssignee(item.sessionId, target
                          ? { kind: target.kind, id: target.id }
                          : null),
                      );
                    }}
                  />
                ))}
              </ul>
            )}
          </section>

          <ProjectLinkedGroupsSection projectId={project.id} />

          {/*
            删除是不可恢复的真删除，所以只给负责人看，且放在页面末尾——不与日常桌面
            上的归档 / 新建任务挤在同一行，避免误点。
          */}
          {canEditMetadata && (
            <section className="flex flex-col gap-2 border-t border-[var(--cmd-palette-border)] pt-5">
              <h2 className="text-14 font-medium text-[var(--settings-section-title)]">
                {t('ccAgent.projectCore.deleteProject.title')}
              </h2>
              <p className="text-13 leading-normal text-[var(--text-secondary)]">
                {t('ccAgent.projectCore.deleteProject.description')}
              </p>
              <div>
                <Button
                  variant="secondary"
                  size="md"
                  tone="danger"
                  disabled={busyKey !== null}
                  onClick={() => void deleteCurrentProject({ id: project.id, name: project.name })}
                >
                  <Trash2 size={14} strokeWidth={1.75} className="mr-1.5" aria-hidden />
                  {t('ccAgent.projectCore.deleteProject.action')}
                </Button>
              </div>
            </section>
          )}
        </div>
      </div>
    </div>
  );
}

function BackButton({
  onClick,
  label,
}: {
  onClick: () => void;
  label: string;
}): React.ReactElement {
  return (
    <button
      type="button"
      onClick={onClick}
      aria-label={label}
      className={cn(
        'flex size-7 shrink-0 items-center justify-center rounded-full text-[var(--settings-section-desc)]',
        'hover:bg-[var(--surface-hover)] hover:text-[var(--text-primary)]',
        'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-[var(--focus-ring)]',
      )}
      style={WINDOW_NO_DRAG_STYLE}
    >
      <ArrowLeft size={16} strokeWidth={1.75} />
    </button>
  );
}

function MemberRow({
  member,
  label,
  busy,
  canManage,
  onRemove,
  onTransfer,
}: {
  member: ProjectMember;
  label: string;
  busy: boolean;
  /** 成员管理与转交只有负责人能做；接管负责人的入口在页头，不在这里。 */
  canManage: boolean;
  onRemove: () => void;
  onTransfer: () => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const isOwner = member.role === 'owner';
  return (
    <li className="flex h-9 items-center gap-2 rounded-lg px-2 text-13 text-[var(--text-primary)]">
      <ProjectSubjectAvatar subject={projectSubjectVisual(member.subject, label)} />
      <span className="truncate">{label}</span>
      {isOwner && (
        <span className="shrink-0 rounded-full bg-[var(--surface-chip)] px-2 py-0.5 text-11 leading-none text-[var(--text-secondary)]">
          {t('ccAgent.projectCore.detail.ownerBadge')}
        </span>
      )}
      <div className="ml-auto flex shrink-0 items-center gap-1">
        {canManage && !isOwner && (
          <Button
            variant="secondary"
            size="sm"
            tone="quiet"
            compact
            disabled={busy}
            onClick={onTransfer}
          >
            <UserPlus size={13} strokeWidth={1.75} className="mr-1" />
            {t('ccAgent.projectCore.detail.transferOwner')}
          </Button>
        )}
        {/* 负责人不能直接移除：服务层会拒绝，这里先不给按钮，避免制造必然失败的操作。 */}
        {canManage && !isOwner && (
          <Button variant="secondary" size="sm" tone="quiet" compact disabled={busy} onClick={onRemove}>
            <UserMinus size={13} strokeWidth={1.75} className="mr-1" />
            {t('ccAgent.projectCore.detail.removeMember')}
          </Button>
        )}
      </div>
    </li>
  );
}

function WorkItemRow({
  item,
  members,
  busy,
  onOpen,
  onOpenMaterials,
  onAssign,
}: {
  item: ProjectWorkItem;
  members: readonly ProjectMember[];
  busy: boolean;
  onOpen: () => void;
  onOpenMaterials: () => void;
  onAssign: (key: string) => void;
}): React.ReactElement {
  const { t } = useTranslation();
  const options = [
    { value: UNASSIGNED, label: t('ccAgent.projectCore.detail.unassigned') },
    ...members.map((member) => {
      const name = member.subject.displayName ?? member.subject.id;
      return {
        value: projectSubjectKey(member.subject),
        label: name,
        endAdornment: <ProjectSubjectAvatar subject={projectSubjectVisual(member.subject, name)} />,
      };
    }),
  ];
  return (
    <li className="flex min-h-10 items-center gap-3 border-b border-[var(--cmd-palette-border)] py-2 last:border-b-0">
      <button
        type="button"
        onClick={onOpen}
        className="min-w-0 flex-1 truncate text-left text-13 text-[var(--text-primary)] hover:underline"
        title={item.title}
      >
        {item.title}
      </button>
      <span className="shrink-0 text-11 text-[var(--settings-section-desc)]">
        {item.status === 'archived'
          ? t('ccAgent.projectCore.detail.archived')
          : t('ccAgent.projectCore.detail.statusActive')}
      </span>
      <Button variant="secondary" size="xs" tone="quiet" compact onClick={onOpenMaterials}>
        {t('ccAgent.materials.entry')}
      </Button>
      <Select
        label={t('ccAgent.projectCore.detail.assignee')}
        value={item.assignee ? projectSubjectKey(item.assignee) : UNASSIGNED}
        options={options}
        onValueChange={onAssign}
        disabled={busy}
        className="w-[168px]"
        triggerAdornment={
          item.assignee ? (
            <ProjectSubjectAvatar
              subject={projectSubjectVisual(
                item.assignee,
                item.assignee.displayName ?? item.assignee.id,
              )}
            />
          ) : null
        }
      />
    </li>
  );
}
