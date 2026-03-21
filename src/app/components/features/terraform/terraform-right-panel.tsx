import { Code, Copy, DownloadSimple, FileCode, GitBranch, Sliders } from '@phosphor-icons/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/app/components/ui/tabs';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { parseHclVariables } from '@/lib/terraform/parse-hcl-variables';
import { cn } from '@/lib/utils/cn';
import { useTerraform } from './terraform-context';
import { TerraformDependencyDiagram } from './terraform-dependency-diagram';
import { downloadAsFile } from './terraform-utils';
import { TerraformVariablesForm } from './terraform-variables-form';

export function TerraformRightPanel(): React.JSX.Element {
  const { generatedCode, generatedFiles, composeMode } = useTerraform();
  const [activeTab, setActiveTab] = useState('code');
  const [activeFileIdx, setActiveFileIdx] = useState(0);
  const prevCodeRef = useRef<string | null>(null);
  const isStacks = composeMode === 'stacks';

  const variableCount = useMemo(
    () => (!isStacks && generatedCode ? parseHclVariables(generatedCode).length : 0),
    [generatedCode, isStacks]
  );

  const activeFile = useMemo(() => {
    if (generatedFiles && generatedFiles.length > 1) {
      const file = generatedFiles[Math.min(activeFileIdx, generatedFiles.length - 1)];
      return file ?? null;
    }
    return null;
  }, [generatedFiles, activeFileIdx]);

  const displayCode = activeFile?.code ?? generatedCode;
  const displayFilename =
    activeFile?.filename ?? (composeMode === 'stacks' ? 'stack.tfcomponent.hcl' : 'main.tf');

  // Reset file index when files change (derive during render with ref)
  const prevFilesRef = useRef(generatedFiles);
  if (prevFilesRef.current !== generatedFiles) {
    prevFilesRef.current = generatedFiles;
    if (activeFileIdx !== 0) setActiveFileIdx(0);
  }

  // Derive effective tab: force 'code' when in stacks mode (dependencies/variables tabs hidden)
  const effectiveTab = isStacks && activeTab !== 'code' ? 'code' : activeTab;

  // Auto-switch tab when code is first generated (derive during render with ref)
  if (generatedCode && !prevCodeRef.current) {
    setActiveTab(composeMode === 'stacks' ? 'code' : 'dependencies');
  }
  prevCodeRef.current = generatedCode;

  return (
    <Tabs
      value={effectiveTab}
      onValueChange={setActiveTab}
      className="flex min-h-0 flex-1 flex-col bg-surface"
    >
      {/* Header with tabs */}
      <div className="flex shrink-0 items-center gap-2 border-b border-border bg-gradient-to-r from-surface to-surface-subtle px-3 py-2">
        <TabsList className="h-7 border-0 bg-transparent p-0">
          <TabsTrigger value="code" className="h-6 gap-1 px-2 text-[11px]">
            <Code className="h-3 w-3" />
            {isStacks ? 'Files' : 'Code'}
          </TabsTrigger>
          {!isStacks ? (
            <TabsTrigger value="dependencies" className="h-6 gap-1 px-2 text-[11px]">
              <GitBranch className="h-3 w-3" />
              Dependencies
            </TabsTrigger>
          ) : null}
          {!isStacks ? (
            <TabsTrigger value="variables" className="h-6 gap-1 px-2 text-[11px]">
              <Sliders className="h-3 w-3" />
              Variables
              {variableCount > 0 ? (
                <span className="ml-1 rounded-full bg-accent/15 px-1.5 text-[9px] font-medium text-accent">
                  {variableCount}
                </span>
              ) : null}
            </TabsTrigger>
          ) : null}
        </TabsList>
      </div>

      {/* Code tab */}
      <TabsContent value="code" className="mt-0 min-h-0 flex-1 overflow-hidden flex flex-col">
        {/* File sub-tabs when multiple stacks files */}
        {generatedFiles && generatedFiles.length > 1 ? (
          <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border bg-surface-subtle px-3 py-1.5">
            {generatedFiles.map((file, idx) => (
              <button
                key={file.filename}
                type="button"
                onClick={() => setActiveFileIdx(idx)}
                className={cn(
                  'flex items-center gap-1 rounded-md px-2 py-1 text-[11px] font-mono transition-colors',
                  idx === activeFileIdx
                    ? 'bg-[#844fba]/10 text-[#844fba] border border-[#844fba]/30'
                    : 'text-fg-muted hover:text-fg hover:bg-surface-emphasis'
                )}
              >
                <FileCode className="h-3 w-3 shrink-0" />
                {file.filename}
              </button>
            ))}
          </div>
        ) : null}
        <div className="min-h-0 flex-1 overflow-y-auto">
          <CodePreview code={displayCode} filename={displayFilename} />
        </div>
      </TabsContent>

      {/* Dependencies tab (standard Terraform only) */}
      {!isStacks ? (
        <TabsContent value="dependencies" className="mt-0 min-h-0 flex-1">
          <TerraformDependencyDiagram />
        </TabsContent>
      ) : null}

      {/* Variables tab (standard Terraform only) */}
      {!isStacks ? (
        <TabsContent value="variables" className="mt-0 min-h-0 flex-1 overflow-y-auto">
          <TerraformVariablesForm />
        </TabsContent>
      ) : null}
    </Tabs>
  );
}

