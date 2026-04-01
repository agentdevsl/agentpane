import type { Icon } from '@phosphor-icons/react';
import {
  Brain,
  Check,
  CircleNotch,
  Circuitry,
  Cpu,
  Gauge,
  GearFine,
  Lightning,
  Robot,
  Sparkle,
  TreeStructure,
  Warning,
} from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { ModelSelector } from '@/app/components/ui/model-selector';
import { ToolAccessSelector } from '@/app/components/ui/tool-access-selector';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useTimeout } from '@/app/hooks/use-timeout';
import { apiClient } from '@/lib/api/client';
import {
  DEFAULT_AGENT_MODEL,
  DEFAULT_ANTHROPIC_BASE_URL,
  DEFAULT_TASK_CREATION_MODEL,
  DEFAULT_WORKFLOW_MODEL,
} from '@/lib/constants/models';
import {
  DEFAULT_AGENT_TOOLS,
  DEFAULT_TASK_CREATION_TOOLS,
  DEFAULT_WORKFLOW_TOOLS,
} from '@/lib/constants/tools';
import { cn } from '@/lib/utils/cn';

// Setting keys used for model/tool configuration
const SETTING_KEYS = {
  DEFAULT_MODEL: 'default_model',
  TASK_CREATION_MODEL: 'task_creation_model',
  WORKFLOW_MODEL: 'workflow_model',
  AGENT_TOOLS: 'agent_tools',
  TASK_CREATION_TOOLS: 'task_creation_tools',
  WORKFLOW_TOOLS: 'workflow_tools',
  ANTHROPIC_BASE_URL: 'anthropic_base_url',
} as const;

export const Route = createFileRoute('/settings/model-optimizations')({
  component: ModelOptimizationsPage,
});

