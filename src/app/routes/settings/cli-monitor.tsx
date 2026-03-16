import type { Icon } from '@phosphor-icons/react';
import { Check, CircleNotch, Database, Terminal, Timer, Warning } from '@phosphor-icons/react';
import { createFileRoute } from '@tanstack/react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { Button } from '@/app/components/ui/button';
import { ConfigSection } from '@/app/components/ui/config-section';
import { apiClient } from '@/lib/api/client';
import { cn } from '@/lib/utils/cn';

const SETTING_KEYS = {
  RETENTION_DAYS: 'cliMonitor.retentionDays',
} as const;

export const Route = createFileRoute('/settings/cli-monitor')({
  component: CliMonitorSettingsPage,
});

function NumberInputCard({
  icon: IconComponent,
  label,
  description,
  value,
  onChange,
  min,
  max,
  unit,
  testId,
}: {
  icon: Icon;
  label: string;
  description: string;
  value: string;
  onChange: (value: string) => void;
  min: number;
  max: number;
  unit?: string;
  testId?: string;
}) {
  return (
    <div className="rounded-lg border border-border/70 bg-surface-subtle/30 p-5 transition-all hover:border-border">
      <div className="mb-4 flex items-start gap-3">
        <div className="flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-md bg-surface-emphasis/50">
          <IconComponent className="h-4 w-4 text-fg-muted" weight="duotone" />
        </div>
        <div className="min-w-0 flex-1">
          <h3 className="text-sm font-medium text-fg">{label}</h3>
          <p className="mt-0.5 text-xs leading-relaxed text-fg-muted">{description}</p>
        </div>
      </div>
      <div className="flex items-center gap-3">
        <div className="relative">
          <input
            type="number"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            min={min}
            max={max}
            data-testid={testId}
            className="w-24 rounded-lg border border-border bg-surface px-3 py-2.5 text-center font-mono text-sm font-medium text-fg transition-all focus:border-accent focus:outline-none focus:ring-2 focus:ring-accent/20"
          />
        </div>
        {unit && (
          <span className="text-xs text-fg-muted">
            {unit} ({min}-{max})
          </span>
        )}
      </div>
    </div>
  );
}

function CliMonitorSettingsPage(): React.JSX.Element {
  const [isLoading, setIsLoading] = useState(true);
  const [isSaving, setIsSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [retentionDays, setRetentionDays] = useState('7');
  const [saved, setSaved] = useState(false);

  useEffect(() => {
    async function loadSettings() {
      setIsLoading(true);
      setError(null);
      try {
        const result = await apiClient.settings.get(Object.values(SETTING_KEYS));
        if (result.ok) {
          const settings = result.data.settings;
          if (settings[SETTING_KEYS.RETENTION_DAYS] !== undefined) {
            setRetentionDays(String(settings[SETTING_KEYS.RETENTION_DAYS]));
          }
        } else {
          setError('Failed to load settings. Using defaults.');
        }
      } catch {
        setError('Failed to load settings. Using defaults.');
      } finally {
        setIsLoading(false);
      }
    }
    loadSettings();
  }, []);

  const isSavingRef = useRef(false);
  const handleSave = useCallback(async () => {
    if (isSavingRef.current) return;
    isSavingRef.current = true;
    setIsSaving(true);
    setError(null);
    try {
      const result = await apiClient.settings.update({
        [SETTING_KEYS.RETENTION_DAYS]: retentionDays,
      });
      if (result.ok) {
        setSaved(true);
        setTimeout(() => setSaved(false), 2000);
      } else {
        setError('Failed to save settings. Please try again.');
      }
    } catch {
      setError('Failed to save settings. Please try again.');
    } finally {
      isSavingRef.current = false;
      setIsSaving(false);
    }
  }, [retentionDays]);

  return (
    <div data-testid="cli-monitor-settings" className="mx-auto max-w-4xl px-6 py-8 sm:px-8">
      <header className="relative mb-10">
        <div className="absolute -left-4 -top-4 h-24 w-24 rounded-full bg-claude/5 blur-2xl" />
        <div className="absolute right-0 top-0 h-16 w-16 rounded-full bg-accent/5 blur-xl" />
        <div className="relative">
          <div className="mb-3 flex items-center gap-3">
            <div className="flex h-12 w-12 items-center justify-center rounded-xl bg-gradient-to-br from-claude-muted to-claude-subtle ring-1 ring-claude/20">
              <Terminal className="h-6 w-6 text-claude" weight="duotone" />
            </div>
            <div>
              <h1 className="text-2xl font-semibold tracking-tight text-fg">CLI Monitor</h1>
              <p className="text-sm text-fg-muted">Configure session retention and cleanup</p>
            </div>
          </div>
          <div className="mt-6 flex flex-wrap gap-6 rounded-lg border border-border/50 bg-surface-subtle/50 px-5 py-3">
            <div className="flex items-center gap-2">
              <Timer className="h-4 w-4 text-fg-subtle" />
              <span className="text-xs text-fg-muted">
                <span className="font-medium text-fg">{retentionDays}</span> day
                {retentionDays !== '1' ? 's' : ''} retention
              </span>
            </div>
          </div>
        </div>
      </header>

      <div className="space-y-5">
        <ConfigSection
          icon={Database}
          title="Data Retention"
          description="Control how long completed CLI session data is kept"
          badge="Storage"
          badgeColor="accent"
          testId="retention-section"
        >
          <NumberInputCard
            icon={Timer}
            label="Retention Period"
            description="Number of days to keep completed session records before automatic cleanup"
            value={retentionDays}
            onChange={setRetentionDays}
            min={1}
            max={30}
            unit="days"
            testId="retention-days-input"
          />
        </ConfigSection>

        {error && (
          <div className="flex items-center gap-2 rounded-lg border border-danger/30 bg-danger/10 px-4 py-3 text-sm text-danger">
            <Warning className="h-4 w-4 flex-shrink-0" />
            {error}
          </div>
        )}

        <div className="sticky bottom-4 z-10 flex items-center justify-between rounded-xl border border-border bg-surface/95 px-5 py-4 shadow-lg backdrop-blur-sm">
          <p className="text-sm text-fg-muted">
            Completed sessions older than the retention period are automatically removed.
          </p>
          <Button
            data-testid="save-cli-monitor-settings"
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
