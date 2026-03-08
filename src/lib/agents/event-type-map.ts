/**
 * Shared event type mapping from agent-runner events to durable streams events.
 *
 * Used by both ContainerBridge (JSON lines from Docker stdout) and
 * AgentCoreBridge (SSE events from AWS AgentCore).
 */
import type { TypedEventType } from '../../services/durable-streams.service.js';

/**
 * Event types emitted by the agent-runner (container or AgentCore).
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
  | 'agent:file_changed';

/**
 * Maps agent-runner event types to durable streams event types.
 * Shared between ContainerBridge (stdout JSON lines) and AgentCoreBridge (SSE events).
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
} as const;

/**
 * Durable stream event types produced by the mapping.
 */
export type DurableStreamAgentEventType = (typeof EVENT_TYPE_MAP)[AgentRunnerEventType];
