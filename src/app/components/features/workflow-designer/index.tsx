import { CaretLeft, Warning } from '@phosphor-icons/react';
import { type Edge, type Node, useEdgesState, useNodesState, type Viewport } from '@xyflow/react';
import { lazy, Suspense, useCallback, useMemo, useRef, useState } from 'react';
import { DialogLoadingFallback } from '@/app/components/ui/suspense-fallbacks';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import '@xyflow/react/dist/style.css';

import type { Workflow } from '@/db/schema';
import { calculateUniformNodeWidth } from '@/lib/workflow-dsl/layout';
import type { WorkflowNode } from '@/lib/workflow-dsl/types';

const AIGenerateDialog = lazy(() =>
  import('./AIGenerateDialog').then((m) => ({ default: m.AIGenerateDialog }))
);

import { type SavedWorkflow, SavedWorkflowsPanel } from './SavedWorkflowsPanel';
import { WorkflowCanvas } from './WorkflowCanvas';
import { WorkflowToolbar } from './WorkflowToolbar';

/** Extended template with skills/commands/agents from sync */
interface TemplateWithContent {
  id: string;
  name: string;
  description?: string | null;
  status?: 'active' | 'syncing' | 'error' | 'disabled' | null;
  cachedSkills?: Array<{ id: string; name: string; description?: string }> | null;
  cachedCommands?: Array<{ name: string; description?: string }> | null;
  cachedAgents?: Array<{ name: string; description?: string }> | null;
}

/**
 * Props for the WorkflowDesigner component
 */
export interface WorkflowDesignerProps {
  /** Initial workflow data for editing existing workflows */
  initialWorkflow?: Workflow;
  /** Whether the designer is in read-only mode */
  readOnly?: boolean;
}

/**
 * Maps standard node types to compact node types for the v3 pill design.
 * Note: A similar function exists in src/lib/workflow-dsl/layout.ts for DSL operations.
 */
function mapToCompactNodeType(type: string): string {
  switch (type) {
    case 'start':
      return 'compactStart';
    case 'end':
      return 'compactEnd';
    case 'context':
      return 'compactContext';
    case 'skill':
      return 'compactSkill';
    case 'agent':
      return 'compactAgent';
    case 'conditional':
    case 'loop':
    case 'parallel':
      // Control flow nodes use their standard (non-compact) type
      return type;
    default:
      // Warn about unmapped types - may indicate a bug or missing mapping
      console.warn(
        `[WorkflowDesigner] Unknown node type "${type}" not mapped to compact type. Node may not render correctly.`
      );
      return type;
  }
}

/**
 * Default nodes for a new workflow (start and end nodes)
 * Uses compact v3 node types for modern visual design
 */
const getDefaultNodes = (): Node[] => [
  {
    id: 'start-1',
    type: 'compactStart',
    position: { x: 400, y: 80 },
    data: { label: 'Start', nodeIndex: 0, nodeType: 'start' },
  },
  {
    id: 'end-1',
    type: 'compactEnd',
    position: { x: 400, y: 200 },
    data: { label: 'Done', nodeIndex: 1, nodeType: 'end' },
  },
];

/**
 * Convert ReactFlow nodes back to DSL format for saving.
 */
const reactFlowNodesToWorkflowNodes = (nodes: Node[]): Workflow['nodes'] => {
  return nodes.map((node) => {
    const { nodeType, nodeIndex, uniformWidth, ...dataRest } = node.data as Record<string, unknown>;
    return {
      id: node.id,
      type: (nodeType as string) || 'context',
      position: node.position,
      ...dataRest,
    };
  }) as Workflow['nodes'];
};

/**
 * Convert ReactFlow edges back to DSL format for saving.
 */
