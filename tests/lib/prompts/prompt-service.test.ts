import { describe, expect, it, vi } from 'vitest';
import { PROMPT_REGISTRY } from '@/lib/prompts/prompt-registry';
import { resolvePromptServer } from '@/lib/prompts/prompt-service';

/**
 * Minimal mock for SettingsService — only `getValue` is used by resolvePromptServer.
 */
function createMockSettingsService(overrides: Record<string, string> = {}) {
  return {
    getValue: vi.fn(async <T>(key: string, defaultValue: T): Promise<T> => {
      if (key in overrides) {
        return overrides[key] as unknown as T;
      }
      return defaultValue;
    }),
  };
}

describe('resolvePromptServer', () => {
  describe('default resolution', () => {
    it('returns default text when no override exists', async () => {
      const settings = createMockSettingsService();
      const result = await resolvePromptServer('plan-mode-default', settings as any);

      expect(result).toBe(PROMPT_REGISTRY['plan-mode-default'].defaultText);
    });

    it('calls settings.getValue with the correct settings key', async () => {
      const settings = createMockSettingsService();
      await resolvePromptServer('task-creation', settings as any);

      expect(settings.getValue).toHaveBeenCalledWith('prompt.task-creation', '');
    });

    it('returns default text for every registered prompt when no overrides exist', async () => {
      const settings = createMockSettingsService();

      for (const [id, def] of Object.entries(PROMPT_REGISTRY)) {
        const result = await resolvePromptServer(id, settings as any);
        // For prompts with no variables, result should match default exactly
        if (def.dynamicVariables.length === 0) {
          expect(result).toBe(def.defaultText);
        }
      }
    });
  });

  describe('overrides', () => {
    it('uses override text when a non-empty override exists', async () => {
      const customPrompt = 'My custom planning prompt.';
      const settings = createMockSettingsService({
        'prompt.plan-mode-default': customPrompt,
      });

      const result = await resolvePromptServer('plan-mode-default', settings as any);
      expect(result).toBe(customPrompt);
    });

    it('ignores empty string overrides and falls back to default', async () => {
      const settings = createMockSettingsService({
        'prompt.plan-mode-default': '',
      });

      const result = await resolvePromptServer('plan-mode-default', settings as any);
      expect(result).toBe(PROMPT_REGISTRY['plan-mode-default'].defaultText);
    });

    it('ignores whitespace-only overrides and falls back to default', async () => {
      const settings = createMockSettingsService({
        'prompt.plan-mode-default': '   \n\t  ',
      });

      const result = await resolvePromptServer('plan-mode-default', settings as any);
      expect(result).toBe(PROMPT_REGISTRY['plan-mode-default'].defaultText);
    });
  });

  describe('variable substitution', () => {
    it('substitutes {{moduleContext}} in terraform-compose prompt', async () => {
      const settings = createMockSettingsService();
      const variables = { moduleContext: 'module "vpc" { source = "..." }' };

      const result = await resolvePromptServer('terraform-compose', settings as any, variables);

      expect(result).toContain('module "vpc" { source = "..." }');
      expect(result).not.toContain('{{moduleContext}}');
    });

    it('substitutes multiple variables in workflow-analysis prompt', async () => {
      const settings = createMockSettingsService();
      const variables = {
        templateName: 'My Template',
        templateDescription: 'A test template',
        templateData: 'step 1\nstep 2',
        availableSkills: '/commit, /review-pr',
        availableAgents: 'opus-agent',
        knownSkills: '/speckit.specify',
      };

      const result = await resolvePromptServer('workflow-analysis', settings as any, variables);

      expect(result).toContain('My Template');
      expect(result).toContain('A test template');
      expect(result).toContain('step 1\nstep 2');
      expect(result).toContain('/commit, /review-pr');
      expect(result).not.toContain('{{templateName}}');
      expect(result).not.toContain('{{templateData}}');
    });

    it('applies variable substitution to overridden text as well', async () => {
      const settings = createMockSettingsService({
        'prompt.terraform-compose': 'Use modules: {{moduleContext}}. Done.',
      });
      const variables = { moduleContext: 'my-module v2.0' };

      const result = await resolvePromptServer('terraform-compose', settings as any, variables);

      expect(result).toBe('Use modules: my-module v2.0. Done.');
    });

    it('leaves unreplaced placeholders when variables are not provided', async () => {
      const settings = createMockSettingsService();
      const result = await resolvePromptServer('terraform-compose', settings as any);

      expect(result).toContain('{{moduleContext}}');
    });

    it('handles empty variables object without error', async () => {
      const settings = createMockSettingsService();
      const result = await resolvePromptServer('plan-mode-default', settings as any, {});

      expect(result).toBe(PROMPT_REGISTRY['plan-mode-default'].defaultText);
    });

    it('replaces all occurrences of the same variable', async () => {
      const settings = createMockSettingsService({
        'prompt.plan-mode-default': '{{name}} builds {{name}} for {{name}}',
      });
      const variables = { name: 'Claude' };

      const result = await resolvePromptServer('plan-mode-default', settings as any, variables);
      expect(result).toBe('Claude builds Claude for Claude');
    });
  });

  describe('error handling', () => {
    it('throws for an unknown prompt ID', async () => {
      const settings = createMockSettingsService();

      await expect(resolvePromptServer('does-not-exist', settings as any)).rejects.toThrow(
        'Unknown prompt ID: does-not-exist'
      );
    });

    it('throws for empty string prompt ID', async () => {
      const settings = createMockSettingsService();

      await expect(resolvePromptServer('', settings as any)).rejects.toThrow('Unknown prompt ID: ');
    });
  });
});
