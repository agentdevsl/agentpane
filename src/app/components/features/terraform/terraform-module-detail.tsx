import {
  ArrowLeft,
  Calendar,
  ChatCircle,
  Cube,
  Link as LinkIcon,
  SignIn,
  SignOut,
} from '@phosphor-icons/react';
import { Link, useNavigate } from '@tanstack/react-router';
import type React from 'react';
import { useState } from 'react';
import ReactMarkdown from 'react-markdown';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import type { TerraformOutput, TerraformVariable } from '@/db/schema';
import { apiClient } from '@/lib/api/client';
import { PROVIDER_COLORS, type TerraformModuleView } from '@/lib/terraform/types';

// Hoisted ReactMarkdown component overrides (stable references prevent DOM remounts)
const markdownComponents: import('react-markdown').Components = {
  h2: ({ children }) => (
    <h2 className="mb-3 border-b border-border-muted pb-2 text-lg font-semibold">{children}</h2>
  ),
  h3: ({ children }) => <h3 className="mb-2 mt-4 text-[15px] font-semibold">{children}</h3>,
  p: ({ children }) => <p className="mb-3 text-fg-muted">{children}</p>,
  code: ({ className, children, ...rest }) => {
    const isBlock = className?.includes('language-');
    if (isBlock) {
      return (
        <code className="text-xs leading-relaxed text-fg" {...rest}>
          {children}
        </code>
      );
    }
    return (
      <code
        className="rounded bg-surface-subtle px-1.5 py-0.5 font-mono text-xs text-accent"
        {...rest}
      >
        {children}
      </code>
    );
  },
  pre: ({ children }) => (
    <pre className="mb-3 overflow-x-auto rounded-md bg-surface-subtle p-4 font-mono">
      {children}
    </pre>
  ),
};

type DetailTab = 'overview' | 'inputs' | 'outputs' | 'dependencies' | 'readme';

interface TabDef {
  key: DetailTab;
  label: string;
  count?: number;
}

function formatDate(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'long', day: 'numeric' });
}

function formatDateShort(dateStr: string | null): string {
  if (!dateStr) return 'Unknown';
  const date = new Date(dateStr);
  return date.toLocaleDateString('en-US', { year: 'numeric', month: 'short', day: 'numeric' });
}

