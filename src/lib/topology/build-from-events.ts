import type { AgentStatus, TaskColumn } from '@/db/schema/shared/enums.js';
import type {
  ContainerAgentCompleteEvent,
  ContainerAgentStartedEvent,
  TopologyAgentCompletedEvent,
  TopologyAgentProgressEvent,
  TopologyAgentSpawnedEvent,
} from '@/services/durable-streams.service.js';
import type { TopologyEdge, TopologyGraph, TopologyNode } from './types.js';
import { deriveContainerAgentNodeId } from './utils.js';

/** Average cost per token used for topology cost estimates */
const AVERAGE_TOKEN_COST = 0.000009;

/** Approximate tokens per tool invocation (used when no real token counts are available) */
const TOKENS_PER_PROGRESS_POINT = 500;

// ---------------------------------------------------------------------------
// Discriminated event types -- eliminates unsafe `as` casts in the builder
// ---------------------------------------------------------------------------

interface AgentSpawnedEvent {
  id: string;
  type: 'topology:agent_spawned';
  timestamp: number;
  data: TopologyAgentSpawnedEvent & { agentType?: string; timestamp?: number };
}

interface AgentProgressEvent {
  id: string;
  type: 'topology:agent_progress';
  timestamp: number;
  data: TopologyAgentProgressEvent;
}

interface AgentCompletedEvent {
  id: string;
  type: 'topology:agent_completed';
  timestamp: number;
  data: TopologyAgentCompletedEvent & { timestamp?: number };
}

interface ContainerStartedEvent {
  id: string;
  type: 'container-agent:started';
  timestamp: number;
  data: ContainerAgentStartedEvent;
}

interface ContainerCompleteEvent {
  id: string;
  type: 'container-agent:complete';
  timestamp: number;
  data: ContainerAgentCompleteEvent & { error?: string };
}

interface ContainerToolStartEvent {
  id: string;
  type: 'container-agent:tool:start';
  timestamp: number;
  data: unknown;
}

interface ContainerMessageEvent {
  id: string;
  type: 'container-agent:message';
  timestamp: number;
  data: unknown;
}

interface ContainerPlanReadyEvent {
  id: string;
  type: 'container-agent:plan_ready';
  timestamp: number;
  data: unknown;
}

/**
 * Base event shape accepted by the topology builder.
 * Specific event interfaces above narrow `data` for known event types.
 */
export type TopologyEvent = {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
};

/**
 * Discriminated union of known event shapes used internally by the builder.
 * The `type` literal discriminates the `data` payload so type narrowing
 * works in the builder's switch branches.
 */
type KnownTopologyEvent =
  | AgentSpawnedEvent
  | AgentProgressEvent
  | AgentCompletedEvent
  | ContainerStartedEvent
  | ContainerCompleteEvent
  | ContainerToolStartEvent
  | ContainerMessageEvent
  | ContainerPlanReadyEvent;

/**
 * Context about the task/session, used to derive the root node
 * when events don't contain explicit topology events.
 */
export interface TopologyBuildContext {
  sessionId: string;
  agentId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  taskColumn?: TaskColumn | null;
  lastAgentStatus?: AgentStatus | null;
  skillId?: string | null;
  skillName?: string | null;
}

/**
 * Extract session events from the API response which may be a flat array
 * or wrapped in `{ data: [...] }`.
 */
export function extractSessionEvents(
  payload: TopologyEvent[] | { data: TopologyEvent[] }
): TopologyEvent[] {
  return Array.isArray(payload) ? payload : payload.data;
}

/**
 * Build a TopologyGraph from a list of historical session events.
 *
 * Processes these event types:
 * - `topology:agent_spawned` -- creates subagent nodes and parent-child edges
 * - `topology:agent_progress` -- updates token/cost/progress on nodes
 * - `topology:agent_completed` -- marks nodes as completed/failed/stopped
 * - `container-agent:started` -- creates root agent node (if no topology nodes exist yet)
 * - `container-agent:complete` -- marks root agent as completed
 * - `container-agent:tool:start` -- increments turn/token counts on root node
 * - `container-agent:message` -- increments message count on root node
 * - `container-agent:plan_ready` -- sets root node to verifying status
 *
 * When no events produce any nodes, a fallback root node is derived from
 * the task/session context.
 *
 * This function is shared by live-task-view and container-agent-panel
 * to avoid duplicating the reconstruction logic.
 */
