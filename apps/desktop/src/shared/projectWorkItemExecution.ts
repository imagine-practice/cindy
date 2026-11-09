import type { ProjectSubjectRef } from './projects.js';

/** Main-only intent. Identity, clock, plan and paths are not caller parameters. */
export interface ProjectWorkItemStartInput {
  intent: 'start'; callerSessionId: string; targetBotId: string;
  projectId: string; sessionId: string; expectedBindingRevision: number;
  requestId: string; objective: string;
}
export type ProjectWorkItemStartResult =
  | { ok: true; delegationId: string; childSessionId: string; existing: boolean; status: string; resumed: false; queued: boolean; queuedMessageId?: string; delivery: 'queued' | 'accepted' }
  | { ok: false; errorCode: string; message: string };
export interface ProjectWorkItemExecutionScope extends ProjectWorkItemStartInput { actor: ProjectSubjectRef }
export interface ProjectWorkItemExecutionView {
  fingerprint: string; delegationId: string; inputId: string;
  existing: boolean; receipt: ProjectWorkItemStartResult | null; phase: string | null;
}
export type ProjectWorkItemExecutionRequest = ProjectWorkItemExecutionScope & (
  | { action: 'inspect' }
  | { action: 'verify'; fingerprint: string }
  | { action: 'admit'; requireSettledExisting?: boolean; fingerprint: string; now: number; maxActiveChildren: number; permissionSnapshotJson: string;
      existingResult?: ProjectWorkItemStartResult }
);
export type ProjectWorkItemExecutionResult =
  | { ok: true; view: ProjectWorkItemExecutionView }
  | { ok: false; errorCode: string; message: string };
