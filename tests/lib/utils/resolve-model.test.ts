/**
 * @vitest-environment node
 */
import { describe, expect, it } from 'vitest';
import { AVAILABLE_MODELS, DEFAULT_AGENT_MODEL, getFullModelId } from '@/lib/constants/models';
import {
  getModelSource,
  isValidModelId,
  resolveModel,
  resolveModelShortId,
} from '@/lib/utils/resolve-model';

// =============================================================================
// resolveModel Tests
// =============================================================================

describe('resolveModel', () => {
  it('returns default model when all context fields are empty', () => {
    const result = resolveModel({});

    expect(result).toBe(getFullModelId(DEFAULT_AGENT_MODEL));
  });

  it('returns default model when all context fields are null', () => {
    const result = resolveModel({
      taskModelOverride: null,
      agentModel: null,
      projectModel: null,
      globalDefault: null,
    });

    expect(result).toBe(getFullModelId(DEFAULT_AGENT_MODEL));
  });

  it('uses taskModelOverride as highest priority', () => {
    const result = resolveModel({
      taskModelOverride: 'claude-haiku-4-5',
      agentModel: 'claude-sonnet-4-6',
      projectModel: 'claude-opus-4-5',
      globalDefault: 'claude-opus-4-6',
    });

    expect(result).toBe(getFullModelId('claude-haiku-4-5'));
  });

  it('uses agentModel when taskModelOverride is null', () => {
    const result = resolveModel({
      taskModelOverride: null,
      agentModel: 'claude-sonnet-4-6',
      projectModel: 'claude-opus-4-5',
      globalDefault: 'claude-opus-4-6',
    });

    expect(result).toBe(getFullModelId('claude-sonnet-4-6'));
  });

  it('uses projectModel when task and agent are null', () => {
    const result = resolveModel({
      taskModelOverride: null,
      agentModel: null,
      projectModel: 'claude-opus-4-5',
      globalDefault: 'claude-opus-4-6',
    });

    expect(result).toBe(getFullModelId('claude-opus-4-5'));
  });

  it('uses globalDefault when task, agent, and project are null', () => {
    const result = resolveModel({
      taskModelOverride: null,
      agentModel: null,
      projectModel: null,
      globalDefault: 'claude-haiku-4-5',
    });

    expect(result).toBe(getFullModelId('claude-haiku-4-5'));
  });

  it('converts short model ID to full API model ID', () => {
    const result = resolveModel({ taskModelOverride: 'claude-opus-4-5' });

    // claude-opus-4-5 has fullId claude-opus-4-5-20251101
    expect(result).toBe('claude-opus-4-5-20251101');
  });

  it('passes through unknown model IDs as-is', () => {
    const result = resolveModel({ taskModelOverride: 'custom-model-xyz' });

    expect(result).toBe('custom-model-xyz');
  });

  it('skips empty string values (treated as falsy)', () => {
    const result = resolveModel({
      taskModelOverride: '',
      agentModel: 'claude-sonnet-4-6',
    });

    expect(result).toBe(getFullModelId('claude-sonnet-4-6'));
  });
});

// =============================================================================
// resolveModelShortId Tests
// =============================================================================

describe('resolveModelShortId', () => {
  it('returns the short ID without conversion', () => {
    const result = resolveModelShortId({
      taskModelOverride: 'claude-opus-4-5',
    });

    expect(result).toBe('claude-opus-4-5');
  });

  it('returns default agent model when all context is empty', () => {
    const result = resolveModelShortId({});

    expect(result).toBe(DEFAULT_AGENT_MODEL);
  });

  it('follows the same cascade priority as resolveModel', () => {
    expect(
      resolveModelShortId({
        taskModelOverride: 'a',
        agentModel: 'b',
        projectModel: 'c',
        globalDefault: 'd',
      })
    ).toBe('a');

    expect(
      resolveModelShortId({
        taskModelOverride: null,
        agentModel: 'b',
      })
    ).toBe('b');

    expect(
      resolveModelShortId({
        taskModelOverride: null,
        agentModel: null,
        projectModel: 'c',
      })
    ).toBe('c');

    expect(
      resolveModelShortId({
        taskModelOverride: null,
        agentModel: null,
        projectModel: null,
        globalDefault: 'd',
      })
    ).toBe('d');
  });
});

// =============================================================================
// getModelSource Tests
// =============================================================================

describe('getModelSource', () => {
  it('returns "Task override" when taskModelOverride is set', () => {
    const result = getModelSource({ taskModelOverride: 'model-a' });

    expect(result).toBe('Task override');
  });

  it('returns "Agent config" when agentModel is set and task is null', () => {
    const result = getModelSource({
      taskModelOverride: null,
      agentModel: 'model-b',
    });

    expect(result).toBe('Agent config');
  });

  it('returns "Project config" when projectModel is set and higher are null', () => {
    const result = getModelSource({
      taskModelOverride: null,
      agentModel: null,
      projectModel: 'model-c',
    });

    expect(result).toBe('Project config');
  });

  it('returns "Global preference" when globalDefault is set and higher are null', () => {
    const result = getModelSource({
      taskModelOverride: null,
      agentModel: null,
      projectModel: null,
      globalDefault: 'model-d',
    });

    expect(result).toBe('Global preference');
  });

  it('returns "Default" when all context is empty', () => {
    const result = getModelSource({});

    expect(result).toBe('Default');
  });

  it('returns "Default" when all context is null', () => {
    const result = getModelSource({
      taskModelOverride: null,
      agentModel: null,
      projectModel: null,
      globalDefault: null,
    });

    expect(result).toBe('Default');
  });
});

// =============================================================================
// isValidModelId Tests
// =============================================================================

describe('isValidModelId', () => {
  it('returns true for valid short model IDs', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(isValidModelId(model.id)).toBe(true);
    }
  });

  it('returns true for valid full model IDs', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(isValidModelId(model.fullId)).toBe(true);
    }
  });

  it('returns false for unknown model IDs', () => {
    expect(isValidModelId('nonexistent-model')).toBe(false);
    expect(isValidModelId('')).toBe(false);
    expect(isValidModelId('gpt-4')).toBe(false);
  });

  it('returns false for deprecated model IDs', () => {
    // Deprecated models are not in AVAILABLE_MODELS
    expect(isValidModelId('claude-sonnet-4')).toBe(false);
    expect(isValidModelId('claude-opus-4')).toBe(false);
  });
});
