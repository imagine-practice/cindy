import type { ProjectSubjectRef } from './projects.js';

/** Main-only intent. Identity, clock, plan and paths are not caller parameters. */
export interface ProjectWorkItemStartInput {
  intent: 'start';
  callerSessionId: string;
  targetBotId: string;
  projectId: string;
  sessionId: string;
  expectedBindingRevision: number;
  requestId: string;
  objective: string;
}
export type ProjectWorkItemStartResult =
  | {
      ok: true;
      delegationId: string;
      childSessionId: string;
      existing: boolean;
      status: string;
      resumed: false;
      queued: boolean;
      queuedMessageId?: string;
      delivery: 'queued' | 'accepted';
    }
  | { ok: false; errorCode: string; message: string };
export interface ProjectWorkItemExecutionScope extends ProjectWorkItemStartInput {
  actor: ProjectSubjectRef;
  /** Captured by the host from the active turn, never accepted as a tool argument. */
  automatic: boolean;
}
export interface ProjectWorkItemExecutionView {
  fingerprint: string;
  delegationId: string;
  inputId: string;
  existing: boolean;
  receipt: ProjectWorkItemStartResult | null;
  phase: string | null;
}
export type ProjectWorkItemExecutionRequest = ProjectWorkItemExecutionScope &
  (
    | { action: 'inspect' }
    | { action: 'verify'; fingerprint: string }
    | { action: 'admit'; fingerprint: string; now: number }
    | { action: 'claim'; fingerprint: string; now: number }
    | { action: 'finish'; fingerprint: string; now: number; result: ProjectWorkItemStartResult }
    | { action: 'unknown'; fingerprint: string; now: number }
  );
export type ProjectWorkItemExecutionResult =
  | { ok: true; view: ProjectWorkItemExecutionView; newlyAdmitted?: boolean; claimed?: boolean }
  | { ok: false; errorCode: string; message: string };
