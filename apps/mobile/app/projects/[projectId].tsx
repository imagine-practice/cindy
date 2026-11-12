/**
 * 手机端项目详情(契约 2026-11-11 §3 / §4):
 * 按宿主返回顺序渲染 summary / progress / work-items / members / group-link,
 * 未知 primitive 只渲染 fallbackMarkdown;四个写动作按宿主的 actions 声明出现。
 */
import { randomUUID } from 'expo-crypto';
import { useCallback, useMemo, useState } from 'react';
import { Alert, ActivityIndicator, Pressable, RefreshControl, ScrollView, StyleSheet, View } from 'react-native';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteActionDescriptor } from '@cindy/device-link';
import { SafeAreaView } from 'react-native-safe-area-context';

import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState, MainWindowMetric } from '@/components/MobilePrimitives';
import { useDeviceLink } from '@/device-link/DeviceLinkContext';
import { isMobileRemoteCollectionSupported, type RemoteResourceHostTarget } from '@/device-link/remoteResources';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { ProjectActionSheet } from '@/projects/ProjectActionSheet';
import { createProjectActionRunner } from '@/projects/projectActions';
import {
  PROJECT_ACTION,
  PROJECT_COLLECTION_ID,
  PROJECT_STAGES,
  projectDetailView,
  type ProjectSection,
  type ProjectWorkItemView,
} from '@/projects/projectModel';
import { useProjectResource, useProjectSubmit } from '@/projects/useProjectResource';
import { goBackGuarded } from '@/utils/backGuard';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

const KNOWN_ACTIONS = new Set<string>(Object.values(PROJECT_ACTION));
/** 归档类动作一律二次确认(契约 §7)。 */
const CONFIRMED_ACTIONS = new Set<string>([PROJECT_ACTION.archive, PROJECT_ACTION.unarchive]);

