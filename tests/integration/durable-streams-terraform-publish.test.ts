import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service';
import { DurableStreamsService } from '../../src/services/durable-streams.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Validates that DurableStreamsService can persist events for non-session streams
 * (terraform compose, plan sessions, task creation) without FK constraint failures.
 *
 * The session_events table stores events for ALL stream types, not just sessions.
 * Stream IDs like "terraform:{jobId}" and "plan:{sessionId}" must work without
 * requiring a matching record in the sessions table.
 */
describe('DurableStreams: non-session stream publish (terraform, plan, task-creation)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: DurableStreamsService;

  const mockServer: DurableStreamsServer = {
    createStream: async () => {},
    publish: async () => 0,
    subscribe: async function* () {},
    deleteStream: async () => true,
  };

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new DurableStreamsService(mockServer, db);
  });

  afterEach(async () => {
    await db.delete(sessionEvents);
    await clearTestDatabase();
  });

  it('publishes terraform:status to a terraform stream without FK error', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:status', {
      jobId,
      stage: 'loading_catalog',
    });

    expect(result.ok).toBe(true);

    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, streamId));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('terraform:status');
  });

  it('publishes terraform:text delta to a terraform stream', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:text', {
      jobId,
      delta: '```hcl\nresource "aws_s3_bucket" "main" {}\n```',
    });

    expect(result.ok).toBe(true);
  });

  it('publishes terraform:done to complete the stream', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:done', {
      jobId,
      generatedCode: 'resource "aws_s3_bucket" "main" {}',
      usage: { inputTokens: 100, outputTokens: 200 },
    });

    expect(result.ok).toBe(true);
  });

  it('publishes terraform:error when pipeline fails', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:error', {
      jobId,
      error: 'SDK session failed: unable to verify certificate',
    });

    expect(result.ok).toBe(true);
  });

  it('publishes plan events to a plan stream without FK error', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:started', {
      sessionId,
      taskId: createId(),
      codespaceId: createId(),
    });

    expect(result.ok).toBe(true);
  });

  it('publishes task-creation events to a task-creation stream', async () => {
    const sessionId = createId();

    await service.createStream(sessionId, null);
    const result = await service.publish(sessionId, 'task-creation:started', {
      sessionId,
      codespaceId: createId(),
    });

    expect(result.ok).toBe(true);
  });

  it('publishes multiple events with incrementing offsets', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);

    await service.publish(streamId, 'terraform:status', {
      jobId,
      stage: 'loading_catalog',
    });
    await service.publish(streamId, 'terraform:status', {
      jobId,
      stage: 'analyzing',
    });
    await service.publish(streamId, 'terraform:text', {
      jobId,
      delta: 'Generating HCL...',
    });

    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, streamId));
    expect(events).toHaveLength(3);

    const offsets = events.map((e) => e.offset).sort((a, b) => a - b);
    expect(offsets).toEqual([0, 1, 2]);
  });
});
