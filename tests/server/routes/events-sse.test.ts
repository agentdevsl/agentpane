/**
 * Tests for event system routes (sources, subscriptions, SSE stream).
 *
 * Covers:
 * - publishEventToStream: no-op with no listeners, does not throw
 * - GET /stream: SSE headers, connection limit (429)
 * - GET /sources: list sources, teamId filter, invalid teamId, webhook secret stripped
 * - POST /sources: create returns webhookSecret (one-time display), validation errors
 * - PATCH /sources/:id: update source, invalid id
 * - DELETE /sources/:id: delete source
 * - POST /sources/:id/rotate-secret: rotate webhook secret
 * - GET /subscriptions: list by eventSourceId, by targetProjectId
 * - POST /subscriptions: create subscription, validation on missing fields
 * - PATCH /subscriptions/:id: update subscription
 * - DELETE /subscriptions/:id: delete subscription
 */
import { Hono } from 'hono';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContext } from '../../../src/lib/api/auth-middleware';
import { publishEventToStream } from '../../../src/lib/events/event-bus';
import {
  createEventsRoutes,
  type EventsRouteDependencies,
} from '../../../src/server/routes/events';

// ---------------------------------------------------------------------------
// Mock helpers
// ---------------------------------------------------------------------------

function createMockEventSourceService() {
  return {
    listByTeam: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
    rotateSecret: vi.fn(),
  };
}

function createMockEventSubscriptionService() {
  return {
    listBySource: vi.fn(),
    listByProject: vi.fn(),
    getById: vi.fn(),
    create: vi.fn(),
    update: vi.fn(),
    delete: vi.fn(),
  };
}

/**
 * Create a chainable query builder mock that resolves to `resolvedValue` at
 * any point in the chain (where, orderBy, limit, or direct await).
 */
function createChainableQuery(resolvedValue: unknown[] = []) {
  const chain: Record<string, ReturnType<typeof vi.fn>> = {};
  chain.where = vi.fn().mockReturnValue(chain);
  chain.orderBy = vi.fn().mockReturnValue(chain);
  chain.limit = vi.fn().mockReturnValue(chain);
  // Make the chain thenable so `await` works at any point in the chain.
  // biome-ignore lint/suspicious/noThenProperty: intentional — mock must be thenable to simulate drizzle query builder
  chain.then = vi
    .fn()
    .mockImplementation((resolve: (v: unknown) => void, reject?: (e: unknown) => void) =>
      Promise.resolve(resolvedValue).then(resolve, reject)
    );
  return chain;
}

function createMockDb() {
  const selectChain = createChainableQuery();
  return {
    select: vi.fn().mockReturnValue({
      from: vi.fn().mockReturnValue(selectChain),
    }),
    _selectChain: selectChain,
    insert: vi.fn().mockReturnValue({
      values: vi.fn().mockReturnValue({
        returning: vi.fn().mockResolvedValue([]),
      }),
    }),
    delete: vi.fn().mockReturnValue({
      where: vi.fn().mockResolvedValue(undefined),
    }),
    query: {
      teams: { findFirst: vi.fn() },
    },
  };
}

function createMockRbacService() {
  return {
    resolveTeamRole: vi.fn().mockResolvedValue('admin'),
    resolveUserRole: vi.fn().mockResolvedValue('admin'),
    hasMinimumRole: vi.fn().mockReturnValue(true),
    checkTeamRole: vi.fn(),
  };
}

type MockDeps = {
  eventSourceService: ReturnType<typeof createMockEventSourceService>;
  eventSubscriptionService: ReturnType<typeof createMockEventSubscriptionService>;
  db: ReturnType<typeof createMockDb>;
  rbacService: ReturnType<typeof createMockRbacService>;
};

function createMockDeps(): MockDeps {
  return {
    eventSourceService: createMockEventSourceService(),
    eventSubscriptionService: createMockEventSubscriptionService(),
    db: createMockDb(),
    rbacService: createMockRbacService(),
  };
}

const DEV_AUTH: AuthContext = {
  userId: 'user-dev-001',
  authMethod: 'dev',
  teamMemberships: [{ teamId: 'team-1', role: 'admin' }],
};

function createApp(deps: MockDeps, auth: AuthContext = DEV_AUTH) {
  const routes = createEventsRoutes(deps as unknown as EventsRouteDependencies);
  const app = new Hono();
  app.use('*', async (c, next) => {
    c.set('auth', auth);
    return next();
  });
  app.route('/events', routes);
  return app;
}

// ---------------------------------------------------------------------------
// publishEventToStream
// ---------------------------------------------------------------------------

