import { describe, expect, it, vi } from 'vitest';
import { SandboxConfigErrors } from '../../lib/errors/sandbox-config-errors.js';
import { SandboxConfigService } from '../sandbox-config.service.js';

const createDbMock = () => ({
  query: {
    sandboxConfigs: {
      findFirst: vi.fn(),
      findMany: vi.fn(),
    },
    projects: {
      findMany: vi.fn(),
    },
  },
  insert: vi.fn(() => ({ values: vi.fn(() => ({ returning: vi.fn() })) })),
  update: vi.fn(() => ({ set: vi.fn(() => ({ where: vi.fn(() => ({ returning: vi.fn() })) })) })),
  delete: vi.fn(() => ({ where: vi.fn() })),
});

const sampleConfig = {
  id: 'cfg-1',
  name: 'Default',
  description: 'Default configuration',
  isDefault: true,
  baseImage: 'node:22-slim',
  memoryMb: 4096,
  cpuCores: 2.0,
  maxProcesses: 256,
  timeoutMinutes: 60,
  createdAt: '2026-01-01T00:00:00Z',
  updatedAt: '2026-01-01T00:00:00Z',
};

describe('SandboxConfigService', () => {
  describe('create', () => {
    it('creates a config with defaults', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(null);

      const returning = vi.fn().mockResolvedValue([sampleConfig]);
      db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

      const service = new SandboxConfigService(db as never);
      const result = await service.create({ name: 'Default' });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Default');
      }
    });

    it('returns error for duplicate name', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);

      const service = new SandboxConfigService(db as never);
      const result = await service.create({ name: 'Default' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SandboxConfigErrors.ALREADY_EXISTS);
      }
    });

    it('clears existing default when setting new default', async () => {
      const db = createDbMock();
      const existingDefault = { ...sampleConfig, id: 'cfg-old' };

      // First call: check name uniqueness
      // Second call: check existing default
      db.query.sandboxConfigs.findFirst
        .mockResolvedValueOnce(null) // no duplicate name
        .mockResolvedValueOnce(existingDefault); // existing default

      const returning = vi.fn().mockResolvedValue([sampleConfig]);
      db.insert.mockReturnValue({ values: vi.fn(() => ({ returning })) });

      const updateReturning = vi.fn();
      const updateWhere = vi.fn(() => ({ returning: updateReturning }));
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      db.update.mockReturnValue({ set: updateSet });

      const service = new SandboxConfigService(db as never);
      const result = await service.create({ name: 'New Default', isDefault: true });

      expect(result.ok).toBe(true);
      expect(db.update).toHaveBeenCalled();
    });

    it('validates memory limits', async () => {
      const db = createDbMock();
      const service = new SandboxConfigService(db as never);

      const tooLow = await service.create({ name: 'Test', memoryMb: 100 });
      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }

      const tooHigh = await service.create({ name: 'Test', memoryMb: 50000 });
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });

    it('validates CPU limits', async () => {
      const db = createDbMock();
      const service = new SandboxConfigService(db as never);

      const tooLow = await service.create({ name: 'Test', cpuCores: 0.1 });
      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }

      const tooHigh = await service.create({ name: 'Test', cpuCores: 20 });
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }
    });

    it('validates process limits', async () => {
      const db = createDbMock();
      const service = new SandboxConfigService(db as never);

      const tooLow = await service.create({ name: 'Test', maxProcesses: 10 });
      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }

      const tooHigh = await service.create({ name: 'Test', maxProcesses: 10000 });
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }
    });

    it('validates timeout limits', async () => {
      const db = createDbMock();
      const service = new SandboxConfigService(db as never);

      const tooLow = await service.create({ name: 'Test', timeoutMinutes: 0 });
      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_TIMEOUT');
      }

      const tooHigh = await service.create({ name: 'Test', timeoutMinutes: 2000 });
      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_TIMEOUT');
      }
    });
  });

  describe('getById', () => {
    it('returns config when found', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);

      const service = new SandboxConfigService(db as never);
      const result = await service.getById('cfg-1');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe('cfg-1');
      }
    });

    it('returns NOT_FOUND when config does not exist', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(null);

      const service = new SandboxConfigService(db as never);
      const result = await service.getById('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SandboxConfigErrors.NOT_FOUND);
      }
    });
  });

  describe('getDefault', () => {
    it('returns default config when one exists', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);

      const service = new SandboxConfigService(db as never);
      const result = await service.getDefault();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.isDefault).toBe(true);
      }
    });

    it('returns null when no default exists', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(null);

      const service = new SandboxConfigService(db as never);
      const result = await service.getDefault();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('list', () => {
    it('returns list of configs', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findMany.mockResolvedValue([sampleConfig]);

      const service = new SandboxConfigService(db as never);
      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toHaveLength(1);
        expect(result.value[0]?.id).toBe('cfg-1');
      }
    });

    it('returns empty list when no configs', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findMany.mockResolvedValue([]);

      const service = new SandboxConfigService(db as never);
      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toEqual([]);
      }
    });

    it('respects limit and offset', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findMany.mockResolvedValue([sampleConfig]);

      const service = new SandboxConfigService(db as never);
      await service.list({ limit: 10, offset: 5 });

      expect(db.query.sandboxConfigs.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          limit: 10,
          offset: 5,
        })
      );
    });
  });

  describe('update', () => {
    it('updates config fields', async () => {
      const db = createDbMock();
      const updatedConfig = { ...sampleConfig, memoryMb: 8192 };

      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);

      const returning = vi.fn().mockResolvedValue([updatedConfig]);
      const updateWhere = vi.fn(() => ({ returning }));
      const updateSet = vi.fn(() => ({ where: updateWhere }));
      db.update.mockReturnValue({ set: updateSet });

      const service = new SandboxConfigService(db as never);
      const result = await service.update('cfg-1', { memoryMb: 8192 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memoryMb).toBe(8192);
      }
    });

    it('returns NOT_FOUND when config does not exist', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(null);

      const service = new SandboxConfigService(db as never);
      const result = await service.update('nonexistent', { memoryMb: 8192 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SandboxConfigErrors.NOT_FOUND);
      }
    });

    it('validates resource limits on update', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);

      const service = new SandboxConfigService(db as never);
      const result = await service.update('cfg-1', { memoryMb: 100 });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });

    it('prevents duplicate name on update', async () => {
      const db = createDbMock();
      const otherConfig = { ...sampleConfig, id: 'cfg-2', name: 'Other' };

      // First call: find config being updated
      // Second call: check for name conflict
      db.query.sandboxConfigs.findFirst
        .mockResolvedValueOnce(sampleConfig) // config exists
        .mockResolvedValueOnce(otherConfig); // name conflict

      const service = new SandboxConfigService(db as never);
      const result = await service.update('cfg-1', { name: 'Other' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SandboxConfigErrors.ALREADY_EXISTS);
      }
    });
  });

  describe('delete', () => {
    it('deletes config when not in use', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);
      db.query.projects.findMany.mockResolvedValue([]);

      const service = new SandboxConfigService(db as never);
      const result = await service.delete('cfg-1');

      expect(result.ok).toBe(true);
      expect(db.delete).toHaveBeenCalled();
    });

    it('returns NOT_FOUND when config does not exist', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(null);

      const service = new SandboxConfigService(db as never);
      const result = await service.delete('nonexistent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).toMatchObject(SandboxConfigErrors.NOT_FOUND);
      }
    });

    it('returns IN_USE when projects are using config', async () => {
      const db = createDbMock();
      db.query.sandboxConfigs.findFirst.mockResolvedValue(sampleConfig);
      db.query.projects.findMany.mockResolvedValue([
        { id: 'proj-1', sandboxConfigId: 'cfg-1' },
        { id: 'proj-2', sandboxConfigId: 'cfg-1' },
      ]);

      const service = new SandboxConfigService(db as never);
      const result = await service.delete('cfg-1');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        const expected = SandboxConfigErrors.IN_USE(2);
        expect(result.error).toMatchObject({
          code: expected.code,
          message: expected.message,
          status: expected.status,
          details: expected.details,
        });
      }
    });
  });
});
