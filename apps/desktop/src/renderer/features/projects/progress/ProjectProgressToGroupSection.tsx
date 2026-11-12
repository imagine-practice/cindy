/**
 * 项目详情里的「同步到群」：手动把**真实读到的**项目进展摘要发到该项目已关联的一个群。
 *
 * 行为边界（`docs/plans/2026-11-06-project-progress-to-group.md`）：
 * - 只列这个项目已关联的群（`local-db:project-group-links:list-project`，按项目一次读）；
 *   没有关联群时按钮禁用并说明先去群设置关联。
 * - 发送前必须二次确认，确认框里显示将发送的完整文本；发到群里就收不回来。
 * - 摘要由 `projectProgressSync.ts` 从宿主已授权的读取结果生成：没有记录就写「暂无记录」，
 *   不写 0%、不编造百分比；每个工作项列出状态与处理人（未分配就写未分配）；
 *   不含材料正文、成员名单、凭证。
 * - 发送走既有群发送通道，以**当前账号**身份（main 固定 `authorKind: 'user'`），不冒充伙伴。
 * - **同内容可以再发**：每次确认发送生成一枚新的 sendId；失败/未知时重试复用同一枚
 *   （不会产生第二条），成功后作废。发送中与确认框打开期间都不能再点第二次。
 * - 结果如实：已发送 / 已发送过（这一枚此前已入库）/ 失败原因；失败保留可重试。
 * - 等不到回执而显示「发送中，结果未知」时，只做**只读对账**：界面重新获得焦点、标签页转为
 *   可见、或页面刷新时读一次群发送回执；回执已到就改说「已发送过」。对账绝不重发、不入队，
 *   也不改发送标识：回执没到就继续显示未知，等下一次对账。
 * - 读不到项目进展（含非成员）时整块不出现：没有摘要就没有这个入口。
 */
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Send } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Select } from '@/components/ui/select';
import { Spinner } from '@/components/ui/spinner';
import { useOptionalConfirmDialog } from '@/components/ui/confirm-dialog-provider';
import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProjectProgressReadResult } from '../../../../shared/projectProgressApi';
import type { ProjectMember } from '../../../../shared/projects';
import { getBotGroupOutboxReceipt } from '@/features/bots/botGroupOutbox';
import { projectGroupLinkAvailable } from '../projectGroupLinkClient';
import { useProjectLinkedGroups } from '../useProjectLinkedGroups';
import { useProjectSubjectName } from '../projectLabels';
import { readProjectProgress } from './projectProgressService';
import {
  buildProjectProgressSummary,
  createProjectProgressSendId,
  projectProgressClientId,
  sendProjectProgressSummary,
  type ProjectProgressSummary,
  type ProjectProgressSubjectRef,
  type ProjectProgressSyncOutcome,
} from './projectProgressSync';

type ReadState =
  | { status: 'loading' }
  | { status: 'ready'; items: ProjectProgressReadResult['items']; history: ProjectProgressReadResult['history'] }
  | { status: 'unavailable' }
  | { status: 'forbidden' };

type Notice =
  | { kind: 'sent' }
  | { kind: 'alreadySent' }
  /** 等不到回执但仍在队列/飞行中：不是失败，保留这一次发送以便对账。 */
  | { kind: 'inFlight' }
  | { kind: 'failed'; reasonKey: string; retryable: boolean };

/** 一次已确认的发送：摘要 + 目标群 + 这一次点击的发送标识（重试复用同一枚）。 */
interface Attempt {
  summary: ProjectProgressSummary;
  groupId: string;
  sendId: string;
}

