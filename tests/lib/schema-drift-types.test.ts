/**
 * F02-16 (arch29-W2-R): regression coverage for `scripts/check-schema-drift.ts`
 * type-token comparison.
 *
 * Before this PR the script only compared column NAMES — it could not catch
 * real type drifts like SQLite `text` vs PG `jsonb`, SQLite `text` vs PG
 * `timestamp`, or SQLite `integer({ mode: 'boolean' })` vs PG `text`. This
 * test covers the {@link normalizeTypeToken} + {@link typesCompatible} pair
 * extracted into `scripts/lib/schema-drift.ts` so:
 *
 *   - SQLite `text` → 'text' and PG `jsonb` → 'text-json' are detected as drift.
 *   - SQLite `text({ mode: 'json' })` → 'text-json' and PG `jsonb` → 'text-json'
 *     are accepted as drift-free.
 *   - SQLite `integer({ mode: 'timestamp_ms' })` and PG `bigint(_, { mode:
 *     'number' })` are accepted (F02-18 event_outbox shape).
 *   - Plain SQLite `integer` (epoch ms) and PG `bigint+number` are accepted
 *     (precedent from `session_events.timestamp`).
 *   - The full `compareSchemas` helper surfaces drift warnings for synthetic
 *     SQLite vs PG content with a real type drift.
 *
 * before:test_name (FAIL) → drift undetected because script was name-only
 * after:test_name (PASS) → drift detected via type-token comparison
 */

import { describe, expect, it } from 'vitest';
import {
  compareSchemas,
  normalizeTypeToken,
  parseSchemaContent,
  typesCompatible,
} from '../../scripts/lib/schema-drift';

describe('normalizeTypeToken — F02-16 type-token derivation', () => {
  it('maps SQLite `text` to "text"', () => {
    expect(normalizeTypeToken('text', `text('payload').notNull()`)).toBe('text');
  });

  it('maps SQLite `text({ mode: "json" })` to "text-json"', () => {
    expect(normalizeTypeToken('text', `text('payload', { mode: 'json' }).notNull()`)).toBe(
      'text-json'
    );
  });

  it('maps PG `jsonb` to "text-json"', () => {
    expect(normalizeTypeToken('jsonb', `jsonb('payload').notNull()`)).toBe('text-json');
  });

  it('maps SQLite `integer({ mode: "boolean" })` to "integer-boolean"', () => {
    expect(normalizeTypeToken('integer', `integer('flag', { mode: 'boolean' }).notNull()`)).toBe(
      'integer-boolean'
    );
  });

  it('maps PG `boolean` to "integer-boolean"', () => {
    expect(normalizeTypeToken('boolean', `boolean('flag').notNull()`)).toBe('integer-boolean');
  });

  it('maps SQLite `integer({ mode: "timestamp_ms" })` to "integer-timestamp_ms"', () => {
    expect(
      normalizeTypeToken('integer', `integer('next_attempt_at', { mode: 'timestamp_ms' })`)
    ).toBe('integer-timestamp_ms');
  });

  it('maps PG `bigint(_, { mode: "number" })` to "integer-timestamp_ms"', () => {
    expect(normalizeTypeToken('bigint', `bigint('next_attempt_at', { mode: 'number' })`)).toBe(
      'integer-timestamp_ms'
    );
  });

  it('maps PG `timestamp` to "text-timestamp"', () => {
    expect(normalizeTypeToken('timestamp', `timestamp('created_at', { withTimezone: true })`)).toBe(
      'text-timestamp'
    );
  });

  it('maps PG `varchar` to "text"', () => {
    expect(normalizeTypeToken('varchar', `varchar('name')`)).toBe('text');
  });

  it('maps PG `serial` / `bigserial` to "integer"', () => {
    expect(normalizeTypeToken('serial', `serial('id')`)).toBe('integer');
    expect(normalizeTypeToken('bigserial', `bigserial('id')`)).toBe('integer');
  });

  it('maps PG `numeric` / `doublePrecision` to "real"', () => {
    expect(normalizeTypeToken('numeric', `numeric('cost')`)).toBe('real');
    expect(normalizeTypeToken('doublePrecision', `doublePrecision('rating')`)).toBe('real');
  });

  it('maps unknown drizzle types to themselves (failsafe)', () => {
    expect(normalizeTypeToken('point', `point('xy')`)).toBe('point');
  });
});

describe('typesCompatible — F02-16 cross-dialect compatibility matrix', () => {
  it('accepts identical tokens', () => {
    expect(typesCompatible('text', 'text')).toBe(true);
    expect(typesCompatible('integer', 'integer')).toBe(true);
    expect(typesCompatible('text-json', 'text-json')).toBe(true);
  });

  it('accepts SQLite `text-json` ↔ PG `text-json` (jsonb on PG, mode:json on SQLite)', () => {
    expect(typesCompatible('text-json', 'text-json')).toBe(true);
  });

  it('accepts SQLite `integer-timestamp_ms` ↔ PG `integer-timestamp_ms` (event_outbox shape)', () => {
    expect(typesCompatible('integer-timestamp_ms', 'integer-timestamp_ms')).toBe(true);
  });

  it('accepts plain SQLite `integer` ↔ PG `integer-timestamp_ms` (session_events.timestamp precedent)', () => {
    expect(typesCompatible('integer', 'integer-timestamp_ms')).toBe(true);
    expect(typesCompatible('integer-timestamp_ms', 'integer')).toBe(true);
  });

  it('accepts legacy SQLite `text` ↔ PG `text-timestamp`', () => {
    expect(typesCompatible('text', 'text-timestamp')).toBe(true);
    expect(typesCompatible('text-timestamp', 'text')).toBe(true);
  });

  it('REJECTS SQLite `text` ↔ PG `text-json` (real drift — F02-16 target)', () => {
    expect(typesCompatible('text', 'text-json')).toBe(false);
    expect(typesCompatible('text-json', 'text')).toBe(false);
  });

  it('REJECTS SQLite `integer` ↔ PG `integer-boolean` (real drift)', () => {
    expect(typesCompatible('integer', 'integer-boolean')).toBe(false);
    expect(typesCompatible('integer-boolean', 'integer')).toBe(false);
  });

  it('REJECTS SQLite `text` ↔ PG `integer` (cross-storage drift)', () => {
    expect(typesCompatible('text', 'integer')).toBe(false);
    expect(typesCompatible('integer', 'text')).toBe(false);
  });

  it('REJECTS SQLite `integer-boolean` ↔ PG `text-json` (real drift)', () => {
    expect(typesCompatible('integer-boolean', 'text-json')).toBe(false);
  });
});

