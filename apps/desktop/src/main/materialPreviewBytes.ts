import type { IpcMainInvokeEvent } from 'electron';
import { assertTrustedAppRendererEvent } from './security/trustedAppRenderer';
import { readMaterialPreviewGrant } from './materialPreviewAccess';
import { throwIpcError } from './utils/ipcValidate';

/** Central IPC registration belongs to the integrator; no generic URL or path read. */
export async function readMaterialPreviewPdfBytes(event: IpcMainInvokeEvent, raw: unknown): Promise<{ bytes: Uint8Array<ArrayBuffer>; mime: 'application/pdf' }> {
  try { assertTrustedAppRendererEvent(event); }
  catch { throwIpcError('PERMISSION_DENIED', 'Material preview source is unavailable'); }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw) || Object.keys(raw).some(key => key !== 'url')) {
    throwIpcError('INVALID_PARAMS', 'Invalid material preview request');
  }
  try {
    const sender = event.sender, frame = event.senderFrame;
    if (!frame || sender.isDestroyed() || frame.detached) throw Error('Source unavailable');
    const senderId = sender.id, processId = frame.processId, routingId = frame.routingId, url = frame.url;
    let invalidated = false;
    const invalidate = () => { invalidated = true; };
    const onNavigate = (_event: unknown, _url: string, _inPlace: boolean, isMainFrame: boolean) => {
      if (isMainFrame) invalidate();
    };
    const assertSourceCurrent = () => {
      if (invalidated || event.sender !== sender || sender.isDestroyed() || sender.id !== senderId ||
          event.senderFrame !== frame || frame.detached || sender.mainFrame !== frame ||
          frame.processId !== processId || frame.routingId !== routingId || frame.url !== url) {
        throw Error('Source unavailable');
      }
      assertTrustedAppRendererEvent(event);
    };
    // Latch invalidation even if navigation returns to the same trusted frame/URL.
    // These are main-owned Electron events, never a renderer-reported authorization flag.
    sender.on('did-start-navigation', onNavigate);
    sender.on('destroyed', invalidate);
    sender.on('render-process-gone', invalidate);
    try {
      assertSourceCurrent();
      const result = await readMaterialPreviewGrant((raw as { url?: unknown }).url);
      if (result.mime !== 'application/pdf') throw Error('Unsupported material');
      assertSourceCurrent(); // No await between this check and returning the bytes.
      return { bytes: result.bytes, mime: 'application/pdf' };
    } finally {
      sender.removeListener('did-start-navigation', onNavigate);
      sender.removeListener('destroyed', invalidate);
      sender.removeListener('render-process-gone', invalidate);
    }
  } catch { throwIpcError('VERSION_NOT_READABLE', 'Material preview is unavailable'); }
}
