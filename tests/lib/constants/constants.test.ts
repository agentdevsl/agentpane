import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AVAILABLE_MODELS,
  DEFAULT_AGENT_MODEL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_TASK_CREATION_MODEL,
  DEFAULT_WORKFLOW_MODEL,
  getAnthropicBaseUrl,
  getFullModelId,
  getModelById,
} from '../../../src/lib/constants/models';
import { CONTAINER_WORKSPACE_PATH } from '../../../src/lib/constants/sandbox';
import {
  ALL_TOOLS,
  ALLOW_ALL_TOOLS,
  DEFAULT_AGENT_TOOLS,
  DEFAULT_TASK_CREATION_TOOLS,
  DEFAULT_WORKFLOW_TOOLS,
  getAgentTools,
  getTaskCreationTools,
  getWorkflowTools,
  TOOL_GROUPS,
} from '../../../src/lib/constants/tools';

// Stub localStorage for functions that use it when `window` is defined (happy-dom)
const mockLocalStorage = {
  getItem: vi.fn().mockReturnValue(null),
  setItem: vi.fn(),
  removeItem: vi.fn(),
  clear: vi.fn(),
  length: 0,
  key: vi.fn().mockReturnValue(null),
};

beforeEach(() => {
  vi.stubGlobal('localStorage', mockLocalStorage);
});

afterEach(() => {
  vi.restoreAllMocks();
});

// ============================================
// Model Constants
// ============================================

describe('AVAILABLE_MODELS', () => {
  it('is a non-empty array', () => {
    expect(Array.isArray(AVAILABLE_MODELS)).toBe(true);
    expect(AVAILABLE_MODELS.length).toBeGreaterThan(0);
  });

  it('each model has required fields', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(model).toHaveProperty('id');
      expect(model).toHaveProperty('name');
      expect(model).toHaveProperty('fullId');
      expect(model).toHaveProperty('description');
      expect(typeof model.id).toBe('string');
      expect(typeof model.name).toBe('string');
      expect(typeof model.fullId).toBe('string');
      expect(typeof model.description).toBe('string');
      expect(model.id.length).toBeGreaterThan(0);
      expect(model.name.length).toBeGreaterThan(0);
      expect(model.fullId.length).toBeGreaterThan(0);
    }
  });

  it('has unique ids', () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it('has unique fullIds', () => {
    const fullIds = AVAILABLE_MODELS.map((m) => m.fullId);
    expect(new Set(fullIds).size).toBe(fullIds.length);
  });

  it('contains the default models', () => {
    const ids = AVAILABLE_MODELS.map((m) => m.id);
    expect(ids).toContain(DEFAULT_AGENT_MODEL);
    expect(ids).toContain(DEFAULT_WORKFLOW_MODEL);
    expect(ids).toContain(DEFAULT_TASK_CREATION_MODEL);
  });
});

describe('getFullModelId', () => {
  it('returns fullId for a known short id', () => {
    const model = AVAILABLE_MODELS[0];
    expect(getFullModelId(model.id)).toBe(model.fullId);
  });

  it('returns the same value when given an already-known fullId', () => {
    for (const model of AVAILABLE_MODELS) {
      expect(getFullModelId(model.fullId)).toBe(model.fullId);
    }
  });

  it('passes through unknown model IDs as-is', () => {
    expect(getFullModelId('unknown-model-xyz')).toBe('unknown-model-xyz');
  });

  it('migrates deprecated claude-sonnet-4 to claude-sonnet-4-6', () => {
    const result = getFullModelId('claude-sonnet-4');
    expect(result).toBe('claude-sonnet-4-6');
  });

  it('migrates deprecated claude-sonnet-4-20250514', () => {
    const result = getFullModelId('claude-sonnet-4-20250514');
    expect(result).toBe('claude-sonnet-4-6');
  });

  it('migrates deprecated claude-sonnet-4-5 to claude-sonnet-4-6', () => {
    const result = getFullModelId('claude-sonnet-4-5');
    expect(result).toBe('claude-sonnet-4-6');
  });

  it('migrates deprecated claude-opus-4 to claude-opus-4-5 fullId', () => {
    const result = getFullModelId('claude-opus-4');
    // claude-opus-4 -> claude-opus-4-5 (short id) -> fullId
    const opus45 = AVAILABLE_MODELS.find((m) => m.id === 'claude-opus-4-5');
    expect(result).toBe(opus45?.fullId);
  });

  it('migrates deprecated claude-haiku-3-5', () => {
    const result = getFullModelId('claude-haiku-3-5');
    const haiku45 = AVAILABLE_MODELS.find((m) => m.id === 'claude-haiku-4-5');
    expect(result).toBe(haiku45?.fullId);
  });

  it('migrates deprecated full IDs with date stamps', () => {
    // claude-opus-4-20250514 -> claude-opus-4-5-20251101 (already a fullId)
    expect(getFullModelId('claude-opus-4-20250514')).toBe('claude-opus-4-5-20251101');
    // claude-haiku-4-5-20250414 -> claude-haiku-4-5-20251001 (already a fullId)
    expect(getFullModelId('claude-haiku-4-5-20250414')).toBe('claude-haiku-4-5-20251001');
  });
});

describe('getModelById', () => {
  it('returns the model object for a known short id', () => {
    const model = getModelById('claude-opus-4-6');
    expect(model).toBeDefined();
    expect(model?.id).toBe('claude-opus-4-6');
    expect(model?.name).toBe('Claude Opus 4.6');
  });

  it('returns undefined for an unknown short id', () => {
    expect(getModelById('non-existent-model')).toBeUndefined();
  });

  it('returns undefined for a fullId (only matches short id)', () => {
    // getModelById uses shortId matching only
    const model = AVAILABLE_MODELS.find((m) => m.id !== m.fullId);
    if (model) {
      expect(getModelById(model.fullId)).toBeUndefined();
    }
  });
});

