// Default: SQLite schema (re-export everything for backward compatibility)
export * from './sqlite';

// NOTE: Do NOT use `export * as pgSchema` or `export * as sqliteSchema` here.
// Module namespace objects have null prototypes, which crashes drizzle-orm's
// extractTablesRelationalConfig. Import directly from the dialect directories:
//   import * as pgSchema from '@/db/schema/postgres';
//   import * as sqliteSchema from '@/db/schema/sqlite';

// DB-012: Soft delete pattern (adding `deletedAt` columns) is intentionally deferred.
// Current cascade deletes work correctly for our use case. Soft delete would require:
//   1. Adding `deletedAt` column to all tables with cascade references
//   2. Updating all queries to filter out soft-deleted rows
//   3. Adding a periodic hard-delete sweep for data retention compliance
//   4. Updating the UI to handle "archived" vs "deleted" states
// This is a significant cross-cutting change that should be planned as a dedicated effort
// when audit trail requirements are formalized. See finding DB-012 in the March 2026 review.
