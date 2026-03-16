import {
  CheckCircle,
  Copy,
  DownloadSimple,
  FileCode,
  Lock,
  Sliders,
  SpinnerGap,
  Warning,
  XCircle,
} from '@phosphor-icons/react';
import { useCallback, useMemo, useRef, useState } from 'react';
import {
  Select,
  SelectContent,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from '@/app/components/ui/select';
import { Switch } from '@/app/components/ui/switch';
import { apiClient } from '@/lib/api/client';
import { generateTfvars } from '@/lib/terraform/generate-tfvars';
import {
  inferSmartWidget,
  type ParsedHclVariable,
  parseHclVariables,
  type SmartWidget,
} from '@/lib/terraform/parse-hcl-variables';
import { useTerraform } from './terraform-context';
import { downloadAsFile } from './terraform-utils';

interface ValidationDiagnostic {
  severity: 'error' | 'warning';
  summary: string;
  detail?: string;
}

interface ValidationResult {
  valid: boolean;
  diagnostics: ValidationDiagnostic[];
}

export function TerraformVariablesForm(): React.JSX.Element {
  const { generatedCode } = useTerraform();

  const variables = useMemo(
    () => (generatedCode ? parseHclVariables(generatedCode) : []),
    [generatedCode]
  );

  const [values, setValues] = useState<Record<string, string>>({});
  const [copied, setCopied] = useState(false);
  const [validating, setValidating] = useState(false);
  const [validation, setValidation] = useState<ValidationResult | null>(null);

  // When variables change (code regenerated), merge existing values with new variable set
  // Derive during render with ref instead of useEffect
  const prevVariablesRef = useRef(variables);
  if (prevVariablesRef.current !== variables) {
    prevVariablesRef.current = variables;
    setValues((prev) => {
      const next: Record<string, string> = {};
      for (const v of variables) {
        if (prev[v.name] !== undefined) {
          next[v.name] = prev[v.name] as string;
        } else if (v.default !== null) {
          next[v.name] = v.default;
        }
      }
      return next;
    });
    setValidation(null);
  }

  const tfvarsContent = useMemo(() => generateTfvars(variables, values), [variables, values]);

  const configuredCount = useMemo(
    () => variables.filter((v) => values[v.name] !== undefined && values[v.name] !== '').length,
    [variables, values]
  );

  const setValue = useCallback((name: string, value: string) => {
    setValues((prev) => ({ ...prev, [name]: value }));
    setValidation(null);
  }, []);

  const handleCopy = useCallback(async () => {
    if (!tfvarsContent) return;
    try {
      await navigator.clipboard.writeText(tfvarsContent);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      console.error('[Terraform] Failed to copy to clipboard:', err);
    }
  }, [tfvarsContent]);

  const handleDownload = useCallback(() => {
    if (!tfvarsContent) return;
    downloadAsFile(tfvarsContent, 'terraform.tfvars');
  }, [tfvarsContent]);

  const handleValidate = useCallback(async () => {
    if (!generatedCode) return;
    setValidating(true);
    setValidation(null);
    try {
      const result = await apiClient.terraform.validateCode({
        code: generatedCode,
        tfvars: tfvarsContent || undefined,
      });
      if (result.ok) {
        setValidation(result.data);
      } else {
        setValidation({
          valid: false,
          diagnostics: [
            { severity: 'error', summary: result.error?.message ?? 'Validation failed' },
          ],
        });
      }
    } catch (err) {
      setValidation({
        valid: false,
        diagnostics: [
          {
            severity: 'error',
            summary: err instanceof Error ? err.message : 'Failed to reach validation service',
          },
        ],
      });
    } finally {
      setValidating(false);
    }
  }, [generatedCode, tfvarsContent]);

  if (!generatedCode || variables.length === 0) {
    return (
      <div className="flex flex-1 flex-col items-center justify-center gap-3 px-6 py-12 text-center">
        <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-surface-emphasis">
          <Sliders className="h-6 w-6 text-fg-subtle" />
        </div>
        <p className="text-sm text-fg-muted">No variables found in generated code.</p>
      </div>
    );
  }

  return (
    <div className="flex h-full flex-col animate-slide-up">
      <div className="flex shrink-0 items-center justify-between border-b border-border bg-surface-subtle px-3 py-2">
        <span className="flex items-center gap-1.5 font-mono text-xs text-fg-muted">
          <FileCode className="h-3.5 w-3.5 text-fg-subtle" />
          terraform.tfvars
        </span>
        <div className="flex gap-1">
          <button
            type="button"
            onClick={handleCopy}
            disabled={!tfvarsContent}
            className="rounded p-1.5 text-fg-muted transition-all hover:bg-surface-emphasis hover:text-fg disabled:opacity-50"
            title="Copy to clipboard"
            aria-label="Copy to clipboard"
          >
            <Copy className="h-3.5 w-3.5" />
            {copied ? <span className="ml-1 text-[10px] text-success">Copied!</span> : null}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!tfvarsContent}
            className="rounded p-1.5 text-fg-muted transition-all hover:bg-surface-emphasis hover:text-fg disabled:opacity-50"
            title="Download terraform.tfvars"
            aria-label="Download terraform.tfvars"
          >
            <DownloadSimple className="h-3.5 w-3.5" />
          </button>
        </div>
      </div>

      <div className="min-h-0 flex-1 space-y-4 overflow-y-auto p-3">
        {variables.map((v) => (
          <VariableField
            key={v.name}
            variable={v}
            value={values[v.name] ?? ''}
            onChange={(val) => setValue(v.name, val)}
          />
        ))}
      </div>

      {validation ? <ValidationBanner result={validation} /> : null}

      <div className="flex shrink-0 items-center justify-between border-t border-border bg-surface-subtle px-3 py-2">
        <span className="text-[11px] text-fg-muted">
          {configuredCount} of {variables.length} configured
        </span>
        <div className="flex gap-1.5">
          <button
            type="button"
            onClick={handleValidate}
            disabled={validating}
            className="flex items-center gap-1.5 rounded-md border border-border bg-surface px-2.5 py-1 text-[11px] font-medium text-fg transition-colors hover:bg-surface-emphasis disabled:opacity-50"
          >
            {validating ? (
              <SpinnerGap className="h-3 w-3 animate-spin" />
            ) : (
              <CheckCircle className="h-3 w-3" />
            )}
            {validating ? 'Validating...' : 'Validate'}
          </button>
          <button
            type="button"
            onClick={handleDownload}
            disabled={!tfvarsContent}
            className="rounded-md bg-accent px-2.5 py-1 text-[11px] font-medium text-fg-on-accent transition-colors hover:bg-accent/90 disabled:opacity-50"
          >
            Download .tfvars
          </button>
        </div>
      </div>
    </div>
  );
}

