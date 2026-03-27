export function formatTokens(tokens: number | null): string {
  if (tokens === null || !Number.isFinite(tokens) || tokens < 0) return '\u2014';
  if (tokens >= 1000) return `${(tokens / 1000).toFixed(1)}k`;
  return String(tokens);
}

export function formatCost(cost: number | null, precision = 2): string {
  if (cost === null || !Number.isFinite(cost) || cost < 0) return '\u2014';
  return `$${cost.toFixed(precision)}`;
}

export function formatDuration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return '\u2014';
  if (ms < 1000) return `${ms}ms`;
  const totalSeconds = Math.round(ms / 1000);
  if (totalSeconds < 60) return `${totalSeconds}s`;
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  if (seconds === 0) return `${minutes}m`;
  return `${minutes}m ${seconds}s`;
}

export function formatRelativeDate(dateStr: string | null): string {
  if (!dateStr) return 'Never';
  const date = new Date(dateStr);
  if (Number.isNaN(date.getTime())) return '\u2014';
  const now = new Date();
  const diffMs = now.getTime() - date.getTime();
  if (diffMs < 0) return date.toLocaleDateString();
  const diffMins = Math.floor(diffMs / 60_000);

  if (diffMins < 1) return 'Just now';
  if (diffMins < 60) return `${diffMins}m ago`;
  const diffHours = Math.floor(diffMins / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  const diffDays = Math.floor(diffHours / 24);
  if (diffDays < 7) return `${diffDays}d ago`;
  return date.toLocaleDateString();
}

export function formatTimestamp(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

export const INPUT_CLASS =
  'rounded-md border border-border bg-surface-subtle px-3 text-sm text-fg h-9 focus:border-accent focus:ring-2 focus:ring-accent-muted focus:outline-none';

export const DEFAULT_DREAM_MODEL = 'claude-haiku-4-5-20251001';

export const DREAM_MODEL_OPTIONS = [
  { value: 'claude-haiku-4-5-20251001', label: 'Claude Haiku 4.5 (cost-efficient)' },
  { value: 'claude-sonnet-4-6', label: 'Claude Sonnet 4.6 (balanced)' },
  { value: 'claude-opus-4-6', label: 'Claude Opus 4.6 (highest quality)' },
];
