# Dual Database Support: SQLite + PostgreSQL 18

## Overview

Add PostgreSQL 18 as an alternative database backend alongside existing SQLite. SQLite remains default for local mode. PostgreSQL selected via `DB_MODE=postgres` + `DATABASE_URL` env vars.

---

## Architecture Diagram

```
┌─────────────────────────────────────────────────────────────────────┐
│                        Application Layer                             │
│                                                                       │
│  ┌──────────────┐  ┌──────────────┐  ┌────────────────────────┐     │
│  │ Services (25+)│  │ Routes (10+) │  │ Bootstrap Phases       │     │
│  │              │  │              │  │                        │     │
│  │ TaskService  │  │ /api/tasks   │  │ sqlite/postgres phase  │     │
│  │ AgentService │  │ /api/agents  │  │ schema validation      │     │
│  │ SessionSvc   │  │ /api/sessions│  │ seeding                │     │
│  │ ProjectSvc   │  │ /api/projects│  │                        │     │
│  │ ...          │  │ ...          │  │                        │     │
│  └──────┬───────┘  └──────┬───────┘  └───────────┬────────────┘     │
│         │                 │                      │                   │
│         └─────────────────┼──────────────────────┘                   │
│                           │                                           │
│                  constructor(db: Database)                            │
│                           │                                           │
└───────────────────────────┼─────────────────────────────────────────┘
                            │
                            ▼
┌───────────────────────────────────────────────────────────────────────┐
│                     src/types/database.ts                              │
│                                                                       │
│  type SqliteDatabase = BetterSQLite3Database<typeof sqliteSchema>     │
│  type PostgresDatabase = PostgresJsDatabase<typeof pgSchema>          │
│  type Database = SqliteDatabase | PostgresDatabase                    │
│                                                                       │
└───────────────────────────┬───────────────────────────────────────────┘
                            │
               ┌────────────┴────────────────┐
               │                             │
     DB_MODE=sqlite (default)        DB_MODE=postgres
               │                             │
               ▼                             ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│   src/db/client.ts        │  │   src/db/client.ts            │
│   createSqliteDatabase()  │  │   createPostgresDatabase()    │
│                           │  │                               │
│   ┌─ better-sqlite3 ───┐ │  │   ┌─ postgres.js ──────────┐ │
│   │  (client/SSR path) │ │  │   │  postgres(DATABASE_URL) │ │
│   └─────────────────────┘ │  │   └────────────────────────┘ │
│   ┌─ bun:sqlite ────────┐│  │                               │
│   │  (API server path)  ││  │   drizzle-orm/postgres-js     │
│   └─────────────────────┘│  │                               │
│   drizzle-orm/bun-sqlite  │  │   Drizzle Kit migrations      │
│   Inline MIGRATION_SQL    │  │   (src/db/migrations-pg/)     │
└────────────┬─────────────┘  └──────────────┬───────────────┘
             │                                │
             ▼                                ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│  src/db/schema/sqlite/    │  │  src/db/schema/postgres/      │
│                           │  │                               │
│  sqliteTable('projects')  │  │  pgTable('projects')          │
│  text('created_at')       │  │  timestamp('created_at',      │
│    .default(datetime now)  │  │    { mode: 'string' })        │
│  text('config',json)      │  │  jsonb('config')              │
│  integer(mode:'boolean')  │  │  boolean()                    │
│  AnySQLiteColumn          │  │  AnyPgColumn                  │
│  real()                   │  │  doublePrecision()            │
│                           │  │                               │
│  22 files (20 tables +    │  │  22 files (mirrors sqlite/)   │
│   relations + index)      │  │                               │
└────────────┬─────────────┘  └──────────────┬───────────────┘
             │                                │
             │     ┌─────────────────────┐    │
             └────►│ src/db/schema/shared │◄───┘
                   │                     │
                   │  enums.ts           │
                   │   TASK_COLUMNS      │
                   │   AGENT_STATUS      │
                   │   AGENT_TYPES       │
                   │   TASK_PRIORITIES   │
                   │   ...               │
                   │                     │
                   │  types.ts           │
                   │   ProjectConfig     │
                   │   AgentConfig       │
                   │   StoredPlanOptions │
                   │   DiffSummary       │
                   │   ...               │
                   └─────────────────────┘
             │                                │
             ▼                                ▼
┌──────────────────────────┐  ┌──────────────────────────────┐
│                           │  │                               │
│   SQLite Database          │  │   PostgreSQL 18 (Docker)      │
│   ./data/agentpane.db     │  │   docker-compose.postgres.yml │
│                           │  │   postgresql://agentpane:      │
│   WAL mode                │  │     agentpane_dev@localhost    │
│   foreign_keys=ON         │  │     :5432/agentpane           │
│   In-memory for tests     │  │                               │
│                           │  │   Persistent volume            │
└──────────────────────────┘  └──────────────────────────────┘
```

## Data Flow Diagram

