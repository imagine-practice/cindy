/** Material-only byte verification. No writes and no storage reference projection. */
import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import * as blobStore from '../../cindy-media/blobStore';
import { verifyMaterialSource, TEXT_PREVIEW_MAX_BYTES } from '../../cindy-media/materialSource';
import type { MaterialStorageKind } from '../../../shared/materials';
import { getSensitiveMediaBlocklist, isPathAllowedAgainst } from '../../filePathPolicy';

// Request-local immutable bytes, not another persistent media store. Larger previews are unsupported.
export const MATERIAL_PREVIEW_MAX_BYTES = 32 * 1024 * 1024;
export async function readMaterialPreviewBytes(row: PrivateMaterialVersion): Promise<Uint8Array<ArrayBuffer>> {
  if (!Number.isSafeInteger(row.sizeBytes) || row.sizeBytes < 0 || row.sizeBytes > MATERIAL_PREVIEW_MAX_BYTES) throw Error('Unsupported preview size');
  let handle: fs.FileHandle | undefined;
  try {
    if (row.storageKind === 'media') handle = (await blobStore.openBlobFile(row.storageRef)).file;
    else if (row.storageKind === 'file') {
      const resolved = await fs.realpath(row.storageRef);
      if (!isPathAllowedAgainst(row.storageRef, getSensitiveMediaBlocklist()) ||
          !isPathAllowedAgainst(resolved, getSensitiveMediaBlocklist())) throw Error('Forbidden source');
      handle = await fs.open(resolved, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    } else throw Error('Unsupported storage');
    const before = await handle.stat();
    if (!before.isFile() || before.size !== row.sizeBytes) throw Error('Source changed');
    const bytes = new Uint8Array(row.sizeBytes + 1);
    let length = 0;
    while (length < bytes.length) {
      const read = await handle.read(bytes, length, bytes.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const after = await handle.stat();
    if (length !== row.sizeBytes || after.size !== before.size || after.mtimeMs !== before.mtimeMs ||
        after.ctimeMs !== before.ctimeMs || createHash('sha256').update(bytes.subarray(0, length)).digest('hex') !== row.sha256) throw Error('Source changed');
    return bytes.slice(0, length);
  } finally { await handle?.close(); }
}
export interface PrivateMaterialVersion {
  id: string; materialId: string; version: number; name: string; mime: string; sizeBytes: number;
  storageKind: MaterialStorageKind; storageRef: string; sha256: string;
}
export type MaterialBytesCheck = { ok: true } | { ok: false; reason: 'SOURCE_MISSING' | 'SOURCE_CHANGED' | 'media-unreadable' };
export async function checkMaterialBytes(row: PrivateMaterialVersion): Promise<MaterialBytesCheck> {
  if (row.storageKind === 'file') return verifyMaterialSource({ filePath: row.storageRef, expectedSha256: row.sha256 });
  if (row.storageKind !== 'media') return { ok: false, reason: 'media-unreadable' };
  try {
    const opened = await blobStore.openBlobFile(row.storageRef);
    try {
      const hash = createHash('sha256'), buffer = Buffer.alloc(256 * 1024);
      let position = 0;
      for (;;) {
        const read = await opened.file.read(buffer, 0, buffer.length, position);
        if (!read.bytesRead) break;
        hash.update(buffer.subarray(0, read.bytesRead)); position += read.bytesRead;
      }
      return hash.digest('hex') === row.sha256 ? { ok: true } : { ok: false, reason: 'media-unreadable' };
    } finally { await opened.file.close(); }
  } catch { return { ok: false, reason: 'media-unreadable' }; }
}
/** Hash the very buffer being decoded, not an earlier read of the mutable source path. */
export async function readVerifiedMaterialText(row: PrivateMaterialVersion): Promise<
  { ok: true; text: string } | { ok: false; reason: 'SOURCE_MISSING' | 'SOURCE_CHANGED' | 'unsupported' }
> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(row.storageRef, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'SOURCE_CHANGED' };
    if (stat.size > TEXT_PREVIEW_MAX_BYTES) return { ok: false, reason: 'unsupported' };
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const read = await handle.read(buffer, length, buffer.length - length, length);
      if (!read.bytesRead) break;
      length += read.bytesRead;
    }
    const bytes = buffer.subarray(0, length);
    if (createHash('sha256').update(bytes).digest('hex') !== row.sha256) return { ok: false, reason: 'SOURCE_CHANGED' };
    try { return { ok: true, text: new TextDecoder('utf-8', { fatal: true }).decode(bytes) }; }
    catch { return { ok: false, reason: 'unsupported' }; }
  } catch (error) {
    return { ok: false, reason: (error as NodeJS.ErrnoException).code === 'ENOENT' ? 'SOURCE_MISSING' : 'SOURCE_CHANGED' };
  } finally { await handle?.close(); }
}