const reactFlowEdgesToWorkflowEdges = (edges: Edge[]): Workflow['edges'] => {
  return edges.map((edge) => {
    const { edgeType, ...dataRest } = (edge.data as Record<string, unknown>) || {};
    return {
      id: edge.id,
      type: (edgeType as string) || edge.type || 'sequential',
      sourceNodeId: edge.source,
      targetNodeId: edge.target,
      ...dataRest,
    };
  }) as Workflow['edges'];
};

/**
 * Convert DB workflow (DSL types) to ReactFlow nodes/edges.
 *
 * DSL types use:
 * - Nodes: typed fields based on node type (e.g., skillId, agentId) + `label` + `description`
 * - Edges: sourceNodeId/targetNodeId instead of source/target
 *
 * ReactFlow expects:
 * - Nodes: generic `data` object with compact v3 types
 * - Edges: source/target fields
 */
const workflowToNodesEdges = (workflow: Workflow): { nodes: Node[]; edges: Edge[] } => {
  // Calculate uniform width for consistent sizing across all nodes
  const uniformWidth = workflow.nodes
    ? calculateUniformNodeWidth(workflow.nodes as WorkflowNode[])
    : undefined;

  const nodes: Node[] =
    workflow.nodes?.map((n, index) => {
      // Extract common fields for ReactFlow data object
      const { id, type, position, ...rest } = n;
      return {
        id,
        type: mapToCompactNodeType(type), // Convert to compact v3 node type
        position,
        data: {
          ...rest, // Put remaining fields (label, description, etc.) into data
          nodeIndex: index, // For staggered animation
          nodeType: type, // Original type for reference
          uniformWidth, // Apply calculated uniform width
        },
      };
    }) ?? getDefaultNodes();

  const edges: Edge[] =
    workflow.edges?.map((e) => {
      // Map DSL sourceNodeId/targetNodeId to ReactFlow source/target
      const { id, type, sourceNodeId, targetNodeId, ...rest } = e;
      // Map edge type to registered types (handle legacy 'straight' -> 'sequential')
      const mappedType = mapEdgeTypeToRegistered(type);
      return {
        id,
        source: sourceNodeId,
        target: targetNodeId,
        type: mappedType,
        data: rest, // Put remaining fields (label, metadata, etc.) into data
      };
    }) ?? [];

  return { nodes, edges };
};

/**
 * Maps edge types to registered ReactFlow edge types.
 * Handles legacy types like 'straight' that were incorrectly used.
 */
function mapEdgeTypeToRegistered(type: string | undefined): string {
  // Registered types: sequential, handoff, dataflow, conditional
  switch (type) {
    case 'sequential':
    case 'handoff':
    case 'dataflow':
    case 'conditional':
      return type;
    case 'straight':
      // Legacy type - map to sequential
      return 'sequential';
    default:
      return 'sequential';
  }
}

/**
 * WorkflowDesigner is the main container component for the visual workflow editor.
 * It orchestrates the canvas, toolbar, saved workflows panel, and AI generation dialog.
 *
 * Layout:
 * - Main area: Canvas with toolbar overlay
 * - Right sidebar: Saved workflows catalog with save status
 */
