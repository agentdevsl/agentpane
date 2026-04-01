import {
  ArrowDown,
  CircleNotch,
  Funnel,
  Info,
  Lightning,
  MagicWand,
  MagnifyingGlass,
  Robot,
  Warning,
  X,
} from '@phosphor-icons/react';
import * as Dialog from '@radix-ui/react-dialog';
import type { Edge, Node } from '@xyflow/react';
import { useCallback, useMemo, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { DEFAULT_WORKFLOW_MODEL } from '@/lib/constants/models';
import { getNodeColors } from '@/lib/constants/node-colors';
import { cn } from '@/lib/utils/cn';
import { layoutWorkflowForReactFlow } from '@/lib/workflow-dsl/layout';
import type { Workflow, WorkflowEdge, WorkflowNode } from '@/lib/workflow-dsl/types';

/** Skill/Agent with content */
interface TemplatePrimitive {
  id?: string;
  name: string;
  description?: string;
  content?: string;
}

/** Extended template with cached content */
interface TemplateWithContent {
  id: string;
  name: string;
  description?: string | null;
  cachedSkills?: TemplatePrimitive[] | null;
  cachedCommands?: TemplatePrimitive[] | null;
  cachedAgents?: TemplatePrimitive[] | null;
}

/** Flattened skill or agent with type info */
interface SkillOrAgent extends TemplatePrimitive {
  _type: 'skill' | 'agent';
  templateName: string;
}

/** AI workflow response from the analyze endpoint */
interface AIWorkflowResponse {
  ok: boolean;
  data?: {
    workflow: Workflow;
  };
  error?: {
    code: string;
    message: string;
  };
}

interface AIGenerateDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  templates: TemplateWithContent[];
  onGenerate: (nodes: Node[], edges: Edge[], sourceName: string, description?: string) => void;
}

/**
 * Dialog for AI-powered workflow generation.
 *
 * User selects a skill from a flat aggregated list,
 * AI analyzes the markdown content to discover workflow steps,
 * then generates the workflow nodes on the canvas.
 */
/** Tag filter type */
type TagFilter = {
  type: 'type' | 'template';
  value: string;
  label: string;
};

