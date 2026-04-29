/**
 * Shared event type mapping from agent-runner events to durable streams events.
 *
 * Used by ContainerBridge (JSON lines from Docker stdout).
 */
import type { TypedEventType } from '../../services/durable-streams.service.js';

/**
 * Event types emitted by the agent-runner.
 */
export type AgentRunnerEventType =
  | 'agent:started'
  | 'agent:token'
  | 'agent:turn'
  | 'agent:tool:start'
  | 'agent:tool:result'
  | 'agent:message'
  | 'agent:complete'
  | 'agent:error'
  | 'agent:cancelled'
  | 'agent:plan_ready'
  | 'agent:file_changed'
  | 'agent:topology:spawned'
  | 'agent:topology:progress'
  | 'agent:topology:completed';

/**
 * Maps agent-runner event types to durable streams event types.
 * Used by ContainerBridge (stdout JSON lines).
 */
export const EVENT_TYPE_MAP: Record<AgentRunnerEventType, TypedEventType> = {
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
  'agent:topology:spawned': 'topology:agent_spawned',
  'agent:topology:progress': 'topology:agent_progress',
  'agent:topology:completed': 'topology:agent_completed',
} as const;

/**
 * Durable stream event types produced by the mapping.
 */
export type DurableStreamAgentEventType = (typeof EVENT_TYPE_MAP)[AgentRunnerEventType];
