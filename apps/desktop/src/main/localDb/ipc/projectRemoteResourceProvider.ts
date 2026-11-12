/**
 * 「项目」集合的手机投影：把本机 `projects` / `project_members` / `sessions` /
 * `work_item_progress*` / `project_group_links` 经 device-link 既有的 Remote Resource
 * 4 通道交给控制端（手机 / 平板）。
 *
 * 契约正本：`documents/2026-11-11-手机端项目页接口契约.md`（v1）。三条不变量：
 *
 * 1. **不新增通道**：集合走 `remoteResourceRegistry` 注册，`REMOTE_RESOURCE_CHANNELS`
 *    与 allowlist 哈希都不动；老被控端没有这个集合时 manifest 里自然不出现。
 * 2. **不依赖 event.sender**：远程调用是合成 event（`sender: undefined`），所以这里
 *    一个 `assertTrustedAppRendererEvent` 都不调，读取/写入都走 sender-free 的既有入口
 *    （`listProjects` / `readProjectDetail` / `requireProjectAction` / `mutateProjects` /
 *    `workItemProgress.execute` / `projectProgress.read`），权限判据复用同一套事务与
 *    `shared/projectAccess`，provider 里不另写一套。
 * 3. **descriptor 只是展示提示**：每次 invoke 都重新判当前成员资格与项目状态，手机传来的
 *    角色、`disabled`、`confirmation` 都不构成授权。
 *
 * 变更通知（契约 §6「两种都可用，但必须选一种」）：**只走既有 `REMOTE_RESOURCE_CHANGED`
 * 广播**——写动作成功后 `tapWindowBroadcast` 一次（`collectionId: 'projects'` + 该项目的 ref），
 * 控制端据此重读。该通道已在 `PUSH_FORWARD_ALLOWLIST`，手机端 `DeviceLinkContext` 已在消费。
 * invoke 回包的 `effects` 为空、**不**内联刷新后的 resource：不做第二套刷新机制，
 * 免得刷新时序不可预测。不变量是「每个成功回包恰好一条广播」——幂等重放与
 * 「状态没变」的 no-op 也发，丢了响应的控制端重试时因此仍能收敛。
 */

import type {
  RemoteActionDescriptor,
  RemoteActionInvokeResponse,
  RemoteCollectionItem,
  RemoteCollectionListResponse,
  RemoteLocalizedText,
  RemoteResource,
  RemoteResourceRef,
} from '@cindy/device-link';
import { REMOTE_RESOURCE_CHANGED_CHANNEL, resolveRemoteText } from '@cindy/device-link';

import { isIpcError } from '../../../shared/ipc-errors';
import type { ProjectProgressApiHistoryEntry, ProjectProgressApiItem, ProjectProgressReadResult } from '../../../shared/projectProgressApi';
import type { ProjectRecord, ProjectSubjectRef, ProjectWorkItem } from '../../../shared/projects';
import type { WorkItemProgressIntent, WorkItemProgressResult } from '../../../shared/workItemProgress';
import { WORK_ITEM_STATUSES, summarizeWorkItems, type WorkItemStatus } from '../../../shared/workItemStatus';
import {
  captureDataOwnerBroadcastScope,
  getSafeDataOwnerPushStamp,
  isDataOwnerBroadcastScopeCurrent,
  tapWindowBroadcast,
} from '../../device-link/broadcast-tap';
import {
  RemoteResourceRegistryError,
  remoteResourceRegistry,
} from '../../device-link/remoteResourceRegistry';
import { createLogger } from '../../logger';
import type { DbClient } from '../client/DbClient';
import { getCurrentDbClientSnapshot } from '../client/current';
import { readProjectGroupLinksByProject } from './projectGroupLinks';
import { listProjects, mutateProjects, readProjectDetail, requireProjectAction } from './projects';

const log = createLogger('project-remote-resource');

export const PROJECT_REMOTE_COLLECTION_ID = 'projects';
export const PROJECT_REMOTE_RESOURCE_KIND = 'project';

/** 契约 §2：`limit` 默认 20、上限 50。 */
const DEFAULT_LIST_LIMIT = 20;
const MAX_LIST_LIMIT = 50;
/** 契约 §3：进度历史默认最近 5 条。 */
const MAX_PROGRESS_EVENTS = 5;
/** 一次读回的工作项上限：项目任务过多时手机端本来也点不过来，先截断而不是拖垮一次读。 */
const MAX_WORK_ITEMS = 200;
const MAX_MEMBERS = 200;
const MAX_FALLBACK_CHARS = 8_000;
const MAX_NAME_CHARS = 200;
const MAX_ID_CHARS = 200;
const MAX_REQUEST_ID_CHARS = 200;
const MAX_NOTE_CHARS = 4_000;
/** 幂等回执在进程内保留的时长与条数（只是重放保护，不是授权凭据）。 */
const RECEIPT_TTL_MS = 5 * 60_000;
const MAX_RECEIPTS = 256;

const ACTION_IDS = {
  recordProgress: 'project.recordProgress',
  setAssignee: 'project.setAssignee',
  archive: 'project.archive',
  unarchive: 'project.unarchive',
} as const;
type ProjectActionId = typeof ACTION_IDS[keyof typeof ACTION_IDS];
const PROJECT_ACTION_IDS: readonly string[] = Object.values(ACTION_IDS);

type Copy = {
  en: string;
  'zh-CN': string;
  'zh-TW': string;
  ja: string;
  ko: string;
  es: string;
  fr: string;
  de: string;
  'pt-PT': string;
  'pt-BR': string;
  'zh-Hant-x-lzh': string;
  'zh-Hans-x-lzh': string;
};

