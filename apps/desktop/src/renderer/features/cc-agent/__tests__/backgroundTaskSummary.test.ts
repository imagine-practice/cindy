import { describe, expect, it } from 'vitest';

import type { Message } from '@/lib/ccAgent.types';
import type { AgentTaskUpdate } from '@/lib/makerChatStore';
import { listSessionTasks } from '@/features/right-sidebar/plugins/background-tasks/listSessionTasks';
import { summarizeBackgroundTasks } from '../backgroundTaskSummary';

function message(partial: Partial<Message> & Pick<Message, 'clientId' | 'role'>): Message {
  return {
    id: partial.clientId,
    sessionId: 'session-1',
    content: '',
    toolUseId: null,
    agentMeta: null,
    createdAt: '2026-10-05T00:00:00.000Z',
    ...partial,
  } as Message;
}

function toolUse(
  clientId: string,
  toolUseId: string,
  toolName: string,
  input: unknown = {},
  status?: 'completed' | 'failed' | 'stopped',
): Message {
  return message({
    clientId,
    role: 'tool_use',
    toolUseId,
    content: { toolName, input },
    ...(status ? { agentMeta: { agentTaskStatus: status } } : {}),
  });
}

function toolResult(clientId: string, toolUseId: string): Message {
  return message({ clientId, role: 'tool_result', toolUseId, content: 'done' });
}

function update(input: Partial<AgentTaskUpdate> & Pick<AgentTaskUpdate, 'taskId'>): AgentTaskUpdate {
  return { provider: 'claude-code', status: 'running', ...input };
}

function summarize(input: Parameters<typeof listSessionTasks>[0]) {
  return summarizeBackgroundTasks(listSessionTasks(input));
}

describe('summarizeBackgroundTasks', () => {
  it('counts completed, failed, and stopped historical tasks after reload', () => {
    const messages = [
      toolUse('c1', 'tool-completed', 'Task', { description: 'completed' }),
      toolResult('r1', 'tool-completed'),
      toolUse('c2', 'tool-failed', 'Task', { description: 'failed' }, 'failed'),
      toolUse('c3', 'tool-stopped', 'Task', { description: 'stopped' }, 'stopped'),
      toolUse('c4', 'tool-bash', 'Bash', { run_in_background: true, command: 'pnpm test' }),
      toolResult('r4', 'tool-bash'),
    ];

    expect(summarize({ messages, taskUpdates: undefined, isSessionStreaming: false })).toEqual({
      subagents: { completed: 3, total: 3 },
      commands: { completed: 1, total: 1 },
    });
  });

  it('uses the sidebar projection to deduplicate live task aliases', () => {
    const subagent = update({
      taskId: 'agent-1',
      parentToolUseId: 'tool-agent-1',
      status: 'completed',
    });
    const command = update({
      taskId: 'bash-1',
      parentToolUseId: 'tool-bash-1',
      taskType: 'local_bash',
      status: 'failed',
    });
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['agent-1', subagent],
      ['tool-agent-1', subagent],
      ['bash-1', command],
      ['tool-bash-1', command],
    ]);
    const messages = [
      toolUse('c1', 'tool-agent-1', 'Task', { description: 'agent' }),
      toolUse('c2', 'tool-bash-1', 'Bash', { run_in_background: true, command: 'build' }),
    ];

    expect(summarize({ messages, taskUpdates, isSessionStreaming: false })).toEqual({
      subagents: { completed: 1, total: 1 },
      commands: { completed: 1, total: 1 },
    });
  });

  it('keeps running work in the total without advancing terminal progress', () => {
    const taskUpdates = new Map<string, AgentTaskUpdate>([
      ['agent-running', update({ taskId: 'agent-running' })],
      ['bash-running', update({ taskId: 'bash-running', taskType: 'local_bash' })],
    ]);

    expect(summarize({ messages: [], taskUpdates, isSessionStreaming: false })).toEqual({
      subagents: { completed: 0, total: 1 },
      commands: { completed: 0, total: 1 },
    });
  });
});
