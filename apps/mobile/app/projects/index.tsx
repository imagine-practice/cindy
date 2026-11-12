/** 手机端项目列表(契约 2026-11-11 §2):项目名、目标摘要、状态、成员/任务数、更新时间。 */
import { useCallback, useEffect, useMemo, useState } from 'react';
import { Redirect, useLocalSearchParams, useRouter } from 'expo-router';
import { useTranslation } from 'react-i18next';
import { ActivityIndicator, FlatList, Pressable, RefreshControl, StyleSheet, View } from 'react-native';
import { ChevronRight, RefreshCw } from 'lucide-react-native';
import { SafeAreaView } from 'react-native-safe-area-context';

import { useAuth } from '@/auth/AuthContext';
import { Text } from '@/components/AppText';
import { MainWindowActionButton, MainWindowEmptyState, RemoteListSyncingPlaceholder } from '@/components/MobilePrimitives';
import { mobileInteractionStyles } from '@/components/mobileInteractionStyles';
import { useRemoteResourceList } from '@/session/useRemoteResourceList';
import { SimpleStackHeader, simpleScrollInsetProps, simpleScrollScreenSafeAreaEdges } from '@/platform/chrome';
import { readRemoteResourceSnapshot } from '@/device-link/remoteResourceCache';
import {
  isMobileRemoteCollectionSupported,
  parseRemoteResourceTargets,
  type RemoteHomeCollection,
  type RemoteResourceHostTarget,
} from '@/device-link/remoteResources';
import { PROJECT_COLLECTION_ID, projectRowView } from '@/projects/projectModel';
import { goBackGuarded } from '@/utils/backGuard';
import { useGuardedPush } from '@/utils/useGuardedPush';
import { useTheme, useThemedStyles, type ThemeColors } from '@/theme';
import { fontWeight, iconSize, iconStroke, lineHeight, radius, spacing, typeScale } from '@/theme/tokens';

function firstParam(value: string | string[] | undefined): string {
  return Array.isArray(value) ? value[0] ?? '' : value ?? '';
}

export function projectsTargetsOf(home: readonly RemoteHomeCollection[]): RemoteResourceHostTarget[] {
  return home.find((collection) => collection.id === PROJECT_COLLECTION_ID)?.targets ?? [];
}

/** 入口会带 targets;直接打开 /projects(深链、返回旧栈)时退回首页缓存里的同一份目标。 */
function useProjectHosts(param: string | undefined): RemoteResourceHostTarget[] {
  const { user } = useAuth();
  const fromParam = useMemo(() => parseRemoteResourceTargets(param), [param]);
  const [cached, setCached] = useState<RemoteResourceHostTarget[]>([]);
  const userId = user?.id ?? '';
  useEffect(() => {
    if (fromParam.length > 0 || !userId) return;
    let live = true;
    void readRemoteResourceSnapshot(userId).then((snapshot) => {
      if (live) setCached(projectsTargetsOf(snapshot.home));
    });
    return () => { live = false; };
  }, [fromParam.length, userId]);
  return fromParam.length > 0 ? fromParam : cached;
}

function updatedLabel(value: number | null, locale: string, fallback: string): string {
  if (value === null || !Number.isFinite(new Date(value).getTime())) return fallback;
  return new Intl.DateTimeFormat(locale, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  }).format(new Date(value));
}

export default function ProjectsScreen() {
  const params = useLocalSearchParams<{ targets?: string | string[] }>();
  const targets = useProjectHosts(firstParam(params.targets) || undefined);
  if (!isMobileRemoteCollectionSupported(PROJECT_COLLECTION_ID)) return <Redirect href="/devices" />;
  return <ProjectsScreenContent targets={targets} />;
}

