/**
 * 群设置里的「关联项目」页：列出这个群已关联的本机项目，发起关联、解除关联。
 *
 * 关联只是「这个群 ↔ 这台电脑上的这个项目」的一条本机记录，不复制项目资料，也不显示
 * 群成员、群消息或任何项目访问凭证。列表每次都重新读取：回执里的 `current` 不会当成
 * 当前状态；`REVISION_CONFLICT` 只提示列表已变化并重读，由用户再操作，不自动重试。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Link2, Unlink } from 'lucide-react';
import { useTranslation } from 'react-i18next';

import { Button } from '@/components/ui/button';
import { useConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { ErrorNotice } from '@/components/ui/error-notice';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import { SettingsCard, SettingsRow, SettingsSection, SETTINGS_HINT } from '@/features/bots/ChatGroupSettingsRows';
import { cn } from '@/lib/utils';
import type { BotGroupSummary } from '../../../shared/botGroupChat';
import type { ProjectGroupLink, ProjectGroupLinkErrorCode } from '../../../shared/projectGroupLinks';
import type { ProjectRecord } from '../../../shared/projects';
import { listProjects } from './projectService';
import {
  ProjectGroupLinkError,
  linkProjectToGroup,
  projectGroupLinkDeviceId,
  projectGroupLinkErrorKey,
  projectGroupLinkGroup,
  readProjectGroupLinks,
  unlinkProjectFromGroup,
  type ProjectGroupLinkRows,
} from './projectGroupLinkClient';

type Notice = 'conflict' | 'uncertain';

/** 当前数据归属账号；由 AuthContext 同步发布到模块级快照，动作前重读以免跟旧账号。 */
function currentAccountId(): string | null {
  return getDataOwnerGeneration().dataOwnerId;
}

/** 关联失败后必须重读的码：本地没提交但列表已经变了，或已提交状态不明。 */
function needsReread(failure: ProjectGroupLinkError): boolean {
  if (failure.commitState !== 'not-committed') return true;
  return failure.code === 'REVISION_CONFLICT' || failure.code === 'REQUEST_CONFLICT'
    || failure.code === 'RELATION_NOT_FOUND';
}

