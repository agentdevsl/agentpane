import type { EventSourcePlugin } from './plugin-interface.js';

/**
 * Dependency-injected registry for event source plugins.
 *
 * Each instance is independent — no global singleton — so tests can create
 * isolated registries and the application can wire one up during bootstrap.
 */
export class PluginRegistry {
  private plugins = new Map<string, EventSourcePlugin>();

  /** Register a plugin under its source type key. */
  register(type: string, plugin: EventSourcePlugin): void {
    this.plugins.set(type, plugin);
  }

  /** Retrieve a plugin by source type. Returns undefined when not registered. */
  get(type: string): EventSourcePlugin | undefined {
    return this.plugins.get(type);
  }

  /** List all registered source type keys. */
  getRegisteredTypes(): string[] {
    return Array.from(this.plugins.keys());
  }
}
