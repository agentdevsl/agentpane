import { afterEach, describe, expect, it, vi } from 'vitest';

const originalDbMode = process.env.DB_MODE;

async function loadSchemaFor(mode: 'sqlite' | 'postgres') {
  vi.resetModules();
  process.env.DB_MODE = mode;
  const { _resetDbDialectCacheForTests } = await import('../../../lib/db/dialect.js');
  _resetDbDialectCacheForTests();
  return import('../index.js');
}

describe('runtime schema barrel', () => {
  afterEach(() => {
    if (originalDbMode === undefined) {
      delete process.env.DB_MODE;
    } else {
      process.env.DB_MODE = originalDbMode;
    }
    vi.resetModules();
  });

  it('exports SQLite tables when DB_MODE=sqlite', async () => {
    const schema = await loadSchemaFor('sqlite');

    expect(schema.tasks.constructor.name).toBe('SQLiteTable');
    expect(schema.githubInstallations.constructor.name).toBe('SQLiteTable');
    expect(schema.SESSION_STATUS).toContain('active');
  });

  it('exports Postgres tables when DB_MODE=postgres', async () => {
    const schema = await loadSchemaFor('postgres');

    expect(schema.tasks.constructor.name).toBe('PgTable');
    expect(schema.githubInstallations.constructor.name).toBe('PgTable');
    expect(schema.EVENT_SOURCE_TYPES).toContain('github');
  });
});