describe('compareSchemas — F02-16 emits drift warnings on real type drift', () => {
  it('catches synthetic text→jsonb drift on payload column', () => {
    const sqliteContent = `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const driftFixture = sqliteTable('drift_fixture', {
        id: text('id'),
        payload: text('payload').notNull(),
      });
    `;
    const pgContent = `
      import { pgTable, text, jsonb } from 'drizzle-orm/pg-core';
      export const driftFixture = pgTable('drift_fixture', {
        id: text('id'),
        payload: jsonb('payload').notNull(),
      });
    `;
    const sqlite = parseSchemaContent(sqliteContent);
    const postgres = parseSchemaContent(pgContent);
    const warnings: string[] = [];

    const drift = compareSchemas('drift-fixture', sqlite, postgres, warnings);

    expect(drift).toBe(true);
    const typeDriftWarning = warnings.find(
      (w) => w.includes('type drift') && w.includes('payload')
    );
    expect(typeDriftWarning).toBeDefined();
    expect(typeDriftWarning).toContain("SQLite='text'");
    expect(typeDriftWarning).toContain("PostgreSQL='text-json'");
  });

  it('does NOT flag drift when SQLite uses text+mode:json and PG uses jsonb', () => {
    const sqliteContent = `
      import { sqliteTable, text } from 'drizzle-orm/sqlite-core';
      export const goodFixture = sqliteTable('good_fixture', {
        id: text('id'),
        payload: text('payload', { mode: 'json' }).notNull(),
      });
    `;
    const pgContent = `
      import { pgTable, text, jsonb } from 'drizzle-orm/pg-core';
      export const goodFixture = pgTable('good_fixture', {
        id: text('id'),
        payload: jsonb('payload').notNull(),
      });
    `;
    const sqlite = parseSchemaContent(sqliteContent);
    const postgres = parseSchemaContent(pgContent);
    const warnings: string[] = [];

    const drift = compareSchemas('good-fixture', sqlite, postgres, warnings);

    expect(drift).toBe(false);
    expect(warnings).toHaveLength(0);
  });

  it('catches integer→boolean drift on a flag column', () => {
    // For a clear, real drift case: SQLite `integer` (boolean-mode missing)
    // vs PG `boolean` (always integer-boolean). Drizzle types diverge.
    const sqliteContent = `
      import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
      export const boolFixture = sqliteTable('bool_fixture', {
        id: text('id'),
        flag: integer('flag').notNull(),
      });
    `;
    const pgContent = `
      import { pgTable, boolean, text } from 'drizzle-orm/pg-core';
      export const boolFixture = pgTable('bool_fixture', {
        id: text('id'),
        flag: boolean('flag').notNull(),
      });
    `;
    const sqlite = parseSchemaContent(sqliteContent);
    const postgres = parseSchemaContent(pgContent);
    const warnings: string[] = [];

    const drift = compareSchemas('bool-fixture', sqlite, postgres, warnings);

    expect(drift).toBe(true);
    const w = warnings.find((m) => m.includes('flag') && m.includes('type drift'));
    expect(w).toBeDefined();
    expect(w).toContain("SQLite='integer'");
    expect(w).toContain("PostgreSQL='integer-boolean'");
  });

  it('still passes for the F02-18 event_outbox shape (integer ↔ bigint+number)', () => {
    const sqliteContent = `
      import { sqliteTable, integer, text } from 'drizzle-orm/sqlite-core';
      export const eventOutbox = sqliteTable('event_outbox', {
        id: text('id'),
        next_attempt_at: integer('next_attempt_at').notNull(),
        created_at: integer('created_at').notNull(),
        published_at: integer('published_at'),
      });
    `;
    const pgContent = `
      import { bigint, pgTable, text } from 'drizzle-orm/pg-core';
      export const eventOutbox = pgTable('event_outbox', {
        id: text('id'),
        next_attempt_at: bigint('next_attempt_at', { mode: 'number' }).notNull(),
        created_at: bigint('created_at', { mode: 'number' }).notNull(),
        published_at: bigint('published_at', { mode: 'number' }),
      });
    `;
    const sqlite = parseSchemaContent(sqliteContent);
    const postgres = parseSchemaContent(pgContent);
    const warnings: string[] = [];

    const drift = compareSchemas('event-outbox', sqlite, postgres, warnings);

    expect(drift).toBe(false);
    expect(warnings).toHaveLength(0);
  });
});
