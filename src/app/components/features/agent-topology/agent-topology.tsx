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
import { AgentNode } from './nodes/agent-node';
import { useTopology } from './topology-context';
import { layoutTopology } from './topology-layout';

const nodeTypes = { agentNode: AgentNode };
const edgeTypes = { agentEdge: AgentEdge };

function TopologyInner(): React.JSX.Element {
  const { state, dispatch, selectedNode } = useTopology();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [nodes, setNodes] = useState<ReactFlowNode[]>([]);
  const [edges, setEdges] = useState<ReactFlowEdge[]>([]);
  const layoutInFlight = useRef(false);
  const lastStructureVersion = useRef(-1);

  // Run ELK layout on structural changes only
  const runLayout = useCallback(async () => {
    if (layoutInFlight.current) return;
    layoutInFlight.current = true;
    try {
      const result = await layoutTopology(state.graph);
      setNodes(result.nodes);
      setEdges(result.edges);
    } catch (err) {
      console.error('[AgentTopology] Layout error:', err);
    } finally {
      layoutInFlight.current = false;
    }
  }, [state.graph]);

  useEffect(() => {
    if (state.graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      return;
    }
    if (state.structureVersion !== lastStructureVersion.current) {
      lastStructureVersion.current = state.structureVersion;
      void runLayout();
    } else {
      // Data-only update — update node data in-place without relayout
      const nodeById = new Map(state.graph.nodes.map((n) => [n.id, n]));
      setNodes((prev) =>
        prev.map((rfNode) => {
          const graphNode = nodeById.get(rfNode.id);
          if (!graphNode) return rfNode;
          return {
            ...rfNode,
            data: {
              ...rfNode.data,
              name: graphNode.name,
              role: graphNode.role,
              status: graphNode.status,
              progress: graphNode.progress,
              decisions: graphNode.decisions,
            },
          };
        })
      );
      setEdges((prev) =>
        prev.map((rfEdge) => {
          const sourceNode = nodeById.get(rfEdge.source);
          const targetNode = nodeById.get(rfEdge.target);
          return {
            ...rfEdge,
            data: {
              ...rfEdge.data,
              sourceStatus: sourceNode?.status ?? 'queued',
              targetStatus: targetNode?.status ?? 'queued',
            },
          };
        })
      );
    }
  }, [state.graph, state.structureVersion, runLayout]);

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
        <p className="text-sm text-fg-muted">No topology data available.</p>
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
            fitViewOptions={{ padding: 0.3 }}
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
            onClick={() => fitView({ padding: 0.3 })}
            className="flex h-8 w-8 items-center justify-center rounded-md border border-border bg-surface/90 text-fg-muted backdrop-blur-sm hover:bg-surface-subtle hover:text-fg"
            title="Fit to view"
          >
            <CornersOut className="h-4 w-4" />
          </button>
        </div>

        {/* Legend overlay */}
        <TopologyLegend />
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
