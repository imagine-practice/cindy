/**
 * materialSource.ts — 材料字节形态判定与源文件复核（M2-A，契约 0.1）。
 *
 * 契约把材料分两种存储形态，仍然只有一个媒体仓：
 *   - `media`：图片/音视频/glb（命中 `cindy-media` 白名单）→ 由 `ingestMedia` 写入媒体仓，
 *     指纹与类型都由宿主按真实字节得出；
 *   - `file`：文本/PDF/Office/其他非媒体 → **不复制、不入媒体仓**，只引用用户原文件，
 *     记录绝对路径、添加时的 sha256 / size / mtime，可读性靠每次预览前重算 sha256。
 *
 * 本模块只读不写，是「按真实字节判定」的唯一实现：扩展名不决定类型，也不决定是否入仓。
 */

import fs from 'node:fs/promises';
import { createHash } from 'node:crypto';

import type { MaterialStorageKind } from '../../shared/materials';
import { sniffMediaMime } from './sniffMediaMime';

/** 头部探测窗口：足够覆盖媒体魔数与文本判定。 */
export const HEAD_PROBE_BYTES = 64 * 1024;
/** 预览内联文本上限：超出即「不解析正文」，不截断冒充完整内容。 */
export const TEXT_PREVIEW_MAX_BYTES = 1024 * 1024;
const READ_CHUNK_BYTES = 256 * 1024;

export type MaterialSourceProbe =
  | {
      ok: true;
      storageKind: MaterialStorageKind;
      sha256: string;
      sizeBytes: number;
      mime: string;
      /** 仅 `file` 形态记录：添加时原文件 mtime（毫秒）。 */
      sourceMtime: number | null;
    }
  | { ok: false; reason: 'unreadable' | 'empty' };

/** 一次顺序读：容器内边算指纹边取头部，读完整份内容。 */
interface SourceRead {
  sha256: string;
  sizeBytes: number;
  head: Buffer;
  mtimeMs: number;
}

async function readWholeFile(filePath: string): Promise<SourceRead | null> {
  const hasher = createHash('sha256');
  const chunk = Buffer.alloc(READ_CHUNK_BYTES);
  let head = Buffer.alloc(0);
  let sizeBytes = 0;
  let handle: fs.FileHandle | undefined;
  try {
    // 只认普通文件；符号链接（O_NOFOLLOW）与目录一律不当作材料源。
    handle = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return null;
    let position = 0;
    for (;;) {
      const { bytesRead } = await handle.read(chunk, 0, chunk.length, position);
      if (bytesRead === 0) break;
      const part = chunk.subarray(0, bytesRead);
      if (head.length < HEAD_PROBE_BYTES) {
        head = Buffer.concat([head, part.subarray(0, HEAD_PROBE_BYTES - head.length)]);
      }
      hasher.update(part);
      sizeBytes += bytesRead;
      position += bytesRead;
    }
    return { sha256: hasher.digest('hex'), sizeBytes, head, mtimeMs: Math.trunc(stat.mtimeMs) };
  } catch {
    return null;
  } finally {
    await handle?.close().catch(() => undefined);
  }
}

/** UTF-8 文本的头部解码：容忍多字节字符被探测窗口切断，含 NUL 即判为二进制。 */
function decodeUtf8Head(head: Buffer): string | null {
  if (head.includes(0)) return null;
  for (let trim = 0; trim <= 3 && trim < head.byteLength; trim += 1) {
    try {
      const text = new TextDecoder('utf-8', { fatal: true }).decode(
        head.subarray(0, head.byteLength - trim),
      );
      return text;
    } catch {
      // 末尾可能正好落在多字节字符中间，去掉 1~3 字节再判一次。
    }
  }
  return null;
}

/**
 * 非媒体形态的保守类型判定。
 *
 * 只看字节：`%PDF-` = PDF，ZIP 容器（Office 文档与普通 zip 同形，这里不解析内容，
 * 因此不下压成 docx/xlsx），可解码的 UTF-8 无 NUL 内容 = 文本，其余 = 未知二进制。
 * 可读性判断不依赖这里的 mime，`file` 形态的真相是 sha256。
 */
