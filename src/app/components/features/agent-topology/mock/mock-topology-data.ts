import type {
  TopologyAgentRole,
  TopologyAgentStatus,
  TopologyDecision,
  TopologyEdge,
  TopologyGraph,
  TopologyNode,
} from '@/lib/topology/types';

const now = Date.now();
const minutesAgo = (m: number) => now - m * 60_000;

function makeNode(
  id: string,
  name: string,
  role: TopologyAgentRole,
  status: TopologyAgentStatus,
  parentId: string | null,
  childIds: string[],
  overrides: Partial<TopologyNode> = {}
): TopologyNode {
  return {
    id,
    name,
    role,
    status,
    parentId,
    childIds,
    progress: 0,
    tokens: 0,
    cost: 0,
    turns: 0,
    messages: 0,
    startedAt: null,
    completedAt: null,
    verified: false,
    verificationScore: 0,
    decisions: [],
    ...overrides,
  };
}

function makeEdge(sourceId: string, targetId: string): TopologyEdge {
  return { id: `${sourceId}->${targetId}`, sourceId, targetId };
}

const orchestratorDecisions: TopologyDecision[] = [
  {
    id: 'dec-1',
    agentId: 'ap-orch',
    type: 'spawn',
    summary: 'Spawned planner agent to decompose API v2 requirements',
    confidence: 0.95,
    timestamp: minutesAgo(12),
  },
  {
    id: 'dec-2',
    agentId: 'ap-orch',
    type: 'delegate',
    summary: 'Delegated route, model, and middleware tasks to coders',
    confidence: 0.9,
    timestamp: minutesAgo(8),
    alternatives: ['Single coder for all', 'Two coders: routes+models and middleware'],
  },
  {
    id: 'dec-3',
    agentId: 'ap-orch',
    type: 'prioritize',
    summary: 'Prioritized routes and models over middleware due to dependencies',
    confidence: 0.85,
    timestamp: minutesAgo(7),
  },
];

const routesCoderDecisions: TopologyDecision[] = [
  {
    id: 'dec-4',
    agentId: 'ap-code1',
    type: 'tool_select',
    summary: 'Using Edit tool for route handler updates',
    confidence: 0.92,
    timestamp: minutesAgo(5),
  },
];

const modelsCoderDecisions: TopologyDecision[] = [
  {
    id: 'dec-5',
    agentId: 'ap-code2',
    type: 'auto_verify',
    summary: 'Schema migration passes validation checks',
    confidence: 0.88,
    timestamp: minutesAgo(3),
  },
];

export function createLargeTopologyGraph(): TopologyGraph {
  const nodes: TopologyNode[] = [
    makeNode('ap-orch', 'API Orchestrator', 'orchestrator', 'completed', null, ['ap-plan'], {
      progress: 100,
      tokens: 15420,
      cost: 0.046,
      turns: 8,
      messages: 16,
      startedAt: minutesAgo(14),
      completedAt: minutesAgo(10),
      verified: true,
      verificationScore: 100,
      decisions: orchestratorDecisions,
    }),
    makeNode(
      'ap-plan',
      'API Planner',
      'planner',
      'completed',
      'ap-orch',
      ['ap-code1', 'ap-code2', 'ap-code3'],
      {
        progress: 100,
        tokens: 22800,
        cost: 0.068,
        turns: 12,
        messages: 24,
        startedAt: minutesAgo(10),
        completedAt: minutesAgo(6),
        verified: true,
        verificationScore: 95,
        decisions: [],
      }
    ),
    makeNode('ap-code1', 'Routes Coder', 'coder', 'running', 'ap-plan', ['ap-rev1'], {
      progress: 65,
      tokens: 18300,
      cost: 0.055,
      turns: 9,
      messages: 18,
      startedAt: minutesAgo(5),
      decisions: routesCoderDecisions,
    }),
    makeNode('ap-code2', 'Models Coder', 'coder', 'running', 'ap-plan', ['ap-rev1'], {
      progress: 42,
      tokens: 12100,
      cost: 0.036,
      turns: 6,
      messages: 12,
      startedAt: minutesAgo(4),
      decisions: modelsCoderDecisions,
    }),
    makeNode('ap-code3', 'Middleware Coder', 'coder', 'running', 'ap-plan', ['ap-rev2'], {
      progress: 78,
      tokens: 20500,
      cost: 0.062,
      turns: 11,
      messages: 22,
      startedAt: minutesAgo(5),
      decisions: [],
    }),
    makeNode('ap-rev1', 'API Reviewer', 'reviewer', 'queued', 'ap-plan', ['ap-test1'], {
      decisions: [],
    }),
    makeNode('ap-rev2', 'Security Reviewer', 'reviewer', 'queued', 'ap-plan', ['ap-test2'], {
      decisions: [],
    }),
    makeNode('ap-test1', 'Integration Tester', 'tester', 'queued', 'ap-rev1', ['ap-scan'], {
      decisions: [],
    }),
    makeNode('ap-test2', 'Security Tester', 'tester', 'queued', 'ap-rev2', ['ap-scan'], {
      decisions: [],
    }),
    makeNode('ap-scan', 'Vuln Scanner', 'scanner', 'queued', null, [], {
      decisions: [],
    }),
  ];

  const edges: TopologyEdge[] = [
    makeEdge('ap-orch', 'ap-plan'),
    makeEdge('ap-plan', 'ap-code1'),
    makeEdge('ap-plan', 'ap-code2'),
    makeEdge('ap-plan', 'ap-code3'),
    makeEdge('ap-code1', 'ap-rev1'),
    makeEdge('ap-code2', 'ap-rev1'),
    makeEdge('ap-code3', 'ap-rev2'),
    makeEdge('ap-rev1', 'ap-test1'),
    makeEdge('ap-rev2', 'ap-test2'),
    makeEdge('ap-test1', 'ap-scan'),
    makeEdge('ap-test2', 'ap-scan'),
  ];

  return {
    nodes,
    edges,
    taskId: 'api-platform',
    taskName: 'API Platform v2',
    taskPriority: 'P0',
  };
}

