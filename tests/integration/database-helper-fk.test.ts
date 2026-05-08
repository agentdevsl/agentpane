import { afterEach, describe, expect, it } from 'vitest';
import { tasks } from '../../src/db/schema';
import {
  clearTestDatabase,
  closeTestDatabase,
  getTestDb,
  setupTestDatabase,
} from '../helpers/database';

describe('test database helper foreign-key enforcement', () => {
  afterEach(async () => {
    await clearTestDatabase();
    await closeTestDatabase();
  });

  it('enables SQLite foreign keys immediately after setup', async () => {
    await closeTestDatabase();
    await setupTestDatabase();
    const db = getTestDb();

    await expect(
      db.insert(tasks).values({
        id: 'task-with-missing-codespace',
        codespaceId: 'missing-codespace',
        title: 'Orphan task should fail',
        column: 'backlog',
        position: 0,
      })
    ).rejects.toThrow(/FOREIGN KEY constraint failed/);
  });
});
