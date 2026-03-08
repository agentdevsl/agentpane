import { describe, expect, it } from 'vitest';
import {
  type AgentRunnerEventType,
  type DurableStreamAgentEventType,
  EVENT_TYPE_MAP,
} from '../event-type-map.js';

describe('EVENT_TYPE_MAP', () => {
  const expectedMappings: Record<AgentRunnerEventType, DurableStreamAgentEventType> = {
    'agent:started': 'container-agent:started',
    'agent:token': 'container-agent:token',
    'agent:turn': 'container-agent:turn',
    'agent:tool:start': 'container-agent:tool:start',
    'agent:tool:result': 'container-agent:tool:result',
    'agent:message': 'container-agent:message',
    'agent:complete': 'container-agent:complete',
    'agent:error': 'container-agent:error',
    'agent:cancelled': 'container-agent:cancelled',
    'agent:plan_ready': 'container-agent:plan_ready',
    'agent:file_changed': 'container-agent:file_changed',
  };

  it('should map all expected agent event types', () => {
    const expectedKeys = Object.keys(expectedMappings);
    const actualKeys = Object.keys(EVENT_TYPE_MAP);

    expect(actualKeys).toHaveLength(expectedKeys.length);

    for (const key of expectedKeys) {
      expect(EVENT_TYPE_MAP).toHaveProperty(key);
    }
  });

  it('should contain exactly 11 mappings', () => {
    expect(Object.keys(EVENT_TYPE_MAP)).toHaveLength(11);
  });

  it('should prefix all mapped types with container-agent:', () => {
    for (const [, value] of Object.entries(EVENT_TYPE_MAP)) {
      expect(value).toMatch(/^container-agent:/);
    }
  });

  it('should map each agent event to the correct container-agent event', () => {
    for (const [key, expected] of Object.entries(expectedMappings)) {
      expect(EVENT_TYPE_MAP[key as AgentRunnerEventType]).toBe(expected);
    }
  });

  it('should preserve the event suffix after prefix replacement', () => {
    for (const [key, value] of Object.entries(EVENT_TYPE_MAP)) {
      // 'agent:started' -> 'started', 'container-agent:started' -> 'started'
      const inputSuffix = key.replace(/^agent:/, '');
      const outputSuffix = value.replace(/^container-agent:/, '');
      expect(outputSuffix).toBe(inputSuffix);
    }
  });

  it('should include lifecycle events (started, complete, error, cancelled)', () => {
    expect(EVENT_TYPE_MAP['agent:started']).toBe('container-agent:started');
    expect(EVENT_TYPE_MAP['agent:complete']).toBe('container-agent:complete');
    expect(EVENT_TYPE_MAP['agent:error']).toBe('container-agent:error');
    expect(EVENT_TYPE_MAP['agent:cancelled']).toBe('container-agent:cancelled');
  });

  it('should include streaming events (token, turn, message)', () => {
    expect(EVENT_TYPE_MAP['agent:token']).toBe('container-agent:token');
    expect(EVENT_TYPE_MAP['agent:turn']).toBe('container-agent:turn');
    expect(EVENT_TYPE_MAP['agent:message']).toBe('container-agent:message');
  });

  it('should include tool events (tool:start, tool:result)', () => {
    expect(EVENT_TYPE_MAP['agent:tool:start']).toBe('container-agent:tool:start');
    expect(EVENT_TYPE_MAP['agent:tool:result']).toBe('container-agent:tool:result');
  });

  it('should include plan and file events', () => {
    expect(EVENT_TYPE_MAP['agent:plan_ready']).toBe('container-agent:plan_ready');
    expect(EVENT_TYPE_MAP['agent:file_changed']).toBe('container-agent:file_changed');
  });
});