export function WorkflowDesigner({
  initialWorkflow,
  readOnly = false,
}: WorkflowDesignerProps): React.JSX.Element {
  // Initialize nodes and edges from initial workflow or defaults
  const initialState = initialWorkflow
    ? workflowToNodesEdges(initialWorkflow)
    : { nodes: getDefaultNodes(), edges: [] };

  // ReactFlow state management
  const [nodes, setNodes, onNodesChange] = useNodesState(initialState.nodes);
  const [edges, setEdges, onEdgesChange] = useEdgesState(initialState.edges);

  // UI state
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [aiDialogOpen, setAiDialogOpen] = useState(false);
  const [viewport, setViewport] = useState<Viewport | undefined>(
    initialWorkflow?.viewport
      ? {
          x: initialWorkflow.viewport.x,
          y: initialWorkflow.viewport.y,
          zoom: initialWorkflow.viewport.zoom,
        }
      : undefined
  );

  // Sidebar collapse state
  const [rightPanelCollapsed, setRightPanelCollapsed] = useState(false);

  // Saved workflows state
  const [savedWorkflows, setSavedWorkflows] = useState<SavedWorkflow[]>([]);
  const [activeWorkflowId, setActiveWorkflowId] = useState<string | null>(
    initialWorkflow?.id ?? null
  );
  const [workflowName, setWorkflowName] = useState<string>(initialWorkflow?.name ?? '');
  const [workflowDescription, setWorkflowDescription] = useState<string>(
    initialWorkflow?.description ?? ''
  );
  const [workflowsLoading, setWorkflowsLoading] = useState(true);

  // Track unsaved changes via a counter approach instead of JSON.stringify
  const changeCounterRef = useRef(0);
  const savedCounterRef = useRef(0);

  // Org templates from API (used by AIGenerateDialog)
  const [templates, setTemplates] = useState<TemplateWithContent[]>([]);

  // Fetch org templates on mount (for AI generation)
  useMountEffect(() => {
    async function fetchTemplates() {
      try {
        const response = await fetch('/api/templates?scope=org');
        const result = await response.json();

        if (result.ok && result.data?.items) {
          setTemplates(result.data.items);
        }
      } catch (err) {
        console.error('[Designer] Template fetch error:', err);
      }
    }

    void fetchTemplates();
  });

  // Fetch saved workflows on mount
  useMountEffect(() => {
    async function fetchWorkflows() {
      try {
        const response = await fetch('/api/workflows');
        const result = await response.json();

        if (result.ok && result.data?.items) {
          setSavedWorkflows(
            result.data.items.map((w: Workflow) => ({
              id: w.id,
              name: w.name,
              description: w.description,
              updatedAt: new Date(w.updatedAt),
              nodeCount: w.nodes?.length ?? 0,
              edgeCount: w.edges?.length ?? 0,
            }))
          );
        }
      } catch (err) {
        console.error('[Designer] Workflows fetch error:', err);
      } finally {
        setWorkflowsLoading(false);
      }
    }

    void fetchWorkflows();
  });

  // Increment change counter whenever nodes or edges change
  useWatchEffect(() => {
    changeCounterRef.current += 1;
  }, [nodes, edges]);

  // biome-ignore lint/correctness/useExhaustiveDependencies: nodes/edges trigger recomputation of counter comparison
  const hasUnsavedChanges = useMemo(
    () => changeCounterRef.current !== savedCounterRef.current,
    [nodes, edges]
  );

  // Update saved counter when workflow is saved
  const markAsSaved = useCallback(() => {
    savedCounterRef.current = changeCounterRef.current;
  }, []);

  // Handle viewport changes
  const handleViewportChange = useCallback((newViewport: Viewport) => {
    setViewport(newViewport);
  }, []);

  // AI Generation handler - opens the AI dialog
  const handleGenerateAI = useCallback(() => {
    if (readOnly) return;
    setAiDialogOpen(true);
  }, [readOnly]);

  // Callback when AI workflow is generated from the dialog
  const handleAIWorkflowGenerated = useCallback(
    (newNodes: Node[], newEdges: Edge[], sourceName: string, description?: string) => {
      setNodes(newNodes);
      setEdges(newEdges);
      setAiDialogOpen(false);
      // Set workflow name and description based on AI generation
      setWorkflowName(sourceName);
      setWorkflowDescription(description ?? '');
      setActiveWorkflowId(null); // This is a new workflow, not an update
      // The change counter will increment via the useWatchEffect watching [nodes, edges]
    },
    [setNodes, setEdges]
  );

  // Save handler
  const handleSave = useCallback(async () => {
    if (readOnly) return;

    setIsSaving(true);
    setError(null);
    try {
      // Convert ReactFlow format back to DSL format
      const workflowNodes = reactFlowNodesToWorkflowNodes(nodes);
      const workflowEdges = reactFlowEdgesToWorkflowEdges(edges);

      let savedWorkflow: Workflow;

      if (activeWorkflowId) {
        // Update existing workflow
        const response = await fetch(`/api/workflows/${activeWorkflowId}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            nodes: workflowNodes,
            edges: workflowEdges,
            viewport,
          }),
        });

        const result = await response.json();
        if (!result.ok) {
          throw new Error(result.error?.message || 'Failed to update workflow');
        }
        savedWorkflow = result.data;
      } else {
        // Create new workflow - use stored name/description from AI generation
        const name = workflowName || `Workflow ${new Date().toLocaleString()}`;
        const response = await fetch('/api/workflows', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            name,
            description: workflowDescription || undefined,
            nodes: workflowNodes,
            edges: workflowEdges,
            viewport,
            status: 'draft',
          }),
        });

        const result = await response.json();
        if (!result.ok) {
          throw new Error(result.error?.message || 'Failed to create workflow');
        }
        savedWorkflow = result.data;
        setActiveWorkflowId(savedWorkflow.id);
      }

      // Mark as saved and update saved workflows list
      markAsSaved();

      // Update or add the workflow in the list
      setSavedWorkflows((prev) => {
        const existingIndex = prev.findIndex((w) => w.id === savedWorkflow.id);
        const workflowSummary: SavedWorkflow = {
          id: savedWorkflow.id,
          name: savedWorkflow.name,
          description: savedWorkflow.description ?? undefined,
          updatedAt: new Date(savedWorkflow.updatedAt),
          nodeCount: savedWorkflow.nodes?.length ?? 0,
          edgeCount: savedWorkflow.edges?.length ?? 0,
        };

        if (existingIndex >= 0) {
          // Update existing
          const updated = [...prev];
          updated[existingIndex] = workflowSummary;
          return updated;
        }
        // Add new at the beginning
        return [workflowSummary, ...prev];
      });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'An unexpected error occurred';
      console.error('Failed to save workflow:', err);
      setError(`Failed to save workflow: ${message}`);
    } finally {
      setIsSaving(false);
    }
  }, [
    readOnly,
    nodes,
    edges,
    viewport,
    markAsSaved,
    activeWorkflowId,
    workflowName,
    workflowDescription,
  ]);

  // Clear handler / Create new workflow
  const handleCreateNew = useCallback(() => {
    if (readOnly) return;

    setNodes(getDefaultNodes());
    setEdges([]);
    setActiveWorkflowId(null);
    setWorkflowName('');
    setWorkflowDescription('');
    // Sync counters so hasUnsavedChanges becomes false after next render
    savedCounterRef.current = changeCounterRef.current + 1;
    // The +1 accounts for the upcoming useWatchEffect increment from setNodes/setEdges
  }, [readOnly, setNodes, setEdges]);

  // Select a saved workflow to load
  const handleSelectWorkflow = useCallback(
    async (workflow: SavedWorkflow) => {
      if (readOnly) return;

      // TODO: [CQ-018] Fetch full workflow data from API
      // For now, simulate loading
      try {
        const response = await fetch(`/api/workflows/${workflow.id}`);
        const result = await response.json();

        if (result.ok && result.data) {
          const loaded = workflowToNodesEdges(result.data);
          setNodes(loaded.nodes);
          setEdges(loaded.edges);
          setActiveWorkflowId(workflow.id);
          setWorkflowName(result.data.name || workflow.name);
          setWorkflowDescription(result.data.description || '');

          // Mark initial state as saved — sync counters after the effect fires
          setTimeout(() => {
            savedCounterRef.current = changeCounterRef.current;
          }, 0);
        }
      } catch (err) {
        console.error('[Designer] Failed to load workflow:', err);
        setError('Failed to load workflow');
      }
    },
    [readOnly, setNodes, setEdges]
  );

  // Delete a saved workflow
  const handleDeleteWorkflow = useCallback(
    async (workflowId: string) => {
      try {
        const response = await fetch(`/api/workflows/${workflowId}`, {
          method: 'DELETE',
        });

        if (!response.ok && response.status !== 204) {
          const result = await response.json();
          throw new Error(result.error?.message || 'Failed to delete workflow');
        }

        // Remove from list
        setSavedWorkflows((prev) => prev.filter((w) => w.id !== workflowId));

        // If deleting active workflow, clear the canvas
        if (workflowId === activeWorkflowId) {
          handleCreateNew();
        }
      } catch (err) {
        console.error('[Designer] Failed to delete workflow:', err);
        const message = err instanceof Error ? err.message : 'Failed to delete workflow';
        setError(message);
      }
    },
    [activeWorkflowId, handleCreateNew]
  );

  return (
    <div className="flex h-full w-full" data-testid="workflow-designer">
      {/* Main area - Canvas with Toolbar */}
      <div className="relative flex-1 min-w-0">
        {/* Error banner */}
        {error && (
          <div
            className="absolute left-[var(--space-4)] right-[var(--space-4)] top-16 z-20 flex items-center justify-between rounded-[var(--radius)] border border-[var(--danger-muted)] bg-[var(--danger-subtle)] px-[var(--space-4)] py-[var(--space-3)] text-[var(--text-sm)] text-[var(--danger-fg)]"
            role="alert"
            data-testid="workflow-error-banner"
          >
            <div className="flex items-center gap-2">
              <Warning className="h-4 w-4" weight="fill" />
              <span>{error}</span>
            </div>
            <button
              type="button"
              className="text-[var(--danger-fg)] hover:opacity-70 transition-opacity"
              onClick={() => setError(null)}
              aria-label="Dismiss error"
            >
              <svg
                xmlns="http://www.w3.org/2000/svg"
                width="16"
                height="16"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <line x1="18" y1="6" x2="6" y2="18" />
                <line x1="6" y1="6" x2="18" y2="18" />
              </svg>
            </button>
          </div>
        )}

        {/* Toolbar overlay */}
        <WorkflowToolbar
          onGenerateAI={handleGenerateAI}
          onSave={handleSave}
          onClear={handleCreateNew}
          isGenerating={false}
          isSaving={isSaving}
          canUndo={false}
          canRedo={false}
        />

        {/* Canvas */}
        <WorkflowCanvas
          nodes={nodes}
          edges={edges}
          onNodesChange={onNodesChange}
          onEdgesChange={onEdgesChange}
          viewport={viewport}
          onViewportChange={handleViewportChange}
          readOnly={readOnly}
        />
      </div>

      {/* Collapse toggle for right panel */}
      {rightPanelCollapsed && (
        <button
          type="button"
          onClick={() => setRightPanelCollapsed(false)}
          className="hidden xl:flex items-center justify-center w-6 bg-[var(--bg-default)] border-l border-[var(--border-default)] hover:bg-[var(--bg-subtle)] transition-colors"
          aria-label="Expand workflows panel"
        >
          <CaretLeft className="h-4 w-4 text-[var(--fg-muted)]" />
        </button>
      )}

      {/* Right sidebar - Saved Workflows */}
      <SavedWorkflowsPanel
        workflows={savedWorkflows}
        activeWorkflowId={activeWorkflowId}
        hasUnsavedChanges={hasUnsavedChanges}
        isLoading={workflowsLoading}
        collapsed={rightPanelCollapsed}
        onCollapse={setRightPanelCollapsed}
        onSelect={handleSelectWorkflow}
        onCreateNew={handleCreateNew}
        onDelete={handleDeleteWorkflow}
        onSave={handleSave}
      />

      {/* AI Generate Dialog */}
      <Suspense fallback={<DialogLoadingFallback label="Loading AI generate dialog…" />}>
        <AIGenerateDialog
          open={aiDialogOpen}
          onOpenChange={setAiDialogOpen}
          templates={templates}
          onGenerate={handleAIWorkflowGenerated}
        />
      </Suspense>
    </div>
  );
}
