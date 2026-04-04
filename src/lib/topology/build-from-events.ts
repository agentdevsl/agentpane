import type { TopologyEdge, TopologyGraph, TopologyNode } from './types.js';
import { deriveContainerAgentNodeId } from './utils.js';

/**
 * Valid agent roles used for validation during event reconstruction.
 */
const VALID_ROLES = new Set([
  'orchestrator',
  'planner',
  'coder',
  'reviewer',
  'tester',
  'scanner',
  'deployer',
]);

/**
 * Minimal event shape expected by the topology builder.
 */
export interface TopologyEvent {
  id: string;
  type: string;
  timestamp: number;
  data: unknown;
}

/**
 * Context about the task/session, used to derive the root node
 * when events don't contain explicit topology events.
 */
export interface TopologyBuildContext {
  sessionId: string;
  agentId?: string | null;
  taskId?: string | null;
  taskTitle?: string | null;
  taskColumn?: string | null;
  lastAgentStatus?: string | null;
}

/**
 * Build a TopologyGraph from a list of historical session events.
 *
 * Processes these event types:
 * - `topology:agent_spawned` — creates subagent nodes and parent-child edges
 * - `topology:agent_progress` — updates token/cost/progress on nodes
 * - `topology:agent_completed` — marks nodes as completed/failed/stopped
 * - `container-agent:started` — creates root agent node (if no topology nodes exist yet)
 * - `container-agent:complete` — marks root agent as completed
 * - `container-agent:tool:start` — increments turn/token counts on root node
 * - `container-agent:message` — increments message count on root node
 * - `container-agent:plan_ready` — sets root node to verifying status
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

  for (const event of events) {
    if (event.type === 'topology:agent_spawned') {
      const d = event.data as {
        agentId: string;
        name: string;
        role?: string;
        agentType?: string;
        parentId?: string;
        timestamp?: number;
      };
      const node: TopologyNode = {
        id: d.agentId,
        name: d.name,
        role: (VALID_ROLES.has(d.role ?? '') ? d.role : 'coder') as TopologyNode['role'],
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
      const d = event.data as { taskId?: string; model?: string };
      const agentId = deriveContainerAgentNodeId({
        agentId: context.agentId,
        taskId: d.taskId ?? context.taskId,
        sessionId: context.sessionId,
      });
      nodes.set(agentId, {
        id: agentId,
        name: d.model ?? context.taskTitle ?? 'Agent',
        role: 'coder',
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
      // Mark root node as completed
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        const d = event.data as { result?: string; error?: string };
        firstNode.status = d.error ? 'failed' : 'completed';
        firstNode.completedAt = event.timestamp;
        if (!d.error) firstNode.progress = 100;
      }
    } else if (event.type === 'topology:agent_progress') {
      const d = event.data as { agentId: string; tokens?: number; toolUses?: number };
      const node = nodes.get(d.agentId);
      if (node && d.tokens) {
        node.tokens = d.tokens;
        node.cost = Number.parseFloat((d.tokens * 0.000009).toFixed(4));
        node.progress = Math.min(95, Math.floor(d.tokens / 500));
        node.turns = d.toolUses ?? node.turns;
      }
    } else if (event.type === 'topology:agent_completed') {
      const d = event.data as {
        agentId: string;
        status?: string;
        tokens?: number;
        timestamp?: number;
      };
      const node = nodes.get(d.agentId);
      if (node) {
        node.status =
          d.status === 'completed' ? 'completed' : d.status === 'stopped' ? 'stopped' : 'failed';
        node.completedAt = d.timestamp ?? event.timestamp;
        if (d.tokens) {
          node.tokens = d.tokens;
          node.cost = Number.parseFloat((d.tokens * 0.000009).toFixed(4));
        }
        if (node.status === 'completed') node.progress = 100;
      }
    } else if (event.type === 'container-agent:tool:start') {
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        firstNode.turns += 1;
        firstNode.tokens += 500;
        firstNode.cost = Number.parseFloat((firstNode.tokens * 0.000009).toFixed(4));
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
    const isCompleted = context.taskColumn === 'verified' || context.taskColumn === 'done';
    const isRunning = context.taskColumn === 'in_progress';
    const isPlanReady = context.lastAgentStatus === 'planning';

    let toolCount = 0;
    for (const event of events) {
      if (event.type.includes('tool:start')) toolCount++;
    }

    const rootNode: TopologyNode = {
      id: agentId,
      name: context.taskTitle ?? 'Agent',
      role: 'coder',
      status: isCompleted
        ? 'completed'
        : isPlanReady
          ? 'verifying'
          : isRunning
            ? 'running'
            : 'queued',
      parentId: null,
      childIds: [],
      progress: isCompleted ? 100 : isPlanReady ? 80 : Math.min(90, toolCount * 10),
      tokens: toolCount * 500,
      cost: Number.parseFloat((toolCount * 500 * 0.000009).toFixed(4)),
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
  };
}