export function AIGenerateDialog({
  open,
  onOpenChange,
  templates,
  onGenerate,
}: AIGenerateDialogProps): React.JSX.Element {
  const [searchQuery, setSearchQuery] = useState('');
  const [selected, setSelected] = useState<SkillOrAgent | null>(null);
  const [isAnalyzing, setIsAnalyzing] = useState(false);
  const [aiWorkflow, setAiWorkflow] = useState<Workflow | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [selectedTags, setSelectedTags] = useState<TagFilter[]>([]);

  // Aggregate all skills from all templates into a flat list
  const allPrimitives = useMemo(() => {
    const primitives: SkillOrAgent[] = [];
    for (const template of templates) {
      for (const skill of template.cachedSkills ?? []) {
        primitives.push({
          ...skill,
          _type: 'skill',
          templateName: template.name,
        });
      }
      for (const cmd of template.cachedCommands ?? []) {
        primitives.push({
          ...cmd,
          _type: 'skill',
          templateName: template.name,
        });
      }
      for (const agent of template.cachedAgents ?? []) {
        primitives.push({
          ...agent,
          _type: 'agent',
          templateName: template.name,
        });
      }
    }
    return primitives;
  }, [templates]);

  // Extract unique tags for filtering
  const availableTags = useMemo(() => {
    const typeTags: TagFilter[] = [];
    const templateTags: TagFilter[] = [];
    const seenTypes = new Set<string>();
    const seenTemplates = new Set<string>();

    for (const primitive of allPrimitives) {
      // Type tags
      if (!seenTypes.has(primitive._type)) {
        seenTypes.add(primitive._type);
        typeTags.push({
          type: 'type',
          value: primitive._type,
          label: primitive._type.charAt(0).toUpperCase() + primitive._type.slice(1),
        });
      }
      // Template tags
      if (!seenTemplates.has(primitive.templateName)) {
        seenTemplates.add(primitive.templateName);
        templateTags.push({
          type: 'template',
          value: primitive.templateName,
          label: primitive.templateName,
        });
      }
    }

    // Sort alphabetically
    typeTags.sort((a, b) => a.label.localeCompare(b.label));
    templateTags.sort((a, b) => a.label.localeCompare(b.label));

    return { typeTags, templateTags };
  }, [allPrimitives]);

  // Toggle tag selection
  const toggleTag = useCallback((tag: TagFilter) => {
    setSelectedTags((prev) => {
      const exists = prev.some((t) => t.type === tag.type && t.value === tag.value);
      if (exists) {
        return prev.filter((t) => !(t.type === tag.type && t.value === tag.value));
      }
      return [...prev, tag];
    });
  }, []);

  // Clear all tags
  const clearTags = useCallback(() => {
    setSelectedTags([]);
  }, []);

  // Check if a tag is selected
  const isTagSelected = useCallback(
    (tag: TagFilter) => {
      return selectedTags.some((t) => t.type === tag.type && t.value === tag.value);
    },
    [selectedTags]
  );

  // Filter primitives by search query and tags
  const filteredPrimitives = useMemo(() => {
    let result = allPrimitives;

    // Apply tag filters
    if (selectedTags.length > 0) {
      const typeFilters = selectedTags.filter((t) => t.type === 'type').map((t) => t.value);
      const templateFilters = selectedTags.filter((t) => t.type === 'template').map((t) => t.value);

      result = result.filter((p) => {
        // If type filters exist, primitive must match one of them
        const matchesType = typeFilters.length === 0 || typeFilters.includes(p._type);
        // If template filters exist, primitive must match one of them
        const matchesTemplate =
          templateFilters.length === 0 || templateFilters.includes(p.templateName);
        return matchesType && matchesTemplate;
      });
    }

    // Apply search filter
    if (searchQuery.trim()) {
      const q = searchQuery.toLowerCase();
      result = result.filter(
        (p) =>
          p.name.toLowerCase().includes(q) ||
          p.description?.toLowerCase().includes(q) ||
          p.templateName.toLowerCase().includes(q)
      );
    }

    return result;
  }, [allPrimitives, searchQuery, selectedTags]);

  // Analyze with AI when a primitive is selected
  const analyzeWithAI = useCallback(
    async (primitive: SkillOrAgent) => {
      setIsAnalyzing(true);
      setError(null);
      setAiWorkflow(null);

      try {
        // Get model from localStorage preference
        const workflowModel =
          typeof window !== 'undefined'
            ? (localStorage.getItem('workflow_model') ?? DEFAULT_WORKFLOW_MODEL)
            : DEFAULT_WORKFLOW_MODEL;

        const body: Record<string, unknown> = {
          name: primitive.name,
          model: workflowModel,
        };

        // Add the primitive based on its type
        if (primitive._type === 'skill') {
          body.skills = [
            {
              id: primitive.id ?? primitive.name,
              name: primitive.name,
              description: primitive.description,
              content: primitive.content ?? '',
            },
          ];
        } else if (primitive._type === 'agent') {
          body.agents = [
            {
              name: primitive.name,
              description: primitive.description,
              content: primitive.content ?? '',
            },
          ];
        }

        // Include all known skill names for cross-referencing
        // This helps the AI distinguish between skill invocations vs shell commands
        const knownSkillNames = allPrimitives.filter((p) => p._type === 'skill').map((p) => p.name);
        const knownAgentNames = allPrimitives.filter((p) => p._type === 'agent').map((p) => p.name);

        body.knownSkills = knownSkillNames;
        body.knownAgents = knownAgentNames;

        const response = await fetch('/api/workflow-designer/analyze', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(body),
        });

        const result = (await response.json()) as AIWorkflowResponse;

        if (!result.ok || !result.data?.workflow) {
          const errorMessage =
            result.error?.code === 'WORKFLOW_API_KEY_NOT_FOUND'
              ? 'API key not configured. Please add your Anthropic API key in settings.'
              : (result.error?.message ?? 'AI analysis failed');
          setError(errorMessage);
          return;
        }

        setAiWorkflow(result.data.workflow);
      } catch (err) {
        console.error('[AIGenerateDialog] Analysis error:', err);
        setError(err instanceof Error ? err.message : 'Failed to analyze with AI');
      } finally {
        setIsAnalyzing(false);
      }
    },
    [allPrimitives]
  );

  // Handle primitive selection
  const handleSelect = useCallback(
    (primitive: SkillOrAgent) => {
      setSelected(primitive);

      // Only analyze if the primitive has content
      if (primitive.content) {
        void analyzeWithAI(primitive);
      } else {
        setAiWorkflow(null);
        setError('This skill has no content to analyze. Try syncing the template first.');
      }
    },
    [analyzeWithAI]
  );

  // Handle generate button click
  const handleGenerate = useCallback(async () => {
    if (!aiWorkflow || !selected) return;

    // Apply layout algorithm and convert DSL nodes/edges to ReactFlow format.
    // Skip connectivity fix — server already validated and repaired edges.
    const { nodes: reactFlowNodes, edges: reactFlowEdges } = await layoutWorkflowForReactFlow(
      aiWorkflow.nodes as WorkflowNode[],
      aiWorkflow.edges as WorkflowEdge[],
      { skipConnectivityFix: true }
    );

    onGenerate(reactFlowNodes, reactFlowEdges, selected.name, aiWorkflow.description ?? undefined);

    // Reset state
    setSelected(null);
    setAiWorkflow(null);
    setSearchQuery('');
    setError(null);
  }, [aiWorkflow, selected, onGenerate]);

  // Handle dialog close - reset state
  const handleOpenChange = useCallback(
    (newOpen: boolean) => {
      if (!newOpen) {
        setSelected(null);
        setAiWorkflow(null);
        setSearchQuery('');
        setError(null);
        setSelectedTags([]);
      }
      onOpenChange(newOpen);
    },
    [onOpenChange]
  );

  return (
    <Dialog.Root open={open} onOpenChange={handleOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/50 backdrop-blur-sm z-50" />
        <Dialog.Content className="fixed left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-50 w-[90vw] max-w-[640px] max-h-[calc(100vh-48px)] flex flex-col overflow-hidden rounded-[var(--radius-lg)] border border-[var(--border-default)] bg-[var(--bg-default)] shadow-2xl">
          {/* Header */}
          <div className="flex items-center justify-between px-5 py-4 border-b border-[var(--border-default)] bg-[var(--bg-subtle)]">
            <div className="flex items-center gap-3">
              <div
                className="w-10 h-10 rounded-[var(--radius)] flex items-center justify-center"
                style={{ background: 'linear-gradient(135deg, #a371f7 0%, #58a6ff 100%)' }}
              >
                <Lightning className="h-[22px] w-[22px] text-white" weight="fill" />
              </div>
              <div>
                <Dialog.Title className="text-lg font-semibold text-[var(--fg-default)]">
                  Generate Workflow with AI
                </Dialog.Title>
                <Dialog.Description className="text-[13px] text-[var(--fg-muted)] mt-0.5">
                  Select a component to visualize its workflow steps
                </Dialog.Description>
              </div>
            </div>
            <Dialog.Close asChild>
              <button
                type="button"
                className="w-8 h-8 flex items-center justify-center rounded-[var(--radius)] text-[var(--fg-muted)] hover:bg-[var(--bg-muted)] hover:text-[var(--fg-default)] transition-colors"
              >
                <X className="h-5 w-5" />
              </button>
            </Dialog.Close>
          </div>

          {/* Body - Vertical stacked sections */}
          <div className="flex-1 overflow-y-auto p-5">
            {/* Section 1: Skill Selection */}
            <section className="mb-6">
              <div className="flex items-center gap-2 mb-3">
                <span className="w-5 h-5 rounded-full bg-[var(--accent-emphasis)] text-white text-[11px] font-semibold flex items-center justify-center">
                  1
                </span>
                <span className="text-[13px] font-semibold text-[var(--fg-default)]">
                  Select a skill
                </span>
              </div>

              {/* Search (compact) */}
              {allPrimitives.length > 4 && (
                <div className="relative mb-3">
                  <MagnifyingGlass className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-[var(--fg-muted)]" />
                  <input
                    id="ai-generate-search"
                    type="text"
                    placeholder="Search skills..."
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                    className="w-full pl-10 pr-4 py-2 rounded-[var(--radius)] border border-[var(--border-default)] bg-[var(--bg-default)] text-sm text-[var(--fg-default)] placeholder:text-[var(--fg-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-muted)]"
                  />
                </div>
              )}

              {/* Tag Filters */}
              {(availableTags.typeTags.length > 1 || availableTags.templateTags.length > 1) && (
                <div className="mb-3 space-y-2">
                  {/* Type filters */}
                  {availableTags.typeTags.length > 1 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-medium text-[var(--fg-muted)] flex items-center gap-1">
                        <Funnel className="h-3 w-3" />
                        Type:
                      </span>
                      {availableTags.typeTags.map((tag) => {
                        const isActive = isTagSelected(tag);
                        const Icon = tag.value === 'skill' ? Lightning : Robot;
                        return (
                          <button
                            key={`type-${tag.value}`}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={cn(
                              'inline-flex items-center gap-1.5 px-2 py-1 rounded-full text-[11px] font-medium transition-all border',
                              isActive
                                ? 'border-[var(--accent-fg)] bg-[var(--accent-muted)] text-[var(--accent-fg)]'
                                : 'border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-muted)] hover:border-[var(--border-emphasis)] hover:text-[var(--fg-default)]'
                            )}
                          >
                            <Icon className="h-3 w-3" weight={isActive ? 'fill' : 'regular'} />
                            {tag.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Template filters */}
                  {availableTags.templateTags.length > 1 && (
                    <div className="flex items-center gap-2 flex-wrap">
                      <span className="text-[11px] font-medium text-[var(--fg-muted)]">
                        Template:
                      </span>
                      {availableTags.templateTags.map((tag) => {
                        const isActive = isTagSelected(tag);
                        return (
                          <button
                            key={`template-${tag.value}`}
                            type="button"
                            onClick={() => toggleTag(tag)}
                            className={cn(
                              'inline-flex items-center gap-1 px-2 py-1 rounded-full text-[11px] font-medium transition-all border',
                              isActive
                                ? 'border-[var(--accent-fg)] bg-[var(--accent-muted)] text-[var(--accent-fg)]'
                                : 'border-[var(--border-default)] bg-[var(--bg-subtle)] text-[var(--fg-muted)] hover:border-[var(--border-emphasis)] hover:text-[var(--fg-default)]'
                            )}
                          >
                            {tag.label}
                          </button>
                        );
                      })}
                    </div>
                  )}

                  {/* Clear filters button */}
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      onClick={clearTags}
                      className="text-[11px] text-[var(--accent-fg)] hover:underline"
                    >
                      Clear all filters ({selectedTags.length})
                    </button>
                  )}
                </div>
              )}

              {/* Skill Grid - 2 columns */}
              {allPrimitives.length === 0 ? (
                <div className="text-center py-8 text-[var(--fg-muted)]">
                  <Warning className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">No skills available</p>
                  <p className="text-[11px] mt-1">
                    Sync your org templates to see available skills
                  </p>
                </div>
              ) : filteredPrimitives.length === 0 ? (
                <div className="text-center py-8 text-[var(--fg-muted)]">
                  <Funnel className="h-8 w-8 mx-auto mb-2 opacity-50" />
                  <p className="text-sm">
                    {searchQuery && selectedTags.length > 0
                      ? `No results for "${searchQuery}" with selected filters`
                      : searchQuery
                        ? `No results for "${searchQuery}"`
                        : 'No items match the selected filters'}
                  </p>
                  {selectedTags.length > 0 && (
                    <button
                      type="button"
                      onClick={clearTags}
                      className="text-[11px] text-[var(--accent-fg)] hover:underline mt-2"
                    >
                      Clear filters
                    </button>
                  )}
                </div>
              ) : (
                <div className="grid grid-cols-2 gap-2.5">
                  {filteredPrimitives.slice(0, 8).map((primitive, index) => {
                    const isSelected =
                      selected?.name === primitive.name && selected?._type === primitive._type;
                    const Icon = primitive._type === 'skill' ? Lightning : Robot;
                    const colorClass =
                      primitive._type === 'skill'
                        ? 'bg-[var(--done-muted)] text-[var(--done-fg)]'
                        : 'bg-[var(--accent-muted)] text-[var(--accent-fg)]';

                    return (
                      <button
                        key={`${primitive._type}-${primitive.name}-${index}`}
                        type="button"
                        onClick={() => handleSelect(primitive)}
                        className={cn(
                          'p-3.5 rounded-[var(--radius)] text-left transition-all border',
                          isSelected
                            ? 'border-[var(--accent-fg)] bg-[var(--accent-muted)]'
                            : 'border-[var(--border-default)] bg-[var(--bg-subtle)] hover:border-[var(--accent-fg)] hover:bg-[var(--bg-muted)]'
                        )}
                      >
                        <div className="flex items-center gap-2.5 mb-1.5">
                          <div
                            className={cn(
                              'w-7 h-7 rounded-[6px] flex items-center justify-center flex-shrink-0',
                              colorClass
                            )}
                          >
                            <Icon className="h-4 w-4" weight="fill" />
                          </div>
                          <span className="text-[13px] font-semibold font-mono text-[var(--fg-default)] truncate">
                            /{primitive.name}
                          </span>
                        </div>
                        {primitive.description && (
                          <p className="text-[11px] text-[var(--fg-muted)] line-clamp-2 leading-relaxed">
                            {primitive.description}
                          </p>
                        )}
                      </button>
                    );
                  })}
                </div>
              )}
              {filteredPrimitives.length > 8 && (
                <p className="text-[11px] text-[var(--fg-subtle)] mt-2 text-center">
                  +{filteredPrimitives.length - 8} more available
                </p>
              )}
            </section>

            {/* Section 2: Preview */}
            <section>
              <div className="flex items-center gap-2 mb-3">
                <span className="w-5 h-5 rounded-full bg-[var(--accent-emphasis)] text-white text-[11px] font-semibold flex items-center justify-center">
                  2
                </span>
                <span className="text-[13px] font-semibold text-[var(--fg-default)]">
                  AI-generated workflow preview
                </span>
              </div>

              <div className="rounded-[var(--radius)] border border-[var(--border-default)] bg-[var(--bg-canvas)] p-4">
                {isAnalyzing ? (
                  <div className="py-8 flex items-center justify-center">
                    <div className="text-center">
                      <CircleNotch className="h-10 w-10 mx-auto mb-3 text-[var(--accent-fg)] animate-spin" />
                      <p className="text-sm text-[var(--fg-default)]">Analyzing with AI...</p>
                      <p className="text-[11px] text-[var(--fg-muted)] mt-1">
                        Parsing skill content to discover workflow steps
                      </p>
                    </div>
                  </div>
                ) : error ? (
                  <div className="py-8 flex items-center justify-center">
                    <div className="text-center max-w-xs">
                      <Warning className="h-10 w-10 mx-auto mb-3 text-[var(--danger-fg)]" />
                      <p className="text-sm text-[var(--danger-fg)]">{error}</p>
                      {error.includes('API key') && (
                        <Button
                          variant="outline"
                          size="sm"
                          className="mt-3"
                          onClick={() => {
                            window.location.href = '/settings';
                          }}
                        >
                          Configure API Key
                        </Button>
                      )}
                    </div>
                  </div>
                ) : !selected ? (
                  <div className="py-8 flex items-center justify-center text-[var(--fg-muted)]">
                    <div className="text-center">
                      <MagicWand className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">Select a skill to preview</p>
                      <p className="text-[11px] mt-1">
                        AI will analyze the skill markdown to discover workflow steps
                      </p>
                    </div>
                  </div>
                ) : !aiWorkflow ? (
                  <div className="py-8 flex items-center justify-center text-[var(--fg-muted)]">
                    <div className="text-center">
                      <MagicWand className="h-10 w-10 mx-auto mb-3 opacity-30" />
                      <p className="text-sm">No workflow generated</p>
                      <p className="text-[11px] mt-1">
                        The skill might not have parseable workflow content
                      </p>
                    </div>
                  </div>
                ) : (
                  <>
                    {/* Preview Header */}
                    <div className="flex items-center justify-between mb-4">
                      <span className="text-xs font-semibold text-[var(--fg-muted)] uppercase tracking-wide">
                        Parsed from /{selected.name} {selected._type}
                      </span>
                      <span className="text-[11px] text-[var(--fg-subtle)]">
                        {aiWorkflow.nodes.length} steps detected
                      </span>
                    </div>

                    {/* Preview Steps */}
                    <div className="flex flex-col gap-2">
                      {aiWorkflow.nodes.map((node, index) => {
                        const nodeColors = getNodeColors(node.type);
                        return (
                          <div key={node.id}>
                            {/* Step Card */}
                            <div className="flex items-start gap-3 py-2.5 px-3 bg-[var(--bg-subtle)] border border-[var(--border-muted)] rounded-[var(--radius)]">
                              <span
                                className={cn(
                                  'w-[22px] h-[22px] rounded-full text-[11px] font-semibold flex items-center justify-center flex-shrink-0',
                                  nodeColors.bgClass,
                                  nodeColors.textClass
                                )}
                              >
                                {index + 1}
                              </span>
                              <div className="flex-1 min-w-0">
                                <div className="text-xs font-semibold text-[var(--fg-default)] mb-0.5">
                                  {node.label}
                                </div>
                                {node.description && (
                                  <p className="text-[11px] text-[var(--fg-muted)] line-clamp-1">
                                    {node.description}
                                  </p>
                                )}
                              </div>
                              <span
                                className={cn(
                                  'text-[10px] font-semibold uppercase tracking-wide px-1.5 py-0.5 rounded flex-shrink-0',
                                  nodeColors.bgClass,
                                  nodeColors.textClass
                                )}
                              >
                                {node.type}
                              </span>
                            </div>

                            {/* Arrow Connector */}
                            {index < aiWorkflow.nodes.length - 1 && (
                              <div className="flex justify-center py-1">
                                <ArrowDown className="h-4 w-4 text-[var(--fg-subtle)]" />
                              </div>
                            )}
                          </div>
                        );
                      })}
                    </div>
                  </>
                )}
              </div>
            </section>
          </div>

          {/* Footer */}
          <div className="flex items-center justify-between px-5 py-4 border-t border-[var(--border-default)] bg-[var(--bg-subtle)]">
            <div className="flex items-center gap-1.5 text-xs text-[var(--fg-subtle)]">
              <Info className="h-3.5 w-3.5" />
              <span>AI parses skill markdown to extract workflow steps</span>
            </div>
            <div className="flex items-center gap-2.5">
              <Dialog.Close asChild>
                <Button variant="outline" size="sm">
                  Cancel
                </Button>
              </Dialog.Close>
              <button
                type="button"
                onClick={handleGenerate}
                disabled={!aiWorkflow || isAnalyzing}
                className="inline-flex items-center gap-2 px-4 py-2 text-sm font-medium text-white rounded-[var(--radius)] transition-all disabled:opacity-50 disabled:cursor-not-allowed hover:opacity-90"
                style={{ background: 'linear-gradient(135deg, #a371f7 0%, #58a6ff 100%)' }}
              >
                {isAnalyzing ? (
                  <>
                    <CircleNotch className="h-4 w-4 animate-spin" />
                    Analyzing...
                  </>
                ) : (
                  <>
                    <Lightning className="h-4 w-4" weight="fill" />
                    Generate Workflow
                  </>
                )}
              </button>
            </div>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
