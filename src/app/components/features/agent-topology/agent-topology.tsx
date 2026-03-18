import { CornersOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import {
  ReactFlow,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useEffect, useRef, useState } from 'react';
import { TopologyDetailPanel } from './detail-panel/topology-detail-panel';
import { AgentEdge } from './edges/agent-edge';
import { AgentEdgeMarkers } from './edges/agent-edge-markers';
import { TopologyLegend } from './legend/topology-legend';
import { AgentNode, type AgentNodeData } from './nodes/agent-node';
import { useTopology } from './topology-context';
import { layoutTopology } from './topology-layout';

const nodeTypes = { agentNode: AgentNode };
const edgeTypes = { agentEdge: AgentEdge };
const FIT_VIEW_OPTIONS = { padding: 0.3, maxZoom: 1 };

function TopologyInner(): React.JSX.Element {
  const { state, dispatch, selectedNode } = useTopology();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [nodes, setNodes] = useState<ReactFlowNode[]>([]);
  const [edges, setEdges] = useState<ReactFlowEdge[]>([]);
  const layoutInFlight = useRef(false);
  const lastStructureVersion = useRef(-1);

  // Keep a ref to graph data so runLayout can read the latest without being recreated
  const graphRef = useRef(state.graph);
  graphRef.current = state.graph;

  // Stable runLayout — reads graph from ref, never recreated
  const runLayout = useCallback(async () => {
    if (layoutInFlight.current) return;
    layoutInFlight.current = true;
    try {
      const result = await layoutTopology(graphRef.current);
      setNodes(result.nodes);
      setEdges(result.edges);
    } catch (err) {
      console.error('[AgentTopology] Layout error:', err);
    } finally {
      layoutInFlight.current = false;
    }
  }, []);

  // Structural changes — trigger full ELK relayout
  useEffect(() => {
    if (state.graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      lastStructureVersion.current = state.structureVersion;
      return;
    }
    if (state.structureVersion !== lastStructureVersion.current) {
      lastStructureVersion.current = state.structureVersion;
      void runLayout();
    }
  }, [state.structureVersion, runLayout, state.graph.nodes.length]);

  // Data-only updates — patch ReactFlow node/edge data without relayout.
  // Only creates new data objects when values actually changed, so React.memo
  // on AgentNode can skip re-renders for untouched nodes.
  // Uses graphRef to read the latest graph data without adding it as a dependency;
  // dataVersion is the sole trigger for this effect.
  // biome-ignore lint/correctness/useExhaustiveDependencies: dataVersion is the intentional trigger; graph data is read from graphRef to avoid re-firing on every graph reference change
  useEffect(() => {
    const graph = graphRef.current;
    if (graph.nodes.length === 0) return;

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

    setNodes((prev) => {
      let changed = false;
      const next = prev.map((rfNode) => {
        const graphNode = nodeById.get(rfNode.id);
        if (!graphNode) return rfNode;
        const d = rfNode.data as AgentNodeData;
        // Compare each field — only create a new object if something differs
        if (
          d.name === graphNode.name &&
          d.role === graphNode.role &&
          d.status === graphNode.status &&
          d.progress === graphNode.progress &&
          d.decisions === graphNode.decisions &&
          d.tokens === graphNode.tokens &&
          d.cost === graphNode.cost &&
          d.turns === graphNode.turns
        ) {
          return rfNode;
        }
        changed = true;
        return {
          ...rfNode,
          data: {
            ...rfNode.data,
            name: graphNode.name,
            role: graphNode.role,
            status: graphNode.status,
            progress: graphNode.progress,
            decisions: graphNode.decisions,
            tokens: graphNode.tokens,
            cost: graphNode.cost,
            turns: graphNode.turns,
          },
        };
      });
      return changed ? next : prev;
    });

    setEdges((prev) => {
      let changed = false;
      const next = prev.map((rfEdge) => {
        const sourceNode = nodeById.get(rfEdge.source);
        const targetNode = nodeById.get(rfEdge.target);
        const sourceStatus = sourceNode?.status ?? 'queued';
        const targetStatus = targetNode?.status ?? 'queued';
        const d = rfEdge.data as Record<string, unknown> | undefined;
        if (d && d.sourceStatus === sourceStatus && d.targetStatus === targetStatus) {
          return rfEdge;
        }
        changed = true;
        return {
          ...rfEdge,
          data: {
            ...rfEdge.data,
            sourceStatus,
            targetStatus,
          },
        };
      });
      return changed ? next : prev;
    });
  }, [state.dataVersion]);

  const handleNodeClick = useCallback(
    (_: React.MouseEvent, node: ReactFlowNode) => {
      dispatch({ type: 'SELECT_NODE', nodeId: node.id });
    },
    [dispatch]
  );

  const handlePaneClick = useCallback(() => {
    dispatch({ type: 'SELECT_NODE', nodeId: null });
  }, [dispatch]);

  const isEmpty = state.graph.nodes.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <p className="text-sm font-medium text-fg-muted">No subagent topology yet</p>
        <p className="max-w-sm text-xs text-fg-subtle">
          The topology graph appears when the agent spawns subagents during execution. Subagent
          events are captured in real-time from the SDK.
        </p>
      </div>
    );
  }

  return (
    <div className="flex flex-1 min-h-0 min-w-0">
      {/* Canvas */}
      <div className="relative flex-1 min-h-0 min-w-0">
        <div
          className="h-full w-full"
          style={{
            backgroundImage:
              'radial-gradient(circle, var(--color-border-subtle) 0.5px, transparent 0.5px)',
            backgroundSize: '32px 32px',
          }}
        >
          <ReactFlow
            nodes={nodes}
            edges={edges}
            nodeTypes={nodeTypes}
            edgeTypes={edgeTypes}
            fitView
            fitViewOptions={FIT_VIEW_OPTIONS}
            panOnDrag
            zoomOnScroll
            zoomOnPinch
            nodesDraggable={false}
            nodesConnectable={false}
            elementsSelectable
            onNodeClick={handleNodeClick}
            onPaneClick={handlePaneClick}
            proOptions={{ hideAttribution: true }}
            minZoom={0.3}
            maxZoom={3}
          >
            <AgentEdgeMarkers />
          </ReactFlow>
        </div>

        {/* Toolbar overlay */}
        <div className="absolute left-4 top-4 flex flex-col gap-1">
          <button
            type="button"
            onClick={() => zoomIn()}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface/90 text-fg-muted backdrop-blur-sm hover:bg-surface-subtle hover:text-fg"
            title="Zoom in"
          >
            <MagnifyingGlassPlus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => zoomOut()}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface/90 text-fg-muted backdrop-blur-sm hover:bg-surface-subtle hover:text-fg"
            title="Zoom out"
          >
            <MagnifyingGlassMinus className="h-4 w-4" />
          </button>
          <button
            type="button"
            onClick={() => fitView(FIT_VIEW_OPTIONS)}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface/90 text-fg-muted backdrop-blur-sm hover:bg-surface-subtle hover:text-fg"
            title="Fit to view"
          >
            <CornersOut className="h-4 w-4" />
          </button>
        </div>

        {/* Legend overlay — hidden for single-node view */}
        {state.graph.nodes.length > 1 && <TopologyLegend />}

        {/* Subtle radial vignette for single-node view */}
        {state.graph.nodes.length === 1 && (
          <div
            className="pointer-events-none absolute inset-0"
            style={{
              background:
                'radial-gradient(ellipse at center, transparent 40%, rgba(13,17,23,0.4) 100%)',
            }}
          />
        )}
      </div>

      {/* Detail panel */}
      <TopologyDetailPanel
        node={selectedNode}
        allNodes={state.graph.nodes}
        taskName={state.graph.taskName}
        taskPriority={state.graph.taskPriority}
        onClose={() => dispatch({ type: 'SELECT_NODE', nodeId: null })}
      />
    </div>
  );
}

export function AgentTopology(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <TopologyInner />
    </ReactFlowProvider>
  );
}