function ValidationBanner({ result }: { result: ValidationResult }): React.JSX.Element {
  if (result.valid && result.diagnostics.length === 0) {
    return (
      <div className="flex shrink-0 items-center gap-2 border-t border-success/20 bg-success/10 px-3 py-2">
        <CheckCircle className="h-4 w-4 text-success" weight="fill" />
        <span className="text-[11px] font-medium text-success">Validation passed</span>
      </div>
    );
  }

  return (
    <div className="shrink-0 space-y-1 border-t border-danger/20 bg-danger/5 px-3 py-2">
      {result.diagnostics.map((d, i) => (
        <div key={`${d.severity}-${d.summary}-${i}`} className="flex items-start gap-2">
          {d.severity === 'error' ? (
            <XCircle className="mt-0.5 h-3.5 w-3.5 shrink-0 text-danger" weight="fill" />
          ) : (
            <Warning className="mt-0.5 h-3.5 w-3.5 shrink-0 text-attention" weight="fill" />
          )}
          <div className="min-w-0">
            <p className="text-[11px] font-medium text-fg">{d.summary}</p>
            {d.detail ? <p className="text-[10px] text-fg-muted">{d.detail}</p> : null}
          </div>
        </div>
      ))}
    </div>
  );
}

function VariableField({
  variable,
  value,
  onChange,
}: {
  variable: ParsedHclVariable;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  const smartWidget = useMemo(() => inferSmartWidget(variable), [variable]);

  return (
    <div className="space-y-1.5">
      <div className="flex items-center gap-2">
        <span className="font-mono text-xs font-medium text-fg">{variable.name}</span>
        {variable.required ? (
          <span className="rounded bg-attention/15 px-1.5 py-0.5 text-[9px] font-medium text-attention">
            required
          </span>
        ) : null}
        {variable.sensitive ? <Lock className="h-3 w-3 text-fg-subtle" weight="fill" /> : null}
      </div>

      {variable.description ? (
        <p className="text-[11px] leading-relaxed text-fg-muted">{variable.description}</p>
      ) : null}

      <VariableWidget
        variable={variable}
        smartWidget={smartWidget}
        value={value}
        onChange={onChange}
      />

      {variable.default !== null ? (
        <p className="text-[10px] text-fg-subtle">
          Default: <span className="font-mono">{variable.default}</span>
        </p>
      ) : null}
    </div>
  );
}

function VariableWidget({
  variable,
  smartWidget,
  value,
  onChange,
}: {
  variable: ParsedHclVariable;
  smartWidget: SmartWidget | null;
  value: string;
  onChange: (value: string) => void;
}): React.JSX.Element {
  if (smartWidget?.kind === 'select' && smartWidget.options) {
    return (
      <Select value={value} onValueChange={onChange}>
        <SelectTrigger className="h-8 text-xs">
          <SelectValue placeholder={`Select ${variable.name}...`} />
        </SelectTrigger>
        <SelectContent>
          {smartWidget.options.map((opt) => (
            <SelectItem key={opt} value={opt}>
              {opt}
            </SelectItem>
          ))}
        </SelectContent>
      </Select>
    );
  }

  if (smartWidget?.kind === 'switch' || variable.normalizedType === 'bool') {
    return (
      <div className="flex items-center gap-2">
        <Switch
          checked={value === 'true'}
          onCheckedChange={(checked) => onChange(checked ? 'true' : 'false')}
        />
        <span className="text-xs text-fg-muted">{value === 'true' ? 'true' : 'false'}</span>
      </div>
    );
  }

  if (variable.normalizedType === 'number') {
    return (
      <input
        type="number"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={variable.default ?? '0'}
        className="h-8 w-full rounded-md border border-border bg-surface-subtle px-2.5 font-mono text-xs text-fg transition duration-fast focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none"
      />
    );
  }

  if (
    variable.normalizedType === 'list' ||
    variable.normalizedType === 'map' ||
    variable.normalizedType === 'object'
  ) {
    const placeholder =
      variable.normalizedType === 'list'
        ? '["value1", "value2"]'
        : variable.normalizedType === 'map'
          ? '{\n  key = "value"\n}'
          : '{\n  field = "value"\n}';
    return (
      <textarea
        value={value}
        onChange={(e) => onChange(e.target.value)}
        placeholder={variable.default ?? placeholder}
        rows={3}
        className="w-full rounded-md border border-border bg-surface-subtle px-2.5 py-2 font-mono text-xs text-fg transition duration-fast focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none"
      />
    );
  }

  if (variable.sensitive) {
    return (
      <div className="relative">
        <input
          type="password"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="\u2022\u2022\u2022\u2022\u2022\u2022\u2022\u2022"
          className="h-8 w-full rounded-md border border-border bg-surface-subtle px-2.5 pr-8 font-mono text-xs text-fg transition duration-fast focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none"
        />
        <Lock className="absolute right-2.5 top-2 h-3.5 w-3.5 text-fg-subtle" />
      </div>
    );
  }

  return (
    <input
      type="text"
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={smartWidget?.placeholder ?? variable.default ?? `Enter ${variable.name}...`}
      className="h-8 w-full rounded-md border border-border bg-surface-subtle px-2.5 font-mono text-xs text-fg transition duration-fast focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none"
    />
  );
}