function ProjectsScreenContent({ targets }: { targets: RemoteResourceHostTarget[] }) {
  const styles = useThemedStyles(makeStyles);
  const { colors } = useTheme();
  const { t, i18n } = useTranslation();
  const router = useRouter();
  const guardedPush = useGuardedPush();
  const list = useRemoteResourceList(PROJECT_COLLECTION_ID, targets);
  const { items, loading, refreshing, error, isOnline } = list;
  const load = list.refresh;
  const openProject = useCallback((hosted: (typeof items)[number], projectName: string) => {
    if (!isOnline(hosted.host)) return;
    guardedPush({
      pathname: '/projects/[projectId]',
      params: {
        projectId: hosted.item.ref.id,
        projectName,
        deviceId: hosted.host.deviceId,
        deviceName: hosted.host.deviceName,
      },
    });
  }, [guardedPush, i18n.language, isOnline]);

  return <SafeAreaView edges={simpleScrollScreenSafeAreaEdges()} style={styles.safeArea} testID="projects.screen">
    <SimpleStackHeader
      backTestID="projects.backButton"
      onBack={() => goBackGuarded(router)}
      scrollEdge
      subtitle={targets.length > 1 ? t('projects.list.hostCount', { count: targets.length }) : targets[0]?.deviceName}
      title={t('projects.title')}
      titleTestID="projects.title"
    />
    {loading && items.length === 0 ? <View style={styles.center}>
      <RemoteListSyncingPlaceholder testID="projects.loading" />
    </View> : <FlatList
      {...simpleScrollInsetProps}
      contentContainerStyle={items.length === 0 ? styles.emptyContent : styles.listContent}
      data={items}
      keyExtractor={(item) => item.key}
      refreshControl={<RefreshControl refreshing={refreshing} onRefresh={() => void load(true)} tintColor={colors.textSecondary} />}
      ListHeaderComponent={error && items.length > 0 ? <View style={styles.noticeRow}>
        <Text accessibilityRole="alert" style={styles.noticeText} testID="projects.error">{t('projects.list.stale')}</Text>
        <Pressable
          accessibilityLabel={t('projects.list.retry')}
          accessibilityRole="button"
          accessibilityState={{ busy: refreshing || undefined, disabled: refreshing }}
          disabled={refreshing}
          onPress={() => void load(true)}
          style={({ pressed }) => [styles.retry, pressed && styles.pressed]}
          testID="projects.refresh"
        >
          {refreshing
            ? <ActivityIndicator color={colors.textSecondary} />
            : <RefreshCw color={colors.textSecondary} size={iconSize.sm} strokeWidth={iconStroke.regular} />}
        </Pressable>
      </View> : null}
      renderItem={({ item: hosted }) => {
        const row = projectRowView(hosted.item, i18n.language);
        const online = isOnline(hosted.host);
        const meta = [
          ...row.badges,
          updatedLabel(row.updatedAt, i18n.language, t('projects.updated.unknown')),
        ].filter(Boolean).join(' · ');
        const rowTitle = row.title ?? t('projects.title');
        return <Pressable
          accessibilityLabel={[rowTitle, row.statusLabel, row.goal].filter(Boolean).join(', ')}
          accessibilityRole="button"
          accessibilityState={{ disabled: !online }}
          disabled={!online}
          onPress={() => openProject(hosted, row.title ?? '')}
          style={({ pressed }) => [styles.row, pressed && styles.pressed]}
          testID={`projects.item.${hosted.item.ref.id}`}
        >
          <View style={styles.body}>
            <View style={styles.titleRow}>
              <Text numberOfLines={1} style={styles.title}>{rowTitle}</Text>
              {row.statusLabel ? <View style={styles.chip}>
                <Text numberOfLines={1} style={styles.chipText}>{row.statusLabel}</Text>
              </View> : null}
            </View>
            <Text numberOfLines={2} style={styles.goal} testID={`projects.item.${hosted.item.ref.id}.goal`}>
              {row.goal ?? t('projects.goal.none')}
            </Text>
            <Text numberOfLines={1} style={styles.meta} testID={`projects.item.${hosted.item.ref.id}.meta`}>{meta}</Text>
          </View>
          <ChevronRight color={colors.textTertiary} size={iconSize.md} strokeWidth={iconStroke.regular} />
        </Pressable>;
      }}
      ListEmptyComponent={error ? <MainWindowEmptyState
        centered
        copy={error}
        style={styles.emptyState}
        testID="projects.error"
        title={t('projects.list.loadFailed')}
      >
        <MainWindowActionButton action={{
          busy: refreshing,
          label: t('projects.list.retry'),
          onPress: () => void load(true),
          testID: 'projects.retry',
        }} />
      </MainWindowEmptyState> : <MainWindowEmptyState
        copy={t('projects.list.emptyCopy')}
        testID="projects.empty"
        title={t('projects.list.emptyTitle')}
      />}
    />}
  </SafeAreaView>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  safeArea: { backgroundColor: colors.surface, flex: 1 },
  center: { alignItems: 'center', flex: 1, gap: spacing.sm, justifyContent: 'center' },
  emptyContent: { flexGrow: 1, justifyContent: 'center', padding: spacing.xl },
  emptyState: { gap: spacing.md, padding: spacing.xl },
  listContent: { gap: spacing.sm, padding: spacing.md },
  noticeRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  noticeText: { color: colors.errorText, flex: 1, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  retry: { alignItems: 'center', justifyContent: 'center', minHeight: 44, minWidth: 44 },
  row: {
    alignItems: 'center',
    backgroundColor: colors.surfaceListRow,
    borderColor: colors.border,
    borderRadius: radius.container,
    borderWidth: StyleSheet.hairlineWidth,
    flexDirection: 'row',
    gap: spacing.sm,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.md,
  },
  pressed: mobileInteractionStyles.pressed,
  body: { flex: 1, gap: spacing.xs, minWidth: 0 },
  titleRow: { alignItems: 'center', flexDirection: 'row', gap: spacing.sm },
  title: { color: colors.textPrimary, flexShrink: 1, fontSize: typeScale.subtitle, fontWeight: fontWeight.medium, lineHeight: lineHeight.subtitle },
  chip: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.pill,
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs / 2,
  },
  chipText: { color: colors.textSecondary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
  goal: { color: colors.textSecondary, fontSize: typeScale.bodySmall, lineHeight: lineHeight.bodySmall },
  meta: { color: colors.textTertiary, fontSize: typeScale.caption, lineHeight: lineHeight.caption },
});