describe('Default model constants', () => {
  it('DEFAULT_AGENT_MODEL is a string', () => {
    expect(typeof DEFAULT_AGENT_MODEL).toBe('string');
    expect(DEFAULT_AGENT_MODEL.length).toBeGreaterThan(0);
  });

  it('DEFAULT_WORKFLOW_MODEL is a string', () => {
    expect(typeof DEFAULT_WORKFLOW_MODEL).toBe('string');
  });

  it('DEFAULT_TASK_CREATION_MODEL is a string', () => {
    expect(typeof DEFAULT_TASK_CREATION_MODEL).toBe('string');
  });
});

describe('getAnthropicBaseUrl', () => {
  it('default URL is https://api.anthropic.com', () => {
    expect(DEFAULT_ANTHROPIC_BASE_URL).toBe('https://api.anthropic.com');
  });

  it('returns a string', () => {
    // In the test environment window may be defined (happy-dom), so
    // we just verify the function returns a valid string.
    const url = getAnthropicBaseUrl();
    expect(typeof url).toBe('string');
    expect(url.length).toBeGreaterThan(0);
  });
});

// ============================================
// Tool Constants
// ============================================

describe('TOOL_GROUPS', () => {
  it('has expected group keys', () => {
    const keys = Object.keys(TOOL_GROUPS);
    expect(keys).toContain('Files');
    expect(keys).toContain('System');
    expect(keys).toContain('Web');
    expect(keys).toContain('Agent');
    expect(keys).toContain('Interactive');
    expect(keys).toContain('MCP');
  });

  it('each group is a non-empty array of strings', () => {
    for (const [, tools] of Object.entries(TOOL_GROUPS)) {
      expect(Array.isArray(tools)).toBe(true);
      expect(tools.length).toBeGreaterThan(0);
      for (const tool of tools) {
        expect(typeof tool).toBe('string');
      }
    }
  });

  it('Files group contains Read, Edit, Write', () => {
    expect(TOOL_GROUPS.Files).toContain('Read');
    expect(TOOL_GROUPS.Files).toContain('Edit');
    expect(TOOL_GROUPS.Files).toContain('Write');
  });

  it('System group contains Bash', () => {
    expect(TOOL_GROUPS.System).toContain('Bash');
  });
});

describe('ALL_TOOLS', () => {
  it('is a flat array of all tools from all groups', () => {
    const expectedTotal = Object.values(TOOL_GROUPS).reduce((sum, g) => sum + g.length, 0);
    expect(ALL_TOOLS.length).toBe(expectedTotal);
  });

  it('contains every tool from every group', () => {
    for (const tools of Object.values(TOOL_GROUPS)) {
      for (const tool of tools) {
        expect(ALL_TOOLS).toContain(tool);
      }
    }
  });
});

describe('ALLOW_ALL_TOOLS', () => {
  it('is an empty array', () => {
    expect(ALLOW_ALL_TOOLS).toEqual([]);
  });
});

describe('DEFAULT_AGENT_TOOLS', () => {
  it('equals ALLOW_ALL_TOOLS (empty array)', () => {
    expect(DEFAULT_AGENT_TOOLS).toEqual(ALLOW_ALL_TOOLS);
  });
});

describe('DEFAULT_TASK_CREATION_TOOLS', () => {
  it('contains read-only tools', () => {
    expect(DEFAULT_TASK_CREATION_TOOLS).toContain('Read');
    expect(DEFAULT_TASK_CREATION_TOOLS).toContain('Glob');
    expect(DEFAULT_TASK_CREATION_TOOLS).toContain('Grep');
  });

  it('does not contain Bash', () => {
    expect(DEFAULT_TASK_CREATION_TOOLS).not.toContain('Bash');
  });
});

describe('DEFAULT_WORKFLOW_TOOLS', () => {
  it('contains read-only tools', () => {
    expect(DEFAULT_WORKFLOW_TOOLS).toContain('Read');
    expect(DEFAULT_WORKFLOW_TOOLS).toContain('Glob');
    expect(DEFAULT_WORKFLOW_TOOLS).toContain('Grep');
  });

  it('does not contain write or execution tools', () => {
    expect(DEFAULT_WORKFLOW_TOOLS).not.toContain('Write');
    expect(DEFAULT_WORKFLOW_TOOLS).not.toContain('Edit');
    expect(DEFAULT_WORKFLOW_TOOLS).not.toContain('Bash');
  });
});

describe('getAgentTools', () => {
  it('returns an array of strings', () => {
    const tools = getAgentTools();
    expect(Array.isArray(tools)).toBe(true);
    // DEFAULT_AGENT_TOOLS is ALLOW_ALL_TOOLS (empty array)
    // or localStorage-stored tools — both are valid arrays
  });
});

describe('getTaskCreationTools', () => {
  it('returns an array of strings', () => {
    const tools = getTaskCreationTools();
    expect(Array.isArray(tools)).toBe(true);
  });
});

describe('getWorkflowTools', () => {
  it('returns an array of strings', () => {
    const tools = getWorkflowTools();
    expect(Array.isArray(tools)).toBe(true);
  });
});

// ============================================
// Sandbox Constants
// ============================================

describe('CONTAINER_WORKSPACE_PATH', () => {
  it('is /workspace', () => {
    expect(CONTAINER_WORKSPACE_PATH).toBe('/workspace');
  });
});
