/**
 * Integration tests for getAgentMaxRuntimeMs resolution chain.
 *
 * Exercises the real function against a real SQLite DB to verify:
 *   env var > DB setting > default
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { settings } from '../../src/db/schema';
import {
  DEFAULT_AGENT_MAX_RUNTIME_MS,
  getAgentMaxRuntimeMs,
} from '../../src/services/settings.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('getAgentMaxRuntimeMs (IT-1950)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    // Clear settings table before each test
    await db.delete(settings);
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.unstubAllEnvs();
  });

  it('IT-1950: returns default when no env var or DB setting', async () => {
    const db = getTestDb();
    delete process.env.AGENT_MAX_RUNTIME_MS;
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
    expect(result).toBe(14_400_000);
  });

  it('IT-1951: env var override returns parsed value', async () => {
    const db = getTestDb();
    vi.stubEnv('AGENT_MAX_RUNTIME_MS', '7200000');
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(7_200_000);
  });

  it('IT-1952: env var 0 falls through to default', async () => {
    const db = getTestDb();
    vi.stubEnv('AGENT_MAX_RUNTIME_MS', '0');
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
  });

  it('IT-1953: env var negative falls through to default', async () => {
    const db = getTestDb();
    vi.stubEnv('AGENT_MAX_RUNTIME_MS', '-1');
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
  });

  it('IT-1954: env var non-numeric falls through to default', async () => {
    const db = getTestDb();
    vi.stubEnv('AGENT_MAX_RUNTIME_MS', 'banana');
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
  });

  it('IT-1955: DB setting returns parsed value', async () => {
    const db = getTestDb();
    delete process.env.AGENT_MAX_RUNTIME_MS;
    await db.insert(settings).values({
      key: 'agent.maxRuntimeMs',
      value: '3600000',
      updatedAt: new Date().toISOString(),
    });
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(3_600_000);
  });

  it('IT-1956: DB setting invalid type falls through to default', async () => {
    const db = getTestDb();
    delete process.env.AGENT_MAX_RUNTIME_MS;
    await db.insert(settings).values({
      key: 'agent.maxRuntimeMs',
      value: '"not-a-number"',
      updatedAt: new Date().toISOString(),
    });
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
  });

  it('IT-1957: env var takes precedence over DB setting', async () => {
    const db = getTestDb();
    vi.stubEnv('AGENT_MAX_RUNTIME_MS', '7200000');
    await db.insert(settings).values({
      key: 'agent.maxRuntimeMs',
      value: '3600000',
      updatedAt: new Date().toISOString(),
    });
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(7_200_000);
  });

  it('IT-1958: DB setting 0 falls through to default', async () => {
    const db = getTestDb();
    delete process.env.AGENT_MAX_RUNTIME_MS;
    await db.insert(settings).values({
      key: 'agent.maxRuntimeMs',
      value: '0',
      updatedAt: new Date().toISOString(),
    });
    const result = await getAgentMaxRuntimeMs(db as never);
    expect(result).toBe(DEFAULT_AGENT_MAX_RUNTIME_MS);
  });
});
