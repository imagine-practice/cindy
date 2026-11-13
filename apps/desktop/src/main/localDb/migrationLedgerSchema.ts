import { integer, primaryKey, sqliteTable, text } from 'drizzle-orm/sqlite-core';

// This storage-format bootstrap is generated separately from either business chain.
export const migrationHistoryV2 = sqliteTable('migration_history_v2', {
  namespace: text('namespace').notNull(),
  id: integer('id').notNull(),
  identity: text('identity').notNull(),
  appliedAt: integer('applied_at').notNull(),
  provenance: text('provenance').notNull(),
}, table => [primaryKey({ columns: [table.namespace, table.id] })]);

export const migrationStateV2 = sqliteTable('migration_state_v2', {
  key: text('key').primaryKey(),
  value: text('value').notNull(),
});
