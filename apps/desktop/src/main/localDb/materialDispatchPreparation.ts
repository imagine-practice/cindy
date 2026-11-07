import { createHash } from 'node:crypto';
import type { MaterialDispatchPdfCoverage, MaterialDispatchPreparation, MaterialDispatchPreparedItem } from '../../shared/materialDispatch';

/** Structural input accepts the fixed real PreparedMaterialItem without an assertion.
 * No dependency from shared/data into the PDF/parser or media runtime is introduced. */
export type MaterialDispatchPreparedSource = {
  referenceId: string; materialId: string; version: number; versionId: string; expectedSha256: string;
} & (
  | { status: 'prepared' | 'partial'; verifiedSha256: string;
      content: { kind: 'text'; text: string } | { kind: 'attachment'; file: unknown }; pdf?: MaterialDispatchPdfCoverage }
  | { status: 'unsupported' | 'failed'; code: string; pdf?: MaterialDispatchPdfCoverage }
);

/** Main-only projection strips all body/attachment data and copies PDF evidence verbatim.
 * It records preparation only; nothing here records consumer acceptance or authorizes use.
 */
export function materialDispatchPreparationFromItems(preparationKey: string, items: readonly MaterialDispatchPreparedSource[]): MaterialDispatchPreparation {
  return { preparationKey, items: items.map<MaterialDispatchPreparedItem>(item => {
    const base = { referenceId: item.referenceId, materialId: item.materialId, version: item.version,
      versionId: item.versionId, expectedSha256: item.expectedSha256,
      coverage: item.pdf ? { ...item.pdf } : null };
    if (item.status === 'unsupported' || item.status === 'failed') return { ...base,
      verifiedSha256: null, readiness: item.status, failureCode: item.code, representation: 'unavailable', textSha256: null };
    if ('content' in item) return { ...base, verifiedSha256: item.verifiedSha256,
      readiness: item.status === 'partial' ? 'partial' : 'ready', failureCode: null,
      representation: item.content.kind === 'text' ? item.pdf ? 'pdf-text' : 'text' : 'image',
      textSha256: item.content.kind === 'text' ? createHash('sha256').update(item.content.text).digest('hex') : null };
    throw new Error('Invalid material preparation');
  }) };
}
