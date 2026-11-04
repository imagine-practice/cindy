import type {
  SessionTaskItem,
  SessionTaskLists,
} from '@/features/right-sidebar/plugins/background-tasks/listSessionTasks';

export interface BackgroundTaskProgress {
  completed: number;
  total: number;
}

export interface BackgroundTaskSummary {
  subagents: BackgroundTaskProgress;
  commands: BackgroundTaskProgress;
}

const EMPTY_PROGRESS: BackgroundTaskProgress = { completed: 0, total: 0 };

/**
 * Collapse listSessionTasks' canonical task projection into user-facing
 * progress counts. Keeping this downstream of listSessionTasks means live
 * updates, restored history, durable subagent statuses, task cards, and the
 * background-task sidebar all use the same terminal-state and dedupe rules.
 * Workflows have their own composer status and are excluded here.
 */
export function summarizeBackgroundTasks(
  taskLists: SessionTaskLists,
): BackgroundTaskSummary {
  const items = [...taskLists.running, ...taskLists.completed];
  const progress = (matches: (item: SessionTaskItem) => boolean): BackgroundTaskProgress => {
    const matching = items.filter(matches);
    return {
      completed: matching.filter((item) => item.status !== 'running').length,
      total: matching.length,
    };
  };

  if (items.length === 0) {
    return { subagents: EMPTY_PROGRESS, commands: EMPTY_PROGRESS };
  }

  return {
    subagents: progress((item) => item.kind === 'agent' || item.kind === 'other'),
    commands: progress((item) => item.kind === 'bash'),
  };
}