```
                    Request
                       │
                       ▼
              ┌────────────────┐
              │  Hono Router   │
              │  (api.ts)      │
              └───────┬────────┘
                      │
                      ▼
              ┌────────────────┐
              │  Route Handler │
              │  e.g. tasks.ts │
              └───────┬────────┘
                      │
                      ▼
              ┌────────────────┐
              │  Service Layer │   db.query.tasks.findFirst(...)
              │  TaskService   │   db.insert(tasks).values(...)
              │  (db: Database)│   db.update(tasks).set(...)
              └───────┬────────┘
                      │
                      ▼  Drizzle ORM Query Builder (dialect-agnostic API)
                      │
         ┌────────────┴────────────┐
         │                         │
    SQLite mode               Postgres mode
         │                         │
    ┌────▼────┐              ┌─────▼──────┐
    │bun:sqlite│              │ postgres.js │
    │ driver   │              │  driver     │
    └────┬────┘              └─────┬──────┘
         │                         │
    ┌────▼─────┐             ┌─────▼───────┐
    │ SQLite   │             │ PostgreSQL   │
    │ file DB  │             │ TCP/IP       │
    └──────────┘             └─────────────┘
```

## Migration Strategy Diagram

```
┌─────────────────────────────────────────────────┐
│              SQLite Migrations                    │
│                                                   │
│  src/lib/bootstrap/phases/schema.ts               │
│  ┌──────────────────────────────────────────┐    │
│  │ MIGRATION_SQL (CREATE TABLE IF NOT EXISTS)│    │
│  │ SANDBOX_MIGRATION_SQL (ALTER TABLE)       │    │
│  │ CLI_SESSIONS_MIGRATION_SQL                │    │
│  │ TERRAFORM_MIGRATION_SQL                   │    │
│  │ PERFORMANCE_INDEXES_MIGRATION_SQL         │    │
│  └──────────────────────────────────────────┘    │
│  Executed via: sqlite.exec(SQL)                   │
│  Idempotent: CREATE TABLE IF NOT EXISTS           │
└─────────────────────────────────────────────────┘

┌─────────────────────────────────────────────────┐
│              PostgreSQL Migrations                │
│                                                   │
│  drizzle.config.pg.ts                             │
│  ┌──────────────────────────────────────────┐    │
│  │ Schema source: src/db/schema/postgres/    │    │
│  │ Output: src/db/migrations-pg/             │    │
│  └──────────────────────────────────────────┘    │
│                                                   │
│  Generation: drizzle-kit generate                 │
│  Application: drizzle-orm/postgres-js/migrator    │
│               migrate(db, { migrationsFolder })   │
│  Tracking: Drizzle journal (meta/_journal.json)   │
└─────────────────────────────────────────────────┘
```

## File Structure

```
src/db/
├── schema/
│   ├── shared/                    # Dialect-independent
│   │   ├── enums.ts               # TASK_COLUMNS, AGENT_STATUS, etc.
│   │   └── types.ts               # ProjectConfig, AgentConfig, etc.
│   │
│   ├── sqlite/                    # Current schema (moved)
│   │   ├── index.ts
│   │   ├── projects.ts ... (20 table files)
│   │   └── relations.ts
│   │
│   ├── postgres/                  # New PG schema
│   │   ├── index.ts
│   │   ├── projects.ts ... (20 table files)
│   │   └── relations.ts
│   │
│   └── index.ts                   # Re-exports from sqlite/ (default)
│
├── client.ts                      # Factory: DB_MODE → sqlite or postgres
├── migrations-pg/                 # Drizzle Kit PG migration output
│
drizzle.config.ts                  # SQLite config (unchanged)
drizzle.config.pg.ts               # PG Drizzle Kit config
docker/docker-compose.postgres.yml # PG 18 dev container
src/types/database.ts              # Database = SqliteDb | PostgresDb
src/lib/bootstrap/phases/postgres.ts  # PG bootstrap phase
```

---

## Decisions

| Decision | Choice | Rationale |
|----------|--------|-----------|
| Mode selection | `DB_MODE` env var | Fixed per deployment, no runtime switching needed |
| PG migrations | Drizzle Kit | Proper migration tracking, rollbacks, schema diffing |
| PG driver | postgres.js | Modern, fast, works with `drizzle-orm/postgres-js` |
| Docker dev | docker-compose.postgres.yml | Easy start/stop, persistent volume, health checks |
| Schema approach | Dual directories | Drizzle has no dialect-agnostic table builder; clean native schemas per dialect |
| Timestamp handling | `timestamp(mode:'string')` in PG | Same TypeScript `string` type as SQLite `text` |
| JSON columns | `jsonb()` in PG | Same TS type via `$type<T>()`, better PG indexing |

---

## Schema Translation Reference

| SQLite Pattern | PostgreSQL Pattern | TS Type |
|---|---|---|
| `sqliteTable('x', {...})` | `pgTable('x', {...})` | - |
| `text('id').primaryKey()` | `text('id').primaryKey()` | `string` |
| `text('created_at').default(sql\`(datetime('now'))\`)` | `timestamp('created_at', { mode: 'string' }).defaultNow()` | `string` |
| `text('config', { mode: 'json' }).$type<T>()` | `jsonb('config').$type<T>()` | `T` |
| `integer('col')` | `integer('col')` | `number` |
| `integer('col', { mode: 'boolean' })` | `boolean('col')` | `boolean` |
| `real('col')` | `doublePrecision('col')` | `number` |
| `AnySQLiteColumn` (circular ref) | `AnyPgColumn` | - |
| `text('col').$type<Union>()` | `text('col').$type<Union>()` | Union type |

