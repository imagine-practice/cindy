import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { loadMigrationCatalog, migrationFileHash } from './lib/migration-catalog-loader.mjs';
import { generationBaselineFingerprint, validateGenerationBaseline } from './lib/migration-generation.mjs';

const desktop = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2).filter(a => a !== '--');
const namespace = args.find(a => a.startsWith('--namespace='))?.split('=')[1];
if (namespace !== 'custom') throw new Error('Use db:generate --namespace=custom --name=<name>. Upstream resources are imported unchanged from upstream.');
const forwarded = args.filter(a => !a.startsWith('--namespace='));
if (forwarded.some(a => !/^(?:--custom|--name=[a-z0-9_-]+)$/.test(a))) throw new Error('Only --name=<name> and --custom are supported; schema/out/dialect are fixed.');
if (!forwarded.some(a => a.startsWith('--name='))) throw new Error('A migration name is required');
const drizzleDir = path.join(desktop,'drizzle');
const catalog = loadMigrationCatalog(drizzleDir);
const development = path.join(desktop,'migration-development/custom');
const bindingPath = path.join(development,'catalog-binding.json');
const binding = validateGenerationBaseline(development,catalog.digest);
const nextId = Math.max(0,...catalog.entries.filter(e=>e.namespace==='custom').map(e=>e.id))+1;
const runtimeDir = path.join(drizzleDir,'catalog/custom',String(nextId).padStart(4,'0'));
if (fs.existsSync(runtimeDir)) throw new Error('Custom migration output already exists');
const temp = fs.mkdtempSync(path.join(os.tmpdir(),'cindy-custom-generate-'));
try {
  fs.cpSync(path.join(development,'meta'),path.join(temp,'meta'),{recursive:true});
  const journalBefore = JSON.parse(fs.readFileSync(path.join(temp,'meta/_journal.json'),'utf8'));
  const cli = path.join(path.dirname(createRequire(import.meta.url).resolve('drizzle-kit')),'bin.cjs');
  const result = spawnSync(process.execPath,[cli,'generate','--dialect=sqlite',`--schema=${path.join(desktop,'src/main/localDb/schema.ts').replaceAll('\\','/')}`,'--out=.',...forwarded],{cwd:temp,encoding:'utf8'});
  process.stdout.write(result.stdout ?? '');process.stderr.write(result.stderr ?? '');
  if (result.status !== 0) throw new Error(`Drizzle generation failed: ${result.status}`);
  if (/(?:^|\n)(?:Error\b|.*Error:)/.test(`${result.stdout}\n${result.stderr}`)) throw new Error('Drizzle reported an error despite a successful process exit');
  const journalAfter = JSON.parse(fs.readFileSync(path.join(temp,'meta/_journal.json'),'utf8'));
  if (journalAfter.entries.length === journalBefore.entries.length) process.exitCode = 0;
  else {
    if (journalAfter.entries.length !== journalBefore.entries.length+1) throw new Error('Unexpected generator delta');
    const entry = journalAfter.entries.at(-1), fileName = `${entry.tag}.sql`;
    const sqlPath = path.join(temp,fileName);
    const heads = ['upstream','custom'].flatMap(namespace => {
      const ids = catalog.entries.filter(e=>e.namespace===namespace).map(e=>e.id);
      return ids.length ? [{namespace,id:Math.max(...ids)}] : [];
    });
    const descriptor = {namespace:'custom',id:nextId,fileName,
      sqlPath:`catalog/custom/${String(nextId).padStart(4,'0')}/${fileName}`,
      sqlHash:migrationFileHash(sqlPath),scriptPath:null,scriptHash:null,dependsOn:heads};
    fs.mkdirSync(runtimeDir,{recursive:true});
    fs.copyFileSync(sqlPath,path.join(runtimeDir,fileName),fs.constants.COPYFILE_EXCL);
    fs.writeFileSync(path.join(drizzleDir,`catalog/entries/custom-${String(nextId).padStart(4,'0')}.json`),JSON.stringify(descriptor,null,2)+'\n',{flag:'wx'});
    fs.cpSync(path.join(temp,'meta'),path.join(development,'meta'),{recursive:true});
    const nextCatalog = loadMigrationCatalog(drizzleDir);
    fs.writeFileSync(bindingPath,JSON.stringify({...binding,catalogDigest:nextCatalog.digest,...generationBaselineFingerprint(development)},null,2)+'\n');
    console.log(`Generated custom:${nextId}; upstream metadata and legacy resources unchanged.`);
  }
} finally { fs.rmSync(temp,{recursive:true,force:true}); }
