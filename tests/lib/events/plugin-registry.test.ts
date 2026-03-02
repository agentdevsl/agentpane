import { describe, expect, it } from 'vitest';
import type { EventSourcePlugin } from '../../../src/lib/events/plugin-interface';
import { PluginRegistry } from '../../../src/lib/events/plugin-registry';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function mockPlugin(type: string): EventSourcePlugin {
  return {
    type,
    verifySignature: async () => ({ ok: true, value: true }) as any,
    parseEvent: () => ({ ok: true, value: {} }) as any,
    getEventTypes: () => [],
    getTemplateVariables: () => [],
    matchesFilter: () => false,
  };
}

// ---------------------------------------------------------------------------
// PluginRegistry
// ---------------------------------------------------------------------------

describe('PluginRegistry', () => {
  it('register + get: returns the registered plugin', () => {
    const registry = new PluginRegistry();
    const plugin = mockPlugin('github');

    registry.register('github', plugin);

    expect(registry.get('github')).toBe(plugin);
  });

  it('get: returns undefined for unregistered type', () => {
    const registry = new PluginRegistry();

    expect(registry.get('gitlab')).toBeUndefined();
  });

  it('getRegisteredTypes: returns all registered type keys', () => {
    const registry = new PluginRegistry();
    registry.register('github', mockPlugin('github'));
    registry.register('gitlab', mockPlugin('gitlab'));
    registry.register('bitbucket', mockPlugin('bitbucket'));

    const types = registry.getRegisteredTypes();

    expect(types).toEqual(['github', 'gitlab', 'bitbucket']);
  });

  it('register overwrites existing plugin for same type', () => {
    const registry = new PluginRegistry();
    const pluginV1 = mockPlugin('github');
    const pluginV2 = mockPlugin('github');

    registry.register('github', pluginV1);
    registry.register('github', pluginV2);

    expect(registry.get('github')).toBe(pluginV2);
    expect(registry.get('github')).not.toBe(pluginV1);
    expect(registry.getRegisteredTypes()).toEqual(['github']);
  });

  it('each instance is isolated (no shared state between instances)', () => {
    const registryA = new PluginRegistry();
    const registryB = new PluginRegistry();

    registryA.register('github', mockPlugin('github'));

    expect(registryA.get('github')).toBeDefined();
    expect(registryB.get('github')).toBeUndefined();
    expect(registryB.getRegisteredTypes()).toEqual([]);
  });

  it('empty registry: getRegisteredTypes returns empty array', () => {
    const registry = new PluginRegistry();

    expect(registry.getRegisteredTypes()).toEqual([]);
  });
});
