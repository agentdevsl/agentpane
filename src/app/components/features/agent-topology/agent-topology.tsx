import { CornersOut, MagnifyingGlassMinus, MagnifyingGlassPlus } from '@phosphor-icons/react';
import {
  ReactFlow,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  ReactFlowProvider,
  useReactFlow,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import { useCallback, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { TopologyDetailPanel } from './detail-panel/topology-detail-panel';
import { AgentEdge } from './edges/agent-edge';
import { AgentEdgeMarkers } from './edges/agent-edge-markers';
import { SkillEdge } from './edges/skill-edge';
import { TopologyGroupOverlay } from './groups/topology-group-overlay';
import { TopologyLegend } from './legend/topology-legend';
import { AgentNode, type AgentNodeData } from './nodes/agent-node';
import { SkillNode } from './nodes/skill-node';
import { useTopology } from './topology-context';
import { layoutTopology, type TopologyGroupBox } from './topology-layout';

const nodeTypes = { agentNode: AgentNode, skillNode: SkillNode };
const edgeTypes = { agentEdge: AgentEdge, skillEdge: SkillEdge };
const FIT_VIEW_OPTIONS = { padding: 0.02, maxZoom: 3 };

function TopologyInner(): React.JSX.Element {
  const { state, dispatch, selectedNode, sessionId } = useTopology();
  const { fitView, zoomIn, zoomOut } = useReactFlow();
  const [nodes, setNodes] = useState<ReactFlowNode[]>([]);
  const [edges, setEdges] = useState<ReactFlowEdge[]>([]);
  const [groups, setGroups] = useState<TopologyGroupBox[]>([]);
  const layoutInFlight = useRef(false);
  const lastStructureVersion = useRef(-1);

  // Keep a ref to graph data so runLayout can read the latest without being recreated
  const graphRef = useRef(state.graph);
  graphRef.current = state.graph;

  // Stable runLayout -- reads graph from ref, never recreated
  const runLayout = useCallback(async () => {
    if (layoutInFlight.current) return;
    layoutInFlight.current = true;
    try {
      const result = await layoutTopology(graphRef.current);
      setNodes(result.nodes);
      setEdges(result.edges);
      setGroups(result.groups);
      // Re-fit after the new positions render so the view stays centered
      // when nodes are added/removed.
      requestAnimationFrame(() => {
        requestAnimationFrame(() => fitView(FIT_VIEW_OPTIONS));
      });
    } catch (err) {
      console.error('[AgentTopology] Layout error:', err);
    } finally {
      layoutInFlight.current = false;
    }
  }, [fitView]);

  // Structural changes -- trigger full ELK relayout
  useWatchEffect(() => {
    if (state.graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setGroups([]);
      lastStructureVersion.current = state.structureVersion;
      return;
    }
    if (state.structureVersion !== lastStructureVersion.current) {
      lastStructureVersion.current = state.structureVersion;
      void runLayout();
    }
  }, [state.structureVersion, runLayout, state.graph.nodes.length]);

  // Data-only updates -- patch ReactFlow node/edge data without relayout.
  // Only creates new data objects when values actually changed, so React.memo
  // on AgentNode can skip re-renders for untouched nodes.
  // Uses graphRef to read the latest graph data without adding it as a dependency;
  // dataVersion is the sole trigger for this effect.
  useWatchEffect(() => {
    const graph = graphRef.current;
    if (graph.nodes.length === 0) return;

    const nodeById = new Map(graph.nodes.map((n) => [n.id, n]));

    setNodes((prev) => {
      let changed = false;
      const next = prev.map((rfNode) => {
        const graphNode = nodeById.get(rfNode.id);
        if (!graphNode) return rfNode;
        const d = rfNode.data as AgentNodeData;
        // Compare each field -- only create a new object if something differs
        if (
          d.name === graphNode.name &&
          d.role === graphNode.role &&
          d.agentType === graphNode.agentType &&
          d.status === graphNode.status &&
          d.progress === graphNode.progress &&
          d.decisions === graphNode.decisions &&
          d.tokens === graphNode.tokens &&
          d.cost === graphNode.cost &&
          d.turns === graphNode.turns &&
          d.skillId === graphNode.skillId &&
          d.skillName === graphNode.skillName &&
          d.skillCalls === graphNode.skillCalls &&
          d.agentMeta === graphNode.agentMeta &&
          d.phase === graphNode.phase
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
            agentType: graphNode.agentType,
            status: graphNode.status,
            progress: graphNode.progress,
            decisions: graphNode.decisions,
            tokens: graphNode.tokens,
            cost: graphNode.cost,
            turns: graphNode.turns,
            skillId: graphNode.skillId,
            skillName: graphNode.skillName,
            skillCalls: graphNode.skillCalls,
            agentMeta: graphNode.agentMeta,
            phase: graphNode.phase,
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
        const d = rfEdge.data as { sourceStatus?: string; targetStatus?: string } | undefined;
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
      <div
        data-testid="topology-empty"
        className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center"
      >
        <p className="text-sm font-medium text-fg-muted">No subagent topology yet</p>
        <p className="max-w-sm text-xs text-fg-subtle">
          The topology graph appears when the agent spawns subagents during execution. Subagent
          events are captured in real-time from the SDK.
        </p>
      </div>
    );
  }

  return (
    <div data-testid="topology-canvas" className="flex h-full min-h-0 min-w-0">
      {/* Canvas */}
      <div className="relative flex-1 min-h-0 min-w-0">
        <div
          className="h-full w-full bg-canvas"
          style={{
            backgroundImage:
              'radial-gradient(circle, var(--border-default) 0.5px, transparent 0.5px)',
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
            <TopologyGroupOverlay groups={groups} />
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

        {/* Skill overlay */}
        {state.graph.skillName && (
          <div className="absolute right-4 top-4 z-10 flex items-center gap-2 rounded-lg border border-border bg-surface/90 px-3 py-1.5 backdrop-blur-sm">
            <svg
              width="14"
              height="14"
              viewBox="0 0 256 256"
              fill="currentColor"
              className="text-accent"
              role="img"
              aria-label="Skill"
            >
              <path d="M215.79,118.17a8,8,0,0,0-5-5.66L153.18,90.9l14.66-73.33a8,8,0,0,0-13.69-7l-112,120a8,8,0,0,0,3,13l57.63,21.61L88.16,238.43a8,8,0,0,0,13.69,7l112-120A8,8,0,0,0,215.79,118.17Z" />
            </svg>
            <span className="text-xs font-medium text-fg-default">{state.graph.skillName}</span>
          </div>
        )}

        {/* Legend overlay -- hidden for single-node view */}
        {state.graph.nodes.length > 1 && <TopologyLegend />}
      </div>

      {/* Detail panel */}
      <TopologyDetailPanel
        node={selectedNode}
        allNodes={state.graph.nodes}
        taskName={state.graph.taskName}
        taskPriority={state.graph.taskPriority}
        sessionId={sessionId}
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