---

## Implementation Steps

### Step 1: Install Dependencies
```bash
bun add postgres
```

### Step 2: Create Shared Schema Layer
- Move `src/db/schema/enums.ts` → `src/db/schema/shared/enums.ts`
- Move `SANDBOX_TYPES`/`SandboxType` from `sandbox-configs.ts` → `shared/enums.ts`
- Create `src/db/schema/shared/types.ts` (ProjectConfig, AgentConfig, VolumeMountRecord, etc.)

### Step 3: Move Current Schema to `sqlite/`
- Move 22 files from `src/db/schema/` → `src/db/schema/sqlite/`
- Update enum imports: `./enums` → `../shared/enums`
- Update barrel: `src/db/schema/index.ts` → `export * from './sqlite'`
- Verify: `bun run dev` still works

### Step 4: Create PostgreSQL Schema (22 files)
- Create `src/db/schema/postgres/` mirroring all SQLite tables
- Apply translation rules (see reference table above)
- Create PG relations.ts (identical structure, PG table imports)

### Step 5: Update Database Type (`src/types/database.ts`)
- Union type: `Database = SqliteDatabase | PostgresDatabase`

### Step 6: Update Database Client (`src/db/client.ts`)
- Add `createPostgresDatabase()` factory
- DB_MODE env var selects factory

### Step 7: Update API Server (`src/server/api.ts`)
- Add PG branch alongside `bun:sqlite` initialization
- PG uses `postgres.js` + Drizzle Kit programmatic migrations

### Step 8: Fix `.run()` Calls (9 total across 3 files)
- `src/server/api.ts` (3x) — replace `.run()` with `await`
- `src/services/container-agent.service.ts` (3x)
- `src/services/cli-monitor/cli-monitor.service.ts` (3x)

### Step 9: Create PG Bootstrap Phase
- `src/lib/bootstrap/phases/postgres.ts`
- Update `schema.ts` with PG validation branch

### Step 10: Drizzle Kit PG Config
- Create `drizzle.config.pg.ts`

### Step 11: Docker Compose
- Create `docker/docker-compose.postgres.yml` (PG 18)

### Step 12: Package.json Scripts
- Add 6 PG-related scripts

### Step 13: Generate Initial PG Migration
```bash
bun run docker:pg
DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run db:generate:pg
DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run db:migrate:pg
```

### Step 14: Update Test Infrastructure
- `tests/helpers/database.ts` — add PG test database support

### Step 15: Fix Import Paths
- Update direct schema submodule imports to use barrel

---

## Validation

### 1. SQLite Regression
```bash
bun run dev
bun run test
```

### 2. Docker PG Validation
```bash
bun run docker:pg
DB_MODE=postgres DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run db:generate:pg
DB_MODE=postgres DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run db:migrate:pg
DB_MODE=postgres DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane bun run dev
```

### 3. PG Tests
```bash
DB_MODE=postgres DATABASE_URL=postgresql://agentpane:agentpane_dev@localhost:5432/agentpane_test bun run test
```

### 4. UI Testing (agent-browser)
- Create project → verify PG persistence
- Kanban board CRUD → verify task operations
- Drag-drop columns → verify position updates
- Settings page → verify persistence
- Session events → verify streaming

---

## Files Summary

| File | Action | Details |
|------|--------|---------|
| `package.json` | MODIFY | Add `postgres` dep, add 6 PG scripts |
| `src/db/schema/shared/enums.ts` | CREATE | Move from schema/enums.ts |
| `src/db/schema/shared/types.ts` | CREATE | Shared JSON column types |
| `src/db/schema/sqlite/*` (22 files) | MOVE | From schema/ to schema/sqlite/ |
| `src/db/schema/postgres/*` (22 files) | CREATE | PG equivalents of all tables |
| `src/db/schema/index.ts` | MODIFY | Re-export from ./sqlite |
| `src/db/client.ts` | MODIFY | Add PG factory path |
| `src/types/database.ts` | MODIFY | Union type: SqliteDb \| PostgresDb |
| `src/server/api.ts` | MODIFY | DB_MODE branch, remove .run() |
| `src/lib/bootstrap/phases/postgres.ts` | CREATE | PG bootstrap phase |
| `src/lib/bootstrap/phases/schema.ts` | MODIFY | PG validation branch |
| `drizzle.config.pg.ts` | CREATE | PG Drizzle Kit config |
| `docker/docker-compose.postgres.yml` | CREATE | PG 18 dev container |
| `tests/helpers/database.ts` | MODIFY | PG test support |
| `src/services/container-agent.service.ts` | MODIFY | Remove 3x .run() |
| `src/services/cli-monitor/cli-monitor.service.ts` | MODIFY | Remove 3x .run() |