/** 术语按 `i18n/GLOSSARY.md`：Project / Task / Session 的既有裁决，不自造译法。 */
const COPY = {
  title: { en: 'Projects', 'zh-CN': '项目', 'zh-TW': '專案', ja: 'プロジェクト', ko: '프로젝트',
    es: 'Proyectos', fr: 'Projets', de: 'Projekte', 'pt-PT': 'Projetos', 'pt-BR': 'Projetos', 'zh-Hant-x-lzh': '案', 'zh-Hans-x-lzh': '案' },
  statusActive: { en: 'In progress', 'zh-CN': '进行中', 'zh-TW': '進行中', ja: '進行中', ko: '진행 중',
    es: 'En curso', fr: 'En cours', de: 'In Arbeit', 'pt-PT': 'Em curso', 'pt-BR': 'Em andamento', 'zh-Hant-x-lzh': '方行', 'zh-Hans-x-lzh': '方行' },
  statusArchived: { en: 'Archived', 'zh-CN': '已归档', 'zh-TW': '已封存', ja: 'アーカイブ済み', ko: '보관됨',
    es: 'Archivado', fr: 'Archivé', de: 'Archiviert', 'pt-PT': 'Arquivado', 'pt-BR': 'Arquivado', 'zh-Hant-x-lzh': '已封存', 'zh-Hans-x-lzh': '已归档' },
  members: { en: '{count} members', 'zh-CN': '{count} 位成员', 'zh-TW': '{count} 位成員', ja: '{count} 人のメンバー', ko: '멤버 {count}명',
    es: '{count} miembros', fr: '{count} membres', de: '{count} Mitglieder', 'pt-PT': '{count} membros', 'pt-BR': '{count} membros', 'zh-Hant-x-lzh': '{count} 位同人', 'zh-Hans-x-lzh': '{count} 位同人' },
  tasks: { en: '{count} tasks', 'zh-CN': '{count} 个任务', 'zh-TW': '{count} 個任務', ja: '{count} 件のタスク', ko: '작업 {count}개',
    es: '{count} tareas', fr: '{count} tâches', de: '{count} Aufgaben', 'pt-PT': '{count} tarefas', 'pt-BR': '{count} tarefas', 'zh-Hant-x-lzh': '{count} 件差事', 'zh-Hans-x-lzh': '{count} 件差事' },
  memberFallback: { en: 'A member', 'zh-CN': '某位成员', 'zh-TW': '某位成員', ja: 'メンバーの一人', ko: '알 수 없는 멤버',
    es: 'Un miembro', fr: 'Un membre', de: 'Ein Mitglied', 'pt-PT': 'Um membro', 'pt-BR': 'Um membro', 'zh-Hant-x-lzh': '某員', 'zh-Hans-x-lzh': '某员' },
  groupFallback: { en: 'A group chat', 'zh-CN': '某个群聊', 'zh-TW': '某個群聊', ja: 'いずれかのグループチャット', ko: '알 수 없는 그룹 채팅',
    es: 'Un chat de grupo', fr: 'Une discussion de groupe', de: 'Ein Gruppenchat', 'pt-PT': 'Uma conversa de grupo', 'pt-BR': 'Uma conversa em grupo', 'zh-Hant-x-lzh': '某群議', 'zh-Hans-x-lzh': '某群议' },
  blockSummary: { en: 'Summary', 'zh-CN': '概要', 'zh-TW': '概要', ja: '概要', ko: '요약',
    es: 'Resumen', fr: 'Résumé', de: 'Übersicht', 'pt-PT': 'Resumo', 'pt-BR': 'Resumo', 'zh-Hant-x-lzh': '概要', 'zh-Hans-x-lzh': '概要' },
  blockProgress: { en: 'Progress', 'zh-CN': '进度', 'zh-TW': '進度', ja: '進捗', ko: '진행 상황',
    es: 'Progreso', fr: 'Progression', de: 'Fortschritt', 'pt-PT': 'Progresso', 'pt-BR': 'Progresso', 'zh-Hant-x-lzh': '進度', 'zh-Hans-x-lzh': '进度' },
  blockWorkItems: { en: 'Tasks', 'zh-CN': '任务', 'zh-TW': '任務', ja: 'タスク', ko: '작업',
    es: 'Tareas', fr: 'Tâches', de: 'Aufgaben', 'pt-PT': 'Tarefas', 'pt-BR': 'Tarefas', 'zh-Hant-x-lzh': '差事', 'zh-Hans-x-lzh': '差事' },
  blockMembers: { en: 'Members', 'zh-CN': '成员', 'zh-TW': '成員', ja: 'メンバー', ko: '멤버',
    es: 'Miembros', fr: 'Membres', de: 'Mitglieder', 'pt-PT': 'Membros', 'pt-BR': 'Membros', 'zh-Hant-x-lzh': '同人', 'zh-Hans-x-lzh': '同人' },
  blockGroup: { en: 'Group chat', 'zh-CN': '关联群', 'zh-TW': '關聯群', ja: 'グループチャット', ko: '그룹 채팅',
    es: 'Chat de grupo', fr: 'Discussion de groupe', de: 'Gruppenchat', 'pt-PT': 'Conversa de grupo', 'pt-BR': 'Conversa em grupo', 'zh-Hant-x-lzh': '關聯群議', 'zh-Hans-x-lzh': '关联群议' },
  stageTodo: { en: 'To do', 'zh-CN': '未开始', 'zh-TW': '未開始', ja: '未着手', ko: '시작 전',
    es: 'Sin empezar', fr: 'À faire', de: 'Offen', 'pt-PT': 'Por fazer', 'pt-BR': 'A fazer', 'zh-Hant-x-lzh': '未始', 'zh-Hans-x-lzh': '未始' },
  stageDoing: { en: 'In progress', 'zh-CN': '进行中', 'zh-TW': '進行中', ja: '進行中', ko: '진행 중',
    es: 'En curso', fr: 'En cours', de: 'In Arbeit', 'pt-PT': 'Em curso', 'pt-BR': 'Em andamento', 'zh-Hant-x-lzh': '方行', 'zh-Hans-x-lzh': '方行' },
  stageBlocked: { en: 'Blocked', 'zh-CN': '受阻', 'zh-TW': '受阻', ja: 'ブロック中', ko: '막힘',
    es: 'Bloqueado', fr: 'Bloqué', de: 'Blockiert', 'pt-PT': 'Bloqueado', 'pt-BR': 'Bloqueado', 'zh-Hant-x-lzh': '有阻', 'zh-Hans-x-lzh': '有阻' },
  stageReview: { en: 'In review', 'zh-CN': '待确认', 'zh-TW': '待確認', ja: '確認待ち', ko: '확인 대기',
    es: 'En revisión', fr: 'En relecture', de: 'Zu prüfen', 'pt-PT': 'Em revisão', 'pt-BR': 'Em revisão', 'zh-Hant-x-lzh': '待核', 'zh-Hans-x-lzh': '待核' },
  stageDone: { en: 'Done', 'zh-CN': '确认完成', 'zh-TW': '確認完成', ja: '完了', ko: '확인 완료',
    es: 'Confirmado', fr: 'Terminé', de: 'Bestätigt', 'pt-PT': 'Confirmado', 'pt-BR': 'Confirmado', 'zh-Hant-x-lzh': '已畢', 'zh-Hans-x-lzh': '已毕' },
  actionProgress: { en: 'Record progress', 'zh-CN': '记录进度', 'zh-TW': '記錄進度', ja: '進捗を記録', ko: '진행 기록',
    es: 'Registrar avance', fr: "Enregistrer l'avancement", de: 'Fortschritt erfassen', 'pt-PT': 'Registar progresso', 'pt-BR': 'Registrar progresso', 'zh-Hant-x-lzh': '記進度', 'zh-Hans-x-lzh': '记进度' },
  actionAssignee: { en: 'Set assignee', 'zh-CN': '设置处理人', 'zh-TW': '設定處理人', ja: '担当を設定', ko: '담당자 지정',
    es: 'Asignar responsable', fr: 'Définir le responsable', de: 'Zuständige Person', 'pt-PT': 'Definir responsável', 'pt-BR': 'Definir responsável', 'zh-Hant-x-lzh': '定司事', 'zh-Hans-x-lzh': '定司事' },
  actionArchive: { en: 'Archive project', 'zh-CN': '归档项目', 'zh-TW': '封存專案', ja: 'プロジェクトをアーカイブ', ko: '프로젝트 보관',
    es: 'Archivar proyecto', fr: 'Archiver le projet', de: 'Projekt archivieren', 'pt-PT': 'Arquivar projeto', 'pt-BR': 'Arquivar projeto', 'zh-Hant-x-lzh': '封存案', 'zh-Hans-x-lzh': '封存案' },
  actionUnarchive: { en: 'Restore project', 'zh-CN': '恢复项目', 'zh-TW': '恢復專案', ja: 'プロジェクトを復元', ko: '프로젝트 복원',
    es: 'Restaurar proyecto', fr: 'Restaurer le projet', de: 'Projekt wiederherstellen', 'pt-PT': 'Restaurar projeto', 'pt-BR': 'Restaurar projeto', 'zh-Hant-x-lzh': '復原案', 'zh-Hans-x-lzh': '复原案' },
  fieldTask: { en: 'Task', 'zh-CN': '任务', 'zh-TW': '任務', ja: 'タスク', ko: '작업',
    es: 'Tarea', fr: 'Tâche', de: 'Aufgabe', 'pt-PT': 'Tarefa', 'pt-BR': 'Tarefa', 'zh-Hant-x-lzh': '差事', 'zh-Hans-x-lzh': '差事' },
  fieldStage: { en: 'Stage', 'zh-CN': '阶段', 'zh-TW': '階段', ja: '段階', ko: '단계',
    es: 'Etapa', fr: 'Étape', de: 'Phase', 'pt-PT': 'Etapa', 'pt-BR': 'Etapa', 'zh-Hant-x-lzh': '段', 'zh-Hans-x-lzh': '段' },
  fieldReason: { en: 'Blocking reason', 'zh-CN': '阻塞原因', 'zh-TW': '阻塞原因', ja: 'ブロックの理由', ko: '막힌 이유',
    es: 'Motivo del bloqueo', fr: 'Raison du blocage', de: 'Grund der Blockade', 'pt-PT': 'Motivo do bloqueio', 'pt-BR': 'Motivo do bloqueio', 'zh-Hant-x-lzh': '阻塞之由', 'zh-Hans-x-lzh': '阻塞之由' },
  fieldUnblock: { en: 'Unblock condition', 'zh-CN': '解除条件', 'zh-TW': '解除條件', ja: '解除条件', ko: '해제 조건',
    es: 'Condición para desbloquear', fr: 'Condition de déblocage', de: 'Bedingung zum Entsperren', 'pt-PT': 'Condição para desbloquear', 'pt-BR': 'Condição para desbloquear', 'zh-Hant-x-lzh': '解除之則', 'zh-Hans-x-lzh': '解除之则' },
  fieldResolution: { en: 'Resolution note', 'zh-CN': '解除说明', 'zh-TW': '解除說明', ja: '解除の説明', ko: '해제 설명',
    es: 'Nota de desbloqueo', fr: 'Note de déblocage', de: 'Notiz zur Entsperrung', 'pt-PT': 'Nota de desbloqueio', 'pt-BR': 'Nota de desbloqueio', 'zh-Hant-x-lzh': '解除之述', 'zh-Hans-x-lzh': '解除之述' },
  fieldNote: { en: 'Completion note', 'zh-CN': '完成确认说明', 'zh-TW': '完成確認說明', ja: '完了確認の説明', ko: '완료 확인 설명',
    es: 'Nota de confirmación', fr: 'Note de confirmation', de: 'Bestätigungsnotiz', 'pt-PT': 'Nota de confirmação', 'pt-BR': 'Nota de confirmação', 'zh-Hant-x-lzh': '完成之述', 'zh-Hans-x-lzh': '完成之述' },
  fieldAssignee: { en: 'Assignee', 'zh-CN': '处理人', 'zh-TW': '處理人', ja: '担当', ko: '담당자',
    es: 'Responsable', fr: 'Responsable', de: 'Zuständige Person', 'pt-PT': 'Responsável', 'pt-BR': 'Responsável', 'zh-Hant-x-lzh': '司事', 'zh-Hans-x-lzh': '司事' },
  assigneeNone: { en: 'Unassigned', 'zh-CN': '未分配', 'zh-TW': '未分配', ja: '未割り当て', ko: '미지정',
    es: 'Sin asignar', fr: 'Non attribué', de: 'Nicht zugewiesen', 'pt-PT': 'Não atribuído', 'pt-BR': 'Não atribuído', 'zh-Hant-x-lzh': '未定', 'zh-Hans-x-lzh': '未定' },
  confirmArchiveTitle: { en: 'Archive this project?', 'zh-CN': '归档项目？', 'zh-TW': '封存專案？', ja: 'このプロジェクトをアーカイブしますか？', ko: '프로젝트를 보관할까요?',
    es: '¿Archivar este proyecto?', fr: 'Archiver ce projet ?', de: 'Dieses Projekt archivieren?', 'pt-PT': 'Arquivar este projeto?', 'pt-BR': 'Arquivar este projeto?', 'zh-Hant-x-lzh': '封存此案？', 'zh-Hans-x-lzh': '封存此案？' },
  confirmArchiveBody: { en: 'Archived projects cannot take new tasks or run automatically; members and progress stay readable.',
    'zh-CN': '归档后不能新建任务，也不会再自动运行；成员与进度仍可查看。',
    'zh-TW': '封存後不能新建任務，也不會再自動執行；成員與進度仍可查看。',
    ja: 'アーカイブ後は新しいタスクを作成できず、自動実行も止まります。メンバーと進捗は引き続き確認できます。',
    ko: '보관 후에는 새 작업을 만들 수 없고 자동 실행도 멈춥니다. 멤버와 진행 상황은 계속 볼 수 있어요.',
    es: 'Los proyectos archivados no admiten tareas nuevas ni se ejecutan solos; los miembros y el avance siguen visibles.',
    fr: "Un projet archivé n'accepte plus de nouvelles tâches et ne s'exécute plus automatiquement ; les membres et l'avancement restent visibles.",
    de: 'Archivierte Projekte nehmen keine neuen Aufgaben mehr an und laufen nicht mehr automatisch; Mitglieder und Fortschritt bleiben sichtbar.',
    'pt-PT': 'Projetos arquivados não aceitam novas tarefas nem são executados automaticamente; membros e progresso continuam visíveis.',
    'pt-BR': 'Projetos arquivados não aceitam novas tarefas nem são executados automaticamente; membros e progresso continuam visíveis.',
    'zh-Hant-x-lzh': '封存後不可新立差事，亦不復自行；同人與進度仍可覽。', 'zh-Hans-x-lzh': '封存后不可新立差事，亦不复自行；同人与进度仍可览。' },
  confirmArchiveLabel: { en: 'Archive', 'zh-CN': '归档', 'zh-TW': '封存', ja: 'アーカイブ', ko: '보관',
    es: 'Archivar', fr: 'Archiver', de: 'Archivieren', 'pt-PT': 'Arquivar', 'pt-BR': 'Arquivar', 'zh-Hant-x-lzh': '封存', 'zh-Hans-x-lzh': '封存' },
  ownerLabel: { en: 'Owner', 'zh-CN': '负责人', 'zh-TW': '負責人', ja: 'オーナー', ko: '소유자',
    es: 'Responsable', fr: 'Responsable', de: 'Verantwortlich', 'pt-PT': 'Responsável', 'pt-BR': 'Responsável', 'zh-Hant-x-lzh': '主事', 'zh-Hans-x-lzh': '主事' },
  updatedLabel: { en: 'Updated', 'zh-CN': '更新于', 'zh-TW': '更新於', ja: '更新日時', ko: '업데이트',
    es: 'Actualizado', fr: 'Mis à jour', de: 'Aktualisiert', 'pt-PT': 'Atualizado', 'pt-BR': 'Atualizado', 'zh-Hant-x-lzh': '更新於', 'zh-Hans-x-lzh': '更新于' },
  noGoal: { en: 'No goal', 'zh-CN': '未填写目标', 'zh-TW': '未填寫目標', ja: '目標は未設定', ko: '목표 없음',
    es: 'Sin objetivo', fr: 'Aucun objectif', de: 'Kein Ziel', 'pt-PT': 'Sem objetivo', 'pt-BR': 'Sem objetivo', 'zh-Hant-x-lzh': '未定其標', 'zh-Hans-x-lzh': '未定其标' },
} satisfies Record<string, Copy>;