// Model + Tools configuration card
function ConfigCard({
  icon: IconComponent,
  title,
  description,
  model,
  onModelChange,
  tools,
  onToolsChange,
  modelTestId,
  toolsTestId,
}: {
  icon: Icon;
  title: string;
  description: string;
  model: string | null;
  onModelChange: (value: string | null) => void;
  tools: string[];
  onToolsChange: (tools: string[]) => void;
  modelTestId?: string;
  toolsTestId?: string;
}) {
  const [showTools, setShowTools] = useState(false);

  return (
    <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 transition-all hover:border-border">
      {/* Card header */}
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
          <IconComponent className="h-4 w-4 text-fg-muted" weight="duotone" />
        </div>
        <div className="flex-1 min-w-0">
          <h3 className="text-sm font-medium text-fg">{title}</h3>
          <p className="mt-0.5 text-xs text-fg-muted leading-relaxed">{description}</p>
        </div>
      </div>

      {/* Model selector */}
      <div className="mb-4">
        <span className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
          <Brain className="h-3 w-3" />
          Model
        </span>
        <ModelSelector value={model} onChange={onModelChange} data-testid={modelTestId} />
      </div>

      {/* Tools toggle */}
      <div>
        <button
          type="button"
          onClick={() => setShowTools(!showTools)}
          className="mb-3 flex w-full items-center justify-between rounded-md px-3 py-2 text-xs font-medium uppercase tracking-wider text-fg-subtle transition-colors hover:bg-surface-emphasis/50 hover:text-fg-muted"
        >
          <span className="flex items-center gap-2">
            <GearFine className="h-3 w-3" />
            Tool Access
          </span>
          <span
            className={cn(
              'rounded-full px-2 py-0.5 text-[10px] transition-colors',
              tools.length === 0
                ? 'bg-success-muted text-success'
                : 'bg-surface-emphasis text-fg-muted'
            )}
          >
            {tools.length === 0 ? 'All' : `${tools.length} tools`}
          </span>
        </button>

        <div
          className={cn(
            'grid transition-all duration-200',
            showTools ? 'grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
          )}
        >
          <div className="overflow-hidden">
            <div className="rounded-lg border border-border/50 bg-surface/50 p-4">
              <ToolAccessSelector
                value={tools}
                onChange={onToolsChange}
                data-testid={toolsTestId}
              />
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

function ModelOptimizationsPage(): React.JSX.Element {
  // Loading and error states
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Model settings
  const [defaultModel, setDefaultModel] = useState<string | null>(DEFAULT_AGENT_MODEL);
  const [taskCreationModel, setTaskCreationModel] = useState<string | null>(
    DEFAULT_TASK_CREATION_MODEL
  );
  const [workflowModel, setWorkflowModel] = useState<string | null>(DEFAULT_WORKFLOW_MODEL);

  // Tool access settings
  const [agentTools, setAgentTools] = useState<string[]>(DEFAULT_AGENT_TOOLS);
  const [taskCreationTools, setTaskCreationTools] = useState<string[]>(DEFAULT_TASK_CREATION_TOOLS);
  const [workflowTools, setWorkflowTools] = useState<string[]>(DEFAULT_WORKFLOW_TOOLS);

  const [apiEndpoint, setApiEndpoint] = useState(DEFAULT_ANTHROPIC_BASE_URL);

  const [saved, setSaved] = useState(false);
  const [showAgentTools, setShowAgentTools] = useState(false);

  // Auto-dismiss saved indicator
  useTimeout(() => setSaved(false), saved ? 2000 : null);

  // Load settings from API on mount
  useMountEffect(() => {
    async function loadSettings() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await apiClient.settings.get(Object.values(SETTING_KEYS));
        if (result.ok) {
          const settings = result.data.settings;
          // Apply loaded settings, falling back to defaults if not set
          if (settings[SETTING_KEYS.DEFAULT_MODEL]) {
            setDefaultModel(settings[SETTING_KEYS.DEFAULT_MODEL] as string);
          }
          if (settings[SETTING_KEYS.TASK_CREATION_MODEL]) {
            setTaskCreationModel(settings[SETTING_KEYS.TASK_CREATION_MODEL] as string);
          }
          if (settings[SETTING_KEYS.WORKFLOW_MODEL]) {
            setWorkflowModel(settings[SETTING_KEYS.WORKFLOW_MODEL] as string);
          }
          if (settings[SETTING_KEYS.AGENT_TOOLS]) {
            setAgentTools(settings[SETTING_KEYS.AGENT_TOOLS] as string[]);
          }
          if (settings[SETTING_KEYS.TASK_CREATION_TOOLS]) {
            setTaskCreationTools(settings[SETTING_KEYS.TASK_CREATION_TOOLS] as string[]);
          }
          if (settings[SETTING_KEYS.WORKFLOW_TOOLS]) {
            setWorkflowTools(settings[SETTING_KEYS.WORKFLOW_TOOLS] as string[]);
          }
          if (settings[SETTING_KEYS.ANTHROPIC_BASE_URL]) {
            setApiEndpoint(settings[SETTING_KEYS.ANTHROPIC_BASE_URL] as string);
          }
        } else {
          console.error('Failed to load settings:', result.error);
          setError('Failed to load settings. Using defaults.');
        }
      } catch (err) {
        console.error('Error loading settings:', err);
        setError('Failed to load settings. Using defaults.');
      } finally {
        setIsLoading(false);
      }
    }
    void loadSettings();
  });

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const result = await apiClient.settings.update({
        [SETTING_KEYS.DEFAULT_MODEL]: defaultModel ?? DEFAULT_AGENT_MODEL,
        [SETTING_KEYS.TASK_CREATION_MODEL]: taskCreationModel ?? DEFAULT_TASK_CREATION_MODEL,
        [SETTING_KEYS.WORKFLOW_MODEL]: workflowModel ?? DEFAULT_WORKFLOW_MODEL,
        [SETTING_KEYS.AGENT_TOOLS]: agentTools,
        [SETTING_KEYS.TASK_CREATION_TOOLS]: taskCreationTools,
        [SETTING_KEYS.WORKFLOW_TOOLS]: workflowTools,
        [SETTING_KEYS.ANTHROPIC_BASE_URL]: apiEndpoint,
      });
      if (result.ok) {
        setSaved(true);
      } else {
        console.error('Failed to save settings:', result.error);
        setError('Failed to save settings. Please try again.');
      }
    } catch (err) {
      console.error('Error saving settings:', err);
      setError('Failed to save settings. Please try again.');
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [
    defaultModel,
    taskCreationModel,
    workflowModel,
    agentTools,
    taskCreationTools,
    workflowTools,
    apiEndpoint,
  ]);

  return (
    <div data-testid="model-optimizations-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      {/* Page Header with gradient accent */}
      <header className="relative mb-10">
        {/* Decorative background element */}
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-accent/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-claude/5 blur-xl" />

        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-accent-muted to-accent-subtle ring-1 ring-accent/20">
              <Gauge className="h-6 w-6 text-accent" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">
                Model &amp; Tool Configuration
              </h1>
              <p className="text-sm text-fg-muted">
                Fine-tune AI capabilities for different workflows
              </p>
            </div>
          </div>

          {/* Stats bar */}
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Cpu className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">3</span> configurations
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Lightning className="h-4 w-4 text-attention-fg" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">
                  {agentTools.length === 0 ? 'All' : agentTools.length}
                </span>{' '}
                agent tools
              </span>
            </div>
            <div className="flex items-center gap-2">
              <Circuitry className="h-4 w-4 text-done-fg" />
              <span className="text-xs text-fg-muted">
                API:{' '}
                <span className="font-mono text-[11px] text-fg">
                  {apiEndpoint === DEFAULT_ANTHROPIC_BASE_URL ? 'Default' : 'Custom'}
                </span>
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-5">
        {/* Agent Execution - Primary Configuration */}
        <ConfigSection
          icon={Robot}
          title="Agent Execution"
          description="Primary model and tool access for task agents"
          badge="Core"
          badgeColor="claude"
          testId="agent-execution-section"
        >
          <div className="space-y-6">
            {/* Model selector with visual enhancement */}
            <div>
              <span className="mb-3 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-subtle">
                <Brain className="h-3.5 w-3.5" />
                Default Agent Model
              </span>
              <p className="mb-3 text-sm text-fg-muted">
                The model used when agents work on in-progress tasks. Can be overridden per-task.
              </p>
              <div className="max-w-sm">
                <ModelSelector
                  value={defaultModel}
                  onChange={setDefaultModel}
                  data-testid="default-model-selector"
                />
              </div>
            </div>

            {/* Tools section with collapsible detail */}
            <div className="rounded-lg border border-border/50 bg-surface-subtle/30 p-4">
              <button
                type="button"
                onClick={() => setShowAgentTools(!showAgentTools)}
                className="flex w-full items-center justify-between"
              >
                <div className="flex items-center gap-3">
                  <div className="flex h-9 w-9 items-center justify-center rounded-lg bg-surface-emphasis">
                    <GearFine className="h-4 w-4 text-fg-muted" weight="duotone" />
                  </div>
                  <div className="text-left">
                    <h3 className="text-sm font-medium text-fg">Tool Access</h3>
                    <p className="text-xs text-fg-muted">
                      {agentTools.length === 0
                        ? 'All tools enabled for maximum capability'
                        : `${agentTools.length} tools enabled`}
                    </p>
                  </div>
                </div>
                <div className="flex items-center gap-3">
                  <span
                    className={cn(
                      'rounded-full px-2.5 py-1 text-xs font-medium',
                      agentTools.length === 0
                        ? 'bg-success-muted text-success'
                        : 'bg-surface-emphasis text-fg-muted'
                    )}
                  >
                    {agentTools.length === 0 ? 'All Tools' : `${agentTools.length} Selected`}
                  </span>
                  <div
                    className={cn(
                      'flex h-7 w-7 items-center justify-center rounded-md transition-all',
                      showAgentTools ? 'bg-accent-muted rotate-180' : 'bg-surface-emphasis'
                    )}
                  >
                    <svg
                      aria-hidden="true"
                      className={cn(
                        'h-3.5 w-3.5',
                        showAgentTools ? 'text-accent' : 'text-fg-muted'
                      )}
                      fill="none"
                      viewBox="0 0 24 24"
                      stroke="currentColor"
                      strokeWidth={2}
                    >
                      <path strokeLinecap="round" strokeLinejoin="round" d="M19 9l-7 7-7-7" />
                    </svg>
                  </div>
                </div>
              </button>

              <div
                className={cn(
                  'grid transition-all duration-200',
                  showAgentTools ? 'mt-4 grid-rows-[1fr] opacity-100' : 'grid-rows-[0fr] opacity-0'
                )}
              >
                <div className="overflow-hidden">
                  <div className="rounded-lg border border-border/50 bg-surface/50 p-4">
                    <ToolAccessSelector
                      value={agentTools}
                      onChange={setAgentTools}
                      data-testid="agent-tools-selector"
                    />
                  </div>
                </div>
              </div>
            </div>
          </div>
        </ConfigSection>

        {/* AI Features Section */}
        <ConfigSection
          icon={Sparkle}
          title="AI Features"
          description="Models and tools for AI-assisted workflows"
          badge="Assistants"
          badgeColor="accent"
          testId="ai-features-section"
        >
          <div className="grid gap-4 sm:grid-cols-2">
            <ConfigCard
              icon={Lightning}
              title="Task Creation"
              description="AI assistant for generating task descriptions and acceptance criteria"
              model={taskCreationModel}
              onModelChange={setTaskCreationModel}
              tools={taskCreationTools}
              onToolsChange={setTaskCreationTools}
              modelTestId="task-creation-model-selector"
              toolsTestId="task-creation-tools-selector"
            />
            <ConfigCard
              icon={TreeStructure}
              title="Workflow Designer"
              description="AI-powered workflow generation from skill definitions"
              model={workflowModel}
              onModelChange={setWorkflowModel}
              tools={workflowTools}
              onToolsChange={setWorkflowTools}
              modelTestId="workflow-model-selector"
              toolsTestId="workflow-tools-selector"
            />
          </div>
        </ConfigSection>

        {/* API Configuration */}
        <ConfigSection
          icon={Circuitry}
          title="API Configuration"
          description="Advanced connection settings"
          defaultOpen={false}
          testId="api-config-section"
        >
          <div>
            <label
              htmlFor="api-endpoint"
              className="mb-2 flex items-center gap-2 text-xs font-medium uppercase tracking-wider text-fg-subtle"
            >
              API Base URL
            </label>
            <p className="mb-3 text-sm text-fg-muted">
              Custom Anthropic API endpoint. Use the default unless you have a specific proxy or
              self-hosted deployment.
            </p>
            <div className="relative max-w-lg">
              <input
                id="api-endpoint"
                data-testid="api-endpoint-input"
                type="url"
                value={apiEndpoint}
                onChange={(e) => setApiEndpoint(e.target.value)}
                placeholder={DEFAULT_ANTHROPIC_BASE_URL}
                className="w-full rounded-lg border border-border bg-surface-subtle px-4 py-2.5 font-mono text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20 transition-all"
              />
              {apiEndpoint !== DEFAULT_ANTHROPIC_BASE_URL && (
                <button
                  type="button"
                  onClick={() => setApiEndpoint(DEFAULT_ANTHROPIC_BASE_URL)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 rounded-md px-2 py-1 text-xs text-fg-muted hover:bg-surface-emphasis hover:text-fg transition-colors"
                >
                  Reset
                </button>
              )}
            </div>
            <p className="mt-2 text-xs text-fg-subtle">
              Can also be set via{' '}
              <code className="rounded bg-surface-emphasis px-1.5 py-0.5">ANTHROPIC_BASE_URL</code>{' '}
              environment variable
            </p>
          </div>
        </ConfigSection>

        {/* Error message */}
        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <Warning className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        {/* Save Button - Sticky footer style */}
        <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-border bg-surface/95 px-5 py-4 shadow-lg backdrop-blur-sm">
          <p className="text-sm text-fg-muted">Settings are persisted to the database</p>
          <Button
            data-testid="save-model-settings"
            onClick={handleSave}
            disabled={isLoading || isSaving}
            className={cn(
              'min-w-[140px] transition-all',
              saved && 'bg-success-emphasis hover:bg-success-emphasis'
            )}
          >
            {isSaving ? (
              <>
                <CircleNotch className="h-4 w-4 animate-spin" />
                Saving...
              </>
            ) : saved ? (
              <>
                <Check className="h-4 w-4" weight="bold" />
                Saved!
              </>
            ) : (
              'Save Settings'
            )}
          </Button>
        </div>
      </div>
    </div>
  );
}
