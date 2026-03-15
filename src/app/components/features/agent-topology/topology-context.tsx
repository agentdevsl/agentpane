import {
  createContext,
  type ReactNode,
  useContext,
  useEffect,
  useMemo,
  useReducer,
  useRef,
} from 'react';
import { useTopologyStream } from '@/app/hooks/use-topology-stream';
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
    totalTokens: graph.nodes.reduce((sum, n) => sum + n.tokens, 0),
    totalCost: graph.nodes.reduce((sum, n) => sum + n.cost, 0),
    totalDecisions: graph.nodes.reduce((sum, n) => sum + n.decisions.length, 0),
  };
}

function topologyReducer(state: TopologyState, action: TopologyAction): TopologyState {
  switch (action.type) {
    case 'ADD_NODE': {
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
      return { ...state, graph: newGraph, metrics: computeMetrics(newGraph) };
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
      return { ...state, graph: newGraph, metrics: computeMetrics(newGraph) };
    }
    case 'ADD_DECISION': {
      const newNodes = state.graph.nodes.map((n) =>
        n.id === action.nodeId ? { ...n, decisions: [...n.decisions, action.decision] } : n
      );
      const newGraph = { ...state.graph, nodes: newNodes };
      return { ...state, graph: newGraph, metrics: computeMetrics(newGraph) };
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
  };

  const [state, dispatch] = useReducer(topologyReducer, initial);

  // Sync initialData prop changes into reducer (skip first render — already in initial state)
  const prevInitialDataRef = useRef(initialData);
  useEffect(() => {
    if (initialData && initialData !== prevInitialDataRef.current) {
      prevInitialDataRef.current = initialData;
      dispatch({ type: 'REPLACE_GRAPH', graph: initialData });
    }
  }, [initialData]);

  // Subscribe to live topology events when sessionId is provided
  useTopologyStream(sessionId, dispatch);

  const selectedNode = useMemo(
    () => state.graph.nodes.find((n) => n.id === state.selectedNodeId) ?? null,
    [state.graph.nodes, state.selectedNodeId]
  );

  const value = useMemo(() => ({ state, dispatch, selectedNode }), [state, selectedNode]);

  return <TopologyContext.Provider value={value}>{children}</TopologyContext.Provider>;
}
