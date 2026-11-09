import { getDataOwnerGeneration, isDataOwnerGenerationCurrent } from '@/contexts/dataOwnerGeneration';
import type { ProtectedPdfSource } from '@/features/cc-agent/workdir-browse/PdfPreview';

export function isProtectedMaterialUrl(url: unknown): url is string {
  return typeof url === 'string' && /^xdt-file:\/\/material\/[a-f0-9]{64}$/.test(url);
}
/** Optional bridge until the integrator installs the exact dedicated IPC. Never use raw-file fallback. */
export function protectedPdfSource(url: string): ProtectedPdfSource {
  const owner = getDataOwnerGeneration();
  const assertCurrent = () => {
    if (!isDataOwnerGenerationCurrent(owner)) throw Error('Material owner changed');
  };
  return {
    kind: 'protected', key: url, assertCurrent,
    async readBytes() {
      assertCurrent();
      if (!isProtectedMaterialUrl(url)) throw Error('Invalid material preview');
      const bridge = window.electronAPI;
      if (!bridge.localDb?.materials?.readPreviewBytes) throw Error('Material preview unavailable');
      const result = await bridge.localDb.materials.readPreviewBytes({ url });
      assertCurrent();
      if (!(result.bytes instanceof Uint8Array) || result.mime !== 'application/pdf') throw Error('Invalid material preview bytes');
      return result.bytes;
    },
  };
}