function timeLabel(value: number | null, locale: string, fallback: string): string {
  if (value === null || !Number.isFinite(new Date(value).getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function ProjectDetailScreen() {
  const params = useLocalSearchParams<{
    projectId?: string | string[];
    projectName?: string | string[];
    deviceId?: string | string[];
    deviceName?: string | string[];
  }>();
  const projectId = firstParam(params.projectId);
  if (!isMobileRemoteCollectionSupported(PROJECT_COLLECTION_ID) || !projectId) return <Redirect href="/projects" />;
  return <ProjectDetailContent
    deviceId={firstParam(params.deviceId)}
    deviceName={firstParam(params.deviceName)}
    projectId={projectId}
    projectName={firstParam(params.projectName)}
  />;
}

function ProjectDetailContent({ deviceId, deviceName, projectId, projectName }: {
  deviceId: string;
  deviceName: string;
  projectId: string;
  projectName: string;
}) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const { invoke, status, getPresenceAvailability, presenceVersion } = useDeviceLink();
  void presenceVersion;
  const host = useMemo<RemoteResourceHostTarget>(() => ({ deviceId, deviceName }), [deviceId, deviceName]);
  const online = status === 'online' && getPresenceAvailability(deviceId) !== false;
  const { resource, loading, refreshing, error, refresh, reload } = useProjectResource(host, projectId);
  const runner = useMemo(() => createProjectActionRunner({
    host,
    invoke,
    locale: i18n.language,
    newRequestId: () => randomUUID(),
    resourceRef: { collectionId: PROJECT_COLLECTION_ID, id: projectId, kind: 'project' },
  }), [host, i18n.language, invoke, projectId]);
  const submit = useProjectSubmit(runner);
  const [sheetAction, setSheetAction] = useState<RemoteActionDescriptor | null>(null);
  const view = useMemo(() => resource ? projectDetailView(resource, i18n.language) : null, [i18n.language, resource]);
  const actions = useMemo(() => (resource?.actions ?? []).filter((action) => KNOWN_ACTIONS.has(action.id)), [resource]);
  const title = view?.sections.find((section) => section.kind === 'summary');
  const headerTitle = (title?.kind === 'summary' ? title.view.name : null) ?? (projectName || t('projects.title'));

  const finish = useCallback((ok: boolean) => {
    if (!ok) return;
    setSheetAction(null);
    // 契约 §6:成功后由控制器重读详情(唯一刷新路径)。宿主随后推来的 REMOTE_RESOURCE_CHANGED
    // 也走同一个 load,in-flight 合并后同一次写入只读一遍;invoke 返回的 resource 一律不消费。
    void reload(false);
  }, [reload]);

  const runAction = useCallback(async (action: RemoteActionDescriptor, input: Record<string, unknown>) => {
    const ok = await submit.submit(action.id, input);
    finish(ok);
  }, [finish, submit]);

  const pressAction = useCallback(async (action: RemoteActionDescriptor) => {
    submit.clearError();
    if (!CONFIRMED_ACTIONS.has(action.id)) { setSheetAction(action); return; }
    // 宿主给了确认文案就用它;老被控端没给则用本地文案,后果写清楚。
    const confirmation = action.confirmation;
    const title = confirmation ? resolveRemoteText(confirmation.title, i18n.language) : t(action.id === PROJECT_ACTION.archive
      ? 'projects.confirm.archiveTitle' : 'projects.confirm.unarchiveTitle');
    const body = confirmation?.body
      ? resolveRemoteText(confirmation.body, i18n.language)
      : t(action.id === PROJECT_ACTION.archive ? 'projects.confirm.archiveBody' : 'projects.confirm.unarchiveBody');
    const confirmLabel = confirmation?.confirmLabel
      ? resolveRemoteText(confirmation.confirmLabel, i18n.language)
      : t('projects.confirm.confirm');
    const accepted = await new Promise<boolean>((resolve) => {
      Alert.alert(title, body, [
        { text: t('projects.confirm.cancel'), style: 'cancel', onPress: () => resolve(false) },
        { text: confirmLabel, onPress: () => resolve(true) },
      ], { cancelable: true, onDismiss: () => resolve(false) });
    });
    if (!accepted) return;
    // 契约 §4:归档类动作的 `confirmation` 必填 —— 它在界面上确实问过用户。
    await runAction(action, { confirmation: true });
  }, [i18n.language, runAction, submit, t]);

  return <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="projectDetail.screen">
    <SimpleStackHeader
      backTestID="projectDetail.backButton"
      onBack={() => goBackGuarded(router)}
      subtitle={deviceName}
      title={headerTitle}
      titleTestID="projectDetail.title"
    />
    {loading && !view ? <View style={styles.center}>
      <ActivityIndicator color={colors.textSecondary} testID="projectDetail.loading" />
    </View> : error && !view ? <View style={styles.center}>
      <MainWindowEmptyState
        centered
        copy={error}
        style={styles.emptyState}
        testID="projectDetail.error"
        title={t('projects.list.loadFailed')}
      >
        <MainWindowActionButton action={{
          busy: refreshing,
          label: t('projects.list.retry'),
          onPress: refresh,
          testID: 'projectDetail.retry',
        }} />
      </MainWindowEmptyState>
    </View> : <ScrollView
      {...simpleScrollInsetProps}
      contentContainerStyle={styles.content}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={refresh} tintColor={colors.textSecondary} />}
    >
      {!online ? <Text accessibilityRole="alert" style={styles.notice} testID="projectDetail.offline">{t('projects.form.offline')}</Text> : null}
      {error && view ? <Pressable accessibilityRole="button" onPress={refresh} style={styles.staleRow} testID="projectDetail.stale">
        <Text style={styles.notice}>{t('projects.list.stale')}</Text>
        <Text style={styles.link}>{t('projects.list.retry')}</Text>
      </Pressable> : null}
      {(view?.sections ?? []).map((section) => <Section
        key={`${section.kind}:${section.id}`}
        locale={i18n.language}
        section={section}
      />)}
      {actions.length > 0 ? <View style={styles.actions} testID="projectDetail.actions">
        {actions.map((action) => <MainWindowActionButton
          key={action.id}
          action={{
            disabled: !online || submit.busy || action.disabled === true,
            label: resolveRemoteText(action.label, i18n.language),
            onPress: () => { void pressAction(action); },
            testID: `projectDetail.action.${action.id}`,
            tone: action.id === PROJECT_ACTION.archive ? 'danger' : 'secondary',
          }}
        />)}
        {submit.error && !sheetAction ? <Text accessibilityRole="alert" style={styles.errorText} testID="projectDetail.actionError">{submit.error}</Text> : null}
      </View> : null}
    </ScrollView>}
    <ProjectActionSheet
      action={sheetAction}
      busy={submit.busy}
      error={submit.error}
      members={view?.members ?? []}
      onClose={() => setSheetAction(null)}
      onClosed={submit.clearError}
      onSubmit={(input) => { if (sheetAction) void runAction(sheetAction, input); }}
      online={online}
      tasks={view?.workItems ?? []}
      visible={sheetAction !== null}
    />
  </SafeAreaView>;
}

function Section({ locale, section }: { locale: string; section: ProjectSection }) {
  const styles = useThemedStyles(makeStyles);
  const { t } = useTranslation();
  if (section.kind === 'fallback') {
    // 未知 primitive:只显示宿主写的回落文本,不猜结构。
    return <View style={styles.card} testID={`projectDetail.fallback.${section.primitive}`}>
      <Text style={styles.bodyText}>{section.markdown}</Text>
    </View>;
  }
  if (section.kind === 'summary') {
    const view = section.view;
    return <View style={styles.card} testID="projectDetail.summary">
      <View style={styles.chipRow}>
        <View style={styles.chip} testID="projectDetail.summary.status">
          <Text style={styles.chipText}>{t(view.archived ? 'projects.status.archived' : 'projects.status.active')}</Text>
        </View>
      </View>
      <Text style={styles.groupLabel}>{t('projects.summary.goal')}</Text>
      <Text style={styles.bodyText} testID="projectDetail.summary.goal">{view.goal ?? t('projects.goal.none')}</Text>
      <Row label={t('projects.summary.owner')} value={view.owner?.name || t('projects.members.unknown')} />
      <Row label={t('projects.summary.updated')} value={timeLabel(view.updatedAt, locale, t('projects.updated.unknown'))} />
    </View>;
  }
  if (section.kind === 'progress') {
    const view = section.view;
    return <View style={styles.card} testID="projectDetail.progress">
      <Text style={styles.groupLabel}>{t('projects.progress.title')}</Text>
      <View style={styles.metrics}>
        {PROJECT_STAGES.map((stage) => <MainWindowMetric
          key={stage}
          label={t(`projects.progress.stage.${stage}`)}
          testID={`projectDetail.progress.count.${stage}`}
          value={view.counts[stage]}
        />)}
      </View>
      <Text style={styles.groupLabel}>{t('projects.progress.history')}</Text>
      {view.events.length === 0
        ? <Text style={styles.bodyText}>{t('projects.progress.historyEmpty')}</Text>
        : view.events.map((event) => <View key={event.id} style={styles.event} testID={`projectDetail.progress.event.${event.id}`}>
          <Text numberOfLines={1} style={styles.rowLabel}>
            {event.title ?? `${stageText(t, event.from)} → ${stageText(t, event.to)}`}
          </Text>
          <Text numberOfLines={2} style={styles.rowValue}>
            {[
              event.title ? `${stageText(t, event.from)} → ${stageText(t, event.to)}` : '',
              event.actorName ?? t('projects.progress.actorUnknown'),
              timeLabel(event.at, locale, t('projects.updated.unknown')),
              event.note ?? '',
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>)}
    </View>;
  }
  if (section.kind === 'work-items') {
    const items: readonly ProjectWorkItemView[] = section.view;
    return <View style={styles.card} testID="projectDetail.workItems">
      <Text style={styles.groupLabel}>{t('projects.workItems.title')}</Text>
      {items.length === 0
        ? <Text style={styles.bodyText}>{t('projects.workItems.empty')}</Text>
        : items.map((item) => <View key={item.sessionId} style={styles.event} testID={`projectDetail.workItem.${item.sessionId}`}>
          <Text numberOfLines={2} style={styles.rowLabel}>{item.title}</Text>
          <Text numberOfLines={2} style={styles.rowValue}>
            {[
              item.status ? t(`projects.progress.stage.${item.status}`) : t('projects.status.unknown'),
              item.assignee ? (item.assignee.name || t('projects.members.unknown')) : t('projects.workItems.unassigned'),
              timeLabel(item.updatedAt, locale, t('projects.updated.unknown')),
            ].filter(Boolean).join(' · ')}
          </Text>
        </View>)}
    </View>;
  }
  if (section.kind === 'members') {
    return <View style={styles.card} testID="projectDetail.members">
      <Text style={styles.groupLabel}>{t('projects.members.title')}</Text>
      {section.view.length === 0
        ? <Text style={styles.bodyText}>{t('projects.list.emptyCopy')}</Text>
        : section.view.map((member) => <View key={`${member.kind}:${member.id}`} style={styles.event} testID={`projectDetail.member.${member.kind}.${member.id}`}>
          <Text numberOfLines={1} style={styles.rowLabel}>{member.name || t('projects.members.unknown')}</Text>
          <Text numberOfLines={1} style={styles.rowValue}>
            {t(member.role === 'owner' ? 'projects.members.owner' : 'projects.members.member')}
          </Text>
        </View>)}
    </View>;
  }
  return <View style={styles.card} testID="projectDetail.groupLink">
    <Text style={styles.groupLabel}>{t('projects.group.title')}</Text>
    <Text numberOfLines={1} style={styles.rowLabel}>{section.view.groupName}</Text>
    {section.view.status ? <Text numberOfLines={1} style={styles.rowValue}>{section.view.status}</Text>
      : <Text numberOfLines={1} style={styles.rowValue}>{t('projects.group.statusNone')}</Text>}
  </View>;
}

function stageText(t: (key: string) => string, stage: string | null): string {
  return stage ? t(`projects.progress.stage.${stage}`) : t('projects.status.unknown');
}

function Row({ label, value }: { label: string; value: string }) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.row}>
    <Text numberOfLines={1} style={styles.rowLabel}>{label}</Text>
    <Text numberOfLines={2} style={styles.rowValue}>{value}</Text>
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  center: { flex: 1, justifyContent: 'center', padding: spacing.xl },
  emptyState: { gap: spacing.md, padding: spacing.xl },
  content: { gap: spacing.md, padding: spacing.md, paddingBottom: spacing.xxl },
  chipRow: { flexDirection: 'row', gap: spacing.sm },
  chip: { backgroundColor: colors.surfaceChip, borderRadius: radius.pill, paddingHorizontal: spacing.sm, paddingVertical: spacing.xs },
  chipText: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  card: {
    backgroundColor: colors.surfaceListRow,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    gap: spacing.sm,
    padding: spacing.md,
  },
  groupLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
  },
  bodyText: { color: colors.textPrimary, fontSize: typeScale.body, lineHeight: lineHeight.body },
  metrics: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  event: { gap: spacing.xs },
  row: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  rowLabel: { color: colors.textPrimary, flexShrink: 1, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall, fontWeight: fontWeight.medium },
  rowValue: { color: colors.textSecondary, flexShrink: 1, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  notice: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  staleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  link: { color: colors.textPrimary, fontSize: typeScale.footnote, fontWeight: fontWeight.medium, lineHeight: lineHeight.caption },
  errorText: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  actions: { gap: spacing.sm, paddingTop: spacing.sm },
});
