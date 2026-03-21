import { createContext, type ReactNode, useContext, useMemo, useReducer, useRef } from 'react';
import { useTopologyStream } from '@/app/hooks/use-topology-stream';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { TopologyDecision, TopologyGraph, TopologyNode } from '@/lib/topology/types';

interface TopologyMetrics {
  totalAgents: number;
  activeAgents: number;
  completedAgents: number;
  totalTokens: number;
  totalCost: number;
  totalDecisions: number;
}

interface TopologyState {
  graph: TopologyGraph;
  metrics: TopologyMetrics;
  selectedNodeId: string | null;
  showDecisions: boolean;
  /** Incremented on structural changes (node add/remove) to trigger relayout */
  structureVersion: number;
  /** Incremented on data-only changes (UPDATE_NODE) to track changes without expensive recomputation */
  dataVersion: number;
}

export type TopologyAction =
  | {
      type: 'ADD_NODE';
      node: TopologyNode;
      edges?: Array<{ id: string; sourceId: string; targetId: string }>;
    }
  | { type: 'UPDATE_NODE'; nodeId: string; updates: Partial<TopologyNode> }
  | {
      type: 'COMPLETE_NODE';
      nodeId: string;
      status: 'completed' | 'failed' | 'stopped';
      completedAt: number;
    }
  | { type: 'ADD_DECISION'; nodeId: string; decision: TopologyDecision }
  | { type: 'REPLACE_GRAPH'; graph: TopologyGraph }
  | { type: 'SELECT_NODE'; nodeId: string | null }
  | { type: 'TOGGLE_DECISIONS' };

function computeMetrics(graph: TopologyGraph): TopologyMetrics {
  return {
    totalAgents: graph.nodes.length,
    activeAgents: graph.nodes.filter((n) => n.status === 'running' || n.status === 'verifying')
      .length,
    completedAgents: graph.nodes.filter((n) => n.status === 'completed').length,
    totalTokens: graph.nodes.reduce(
      (sum, n) => sum + (Number.isFinite(n.tokens) ? n.tokens : 0),
      0
    ),
    totalCost: graph.nodes.reduce((sum, n) => sum + (Number.isFinite(n.cost) ? n.cost : 0), 0),
    totalDecisions: graph.nodes.reduce((sum, n) => sum + n.decisions.length, 0),
  };
}

function topologyReducer(state: TopologyState, action: TopologyAction): TopologyState {
  switch (action.type) {
    case 'ADD_NODE': {
      // Deduplicate: if node already exists (e.g. root from initialData), update it
      const existingIdx = state.graph.nodes.findIndex((n) => n.id === action.node.id);
      if (existingIdx >= 0) {
        const updatedNodes = state.graph.nodes.map((n, i) =>
          i === existingIdx ? { ...n, ...action.node } : n
        );
        const existingEdgeIds = new Set(state.graph.edges.map((e) => e.id));
        const newEdges = action.edges ? action.edges.filter((e) => !existingEdgeIds.has(e.id)) : [];
        const hasNewEdges = newEdges.length > 0;
        const newGraph = {
          ...state.graph,
          nodes: updatedNodes,
          edges: hasNewEdges ? [...state.graph.edges, ...newEdges] : state.graph.edges,
        };
        return {
          ...state,
          graph: newGraph,
          metrics: computeMetrics(newGraph),
          dataVersion: state.dataVersion + 1,
          ...(hasNewEdges ? { structureVersion: state.structureVersion + 1 } : {}),
        };
      }
      const parentId = action.node.parentId;
      // Update parent's childIds if the new node has a parent
      const updatedNodes = parentId
        ? state.graph.nodes.map((n) =>
            n.id === parentId ? { ...n, childIds: [...n.childIds, action.node.id] } : n
          )
        : [...state.graph.nodes];
      updatedNodes.push(action.node);
      const newGraph = {
        ...state.graph,
        nodes: updatedNodes,
        edges: action.edges ? [...state.graph.edges, ...action.edges] : state.graph.edges,
      };
      return {
        ...state,
        graph: newGraph,
        metrics: computeMetrics(newGraph),
        structureVersion: state.structureVersion + 1,
      };
    }
    case 'UPDATE_NODE': {
      const newNodes = state.graph.nodes.map((n) =>
        n.id === action.nodeId ? { ...n, ...action.updates } : n
      );
      const newGraph = { ...state.graph, nodes: newNodes };
      // Skip computeMetrics for progress updates — use dataVersion to track changes cheaply
      return { ...state, graph: newGraph, dataVersion: state.dataVersion + 1 };
    }
    case 'COMPLETE_NODE': {
      const newNodes = state.graph.nodes.map(
        (n): TopologyNode =>
          n.id === action.nodeId
            ? {
                ...n,
                status: action.status,
                completedAt: action.completedAt,
                progress: action.status === 'completed' ? 100 : n.progress,
              }
            : n
      );
      const newGraph = { ...state.graph, nodes: newNodes };
      return {
        ...state,
        graph: newGraph,
        metrics: computeMetrics(newGraph),
        dataVersion: state.dataVersion + 1,
      };
    }
    case 'ADD_DECISION': {
      const newNodes = state.graph.nodes.map((n) =>
        n.id === action.nodeId ? { ...n, decisions: [...n.decisions, action.decision] } : n
      );
      const newGraph = { ...state.graph, nodes: newNodes };
      return {
        ...state,
        graph: newGraph,
        metrics: computeMetrics(newGraph),
        dataVersion: state.dataVersion + 1,
      };
    }
    case 'REPLACE_GRAPH':
      return {
        ...state,
        graph: action.graph,
        metrics: computeMetrics(action.graph),
        structureVersion: state.structureVersion + 1,
      };
    case 'SELECT_NODE':
      return { ...state, selectedNodeId: action.nodeId };
    case 'TOGGLE_DECISIONS':
      return { ...state, showDecisions: !state.showDecisions };
    default:
      return state;
  }
}