export function GroupLinkedProjects({ group, canManage }: {
  group: BotGroupSummary;
  /** 群主或管理员：只有他们能提交关联；其他成员看列表并得到所需角色的说明。 */
  canManage: boolean;
}) {
  const { t } = useTranslation();
  const { confirm } = useConfirmDialog();
  const { id: roomId, serverBacked, conversationKind } = group;
  // 只依赖定位本身：群摘要每次刷新都是新对象，不该因此重读关联。
  const locator = useMemo(() => projectGroupLinkGroup({ id: roomId, serverBacked, conversationKind }),
    [roomId, serverBacked, conversationKind]);
  const [rows, setRows] = useState<ProjectGroupLinkRows | null>(null);
  const [readFailure, setReadFailure] = useState<ProjectGroupLinkErrorCode | null>(null);
  const [actionFailure, setActionFailure] = useState<ProjectGroupLinkErrorCode | null>(null);
  const [notice, setNotice] = useState<Notice | null>(null);
  const [projects, setProjects] = useState<ProjectRecord[] | null>(null);
  const [projectsFailed, setProjectsFailed] = useState(false);
  const [selected, setSelected] = useState('');
  const [busy, setBusy] = useState<string | null>(null);
  const mounted = useRef(true);
  const inFlight = useRef(false);
  const sequence = useRef(0);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; sequence.current += 1; };
  }, []);

  /** 以重新读取的列表为准。`includeRemoved` 带回已解除的行，供重新关联算 expectedRevision。 */
  const load = useCallback(async (): Promise<void> => {
    if (!locator) return;
    const token = ++sequence.current;
    const owner = getDataOwnerGeneration();
    const valid = () => mounted.current && sequence.current === token && isDataOwnerGenerationCurrent(owner);
    try {
      let next: ProjectGroupLinkRows;
      try {
        next = await readProjectGroupLinks(locator, { includeRemoved: canManage });
      } catch (error) {
        const failure = error instanceof ProjectGroupLinkError ? error : null;
        // 只看当前关系不需要配置权限：退回普通读，仍能显示真实列表与所需角色。
        if (canManage && (failure?.code === 'NOT_PROJECT_OWNER' || failure?.code === 'NOT_PROJECT_MEMBER')) {
          next = await readProjectGroupLinks(locator);
        } else {
          throw error;
        }
      }
      if (!valid()) return;
      setRows(next);
      setReadFailure(null);
    } catch (error) {
      if (!valid()) return;
      setRows(null);
      setReadFailure(error instanceof ProjectGroupLinkError ? error.code : 'INTERNAL');
    }
  }, [canManage, locator]);

  useEffect(() => { void load(); }, [load]);

  useEffect(() => {
    let cancelled = false;
    const owner = getDataOwnerGeneration();
    const valid = () => !cancelled && mounted.current && isDataOwnerGenerationCurrent(owner);
    void listProjects().then(next => {
      if (!valid()) return;
      setProjects(next);
      setProjectsFailed(false);
    }).catch(() => {
      if (!valid()) return;
      setProjects([]);
      setProjectsFailed(true);
    });
    return () => { cancelled = true; };
  }, []);

  const run = useCallback(async (key: string, action: () => Promise<void>): Promise<void> => {
    if (inFlight.current) return;
    inFlight.current = true;
    setBusy(key);
    setActionFailure(null);
    setNotice(null);
    const generation = getDataOwnerGeneration();
    try {
      await action();
    } catch (error) {
      if (!mounted.current || !isDataOwnerGenerationCurrent(generation)) return;
      const failure = error instanceof ProjectGroupLinkError
        ? error : new ProjectGroupLinkError('INTERNAL', 'unknown');
      setActionFailure(failure.code);
      if (needsReread(failure)) {
        setNotice(failure.commitState === 'not-committed' ? 'conflict' : 'uncertain');
        // 只重读，不重发这次动作：提交状态不明的请求复用原 requestId 由用户决定是否重试。
        await load();
      }
    } finally {
      inFlight.current = false;
      if (mounted.current) setBusy(null);
    }
  }, [load]);

  async function link(projectId: string): Promise<void> {
    const accountId = currentAccountId();
    if (!locator || !accountId || inFlight.current) return;
    const deviceId = await projectGroupLinkDeviceId();
    if (!deviceId || !mounted.current) {
      setActionFailure('UNSUPPORTED_CAPABILITY');
      return;
    }
    const expectedRevision = rows?.revisions.get(projectId) ?? 0;
    await run(`link:${projectId}`, async () => {
      await linkProjectToGroup({ group: locator, accountId, deviceId, projectId, expectedRevision });
      if (!mounted.current) return;
      setSelected('');
      await load();
    });
  }

  async function unlink(row: ProjectGroupLink, name: string): Promise<void> {
    const accountId = currentAccountId();
    if (!locator || !accountId || inFlight.current) return;
    const generation = getDataOwnerGeneration();
    const confirmed = await confirm({
      presentation: 'standard',
      title: t('projectGroupLinks.unlinkTitle', { name }),
      description: t('projectGroupLinks.unlinkNote'),
      confirmText: t('projectGroupLinks.unlink'),
      cancelText: t('projectGroupLinks.cancel'),
      confirmVariant: 'destructive',
    });
    if (!confirmed || !mounted.current || !isDataOwnerGenerationCurrent(generation)) return;
    const deviceId = await projectGroupLinkDeviceId();
    if (!deviceId || !mounted.current) {
      setActionFailure('UNSUPPORTED_CAPABILITY');
      return;
    }
    await run(`unlink:${row.relationId}`, async () => {
      await unlinkProjectFromGroup({
        group: locator, accountId, deviceId, projectId: row.target.projectId,
        relationId: row.relationId, expectedRevision: row.revision,
      });
      if (!mounted.current) return;
      await load();
    });
  }

  const accountId = currentAccountId();
  const projectNames = new Map((projects ?? []).map(project => [project.id, project.name]));
  const active = rows?.active ?? [];
  const linkedProjects = new Set(active.map(row => row.target.projectId));
  const owned = (projects ?? []).filter(project => project.status === 'active'
    && project.members.some(member => member.role === 'owner' && member.subject.kind === 'account'
      && member.subject.id === accountId));
  const available = owned.filter(project => !linkedProjects.has(project.id));
  const ready = rows !== null;

  if (!locator || !accountId) {
    return <SettingsCard className="flex flex-col gap-1 px-4 py-3.5">
      <p className="text-13 leading-[1.54] text-[var(--text-primary)]">{t('projectGroupLinks.unavailable')}</p>
      <p className={SETTINGS_HINT}>{t('projectGroupLinks.unavailableHint')}</p>
    </SettingsCard>;
  }

  return <div className="flex flex-col gap-5">
    {readFailure && <ErrorNotice message={t(projectGroupLinkErrorKey(readFailure))}
      actions={<Button variant="secondary" size="sm" onClick={() => void load()}>{t('projectGroupLinks.retry')}</Button>} />}
    {actionFailure && <ErrorNotice message={t(projectGroupLinkErrorKey(actionFailure))}
      actions={<Button variant="secondary" size="sm" onClick={() => void load()}>{t('projectGroupLinks.reload')}</Button>} />}
    {notice && <p role="status" className="text-13 leading-[1.54] text-[var(--text-secondary)]">
      {t(notice === 'conflict' ? 'projectGroupLinks.conflictNotice' : 'projectGroupLinks.uncertainNotice')}
    </p>}

    <SettingsSection title={t('projectGroupLinks.title')} count={ready ? active.length : undefined}
      caption={t('projectGroupLinks.caption')}>
      <SettingsCard>
        {!ready && !readFailure && <div className="flex items-center gap-2 px-4 py-3.5 text-13 text-[var(--text-secondary)]">
          <Spinner size={14} />{t('projectGroupLinks.loading')}
        </div>}
        {ready && active.length === 0 && <div className="flex flex-col gap-1 px-4 py-3.5">
          <p className="text-14 leading-[1.43] text-[var(--text-primary)]">{t('projectGroupLinks.emptyTitle')}</p>
          <p className={SETTINGS_HINT}>{t('projectGroupLinks.emptyHint')}</p>
        </div>}
        {active.map(row => {
          const name = projectNames.get(row.target.projectId);
          return <SettingsRow key={row.relationId}
            lead={<Link2 size={16} aria-hidden className="shrink-0 text-[var(--text-secondary)]" />}
            title={name ?? t('projectGroupLinks.unknownProject')}
            hint={name ? undefined : t('projectGroupLinks.unknownProjectHint')}
            trailing={<Button variant="secondary" tone="quiet" size="xs" compact
              disabled={busy !== null || !canManage}
              aria-label={t('projectGroupLinks.unlinkTarget', { name: name ?? t('projectGroupLinks.unknownProject') })}
              onClick={() => void unlink(row, name ?? t('projectGroupLinks.unknownProject'))}>
              <Unlink size={14} aria-hidden />{t('projectGroupLinks.unlink')}
            </Button>} />;
        })}
      </SettingsCard>
    </SettingsSection>

    <SettingsSection caption={canManage ? t('projectGroupLinks.addHint') : t('projectGroupLinks.onlyManager')}>
      <SettingsCard className="flex flex-wrap items-center gap-2 px-4 py-3">
        <Select label={t('projectGroupLinks.add')} value={selected}
          disabled={!canManage || busy !== null || !available.length}
          className="min-w-0 flex-1" onValueChange={setSelected}
          options={available.map(project => ({ value: project.id, label: project.name }))} />
        <Button variant="secondary" size="md" disabled={!canManage || busy !== null}
          loading={busy === `link:${selected}`} onClick={() => void link(selected)}>
          {t('projectGroupLinks.add')}
        </Button>
        {canManage && projects !== null && !available.length && <p className={cn('w-full', SETTINGS_HINT)}>
          {t(projectsFailed ? 'projectGroupLinks.projectsFailed' : 'projectGroupLinks.noAvailable')}
        </p>}
      </SettingsCard>
    </SettingsSection>
  </div>;
}
