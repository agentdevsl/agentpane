import { createId } from '@paralleldrive/cuid2';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { err, ok } from '../../src/lib/utils/result';
import { flushPromises } from '../helpers/async';
import { clearTestDatabase, execRawSql, getTestDb, setupTestDatabase } from '../helpers/database';

// ============================================================================
// Mock Setup
// ============================================================================

// Mock encryption module - must be before service imports
vi.mock('../../src/lib/crypto/server-encryption', () => ({
  encryptToken: vi.fn((token: string) => `encrypted:${token}`),
  decryptToken: vi.fn((encrypted: string) => encrypted.replace('encrypted:', '')),
  maskToken: vi.fn((token: string) => `${token.slice(0, 4)}••••${token.slice(-4)}`),
  isValidPATFormat: vi.fn(
    (token: string) => token.startsWith('ghp_') || token.startsWith('github_pat_')
  ),
}));

// Mock Octokit as a class
vi.mock('octokit', () => {
  class MockOctokit {
    rest = {
      users: {
        getAuthenticated: vi.fn().mockResolvedValue({
          data: {
            login: 'testuser',
            id: 12345,
            avatar_url: 'https://github.com/avatar.png',
            name: 'Test User',
          },
        }),
      },
      repos: {
        get: vi.fn().mockResolvedValue({
          data: {
            id: 1,
            name: 'test-repo',
            full_name: 'testuser/test-repo',
            private: false,
            owner: { login: 'testuser', avatar_url: 'https://github.com/avatar.png' },
            default_branch: 'main',
            description: 'Test repo',
            clone_url: 'https://github.com/testuser/test-repo.git',
            updated_at: '2025-01-01T00:00:00Z',
            stargazers_count: 10,
            is_template: false,
          },
        }),
        listBranches: vi.fn().mockResolvedValue({
          data: [
            { name: 'main', protected: true },
            { name: 'develop', protected: false },
          ],
        }),
        listForAuthenticatedUser: vi.fn().mockResolvedValue({ data: [] }),
        listForOrg: vi.fn().mockResolvedValue({ data: [] }),
      },
      orgs: {
        listForAuthenticatedUser: vi.fn().mockResolvedValue({ data: [] }),
      },
    };
  }
  return { Octokit: MockOctokit };
});

import * as schema from '../../src/db/schema';
import { ApiKeyService } from '../../src/services/api-key.service';
import { DurableStreamsService } from '../../src/services/durable-streams.service';
import { GitHubTokenService } from '../../src/services/github-token.service';
import { SandboxConfigService } from '../../src/services/sandbox-config.service';
import {
  calculateNextSyncAt,
  TemplateSyncScheduler,
} from '../../src/services/template-sync-scheduler';

// ============================================================================
// Test Helpers
// ============================================================================

function createMockDurableStreamsServer() {
  return {
    createStream: vi.fn().mockResolvedValue(undefined),
    publish: vi.fn().mockResolvedValue(1), // Returns offset
    subscribe: vi.fn().mockImplementation(async function* () {
      yield { type: 'test', data: {} };
    }),
  };
}

// SandboxService tests removed — sandbox.service.ts was deleted

// ============================================================================
// SandboxConfigService Tests (~20 tests)
// ============================================================================