describe('publishEventToStream', () => {
  it('does not throw when no listeners are registered', () => {
    expect(() => publishEventToStream({ type: 'test', data: {} })).not.toThrow();
  });

  it('does not throw with various event payloads', () => {
    expect(() =>
      publishEventToStream({ type: 'task:created', data: { id: 'task-1' } })
    ).not.toThrow();
    expect(() => publishEventToStream({ type: '', data: null })).not.toThrow();
    expect(() =>
      publishEventToStream({ type: 'complex', data: { nested: { deep: true }, arr: [1, 2, 3] } })
    ).not.toThrow();
  });

  it('can be called multiple times in succession without error', () => {
    for (let i = 0; i < 100; i++) {
      expect(() => publishEventToStream({ type: `event-${i}`, data: { seq: i } })).not.toThrow();
    }
  });
});

// ---------------------------------------------------------------------------
// SSE Stream endpoint
// ---------------------------------------------------------------------------

describe('GET /events/stream', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns SSE headers (Content-Type: text/event-stream)', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/stream');

    expect(res.headers.get('Content-Type')).toBe('text/event-stream');
    expect(res.headers.get('Cache-Control')).toBe('no-cache');
    expect(res.headers.get('Connection')).toBe('keep-alive');
  });

  it('returns a readable stream body', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/stream');

    expect(res.body).toBeTruthy();
    expect(res.status).toBe(200);
  });

  it('sends initial connected event in the stream', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/stream');

    // Read the first chunk from the stream
    const reader = res.body!.getReader();
    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    expect(text).toContain('data: ');
    expect(text).toContain('"type":"connected"');
    expect(text).toContain('"timestamp"');
  });

  it('delivers published events to connected SSE clients', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/stream');

    const reader = res.body!.getReader();

    // Read the initial connected event
    await reader.read();

    // Publish an event
    publishEventToStream({ type: 'task:created', data: { taskId: 'task-abc' } });

    // Read the published event
    const { value } = await reader.read();
    reader.cancel();

    const text = new TextDecoder().decode(value);
    expect(text).toContain('"type":"task:created"');
    expect(text).toContain('"taskId":"task-abc"');
  });

  it('delivers events to multiple concurrent SSE clients', async () => {
    const app = createApp(deps);
    const res1 = await app.request('/events/stream');
    const res2 = await app.request('/events/stream');

    const reader1 = res1.body!.getReader();
    const reader2 = res2.body!.getReader();

    // Consume initial connected events
    await reader1.read();
    await reader2.read();

    // Publish an event
    publishEventToStream({ type: 'multi-test', data: { value: 42 } });

    // Both clients should receive it
    const { value: v1 } = await reader1.read();
    const { value: v2 } = await reader2.read();
    reader1.cancel();
    reader2.cancel();

    const text1 = new TextDecoder().decode(v1);
    const text2 = new TextDecoder().decode(v2);
    expect(text1).toContain('"type":"multi-test"');
    expect(text2).toContain('"type":"multi-test"');
  });
});

// ---------------------------------------------------------------------------
// GET /events/sources
// ---------------------------------------------------------------------------

