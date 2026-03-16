/**
 * Tests for compose-prompt.ts
 *
 * Covers:
 * - buildCompositionSystemPrompt in terraform mode (default)
 * - buildCompositionSystemPrompt in stacks mode
 * - With and without settingsService
 * - Module context substitution
 * - Stacks reference substitution
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

// ── Mock prompt modules ──
// vi.mock factories are hoisted - must not reference outer const variables

const mockResolvePromptServer = vi.fn();
const mockGetPromptDefaultText = vi.fn();

vi.mock('../../../src/lib/prompts/index.js', () => ({
  resolvePromptServer: (...args: unknown[]) => mockResolvePromptServer(...args),
  getPromptDefaultText: (...args: unknown[]) => mockGetPromptDefaultText(...args),
}));

vi.mock('../../../src/lib/terraform/stacks-prompt.js', () => ({
  TERRAFORM_COMPOSE_STACKS_TEXT: 'Stacks prompt with {{moduleContext}} and {{stacksReference}}',
}));

import { buildCompositionSystemPrompt } from '../../../src/lib/terraform/compose-prompt';

// ── Mock Settings Service ──

function createMockSettingsService() {
  return {
    getValue: vi.fn(),
    setValue: vi.fn(),
    getAll: vi.fn(),
  };
}

// ── Tests ──

describe('buildCompositionSystemPrompt', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── Terraform mode (default) ──

  describe('terraform mode (default)', () => {
    it('uses resolvePromptServer when settingsService is provided', async () => {
      const settings = createMockSettingsService();
      mockResolvePromptServer.mockResolvedValue('resolved terraform prompt');

      const result = await buildCompositionSystemPrompt('module catalog here', settings as never);

      expect(mockResolvePromptServer).toHaveBeenCalledWith('terraform-compose', settings, {
        moduleContext: 'module catalog here',
      });
      expect(result).toBe('resolved terraform prompt');
    });

    it('falls back to getPromptDefaultText when no settingsService', async () => {
      mockGetPromptDefaultText.mockReturnValue(
        'Default terraform prompt with {{moduleContext}} modules'
      );

      const result = await buildCompositionSystemPrompt('my-modules');

      expect(mockGetPromptDefaultText).toHaveBeenCalledWith('terraform-compose');
      expect(result).toBe('Default terraform prompt with my-modules modules');
    });

    it('replaces multiple occurrences of {{moduleContext}}', async () => {
      mockGetPromptDefaultText.mockReturnValue('{{moduleContext}} ... also see {{moduleContext}}');

      const result = await buildCompositionSystemPrompt('CATALOG');

      expect(result).toBe('CATALOG ... also see CATALOG');
    });

    it('handles empty module context', async () => {
      mockGetPromptDefaultText.mockReturnValue('Modules: {{moduleContext}}');

      const result = await buildCompositionSystemPrompt('');

      expect(result).toBe('Modules: ');
    });

    it('defaults mode to terraform when not specified', async () => {
      mockGetPromptDefaultText.mockReturnValue('terraform prompt {{moduleContext}}');

      await buildCompositionSystemPrompt('ctx');

      expect(mockGetPromptDefaultText).toHaveBeenCalledWith('terraform-compose');
      expect(mockResolvePromptServer).not.toHaveBeenCalled();
    });
  });

  // ── Stacks mode ──

  describe('stacks mode', () => {
    it('uses resolvePromptServer with stacks prompt ID when settingsService provided', async () => {
      const settings = createMockSettingsService();
      mockResolvePromptServer.mockResolvedValue('resolved stacks prompt');

      const result = await buildCompositionSystemPrompt(
        'module data',
        settings as never,
        'stacks',
        'ref content'
      );

      expect(mockResolvePromptServer).toHaveBeenCalledWith('terraform-compose-stacks', settings, {
        moduleContext: 'module data',
        stacksReference: 'ref content',
      });
      expect(result).toBe('resolved stacks prompt');
    });

    it('falls back to TERRAFORM_COMPOSE_STACKS_TEXT when no settingsService', async () => {
      const result = await buildCompositionSystemPrompt('modules', undefined, 'stacks', 'my-ref');

      expect(result).toBe('Stacks prompt with modules and my-ref');
    });

    it('uses empty string for stacksReference when not provided', async () => {
      const result = await buildCompositionSystemPrompt('modules', undefined, 'stacks');

      expect(result).toBe('Stacks prompt with modules and ');
    });

    it('passes empty string stacksReference to resolvePromptServer when undefined', async () => {
      const settings = createMockSettingsService();
      mockResolvePromptServer.mockResolvedValue('resolved');

      await buildCompositionSystemPrompt('ctx', settings as never, 'stacks');

      expect(mockResolvePromptServer).toHaveBeenCalledWith('terraform-compose-stacks', settings, {
        moduleContext: 'ctx',
        stacksReference: '',
      });
    });

    it('replaces both module context and stacks reference in fallback', async () => {
      const result = await buildCompositionSystemPrompt('MODULE_A', undefined, 'stacks', 'REF_B');

      expect(result).toContain('MODULE_A');
      expect(result).toContain('REF_B');
      expect(result).not.toContain('{{moduleContext}}');
      expect(result).not.toContain('{{stacksReference}}');
    });
  });

  // ── Edge cases ──

  describe('edge cases', () => {
    it('returns string (not undefined) when settingsService resolves', async () => {
      const settings = createMockSettingsService();
      mockResolvePromptServer.mockResolvedValue('prompt text');

      const result = await buildCompositionSystemPrompt('ctx', settings as never, 'terraform');

      expect(typeof result).toBe('string');
      expect(result.length).toBeGreaterThan(0);
    });

    it('handles special regex characters in module context', async () => {
      mockGetPromptDefaultText.mockReturnValue('{{moduleContext}}');

      const result = await buildCompositionSystemPrompt('$1 (test) [bracket]');

      expect(result).toBe('$1 (test) [bracket]');
    });
  });
});
