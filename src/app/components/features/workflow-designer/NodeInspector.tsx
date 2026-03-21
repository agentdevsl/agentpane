import { Trash, Warning } from '@phosphor-icons/react';
import { useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { TextInput } from '@/app/components/ui/text-input';
import { Textarea } from '@/app/components/ui/textarea';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { cn } from '@/lib/utils/cn';
import type { WorkflowNode } from '@/lib/workflow-dsl/types';

export interface NodeInspectorProps {
  /** The currently selected node, or null if no node is selected */
  node: WorkflowNode | null;
  /** Callback when node data is updated */
  onUpdateNode: (nodeId: string, data: Partial<WorkflowNode>) => void;
  /** Callback when node is deleted */
  onDeleteNode: (nodeId: string) => void;
  /** Optional className for the container */
  className?: string;
}

interface FieldGroupProps {
  label: string;
  children: React.ReactNode;
}

function FieldGroup({ label, children }: FieldGroupProps): React.JSX.Element {
  return (
    <div className="space-y-1.5">
      <span className="block text-xs font-medium uppercase tracking-wide text-fg-muted">
        {label}
      </span>
      {children}
    </div>
  );
}

interface ReadOnlyFieldProps {
  label: string;
  value: string | undefined;
}

function ReadOnlyField({ label, value }: ReadOnlyFieldProps): React.JSX.Element {
  return (
    <FieldGroup label={label}>
      <div className="rounded-md border border-border bg-surface-subtle px-3 py-2 text-sm text-fg-muted font-mono">
        {value || '-'}
      </div>
    </FieldGroup>
  );
}

/**
 * NodeInspector displays and allows editing of the selected workflow node's properties.
 * Shows different fields based on node type.
 */
export function NodeInspector({
  node,
  onUpdateNode,
  onDeleteNode,
  className,
}: NodeInspectorProps): React.JSX.Element {
  const [showDeleteConfirm, setShowDeleteConfirm] = useState(false);

  // Reset delete confirmation when node changes
  // biome-ignore lint/correctness/useExhaustiveDependencies: We want to reset state when the selected node changes
  useWatchEffect(() => {
    setShowDeleteConfirm(false);
  }, [node?.id]);

  const handleLabelChange = (value: string) => {
    if (!node) return;
    onUpdateNode(node.id, { label: value } as Partial<WorkflowNode>);
  };

  const handleDescriptionChange = (value: string) => {
    if (!node) return;
    onUpdateNode(node.id, { description: value } as Partial<WorkflowNode>);
  };

  const handleDelete = () => {
    if (!node) return;
    if (!showDeleteConfirm) {
      setShowDeleteConfirm(true);
      return;
    }
    onDeleteNode(node.id);
    setShowDeleteConfirm(false);
  };

  const handleCancelDelete = () => {
    setShowDeleteConfirm(false);
  };

  // Empty state when no node is selected
  if (!node) {
    return (
      <div
        className={cn('flex flex-col border-l border-border bg-surface p-4', 'w-72', className)}
        data-testid="node-inspector"
      >
        <h2 className="text-sm font-semibold text-fg mb-4">Node Inspector</h2>
        <div className="flex-1 flex items-center justify-center">
          <p className="text-sm text-fg-muted text-center">
            Select a node to view and edit its properties
          </p>
        </div>
      </div>
    );
  }

  return (
    <div
      className={cn('flex flex-col border-l border-border bg-surface', 'w-72', className)}
      data-testid="node-inspector"
    >
      {/* Header */}
      <div className="flex items-center justify-between border-b border-border p-4">
        <div>
          <h2 className="text-sm font-semibold text-fg">Node Inspector</h2>
          <span className="text-xs text-fg-muted capitalize">{node.type} Node</span>
        </div>
      </div>

      {/* Fields */}
      <div className="flex-1 overflow-y-auto p-4 space-y-4">
        {/* Common fields for all nodes */}
        <FieldGroup label="Label">
          <TextInput
            value={node.label}
            onChange={(e) => handleLabelChange(e.target.value)}
            placeholder="Node label"
          />
        </FieldGroup>

        <FieldGroup label="Description">
          <Textarea
            value={node.description ?? ''}
            onChange={(e) => handleDescriptionChange(e.target.value)}
            placeholder="Optional description..."
            rows={3}
          />
        </FieldGroup>

        {/* Type-specific fields */}
        <TypeSpecificFields node={node} onUpdateNode={onUpdateNode} />
      </div>

      {/* Delete action */}
      <div className="border-t border-border p-4">
        {showDeleteConfirm ? (
          <div className="space-y-3">
            <div className="flex items-start gap-2 rounded-md bg-danger-muted p-3">
              <Warning className="h-4 w-4 text-danger shrink-0 mt-0.5" />
              <p className="text-xs text-danger">
                Are you sure you want to delete this node? This action cannot be undone.
              </p>
            </div>
            <div className="flex gap-2">
              <Button variant="outline" size="sm" onClick={handleCancelDelete} className="flex-1">
                Cancel
              </Button>
              <Button variant="destructive" size="sm" onClick={handleDelete} className="flex-1">
                Delete
              </Button>
            </div>
          </div>
        ) : (
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            className="w-full text-danger hover:text-danger hover:bg-danger-muted"
          >
            <Trash className="h-4 w-4 mr-2" />
            Delete Node
          </Button>
        )}
      </div>
    </div>
  );
}

interface TypeSpecificFieldsProps {
  node: WorkflowNode;
  onUpdateNode: (nodeId: string, data: Partial<WorkflowNode>) => void;
}

/**
 * Renders type-specific fields based on the node type
 */
function TypeSpecificFields({
  node,
  onUpdateNode,
}: TypeSpecificFieldsProps): React.JSX.Element | null {
  switch (node.type) {
    case 'skill':
      return (
        <>
          <ReadOnlyField label="Skill ID" value={node.skillId} />
          <ReadOnlyField label="Skill Name" value={node.skillName} />
          {node.outputs && node.outputs.length > 0 && (
            <FieldGroup label="Outputs">
              <div className="flex flex-wrap gap-1">
                {node.outputs.map((output) => (
                  <span
                    key={output}
                    className="rounded bg-surface-muted px-2 py-0.5 text-xs text-fg-muted"
                  >
                    {output}
                  </span>
                ))}
              </div>
            </FieldGroup>
          )}
        </>
      );

    case 'context':
      return (
        <FieldGroup label="Content">
          <Textarea
            value={node.content}
            onChange={(e) => onUpdateNode(node.id, { ...node, content: e.target.value })}
            placeholder="Context or prompting content..."
            rows={4}
            className="text-sm"
          />
        </FieldGroup>
      );

    case 'agent':
      return (
        <>
          <ReadOnlyField label="Agent ID" value={node.agentId} />
          <FieldGroup label="Agent Name">
            <TextInput
              value={node.agentName}
              onChange={(e) => onUpdateNode(node.id, { ...node, agentName: e.target.value })}
              placeholder="Agent name"
            />
          </FieldGroup>
          {node.model && <ReadOnlyField label="Model" value={node.model} />}
          {node.maxTurns !== undefined && (
            <FieldGroup label="Max Turns">
              <TextInput
                type="number"
                value={node.maxTurns.toString()}
                onChange={(e) =>
                  onUpdateNode(node.id, {
                    ...node,
                    maxTurns: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
                placeholder="10"
              />
            </FieldGroup>
          )}
          {node.handoffs && node.handoffs.length > 0 && (
            <FieldGroup label="Handoffs">
              <div className="space-y-1">
                {node.handoffs.map((handoff) => (
                  <div
                    key={handoff.targetAgentId}
                    className="rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs"
                  >
                    <span className="text-fg-muted">Target:</span>{' '}
                    <span className="font-mono text-fg">{handoff.targetAgentId}</span>
                    {handoff.condition && (
                      <div className="mt-1 text-fg-muted">
                        <span>Condition:</span> {handoff.condition}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </FieldGroup>
          )}
        </>
      );

    case 'conditional':
      return (
        <>
          <FieldGroup label="Expression">
            <Textarea
              value={node.expression}
              onChange={(e) => onUpdateNode(node.id, { ...node, expression: e.target.value })}
              placeholder="e.g., result.success === true"
              rows={2}
              className="font-mono text-xs"
            />
          </FieldGroup>
          <FieldGroup label="Branches">
            <div className="space-y-1">
              {node.branches.map((branch) => (
                <div
                  key={branch.targetNodeId}
                  className="rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs"
                >
                  <span className="text-fg-muted">Condition:</span>{' '}
                  <span className="font-mono text-fg">{branch.condition}</span>
                  {branch.label && <span className="ml-2 text-fg-muted">({branch.label})</span>}
                </div>
              ))}
            </div>
          </FieldGroup>
          {node.defaultBranch && (
            <ReadOnlyField label="Default Branch" value={node.defaultBranch} />
          )}
        </>
      );

    case 'loop':
      return (
        <>
          <FieldGroup label="Iterator Variable">
            <TextInput
              value={node.iteratorVariable}
              onChange={(e) => onUpdateNode(node.id, { ...node, iteratorVariable: e.target.value })}
              placeholder="e.g., item"
              className="font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Collection">
            <TextInput
              value={node.collection}
              onChange={(e) => onUpdateNode(node.id, { ...node, collection: e.target.value })}
              placeholder="e.g., items"
              className="font-mono"
            />
          </FieldGroup>
          <FieldGroup label="Max Iterations">
            <TextInput
              type="number"
              value={node.maxIterations?.toString() ?? ''}
              onChange={(e) =>
                onUpdateNode(node.id, {
                  ...node,
                  maxIterations: e.target.value ? parseInt(e.target.value, 10) : undefined,
                })
              }
              placeholder="100"
            />
          </FieldGroup>
          {node.breakCondition !== undefined && (
            <FieldGroup label="Break Condition">
              <TextInput
                value={node.breakCondition ?? ''}
                onChange={(e) => onUpdateNode(node.id, { ...node, breakCondition: e.target.value })}
                placeholder="e.g., item.done"
                className="font-mono text-xs"
              />
            </FieldGroup>
          )}
        </>
      );

    case 'parallel':
      return (
        <>
          <FieldGroup label="Branches">
            <div className="text-sm text-fg">
              {node.branchNodeIds.length} parallel branch
              {node.branchNodeIds.length !== 1 ? 'es' : ''}
            </div>
          </FieldGroup>
          <FieldGroup label="Wait for All">
            <label className="flex items-center gap-2 cursor-pointer">
              <input
                type="checkbox"
                checked={node.waitForAll}
                onChange={(e) => onUpdateNode(node.id, { ...node, waitForAll: e.target.checked })}
                className="rounded border-border"
              />
              <span className="text-sm text-fg">Wait for all branches to complete</span>
            </label>
          </FieldGroup>
          {node.maxConcurrency !== undefined && (
            <FieldGroup label="Max Concurrency">
              <TextInput
                type="number"
                value={node.maxConcurrency.toString()}
                onChange={(e) =>
                  onUpdateNode(node.id, {
                    ...node,
                    maxConcurrency: e.target.value ? parseInt(e.target.value, 10) : undefined,
                  })
                }
                placeholder="Unlimited"
              />
            </FieldGroup>
          )}
        </>
      );

    case 'start':
      return (
        <>
          {node.inputs && node.inputs.length > 0 && (
            <FieldGroup label="Workflow Inputs">
              <div className="space-y-1">
                {node.inputs.map((input) => (
                  <div
                    key={input.name}
                    className="rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs"
                  >
                    <span className="font-mono text-fg">{input.name}</span>
                    <span className="text-fg-muted">: {input.type}</span>
                    {input.required && <span className="ml-1 text-danger">*</span>}
                  </div>
                ))}
              </div>
            </FieldGroup>
          )}
          <p className="text-xs text-fg-muted italic">
            The start node marks the entry point of the workflow.
          </p>
        </>
      );

    case 'end':
      return (
        <>
          {node.outputs && node.outputs.length > 0 && (
            <FieldGroup label="Workflow Outputs">
              <div className="space-y-1">
                {node.outputs.map((output) => (
                  <div
                    key={output.name}
                    className="rounded border border-border bg-surface-subtle px-2 py-1.5 text-xs"
                  >
                    <span className="font-mono text-fg">{output.name}</span>
                    <span className="text-fg-muted">: {output.type}</span>
                    {output.sourceNodeId && (
                      <div className="mt-1 text-fg-muted">
                        Source: {output.sourceNodeId}
                        {output.sourceOutput && `.${output.sourceOutput}`}
                      </div>
                    )}
                  </div>
                ))}
              </div>
            </FieldGroup>
          )}
          <p className="text-xs text-fg-muted italic">
            The end node marks a termination point of the workflow.
          </p>
        </>
      );

    default:
      return null;
  }
}

NodeInspector.displayName = 'NodeInspector';