function formatDefault(value: unknown): string {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value;
  return JSON.stringify(value);
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

function ModuleHeader({ mod }: { mod: TerraformModuleView }): React.JSX.Element {
  const providerColor =
    PROVIDER_COLORS[mod.provider.toLowerCase()] ?? 'bg-surface-emphasis text-fg-muted';
  const inputCount = mod.inputs?.length ?? 0;
  const outputCount = mod.outputs?.length ?? 0;
  const depCount = mod.dependencies?.length ?? 0;

  return (
    <div className="border-b border-border bg-surface px-6 py-6">
      <div className="font-mono text-xl font-semibold tracking-tight text-fg">{mod.name}</div>

      <div className="mt-3 flex items-center gap-2">
        <span className="rounded bg-surface-emphasis px-2 py-0.5 font-mono text-xs text-fg-muted">
          v{mod.version}
        </span>
        <span className={`rounded px-2 py-0.5 text-xs font-semibold uppercase ${providerColor}`}>
          {mod.provider}
        </span>
      </div>

      <div className="mt-3">
        <span className="inline-block rounded bg-surface-subtle px-2 py-1 font-mono text-xs text-fg-subtle">
          {mod.source}
        </span>
      </div>

      <div className="mt-3 flex items-center gap-6 text-xs text-fg-muted">
        <span className="flex items-center gap-1">
          <Calendar className="h-3.5 w-3.5" />
          Published {formatDateShort(mod.publishedAt)}
        </span>
        <span className="flex items-center gap-1">
          <SignIn className="h-3.5 w-3.5" />
          {inputCount} inputs
        </span>
        <span className="flex items-center gap-1">
          <SignOut className="h-3.5 w-3.5" />
          {outputCount} outputs
        </span>
        <span className="flex items-center gap-1">
          <LinkIcon className="h-3.5 w-3.5" />
          {depCount} dependencies
        </span>
      </div>
    </div>
  );
}

function TabBar({
  tabs,
  activeTab,
  onTabChange,
}: {
  tabs: TabDef[];
  activeTab: DetailTab;
  onTabChange: (tab: DetailTab) => void;
}): React.JSX.Element {
  return (
    <div className="flex border-b border-border bg-surface px-6">
      {tabs.map((tab) => (
        <button
          key={tab.key}
          type="button"
          onClick={() => onTabChange(tab.key)}
          className={`px-4 py-3 text-[13px] font-medium transition-colors ${
            activeTab === tab.key
              ? 'border-b-2 border-accent text-accent'
              : 'border-b-2 border-transparent text-fg-muted hover:text-fg'
          }`}
        >
          {tab.label}
          {tab.count !== undefined && (
            <span className="ml-1 rounded-full bg-surface-emphasis px-1.5 py-0.5 text-[11px] text-fg-subtle">
              {tab.count}
            </span>
          )}
        </button>
      ))}
    </div>
  );
}

function OverviewTab({ mod }: { mod: TerraformModuleView }): React.JSX.Element {
  const sections = [
    { label: 'Description', value: mod.description ?? 'No description available.' },
    { label: 'Published', value: formatDate(mod.publishedAt) },
    { label: 'Registry', value: mod.namespace },
    { label: 'Provider', value: mod.provider },
    { label: 'Source', value: mod.source },
  ];

  return (
    <div className="p-6">
      {sections.map((s) => (
        <div key={s.label} className="mb-6">
          <div className="mb-2 text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
            {s.label}
          </div>
          <div className="text-sm leading-relaxed text-fg">{s.value}</div>
        </div>
      ))}
    </div>
  );
}

function InputsTab({ inputs }: { inputs: TerraformVariable[] }): React.JSX.Element {
  if (inputs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <p className="text-sm text-fg-muted">This module has no input variables.</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th
              className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
              style={{ width: 180 }}
            >
              Name
            </th>
            <th
              className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
              style={{ width: 120 }}
            >
              Type
            </th>
            <th
              className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
              style={{ width: 70 }}
            >
              Required
            </th>
            <th
              className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
              style={{ width: 140 }}
            >
              Default
            </th>
            <th className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {inputs.map((input) => (
            <tr
              key={input.name}
              className="group border-b border-border-muted last:border-b-0 hover:bg-surface-subtle"
            >
              <td className="px-3 py-3 align-top">
                <span className="font-mono text-xs font-medium text-accent">{input.name}</span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className="font-mono text-xs text-fg-subtle">{input.type}</span>
              </td>
              <td className="px-3 py-3 align-top">
                <span
                  className={`text-[11px] font-semibold ${input.required ? 'text-danger' : 'text-fg-subtle'}`}
                >
                  {input.required ? 'Yes' : 'No'}
                </span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className="font-mono text-xs text-fg-muted">
                  {formatDefault(input.default)}
                </span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className="text-xs leading-relaxed text-fg-muted">
                  {input.description ?? '-'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function OutputsTab({ outputs }: { outputs: TerraformOutput[] }): React.JSX.Element {
  if (outputs.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <p className="text-sm text-fg-muted">This module has no outputs.</p>
      </div>
    );
  }

  return (
    <div className="px-6 py-4">
      <table className="w-full border-collapse text-[13px]">
        <thead>
          <tr>
            <th
              className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle"
              style={{ width: 220 }}
            >
              Name
            </th>
            <th className="bg-surface-subtle px-3 py-2 text-left text-[11px] font-semibold uppercase tracking-wide text-fg-subtle">
              Description
            </th>
          </tr>
        </thead>
        <tbody>
          {outputs.map((output) => (
            <tr
              key={output.name}
              className="group border-b border-border-muted last:border-b-0 hover:bg-surface-subtle"
            >
              <td className="px-3 py-3 align-top">
                <span className="font-mono text-xs font-medium text-accent">{output.name}</span>
              </td>
              <td className="px-3 py-3 align-top">
                <span className="text-xs leading-relaxed text-fg-muted">
                  {output.description ?? '-'}
                </span>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function DependenciesTab({ dependencies }: { dependencies: string[] }): React.JSX.Element {
  if (dependencies.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <p className="text-sm text-fg-muted">This module has no dependencies.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="flex flex-col gap-2">
        {dependencies.map((dep) => (
          <div
            key={dep}
            className="flex items-center gap-3 rounded-md border border-border bg-surface p-3 transition-colors hover:border-fg-subtle"
          >
            <div className="flex h-8 w-8 items-center justify-center rounded-md bg-[rgba(132,79,186,0.15)]">
              <Cube className="h-4 w-4 text-[#844fba]" />
            </div>
            <div>
              <div className="font-mono text-[13px] font-medium text-fg">{dep}</div>
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}

function ReadmeTab({ readme }: { readme: string | null | undefined }): React.JSX.Element {
  if (!readme) {
    return (
      <div className="flex flex-col items-center justify-center gap-2 p-12 text-center">
        <p className="text-sm text-fg-muted">No readme available for this module.</p>
      </div>
    );
  }

  return (
    <div className="p-6">
      <div className="rounded-md border border-border bg-surface p-6 text-sm leading-[1.8] text-fg">
        <ReactMarkdown components={markdownComponents}>{readme}</ReactMarkdown>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main component
// ---------------------------------------------------------------------------

export function TerraformModuleDetail({ moduleId }: { moduleId: string }): React.JSX.Element {
  const navigate = useNavigate();
  const [mod, setMod] = useState<TerraformModuleView | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [activeTab, setActiveTab] = useState<DetailTab>('overview');

  useWatchEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);

    void apiClient.terraform.getModule(moduleId).then((res) => {
      if (cancelled) return;
      if (res.ok) {
        setMod(res.data as TerraformModuleView);
      } else {
        setError(res.error.message);
      }
      setLoading(false);
    });

    return () => {
      cancelled = true;
    };
  }, [moduleId]);

  // Loading state
  if (loading) {
    return (
      <div className="flex h-full flex-col">
        {/* Header skeleton */}
        <div className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="flex items-center gap-3">
            <div className="h-6 w-20 animate-pulse rounded bg-surface-emphasis" />
            <div className="h-5 w-64 animate-pulse rounded bg-surface-emphasis" />
          </div>
        </div>
        <div className="flex flex-1 items-center justify-center">
          <p className="text-sm text-fg-muted">Loading module...</p>
        </div>
      </div>
    );
  }

  // Error state
  if (error || !mod) {
    return (
      <div className="flex h-full flex-col">
        <div className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
          <div className="flex items-center gap-3">
            <Link
              to="/terraform/modules"
              className="flex items-center gap-1 rounded px-2 py-1 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
            >
              <ArrowLeft className="h-4 w-4" />
              Modules
            </Link>
          </div>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-2">
          <p className="text-sm text-fg-muted">{error ?? 'Module not found.'}</p>
          <Link to="/terraform/modules" className="text-sm text-accent hover:underline">
            Back to modules
          </Link>
        </div>
      </div>
    );
  }

  const inputs = (mod.inputs ?? []) as TerraformVariable[];
  const outputs = (mod.outputs ?? []) as TerraformOutput[];
  const dependencies = mod.dependencies ?? [];

  const tabs: TabDef[] = [
    { key: 'overview', label: 'Overview' },
    { key: 'inputs', label: 'Inputs', count: inputs.length },
    { key: 'outputs', label: 'Outputs', count: outputs.length },
    { key: 'dependencies', label: 'Dependencies', count: dependencies.length },
    { key: 'readme', label: 'Readme' },
  ];

  return (
    <div className="flex h-full flex-col overflow-hidden">
      {/* Page header */}
      <div className="flex items-center justify-between border-b border-border bg-surface px-6 py-3">
        <div className="flex items-center gap-3">
          <Link
            to="/terraform/modules"
            className="flex items-center gap-1 rounded px-2 py-1 text-sm text-fg-muted transition-colors hover:bg-surface-subtle hover:text-fg"
          >
            <ArrowLeft className="h-4 w-4" />
            Modules
          </Link>
          <span className="text-sm font-semibold text-fg">
            Terraform
            <span className="mx-1 text-fg-subtle">/</span>
            Modules
            <span className="mx-1 text-fg-subtle">/</span>
            {mod.name}
          </span>
        </div>
        <div>
          <button
            type="button"
            onClick={() => navigate({ to: '/terraform', search: { tab: 'compose' } })}
            className="inline-flex items-center gap-2 rounded-md bg-accent px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-emphasis"
          >
            <ChatCircle className="h-4 w-4" />
            Use in Compose
          </button>
        </div>
      </div>

      {/* Scrollable content */}
      <div className="flex-1 overflow-y-auto">
        <ModuleHeader mod={mod} />
        <TabBar tabs={tabs} activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'overview' && <OverviewTab mod={mod} />}
        {activeTab === 'inputs' && <InputsTab inputs={inputs} />}
        {activeTab === 'outputs' && <OutputsTab outputs={outputs} />}
        {activeTab === 'dependencies' && <DependenciesTab dependencies={dependencies} />}
        {activeTab === 'readme' && <ReadmeTab readme={mod.readme} />}
      </div>
    </div>
  );
}
