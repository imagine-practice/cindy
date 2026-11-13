import fs from 'node:fs';
import path from 'node:path';
import { migrationDigest, migrationFileHash } from './migration-catalog-loader.mjs';

export function generationBaselineFingerprint(developmentDir) {
  const meta=path.join(developmentDir,'meta');
  const files=fs.readdirSync(meta).filter(f=>f.endsWith('.json')).sort();
  const journal=JSON.parse(fs.readFileSync(path.join(meta,'_journal.json'),'utf8'));
  const head=journal.entries?.at(-1)?.idx;
  if (!Number.isSafeInteger(head)) throw new Error('Invalid custom generation baseline');
  return {metadataSha256:migrationDigest(files.map(f=>[f,migrationFileHash(path.join(meta,f))])),
    schemaSnapshotSha256:migrationFileHash(path.join(meta,`${String(head).padStart(4,'0')}_snapshot.json`))};
}

export function validateGenerationBaseline(developmentDir,catalogDigest) {
  const binding=JSON.parse(fs.readFileSync(path.join(developmentDir,'catalog-binding.json'),'utf8'));
  const fingerprints=generationBaselineFingerprint(developmentDir);
  if (binding.version !== 1 || binding.catalogDigest !== catalogDigest ||
      binding.metadataSha256 !== fingerprints.metadataSha256 || binding.schemaSnapshotSha256 !== fingerprints.schemaSnapshotSha256) {
    throw new Error('Custom generation baseline/catalog identity changed; review an actual generated combined baseline');
  }
  return binding;
}