describe('GET /events/sources', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns sources with webhook secrets stripped', async () => {
    const sampleSource = {
      id: 'src-1',
      teamId: 'team-1',
      name: 'GitHub Webhook',
      type: 'github',
      webhookSecret: 'super-secret-hash',
      slug: 'github-webhook-abc',
      isEnabled: true,
      createdAt: '2026-01-01T00:00:00Z',
    };
    // Configure mock DB to return the source from the paginated query
    const selectChain = createChainableQuery([sampleSource]);
    deps.db.select.mockReturnValue({ from: vi.fn().mockReturnValue(selectChain) });

    const app = createApp(deps);
    const res = await app.request('/events/sources?teamId=team-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(1);
    // webhookSecret should be stripped
    expect(body.data.items[0]).not.toHaveProperty('webhookSecret');
    expect(body.data.items[0].id).toBe('src-1');
    expect(body.data.items[0].name).toBe('GitHub Webhook');
  });

  it('returns 400 for invalid teamId query param', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources?teamId=../../../etc/passwd');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid teamId');
  });

  it('returns 403 when user is not a member of the requested team', async () => {
    // Auth context has team-1, but requesting team-other
    const auth: AuthContext = {
      userId: 'user-1',
      authMethod: 'dev',
      teamMemberships: [{ teamId: 'team-1', role: 'admin' }],
    };
    const app = createApp(deps, auth);
    const res = await app.request('/events/sources?teamId=team-other');
    const body = await res.json();

    expect(res.status).toBe(403);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('FORBIDDEN');
  });

  it('returns empty items when user has no teams', async () => {
    // Use session auth with DB fallback -- mock DB to return empty memberships
    const auth: AuthContext = {
      userId: 'user-no-teams',
      authMethod: 'session',
    };
    // The getUserTeamIds function queries DB for user's team memberships
    deps.db.select.mockReturnValueOnce({
      from: vi.fn().mockReturnValue({
        where: vi.fn().mockResolvedValue([]),
      }),
    });

    const app = createApp(deps, auth);
    const res = await app.request('/events/sources');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.items).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// POST /events/sources
// ---------------------------------------------------------------------------

describe('POST /events/sources', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns webhookSecret in response (one-time display) and strips it from source', async () => {
    const createdSource = {
      id: 'src-new',
      teamId: 'team-1',
      name: 'New Source',
      type: 'github',
      slug: 'new-source-abc',
      webhookSecret: 'hashed-secret',
      isEnabled: true,
    };
    deps.eventSourceService.create.mockResolvedValue({
      ok: true,
      value: { source: createdSource, plaintextSecret: 'whsec_plaintext_123' },
    });

    const app = createApp(deps);
    const res = await app.request('/events/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId: 'team-1',
        name: 'New Source',
        type: 'github',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    // The plaintext secret is included in the response for one-time display
    expect(body.data.webhookSecret).toBe('whsec_plaintext_123');
    expect(body.data.webhookUrl).toBe('/hooks/events/new-source-abc');
    expect(body.data.name).toBe('New Source');
  });

  it('rejects invalid source type', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId: 'team-1',
        name: 'Bad Source',
        type: 'invalid_type',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing name', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        teamId: 'team-1',
        type: 'github',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing teamId', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'No Team Source',
        type: 'github',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// PATCH /events/sources/:id
// ---------------------------------------------------------------------------

describe('PATCH /events/sources/:id', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns 400 for invalid source id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources/not a valid id!!', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'Updated' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('INVALID_ID');
  });

  it('updates an existing source successfully', async () => {
    const existingSource = {
      id: 'src-1',
      teamId: 'team-1',
      name: 'Old Name',
      type: 'github',
      webhookSecret: 'hash',
    };
    const updatedSource = { ...existingSource, name: 'New Name' };

    deps.eventSourceService.getById.mockResolvedValue({ ok: true, value: existingSource });
    deps.eventSourceService.update.mockResolvedValue({ ok: true, value: updatedSource });

    const app = createApp(deps);
    const res = await app.request('/events/sources/src-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Name' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    // webhookSecret should be stripped from the response
    expect(body.data).not.toHaveProperty('webhookSecret');
    expect(body.data.name).toBe('New Name');
  });
});

// ---------------------------------------------------------------------------
// DELETE /events/sources/:id
// ---------------------------------------------------------------------------

describe('DELETE /events/sources/:id', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('deletes a source successfully', async () => {
    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });
    deps.eventSourceService.delete.mockResolvedValue({ ok: true, value: { deleted: true } });

    const app = createApp(deps);
    const res = await app.request('/events/sources/src-1', { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('returns 400 for invalid id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources/bad id!', { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ---------------------------------------------------------------------------
// POST /events/sources/:id/rotate-secret
// ---------------------------------------------------------------------------

describe('POST /events/sources/:id/rotate-secret', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('rotates the secret successfully', async () => {
    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });
    deps.eventSourceService.rotateSecret.mockResolvedValue({
      ok: true,
      value: { newSecret: 'test-rotated-secret' },
    });

    const app = createApp(deps);
    const res = await app.request('/events/sources/src-1/rotate-secret', { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.newSecret).toBe('test-rotated-secret');
  });

  it('returns 400 for invalid source id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources/bad id!/rotate-secret', { method: 'POST' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ---------------------------------------------------------------------------
// POST /events/subscriptions
// ---------------------------------------------------------------------------

describe('POST /events/subscriptions', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('creates a subscription successfully', async () => {
    const newSubscription = {
      id: 'sub-1',
      name: 'PR Events',
      eventSourceId: 'src-1',
      targetProjectId: 'proj-1',
      promptTemplate: 'Handle this PR: {{event.title}}',
    };

    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });
    deps.eventSubscriptionService.create.mockResolvedValue({
      ok: true,
      value: newSubscription,
    });

    const app = createApp(deps);
    const res = await app.request('/events/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'PR Events',
        eventSourceId: 'src-1',
        targetProjectId: 'proj-1',
        promptTemplate: 'Handle this PR: {{event.title}}',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(201);
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('PR Events');
  });

  it('rejects missing required fields (name)', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        eventSourceId: 'src-1',
        targetProjectId: 'proj-1',
        // missing name and promptTemplate
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects missing promptTemplate', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'My Sub',
        eventSourceId: 'src-1',
        targetProjectId: 'proj-1',
        // missing promptTemplate
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects invalid eventSourceId format', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        name: 'Bad Sub',
        eventSourceId: '', // empty string fails idSchema
        targetProjectId: 'proj-1',
        promptTemplate: 'Do something',
      }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.ok).toBe(false);
    expect(body.error.code).toBe('VALIDATION_ERROR');
  });
});

// ---------------------------------------------------------------------------
// PATCH /events/subscriptions/:id
// ---------------------------------------------------------------------------

describe('PATCH /events/subscriptions/:id', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('updates a subscription successfully', async () => {
    const existing = {
      id: 'sub-1',
      eventSourceId: 'src-1',
      name: 'Old Name',
    };
    const updated = { ...existing, name: 'New Sub Name' };

    deps.eventSubscriptionService.getById.mockResolvedValue({ ok: true, value: existing });
    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });
    deps.eventSubscriptionService.update.mockResolvedValue({ ok: true, value: updated });

    const app = createApp(deps);
    const res = await app.request('/events/subscriptions/sub-1', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'New Sub Name' }),
    });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.name).toBe('New Sub Name');
  });

  it('returns 400 for invalid subscription id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions/bad id!', {
      method: 'PATCH',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: 'X' }),
    });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ---------------------------------------------------------------------------
