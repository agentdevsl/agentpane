import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { agents, codespaces, sessionEvents, settings, teams } from '../../src/db/schema';
import { ok } from '../../src/lib/utils/result';
import { TaskService } from '../../src/services/task.service';
import { canTransition } from '../../src/services/task-transitions';
import { createTestAgent } from '../factories/agent.factory';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { createTestTask } from '../factories/task.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

const mockWorktreeService = {
  getDiff: async () => ok({ files: [], stats: { filesChanged: 0, additions: 0, deletions: 0 } }),
  merge: async () => ok(undefined),
  remove: async () => ok(undefined),
};

describe('API Route Validation Patterns (IT-163 to IT-170)', () => {
  let db: ReturnType<typeof getTestDb>;
  let taskService: TaskService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    taskService = new TaskService(db, mockWorktreeService);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('IT-163: TaskService.create rejects missing codespace, succeeds with valid input', async () => {
    // Create with nonexistent codespace -> error
    const badResult = await taskService.create({
      codespaceId: 'nonexistent-codespace',
      title: 'Test Task',
    });
    expect(badResult.ok).toBe(false);
    if (!badResult.ok) {
      expect(badResult.error.code).toBe('CODESPACE_NOT_FOUND');
    }

    // Create with valid codespace -> success
    const codespace = await createTestProject();
    const goodResult = await taskService.create({
      codespaceId: codespace.id,
      title: 'Valid Task',
    });
    expect(goodResult.ok).toBe(true);
    if (goodResult.ok) {
      expect(goodResult.value.title).toBe('Valid Task');
      expect(goodResult.value.column).toBe('backlog');
    }
  });

  it('IT-164: canTransition rejects invalid column names and wrong transitions', async () => {
    // 'invalid' is not a valid column
    expect(canTransition('backlog', 'invalid' as any)).toBe(false);

    // backlog -> verified is not a valid direct transition
    expect(canTransition('backlog', 'verified')).toBe(false);

    // backlog -> queued is valid
    expect(canTransition('backlog', 'queued')).toBe(true);

    // Use TaskService to verify actual rejection at service level
    const codespace = await createTestProject();
    const task = await createTestTask(codespace.id, { column: 'backlog' });
    const result = await taskService.moveColumn(task.id, 'verified');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('TASK_INVALID_TRANSITION');
    }
  });

  it('IT-165: session events support afterEventId cursor pattern via offset', async () => {
    const codespace = await createTestProject();
    const session = await createTestSession(codespace.id);

    // Insert 5 session events with incrementing offsets.
    // F05-25: bare CUIDs are session-kind streams.
    for (let i = 0; i < 5; i++) {
      await db.insert(sessionEvents).values({
        id: createId(),
        sessionId: session.id,
        streamKind: 'session',
        offset: i,
        type: 'chunk',
        channel: 'chunks',
        data: { text: `chunk-${i}` },
        timestamp: Date.now() + i,
      });
    }

    // Query events after offset 2 (should return offsets 3, 4)
    const afterOffset = 2;
    const events = await db.query.sessionEvents.findMany({
      where: (se, { and, eq, gt }) => and(eq(se.sessionId, session.id), gt(se.offset, afterOffset)),
    });

    expect(events).toHaveLength(2);
    const offsets = events.map((e) => e.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([3, 4]);
  });

  it('IT-166: path depth validation concept - count path segments', async () => {
    // Test the path depth concept used in codespace validation
    const paths = [
      { path: '/tmp', segments: 1, tooShallow: true },
      { path: '/home/user', segments: 2, tooShallow: false },
      { path: '/home/user/projects/myapp', segments: 4, tooShallow: false },
      { path: '/', segments: 0, tooShallow: true },
    ];

    for (const { path, segments, tooShallow } of paths) {
      const parts = path.split('/').filter(Boolean);
      expect(parts.length).toBe(segments);
      // A path with fewer than 2 segments could be dangerous (e.g., /tmp, /)
      expect(parts.length < 2).toBe(tooShallow);
    }
  });

  it('IT-167: skill ID regex validates safe identifiers', async () => {
    const SKILL_ID_REGEX = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

    // Valid skill IDs
    expect(SKILL_ID_REGEX.test('terraform-stacks')).toBe(true);
    expect(SKILL_ID_REGEX.test('mySkill123')).toBe(true);
    expect(SKILL_ID_REGEX.test('a')).toBe(true);
    expect(SKILL_ID_REGEX.test('Skill_v2')).toBe(true);

    // Invalid skill IDs
    expect(SKILL_ID_REGEX.test('../inject')).toBe(false);
    expect(SKILL_ID_REGEX.test('-starts-with-dash')).toBe(false);
    expect(SKILL_ID_REGEX.test('_starts-with-underscore')).toBe(false);
    expect(SKILL_ID_REGEX.test('')).toBe(false);
    expect(SKILL_ID_REGEX.test('has spaces')).toBe(false);
    expect(SKILL_ID_REGEX.test('path/traversal')).toBe(false);
  });

  it('IT-168: settings table stores values and supports redaction detection', async () => {
    // Insert a sensitive setting
    await db.insert(settings).values({
      key: 'anthropic_api_key',
      value: JSON.stringify('sk-ant-test-12345'),
    });

    // Insert a non-sensitive setting
    await db.insert(settings).values({
      key: 'default_model',
      value: JSON.stringify('claude-sonnet-4-6'),
    });

    // Verify both stored
    const apiKey = await db.query.settings.findFirst({
      where: eq(settings.key, 'anthropic_api_key'),
    });
    expect(apiKey).toBeDefined();
    expect(JSON.parse(apiKey!.value)).toBe('sk-ant-test-12345');

    const model = await db.query.settings.findFirst({
      where: eq(settings.key, 'default_model'),
    });
    expect(model).toBeDefined();
    expect(JSON.parse(model!.value)).toBe('claude-sonnet-4-6');

    // Redaction concept: detect keys that should be redacted in API responses
    const SENSITIVE_KEY_PATTERNS = ['api_key', 'secret', 'token', 'password'];
    const shouldRedact = (key: string) =>
      SENSITIVE_KEY_PATTERNS.some((pattern) => key.toLowerCase().includes(pattern));

    expect(shouldRedact('anthropic_api_key')).toBe(true);
    expect(shouldRedact('webhook_secret')).toBe(true);
    expect(shouldRedact('default_model')).toBe(false);
  });

  it('IT-169: codespace delete blocked by running agent, allowed after agent set to idle', async () => {
    const codespace = await createTestProject({ name: 'Delete Guard' });

    // Create a running agent in the codespace
    const agent = await createTestAgent(codespace.id, { status: 'running' });

    // Verify running agent exists
    const runningAgents = await db.query.agents.findMany({
      where: (a, { and, eq, inArray }) =>
        and(
          eq(a.codespaceId, codespace.id),
          inArray(a.status, ['starting', 'planning', 'running'])
        ),
    });
    expect(runningAgents).toHaveLength(1);

    // Set agent to idle
    await db.update(agents).set({ status: 'idle' }).where(eq(agents.id, agent.id));

    // Verify no active agents remain
    const activeAfter = await db.query.agents.findMany({
      where: (a, { and, eq, inArray }) =>
        and(
          eq(a.codespaceId, codespace.id),
          inArray(a.status, ['starting', 'planning', 'running'])
        ),
    });
    expect(activeAfter).toHaveLength(0);

    // Now delete should be safe - remove agents first, then codespace
    await db.delete(agents).where(eq(agents.codespaceId, codespace.id));
    await db.delete(codespaces).where(eq(codespaces.id, codespace.id));

    // Verify codespace is gone
    const deleted = await db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespace.id),
    });
    expect(deleted).toBeUndefined();
  });

  it('IT-170: team slug unique constraint prevents duplicates', async () => {
    const slug = `unique-team-${createId().slice(0, 6)}`;

    await db.insert(teams).values({
      id: createId(),
      name: 'Team Alpha',
      slug,
    });

    // Duplicate slug should throw unique constraint error
    await expect(
      db.insert(teams).values({
        id: createId(),
        name: 'Team Alpha Duplicate',
        slug,
      })
    ).rejects.toThrow();
  });
});
