import { tsImport } from 'tsx/esm/api';

// Build tools share the runtime catalog implementation without depending on native
// type-stripping becoming a default in newer Node 22 releases. No global loader.
export const {loadMigrationCatalog,migrationCatalogSummary,migrationDigest,migrationFileHash} =
  await tsImport('../../src/main/localDb/migrationCatalog.ts',import.meta.url);
