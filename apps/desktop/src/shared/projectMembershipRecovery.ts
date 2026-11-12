/** Local-only maintenance API. No device-link allowlist entry: remote callers
 * cannot use source-adoption proof to change a target account's membership. */
export interface ProjectMembershipRecoveryPreview {
  previewId: string; projectId: string; projectName: string; taskCount: number;
  from: 'local-v1/member'; to: 'current-authenticated-account/member';
  botOwnerUnchanged: true; backupRequired: true;
}
export type ProjectMembershipRecoveryPreviewResult =
  | { ok:true; preview:ProjectMembershipRecoveryPreview }
  | { ok:false; errorCode:string };
export type ProjectMembershipRecoveryApplyResult =
  | { ok:true; status:'repaired' | 'already-repaired'; backupPath:string }
  | { ok:false; errorCode:string; writeOutcome:'not-applied' | 'unknown' };
