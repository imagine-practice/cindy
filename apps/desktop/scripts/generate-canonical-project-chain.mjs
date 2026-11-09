// One-shot candidate preparation: Drizzle owns every generated SQL/journal/snapshot.
// Existing canonical migrations must already be present; never run on user data.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { execFileSync } from 'node:child_process';
const require = createRequire(import.meta.url);
const root = path.resolve(import.meta.dirname, '..');
const initialJournal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8'));
if (initialJournal.entries.at(-1)?.idx !== 148) {
  throw new Error('One-shot generation requires the untouched canonical chain through 0148');
}
const source = fs.readFileSync(path.join(root, 'src/main/localDb/schema.ts'), 'utf8');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cindy-canonical-schema-'));
const phases = [
  ['projects', ['projects', 'projectMembers']],
  ['materials', ['materials', 'materialVersions', 'materialContexts']],
  ['progress', ['workItemProgress', 'workItemProgressEvents']],
  ['references', ['materialReferences']],
  ['group_links', ['projectGroupLinks', 'projectGroupLinkRequests']],
  ['dispatch', ['materialDispatchMessages', 'materialDispatchRevisions', 'materialDispatchAttempts', 'materialDispatchObservations']],
  ['followup', ['botTaskFollowupRequests']],
  ['schedule_project', []],
  ['project_dirs', ['projectDirs']],
];
const all = phases.flatMap(([, tables]) => tables);
const active = new Set();
for (const [phase, [name, tables]] of phases.entries()) {
  tables.forEach(table => active.add(table));
  let text = source;
  for (const table of all.filter(table => !active.has(table))) {
    text = text.replace(`export const ${table} =`, `const ${table} =`);
  }
  if (phase < 2) text = text.replace(/^.*projectBindingRevision: integer\('project_binding_revision'\).*\r?\n/m, '');
  if (phase < 3) {
    text = text.replace(/(export const materialContexts = sqliteTable\('material_contexts', \{[\s\S]*?)(\n\}\);)/, (_, body, end) =>
      body.replace(/^.*(?:projectId: text\('project_id'\)|bindingRevision: integer\('binding_revision'\)).*\r?\n/gm, '') + end);
  }
  if (phase < 7) {
    const start = text.indexOf('export const schedules =');
    const end = text.indexOf('\nexport const ', start + 1);
    text = text.slice(0, start) + text.slice(start, end).replace(/^.*projectId: text\('project_id'\).*\r?\n/m, '') + text.slice(end);
  }
  for (const module of ['drizzle-orm/sqlite-core', 'drizzle-orm', '@cindy/maker-shared']) {
    text = text.replaceAll(`from '${module}'`, `from '${require.resolve(module).replaceAll('\\', '/')}'`);
  }
  text = text.replace("from '../../shared/sessionSource.js'", `from '${path.join(root, 'src/shared/sessionSource.ts').replaceAll('\\', '/')}'`);
  const schema = path.join(dir, 'schema.ts');
  fs.writeFileSync(schema, text);
  const config = path.join(dir, 'drizzle.config.json');
  fs.writeFileSync(config, JSON.stringify({ schema: schema.replaceAll('\\', '/'), out: './drizzle', dialect: 'sqlite' }));
  execFileSync(process.execPath, [path.join(path.dirname(require.resolve('drizzle-kit')), 'bin.cjs'), 'generate', `--config=${config}`, `--name=project_${name}`], { cwd: root, stdio: 'inherit' });
  const journal = JSON.parse(fs.readFileSync(path.join(root, 'drizzle/meta/_journal.json'), 'utf8'));
  if (journal.entries.at(-1).idx !== 149 + phase) throw new Error(`Drizzle did not generate phase ${phase}`);
}
console.log(`Generated canonical project chain; schema scratch directory: ${dir}`);
