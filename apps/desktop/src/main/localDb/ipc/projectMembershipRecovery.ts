import { BrowserWindow, dialog, ipcMain } from 'electron';
import { t } from '../../i18n';
import { assertTrustedAppRendererEvent } from '../../security/trustedAppRenderer';
import { createProductionProjectMembershipRecovery } from '../projectMembershipRecoveryProduction';
import type { ProjectMembershipRecoveryPreviewResult, ProjectMembershipRecoveryApplyResult } from '../../../shared/projectMembershipRecovery';
import { PROJECTS_CHANGED_CHANNEL } from '../../../shared/projects';
import { captureDataOwnerBroadcastScope, isDataOwnerBroadcastScopeCurrent } from '../../device-link/broadcast-tap';

/** Maintenance API, separated from ordinary project mutations/actor selection.
 * Preview does not change data. Apply always asks through a native, cancel-first
 * dialog in the exact trusted local renderer, then verifies an online backup.
 */
export function registerProjectMembershipRecoveryIpc(): void {
  const services = new Map<number, {service:ReturnType<typeof createProductionProjectMembershipRecovery>; frame:Electron.WebFrameMain; url:string}>();
  const watchedSenders = new Set<number>();
  const navigationEpochs = new Map<number,number>();
  const code = (error: unknown) => {
    const value = error && typeof error === 'object' && 'code' in error ? error.code : null;
    return value === 'CANCELLED' || value === 'INVALID_PARAMS' || value === 'PRECONDITION_FAILED' ? value : 'INTERNAL';
  };
  ipcMain.handle('local-db:projects:membership-recovery-preview', async (event, projectId:unknown):Promise<ProjectMembershipRecoveryPreviewResult> => {
    assertTrustedAppRendererEvent(event);
    if (typeof projectId !== 'string') return {ok:false,errorCode:'INVALID_PARAMS'};
    let entry=services.get(event.sender.id);
    if (!entry || entry.frame!==event.senderFrame || entry.url!==event.senderFrame?.url) {
      const sender=event.sender;
      const frame=event.senderFrame;
      if(!frame)return {ok:false,errorCode:'PRECONDITION_FAILED'};
      const url=frame.url;
      const navigationEpoch=navigationEpochs.get(sender.id)??0;
      const isRequesterCurrent=()=>{
        if(sender.isDestroyed()||sender.mainFrame!==frame||frame.url!==url
          ||(navigationEpochs.get(sender.id)??0)!==navigationEpoch)return false;
        try{assertTrustedAppRendererEvent(event);return true;}catch{return false;}
      };
      const service=createProductionProjectMembershipRecovery(async (_scope,preview) => {
        const window=BrowserWindow.fromWebContents(sender);
        if (!window || sender.isDestroyed()) return false;
        const body=t('ccAgent.projectCore.recovery.confirmBody')
          .replace('{{project}}',JSON.stringify(preview.projectName)).replace('{{count}}',String(preview.taskCount));
        const result=await dialog.showMessageBox(window,{type:'warning',title:t('ccAgent.projectCore.recovery.title'),message:body,
          buttons:[t('commonUi.confirmDialog.cancel'),t('commonUi.confirmDialog.confirm')],defaultId:0,cancelId:0,noLink:true});
        return result.response===1;
      },()=>{
        if (sender.isDestroyed()) return;
        const scope=captureDataOwnerBroadcastScope();
        if(isDataOwnerBroadcastScopeCurrent(scope)) sender.send(PROJECTS_CHANGED_CHANNEL,{},scope.ownerStamp);
      },isRequesterCurrent);
      entry={service,frame,url};
      services.set(sender.id,entry);
      if(!watchedSenders.has(sender.id)) {
        watchedSenders.add(sender.id);
        sender.on('did-start-navigation',(_event,_url,_isInPlace,isMainFrame)=>{
          if(!isMainFrame)return;
          navigationEpochs.set(sender.id,(navigationEpochs.get(sender.id)??0)+1);
          services.delete(sender.id);
        });
        sender.once('destroyed',()=>{services.delete(sender.id);watchedSenders.delete(sender.id);navigationEpochs.delete(sender.id);});
      }
    }
    try { return {ok:true,preview:await entry.service.preview(projectId)}; }
    catch(error) { return {ok:false,errorCode:code(error)}; }
  });
  ipcMain.handle('local-db:projects:membership-recovery-apply', async(event,previewId:unknown):Promise<ProjectMembershipRecoveryApplyResult>=>{
    assertTrustedAppRendererEvent(event);
    if(typeof previewId!=='string')return {ok:false,errorCode:'INVALID_PARAMS',writeOutcome:'not-applied'};
    const entry=services.get(event.sender.id);
    if(!entry)return {ok:false,errorCode:'PRECONDITION_FAILED',writeOutcome:'unknown'};
    try { return {ok:true,...await entry.service.repair(previewId)}; }
    catch(error) { return {ok:false,errorCode:code(error),writeOutcome:error&&typeof error==='object'&&'writeOutcome' in error&&error.writeOutcome==='unknown'?'unknown':'not-applied'}; }
  });
}
