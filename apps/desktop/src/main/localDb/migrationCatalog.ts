import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export type MigrationNamespace = 'upstream' | 'custom';
export interface MigrationKey { namespace: MigrationNamespace; id: number }
export interface CatalogEntry extends MigrationKey {
  fileName: string;
  sqlPath: string;
  sqlHash: string;
  scriptPath: string | null;
  scriptHash: string | null;
  dependsOn: MigrationKey[];
  legacySeq?: number;
}
export interface MigrationCatalog {
  format: 2;
  digest: string;
  entries: CatalogEntry[];
  bootstrapPath: string;
  bootstrapHash: string;
}

export function migrationDigest(value: unknown): string {
  return crypto.createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

function readMigrationResource(file: string): {sha256: string; readBytes: number; normalizedBytes: number} {
  const bytes = fs.readFileSync(file);
  const normalized = bytes.toString('utf8').replace(/\r\n/g, '\n');
  return {sha256: crypto.createHash('sha256').update(normalized).digest('hex'),
    readBytes: bytes.length, normalizedBytes: Buffer.byteLength(normalized)};
}

export function migrationFileHash(file: string): string {
  return readMigrationResource(file).sha256;
}

export function migrationKey(key: MigrationKey): string { return `${key.namespace}:${key.id}`; }

export function migrationCatalogSummary(catalog: MigrationCatalog): object {
  return {format:2,minimumRunner:'dual-chain-v2',catalogSha256:catalog.digest,bootstrapSha256:catalog.bootstrapHash,
    namespaces:(['upstream','custom'] as const).map(namespace => ({namespace,
      head:Math.max(...catalog.entries.filter(e=>e.namespace===namespace).map(e=>e.id)),
      count:catalog.entries.filter(e=>e.namespace===namespace).length}))};
}

export function hasDualMigrationCatalog(drizzleDir: string): boolean {
  // An incomplete catalog must fail closed, never fall back to numeric scanning.
  return fs.existsSync(path.join(drizzleDir, 'catalog'));
}

/** Absolute installation paths never participate in the immutable identity. */
export function catalogIdentity(entry: CatalogEntry): object {
  return {
    namespace: entry.namespace, id: entry.id, fileName: entry.fileName,
    sqlHash: entry.sqlHash, scriptHash: entry.scriptHash, dependsOn: entry.dependsOn,
    legacySeq: entry.legacySeq ?? null,
  };
}

/** Validate the whole dependency graph and every resource before executing any SQL. */
export function loadMigrationCatalog(drizzleDir: string): MigrationCatalog {
  const root = fs.realpathSync(drizzleDir);
  const resources = new Set<string>();
  const resource = (relative: string): string => {
    if (typeof relative !== 'string' || path.isAbsolute(relative)) throw new Error('Invalid migration resource');
    const absolute = path.resolve(root, relative);
    if (!absolute.startsWith(`${root}${path.sep}`) || fs.realpathSync(absolute) !== absolute) {
      throw new Error(`Migration resource escapes its installation: ${relative}`);
    }
    if (resources.has(absolute)) throw new Error(`Duplicate migration resource: ${relative}`);
    resources.add(absolute);
    return absolute;
  };
  const format = JSON.parse(fs.readFileSync(path.join(root, 'catalog/format.json'), 'utf8'));
  if (format.version !== 2 || format.commonLegacyHead !== 148) throw new Error('Unsupported migration catalog format');
  const bootstrapPath = resource(format.bootstrap.sqlPath);
  const bootstrapHash = migrationFileHash(bootstrapPath);
  if (bootstrapHash !== format.bootstrap.sqlHash) throw new Error('Migration bootstrap identity changed');
  const descriptors = fs.readdirSync(path.join(root, 'catalog/entries')).filter(f => f.endsWith('.json')).sort();
  const entries: CatalogEntry[] = descriptors.map(file => {
    const raw = JSON.parse(fs.readFileSync(path.join(root, 'catalog/entries', file), 'utf8'));
    if (!['upstream', 'custom'].includes(raw.namespace) || !Number.isSafeInteger(raw.id) || raw.id < 0 ||
        !Array.isArray(raw.dependsOn) || !/^[\da-f]{64}$/.test(raw.sqlHash)) {
      throw new Error(`Invalid migration descriptor: ${file}`);
    }
    const sqlPath = resource(raw.sqlPath);
    const scriptPath = raw.scriptPath === null ? null : resource(raw.scriptPath);
    if (path.extname(sqlPath) !== '.sql' || (scriptPath && path.basename(scriptPath) !== path.basename(sqlPath).replace(/\.sql$/,'.ts'))) {
      throw new Error(`Invalid migration SQL/companion pair: ${file}`);
    }
    const sqlRead = readMigrationResource(sqlPath);
    const companionRead = scriptPath ? readMigrationResource(scriptPath) : null;
    if (sqlRead.sha256 !== raw.sqlHash || (companionRead?.sha256 ?? null) !== raw.scriptHash) {
      // Retain evidence from the rejected reads; rereading after an error could hide a transient change.
      // Paths, digests and byte lengths are diagnostic metadata. Never include SQL/script contents.
      const details = {namespace: raw.namespace, id: raw.id,
        descriptorPath: path.posix.join('catalog', 'entries', file),
        sql: {relativePath: raw.sqlPath, actualPath: sqlPath, expectedNormalizedSha256: raw.sqlHash,
          actualNormalizedSha256: sqlRead.sha256, readBytes: sqlRead.readBytes, normalizedBytes: sqlRead.normalizedBytes},
        companion: companionRead ? {relativePath: raw.scriptPath, actualPath: scriptPath,
          expectedNormalizedSha256: raw.scriptHash, actualNormalizedSha256: companionRead.sha256,
          readBytes: companionRead.readBytes, normalizedBytes: companionRead.normalizedBytes} : null};
      throw Object.assign(new Error(`Migration resource identity changed: ${file}; ${JSON.stringify(details)}`),
        {code: 'MIGRATION_RESOURCE_IDENTITY_CHANGED', details});
    }
    if (path.basename(sqlPath) !== raw.fileName) throw new Error(`Invalid migration file name: ${file}`);
    if (raw.dependsOn.some((d: MigrationKey) => !d || !['upstream','custom'].includes(d.namespace) || !Number.isSafeInteger(d.id) || d.id < 0)) {
      throw new Error(`Invalid migration dependency: ${file}`);
    }
    if (raw.legacySeq !== undefined && (!Number.isSafeInteger(raw.legacySeq) || raw.legacySeq < 0)) {
      throw new Error(`Invalid legacy migration binding: ${file}`);
    }
    return { ...raw, sqlPath, scriptPath } as CatalogEntry;
  });
  const byKey = new Map(entries.map(e => [migrationKey(e), e]));
  if (byKey.size !== entries.length) throw new Error('Duplicate migration namespace/id');
  for (const namespace of ['upstream', 'custom'] as const) {
    const chain = entries.filter(e => e.namespace === namespace).sort((a, b) => a.id - b.id);
    chain.forEach((entry, i) => {
      if (entry.id !== i + (namespace === 'custom' ? 1 : 0)) throw new Error(`Gap in ${namespace} migration chain`);
      if (i && !entry.dependsOn.some(d => migrationKey(d) === migrationKey(chain[i - 1]))) {
        throw new Error(`Missing predecessor in ${migrationKey(entry)}`);
      }
    });
  }
  const ordered: CatalogEntry[] = [], visiting = new Set<string>(), done = new Set<string>();
  const visit = (entry: CatalogEntry): void => {
    const key = migrationKey(entry);
    if (visiting.has(key)) throw new Error(`Cyclic migration dependencies: ${key}`);
    if (done.has(key)) return;
    visiting.add(key);
    for (const dependency of entry.dependsOn) {
      const target = byKey.get(migrationKey(dependency));
      if (!target) throw new Error(`Missing migration dependency: ${migrationKey(dependency)}`);
      visit(target);
    }
    visiting.delete(key); done.add(key); ordered.push(entry);
  };
  [...entries].sort((a, b) => a.namespace.localeCompare(b.namespace) || a.id - b.id).forEach(visit);
  // Every legacy SQL must have exactly one owner; a duplicate numeric prefix is legal only across owners.
  for (const file of fs.readdirSync(root).filter(f => /^\d{4}_.*\.sql$/.test(f))) {
    if (!resources.has(path.join(root, file))) throw new Error(`Unowned migration SQL: ${file}`);
  }
  for (const file of fs.readdirSync(path.join(root, 'scripts')).filter(f => /^\d{4}_.*\.ts$/.test(f))) {
    if (!resources.has(path.join(root, 'scripts', file))) throw new Error(`Unowned migration companion: ${file}`);
  }
  const checkOwned = (dir: string): void => {
    if (!fs.existsSync(dir)) return;
    for (const file of fs.readdirSync(dir,{withFileTypes:true})) {
      const full=path.join(dir,file.name);
      if (file.isSymbolicLink()) throw new Error('Symlink in migration resources');
      if (file.isDirectory()) checkOwned(full);
      else if (/\.(?:sql|ts)$/.test(file.name) && !resources.has(full)) throw new Error(`Unowned migration resource: ${full}`);
    }
  };
  checkOwned(path.join(root,'catalog/custom'));checkOwned(path.join(root,'catalog/bootstrap'));
  const mapping = JSON.parse(fs.readFileSync(path.join(root,'catalog/legacy-fork-v1.json'),'utf8'));
  if (mapping.version !== 1 || mapping.sourceCommit !== '9c7b400a0098722d10390fdda871acc8f77efc22' ||
      mapping.legacyHead !== 161 || !Array.isArray(mapping.customKeys) || mapping.customKeys.length !== 13 ||
      mapping.customKeys.some((key: {namespace:string;id:number;legacySeq:number;fileName:string;sqlHash:string;scriptHash:string|null}, i:number) => {
        const e=byKey.get(`custom:${i+1}`);
        return !e || key.namespace !== 'custom' || key.id !== i+1 || key.legacySeq !== 149+i ||
          e.legacySeq !== key.legacySeq || e.fileName !== key.fileName || e.sqlHash !== key.sqlHash || e.scriptHash !== key.scriptHash;
      })) throw new Error('Invalid immutable fork legacy mapping');
  if (entries.some(e=>e.namespace === 'custom' && e.id>13 && e.legacySeq !== undefined)) throw new Error('New custom migration cannot claim a legacy sequence');
  return { format: 2, entries: ordered, bootstrapPath, bootstrapHash,
    digest: migrationDigest({ format: 2, bootstrapHash, entries: ordered.map(catalogIdentity) }) };
}