const EMPTY_GRAPH: TopologyGraph = {
  nodes: [],
  edges: [],
  taskId: '',
  taskName: '',
  taskPriority: '',
};

interface TopologyContextValue {
  state: TopologyState;
  dispatch: React.Dispatch<TopologyAction>;
  selectedNode: TopologyNode | null;
}

const TopologyContext = createContext<TopologyContextValue | null>(null);

export function useTopology(): TopologyContextValue {
  const ctx = useContext(TopologyContext);
  if (!ctx) throw new Error('useTopology must be used within TopologyProvider');
  return ctx;
}

interface TopologyProviderProps {
  children: ReactNode;
  sessionId?: string;
  initialData?: TopologyGraph;
}

export function TopologyProvider({ children, sessionId, initialData }: TopologyProviderProps) {
  const initial: TopologyState = {
    graph: initialData ?? EMPTY_GRAPH,
    metrics: computeMetrics(initialData ?? EMPTY_GRAPH),
    selectedNodeId: null,
    showDecisions: true,
    structureVersion: 0,
    dataVersion: 0,
  };

  const [state, dispatch] = useReducer(topologyReducer, initial);

  // Sync initialData prop changes into reducer (skip first render — already in initial state)
  const prevInitialDataRef = useRef(initialData);
  useWatchEffect(() => {
    if (initialData && initialData !== prevInitialDataRef.current) {
      prevInitialDataRef.current = initialData;
      dispatch({ type: 'REPLACE_GRAPH', graph: initialData });
    }
  }, [initialData]);

  // Subscribe to live topology events when sessionId is provided.
  // Note: The session detail view already subscribes via useSessionEvents.
  // Passing undefined avoids opening a duplicate SSE connection which crashes the stream client.
  // Topology events from the existing subscription are routed via the container-agent hook instead.
  // Only subscribe when used standalone (e.g., container-agent-panel which passes sessionId directly).
  console.debug('[TopologyProvider] render', { sessionId, nodeCount: state.graph.nodes.length });
  useTopologyStream(sessionId, dispatch);

  const selectedNode = useMemo(
    () => state.graph.nodes.find((n) => n.id === state.selectedNodeId) ?? null,
    [state.graph.nodes, state.selectedNodeId]
  );

  const value = useMemo(() => ({ state, dispatch, selectedNode }), [state, selectedNode]);

  return <TopologyContext.Provider value={value}>{children}</TopologyContext.Provider>;
}
