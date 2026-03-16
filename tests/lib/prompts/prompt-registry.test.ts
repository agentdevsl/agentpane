import { describe, expect, it } from 'vitest';
import {
  getPromptDefaultText,
  getPromptSettingsKeys,
  getPromptsByCategory,
  PROMPT_CATEGORIES,
  PROMPT_REGISTRY,
} from '@/lib/prompts/prompt-registry';

describe('Prompt Registry', () => {
  describe('PROMPT_REGISTRY structure', () => {
    it('has at least one registered prompt', () => {
      expect(Object.keys(PROMPT_REGISTRY).length).toBeGreaterThan(0);
    });

    it('every prompt has a valid definition with required fields', () => {
      for (const [key, def] of Object.entries(PROMPT_REGISTRY)) {
        expect(def.id).toBe(key);
        expect(def.id).toBeTruthy();
        expect(def.category).toBeTruthy();
        expect(def.name).toBeTruthy();
        expect(def.description).toBeTruthy();
        expect(def.defaultText.length).toBeGreaterThan(0);
        expect(def.settingsKey).toMatch(/^prompt\./);
        expect(Array.isArray(def.dynamicVariables)).toBe(true);
        expect(typeof def.wordCount).toBe('number');
        expect(def.wordCount).toBeGreaterThan(0);
      }
    });

    it('every prompt category references a valid PROMPT_CATEGORIES entry', () => {
      const validCategoryIds = PROMPT_CATEGORIES.map((c) => c.id);
      for (const def of Object.values(PROMPT_REGISTRY)) {
        expect(validCategoryIds).toContain(def.category);
      }
    });

    it('every prompt settingsKey is unique', () => {
      const keys = Object.values(PROMPT_REGISTRY).map((p) => p.settingsKey);
      const unique = new Set(keys);
      expect(unique.size).toBe(keys.length);
    });

    it('wordCount matches actual word count of defaultText', () => {
      const countWords = (text: string) => text.split(/\s+/).filter((w) => w.length > 0).length;

      for (const def of Object.values(PROMPT_REGISTRY)) {
        expect(def.wordCount).toBe(countWords(def.defaultText));
      }
    });
  });

  describe('PROMPT_CATEGORIES', () => {
    it('contains the expected categories', () => {
      const ids = PROMPT_CATEGORIES.map((c) => c.id);
      expect(ids).toContain('agent-execution');
      expect(ids).toContain('task-creation');
      expect(ids).toContain('terraform-compose');
      expect(ids).toContain('workflow-designer');
    });

    it('each category has required fields', () => {
      for (const cat of PROMPT_CATEGORIES) {
        expect(cat.id).toBeTruthy();
        expect(cat.label).toBeTruthy();
        expect(cat.description).toBeTruthy();
        expect(['claude', 'accent', 'success', 'attention']).toContain(cat.color);
      }
    });
  });

  describe('getPromptsByCategory', () => {
    it('returns a Map keyed by all known categories', () => {
      const grouped = getPromptsByCategory();
      expect(grouped).toBeInstanceOf(Map);

      for (const cat of PROMPT_CATEGORIES) {
        expect(grouped.has(cat.id)).toBe(true);
      }
    });

    it('every registered prompt appears in exactly one category', () => {
      const grouped = getPromptsByCategory();
      const allGrouped: string[] = [];

      for (const prompts of grouped.values()) {
        for (const p of prompts) {
          allGrouped.push(p.id);
        }
      }

      const registeredIds = Object.keys(PROMPT_REGISTRY);
      expect(allGrouped.sort()).toEqual(registeredIds.sort());
    });

    it('groups terraform prompts under terraform-compose category', () => {
      const grouped = getPromptsByCategory();
      const terraformPrompts = grouped.get('terraform-compose') ?? [];
      const ids = terraformPrompts.map((p) => p.id);
      expect(ids).toContain('terraform-compose');
      expect(ids).toContain('terraform-compose-stacks');
    });

    it('groups workflow prompts under workflow-designer category', () => {
      const grouped = getPromptsByCategory();
      const workflowPrompts = grouped.get('workflow-designer') ?? [];
      const ids = workflowPrompts.map((p) => p.id);
      expect(ids).toContain('workflow-generation-system');
      expect(ids).toContain('workflow-analysis');
      expect(ids).toContain('workflow-validation');
      expect(ids).toContain('workflow-from-description');
    });
  });

  describe('getPromptSettingsKeys', () => {
    it('returns an array of strings', () => {
      const keys = getPromptSettingsKeys();
      expect(Array.isArray(keys)).toBe(true);
      expect(keys.length).toBe(Object.keys(PROMPT_REGISTRY).length);
    });

    it('every key starts with "prompt."', () => {
      const keys = getPromptSettingsKeys();
      for (const key of keys) {
        expect(key).toMatch(/^prompt\./);
      }
    });

    it('contains expected keys', () => {
      const keys = getPromptSettingsKeys();
      expect(keys).toContain('prompt.plan-mode-default');
      expect(keys).toContain('prompt.task-creation');
      expect(keys).toContain('prompt.terraform-compose');
    });
  });

  describe('getPromptDefaultText', () => {
    it('returns default text for a known prompt ID', () => {
      const text = getPromptDefaultText('plan-mode-default');
      expect(typeof text).toBe('string');
      expect(text.length).toBeGreaterThan(0);
      expect(text).toContain('plan');
    });

    it('returns the matching default text from PROMPT_REGISTRY', () => {
      for (const [id, def] of Object.entries(PROMPT_REGISTRY)) {
        expect(getPromptDefaultText(id)).toBe(def.defaultText);
      }
    });

    it('throws for an unknown prompt ID', () => {
      expect(() => getPromptDefaultText('nonexistent-prompt')).toThrow(
        'Unknown prompt ID: nonexistent-prompt'
      );
    });

    it('throws for empty string ID', () => {
      expect(() => getPromptDefaultText('')).toThrow('Unknown prompt ID: ');
    });
  });

  describe('Dynamic variables', () => {
    it('terraform-compose prompt declares moduleContext variable', () => {
      const def = PROMPT_REGISTRY['terraform-compose'];
      expect(def.dynamicVariables).toContain('moduleContext');
    });

    it('workflow-analysis prompt declares multiple variables', () => {
      const def = PROMPT_REGISTRY['workflow-analysis'];
      expect(def.dynamicVariables).toContain('templateName');
      expect(def.dynamicVariables).toContain('templateData');
      expect(def.dynamicVariables).toContain('availableSkills');
    });

    it('plan-mode-default prompt has no dynamic variables', () => {
      const def = PROMPT_REGISTRY['plan-mode-default'];
      expect(def.dynamicVariables).toEqual([]);
    });

    it('declared dynamic variables have matching {{placeholders}} in defaultText', () => {
      for (const def of Object.values(PROMPT_REGISTRY)) {
        for (const variable of def.dynamicVariables) {
          expect(def.defaultText).toContain(`{{${variable}}}`);
        }
      }
    });
  });
});