const STAGE_COPY: Readonly<Record<WorkItemStatus, Copy>> = {
  todo: COPY.stageTodo,
  doing: COPY.stageDoing,
  blocked: COPY.stageBlocked,
  review: COPY.stageReview,
  done: COPY.stageDone,
};

function fill(template: string, vars: Record<string, string | number> = {}): string {
  return template.replace(/\{(\w+)\}/g, (match, key: string) => (key in vars ? String(vars[key]) : match));
}

function localized(copy: Copy, vars: Record<string, string | number> = {}): RemoteLocalizedText {
  const { en, ...rest } = copy;
  return {
    fallback: fill(en, vars),
    translations: Object.fromEntries(Object.entries(rest).map(([locale, text]) => [locale, fill(text, vars)])),
  };
}

/** 一份文案在控制端语言下的文本；`fallbackMarkdown` 也按控制端语言写，不混语言。 */
function text(copy: Copy, locale?: string, vars: Record<string, string | number> = {}): string {
  return resolveRemoteText(localized(copy, vars), locale);
}

function clip(value: string, max: number): string {
  const trimmed = value.trim();
  return trimmed.length > max ? `${trimmed.slice(0, max - 1)}…` : trimmed;
}

function recordOf(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
}

function projectRef(id: string): RemoteResourceRef {
  return { collectionId: PROJECT_REMOTE_COLLECTION_ID, kind: PROJECT_REMOTE_RESOURCE_KIND, id };
}

