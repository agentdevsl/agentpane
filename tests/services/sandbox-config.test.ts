import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SandboxConfigService } from '../../src/services/sandbox-config.service';
import { createTestProject } from '../factories/project.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('SandboxConfigService', () => {
  let service: SandboxConfigService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    service = new SandboxConfigService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // =============================================================================
  // CRUD Operations
  // =============================================================================

  describe('create', () => {
    it('creates a sandbox configuration with minimal input', async () => {
      const result = await service.create({
        name: 'Test Config',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Test Config');
        expect(result.value.type).toBe('docker');
        expect(result.value.isDefault).toBe(false);
        expect(result.value.baseImage).toBe('node:22-slim');
        expect(result.value.memoryMb).toBe(4096);
        expect(result.value.cpuCores).toBe(2.0);
        expect(result.value.maxProcesses).toBe(256);
        expect(result.value.timeoutMinutes).toBe(60);
        expect(result.value.id).toBeDefined();
        expect(result.value.createdAt).toBeDefined();
        expect(result.value.updatedAt).toBeDefined();
      }
    });

    it('creates a sandbox configuration with all fields', async () => {
      const result = await service.create({
        name: 'Full Config',
        description: 'A complete configuration',
        type: 'devcontainer',
        isDefault: true,
        baseImage: 'python:3.12-slim',
        memoryMb: 8192,
        cpuCores: 4.0,
        maxProcesses: 512,
        timeoutMinutes: 120,
        volumeMountPath: '/home/user/projects',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Full Config');
        expect(result.value.description).toBe('A complete configuration');
        expect(result.value.type).toBe('devcontainer');
        expect(result.value.isDefault).toBe(true);
        expect(result.value.baseImage).toBe('python:3.12-slim');
        expect(result.value.memoryMb).toBe(8192);
        expect(result.value.cpuCores).toBe(4.0);
        expect(result.value.maxProcesses).toBe(512);
        expect(result.value.timeoutMinutes).toBe(120);
        expect(result.value.volumeMountPath).toBe('/home/user/projects');
      }
    });

    it('returns error when creating with duplicate name', async () => {
      await service.create({ name: 'Duplicate' });
      const result = await service.create({ name: 'Duplicate' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_ALREADY_EXISTS');
      }
    });
  });

  describe('getById', () => {
    it('retrieves a sandbox configuration by ID', async () => {
      const createResult = await service.create({ name: 'Find Me' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.getById(createResult.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.id).toBe(createResult.value.id);
        expect(result.value.name).toBe('Find Me');
      }
    });

    it('returns error for non-existent ID', async () => {
      const result = await service.getById('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });
  });

  describe('update', () => {
    it('updates a sandbox configuration', async () => {
      const createResult = await service.create({ name: 'Original Name' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.update(createResult.value.id, {
        name: 'Updated Name',
        description: 'New description',
        memoryMb: 8192,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Updated Name');
        expect(result.value.description).toBe('New description');
        expect(result.value.memoryMb).toBe(8192);
      }
    });

    it('returns error when updating non-existent config', async () => {
      const result = await service.update('non-existent-id', { name: 'New Name' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });

    it('returns error when updating name to existing name', async () => {
      await service.create({ name: 'Config A' });
      const createResult = await service.create({ name: 'Config B' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.update(createResult.value.id, { name: 'Config A' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_ALREADY_EXISTS');
      }
    });
  });

  describe('delete', () => {
    it('deletes a sandbox configuration', async () => {
      const createResult = await service.create({ name: 'Delete Me' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const deleteResult = await service.delete(createResult.value.id);
      expect(deleteResult.ok).toBe(true);

      const getResult = await service.getById(createResult.value.id);
      expect(getResult.ok).toBe(false);
    });

    it('returns error when deleting non-existent config', async () => {
      const result = await service.delete('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });

    it('returns error when deleting config in use by projects', async () => {
      const createResult = await service.create({ name: 'In Use Config' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      // Create a project using this sandbox config
      await createTestProject({ sandboxConfigId: createResult.value.id });

      const result = await service.delete(createResult.value.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_IN_USE');
      }
    });
  });

  describe('list', () => {
    it('lists all sandbox configurations', async () => {
      await service.create({ name: 'Config 1' });
      await service.create({ name: 'Config 2' });
      await service.create({ name: 'Config 3' });

      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(3);
      }
    });

    it('respects limit and offset options', async () => {
      await service.create({ name: 'Config 1' });
      await service.create({ name: 'Config 2' });
      await service.create({ name: 'Config 3' });

      const result = await service.list({ limit: 2, offset: 1 });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(2);
      }
    });

    it('returns empty array when no configurations exist', async () => {
      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(0);
      }
    });
  });

  // =============================================================================
  // Validation
  // =============================================================================

  describe('validation', () => {
    it('rejects memory below minimum (512MB)', async () => {
      const result = await service.create({
        name: 'Low Memory',
        memoryMb: 256,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });

    it('rejects memory above maximum (32768MB)', async () => {
      const result = await service.create({
        name: 'High Memory',
        memoryMb: 65536,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });

    it('rejects CPU cores below minimum (0.5)', async () => {
      const result = await service.create({
        name: 'Low CPU',
        cpuCores: 0.25,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }
    });

    it('rejects CPU cores above maximum (16)', async () => {
      const result = await service.create({
        name: 'High CPU',
        cpuCores: 32,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }
    });

    it('rejects max processes below minimum (32)', async () => {
      const result = await service.create({
        name: 'Low Processes',
        maxProcesses: 16,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }
    });

    it('rejects max processes above maximum (4096)', async () => {
      const result = await service.create({
        name: 'High Processes',
        maxProcesses: 8192,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }
    });

    it('rejects timeout below minimum (1 minute)', async () => {
      const result = await service.create({
        name: 'Low Timeout',
        timeoutMinutes: 0,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_TIMEOUT');
      }
    });

    it('rejects timeout above maximum (1440 minutes)', async () => {
      const result = await service.create({
        name: 'High Timeout',
        timeoutMinutes: 2880,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_TIMEOUT');
      }
    });

    it('validates resource limits on update', async () => {
      const createResult = await service.create({ name: 'Valid Config' });
      expect(createResult.ok).toBe(true);
      if (!createResult.ok) return;

      const result = await service.update(createResult.value.id, {
        memoryMb: 256,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });
  });

  // =============================================================================
  // Default Configuration Management
  // =============================================================================

  describe('default configuration', () => {
    it('returns null when no default exists', async () => {
      const result = await service.getDefault();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });

    it('retrieves the default configuration', async () => {
      await service.create({ name: 'Default Config', isDefault: true });

      const result = await service.getDefault();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).not.toBeNull();
        expect(result.value?.name).toBe('Default Config');
        expect(result.value?.isDefault).toBe(true);
      }
    });

    it('clears previous default when creating new default', async () => {
      const first = await service.create({ name: 'First Default', isDefault: true });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = await service.create({ name: 'Second Default', isDefault: true });
      expect(second.ok).toBe(true);

      // Verify only the second is now default
      const firstResult = await service.getById(first.value.id);
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok) {
        expect(firstResult.value.isDefault).toBe(false);
      }

      const defaultResult = await service.getDefault();
      expect(defaultResult.ok).toBe(true);
      if (defaultResult.ok) {
        expect(defaultResult.value?.name).toBe('Second Default');
      }
    });

    it('clears previous default when updating to default', async () => {
      const first = await service.create({ name: 'First', isDefault: true });
      expect(first.ok).toBe(true);
      if (!first.ok) return;

      const second = await service.create({ name: 'Second', isDefault: false });
      expect(second.ok).toBe(true);
      if (!second.ok) return;

      await service.update(second.value.id, { isDefault: true });

      // Verify first is no longer default
      const firstResult = await service.getById(first.value.id);
      expect(firstResult.ok).toBe(true);
      if (firstResult.ok) {
        expect(firstResult.value.isDefault).toBe(false);
      }

      // Verify second is now default
      const secondResult = await service.getById(second.value.id);
      expect(secondResult.ok).toBe(true);
      if (secondResult.ok) {
        expect(secondResult.value.isDefault).toBe(true);
      }
    });

    it('lists default configuration first', async () => {
      await service.create({ name: 'Non-Default 1', isDefault: false });
      await service.create({ name: 'Default Config', isDefault: true });
      await service.create({ name: 'Non-Default 2', isDefault: false });

      const result = await service.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(3);
        expect(result.value.items[0].name).toBe('Default Config');
        expect(result.value.items[0].isDefault).toBe(true);
      }
    });
  });
});
