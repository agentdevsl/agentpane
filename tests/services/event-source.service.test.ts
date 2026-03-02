import { beforeEach, describe, expect, it, vi } from 'vitest';
import { EventSourceService } from '../../src/services/event-source.service';

// =============================================================================
// Module mocks
// =============================================================================

vi.mock('@paralleldrive/cuid2', () => ({
  createId: vi.fn().mockReturnValue('mock-cuid-123456'),
}));

vi.mock('../../src/lib/crypto/server-encryption', () => ({
  encryptToken: vi.fn().mockReturnValue('encrypted-secret-value'),
  decryptToken: vi.fn().mockReturnValue('decrypted-plaintext-secret'),
}));

vi.mock('../../src/lib/utils/slugify', () => ({
  slugify: vi.fn().mockReturnValue('my-source'),
}));

// Mock node:crypto — only randomBytes is used
vi.mock('node:crypto', () => ({
  randomBytes: vi.fn().mockReturnValue({
    toString: vi
      .fn()
      .mockReturnValue('abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'),
  }),
}));

import * as crypto from 'node:crypto';
import { createId } from '@paralleldrive/cuid2';
import { decryptToken, encryptToken } from '../../src/lib/crypto/server-encryption';
import { slugify } from '../../src/lib/utils/slugify';

// =============================================================================
// Mock DB factory
// =============================================================================