function sniffDocumentMime(head: Buffer): string {
  if (head.byteLength >= 5 && head.subarray(0, 5).toString('latin1') === '%PDF-') {
    return 'application/pdf';
  }
  if (
    head.byteLength >= 4 &&
    head[0] === 0x50 &&
    head[1] === 0x4b &&
    (head[2] === 0x03 || head[2] === 0x05 || head[2] === 0x07) &&
    (head[3] === 0x04 || head[3] === 0x06 || head[3] === 0x08)
  ) {
    return 'application/zip';
  }
  if (decodeUtf8Head(head) !== null) return 'text/plain';
  return 'application/octet-stream';
}

/**
 * 判定一份本机文件的材料形态并给出指纹、大小、真实 mime 与 mtime。
 *
 * 读不到（不存在 / 权限 / 符号链接 / 目录）与空文件分开表达，由调用方映射成可读错误。
 */
export async function probeMaterialSource(filePath: string): Promise<MaterialSourceProbe> {
  const read = await readWholeFile(filePath);
  if (!read) return { ok: false, reason: 'unreadable' };
  if (read.sizeBytes === 0) return { ok: false, reason: 'empty' };
  const mediaMime = sniffMediaMime(read.head);
  if (mediaMime) {
    return {
      ok: true,
      storageKind: 'media',
      sha256: read.sha256,
      sizeBytes: read.sizeBytes,
      mime: mediaMime,
      sourceMtime: null,
    };
  }
  return {
    ok: true,
    storageKind: 'file',
    sha256: read.sha256,
    sizeBytes: read.sizeBytes,
    mime: sniffDocumentMime(read.head),
    sourceMtime: read.mtimeMs,
  };
}

export type MaterialSourceVerification =
  | { ok: true }
  | { ok: false; reason: 'SOURCE_MISSING' | 'SOURCE_CHANGED' };

/**
 * 复核 `file` 形态的源文件是否仍是我们记录的那份内容（契约 0.1）。
 *
 * 每次预览前都要跑：源文件被删除 → `SOURCE_MISSING`；内容与添加时的 sha256 不一致
 * （被改写、被替换、读不出来）→ `SOURCE_CHANGED`。绝不用新内容冒充旧依据。
 */
export async function verifyMaterialSource(params: {
  filePath: string;
  expectedSha256: string;
}): Promise<MaterialSourceVerification> {
  try {
    const stat = await fs.stat(params.filePath);
    if (!stat.isFile()) return { ok: false, reason: 'SOURCE_CHANGED' };
  } catch {
    return { ok: false, reason: 'SOURCE_MISSING' };
  }
  const read = await readWholeFile(params.filePath);
  if (!read) return { ok: false, reason: 'SOURCE_CHANGED' };
  if (read.sha256 !== params.expectedSha256) return { ok: false, reason: 'SOURCE_CHANGED' };
  return { ok: true };
}

export type MaterialTextPreview =
  | { ok: true; text: string }
  | { ok: false; reason: 'too-large' | 'not-text' | 'unreadable' };

/** 读取文本正文用于内联预览；不做截断，超限就明确「不解析正文」。 */
export async function readMaterialTextPreview(
  filePath: string,
  maxBytes = TEXT_PREVIEW_MAX_BYTES,
): Promise<MaterialTextPreview> {
  let handle: fs.FileHandle | undefined;
  try {
    handle = await fs.open(filePath, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW ?? 0));
    const stat = await handle.stat();
    if (!stat.isFile()) return { ok: false, reason: 'unreadable' };
    if (stat.size > maxBytes) return { ok: false, reason: 'too-large' };
    const buffer = Buffer.alloc(stat.size + 1);
    let length = 0;
    while (length < buffer.length) {
      const { bytesRead } = await handle.read(buffer, length, buffer.length - length, length);
      if (bytesRead === 0) break;
      length += bytesRead;
    }
    if (length > maxBytes) return { ok: false, reason: 'too-large' };
    const text = new TextDecoder('utf-8', { fatal: true }).decode(buffer.subarray(0, length));
    return { ok: true, text };
  } catch {
    return { ok: false, reason: 'not-text' };
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