/**
 * 主体投影：伙伴名由 main 从 `bot_profiles` 解析；账号昵称 main 没有权威来源，
 * 解析不到时给可读兜底（「某位成员」），绝不把内部 id 当名字显示。
 */
function subjectPayload(
  ref: { kind: string; id: string; displayName?: string | null } | null,
  fallback: string,
): { kind: string; id: string; name: string } | null {
  if (!ref) return null;
  const name = typeof ref.displayName === 'string' ? ref.displayName.trim() : '';
  return { kind: ref.kind, id: ref.id, name: name ? clip(name, MAX_NAME_CHARS) : fallback };
}

function goalFirstLine(goal: string | null | undefined): string | undefined {
  if (typeof goal !== 'string') return undefined;
  const line = goal.split(/\r?\n/).map((part) => part.trim()).find((part) => part.length > 0);
  return line ? clip(line, 160) : undefined;
}

function timestamp(iso: string | null | undefined): number | undefined {
  if (typeof iso !== 'string') return undefined;
  const value = Date.parse(iso);
  return Number.isFinite(value) ? value : undefined;
}

function readId(value: unknown, label: string): string {
  if (typeof value !== 'string' || !value.trim() || value.length > MAX_ID_CHARS || /\s/.test(value)) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', `invalid ${label}`);
  }
  return value;
}

function readOptionalInt(value: unknown, label: string): number | undefined {
  if (value === undefined || value === null) return undefined;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', `invalid ${label}`);
  }
  return value;
}

function readNote(value: unknown, label: string): string | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== 'string' || value.length > MAX_NOTE_CHARS) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', `invalid ${label}`);
  }
  const trimmed = value.trim();
  return trimmed ? trimmed : null;
}

function readStage(value: unknown): WorkItemStatus {
  if (typeof value !== 'string' || !(WORK_ITEM_STATUSES as readonly string[]).includes(value)) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid stage');
  }
  return value as WorkItemStatus;
}

/**
 * 处理人入参：`{kind,id}`（契约 §4 的形状）或 select 的字符串句柄 `kind|id`；
 * `null` / 缺省 = 未分配，绝不回落到负责人。
 */
function readAssignee(value: unknown): ProjectSubjectRef | null {
  if (value === undefined || value === null) return null;
  if (typeof value === 'string') {
    const separator = value.indexOf('|');
    const kind = separator > 0 ? value.slice(0, separator) : '';
    const id = separator > 0 ? value.slice(separator + 1) : '';
    if ((kind !== 'account' && kind !== 'bot') || !id || id.length > MAX_ID_CHARS) {
      throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid assignee');
    }
    return { kind, id };
  }
  const body = recordOf(value);
  const kind = body.kind;
  if (kind !== 'account' && kind !== 'bot') {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid assignee kind');
  }
  return { kind, id: readId(body.id, 'assignee.id') };
}

function assigneeHandle(subject: { kind: string; id: string }): string {
  // select 的 option value 必须是字符串；用 `|` 而不是 `:`，避免出现契约禁止的
  // `account:` / `bot:` 原始 id 形状。
  return `${subject.kind}|${subject.id}`;
}

function sameSubject(
  left: { kind: string; id: string } | null,
  right: { kind: string; id: string } | null,
): boolean {
  if (!left || !right) return left === right;
  return left.kind === right.kind && left.id === right.id;
}

/** IPC / worker 的错误码只用来翻译成契约里的对外码，不改写它们自己的判定。 */
function projectErrorCode(error: unknown): string {
  if (isIpcError(error)) return error.code;
  const message = error instanceof Error ? error.message : '';
  return /^\[([A-Z_]+)\]/.exec(message)?.[1] ?? '';
}

const PRECONDITION_CODES = new Set([
  'PRECONDITION_FAILED',
  'REVISION_CONFLICT',
  'BINDING_CONFLICT',
  'ILLEGAL_TRANSITION',
  'REQUEST_CONFLICT',
  'PROJECT_MISMATCH',
  'SESSION_DELETED',
  'PROJECT_TASK_UNBOUND',
]);

const INVALID_PARAM_CODES = new Set([
  'INVALID_PARAMS',
  'REASON_REQUIRED',
  'UNBLOCK_CONDITION_REQUIRED',
  'RESOLUTION_REQUIRED',
  'COMPLETION_NOTE_REQUIRED',
  'ASSIGNEE_NOT_MEMBER',
  'PROJECT_ARCHIVED',
  'PROJECT_NOT_FOUND',
]);

/**
 * 把内部错误翻成契约 §4 的对外码。具体内部码留在 message 里（手机据此显示更细的原因），
 * 但 `code` 只用既有对外码，控制端不会因为看到内部词而误判。
 */
