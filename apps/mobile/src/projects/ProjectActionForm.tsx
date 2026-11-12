/**
 * 项目写动作的表单(契约 §4)。
 *
 * - `project.recordProgress`:选任务 + 选阶段 + 按 `to` 条件必填的备注字段;到 `done` 时提示
 *   「只有负责人能确认完成」。
 * - `project.setAssignee`:选任务 + 选处理人(成员 + 未分配)。
 *
 * 表单只负责「别把注定被拒的请求发出去」:缺少必填项时提交按钮不可用;真正的权限与状态
 * 校验仍在宿主。失败时保留已填内容,只显示宿主给的可读原因。
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, View } from 'react-native';
import { useTranslation } from 'react-i18next';
import { Text, TextInput } from '@/components/AppText';
import { MainWindowActionButton, MainWindowOptionButton } from '@/components/MobilePrimitives';
import { fontWeight, lineHeight, radius, spacing, typeScale, useThemedStyles, type ThemeColors } from '@/theme';
import {
  PROJECT_STAGES,
  assigneeInput,
  canRecordStage,
  emptyProgressDraft,
  progressInput,
  progressMissingFields,
  progressRequirements,
  type ProjectMemberView,
  type ProjectStage,
  type ProjectSubject,
  type ProjectWorkItemView,
  type ProgressDraft,
} from './projectModel';

export type ProjectActionMode = 'progress' | 'assignee';

export function ProjectActionForm({
  busy,
  error,
  members,
  mode,
  online,
  onSubmit,
  tasks,
}: {
  busy: boolean;
  error: string | null;
  members: readonly ProjectMemberView[];
  mode: ProjectActionMode;
  online: boolean;
  onSubmit(input: Record<string, unknown>): void;
  tasks: readonly ProjectWorkItemView[];
}) {
  const { t } = useTranslation();
  const styles = useThemedStyles(makeStyles);
  const [taskId, setTaskId] = useState(tasks.length === 1 ? tasks[0].sessionId : '');
  const [assigneeKey, setAssigneeKey] = useState<string>(() => {
    const assigned = tasks.find((task) => task.assignee);
    return assigned?.assignee ? `${assigned.assignee.kind}:${assigned.assignee.id}` : '__none__';
  });
  const selectedTask = tasks.find((task) => task.sessionId === taskId) ?? null;
  const [draft, setDraft] = useState<ProgressDraft>(() => emptyProgressDraft(taskId, selectedTask?.status ?? null));
  const from = selectedTask?.status ?? null;
  // 任务换了就从它当前阶段重新起草稿,免得上一个任务的备注串到下一个任务。
  const [draftTask, setDraftTask] = useState<string>(taskId);
  if (draftTask !== taskId) {
    setDraftTask(taskId);
    setDraft(emptyProgressDraft(taskId, from));
  }
  const requirements = progressRequirements(from, draft.to);
  const missing = progressMissingFields({ ...draft, sessionId: taskId }, from);
  const assigneeOptions = useMemo(() => members.map((member) => ({
    key: `${member.kind}:${member.id}`,
    member,
  })), [members]);
  const assignee = assigneeKey === '__none__'
    ? null
    : assigneeOptions.find((option) => option.key === assigneeKey)?.member ?? null;
  const disabled = !online || busy || tasks.length === 0;
  const patch = (next: Partial<ProgressDraft>) => setDraft((current) => ({ ...current, ...next }));

  const submit = () => {
    if (disabled) return;
    if (mode === 'assignee') {
      if (!taskId) return;
      const selected: ProjectSubject | null = assignee ? { kind: assignee.kind, id: assignee.id, name: assignee.name } : null;
      onSubmit(assigneeInput(taskId, selected));
      return;
    }
    if (missing.length > 0) return;
    onSubmit(progressInput({ ...draft, sessionId: taskId }, selectedTask));
  };

  if (tasks.length === 0) {
    return <View style={styles.empty}>
      <Text style={styles.note}>{t('projects.form.noTasks')}</Text>
    </View>;
  }

  const submitLabel = busy ? t('projects.form.saving') : t('projects.form.submit');
  return <ScrollView contentContainerStyle={styles.content} keyboardShouldPersistTaps="handled">
    <Text style={styles.groupLabel}>{t('projects.form.task')}</Text>
    <View style={styles.card}>
      {tasks.map((task, index) => (
        <View key={task.sessionId}>
          {index > 0 ? <View style={styles.divider} /> : null}
          <MainWindowOptionButton
            label={task.title}
            selected={task.sessionId === taskId}
            onPress={() => setTaskId(task.sessionId)}
            disabled={busy}
            testID={`projects.form.task.${task.sessionId}`}
            variant="segmented"
          />
        </View>
      ))}
    </View>

    {mode === 'progress' ? <>
      <Text style={styles.groupLabel}>{t('projects.form.stage')}</Text>
      <View accessibilityLabel={t('projects.form.stage')} accessibilityRole="radiogroup" style={styles.stages} testID="projects.form.stage">
        {PROJECT_STAGES.map((stage) => (
          <MainWindowOptionButton
            key={stage}
            label={t(`projects.progress.stage.${stage}`)}
            selected={stage === draft.to}
            disabled={busy || !canRecordStage(from, stage)}
            onPress={() => patch({ to: stage })}
            testID={`projects.form.stage.${stage}`}
          />
        ))}
      </View>
      {draft.to === 'done' ? <Text style={styles.note} testID="projects.form.doneOwnerOnly">{t('projects.form.doneOwnerOnly')}</Text> : null}
      {requirements.reason ? <>
        <Field
          label={t('projects.form.reason')}
          onChange={(value) => patch({ reason: value })}
          testID="projects.form.reason"
          value={draft.reason}
        />
        <Field
          label={t('projects.form.unblockCondition')}
          onChange={(value) => patch({ unblockCondition: value })}
          testID="projects.form.unblockCondition"
          value={draft.unblockCondition}
        />
      </> : null}
      {requirements.resolution ? <Field
        label={t('projects.form.resolution')}
        onChange={(value) => patch({ resolution: value })}
        testID="projects.form.resolution"
        value={draft.resolution}
      /> : null}
      {requirements.completionNote ? <Field
        label={t('projects.form.completionNote')}
        onChange={(value) => patch({ completionNote: value })}
        testID="projects.form.completionNote"
        value={draft.completionNote}
      /> : null}
    </> : <>
      <Text style={styles.groupLabel}>{t('projects.form.assignee')}</Text>
      <View style={styles.card}>
        {[{ key: '__none__', label: t('projects.form.unassigned') },
          ...assigneeOptions.map((option) => ({ key: option.key, label: option.member.name || t('projects.members.unknown') }))]
          .map((option, index) => <View key={option.key}>
            {index > 0 ? <View style={styles.divider} /> : null}
            <MainWindowOptionButton
              label={option.label}
              selected={option.key === assigneeKey}
              onPress={() => setAssigneeKey(option.key)}
              disabled={busy}
              testID={`projects.form.assignee.${option.key}`}
              variant="segmented"
            />
          </View>)}
      </View>
    </>}

    {!online ? <Text style={styles.note} testID="projects.form.offline">{t('projects.form.offline')}</Text> : null}
    {online && missing.length > 0 && mode === 'progress' ? <Text style={styles.note}>{t('projects.form.required')}</Text> : null}
    {error ? <Text accessibilityRole="alert" style={styles.error} testID="projects.form.error">{error}</Text> : null}
    <MainWindowActionButton
      action={{
        busy,
        disabled: disabled || (mode === 'progress' ? missing.length > 0 : !taskId),
        label: submitLabel,
        onPress: submit,
        testID: 'projects.form.submit',
        tone: 'primary',
      }}
    />
  </ScrollView>;
}

function Field({ label, onChange, testID, value }: {
  label: string; onChange(value: string): void; testID: string; value: string;
}) {
  const styles = useThemedStyles(makeStyles);
  return <View style={styles.field}>
    <Text style={styles.groupLabel}>{label}</Text>
    <TextInput
      accessibilityLabel={label}
      multiline
      onChangeText={onChange}
      style={styles.input}
      testID={testID}
      value={value}
    />
  </View>;
}

const makeStyles = (colors: ThemeColors) => StyleSheet.create({
  content: { gap: spacing.sm, paddingBottom: spacing.xl },
  empty: { padding: spacing.lg },
  card: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.container,
    overflow: 'hidden',
    paddingHorizontal: spacing.sm,
    paddingVertical: spacing.xs,
  },
  divider: { backgroundColor: colors.border, height: StyleSheet.hairlineWidth },
  groupLabel: {
    color: colors.textTertiary,
    fontSize: typeScale.footnote,
    fontWeight: fontWeight.semibold,
    lineHeight: lineHeight.caption,
    paddingTop: spacing.sm,
  },
  stages: { flexDirection: 'row', flexWrap: 'wrap', gap: spacing.sm },
  field: { gap: spacing.xs },
  input: {
    backgroundColor: colors.surfaceChip,
    borderRadius: radius.control,
    color: colors.textPrimary,
    fontSize: typeScale.body,
    lineHeight: lineHeight.body,
    minHeight: 88,
    paddingHorizontal: spacing.md,
    paddingVertical: spacing.sm,
    textAlignVertical: 'top',
  },
  note: { color: colors.textSecondary, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
  error: { color: colors.errorText, fontSize: typeScale.footnote, lineHeight: lineHeight.caption },
});