export function ProjectProgressToGroupSection({ projectId, projectName, refreshKey, members = [] }: {
  projectId: string;
  projectName: string;
  refreshKey: number;
  members?: readonly ProjectMember[];
}): React.ReactElement | null {
  const { t } = useTranslation();
  const dialog = useOptionalConfirmDialog();
  const knownSubjectName = useProjectSubjectName();
  // main 只给 kind/id；账号昵称与伙伴名由界面按已知主体补。解析不到时返回空串，让群摘要
  // 用它自己面向对方的措辞（「某位成员」），不要把内部的「资料暂不可用」发进群里。
  const subjectLabel = useCallback((ref: ProjectProgressSubjectRef): string => knownSubjectName(
    members.find(member => member.subject.kind === ref.kind && member.subject.id === ref.id)?.subject
      ?? { ...ref, displayName: null, avatar: null, avatarColor: null },
  ) ?? '', [knownSubjectName, members]);
  const accountId = getDataOwnerGeneration().dataOwnerId;
  const available = projectGroupLinkAvailable();
  const links = useProjectLinkedGroups(projectId, refreshKey);
  const [read, setRead] = useState<ReadState>({ status: 'loading' });
  const [targetId, setTargetId] = useState('');
  const [notice, setNotice] = useState<Notice | null>(null);
  const [sending, setSending] = useState(false);
  const [asking, setAsking] = useState(false);
  /** 已确认过的那次发送：重试用它（同一枚 sendId），保证「看到的就是发出的」。 */
  const [attempt, setAttempt] = useState<Attempt | null>(null);
  const mounted = useRef(false);
  const owner = useRef(getDataOwnerGeneration());
  const sendingRef = useRef(false);
  const askingRef = useRef(false);
  const readSequence = useRef(0);
  const isCurrent = useCallback((sequence: number) => mounted.current && readSequence.current === sequence
    && isDataOwnerGenerationCurrent(owner.current), []);

  useEffect(() => {
    mounted.current = true;
    return () => { mounted.current = false; readSequence.current += 1; };
  }, []);

  useEffect(() => {
    if (!available) return;
    const sequence = ++readSequence.current;
    setRead({ status: 'loading' });
    void readProjectProgress({ projectId }).then(
      (result) => {
        if (!isCurrent(sequence)) return;
        // 结果只认这个项目：别的项目的进展既不能显示也不能发出去。
        if (result.projectId !== projectId || result.items.some(item => item.projectId !== projectId)
          || result.history.some(event => event.projectId !== projectId)) {
          setRead({ status: 'unavailable' });
          return;
        }
        setRead({ status: 'ready', items: result.items, history: result.history });
      },
      (error: unknown) => {
        if (!isCurrent(sequence)) return;
        const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
        setRead({ status: code === 'FORBIDDEN' || code === 'NOT_PROJECT_MEMBER' ? 'forbidden' : 'unavailable' });
      },
    );
  }, [available, isCurrent, projectId, refreshKey]);

  // 只有一个关联群时默认选中它；多个时保持用户当前选择（消失则回落到第一个）。
  useEffect(() => {
    if (links.status !== 'ready' || links.groups.length === 0) { setTargetId(''); return; }
    setTargetId(current => links.groups.some(group => group.id === current) ? current : links.groups[0].id);
  }, [links]);

  // 摘要随真实读取结果、界面语言与处理人名字重算；确认框与发送都用同一份。
  const summary = useMemo<ProjectProgressSummary | null>(() => {
    if (read.status !== 'ready') return null;
    try {
      return buildProjectProgressSummary({
        projectId, projectName, items: read.items, history: read.history, t, subjectLabel,
      });
    } catch {
      // 进展数据自相矛盾时不发一段猜出来的文字，按钮保持禁用。
      return null;
    }
  }, [projectId, projectName, read, subjectLabel, t]);

  /**
   * 只读对账：这一次发送只等到超时（`inFlight`），回执可能随后才落库。群发送回执是本地已有的
   * 只读记录（main 的 (group, clientId) 回执）；页面刷新、窗口重新获得焦点、标签页转为可见时
   * 各读一次：回执到了就说「已发送过」，没到就继续显示未知。
   *
   * 这里**不发送、不入队、不重试**，也不换发送标识：重发只能由用户显式点按（发送 / 重新核对）。
   */
  const inFlightAttempt = notice?.kind === 'inFlight' ? attempt : null;
  useEffect(() => {
    if (!inFlightAttempt) return;
    const clientId = projectProgressClientId(projectId, inFlightAttempt.summary.text, inFlightAttempt.sendId);
    const lookup = () => {
      const messageId = getBotGroupOutboxReceipt(inFlightAttempt.groupId, clientId);
      // 卸载或换了账号：这一次对账说的已经不是屏幕上的那个项目。
      if (!messageId || !mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
      setNotice({ kind: 'alreadySent' });
      setAttempt(null);
    };
    lookup();
    const onVisible = () => { if (document.visibilityState === 'visible') lookup(); };
    const onFocus = () => lookup();
    window.addEventListener('focus', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      window.removeEventListener('focus', onFocus);
      document.removeEventListener('visibilitychange', onVisible);
    };
    // 对账只认这一次发送与它所在的项目；每次刷新 / 焦点都重新读一次回执。
  }, [inFlightAttempt, projectId, refreshKey]);

  // 读不到进展（含不是成员）：没有摘要就没有这个入口。
  if (!available || !accountId || read.status === 'forbidden') return null;

  const groups = links.status === 'ready' ? links.groups : [];
  const targetGroup = groups.find(group => group.id === targetId) ?? null;
  const canSend = !sending && !asking && targetGroup !== null && dialog !== null && summary !== null;

  const send = async (next: Attempt): Promise<void> => {
    if (sendingRef.current) return;
    sendingRef.current = true;
    setSending(true);
    setNotice(null);
    let outcome: ProjectProgressSyncOutcome;
    try {
      outcome = await sendProjectProgressSummary(next);
    } finally {
      sendingRef.current = false;
      if (mounted.current) setSending(false);
    }
    if (!mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
    if (outcome.kind === 'inFlight') {
      // Keep this attempt: the manager reuses `attempt.sendId` for the same summary text (see
      // `askAndSend`) and the 重新核对 button below retries it, so this send is never duplicated.
      setAttempt(next);
      setNotice({ kind: 'inFlight' });
      return;
    }
    if (outcome.kind === 'failed') {
      // 失败保留这一次发送（同一枚 sendId），重试不会变成第二条。
      setAttempt(next);
      setNotice({ kind: 'failed', reasonKey: outcome.reasonKey, retryable: outcome.retryable });
      return;
    }
    // 成功即作废这一枚：下次确认发送是新的标识，同内容可以再发。
    setAttempt(null);
    setNotice({ kind: outcome.kind });
  };

  const askAndSend = async (): Promise<void> => {
    // 确认框打开期间和发送中都不再响应点击：连点只产生一次发送。
    if (!targetGroup || !dialog || !summary || sendingRef.current || askingRef.current) return;
    // 同一群 + 同一段摘要文本 = 用户已经确认过的那一条：继续用它，别再生成第二个标识。
    // 摘要内容变了才是另一条消息，那时才换新标识。
    if (attempt && attempt.groupId === targetGroup.id && attempt.summary.text === summary.text) {
      await send(attempt);
      return;
    }
    askingRef.current = true;
    setAsking(true);
    const next: Attempt = { summary, groupId: targetGroup.id, sendId: createProjectProgressSendId() };
    let confirmed = false;
    try {
      confirmed = await dialog.confirm({
        title: t('projectProgressToGroup.confirmTitle', { name: targetGroup.name }),
        description: t('projectProgressToGroup.confirmNote'),
        content: (
          <pre className="max-h-[40vh] overflow-y-auto whitespace-pre-wrap break-words rounded-lg bg-[var(--surface-chip)] p-3 text-12 leading-[1.5] text-[var(--text-primary)]">
            {summary.text}
          </pre>
        ),
        confirmText: t('projectProgressToGroup.confirmSend'),
        cancelText: t('projectProgressToGroup.cancel'),
        maxWidth: 480,
        contentSelectable: true,
      });
    } finally {
      askingRef.current = false;
      if (mounted.current) setAsking(false);
    }
    // 确认框关掉就是不发：不改状态、不写回执。
    if (!confirmed || !mounted.current || !isDataOwnerGenerationCurrent(owner.current)) return;
    await send(next);
  };

  const noticeText = notice === null ? null : notice.kind === 'sent'
    ? t('projectProgressToGroup.sent')
    : notice.kind === 'alreadySent'
      ? t('projectProgressToGroup.alreadySent')
      : notice.kind === 'inFlight'
        ? t('projectProgressToGroup.inFlight')
        : t('projectProgressToGroup.failed', { detail: t(notice.reasonKey) });

  return <section className="flex min-w-0 flex-col gap-2">
    <h2 className="text-14 font-medium text-[var(--settings-section-title)]">{t('projectProgressToGroup.title')}</h2>
    <p className="text-12 leading-[1.42] text-[var(--settings-section-desc)]">{t('projectProgressToGroup.hint')}</p>
    {links.status === 'loading' && <p className="flex items-center gap-2 text-13 text-[var(--settings-section-desc)]">
      <Spinner size={14} />{t('projectProgressToGroup.loadingGroups')}
    </p>}
    {links.status === 'failed' && <p role="alert" className="text-12 leading-[1.42] text-[var(--text-danger)]">
      {t('projectGroupLinks.projectFailed')}{' '}{t(links.reasonKey)}
    </p>}
    {links.status === 'ready' && links.groups.length === 0 && <p className="text-13 leading-normal text-[var(--settings-section-desc)]">
      {t('projectProgressToGroup.noGroup')}
    </p>}
    {links.status !== 'unavailable' && <div className="flex min-w-0 flex-col gap-2 sm:flex-row sm:items-center">
      {groups.length > 1 && <Select
        label={t('projectProgressToGroup.target')}
        value={targetId}
        options={groups.map(group => ({ value: group.id, label: group.name }))}
        onValueChange={(value) => {
          // 换了群，上一条回执与失败重试说的都是另一个群：一并清掉。
          setTargetId(value);
          setNotice(null);
          setAttempt(null);
        }}
        disabled={sending}
        className="w-full min-w-0 sm:w-[220px]"
      />}
      {/* 没有关联群、读不到进展、或没有确认框时按钮保持可见但禁用：入口在，条件不满足就说清楚。 */}
      <Button variant="secondary" size="md" className="min-w-0 whitespace-normal" disabled={!canSend}
        onClick={() => { void askAndSend(); }}>
        <Send size={14} strokeWidth={1.75} aria-hidden />
        <span className="min-w-0">{t(sending ? 'projectProgressToGroup.sending' : 'projectProgressToGroup.action')}</span>
      </Button>
    </div>}
    {links.status === 'ready' && links.groups.length > 0 && read.status === 'unavailable'
      && <p className="text-12 leading-[1.42] text-[var(--settings-section-desc)]">{t('projectProgressToGroup.progressUnavailable')}</p>}
    {links.status === 'ready' && links.truncated && <p role="status" className="text-12 leading-[1.42] text-[var(--text-secondary)]">
      {t('projectGroupLinks.projectPartial')}
    </p>}
    {notice !== null && noticeText !== null && <div className="flex min-w-0 flex-col gap-2"
      role={notice.kind === 'failed' ? 'alert' : 'status'}>
      <p className={notice.kind === 'failed'
        ? 'text-12 leading-[1.42] text-[var(--text-danger)]'
        : 'text-12 leading-[1.42] text-[var(--text-secondary)]'}>{noticeText}</p>
      {(notice.kind === 'inFlight' || (notice.kind === 'failed' && notice.retryable)) && <Button
        variant="secondary" size="sm" tone="quiet" compact className="self-start whitespace-normal"
        disabled={sending || attempt === null}
        onClick={() => { if (attempt) void send(attempt); }}>
        {t(notice.kind === 'inFlight' ? 'projectProgressToGroup.recheck' : 'projectProgressToGroup.retry')}
      </Button>}
    </div>}
  </section>;
}
