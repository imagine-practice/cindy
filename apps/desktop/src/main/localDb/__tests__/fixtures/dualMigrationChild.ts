import type DatabaseType from 'better-sqlite3';
import { createRequire } from 'node:module';
import { runDualMigrationReplay } from '../../migrationLedger';

// Resource-tier child: terminate the actual executor at a durable boundary, not a
// simulated thrown exception. The parent owns the unique temporary DB and cleanup.
const [dbPath,drizzleDir,phase,modulePath]=process.argv.slice(2);
const Database=createRequire(import.meta.url)(modulePath) as typeof DatabaseType;
const db=new Database(dbPath);
runDualMigrationReplay(db,{drizzleDir,dbPath,onPhase:current=>{
  if(current === phase) process.exit(73);
}});
db.close();