// DELETE /events/subscriptions/:id
// ---------------------------------------------------------------------------

describe('DELETE /events/subscriptions/:id', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('deletes a subscription successfully', async () => {
    deps.eventSubscriptionService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'sub-1', eventSourceId: 'src-1' },
    });
    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });
    deps.eventSubscriptionService.delete.mockResolvedValue({
      ok: true,
      value: { deleted: true },
    });

    const app = createApp(deps);
    const res = await app.request('/events/subscriptions/sub-1', { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.deleted).toBe(true);
  });

  it('returns 400 for invalid id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions/bad id!!', { method: 'DELETE' });
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });
});

// ---------------------------------------------------------------------------
// GET /events/subscriptions (list with filters)
// ---------------------------------------------------------------------------

describe('GET /events/subscriptions', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('lists subscriptions by eventSourceId', async () => {
    const subs = [
      { id: 'sub-1', name: 'Sub 1', eventSourceId: 'src-1', createdAt: '2026-01-02T00:00:00Z' },
      { id: 'sub-2', name: 'Sub 2', eventSourceId: 'src-1', createdAt: '2026-01-01T00:00:00Z' },
    ];

    deps.eventSourceService.getById.mockResolvedValue({
      ok: true,
      value: { id: 'src-1', teamId: 'team-1' },
    });

    // Configure mock DB to return subscriptions from the paginated query
    const selectChain = createChainableQuery(subs);
    deps.db.select.mockReturnValue({ from: vi.fn().mockReturnValue(selectChain) });

    const app = createApp(deps);
    const res = await app.request('/events/subscriptions?eventSourceId=src-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data.items).toHaveLength(2);
  });

  it('returns 400 for invalid eventSourceId', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/subscriptions?eventSourceId=bad id!');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid eventSourceId');
  });

  it('returns 400 for invalid targetProjectId', async () => {
    // Provide a source so scope check doesn't exit early before targetProjectId validation
    const selectChain = createChainableQuery([{ id: 'src-1' }]);
    deps.db.select.mockReturnValue({ from: vi.fn().mockReturnValue(selectChain) });

    const app = createApp(deps);
    const res = await app.request('/events/subscriptions?targetProjectId=bad id!');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('VALIDATION_ERROR');
    expect(body.error.message).toBe('Invalid targetProjectId');
  });
});

// ---------------------------------------------------------------------------
// GET /events/sources/:id
// ---------------------------------------------------------------------------

describe('GET /events/sources/:id', () => {
  let deps: MockDeps;

  beforeEach(() => {
    deps = createMockDeps();
  });

  it('returns source with webhook secret stripped', async () => {
    const source = {
      id: 'src-1',
      teamId: 'team-1',
      name: 'My Source',
      webhookSecret: 'should-not-appear',
    };
    deps.eventSourceService.getById.mockResolvedValue({ ok: true, value: source });

    const app = createApp(deps);
    const res = await app.request('/events/sources/src-1');
    const body = await res.json();

    expect(res.status).toBe(200);
    expect(body.ok).toBe(true);
    expect(body.data).not.toHaveProperty('webhookSecret');
    expect(body.data.name).toBe('My Source');
  });

  it('returns 400 for invalid source id', async () => {
    const app = createApp(deps);
    const res = await app.request('/events/sources/bad id!');
    const body = await res.json();

    expect(res.status).toBe(400);
    expect(body.error.code).toBe('INVALID_ID');
  });
});
