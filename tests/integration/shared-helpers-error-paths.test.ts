/**
 * Integration coverage for shared-helpers DB-error paths.
 *
 * Targets the catch blocks in:
 *   - updateTaskOnAgentComplete (lines around 197-213): publishes
 *     `container-agent:task-update-failed` when streams + sessionId are
 *     provided and the DB write throws.
 *   - updateTaskOnAgentError (lines around 251-272): same pattern for the
 *     error-path helper.
 *   - resolveOAuthExpiresAtMs (lines around 322-326): try/catch around the
 *     dynamic schema import + db.query.
 *
 * Uses a Drizzle `update` spy to make the underlying chain throw without
 * mutating the schema.
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  resolveOAuthExpiresAtMs,
  updateTaskOnAgentComplete,
  updateTaskOnAgentError,
} from '../../src/services/container-agent/shared-helpers';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('shared-helpers DB-error paths (IT-SH-ERR)', () => {
  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('updateTaskOnAgentComplete publishes task-update-failed and returns false when db throws', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const publish = vi.fn().mockResolvedValue(undefined);
    const streams = { publish } as never;

    // Spy on db.update to throw at returning() — simulates a failed write.
    const originalUpdate = db.update.bind(db);
    let triggered = false;
    const spy = vi.spyOn(db, 'update').mockImplementation(((arg: unknown) => {
      if (!triggered) {
        triggered = true;
        return {
          set: () => ({
            where: () => ({
              returning: () => {
                throw new Error('disk pressure');
              },
            }),
          }),
        } as never;
      }
      return originalUpdate(arg as never);
    }) as never);

    const result = await updateTaskOnAgentComplete(db, task.id, 'completed', streams, session.id);

    expect(result).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      session.id,
      'container-agent:task-update-failed',
      expect.objectContaining({ taskId: task.id, sessionId: session.id, error: 'disk pressure' })
    );
    spy.mockRestore();
  });

  it('updateTaskOnAgentComplete swallows publish failures (best-effort logging)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const publish = vi.fn().mockRejectedValue(new Error('stream gone'));
    const streams = { publish } as never;

    const originalUpdate = db.update.bind(db);
    let triggered = false;
    const spy = vi.spyOn(db, 'update').mockImplementation(((arg: unknown) => {
      if (!triggered) {
        triggered = true;
        return {
          set: () => ({
            where: () => ({
              returning: () => {
                throw new Error('db error');
              },
            }),
          }),
        } as never;
      }
      return originalUpdate(arg as never);
    }) as never);

    const result = await updateTaskOnAgentComplete(db, task.id, 'completed', streams, session.id);

    expect(result).toBe(false);
    expect(publish).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('updateTaskOnAgentError publishes task-update-failed and returns false when db throws', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const publish = vi.fn().mockResolvedValue(undefined);
    const streams = { publish } as never;

    const originalUpdate = db.update.bind(db);
    let triggered = false;
    const spy = vi.spyOn(db, 'update').mockImplementation(((arg: unknown) => {
      if (!triggered) {
        triggered = true;
        return {
          set: () => ({
            where: () => ({
              returning: () => {
                throw new Error('db pressure');
              },
            }),
          }),
        } as never;
      }
      return originalUpdate(arg as never);
    }) as never);

    const result = await updateTaskOnAgentError(db, task.id, streams, session.id);
    expect(result).toBe(false);
    expect(publish).toHaveBeenCalledWith(
      session.id,
      'container-agent:task-update-failed',
      expect.objectContaining({
        taskId: task.id,
        sessionId: session.id,
        error: 'db pressure',
        attemptedStatus: 'error',
      })
    );
    spy.mockRestore();
  });

  it('updateTaskOnAgentError swallows publish failures (best-effort logging)', async () => {
    const db = getTestDb();
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);
    const task = await createTestTask(codespace.id, { column: 'in_progress' });

    const publish = vi.fn().mockRejectedValue(new Error('stream gone'));
    const streams = { publish } as never;

    const originalUpdate = db.update.bind(db);
    let triggered = false;
    const spy = vi.spyOn(db, 'update').mockImplementation(((arg: unknown) => {
      if (!triggered) {
        triggered = true;
        return {
          set: () => ({
            where: () => ({
              returning: () => {
                throw new Error('write failure');
              },
            }),
          }),
        } as never;
      }
      return originalUpdate(arg as never);
    }) as never);

    const result = await updateTaskOnAgentError(db, task.id, streams, session.id);
    expect(result).toBe(false);
    expect(publish).toHaveBeenCalled();
    spy.mockRestore();
  });

  it('resolveOAuthExpiresAtMs returns null when db.query throws (catch block)', async () => {
    const db = getTestDb();
    const spy = vi.spyOn(db.query.apiKeys, 'findFirst').mockImplementation(() => {
      throw new Error('schema corrupt');
    });

    const result = await resolveOAuthExpiresAtMs(db);
    expect(result).toBeNull();

    spy.mockRestore();
  });
});
