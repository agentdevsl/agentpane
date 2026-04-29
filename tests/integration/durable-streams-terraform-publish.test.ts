import { createId } from '@paralleldrive/cuid2';
import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { sessionEvents } from '../../src/db/schema';
import type { DurableStreamsServer } from '../../src/services/durable-streams.service';
import { DurableStreamsService } from '../../src/services/durable-streams.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Validates that DurableStreamsService can publish events for non-session streams
 * (terraform compose, plan sessions, task creation) without FK constraint failures.
 *
 * Non-session streams (IDs containing ':') skip DB persistence and publish
 * directly to the Caddy streams server for real-time delivery.
 */
describe('DurableStreams: non-session stream publish (terraform, plan, task-creation)', () => {
  let db: ReturnType<typeof getTestDb>;
  let service: DurableStreamsService;
  const publishSpy = vi.fn().mockResolvedValue(0);

  const mockServer: DurableStreamsServer = {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: publishSpy,
    subscribe: async function* () {},
    deleteStream: vi.fn().mockResolvedValue(true),
  };

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    service = new DurableStreamsService(mockServer, db);
    publishSpy.mockClear();
    (mockServer.createStream as ReturnType<typeof vi.fn>).mockClear();
  });

  afterEach(async () => {
    await db.delete(sessionEvents);
    await clearTestDatabase();
  });

  it('publishes terraform:status via Caddy without DB persistence', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:status', {
      jobId,
      stage: 'loading_catalog',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledOnce();

    // Terraform events are ephemeral — NOT persisted to DB
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, streamId));
    expect(events).toHaveLength(0);
  });

  it('publishes terraform:text delta via Caddy', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:text', {
      jobId,
      delta: '```hcl\nresource "aws_s3_bucket" "main" {}\n```',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).toHaveBeenCalledOnce();
  });

  it('publishes terraform:done via Caddy', async () => {
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

  it('publishes terraform:error via Caddy', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:error', {
      jobId,
      error: 'SDK session failed: unable to verify certificate',
    });

    expect(result.ok).toBe(true);
  });

  it('publishes and persists plan events to DB (durable)', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:started', {
      sessionId,
      taskId: createId(),
      codespaceId: createId(),
    });

    expect(result.ok).toBe(true);
    // F05-19: server.publish is called by the relay, not directly from
    // publish() for non-ephemeral streams.
    expect(publishSpy).not.toHaveBeenCalled();

    // Plan events should be persisted to DB (durable, not ephemeral)
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, streamId));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('plan:started');
  });

  it('publishes plan:turn via Caddy without FK error', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:turn', {
      sessionId,
      turnId: createId(),
      role: 'assistant',
      content: 'Here is my analysis of the codebase...',
    });

    expect(result.ok).toBe(true);
    // F05-19: outbox-relay path. publish() does not call server.publish.
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes plan:token via Caddy without FK error', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:token', {
      sessionId,
      delta: 'Hello',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes plan:completed via Caddy without FK error', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:completed', {
      sessionId,
      issueUrl: 'https://github.com/test/repo/issues/1',
      issueNumber: 1,
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes plan:error via Caddy without FK error', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:error', {
      sessionId,
      error: 'Claude API rate limit exceeded',
      code: 'PLAN_API_ERROR',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes and persists sandbox:creating to DB (durable)', async () => {
    const sandboxId = createId();
    const streamId = `sandbox:${sandboxId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'sandbox:creating', {
      sandboxId,
      codespaceId: createId(),
      image: 'agentpane/sandbox:latest',
    });

    expect(result.ok).toBe(true);

    // Sandbox events should be persisted to DB (durable)
    const events = await db
      .select()
      .from(sessionEvents)
      .where(eq(sessionEvents.sessionId, streamId));
    expect(events).toHaveLength(1);
    expect(events[0].type).toBe('sandbox:creating');
    // F05-19: relay handles delivery, not publish().
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes sandbox:ready via Caddy without FK error', async () => {
    const sandboxId = createId();
    const streamId = `sandbox:${sandboxId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'sandbox:ready', {
      sandboxId,
      codespaceId: createId(),
      containerId: 'abc123def456',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes sandbox:error via Caddy without FK error', async () => {
    const sandboxId = createId();
    const streamId = `sandbox:${sandboxId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'sandbox:error', {
      sandboxId,
      codespaceId: createId(),
      error: 'Docker daemon unavailable',
      code: 'SANDBOX_CONTAINER_CREATION_FAILED',
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes sandbox:stopped via Caddy without FK error', async () => {
    const sandboxId = createId();
    const streamId = `sandbox:${sandboxId}`;

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'sandbox:stopped', {
      sandboxId,
      codespaceId: createId(),
    });

    expect(result.ok).toBe(true);
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes multiple sandbox lifecycle events in sequence', async () => {
    const sandboxId = createId();
    const codespaceId = createId();
    const streamId = `sandbox:${sandboxId}`;

    await service.createStream(streamId, null);

    await service.publish(streamId, 'sandbox:creating', {
      sandboxId,
      codespaceId,
      image: 'agentpane/sandbox:latest',
    });
    await service.publish(streamId, 'sandbox:ready', {
      sandboxId,
      codespaceId,
      containerId: 'container-abc',
    });
    await service.publish(streamId, 'sandbox:stopping', {
      sandboxId,
      codespaceId,
      reason: 'idle_timeout',
    });
    await service.publish(streamId, 'sandbox:stopped', {
      sandboxId,
      codespaceId,
    });

    // F05-19: 4 outbox rows, but server.publish is not called from
    // publish() — the relay delivers each row asynchronously.
    expect(publishSpy).not.toHaveBeenCalled();
  });

  it('publishes multiple terraform events with correct ordering', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;

    await service.createStream(streamId, null);

    await service.publish(streamId, 'terraform:status', { jobId, stage: 'loading_catalog' });
    await service.publish(streamId, 'terraform:status', { jobId, stage: 'analyzing' });
    await service.publish(streamId, 'terraform:text', { jobId, delta: 'Generating HCL...' });
    await service.publish(streamId, 'terraform:done', {
      jobId,
      generatedCode: 'resource "aws_s3_bucket" "main" {}',
      usage: { inputTokens: 50, outputTokens: 100 },
    });

    // All events should go through Caddy server
    expect(publishSpy).toHaveBeenCalledTimes(4);
  });

  it('surfaces Caddy publish errors for ephemeral streams (Caddy is only delivery path)', async () => {
    const jobId = createId();
    const streamId = `terraform:${jobId}`;
    publishSpy.mockRejectedValueOnce(new Error('Caddy unavailable'));

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'terraform:status', {
      jobId,
      stage: 'loading_catalog',
    });

    // Ephemeral streams (terraform:*) rely solely on Caddy — errors must propagate
    expect(result.ok).toBe(false);
  });

  it('tolerates Caddy publish errors for durable (non-ephemeral) streams', async () => {
    const sessionId = createId();
    const streamId = `plan:${sessionId}`;
    publishSpy.mockRejectedValueOnce(new Error('Caddy unavailable'));

    await service.createStream(streamId, null);
    const result = await service.publish(streamId, 'plan:started', {
      sessionId,
      taskId: createId(),
      codespaceId: createId(),
    });

    // Durable streams persist to DB first — Caddy failure is best-effort
    expect(result.ok).toBe(true);
  });
});