function refusal(error: unknown, projectId: string): never {
  const code = projectErrorCode(error);
  if (code === 'NOT_PROJECT_MEMBER' || code === 'NOT_PROJECT_OWNER' || code === 'NOT_FOUND') {
    throw new RemoteResourceRegistryError(code, code);
  }
  // 进度事务用 FORBIDDEN 表示「当前成员资格不允许」：对外它就是「不是成员」。
  if (code === 'FORBIDDEN') throw new RemoteResourceRegistryError('NOT_PROJECT_MEMBER', 'NOT_PROJECT_MEMBER');
  if (PRECONDITION_CODES.has(code)) {
    throw new RemoteResourceRegistryError('PRECONDITION_FAILED', code || 'PRECONDITION_FAILED');
  }
  if (INVALID_PARAM_CODES.has(code)) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', code);
  }
  if (code) throw new RemoteResourceRegistryError('INVALID_PARAMS', code);
  log.warn('project remote action failed', { projectId, error: error instanceof Error ? error.message : String(error) });
  throw new RemoteResourceRegistryError('INTERNAL', 'project action failed');
}

interface ProjectAuthority {
  client: DbClient;
  subject: ProjectSubjectRef;
  assertCurrent(): void;
}

/** 每次调用都重新捕获：账号切换期间的读与写都作废，绝不用上一次的 owner 授权。 */
function captureAuthority(): ProjectAuthority {
  const owner = getCurrentDbClientSnapshot();
  if (!owner?.userId) {
    throw new RemoteResourceRegistryError('PRECONDITION_FAILED', 'project data is unavailable');
  }
  const scope = captureDataOwnerBroadcastScope();
  const subject: ProjectSubjectRef = { kind: 'account', id: owner.userId };
  const assertCurrent = (): void => {
    if (getCurrentDbClientSnapshot() !== owner || !isDataOwnerBroadcastScopeCurrent(scope)) {
      throw new RemoteResourceRegistryError('NOT_FOUND', 'account changed');
    }
  };
  assertCurrent();
  return { client: owner.client, subject, assertCurrent };
}

/** 契约 §3：进度块与工作项状态来自同一个权威读（事务内先证成员资格）。 */
async function readProgress(authority: ProjectAuthority, projectId: string): Promise<ProjectProgressReadResult> {
  try {
    return await authority.client.tx('projectProgress.read', {
      request: { projectId },
      context: { actor: authority.subject },
    });
  } catch (error) {
    return refusal(error, projectId);
  }
}

/** 读详情：`NOT_PROJECT_MEMBER` / `NOT_FOUND` 原样对外，其它内部错不泄漏。 */
async function readDetail(authority: ProjectAuthority, projectId: string) {
  try {
    return await readProjectDetail(projectId, authority.subject, authority.client);
  } catch (error) {
    return refusal(error, projectId);
  }
}

function progressByItem(progress: ProjectProgressReadResult): Map<string, ProjectProgressApiItem> {
  return new Map(progress.items.map((item) => [item.sessionId, item]));
}

function itemStage(item: ProjectProgressApiItem | undefined): WorkItemStatus {
  // 没有进度记录就是「未开始」：手机端 5 档计数必须闭合，不引入第 6 档。
  return item?.progress?.status ?? 'todo';
}

interface GroupLinkView {
  groupName: string;
  status: string;
  revision: number;
}

/**
 * 关联群（只读）：走既有 `list-project` 读（成员资格 + 本机 + 当前账号三重封闭）。
 * 群名只从本机 `bot_groups` 解析；解析不到给可读兜底，**绝不**回退成 roomId 或端点。
 */
async function readGroupLink(authority: ProjectAuthority, projectId: string): Promise<GroupLinkView | null> {
  try {
    const result = await readProjectGroupLinksByProject({ action: 'list-project', projectId });
    if (!result.ok || result.links.length === 0) return null;
    const [link] = result.links;
    const row = await authority.client
      .queryOne<{ name: string }>('SELECT name FROM bot_groups WHERE id = ?', [link.group.roomId])
      .catch(() => undefined);
    const name = typeof row?.name === 'string' ? row.name.trim() : '';
    return {
      groupName: name ? clip(name, MAX_NAME_CHARS) : fill(COPY.groupFallback.en),
      status: link.status,
      revision: link.revision,
    };
  } catch {
    // 关联群是附加信息：读不到就是没有这一块，不让整页详情失败。
    return null;
  }
}

function summaryMarkdown(record: ProjectRecord, locale?: string): string {
  const owner = record.members.find((member) => member.role === 'owner');
  const ownerName = owner?.subject.displayName?.trim() || text(COPY.memberFallback, locale);
  return [
    `**${clip(record.name, MAX_NAME_CHARS)}** — ${text(record.status === 'archived' ? COPY.statusArchived : COPY.statusActive, locale)}`,
    goalFirstLine(record.goal) ?? text(COPY.noGoal, locale),
    `${text(COPY.ownerLabel, locale)}: ${ownerName}`,
    `${text(COPY.updatedLabel, locale)}: ${record.updatedAt}`,
  ].join('\n').slice(0, MAX_FALLBACK_CHARS);
}

function progressMarkdown(
  counts: Record<WorkItemStatus, number>,
  events: readonly ProjectProgressApiHistoryEntry[],
  titles: ReadonlyMap<string, string>,
  locale?: string,
): string {
  const head = WORK_ITEM_STATUSES.map((stage) => `${text(STAGE_COPY[stage], locale)} ${counts[stage]}`).join(' · ');
  const lines = events.map((event) => {
    const title = titles.get(event.sessionId) ?? event.sessionId;
    const from = event.from ? text(STAGE_COPY[event.from], locale) : '—';
    const note = event.completionNote ?? event.resolution ?? event.reason ?? event.unblockCondition;
    const actor = event.actor.displayName?.trim() || text(COPY.memberFallback, locale);
    return `- ${clip(title, 120)}: ${from} → ${text(STAGE_COPY[event.to], locale)} (${actor})${note ? ` — ${clip(note, 200)}` : ''}`;
  });
  return [head, ...lines].join('\n').slice(0, MAX_FALLBACK_CHARS);
}

function workItemsMarkdown(
  rows: readonly { title: string; stage: WorkItemStatus; assignee: { displayName?: string | null } | null }[],
  locale?: string,
): string {
  return rows
    .map((row) => `- ${clip(row.title, 120)} — ${text(STAGE_COPY[row.stage], locale)} · ${
      row.assignee?.displayName?.trim() || text(COPY.assigneeNone, locale)}`)
    .join('\n')
    .slice(0, MAX_FALLBACK_CHARS);
}

export function projectRemoteItem(record: ProjectRecord): RemoteCollectionItem {
  const updatedAt = timestamp(record.updatedAt);
  const subtitle = goalFirstLine(record.goal);
  return {
    ref: projectRef(record.id),
    display: {
      title: clip(record.name, MAX_NAME_CHARS),
      ...(subtitle ? { subtitle } : {}),
      status: {
        label: localized(record.status === 'archived' ? COPY.statusArchived : COPY.statusActive),
        tone: record.status === 'archived' ? 'neutral' : 'positive',
      },
      ...(updatedAt === undefined ? {} : { timestamp: updatedAt }),
      badges: [
        { label: localized(COPY.members, { count: record.members.length }), accessibilityLabel: localized(COPY.members, { count: record.members.length }) },
        { label: localized(COPY.tasks, { count: record.taskCount }), accessibilityLabel: localized(COPY.tasks, { count: record.taskCount }) },
      ],
    },
    links: [],
    // 契约 §1：不透明字符串，控制器只比较不解释；列表行跟着 `updated_at` 走。
    revision: updatedAt === undefined ? String(record.updatedAt) : String(updatedAt),
    // 契约 §2：列表不挂动作，动作只在详情上。
    actions: [],
  };
}