// Preload shiki once when this module is first imported
const shikiPromise = import('shiki');

function useHighlightedCode(code: string | null): string | null {
  const [html, setHtml] = useState<string | null>(null);

  useWatchEffect(() => {
    if (!code) {
      setHtml(null);
      return;
    }
    let cancelled = false;
    shikiPromise
      .then(({ codeToHtml }) =>
        codeToHtml(code, {
          lang: 'hcl',
          theme: 'github-dark-default',
        }).then((result) => {
          if (!cancelled) setHtml(result);
        })
      )
      .catch((err) => {
        if (!cancelled) {
          console.error('[Terraform] Failed to load syntax highlighting:', err);
        }
      });
    return () => {
      cancelled = true;
    };
  }, [code]);

  return html;
}

function CodePreview({
  code,
  filename = 'main.tf',
}: {
  code: string | null;
  filename?: string;
}): React.JSX.Element {
  const [copied, setCopied] = useState(false);
  const highlightedHtml = useHighlightedCode(code);

  const handleCopy = useCallback(async () => {
    if (!code) return;
    try {
      await navigator.clipboard.writeText(code);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[Terraform] Failed to copy to clipboard:', err);
    }
  }, [code]);

  const handleDownload = useCallback(() => {
    if (!code) return;
    downloadAsFile(code, filename);
  }, [code, filename]);

  if (!code) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-emphasis">
          <Code className="h-6 w-6 text-fg-subtle" />
        </div>
        <p className="text-sm text-fg-muted">
          {filename.endsWith('.hcl')
            ? 'Generated Stacks files will appear here.'
            : 'Generated Terraform code will appear here.'}
        </p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col animate-slide-up">
      {/* Filename bar + actions */}
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface-subtle px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-xs text-fg-muted">
          <FileCode className="h-3.5 w-3.5 text-fg-subtle" />
          {filename}
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleCopy}
            className="rounded p-1.5 text-fg-muted transition-all hover:bg-surface-emphasis hover:text-fg"
            title="Copy to clipboard"
            aria-label="Copy to clipboard"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? <span className="ml-1 text-[10px] text-success">Copied!</span> : null}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            className="rounded p-1.5 text-fg-muted transition-all hover:bg-surface-emphasis hover:text-fg"
            title={`Download ${filename}`}
            aria-label={`Download ${filename}`}
          >
            <DownloadSimple className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      {/* Code block with optional syntax highlighting */}
      <div className="min-h-0 flex-1 overflow-auto">
        {highlightedHtml ? (
          <div
            className="terraform-code-preview p-3 text-xs leading-relaxed [&_pre]:!bg-transparent [&_code]:font-mono"
            // biome-ignore lint/security/noDangerouslySetInnerHtml: shiki escapes code input and produces safe HTML
            dangerouslySetInnerHTML={{ __html: highlightedHtml }}
          />
        ) : (
          <pre className="p-3 font-mono text-xs leading-relaxed text-fg">
            <code>{code}</code>
          </pre>
        )}
      </div>
    </div>
  );
}
