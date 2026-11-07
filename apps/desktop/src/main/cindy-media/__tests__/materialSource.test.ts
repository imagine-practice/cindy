/**
 * 材料源文件判定与复核（M2-A / 契约 0.1）。
 *
 * 用真实文件验证用户会直接看到的行为：
 *   - 媒体与非媒体按真实字节分流：图片走媒体仓形态，文本/PDF 走 `file` 形态且不复制；
 *   - 扩展名不作依据：`.png` 后缀的文本仍是 `file` 形态；
 *   - `file` 形态的三条复核结论：正常读取、源文件改动（SOURCE_CHANGED）、
 *     源文件删除（SOURCE_MISSING），以及文本正文预览。
 */
import { createHash } from 'node:crypto';
import { mkdtemp, rm, unlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import {
  probeMaterialSource,
  readMaterialTextPreview,
  verifyMaterialSource,
} from '../materialSource';

const PNG_HEADER = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01, 0x08, 0x06, 0x00, 0x00, 0x00, 
]);
const TEXT_BODY = '材料正文：这是一份 UTF-8 文本，用于验证文本预览与指纹复核。\n';

function sha256(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex');
}

describe('material source probe', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cindy-material-source-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('图片按字节识别为媒体形态，并给出真实指纹与大小', async () => {
    const file = path.join(dir, 'image.bin');
    await writeFile(file, PNG_HEADER);
    const probe = await probeMaterialSource(file);
    expect(probe).toMatchObject({
      ok: true,
      storageKind: 'media',
      sha256: sha256(PNG_HEADER),
      sizeBytes: PNG_HEADER.byteLength,
      mime: 'image/png',
      sourceMtime: null,
    });
  });

  it('文本走 file 形态（不复制），并记录 mtime；扩展名不参与判定', async () => {
    const disguised = path.join(dir, 'plainly-not-an-image.png');
    await writeFile(disguised, TEXT_BODY, 'utf8');
    const probe = await probeMaterialSource(disguised);
    expect(probe).toMatchObject({
      ok: true,
      storageKind: 'file',
      sha256: sha256(TEXT_BODY),
      sizeBytes: Buffer.byteLength(TEXT_BODY),
      mime: 'text/plain',
    });
    expect(probe.ok && typeof probe.sourceMtime === 'number' && probe.sourceMtime > 0).toBe(true);
  });

  it('PDF 按字节识别为 file 形态的 application/pdf', async () => {
    const file = path.join(dir, 'report.pdf');
    await writeFile(file, Buffer.concat([Buffer.from('%PDF-1.7\n'), Buffer.alloc(64, 0x20)]));
    const probe = await probeMaterialSource(file);
    expect(probe).toMatchObject({ ok: true, storageKind: 'file', mime: 'application/pdf' });
  });

  it('空文件、目录与不存在的路径分别是可读的失败原因，不是「已读」', async () => {
    const empty = path.join(dir, 'empty.txt');
    await writeFile(empty, '');
    expect(await probeMaterialSource(empty)).toEqual({ ok: false, reason: 'empty' });
    expect(await probeMaterialSource(dir)).toEqual({ ok: false, reason: 'unreadable' });
    expect(await probeMaterialSource(path.join(dir, 'missing.png'))).toEqual({
      ok: false,
      reason: 'unreadable',
    });
  });
});

describe('file 形态源文件复核（契约 0.1）', () => {
  let dir: string;

  beforeAll(async () => {
    dir = await mkdtemp(path.join(tmpdir(), 'cindy-material-verify-'));
  });
  afterAll(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it('正常读取：内容与记录一致时通过，并能给出文本正文', async () => {
    const file = path.join(dir, 'notes.md');
    await writeFile(file, TEXT_BODY, 'utf8');
    const expectedSha256 = sha256(TEXT_BODY);

    expect(await verifyMaterialSource({ filePath: file, expectedSha256 })).toEqual({ ok: true });
    expect(await readMaterialTextPreview(file)).toEqual({ ok: true, text: TEXT_BODY });
  });

  it('源文件改动：sha256 与添加时不一致即 SOURCE_CHANGED，不拿新内容冒充旧依据', async () => {
    const file = path.join(dir, 'edited.md');
    await writeFile(file, TEXT_BODY, 'utf8');
    const expectedSha256 = sha256(TEXT_BODY);
    await writeFile(file, `${TEXT_BODY}（后来补的一段）\n`, 'utf8');

    expect(await verifyMaterialSource({ filePath: file, expectedSha256 })).toEqual({
      ok: false,
      reason: 'SOURCE_CHANGED',
    });
  });

  it('源文件删除：明确报告 SOURCE_MISSING', async () => {
    const file = path.join(dir, 'gone.md');
    await writeFile(file, TEXT_BODY, 'utf8');
    const expectedSha256 = sha256(TEXT_BODY);
    await unlink(file);

    expect(await verifyMaterialSource({ filePath: file, expectedSha256 })).toEqual({
      ok: false,
      reason: 'SOURCE_MISSING',
    });
  });

  it('超过内联预览上限时明确拒绝，不返回截断的正文', async () => {
    const file = path.join(dir, 'huge.md');
    await writeFile(file, 'x'.repeat(64));
    expect(await readMaterialTextPreview(file, 16)).toEqual({ ok: false, reason: 'too-large' });
  });
});