function projectActions(record: ProjectRecord, workItems: readonly ProjectWorkItem[]): RemoteActionDescriptor[] {
  const archived = record.status === 'archived';
  const taskOptions = workItems.slice(0, MAX_WORK_ITEMS).map((item) => ({ value: item.sessionId, label: clip(item.title, 120) || item.sessionId }));
  const noTasks = taskOptions.length === 0;
  return [
    {
      id: ACTION_IDS.recordProgress,
      label: localized(COPY.actionProgress),
      ...(noTasks ? { disabled: true } : {}),
      fields: [
        { id: 'sessionId', label: localized(COPY.fieldTask), kind: 'select', required: true, options: taskOptions },
        {
          id: 'to',
          label: localized(COPY.fieldStage),
          kind: 'select',
          required: true,
          options: WORK_ITEM_STATUSES.map((stage) => ({ value: stage, label: localized(STAGE_COPY[stage]) })),
        },
        { id: 'reason', label: localized(COPY.fieldReason), kind: 'multiline' },
        { id: 'unblockCondition', label: localized(COPY.fieldUnblock), kind: 'multiline' },
        { id: 'resolution', label: localized(COPY.fieldResolution), kind: 'multiline' },
        { id: 'completionNote', label: localized(COPY.fieldNote), kind: 'multiline' },
      ],
    },
    {
      id: ACTION_IDS.setAssignee,
      label: localized(COPY.actionAssignee),
      ...(archived || noTasks ? { disabled: true } : {}),
      fields: [
        { id: 'sessionId', label: localized(COPY.fieldTask), kind: 'select', required: true, options: taskOptions },
        {
          id: 'assignee',
          label: localized(COPY.fieldAssignee),
          kind: 'select',
          required: true,
          options: [
            { value: 'none', label: localized(COPY.assigneeNone) },
            ...record.members.slice(0, MAX_MEMBERS).map((member) => ({
              value: assigneeHandle(member.subject),
              label: member.subject.displayName?.trim() || localized(COPY.memberFallback),
            })),
          ],
        },
      ],
    },
    {
      id: ACTION_IDS.archive,
      label: localized(COPY.actionArchive),
      tone: 'destructive',
      ...(archived ? { disabled: true } : {}),
      confirmation: {
        title: localized(COPY.confirmArchiveTitle),
        body: localized(COPY.confirmArchiveBody),
        confirmLabel: localized(COPY.confirmArchiveLabel),
      },
    },
    {
      id: ACTION_IDS.unarchive,
      label: localized(COPY.actionUnarchive),
      ...(archived ? {} : { disabled: true }),
    },
  ];
}

/** 详情：五个 block 按契约 §3 的顺序；旧控制器只读 fallbackMarkdown。 */
export function projectRemoteResource(input: {
  record: ProjectRecord;
  workItems: readonly ProjectWorkItem[];
  progress: ProjectProgressReadResult;
  groupLink: GroupLinkView | null;
  locale?: string;
}): RemoteResource {
  const { record, progress, groupLink, locale } = input;
  const byItem = progressByItem(progress);
  // 工作项名单以详情读为准（它带着 `taskObjective`），进度状态与版本按 sessionId 合并。
  const workItems = input.workItems.slice(0, MAX_WORK_ITEMS);
  const rows = workItems.map((item) => ({
    item,
    stage: itemStage(byItem.get(item.sessionId)),
  }));
  const counts = summarizeWorkItems(rows.map((row) => ({ status: row.stage }))).counts;
  const events = progress.history.slice(0, MAX_PROGRESS_EVENTS);
  const titles = new Map(workItems.map((item) => [item.sessionId, item.title]));
  const owner = record.members.find((member) => member.role === 'owner');
  const memberFallback = text(COPY.memberFallback, locale);

  const blocks: NonNullable<RemoteResource['blocks']> = [
    {
      id: 'summary',
      primitive: 'project-summary',
      title: localized(COPY.blockSummary),
      fallbackMarkdown: summaryMarkdown(record, locale),
      data: {
        projectId: record.id,
        name: record.name,
        goal: record.goal,
        owner: subjectPayload(owner?.subject ?? null, memberFallback)
          ?? { kind: 'account', id: record.ownerId, name: memberFallback },
        status: record.status,
        updatedAt: timestamp(record.updatedAt) ?? 0,
      },
    },
    {
      id: 'progress',
      primitive: 'project-progress',
      title: localized(COPY.blockProgress),
      fallbackMarkdown: progressMarkdown(counts, events, titles, locale),
      data: {
        counts,
        events: events.map((event) => {
          const title = titles.get(event.sessionId);
          const note = event.completionNote ?? event.resolution ?? event.reason ?? event.unblockCondition;
          return {
            id: String(event.eventId),
            sessionId: event.sessionId,
            ...(title ? { title: clip(title, 160) } : {}),
            from: event.from,
            to: event.to,
            at: event.createdAt,
            actorName: event.actor.displayName?.trim() || memberFallback,
            actorKind: event.actor.kind,
            actorId: event.actor.id,
            ...(note ? { note: clip(note, MAX_NOTE_CHARS) } : {}),
          };
        }),
      },
    },
    {
      id: 'work-items',
      primitive: 'project-work-items',
      title: localized(COPY.blockWorkItems),
      fallbackMarkdown: workItemsMarkdown(rows.map((row) => ({
        title: row.item.title,
        stage: row.stage,
        assignee: row.item.assignee,
      })), locale),
      data: {
        items: workItems.map((item) => {
          const progressItem = byItem.get(item.sessionId);
          const stage = itemStage(progressItem);
          const objective = typeof item.taskObjective === 'string' && item.taskObjective.trim()
            ? item.taskObjective.trim()
            : undefined;
          return {
            sessionId: item.sessionId,
            title: item.title,
            ...(objective ? { taskObjective: objective } : {}),
            status: stage,
            assignee: subjectPayload(item.assignee, memberFallback),
            bindingRevision: progressItem?.bindingRevision ?? item.bindingRevision ?? 0,
            updatedAt: progressItem?.progress?.updatedAt ?? timestamp(item.updatedAt) ?? 0,
            // 追加字段（契约允许新增字段）：手机要严格绑定进度版本时用它，不传时
            // host 按当前权威读推导，见 `recordProgress`。
            progressRevision: progressItem?.progress?.revision ?? 0,
          };
        }),
      },
    },
    {
      id: 'members',
      primitive: 'project-members',
      title: localized(COPY.blockMembers),
      fallbackMarkdown: record.members
        .slice(0, MAX_MEMBERS)
        .map((member) => `- ${member.subject.displayName?.trim() || text(COPY.memberFallback, locale)}`)
        .join('\n')
        .slice(0, MAX_FALLBACK_CHARS),
      data: {
        members: record.members.slice(0, MAX_MEMBERS).map((member) => ({
          ...subjectPayload(member.subject, memberFallback),
          role: member.role,
        })),
      },
    },
  ];

  if (groupLink) {
    blocks.push({
      id: 'group-link',
      primitive: 'project-group-link',
      title: localized(COPY.blockGroup),
      fallbackMarkdown: `${groupLink.groupName} — ${groupLink.status}`.slice(0, MAX_FALLBACK_CHARS),
      data: { groupName: groupLink.groupName, status: groupLink.status, revision: groupLink.revision },
    });
  }

  const item = projectRemoteItem(record);
  return {
    ...item,
    // 详情 revision 必须覆盖写动作会改到的状态：进度写入不动 `projects.updated_at`，
    // 所以把最新进度事件代数与关联群版本一并编进这个不透明串。
    revision: [
      item.revision,
      progress.history[0]?.eventId ?? 0,
      workItems.reduce((max, current) => Math.max(max, byItem.get(current.sessionId)?.progress?.revision ?? 0), 0),
      groupLink?.revision ?? 0,
    ].join('.'),
    actions: projectActions(record, workItems),
    blocks,
  };
}