export function buildTopologyFromEvents(
  events: TopologyEvent[],
  context: TopologyBuildContext
): TopologyGraph {
  const nodes = new Map<string, TopologyNode>();
  const edges: TopologyEdge[] = [];

  for (const rawEvent of events) {
    // Cast to the known discriminated union so TypeScript narrows `data`
    // in each branch. Unknown event types fall through without processing.
    const event = rawEvent as KnownTopologyEvent;
    if (event.type === 'topology:agent_spawned') {
      const d = event.data;
      const roleStr = d.role ?? '';
      const node: TopologyNode = {
        id: d.agentId,
        name: d.name,
        role: roleStr || 'agent',
        agentType: d.agentType ?? null,
        status: 'running',
        parentId: d.parentId ?? null,
        childIds: [],
        progress: 0,
        tokens: 0,
        cost: 0,
        turns: 0,
        messages: 0,
        startedAt: d.timestamp ?? event.timestamp,
        completedAt: null,
        verified: false,
        verificationScore: 0,
        decisions: [],
      };
      nodes.set(d.agentId, node);
      if (d.parentId) {
        edges.push({
          id: `${d.parentId}->${d.agentId}`,
          sourceId: d.parentId,
          targetId: d.agentId,
        });
        const parent = nodes.get(d.parentId);
        if (parent) parent.childIds.push(d.agentId);
      }
    } else if (event.type === 'container-agent:started' && nodes.size === 0) {
      const d = event.data;
      const agentId = deriveContainerAgentNodeId({
        agentId: context.agentId,
        taskId: d.taskId ?? context.taskId,
        sessionId: context.sessionId,
      });
      nodes.set(agentId, {
        id: agentId,
        name: d.model ?? context.taskTitle ?? 'Agent',
        role: 'agent',
        agentType: null,
        status: 'running',
        parentId: null,
        childIds: [],
        progress: 0,
        tokens: 0,
        cost: 0,
        turns: 0,
        messages: 0,
        startedAt: event.timestamp,
        completedAt: null,
        verified: false,
        verificationScore: 0,
        decisions: [],
      });
    } else if (event.type === 'container-agent:complete') {
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        const d = event.data;
        firstNode.status = d.error ? 'failed' : 'completed';
        firstNode.completedAt = event.timestamp;
        if (!d.error) firstNode.progress = 100;
      }
    } else if (event.type === 'topology:agent_progress') {
      const d = event.data;
      const node = nodes.get(d.agentId);
      if (node && d.tokens) {
        node.tokens = d.tokens;
        node.cost = Number.parseFloat((d.tokens * AVERAGE_TOKEN_COST).toFixed(4));
        node.progress = Math.min(95, Math.floor(d.tokens / TOKENS_PER_PROGRESS_POINT));
        node.turns = d.toolUses ?? node.turns;
      }
    } else if (event.type === 'topology:agent_completed') {
      const d = event.data;
      const node = nodes.get(d.agentId);
      if (node) {
        node.status =
          d.status === 'completed' ? 'completed' : d.status === 'stopped' ? 'stopped' : 'failed';
        node.completedAt = d.timestamp ?? event.timestamp;
        if (d.tokens) {
          node.tokens = d.tokens;
          node.cost = Number.parseFloat((d.tokens * AVERAGE_TOKEN_COST).toFixed(4));
        }
        if (node.status === 'completed') node.progress = 100;
      }
    } else if (event.type === 'container-agent:tool:start') {
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        firstNode.turns += 1;
        firstNode.tokens += TOKENS_PER_PROGRESS_POINT;
        firstNode.cost = Number.parseFloat((firstNode.tokens * AVERAGE_TOKEN_COST).toFixed(4));
        firstNode.progress = Math.min(95, firstNode.turns * 10);
      }
    } else if (event.type === 'container-agent:message') {
      const firstNode = nodes.values().next().value;
      if (firstNode) firstNode.messages += 1;
    } else if (event.type === 'container-agent:plan_ready') {
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        firstNode.status = 'verifying';
        firstNode.progress = 80;
      }
    }
  }

  // Fallback: create a root node from task/session metadata
  if (nodes.size === 0) {
    const agentId = deriveContainerAgentNodeId({
      agentId: context.agentId,
      taskId: context.taskId,
      sessionId: context.sessionId,
    });
    const isCompleted = context.taskColumn === 'verified';
    const isRunning = context.taskColumn === 'in_progress';
    const isPlanReady = context.lastAgentStatus === 'planning';

    let toolCount = 0;
    for (const event of events) {
      if (event.type.includes('tool:start')) toolCount++;
    }

    let fallbackStatus: TopologyNode['status'];
    if (isCompleted) {
      fallbackStatus = 'completed';
    } else if (isPlanReady) {
      fallbackStatus = 'verifying';
    } else if (isRunning) {
      fallbackStatus = 'running';
    } else {
      fallbackStatus = 'queued';
    }

    const rootNode: TopologyNode = {
      id: agentId,
      name: context.taskTitle ?? 'Agent',
      role: 'agent',
      agentType: null,
      status: fallbackStatus,
      parentId: null,
      childIds: [],
      progress: isCompleted ? 100 : isPlanReady ? 80 : Math.min(90, toolCount * 10),
      tokens: toolCount * TOKENS_PER_PROGRESS_POINT,
      cost: Number.parseFloat(
        (toolCount * TOKENS_PER_PROGRESS_POINT * AVERAGE_TOKEN_COST).toFixed(4)
      ),
      turns: toolCount,
      messages: events.filter((e) => e.type.includes('message')).length,
      startedAt: events[0]?.timestamp ?? Date.now(),
      completedAt: isCompleted ? (events[events.length - 1]?.timestamp ?? null) : null,
      verified: isCompleted,
      verificationScore: isCompleted ? 1 : 0,
      decisions: [],
    };
    nodes.set(agentId, rootNode);
  }

  return {
    nodes: Array.from(nodes.values()),
    edges,
    taskId: context.taskId ?? '',
    taskName: context.taskTitle ?? '',
    taskPriority: '',
    skillId: context.skillId ?? null,
    skillName: context.skillName ?? null,
  };
}
