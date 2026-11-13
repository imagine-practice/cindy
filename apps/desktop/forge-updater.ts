import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawnSync } from 'node:child_process';

/** Resolve the existing Windows SDK manifest tool; never install a toolchain. */
export function findMtExe(): string {
  const candidates = [
    'C:\\Program Files (x86)\\Windows Kits\\10\\bin',
    'C:\\Program Files\\Windows Kits\\10\\bin',
  ];
  for (const base of candidates) {
    if (!fs.existsSync(base)) continue;
    const versions = fs.readdirSync(base).filter(d => /^10\.\d+\.\d+\.\d+$/.test(d)).sort().reverse();
    for (const version of versions) {
      const mt = path.join(base, version, 'x64', 'mt.exe');
      if (fs.existsSync(mt)) return mt;
    }
    const flat = path.join(base, 'x64', 'mt.exe');
    if (fs.existsSync(flat)) return flat;
  }
  throw new Error('[forge] mt.exe not found. Install Windows 10/11 SDK and ensure ' +
    '"C:\\Program Files (x86)\\Windows Kits\\10\\bin\\<ver>\\x64\\mt.exe" exists.');
}

/** Embed the required manifest before publishing the updater to release resources. */
export function stageUpdaterExecutable(sourceExe: string, destinationExe: string, manifestPath: string): void {
  if (!fs.existsSync(manifestPath)) throw new Error(`[forge] manifest missing at ${manifestPath}`);
  const stageDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-updater-stage-'));
  let publicationDir: string | undefined;
  try {
    // Cargo may share its output with a dependency artifact. Only edit an owned copy.
    const stagedExe = path.join(stageDir, path.basename(destinationExe));
    fs.copyFileSync(sourceExe, stagedExe);
    const result = spawnSync(findMtExe(), ['-nologo', '-manifest', manifestPath, `-outputresource:${stagedExe};#1`], {
      stdio: 'inherit',
    });
    if (result.error) throw new Error(`[forge] mt.exe spawn failed: ${result.error.message}`);
    if (result.status !== 0) throw new Error(`[forge] mt.exe exited ${result.status} when patching manifest`);
    // Prepare the replacement beside the destination so failed copying cannot damage it.
    publicationDir = fs.mkdtempSync(path.join(path.dirname(destinationExe), '.cindy-updater-publish-'));
    const replacement = path.join(publicationDir, path.basename(destinationExe));
    fs.copyFileSync(stagedExe, replacement);
    fs.renameSync(replacement, destinationExe);
    console.log(`[forge:prePackage] manifest patched into ${path.basename(destinationExe)} (PCA bypass)`);
  } finally {
    try { if (publicationDir) fs.rmSync(publicationDir, { recursive: true, force: true }); }
    finally { fs.rmSync(stageDir, { recursive: true, force: true }); }
  }
}