interface Receipt {
  signature: string;
  response: RemoteActionInvokeResponse;
  expiresAt: number;
}

/**
 * `requestId` 幂等回执：只防「同一个请求重放两次」。它**不是**授权凭据——
 * 命中回执也只在同一个 owner 下才可能命中，且每次真正的写入都重新判权限。
 */
const receipts = new Map<string, Receipt>();

function receiptKey(ownerId: string, actionId: string, requestId: string): string {
  return `${ownerId}\u0000${actionId}\u0000${requestId}`;
}

function readReceipt(key: string, signature: string, now: number): RemoteActionInvokeResponse | null {
  const receipt = receipts.get(key);
  if (!receipt) return null;
  if (receipt.expiresAt <= now) {
    receipts.delete(key);
    return null;
  }
  if (receipt.signature !== signature) {
    // 同一个 requestId 换了内容：不是重放，是一次自相矛盾的请求。
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'REQUEST_CONFLICT');
  }
  return receipt.response;
}

function writeReceipt(key: string, signature: string, response: RemoteActionInvokeResponse, now: number): void {
  if (receipts.size >= MAX_RECEIPTS) {
    for (const [candidate, receipt] of receipts) {
      if (receipt.expiresAt <= now) receipts.delete(candidate);
    }
    // 仍然超额时丢掉最老的一批：回执只是重放保护，丢一条只多写一次同样的状态。
    while (receipts.size >= MAX_RECEIPTS) {
      const oldest = receipts.keys().next();
      if (oldest.done) break;
      receipts.delete(oldest.value);
    }
  }
  receipts.set(key, { signature, response, expiresAt: now + RECEIPT_TTL_MS });
}

/** 只在内存里留下一代回执；测试与账号切换都从这里清。 */
export function resetProjectRemoteReceipts(): void {
  receipts.clear();
}

function requestIdOf(input: Record<string, unknown>, authority: ProjectAuthority, actionId: string): string {
  const supplied = input.requestId;
  if (supplied === undefined || supplied === null) {
    // 老控制器不一定带 `requestId`：用「同一次动作 + 同一份输入」派生一个稳定键，
    // 这样它的重试仍然幂等，不必逼所有控制端先升级。
    const canonical = JSON.stringify([authority.subject.id, actionId, stableKey(input)]);
    return `auto-${hash(canonical)}`;
  }
  if (typeof supplied !== 'string' || !supplied.trim() || supplied.length > MAX_REQUEST_ID_CHARS) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid requestId');
  }
  return supplied;
}

function stableKey(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableKey);
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value as Record<string, unknown>)
      .filter(([key]) => key !== 'requestId')
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, entry]) => [key, stableKey(entry)]));
  }
  return value;
}

function hash(value: string): string {
  let state = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    state ^= value.charCodeAt(index);
    state = Math.imul(state, 0x01000193) >>> 0;
  }
  return state.toString(16).padStart(8, '0');
}

function broadcastProjectChanged(projectId: string): void {
  try {
    tapWindowBroadcast(REMOTE_RESOURCE_CHANGED_CHANNEL, {
      collectionId: PROJECT_REMOTE_COLLECTION_ID,
      resourceRefs: [projectRef(projectId)],
    }, getSafeDataOwnerPushStamp());
  } catch (error) {
    // 通知失败不能把已经落库的写入变成失败请求。
    log.warn('project remote resource invalidation failed', { error: error instanceof Error ? error.message : String(error) });
  }
}

/**
 * 成功的回包只带结果（`eventId` / `revision` / `replayed` 等），刷新由 `invoke` 结束时那一次
 * `REMOTE_RESOURCE_CHANGED` 广播驱动：契约 §6 只选一种，不在这里再给 refresh effect。
 */
function success(result: Record<string, unknown>): RemoteActionInvokeResponse {
  return { result: { ok: true, ...result }, effects: [] };
}

/** 契约 §4 的 `project.recordProgress`：复用既有进度事务与角色判定。 */
async function recordProgress(
  authority: ProjectAuthority,
  projectId: string,
  input: Record<string, unknown>,
  requestId: string,
): Promise<RemoteActionInvokeResponse> {
  const sessionId = readId(input.sessionId, 'sessionId');
  const to = readStage(input.to);
  const detail = await readDetail(authority, projectId);
  if (!detail.workItems.some((item) => item.sessionId === sessionId)) {
    throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
  }
  const progress = await readProgress(authority, projectId);
  const item = progressByItem(progress).get(sessionId);
  if (!item) throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
  // 同一阶段的重复提交不再造一条事件：控制器重试（尤其是不带 requestId 的老控制器）
  // 不该把「还在进行中」写成两条历史。
  if (item.progress?.status === to) {
    return success({
      sessionId,
      eventId: item.progress.completionEventId,
      revision: item.progress.revision,
      replayed: true,
    });
  }
  const intent: WorkItemProgressIntent = {
    projectId,
    sessionId,
    // 控制器给了版本就严格按它判并发；没给就按此刻的权威读推导（老控制器只能这样）。
    expectedRevision: readOptionalInt(input.expectedRevision, 'expectedRevision') ?? item.progress?.revision ?? 0,
    expectedBindingRevision: readOptionalInt(input.expectedBindingRevision, 'expectedBindingRevision') ?? item.bindingRevision,
    requestId,
    to,
    reason: readNote(input.reason, 'reason'),
    unblockCondition: readNote(input.unblockCondition, 'unblockCondition'),
    resolution: readNote(input.resolution, 'resolution'),
    completionNote: readNote(input.completionNote, 'completionNote'),
  };
  let result: WorkItemProgressResult;
  try {
    result = await authority.client.tx('workItemProgress.execute', {
      intent,
      context: { actor: authority.subject, now: Date.now() },
    });
  } catch (error) {
    const code = projectErrorCode(error);
    // 事务里的 FORBIDDEN 对非成员与「普通成员确认完成」是同一个码；非成员已在上面
    // 用同一个成员判据拒绝过，所以这里剩下的就是「只有负责人能确认完成」。
    if (code === 'FORBIDDEN') {
      throw new RemoteResourceRegistryError(
        to === 'done' ? 'NOT_PROJECT_OWNER' : 'NOT_PROJECT_MEMBER',
        to === 'done' ? 'NOT_PROJECT_OWNER' : 'NOT_PROJECT_MEMBER',
      );
    }
    if (code === 'PROJECT_MISMATCH') throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
    return refusal(error, projectId);
  }
  return success({
    sessionId,
    eventId: result.eventId,
    revision: result.revision,
    replayed: result.replayed,
  });
}

