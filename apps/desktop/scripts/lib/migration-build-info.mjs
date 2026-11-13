import { loadMigrationCatalog, migrationCatalogSummary } from './migration-catalog-loader.mjs';

/** Explicit format: a namespace vector must never masquerade as scalar schemaVersionMax. */
export function migrationBuildInfo(drizzleDir) {
  const catalog = loadMigrationCatalog(drizzleDir);
  return migrationCatalogSummary(catalog);
}
