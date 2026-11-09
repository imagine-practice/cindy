import type Database from 'better-sqlite3';

function run(db: Database.Database): void {
  const columns = new Set((db.prepare("PRAGMA table_info('sessions')").all() as { name: string }[]).map(r => r.name));
  const epoch = ['project_id', 'status', 'project_binding_revision'].every(c => columns.has(c))
    ? "CASE WHEN m.work_item_id IS NOT NULL AND s.project_id=m.project_id AND s.status <> 'deleted' AND s.project_binding_revision=0 THEN 0 ELSE NULL END"
    : 'NULL';
  db.exec(`INSERT OR IGNORE INTO material_references
    (id,project_id,work_item_id,binding_revision,material_id,version,status,
     created_by_kind,created_by_id,created_at,updated_at)
    SELECT 'legacy-material:' || m.id, m.project_id, m.work_item_id,
      ${epoch},
      m.id, v.version, m.status, m.created_by_kind, m.created_by_id, m.created_at, m.updated_at
    FROM materials m
    JOIN material_versions v ON v.material_id=m.id
      AND v.version=(SELECT MAX(latest.version) FROM material_versions latest WHERE latest.material_id=m.id)
    LEFT JOIN sessions s ON s.id=m.work_item_id`);
  const report = {
    projectReferences: db.prepare('SELECT COUNT(*) FROM material_references WHERE work_item_id IS NULL').pluck().get(),
    initialTaskReferences: db.prepare('SELECT COUNT(*) FROM material_references WHERE work_item_id IS NOT NULL AND binding_revision=0').pluck().get(),
    unresolvedTaskReferences: db.prepare('SELECT COUNT(*) FROM material_references WHERE work_item_id IS NOT NULL AND binding_revision IS NULL').pluck().get(),
    materialsWithoutVersion: db.prepare('SELECT COUNT(*) FROM materials m WHERE NOT EXISTS (SELECT 1 FROM material_versions v WHERE v.material_id=m.id)').pluck().get(),
  };
  db.prepare('INSERT OR IGNORE INTO migration_meta (key,value) VALUES (?,?)')
    .run('material_reference_r1_migration_summary', JSON.stringify(report));
}

module.exports = { run };