export function createSmallTopologyGraph(): TopologyGraph {
  const nodes: TopologyNode[] = [
    makeNode('sm-orch', 'Orchestrator', 'orchestrator', 'completed', null, ['sm-code'], {
      progress: 100,
      tokens: 8200,
      cost: 0.025,
      turns: 4,
      messages: 8,
      startedAt: minutesAgo(6),
      completedAt: minutesAgo(4),
      verified: true,
      verificationScore: 100,
      decisions: [
        {
          id: 'sm-dec-1',
          agentId: 'sm-orch',
          type: 'spawn',
          summary: 'Spawned coder for implementation',
          confidence: 0.95,
          timestamp: minutesAgo(5),
        },
      ],
    }),
    makeNode('sm-code', 'Coder', 'coder', 'running', 'sm-orch', ['sm-test'], {
      progress: 55,
      tokens: 14600,
      cost: 0.044,
      turns: 7,
      messages: 14,
      startedAt: minutesAgo(4),
      decisions: [],
    }),
    makeNode('sm-test', 'Tester', 'tester', 'queued', 'sm-code', [], {
      decisions: [],
    }),
  ];

  const edges: TopologyEdge[] = [makeEdge('sm-orch', 'sm-code'), makeEdge('sm-code', 'sm-test')];

  return {
    nodes,
    edges,
    taskId: 'small-task',
    taskName: 'Bug Fix #42',
    taskPriority: 'P2',
  };
}

export function createMockSimulation(graph: TopologyGraph) {
  let current = structuredClone(graph);
  let tickCount = 0;

  function canAdvance(node: TopologyNode): boolean {
    if (node.status === 'completed') return false;
    // A node can advance only if all its source parents (nodes that have edges pointing to it) are completed
    const parentNodes = current.edges
      .filter((e) => e.targetId === node.id)
      .map((e) => current.nodes.find((n) => n.id === e.sourceId))
      .filter(Boolean) as TopologyNode[];
    return parentNodes.length === 0 || parentNodes.every((p) => p.status === 'completed');
  }

  function tick(): TopologyGraph {
    tickCount++;
    current = structuredClone(current);

    for (const node of current.nodes) {
      if (!canAdvance(node)) continue;

      if (node.status === 'queued') {
        node.status = 'running';
        node.startedAt = Date.now();
        node.progress = 10;
        continue;
      }

      if (node.status === 'running') {
        node.progress = Math.min(100, node.progress + 15 + Math.floor(tickCount % 3) * 5);
        node.tokens += 1200 + tickCount * 100;
        node.cost = Number.parseFloat((node.tokens * 0.000003).toFixed(4));
        node.turns += 1;
        node.messages += 2;

        if (node.progress >= 100) {
          node.status = 'verifying';
          node.progress = 100;
        }
        continue;
      }

      if (node.status === 'verifying') {
        node.status = 'completed';
        node.completedAt = Date.now();
        node.verified = true;
        node.verificationScore = 85 + Math.floor(tickCount % 3) * 5;
      }
    }

    return current;
  }

  return { tick };
}
