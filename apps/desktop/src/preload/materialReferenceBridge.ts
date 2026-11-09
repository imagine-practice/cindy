import { ipcRenderer } from 'electron';
import type { MaterialReferenceBridge } from '../shared/materialReferenceBridge';
import {
  MATERIALS_LIST_CHANNEL, MATERIALS_ADD_CHANNEL, MATERIALS_ADD_VERSION_CHANNEL, MATERIALS_RECORD_SOURCE_CHANNEL,
  MATERIALS_REMOVE_REFERENCE_CHANNEL, MATERIALS_RETRY_READ_CHANNEL, MATERIALS_PREVIEW_CHANNEL,
  MATERIAL_CONTEXTS_CREATE_CHANNEL, MATERIAL_CONTEXTS_LIST_CHANNEL,
} from '../shared/materials';

/** Eight fixed capabilities; main validates every untrusted payload and derives identity. */
export function createMaterialReferenceBridge(): MaterialReferenceBridge {
  return {
    materials: {
      list: params => ipcRenderer.invoke(MATERIALS_LIST_CHANNEL, params),
      add: params => ipcRenderer.invoke(MATERIALS_ADD_CHANNEL, params),
      addVersion: params => ipcRenderer.invoke(MATERIALS_ADD_VERSION_CHANNEL, params),
      recordSourceVersion: params => ipcRenderer.invoke(MATERIALS_RECORD_SOURCE_CHANNEL, params),
      removeReference: params => ipcRenderer.invoke(MATERIALS_REMOVE_REFERENCE_CHANNEL, params),
      retryRead: params => ipcRenderer.invoke(MATERIALS_RETRY_READ_CHANNEL, params),
      preview: params => ipcRenderer.invoke(MATERIALS_PREVIEW_CHANNEL, params),
    },
    materialContexts: {
      create: params => ipcRenderer.invoke(MATERIAL_CONTEXTS_CREATE_CHANNEL, params),
      list: params => ipcRenderer.invoke(MATERIAL_CONTEXTS_LIST_CHANNEL, params),
    },
  };
}
