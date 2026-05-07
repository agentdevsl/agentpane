import type { AgentStatus, TaskColumn } from '@/db/schema/shared/enums.js';
import type {
  ContainerAgentCompleteEvent,
  ContainerAgentStartedEvent,
  TopologyAgentCompletedEvent,
  TopologyAgentProgressEvent,
  TopologyAgentSpawnedEvent,
} from '@/services/durable-streams.service.js';
import { extractSkillNamespace } from './map-agent-role.js';
import type { TopologyAgentMeta, TopologyEdge, TopologyGraph, TopologyNode } from './types.js';
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
  data: TopologyAgentSpawnedEvent & { timestamp?: number };
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

interface ToolStartEvent {
  id: string;
  type: 'tool:start';
  timestamp: number;
  data: { tool: string; input?: { skill?: string } };
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
  | ContainerPlanReadyEvent
  | ToolStartEvent;

/** Known agent entry from CachedAgent frontmatter for resolving agentMeta */
export interface KnownAgent {
  name: string;
  model?: string;
  color?: string;
  skills?: string[];
  tools?: string[];
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
  taskColumn?: TaskColumn | null;
  lastAgentStatus?: AgentStatus | null;
  skillId?: string | null;
  skillName?: string | null;
  /** Known agents from template's CachedAgent frontmatter for resolving agentMeta */
  knownAgents?: KnownAgent[];
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

/** Resolve agentMeta from knownAgents by matching agentType name */
function resolveAgentMeta(
  agentType: string | null,
  knownAgents?: KnownAgent[]
): TopologyAgentMeta | null {
  if (!agentType || !knownAgents || knownAgents.length === 0) return null;
  // Try exact match first
  const match = knownAgents.find((a) => a.name === agentType);
  if (match) {
    return {
      model: match.model,
      color: match.color,
      skills: match.skills,
      tools: match.tools,
    };
  }
  // Try matching just the suffix after the namespace separator (colon or dot)
  const colonIdx = agentType.lastIndexOf(':');
  const dotIdx = agentType.lastIndexOf('.');
  const sep = Math.max(colonIdx, dotIdx);
  if (sep > 0) {
    const suffix = agentType.slice(sep + 1);
    const suffixMatch = knownAgents.find((a) => a.name === suffix);
    if (suffixMatch) {
      return {
        model: suffixMatch.model,
        color: suffixMatch.color,
        skills: suffixMatch.skills,
        tools: suffixMatch.tools,
      };
    }
  }
  return null;
}

/** Default new-field values for TopologyNode */
function defaultNodeFields(): Pick<
  TopologyNode,
  'type' | 'skillId' | 'skillName' | 'skillCalls' | 'agentMeta' | 'phase'
> {
  return {
    type: 'agent',
    skillId: null,
    skillName: null,
    skillCalls: [],
    agentMeta: null,
    phase: undefined,
  };
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
 * - `tool:start` -- when tool === 'Skill', accumulates skill calls on the root node
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
  /** Accumulated skill tool calls for the root node (deduped after the loop) */
  const rootSkillCalls = new Set<string>();
  /** Track plan_ready to detect phase transitions */
  let seenPlanReady = false;
  /** Maps planning root agentId → execution node ID for child routing */
  const executionPhaseRoots = new Map<string, string>();
  for (const rawEvent of events) {
    // Cast to the known discriminated union so TypeScript narrows `data`
    // in each branch. Unknown event types fall through without processing.
    const event = rawEvent as KnownTopologyEvent;
    if (event.type === 'topology:agent_spawned') {
      const d = event.data;
      const existing = nodes.get(d.agentId);

      // Phase transition: if the root agent is re-spawned after plan_ready,
      // create a separate execution phase node so both phases are visible.
      if (
        existing &&
        seenPlanReady &&
        (existing.childIds.length > 0 || existing.tokens > 0 || existing.status !== 'running')
      ) {
        const execNodeId = `${d.agentId}:execution`;
        if (!nodes.has(execNodeId)) {
          // Mark planning root as completed (plan phase done)
          existing.status = 'completed';
          existing.progress = 100;
          existing.name = `${existing.name} (Planning)`;

          // Create execution phase node
          const execNode: TopologyNode = {
            id: execNodeId,
            name: d.name || 'Execution',
            role: existing.role || 'agent',
            ...defaultNodeFields(),
            agentType: null,
            phase: 'executing',
            status: 'running',
            parentId: existing.id,
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
          nodes.set(execNodeId, execNode);
          existing.childIds.push(execNodeId);
          edges.push({
            id: `${existing.id}->${execNodeId}`,
            sourceId: existing.id,
            targetId: execNodeId,
          });
          executionPhaseRoots.set(d.agentId, execNodeId);
        }
        continue;
      }

      // Skip true duplicates (same node, no phase transition)
      if (
        existing &&
        (existing.tokens > 0 || existing.status !== 'running' || existing.childIds.length > 0)
      ) {
        continue;
      }
      const roleStr = d.role ?? '';
      const agentType = d.agentType ?? null;
      const skillNs = agentType ? extractSkillNamespace(agentType) : null;
      const agentMeta = resolveAgentMeta(agentType, context.knownAgents);
      const node: TopologyNode = {
        id: d.agentId,
        name: d.name,
        role: roleStr || 'agent',
        ...defaultNodeFields(),
        agentType,
        phase: seenPlanReady ? 'executing' : 'planning',
        skillId: skillNs,
        skillName: skillNs ? agentType : null,
        agentMeta,
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
        // Route execution-phase children to the execution root node
        const effectiveParentId =
          seenPlanReady && executionPhaseRoots.has(d.parentId)
            ? (executionPhaseRoots.get(d.parentId) ?? d.parentId)
            : d.parentId;

        // Connect the spawned agent directly to its parent. Agent-type
        // grouping is now handled visually via `TopologyGroupOverlay`
        // boxes drawn behind same-type sibling clusters — synthesising an
        // intermediate "group" parent node here would create the box
        // *and* a duplicate hierarchical level (one synthetic node per
        // type, plus the real subagents), which is exactly what the
        // overlay was meant to replace.
        node.parentId = effectiveParentId;
        edges.push({
          id: `${effectiveParentId}->${d.agentId}`,
          sourceId: effectiveParentId,
          targetId: d.agentId,
        });
        const parent = nodes.get(effectiveParentId);
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
        name: context.taskTitle ?? 'Orchestrator',
        role: 'agent',
        ...defaultNodeFields(),
        agentType: null,
        phase: 'planning',
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
      const d = event.data;
      const completeStatus =
        d.status === 'completed' ? 'completed' : d.status === 'cancelled' ? 'stopped' : 'failed';
      // If there's an execution phase node, complete that; otherwise complete the root
      const execNodeId = executionPhaseRoots.values().next().value;
      const targetNode = execNodeId ? nodes.get(execNodeId) : nodes.values().next().value;
      if (targetNode) {
        targetNode.status = completeStatus;
        targetNode.completedAt = event.timestamp;
        if (completeStatus === 'completed') targetNode.progress = 100;
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
      seenPlanReady = true;
      const firstNode = nodes.values().next().value;
      if (firstNode) {
        firstNode.status = 'verifying';
        firstNode.progress = 80;
        firstNode.phase = 'reviewing';
      }
    } else if (event.type === 'tool:start') {
      const d = event.data;
      if (d.tool === 'Skill' && d.input?.skill) {
        rootSkillCalls.add(d.input.skill);
      }
    }
  }

  // Assign accumulated skill calls to the root node (first node)
  if (rootSkillCalls.size > 0) {
    const firstNode = nodes.values().next().value;
    if (firstNode) {
      firstNode.skillCalls = Array.from(rootSkillCalls);
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

    const fallbackPhase: TopologyNode['phase'] = isCompleted
      ? 'executing'
      : isPlanReady
        ? 'reviewing'
        : isRunning
          ? 'planning'
          : undefined;

    const rootNode: TopologyNode = {
      id: agentId,
      name: context.taskTitle ?? 'Agent',
      role: 'agent',
      ...defaultNodeFields(),
      agentType: null,
      phase: fallbackPhase,
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
      skillCalls: Array.from(rootSkillCalls),
    };
    nodes.set(agentId, rootNode);
  }

  // --- Reconcile stale "running" nodes ---
  // After processing all events, some nodes may still show "running" because:
  // 1. topology:agent_completed event was never emitted/stored
  // 2. A duplicate topology:agent_spawned reset a node after it was completed
  // 3. The container-agent:complete only updates firstNode, not topology nodes

  // Strategy 1: If we saw a container-agent:complete event, the overall agent
  // session is done — mark all remaining "running" nodes as completed.
  const sawContainerComplete = events.some((e) => e.type === 'container-agent:complete');

  // Strategy 2: Context-based — task has left in_progress or has terminal status.
  const terminalStatuses: Record<string, TopologyNode['status']> = {
    completed: 'completed',
    cancelled: 'stopped',
    error: 'failed',
    turn_limit: 'failed',
    planning: 'completed',
  };
  const resolvedTerminal = context.lastAgentStatus
    ? terminalStatuses[context.lastAgentStatus]
    : undefined;
  const taskIsTerminal =
    resolvedTerminal ||
    (context.taskColumn && context.taskColumn !== 'in_progress' && context.taskColumn !== 'queued');

  // Strategy 3: If ALL child nodes of a parent are completed/failed/stopped,
  // the parent should not be "running" either.
  const allChildrenDone = (node: TopologyNode): boolean => {
    if (node.childIds.length === 0) return false;
    return node.childIds.every((childId) => {
      const child = nodes.get(childId);
      return child && child.status !== 'running' && child.status !== 'queued';
    });
  };

  if (sawContainerComplete || taskIsTerminal) {
    const finalStatus = resolvedTerminal ?? 'completed';
    for (const node of nodes.values()) {
      if (node.status === 'running') {
        node.status = finalStatus;
        if (finalStatus === 'completed') node.progress = 100;
      }
    }
  } else {
    // Even without a global terminal signal, reconcile parents whose children all finished.
    // Iterate until convergence since group nodes may need to be reconciled before their
    // parents can be (e.g. orch → group → agent, group must complete before orch can).
    let changed = true;
    while (changed) {
      changed = false;
      for (const node of nodes.values()) {
        if (node.status === 'running' && allChildrenDone(node)) {
          node.status = 'completed';
          node.progress = 100;
          changed = true;
        }
      }
    }
  }

  // --- Group concurrent siblings ---
  // Detect batches of siblings that share a parent and were spawned close together.
  // Uses event order (spawn sequence) rather than timestamps since timestamps may be null.
  const spawnOrder: string[] = []; // agentIds in spawn order
  for (const rawEvent of events) {
    const ev = rawEvent as KnownTopologyEvent;
    if (ev.type === 'topology:agent_spawned' && ev.data.parentId) {
      spawnOrder.push(ev.data.agentId);
    }
  }

  // Group consecutive siblings that share the same parent. Sets the
  // `group` field on each node — the legacy `layered` ELK path used this
  // for compound nodes; the current `mrtree` layout ignores it but it's
  // still set for downstream consumers (analytics, etc.).
  let groupIndex = 0;
  let i = 0;
  while (i < spawnOrder.length) {
    const spawnId = spawnOrder[i] as string;
    const nodeA = nodes.get(spawnId);
    if (!nodeA?.parentId) {
      i++;
      continue;
    }

    // Collect consecutive siblings with the same parent
    const batch: string[] = [spawnId];
    let j = i + 1;
    while (j < spawnOrder.length) {
      const nextId = spawnOrder[j] as string;
      const nodeB = nodes.get(nextId);
      if (!nodeB || nodeB.parentId !== nodeA.parentId) break;
      batch.push(nextId);
      j++;
    }

    // Only group batches of 2+ siblings
    if (batch.length >= 2) {
      const groupId = `group-${groupIndex++}`;
      for (const agentId of batch) {
        const node = nodes.get(agentId);
        if (node) node.group = groupId;
      }
    }

    i = j;
  }

  // --- Synthetic skill nodes ---
  // Per-cluster agent skill rendering is handled in topology-layout.ts,
  // not here. The layout layer knows about *visual* cluster splits (one
  // data-level (parentId, agentType) cluster can render as two boxes
  // when mrtree puts members far apart) and emits one skill pill per
  // visual sub-cluster — that data isn't available at this layer.
  // The map below still holds the task-level injection node from
  // context.skillId, which IS data-driven.
  const skillNodeMap = new Map<string, TopologyNode>();
  const allNodes = Array.from(nodes.values());

  // --- Task-level skill injection node ---
  // When the task has a skill assigned (context.skillId), show it as
  // an injected skill node connected to the root agent.
  const rootNode = allNodes[0];
  if (context.skillId && rootNode) {
    const injectionNodeId = `skill-inject-${context.skillId}`;
    if (!skillNodeMap.has(injectionNodeId)) {
      const injectionNode: TopologyNode = {
        id: injectionNodeId,
        name: context.skillName ?? context.skillId,
        role: 'skill',
        type: 'skill',
        agentType: null,
        skillId: context.skillId,
        skillName: context.skillName ?? context.skillId,
        skillCalls: [],
        agentMeta: null,
        status: 'completed',
        parentId: rootNode.id,
        childIds: [],
        progress: 100,
        tokens: 0,
        cost: 0,
        turns: 0,
        messages: 0,
        startedAt: rootNode.startedAt,
        completedAt: rootNode.startedAt,
        verified: false,
        verificationScore: 0,
        decisions: [],
      };
      skillNodeMap.set(injectionNodeId, injectionNode);
      // Edge: orchestrator -> skill (NOT skill -> orchestrator). The
      // skill is an annotation hanging off the root, not a parent of
      // it: with the reverse direction the skill became a tree root
      // (no incoming edges) and mrtree placed it ABOVE the
      // orchestrator, often offscreen by default. Sourcing the edge
      // from the orchestrator makes the skill render as a child,
      // visible just below the root with the rest of the workflow.
      const edgeId = `${rootNode.id}->skill-inject-${context.skillId}`;
      if (!edges.some((e) => e.id === edgeId)) {
        edges.push({
          id: edgeId,
          sourceId: rootNode.id,
          targetId: injectionNodeId,
        });
      }
    }
  }

  // Merge skill nodes into the main node list
  const finalNodes = [...allNodes, ...skillNodeMap.values()];

  return {
    nodes: finalNodes,
    edges,
    taskId: context.taskId ?? '',
    taskName: context.taskTitle ?? '',
    taskPriority: '',
    skillId: context.skillId ?? null,
    skillName: context.skillName ?? null,
  };
}