function makeEventSource(overrides: Record<string, unknown> = {}) {
  return {
    id: 'source-1',
    teamId: 'team-1',
    name: 'My Source',
    type: 'github',
    slug: 'my-source-abc123',
    webhookSecret: 'encrypted-secret-value',
    isEnabled: true,
    config: {},
    eventCount: 0,
    lastEventAt: null,
    status: 'active',
    createdAt: '2026-01-01T00:00:00.000Z',
    updatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

function createMockDb() {
  const insertChain = {
    values: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([makeEventSource()]),
  };
  const updateChain = {
    set: vi.fn().mockReturnThis(),
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([makeEventSource()]),
  };
  const deleteChain = {
    where: vi.fn().mockReturnThis(),
    returning: vi.fn().mockResolvedValue([{ id: 'source-1' }]),
  };

  return {
    insert: vi.fn().mockReturnValue(insertChain),
    update: vi.fn().mockReturnValue(updateChain),
    delete: vi.fn().mockReturnValue(deleteChain),
    query: {
      teams: {
        findFirst: vi.fn().mockResolvedValue({ id: 'team-1', name: 'Test Team' }),
      },
      eventSources: {
        findFirst: vi.fn().mockResolvedValue(makeEventSource()),
        findMany: vi.fn().mockResolvedValue([makeEventSource()]),
      },
    },
    _insertChain: insertChain,
    _updateChain: updateChain,
    _deleteChain: deleteChain,
  };
}

// =============================================================================
// EventSourceService Tests
// =============================================================================

describe('EventSourceService', () => {
  let mockDb: ReturnType<typeof createMockDb>;
  let service: EventSourceService;

  beforeEach(() => {
    vi.clearAllMocks();
    mockDb = createMockDb();
    service = new EventSourceService(mockDb as never);
  });

  // ===========================================================================
  // create()
  // ===========================================================================

  describe('create()', () => {
    const baseInput = {
      teamId: 'team-1',
      name: 'My Source',
      type: 'github' as const,
    };

    it('creates source with all provided fields and returns source + plaintextSecret', async () => {
      const result = await service.create({
        ...baseInput,
        webhookSecret: 'user-provided-secret',
        config: { repo: 'owner/repo' },
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.source).toEqual(makeEventSource());
      expect(result.value.plaintextSecret).toBe('user-provided-secret');

      // Verify insert was called
      expect(mockDb.insert).toHaveBeenCalledTimes(1);
      const insertValues = mockDb._insertChain.values.mock.calls[0][0];
      expect(insertValues.teamId).toBe('team-1');
      expect(insertValues.name).toBe('My Source');
      expect(insertValues.type).toBe('github');
      expect(insertValues.config).toEqual({ repo: 'owner/repo' });
      expect(insertValues.isEnabled).toBe(true);
      expect(insertValues.eventCount).toBe(0);
      expect(insertValues.status).toBe('active');
    });

    it('returns TEAM_NOT_FOUND when team does not exist', async () => {
      mockDb.query.teams.findFirst.mockResolvedValue(undefined);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_TEAM_NOT_FOUND');

      // Should not attempt insert
      expect(mockDb.insert).not.toHaveBeenCalled();
    });

    it('auto-generates webhook secret when not provided (uses crypto.randomBytes)', async () => {
      const result = await service.create(baseInput);

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // randomBytes should have been called to generate a secret
      expect(crypto.randomBytes).toHaveBeenCalledWith(32);
      // The plaintext secret is the hex-encoded value from randomBytes
      expect(result.value.plaintextSecret).toBe(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      );
    });

    it('uses provided webhookSecret when given', async () => {
      const result = await service.create({
        ...baseInput,
        webhookSecret: 'my-custom-secret',
      });

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      expect(result.value.plaintextSecret).toBe('my-custom-secret');
      // randomBytes should NOT be called when a secret is provided
      expect(crypto.randomBytes).not.toHaveBeenCalled();
    });

    it('encrypts the webhook secret via encryptToken', async () => {
      await service.create({
        ...baseInput,
        webhookSecret: 'secret-to-encrypt',
      });

      expect(encryptToken).toHaveBeenCalledWith('secret-to-encrypt');

      const insertValues = mockDb._insertChain.values.mock.calls[0][0];
      expect(insertValues.webhookSecret).toBe('encrypted-secret-value');
    });

    it('generates slug from name using slugify + random suffix', async () => {
      await service.create(baseInput);

      expect(slugify).toHaveBeenCalledWith('My Source');
      // The slug should be: slugify(name) + '-' + createId().slice(0,6)
      const insertValues = mockDb._insertChain.values.mock.calls[0][0];
      expect(insertValues.slug).toBe('my-source-mock-c');
    });

    it('returns PROCESSING_FAILED when insert returns empty', async () => {
      mockDb._insertChain.returning.mockResolvedValue([]);

      const result = await service.create(baseInput);

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_PROCESSING_FAILED');
    });

    it('uses createId for the source ID', async () => {
      await service.create(baseInput);

      expect(createId).toHaveBeenCalled();
      const insertValues = mockDb._insertChain.values.mock.calls[0][0];
      expect(insertValues.id).toBe('mock-cuid-123456');
    });

    it('defaults config to empty object when not provided', async () => {
      await service.create(baseInput);

      const insertValues = mockDb._insertChain.values.mock.calls[0][0];
      expect(insertValues.config).toEqual({});
    });
  });

  // ===========================================================================
  // getById()
  // ===========================================================================

  describe('getById()', () => {
    it('returns source when found', async () => {
      const result = await service.getById('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(makeEventSource());
      expect(mockDb.query.eventSources.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns SOURCE_NOT_FOUND when not found', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue(undefined);

      const result = await service.getById('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // listByTeam()
  // ===========================================================================

  describe('listByTeam()', () => {
    it('returns array of sources for team', async () => {
      const sources = [
        makeEventSource({ id: 'source-1' }),
        makeEventSource({ id: 'source-2', name: 'Second Source' }),
      ];
      mockDb.query.eventSources.findMany.mockResolvedValue(sources);

      const result = await service.listByTeam('team-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toHaveLength(2);
      expect(result.value[0].id).toBe('source-1');
      expect(result.value[1].id).toBe('source-2');
    });

    it('returns empty array when no sources exist', async () => {
      mockDb.query.eventSources.findMany.mockResolvedValue([]);

      const result = await service.listByTeam('team-no-sources');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual([]);
    });
  });

  // ===========================================================================
  // update()
  // ===========================================================================

  describe('update()', () => {
    it('updates provided fields', async () => {
      const updated = makeEventSource({ name: 'Updated Name' });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      const result = await service.update('source-1', { name: 'Updated Name' });

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value.name).toBe('Updated Name');
      expect(mockDb.update).toHaveBeenCalledTimes(1);

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      expect(setArg.name).toBe('Updated Name');
      expect(setArg.updatedAt).toBeTruthy();
    });

    it('syncs status to active when isEnabled=true', async () => {
      const updated = makeEventSource({ isEnabled: true, status: 'active' });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      await service.update('source-1', { isEnabled: true });

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      expect(setArg.status).toBe('active');
      expect(setArg.isEnabled).toBe(true);
    });

    it('syncs status to disabled when isEnabled=false', async () => {
      const updated = makeEventSource({ isEnabled: false, status: 'disabled' });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      await service.update('source-1', { isEnabled: false });

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      expect(setArg.status).toBe('disabled');
      expect(setArg.isEnabled).toBe(false);
    });

    it('returns SOURCE_NOT_FOUND when ID does not exist', async () => {
      mockDb._updateChain.returning.mockResolvedValue([]);

      const result = await service.update('nonexistent-id', { name: 'New Name' });

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });

    it('filters out undefined values', async () => {
      const updated = makeEventSource();
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      await service.update('source-1', { name: undefined, isEnabled: true });

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      // name should be filtered out since it's undefined
      expect(setArg).not.toHaveProperty('name');
      expect(setArg.isEnabled).toBe(true);
      expect(setArg.updatedAt).toBeTruthy();
    });

    it('does not set status when isEnabled is not provided', async () => {
      const updated = makeEventSource({ name: 'Renamed' });
      mockDb._updateChain.returning.mockResolvedValue([updated]);

      await service.update('source-1', { name: 'Renamed' });

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      expect(setArg).not.toHaveProperty('status');
    });
  });

  // ===========================================================================
  // delete()
  // ===========================================================================

  describe('delete()', () => {
    it('deletes and returns ok(undefined)', async () => {
      const result = await service.delete('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeUndefined();
      expect(mockDb.delete).toHaveBeenCalledTimes(1);
    });

    it('returns SOURCE_NOT_FOUND when ID does not exist', async () => {
      mockDb._deleteChain.returning.mockResolvedValue([]);

      const result = await service.delete('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // rotateSecret()
  // ===========================================================================

  describe('rotateSecret()', () => {
    it('generates new secret, encrypts it, updates DB, returns plaintext', async () => {
      mockDb._updateChain.returning.mockResolvedValue([{ id: 'source-1' }]);

      const result = await service.rotateSecret('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;

      // Should generate a random secret
      expect(crypto.randomBytes).toHaveBeenCalledWith(32);
      expect(result.value.secret).toBe(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      );

      // Should encrypt it
      expect(encryptToken).toHaveBeenCalledWith(
        'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789'
      );

      // Should update DB with encrypted value
      expect(mockDb.update).toHaveBeenCalledTimes(1);
      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      expect(setArg.webhookSecret).toBe('encrypted-secret-value');
      expect(setArg.updatedAt).toBeTruthy();
    });

    it('returns SOURCE_NOT_FOUND when ID does not exist', async () => {
      mockDb._updateChain.returning.mockResolvedValue([]);

      const result = await service.rotateSecret('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // getBySlug()
  // ===========================================================================

  describe('getBySlug()', () => {
    it('returns source when found', async () => {
      const result = await service.getBySlug('my-source-abc123');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toEqual(makeEventSource());
      expect(mockDb.query.eventSources.findFirst).toHaveBeenCalledTimes(1);
    });

    it('returns SOURCE_NOT_FOUND when not found', async () => {
      mockDb.query.eventSources.findFirst.mockResolvedValue(undefined);

      const result = await service.getBySlug('nonexistent-slug');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // incrementEventCount()
  // ===========================================================================

  describe('incrementEventCount()', () => {
    it('updates event count and lastEventAt', async () => {
      mockDb._updateChain.returning.mockResolvedValue([makeEventSource({ eventCount: 1 })]);

      const result = await service.incrementEventCount('source-1');

      expect(result.ok).toBe(true);
      if (!result.ok) return;
      expect(result.value).toBeUndefined();
      expect(mockDb.update).toHaveBeenCalledTimes(1);

      const setArg = mockDb._updateChain.set.mock.calls[0][0];
      // eventCount uses sql`...` expression, so we verify it's set
      expect(setArg.eventCount).toBeDefined();
      expect(setArg.lastEventAt).toBeTruthy();
    });

    it('returns SOURCE_NOT_FOUND when ID does not exist', async () => {
      mockDb._updateChain.returning.mockResolvedValue([]);

      const result = await service.incrementEventCount('nonexistent-id');

      expect(result.ok).toBe(false);
      if (result.ok) return;
      expect(result.error.code).toBe('EVENT_SOURCE_NOT_FOUND');
    });
  });

  // ===========================================================================
  // decryptSecret()
  // ===========================================================================

  describe('decryptSecret()', () => {
    it('returns decrypted plaintext when webhookSecret exists', () => {
      const source = makeEventSource({ webhookSecret: 'encrypted-data' });

      const result = service.decryptSecret(source as never);

      expect(result).toBe('decrypted-plaintext-secret');
      expect(decryptToken).toHaveBeenCalledWith('encrypted-data');
    });

    it('returns null when webhookSecret is null', () => {
      const source = makeEventSource({ webhookSecret: null });

      const result = service.decryptSecret(source as never);

      expect(result).toBeNull();
      expect(decryptToken).not.toHaveBeenCalled();
    });

    it('returns null when webhookSecret is empty string (falsy)', () => {
      const source = makeEventSource({ webhookSecret: '' });

      const result = service.decryptSecret(source as never);

      expect(result).toBeNull();
      expect(decryptToken).not.toHaveBeenCalled();
    });
  });
});
