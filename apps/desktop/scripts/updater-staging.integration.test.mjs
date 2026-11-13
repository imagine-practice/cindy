import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { findMtExe, stageUpdaterExecutable } from '../forge-updater';

// Value: real production staging must preserve Cargo output and the prior release on failure.
// The d25 mt.exe failure is not reproduced here; existing package tests do not exercise mt.
// Minimal input is a copied PE with a Cargo-style hardlink and valid/invalid manifest.
// Integration tier: requires the installed Windows SDK and real native resource editing.
// A separate file keeps the SDK requirement out of the existing portable packaging unit tests.
describe.skipIf(process.platform !== 'win32')('Windows updater manifest staging', () => {
  let root, mt, fixtureExe, fixtureHash, manifest;
  const digest = file => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
  beforeAll(() => {
    mt = findMtExe();
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-updater-staging-test-'));
    const cargoExe = path.resolve(__dirname, '../cindy-updater/src-tauri/target/release/cindy-updater.exe');
    // CI need not compile Cargo for this test: an SDK PE provides the same resource-editing seam.
    fixtureExe = fs.existsSync(cargoExe) ? cargoExe : mt;
    fixtureHash = digest(fixtureExe);
    manifest = path.resolve(__dirname, '../cindy-updater/src-tauri/cindy-updater.manifest');
  });
  afterAll(() => {
    if (root) fs.rmSync(root, { recursive: true, force: true });
  });

  it.each(['success', 'manifest failure', 'publication failure'])('preserves producer/target boundaries and cleans its stage on %s', outcome => {
    const dir = fs.mkdtempSync(path.join(root, 'case-'));
    const source = path.join(dir, 'cargo-updater.exe'), alias = path.join(dir, 'cargo-deps.exe');
    const destination = path.join(dir, 'release-updater.exe'), neighbor = path.join(dir, 'keep.txt');
    fs.copyFileSync(fixtureExe, source);
    fs.linkSync(source, alias);
    if (outcome === 'publication failure') {
      fs.mkdirSync(destination);
      fs.writeFileSync(path.join(destination, 'prior-data.txt'), 'prior destination');
    } else fs.copyFileSync(mt, destination);
    fs.writeFileSync(neighbor, 'unrelated temporary file');
    const beforeSource = digest(source), beforeTarget = outcome === 'publication failure' ? null : digest(destination);
    const badManifest = path.join(dir, 'invalid.manifest');
    fs.writeFileSync(badManifest, '<invalid');
    const observedStages = vi.spyOn(fs, 'mkdtempSync');
    try {
      if (outcome === 'manifest failure') {
        expect(() => stageUpdaterExecutable(source, destination, badManifest)).toThrow(/mt\.exe exited/);
        expect(digest(destination)).toBe(beforeTarget);
      } else if (outcome === 'publication failure') {
        expect(() => stageUpdaterExecutable(source, destination, manifest)).toThrow();
        expect(fs.readdirSync(destination)).toEqual(['prior-data.txt']);
        expect(fs.readFileSync(path.join(destination, 'prior-data.txt'), 'utf8')).toBe('prior destination');
      } else {
        stageUpdaterExecutable(source, destination, manifest);
      }
      expect(digest(source)).toBe(beforeSource);
      expect(digest(alias)).toBe(beforeSource);
      expect(fs.statSync(source).nlink).toBe(2);
      expect(digest(fixtureExe)).toBe(fixtureHash);
      expect(fs.readFileSync(neighbor, 'utf8')).toBe('unrelated temporary file');
      for (const call of observedStages.mock.results.filter(result => result.type === 'return')) {
        expect(fs.existsSync(call.value)).toBe(false);
        expect(call.value).not.toBe(dir);
      }
    } finally { observedStages.mockRestore(); }

    if (outcome === 'success') {
      const extracted = path.join(dir, 'extracted.manifest');
      const extract = spawnSync(mt, ['-nologo', `-inputresource:${destination};#1`, `-out:${extracted}`], { encoding: 'utf8' });
      expect(extract.status, extract.stderr).toBe(0);
      const canonical = [manifest, extracted].map((input, index) => {
        const output = path.join(dir, `canonical-${index}.manifest`);
        const result = spawnSync(mt, ['-nologo', '-manifest', input, '-canonicalize', `-out:${output}`], { encoding: 'utf8' });
        expect(result.status, result.stderr).toBe(0);
        return fs.readFileSync(output);
      });
      expect(canonical[1].equals(canonical[0])).toBe(true);
    }
  });
});