/** 契约 §4 的 `project.setAssignee`：复用 `mutateProjects({action:'setAssignee'})`。 */
async function setAssignee(
  authority: ProjectAuthority,
  projectId: string,
  input: Record<string, unknown>,
): Promise<RemoteActionInvokeResponse> {
  const sessionId = readId(input.sessionId, 'sessionId');
  const assignee = readAssignee(input.assignee);
  const progress = await readProgress(authority, projectId);
  const item = progressByItem(progress).get(sessionId);
  // 只认这个项目自己的任务：手机上打开项目 A 的详情，不能顺手改到项目 B 的任务。
  if (!item || item.projectId !== projectId) throw new RemoteResourceRegistryError('NOT_FOUND', 'NOT_FOUND');
  if (sameSubject(item.assignee, assignee)) {
    return success({ sessionId, replayed: true });
  }
  try {
    await mutateProjects({ action: 'setAssignee', sessionId, assignee }, authority.subject, authority.client);
  } catch (error) {
    return refusal(error, projectId);
  }
  return success({ sessionId, replayed: false });
}

/** 契约 §4 的归档 / 恢复：负责人专属，走既有 `update` 变更而不是新路径。 */
async function setArchived(
  authority: ProjectAuthority,
  projectId: string,
  archived: boolean,
  input: Record<string, unknown>,
): Promise<RemoteActionInvokeResponse> {
  // 归档是破坏性动作：契约要求二次确认。控制端必须显式带 `confirmation: true`
  // 才是它在界面上问过用户；值本身不是授权，权限仍由 `requireProjectAction` 判。
  if (archived && input.confirmation !== true) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'CONFIRMATION_REQUIRED');
  }
  try {
    await requireProjectAction('updateProject', projectId, authority.subject, authority.client);
  } catch (error) {
    return refusal(error, projectId);
  }
  const detail = await readDetail(authority, projectId);
  if ((detail.project.status === 'archived') === archived) {
    return success({ replayed: true });
  }
  try {
    await mutateProjects(
      { action: 'update', projectId, status: archived ? 'archived' : 'active' },
      authority.subject,
      authority.client,
    );
  } catch (error) {
    return refusal(error, projectId);
  }
  return success({ replayed: false });
}

function readListLimit(value: unknown): number {
  if (value === undefined || value === null) return DEFAULT_LIST_LIMIT;
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 1) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid limit');
  }
  return Math.min(value, MAX_LIST_LIMIT);
}

function readCursor(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  if (typeof value !== 'string' || !/^\d{1,9}$/.test(value)) {
    throw new RemoteResourceRegistryError('INVALID_PARAMS', 'invalid cursor');
  }
  return Number(value);
}

let registered = false;

export function registerProjectRemoteResourceProvider(): void {
  if (registered) return;
  registered = true;
  remoteResourceRegistry.register({
    collection: {
      id: PROJECT_REMOTE_COLLECTION_ID,
      resourceKind: PROJECT_REMOTE_RESOURCE_KIND,
      title: localized(COPY.title),
      // 手机首页设备卡只合并 `home-scope` 集合；不新开一级 tab（契约 §7）。
      placement: 'home-scope',
      icon: { name: 'folder', fallbackText: '项' },
    },

    async list(_context, request): Promise<RemoteCollectionListResponse> {
      const authority = captureAuthority();
      const limit = readListLimit(request.limit);
      const offset = readCursor(request.cursor);
      let records: ProjectRecord[];
      try {
        records = await listProjects(authority.subject, authority.client);
      } catch (error) {
        return refusal(error, 'list');
      }
      authority.assertCurrent();
      const query = request.query?.trim().toLocaleLowerCase() ?? '';
      const matched = query
        ? records.filter((record) => [record.name, record.goal ?? '']
          .some((value) => value.toLocaleLowerCase().includes(query)))
        : records;
      // 契约 §2：按 `updated_at` 降序（同名按名称稳定排序）。
      const sorted = matched.slice().sort((left, right) =>
        (timestamp(right.updatedAt) ?? 0) - (timestamp(left.updatedAt) ?? 0)
        || left.name.localeCompare(right.name));
      const page = sorted.slice(offset, offset + limit);
      const items = page.map(projectRemoteItem);
      const next = offset + limit < sorted.length ? String(offset + limit) : undefined;
      return {
        collectionId: PROJECT_REMOTE_COLLECTION_ID,
        revision: items.map((item) => item.revision).join('|'),
        items,
        ...(next ? { nextCursor: next } : {}),
      };
    },

    async get(_context, request): Promise<RemoteResource> {
      const authority = captureAuthority();
      const projectId = request.ref.id;
      const detail = await readDetail(authority, projectId);
      const progress = await readProgress(authority, projectId);
      const groupLink = await readGroupLink(authority, projectId);
      authority.assertCurrent();
      return projectRemoteResource({
        record: detail.project,
        workItems: detail.workItems,
        progress,
        groupLink,
        ...(request.client.locale ? { locale: request.client.locale } : {}),
      });
    },

    async invoke(_context, request): Promise<RemoteActionInvokeResponse> {
      const actionId = request.actionId;
      if (!PROJECT_ACTION_IDS.includes(actionId)) {
        throw new RemoteResourceRegistryError('INVALID_PARAMS', 'unknown project action');
      }
      const projectId = request.resourceRef?.id;
      if (!projectId) throw new RemoteResourceRegistryError('INVALID_PARAMS', 'project resource required');
      const input = recordOf(request.input);
      const authority = captureAuthority();
      const requestId = requestIdOf(input, authority, actionId);
      const signature = JSON.stringify(stableKey(input));
      const key = receiptKey(authority.subject.id, actionId, requestId);
      const remembered = readReceipt(key, signature, Date.now());
      if (remembered) {
        // 重放不写库，但丢过响应的控制端要靠这条广播收敛。
        broadcastProjectChanged(projectId);
        return remembered;
      }

      let response: RemoteActionInvokeResponse;
      switch (actionId as ProjectActionId) {
        case ACTION_IDS.recordProgress:
          response = await recordProgress(authority, projectId, input, requestId);
          break;
        case ACTION_IDS.setAssignee:
          response = await setAssignee(authority, projectId, input);
          break;
        case ACTION_IDS.archive:
          response = await setArchived(authority, projectId, true, input);
          break;
        case ACTION_IDS.unarchive:
          response = await setArchived(authority, projectId, false, input);
          break;
        default:
          throw new RemoteResourceRegistryError('INVALID_PARAMS', 'unknown project action');
      }
      authority.assertCurrent();
      writeReceipt(key, signature, response, Date.now());
      // 契约 §6：唯一的刷新机制就是这条广播（每个成功回包一次）。
      broadcastProjectChanged(projectId);
      return response;
    },
  });
}
