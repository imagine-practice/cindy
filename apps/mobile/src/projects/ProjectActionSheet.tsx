/** 写动作表单的外壳:标题取宿主给的动作标签,正文是 ProjectActionForm。 */
import { useTranslation } from 'react-i18next';
import { resolveRemoteText, type RemoteActionDescriptor } from '@cindy/device-link';
import { CompanionSheet } from '@/session/CompanionSheet';
import {
  PROJECT_ACTION,
  type ProjectMemberView,
  type ProjectWorkItemView,
} from './projectModel';
import { ProjectActionForm } from './ProjectActionForm';

export function ProjectActionSheet({
  busy,
  error,
  members,
  onClose,
  onClosed,
  onSubmit,
  online,
  tasks,
  visible,
  action,
}: {
  action: RemoteActionDescriptor | null;
  busy: boolean;
  error: string | null;
  members: readonly ProjectMemberView[];
  onClose(): void;
  onClosed?(): void;
  onSubmit(input: Record<string, unknown>): void;
  online: boolean;
  tasks: readonly ProjectWorkItemView[];
  visible: boolean;
}) {
  const { i18n } = useTranslation();
  const mode = action?.id === PROJECT_ACTION.setAssignee ? 'assignee' : 'progress';
  return <CompanionSheet
    initialSnap="full"
    keyboardAvoidingBehavior="padding"
    onClose={onClose}
    onClosed={onClosed}
    preventDismiss={busy}
    testID="projects.actionSheet"
    title={action ? resolveRemoteText(action.label, i18n.language) : ''}
    visible={visible}
  >
    <ProjectActionForm
      busy={busy}
      error={error}
      members={members}
      mode={mode}
      online={online}
      onSubmit={onSubmit}
      tasks={tasks}
    />
  </CompanionSheet>;
}