describe('SandboxConfigService', () => {
  let configService: SandboxConfigService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    configService = new SandboxConfigService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  // ---------------------------------------------------------------------------
  // Create Configuration (6 tests)
  // ---------------------------------------------------------------------------

  describe('Create Configuration', () => {
    it('creates a sandbox configuration with defaults', async () => {
      const result = await configService.create({
        name: 'Default Config',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Default Config');
        expect(result.value.type).toBe('docker');
        expect(result.value.baseImage).toBe('node:22-slim');
        expect(result.value.memoryMb).toBe(4096);
        expect(result.value.cpuCores).toBe(2.0);
        expect(result.value.maxProcesses).toBe(256);
        expect(result.value.timeoutMinutes).toBe(60);
      }
    });

    it('creates a sandbox configuration with custom values', async () => {
      const result = await configService.create({
        name: 'High Performance',
        description: 'For intensive workloads',
        type: 'devcontainer',
        memoryMb: 8192,
        cpuCores: 4,
        maxProcesses: 512,
        timeoutMinutes: 120,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('High Performance');
        expect(result.value.description).toBe('For intensive workloads');
        expect(result.value.type).toBe('devcontainer');
        expect(result.value.memoryMb).toBe(8192);
        expect(result.value.cpuCores).toBe(4);
        expect(result.value.maxProcesses).toBe(512);
        expect(result.value.timeoutMinutes).toBe(120);
      }
    });

    it('creates default configuration and clears existing default', async () => {
      // Create first default
      await configService.create({
        name: 'First Default',
        isDefault: true,
      });

      // Create second default
      const result = await configService.create({
        name: 'Second Default',
        isDefault: true,
      });

      expect(result.ok).toBe(true);

      // Verify first is no longer default
      const allConfigs = await configService.list();
      if (allConfigs.ok) {
        const first = allConfigs.value.items.find((c) => c.name === 'First Default');
        const second = allConfigs.value.items.find((c) => c.name === 'Second Default');
        expect(first?.isDefault).toBe(false);
        expect(second?.isDefault).toBe(true);
      }
    });

    it('rejects duplicate configuration names', async () => {
      await configService.create({ name: 'Unique Name' });

      const result = await configService.create({ name: 'Unique Name' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_ALREADY_EXISTS');
      }
    });

    it('validates memory limits', async () => {
      const tooLow = await configService.create({
        name: 'Too Low Memory',
        memoryMb: 256, // Min is 512
      });

      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }

      const tooHigh = await configService.create({
        name: 'Too High Memory',
        memoryMb: 65536, // Max is 32768
      });

      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_MEMORY');
      }
    });

    it('validates CPU limits', async () => {
      const tooLow = await configService.create({
        name: 'Too Low CPU',
        cpuCores: 0.25, // Min is 0.5
      });

      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }

      const tooHigh = await configService.create({
        name: 'Too High CPU',
        cpuCores: 32, // Max is 16
      });

      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_CPU');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Get Configuration (3 tests)
  // ---------------------------------------------------------------------------

  describe('Get Configuration', () => {
    it('gets configuration by ID', async () => {
      const created = await configService.create({ name: 'Test Config' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await configService.getById(created.value.id);

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Test Config');
      }
    });

    it('returns error for non-existent configuration', async () => {
      const result = await configService.getById('non-existent-id');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });

    it('gets default configuration', async () => {
      await configService.create({ name: 'Default', isDefault: true });

      const result = await configService.getDefault();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value?.name).toBe('Default');
        expect(result.value?.isDefault).toBe(true);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // List Configurations (2 tests)
  // ---------------------------------------------------------------------------

  describe('List Configurations', () => {
    it('lists all configurations', async () => {
      await configService.create({ name: 'Config A' });
      await configService.create({ name: 'Config B' });
      await configService.create({ name: 'Config C' });

      const result = await configService.list();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.items.length).toBe(3);
      }
    });

    it('supports pagination', async () => {
      for (let i = 0; i < 5; i++) {
        await configService.create({ name: `Config ${i}` });
      }

      const page1 = await configService.list({ limit: 2, offset: 0 });
      const page2 = await configService.list({ limit: 2, offset: 2 });

      expect(page1.ok).toBe(true);
      expect(page2.ok).toBe(true);
      if (page1.ok && page2.ok) {
        expect(page1.value.items.length).toBe(2);
        expect(page2.value.items.length).toBe(2);
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Update Configuration (5 tests)
  // ---------------------------------------------------------------------------

  describe('Update Configuration', () => {
    it('updates configuration name', async () => {
      const created = await configService.create({ name: 'Original Name' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await configService.update(created.value.id, {
        name: 'Updated Name',
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.name).toBe('Updated Name');
      }
    });

    it('updates configuration resources', async () => {
      const created = await configService.create({ name: 'Resource Config' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await configService.update(created.value.id, {
        memoryMb: 8192,
        cpuCores: 8,
        maxProcesses: 1024,
        timeoutMinutes: 240,
      });

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.memoryMb).toBe(8192);
        expect(result.value.cpuCores).toBe(8);
        expect(result.value.maxProcesses).toBe(1024);
        expect(result.value.timeoutMinutes).toBe(240);
      }
    });

    it('rejects update with duplicate name', async () => {
      await configService.create({ name: 'Existing Name' });
      const created = await configService.create({ name: 'Original' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await configService.update(created.value.id, {
        name: 'Existing Name',
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_ALREADY_EXISTS');
      }
    });

    it('updates default status and clears other defaults', async () => {
      const first = await configService.create({ name: 'First', isDefault: true });
      const second = await configService.create({ name: 'Second' });
      expect(first.ok && second.ok).toBe(true);
      if (!first.ok || !second.ok) return;

      await configService.update(second.value.id, { isDefault: true });

      const firstUpdated = await configService.getById(first.value.id);
      const secondUpdated = await configService.getById(second.value.id);

      if (firstUpdated.ok && secondUpdated.ok) {
        expect(firstUpdated.value.isDefault).toBe(false);
        expect(secondUpdated.value.isDefault).toBe(true);
      }
    });

    it('returns error for non-existent configuration', async () => {
      const result = await configService.update('non-existent', { name: 'New Name' });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });
  });

  // ---------------------------------------------------------------------------
  // Delete Configuration (4 tests)
  // ---------------------------------------------------------------------------

  describe('Delete Configuration', () => {
    it('deletes unused configuration', async () => {
      const created = await configService.create({ name: 'To Delete' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      const result = await configService.delete(created.value.id);

      expect(result.ok).toBe(true);

      const found = await configService.getById(created.value.id);
      expect(found.ok).toBe(false);
    });

    it('returns error for non-existent configuration', async () => {
      const result = await configService.delete('non-existent');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_NOT_FOUND');
      }
    });

    it('prevents deletion when configuration is in use', async () => {
      const created = await configService.create({ name: 'In Use Config' });
      expect(created.ok).toBe(true);
      if (!created.ok) return;

      // Create a project using this config
      const db = getTestDb();
      await db.insert(schema.codespaces).values({
        id: createId(),
        projectFolderId: 'default-folder',
        name: 'Test Project',
        path: `/tmp/test-sandbox-config-${createId()}`,
        config: {},
        sandboxConfigId: created.value.id,
      });

      const result = await configService.delete(created.value.id);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('SANDBOX_CONFIG_IN_USE');
      }
    });

    it('validates process limits', async () => {
      const tooLow = await configService.create({
        name: 'Too Few Processes',
        maxProcesses: 16, // Min is 32
      });

      expect(tooLow.ok).toBe(false);
      if (!tooLow.ok) {
        expect(tooLow.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }

      const tooHigh = await configService.create({
        name: 'Too Many Processes',
        maxProcesses: 8192, // Max is 4096
      });

      expect(tooHigh.ok).toBe(false);
      if (!tooHigh.ok) {
        expect(tooHigh.error.code).toBe('SANDBOX_CONFIG_INVALID_PROCESSES');
      }
    });
  });
});

// ============================================================================
// ApiKeyService Tests (~10 tests)
// ============================================================================

describe('ApiKeyService', () => {
  let apiKeyService: ApiKeyService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    apiKeyService = new ApiKeyService(db);
  });

  afterEach(async () => {
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  describe('Save Key', () => {
    it('saves a valid Anthropic API key', async () => {
      const result = await apiKeyService.saveKey('anthropic', 'sk-ant-api123456789abcdef');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.service).toBe('anthropic');
        expect(result.value.isValid).toBe(true);
        expect(result.value.maskedKey).toContain('sk-a');
      }
    });

    it('rejects empty API key', async () => {
      const result = await apiKeyService.saveKey('anthropic', '');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
      }
    });

    it('rejects Anthropic key with invalid format', async () => {
      const result = await apiKeyService.saveKey('anthropic', 'invalid-key-format');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
        expect(result.error.message).toContain('sk-ant-');
      }
    });

    it('replaces existing key for same service', async () => {
      await apiKeyService.saveKey('anthropic', 'sk-ant-first-key-12345');
      const result = await apiKeyService.saveKey('anthropic', 'sk-ant-second-key-67890');

      expect(result.ok).toBe(true);

      // Verify we can retrieve a decrypted key (and it's the second one)
      const decrypted = await apiKeyService.getDecryptedKey('anthropic');
      expect(decrypted).toBe('sk-ant-second-key-67890');
    });
  });

  describe('Get Key Info', () => {
    it('returns key info without decrypted value', async () => {
      await apiKeyService.saveKey('anthropic', 'sk-ant-test-key-abcdef12');

      const result = await apiKeyService.getKeyInfo('anthropic');

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.service).toBe('anthropic');
        expect(result.value.maskedKey).toBeDefined();
        // Should not expose actual key
        expect(result.value.maskedKey).not.toBe('sk-ant-test-key-abcdef12');
      }
    });

    it('returns null for non-existent service', async () => {
      const result = await apiKeyService.getKeyInfo('non-existent');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('Get Decrypted Key', () => {
    it('returns decrypted key for existing service', async () => {
      await apiKeyService.saveKey('anthropic', 'sk-ant-secret-key-xyz');

      const key = await apiKeyService.getDecryptedKey('anthropic');

      expect(key).toBe('sk-ant-secret-key-xyz');
    });

    it('returns null for non-existent service', async () => {
      const key = await apiKeyService.getDecryptedKey('non-existent');

      expect(key).toBeNull();
    });
  });

  describe('Delete Key', () => {
    it('deletes an existing key', async () => {
      await apiKeyService.saveKey('anthropic', 'sk-ant-to-delete-123');

      const result = await apiKeyService.deleteKey('anthropic');

      expect(result.ok).toBe(true);

      const info = await apiKeyService.getKeyInfo('anthropic');
      if (info.ok) {
        expect(info.value).toBeNull();
      }
    });
  });

  describe('Mark Invalid', () => {
    it('marks a key as invalid', async () => {
      await apiKeyService.saveKey('anthropic', 'sk-ant-valid-key-abc');

      await apiKeyService.markInvalid('anthropic');

      const info = await apiKeyService.getKeyInfo('anthropic');
      if (info.ok && info.value) {
        expect(info.value.isValid).toBe(false);
      }
    });
  });
});

// ============================================================================
// GitHubTokenService Tests (~10 tests)
// ============================================================================

describe('GitHubTokenService', () => {
  let tokenService: GitHubTokenService;

  beforeEach(async () => {
    await setupTestDatabase();
    // Clear github_tokens table before each test
    execRawSql('DELETE FROM github_tokens');
    const db = getTestDb();
    tokenService = new GitHubTokenService(db);
  });

  afterEach(async () => {
    // Clear github_tokens table after each test
    try {
      execRawSql('DELETE FROM github_tokens');
    } catch {
      // Ignore if table doesn't exist
    }
    await clearTestDatabase();
    vi.clearAllMocks();
  });

  describe('Save Token', () => {
    it('saves a valid GitHub PAT (ghp_ format)', async () => {
      // The mock for isValidPATFormat will return true for ghp_ prefix
      const result = await tokenService.saveToken('ghp_testtoken1234567890abcdef');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.githubLogin).toBe('testuser');
        expect(result.value.isValid).toBe(true);
      }
    });

    it('saves a valid fine-grained PAT (github_pat_ format)', async () => {
      const result = await tokenService.saveToken('github_pat_testtoken1234567890');

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value.isValid).toBe(true);
      }
    });

    it('rejects invalid token format', async () => {
      const result = await tokenService.saveToken('invalid-token-format');

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('INVALID_FORMAT');
      }
    });
  });

  describe('Get Token Info', () => {
    it('returns token info for saved token', async () => {
      // First save a token
      const saveResult = await tokenService.saveToken('ghp_savedtoken123456789abc');
      expect(saveResult.ok).toBe(true);

      const result = await tokenService.getTokenInfo();

      expect(result.ok).toBe(true);
      if (result.ok && result.value) {
        expect(result.value.githubLogin).toBe('testuser');
        expect(result.value.maskedToken).toBeDefined();
      }
    });

    it('returns null when no token saved', async () => {
      const result = await tokenService.getTokenInfo();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBeNull();
      }
    });
  });

  describe('Get Decrypted Token', () => {
    it('returns decrypted token', async () => {
      // First save a token
      const saveResult = await tokenService.saveToken('ghp_decryptme123456789');
      expect(saveResult.ok).toBe(true);

      const token = await tokenService.getDecryptedToken();

      expect(token).toBe('ghp_decryptme123456789');
    });

    it('returns null when no token saved', async () => {
      const token = await tokenService.getDecryptedToken();

      expect(token).toBeNull();
    });
  });

  describe('Delete Token', () => {
    it('deletes the saved token', async () => {
      // First save a token
      const saveResult = await tokenService.saveToken('ghp_todelete123456789');
      expect(saveResult.ok).toBe(true);

      const result = await tokenService.deleteToken();

      expect(result.ok).toBe(true);

      const info = await tokenService.getTokenInfo();
      if (info.ok) {
        expect(info.value).toBeNull();
      }
    });
  });

  describe('Revalidate Token', () => {
    it('revalidates existing token', async () => {
      // First save a token
      const saveResult = await tokenService.saveToken('ghp_revalidate12345678');
      expect(saveResult.ok).toBe(true);

      const result = await tokenService.revalidateToken();

      expect(result.ok).toBe(true);
      if (result.ok) {
        expect(result.value).toBe(true);
      }
    });

    it('returns error when no token saved', async () => {
      const result = await tokenService.revalidateToken();

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('NOT_FOUND');
      }
    });
  });

  describe('Get Octokit', () => {
    it('returns Octokit instance when token exists', async () => {
      // First save a token
      const saveResult = await tokenService.saveToken('ghp_octokit123456789');
      expect(saveResult.ok).toBe(true);

      const octokit = await tokenService.getOctokit();

      expect(octokit).not.toBeNull();
    });

    it('returns null when no token exists', async () => {
      const octokit = await tokenService.getOctokit();

      expect(octokit).toBeNull();
    });
  });
});

// ============================================================================
// DurableStreamsService Tests (~10 tests)
// ============================================================================

describe('DurableStreamsService', () => {
  let streamsService: DurableStreamsService;
  let mockServer: ReturnType<typeof createMockDurableStreamsServer>;

  beforeEach(() => {
    mockServer = createMockDurableStreamsServer();
    streamsService = new DurableStreamsService(mockServer);
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  describe('Stream Management', () => {
    it('creates a new stream', async () => {
      await streamsService.createStream('stream-1', { type: 'test' });

      expect(mockServer.createStream).toHaveBeenCalledWith('stream-1', { type: 'test' });
    });

    it('publishes events to stream', async () => {
      await streamsService.createStream('stream-1', {});
      await streamsService.publish('stream-1', 'plan:started', { sessionId: 'session-1' });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'stream-1',
        'plan:started',
        expect.objectContaining({ sessionId: 'session-1' })
      );
    });
  });

  describe('Plan Mode Events', () => {
    it('publishes plan started event', async () => {
      await streamsService.createStream('stream-1', {});
      await streamsService.publishPlanStarted('stream-1', {
        sessionId: 'session-1',
        taskId: 'task-1',
        codespaceId: 'project-1',
      });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'stream-1',
        'plan:started',
        expect.objectContaining({ sessionId: 'session-1' })
      );
    });

    it('publishes plan completed event', async () => {
      await streamsService.createStream('stream-1', {});
      await streamsService.publishPlanCompleted('stream-1', {
        sessionId: 'session-1',
        issueUrl: 'https://github.com/test/issue/1',
        issueNumber: 1,
      });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'stream-1',
        'plan:completed',
        expect.objectContaining({ issueUrl: 'https://github.com/test/issue/1' })
      );
    });
  });

  describe('Sandbox Events', () => {
    it('publishes sandbox creating event', async () => {
      await streamsService.createStream('sandbox-1', {});
      await streamsService.publish('sandbox-1', 'sandbox:creating', {
        sandboxId: 'sandbox-1',
        codespaceId: 'project-1',
        image: 'node:22-slim',
      });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'sandbox-1',
        'sandbox:creating',
        expect.objectContaining({ image: 'node:22-slim' })
      );
    });

    it('publishes sandbox ready event', async () => {
      await streamsService.createStream('sandbox-1', {});
      await streamsService.publish('sandbox-1', 'sandbox:ready', {
        sandboxId: 'sandbox-1',
        codespaceId: 'project-1',
        containerId: 'container-123',
      });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'sandbox-1',
        'sandbox:ready',
        expect.objectContaining({ containerId: 'container-123' })
      );
    });

    it('publishes sandbox error event', async () => {
      await streamsService.createStream('sandbox-1', {});
      await streamsService.publish('sandbox-1', 'sandbox:error', {
        sandboxId: 'sandbox-1',
        codespaceId: 'project-1',
        error: 'Container failed to start',
        code: 'CONTAINER_START_FAILED',
      });

      expect(mockServer.publish).toHaveBeenCalledWith(
        'sandbox-1',
        'sandbox:error',
        expect.objectContaining({ error: 'Container failed to start' })
      );
    });
  });
});

// ============================================================================
// TemplateSyncScheduler Tests (~15 tests)
// ============================================================================

describe('TemplateSyncScheduler', () => {
  let scheduler: TemplateSyncScheduler;

  beforeEach(async () => {
    await setupTestDatabase();
  });

  afterEach(async () => {
    scheduler?.stop();
    await clearTestDatabase();
  });

  describe('Utility Functions', () => {
    it('calculates next sync time correctly', () => {
      const before = new Date();
      const result = calculateNextSyncAt(15);
      const after = new Date();

      const nextSync = new Date(result);
      const expectedMin = new Date(before.getTime() + 15 * 60 * 1000);
      const expectedMax = new Date(after.getTime() + 15 * 60 * 1000);

      expect(nextSync.getTime()).toBeGreaterThanOrEqual(expectedMin.getTime() - 1000);
      expect(nextSync.getTime()).toBeLessThanOrEqual(expectedMax.getTime() + 1000);
    });
  });

  describe('Scheduler State', () => {
    it('returns initial state when not running', () => {
      const db = getTestDb();
      const mockTemplateService = { sync: vi.fn() };
      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);

      const state = scheduler.getState();
      expect(state.isRunning).toBe(false);
      expect(state.syncInProgressCount).toBe(0);
    });

    it('starts scheduler and updates state', () => {
      const db = getTestDb();
      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      const cleanup = scheduler.start();

      const state = scheduler.getState();
      expect(state.isRunning).toBe(true);

      cleanup();
    });

    it('stops scheduler and updates state', () => {
      const db = getTestDb();
      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();
      scheduler.stop();

      const state = scheduler.getState();
      expect(state.isRunning).toBe(false);
    });

    it('prevents starting scheduler twice', () => {
      const db = getTestDb();
      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();
      const cleanup2 = scheduler.start(); // Second call

      expect(typeof cleanup2).toBe('function');

      const state = scheduler.getState();
      expect(state.isRunning).toBe(true);

      cleanup2();
    });

    it('returns cleanup function from start', () => {
      const db = getTestDb();
      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      const cleanup = scheduler.start();

      expect(typeof cleanup).toBe('function');

      cleanup();
      expect(scheduler.getState().isRunning).toBe(false);
    });
  });

  describe('Template Sync', () => {
    it('syncs templates due for sync on startup', async () => {
      const db = getTestDb();

      const pastDate = new Date(Date.now() - 60000).toISOString();
      await db.insert(schema.templates).values({
        id: createId(),
        name: 'Test Template',
        scope: 'org',
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        syncIntervalMinutes: 15,
        nextSyncAt: pastDate,
        status: 'active',
      });

      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 1, commandCount: 2, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();

      await flushPromises();
      scheduler.stop();

      expect(mockTemplateService.sync).toHaveBeenCalled();
    });

    it('skips templates with disabled sync', async () => {
      const db = getTestDb();

      await db.insert(schema.templates).values({
        id: createId(),
        name: 'No Sync Template',
        scope: 'org',
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        syncIntervalMinutes: null,
        nextSyncAt: null,
        status: 'active',
      });

      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();
      await flushPromises();
      scheduler.stop();

      expect(mockTemplateService.sync).not.toHaveBeenCalled();
    });

    it('skips templates not yet due for sync', async () => {
      const db = getTestDb();

      const futureDate = new Date(Date.now() + 3600000).toISOString();
      await db.insert(schema.templates).values({
        id: createId(),
        name: 'Future Template',
        scope: 'org',
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        syncIntervalMinutes: 60,
        nextSyncAt: futureDate,
        status: 'active',
      });

      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(ok({ skillCount: 0, commandCount: 0, agentCount: 0 })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();
      await flushPromises();
      scheduler.stop();

      expect(mockTemplateService.sync).not.toHaveBeenCalled();
    });

    it('handles sync errors gracefully', async () => {
      const db = getTestDb();

      const pastDate = new Date(Date.now() - 60000).toISOString();
      await db.insert(schema.templates).values({
        id: createId(),
        name: 'Error Template',
        scope: 'org',
        githubOwner: 'test-owner',
        githubRepo: 'test-repo',
        syncIntervalMinutes: 15,
        nextSyncAt: pastDate,
        status: 'active',
      });

      const mockTemplateService = {
        sync: vi.fn().mockResolvedValue(err({ code: 'SYNC_FAILED', message: 'Network error' })),
      };

      scheduler = new TemplateSyncScheduler(db, mockTemplateService as any);
      scheduler.start();
      await flushPromises();
      scheduler.stop();

      expect(mockTemplateService.sync).toHaveBeenCalled();
    });
  });
});
