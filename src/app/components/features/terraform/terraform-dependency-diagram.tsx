import { GitBranch } from '@phosphor-icons/react';
import {
  ReactFlow,
  type Edge as ReactFlowEdge,
  type Node as ReactFlowNode,
  ReactFlowProvider,
} from '@xyflow/react';
import '@xyflow/react/dist/style.css';
import type { ElkNode } from 'elkjs/lib/elk.bundled.js';
import { useCallback, useMemo, useRef, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { parseHclDependencies, type TerraformGraph } from '@/lib/terraform/parse-hcl-dependencies';
import { parseStacksDependencies } from '@/lib/terraform/parse-stacks-dependencies';
import { getElk } from '@/lib/workflow-dsl/layout';
import { useTerraform } from './terraform-context';
import { TerraformDependencyEdge, TerraformEdgeMarkers } from './terraform-dependency-edge';
import { TerraformModuleNode } from './terraform-module-node';

const nodeTypes = { terraformModule: TerraformModuleNode };
const edgeTypes = { terraformDependency: TerraformDependencyEdge };

const NODE_WIDTH = 220;
const NODE_HEIGHT = 36;

async function layoutGraph(
  graph: TerraformGraph
): Promise<{ nodes: ReactFlowNode[]; edges: ReactFlowEdge[] }> {
  if (graph.nodes.length === 0) return { nodes: [], edges: [] };

  const elk = await getElk();
  const elkGraph: ElkNode = {
    id: 'root',
    layoutOptions: {
      'elk.algorithm': 'layered',
      'elk.direction': 'DOWN',
      'elk.spacing.nodeNode': '120',
      'elk.layered.spacing.nodeNodeBetweenLayers': '120',
      'elk.edgeRouting': 'ORTHOGONAL',
      'elk.layered.crossingMinimization.strategy': 'LAYER_SWEEP',
      'elk.layered.nodePlacement.strategy': 'NETWORK_SIMPLEX',
      'elk.contentAlignment': 'H_CENTER V_TOP',
      'elk.layered.mergeEdges': 'false',
      'elk.spacing.edgeNode': '80',
      'elk.layered.spacing.edgeEdgeBetweenLayers': '40',
      'elk.layered.spacing.edgeNodeBetweenLayers': '80',
      'elk.layered.thoroughness': '10',
    },
    children: graph.nodes.map((n) => ({
      id: n.id,
      width: NODE_WIDTH,
      height: NODE_HEIGHT,
      properties: {
        'org.eclipse.elk.portConstraints': 'FIXED_POS',
      },
      ports: [
        {
          id: `${n.id}__target`,
          properties: { 'org.eclipse.elk.port.side': 'NORTH' },
          x: NODE_WIDTH / 2,
          y: 0,
          width: 1,
          height: 1,
        },
        {
          id: `${n.id}__source`,
          properties: { 'org.eclipse.elk.port.side': 'SOUTH' },
          x: NODE_WIDTH / 2,
          y: NODE_HEIGHT,
          width: 1,
          height: 1,
        },
      ],
    })),
    edges: graph.edges.map((e) => ({
      id: e.id,
      sources: [`${e.source}__source`],
      targets: [`${e.target}__target`],
    })),
  };

  const layouted = await elk.layout(elkGraph);
  const children = layouted.children ?? [];

  // Extract ELK edge routing (bend points that avoid nodes)
  const elkEdgeMap = new Map<string, Array<{ x: number; y: number }>>();
  for (const elkEdge of layouted.edges ?? []) {
    const section = elkEdge.sections?.[0];
    if (section) {
      elkEdgeMap.set(elkEdge.id, [
        section.startPoint,
        ...(section.bendPoints ?? []),
        section.endPoint,
      ]);
    }
  }

  const rfNodes: ReactFlowNode[] = children
    .map((child: ElkNode, index: number) => {
      const graphNode = graph.nodes.find((n) => n.id === child.id);
      if (!graphNode) return undefined;
      return {
        id: child.id,
        type: 'terraformModule' as const,
        position: { x: child.x ?? 0, y: child.y ?? 0 },
        data: {
          label: graphNode.label,
          provider: graphNode.provider,
          confidence: graphNode.confidence,
          nodeIndex: index,
        },
        draggable: false,
        connectable: false,
      };
    })
    .filter((n: ReactFlowNode | undefined): n is ReactFlowNode => n !== undefined);

  const rfEdges: ReactFlowEdge[] = graph.edges.map((e) => ({
    id: e.id,
    source: e.source,
    target: e.target,
    sourceHandle: 'source',
    targetHandle: 'target',
    type: 'terraformDependency',
    data: {
      edgeType: e.type,
      outputs: e.label,
      elkPoints: elkEdgeMap.get(e.id) ?? null,
    },
  }));

  return { nodes: rfNodes, edges: rfEdges };
}

function DiagramInner(): React.JSX.Element {
  const { generatedCode, generatedFiles, composeMode, matchedModules } = useTerraform();
  const [nodes, setNodes] = useState<ReactFlowNode[]>([]);
  const [edges, setEdges] = useState<ReactFlowEdge[]>([]);
  const [isEmpty, setIsEmpty] = useState(true);
  const layoutInFlight = useRef(false);

  const graph = useMemo(() => {
    if (composeMode === 'stacks') {
      if (!generatedFiles?.length) return null;
      return parseStacksDependencies(generatedFiles, matchedModules);
    }
    if (!generatedCode) return null;
    return parseHclDependencies(generatedCode, matchedModules);
  }, [composeMode, generatedCode, generatedFiles, matchedModules]);

  const runLayout = useCallback(async (g: TerraformGraph) => {
    if (layoutInFlight.current) return;
    layoutInFlight.current = true;
    try {
      const result = await layoutGraph(g);
      setNodes(result.nodes);
      setEdges(result.edges);
      setIsEmpty(result.nodes.length === 0);
    } catch (err) {
      console.error('[TerraformDependencyDiagram] Layout error:', err);
      setIsEmpty(true);
    } finally {
      layoutInFlight.current = false;
    }
  }, []);

  useWatchEffect(() => {
    if (!graph || graph.nodes.length === 0) {
      setNodes([]);
      setEdges([]);
      setIsEmpty(true);
      return;
    }
    void runLayout(graph);
  }, [graph, runLayout]);

  const hasSource = composeMode === 'stacks' ? (generatedFiles?.length ?? 0) > 0 : !!generatedCode;
  if (!hasSource || isEmpty) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-emphasis">
          <GitBranch className="h-6 w-6 text-fg-subtle" />
        </div>
        <p className="text-sm text-fg-muted">
          {hasSource
            ? `No ${composeMode === 'stacks' ? 'component' : 'module'} dependencies detected in the generated code.`
            : `${composeMode === 'stacks' ? 'Component' : 'Module'} dependencies will appear here after code generation.`}
        </p>
      </div>
    );
  }

  return (
    <div
      className="h-full w-full animate-fade-in"
      style={{
        backgroundImage:
          'radial-gradient(circle, var(--color-border-subtle) 0.5px, transparent 0.5px)',
        backgroundSize: '20px 20px',
      }}
    >
      <ReactFlow
        nodes={nodes}
        edges={edges}
        nodeTypes={nodeTypes}
        edgeTypes={edgeTypes}
        fitView
        fitViewOptions={{ padding: 0.35 }}
        panOnDrag
        zoomOnScroll
        zoomOnPinch
        nodesDraggable={false}
        nodesConnectable={false}
        elementsSelectable={false}
        proOptions={{ hideAttribution: true }}
        minZoom={0.3}
        maxZoom={2}
      >
        <TerraformEdgeMarkers />
      </ReactFlow>
    </div>
  );
}

export function TerraformDependencyDiagram(): React.JSX.Element {
  return (
    <ReactFlowProvider>
      <DiagramInner />
    </ReactFlowProvider>
  );
}
