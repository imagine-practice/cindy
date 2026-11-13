import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { loadMigrationCatalog, migrationFileHash } from './lib/migration-catalog-loader.mjs';

// The upstream journal must first be selected from the reviewed upstream commit.
// This command records identities; it never regenerates or renumbers upstream SQL.
const desktop=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
const root=path.join(desktop,'drizzle');
const journal=JSON.parse(fs.readFileSync(path.join(root,'meta/_journal.json'),'utf8'));
const additions=[];
for (let i=0;i<journal.entries.length;i++) {
  const entry=journal.entries[i];
  if(entry.idx !== i || typeof entry.tag !== 'string' || !new RegExp(`^${String(i).padStart(4,'0')}_[a-zA-Z0-9_-]+$`).test(entry.tag)) throw new Error('Invalid upstream generator journal');
  const fileName=`${entry.tag}.sql`,script=`scripts/${entry.tag}.ts`,hasScript=fs.existsSync(path.join(root,script));
  const descriptor={namespace:'upstream',id:i,fileName,sqlPath:fileName,sqlHash:migrationFileHash(path.join(root,fileName)),
    scriptPath:hasScript?script:null,scriptHash:hasScript?migrationFileHash(path.join(root,script)):null,
    dependsOn:i?[{namespace:'upstream',id:i-1}]:[],legacySeq:i};
  const file=path.join(root,`catalog/entries/upstream-${String(i).padStart(4,'0')}.json`);
  if(fs.existsSync(file)) {
    if(JSON.stringify(JSON.parse(fs.readFileSync(file,'utf8'))) !== JSON.stringify(descriptor)) throw new Error(`Immutable upstream identity changed: ${i}`);
  } else additions.push({file,descriptor});
}
for(const {file,descriptor} of additions) fs.writeFileSync(file,JSON.stringify(descriptor,null,2)+'\n',{flag:'wx'});
const catalog=loadMigrationCatalog(root);
console.log(`Imported ${additions.length} new upstream identities; catalog ${catalog.digest}.`);
if(additions.length) console.log('The custom generation baseline is now stale. Complete schema integration and review a newly generated combined baseline before generating custom deltas.');
