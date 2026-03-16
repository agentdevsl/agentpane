import { ArrowSquareOut, ChatCircle, Clock, Cube, MagnifyingGlass } from '@phosphor-icons/react';
import { Link } from '@tanstack/react-router';
import { useMemo, useState } from 'react';
import type { CompositionEntry } from '@/lib/terraform/types';

const STORAGE_KEY = 'terraform-compositions';

/** Group compositions by date bucket (single pass) */
function groupByDate(entries: CompositionEntry[]): { label: string; items: CompositionEntry[] }[] {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const yesterday = today - 86_400_000;
  const lastWeek = today - 7 * 86_400_000;

  const todayItems: CompositionEntry[] = [];
  const yesterdayItems: CompositionEntry[] = [];
  const lastWeekItems: CompositionEntry[] = [];
  const olderItems: CompositionEntry[] = [];

  for (const e of entries) {
    if (e.timestamp >= today) todayItems.push(e);
    else if (e.timestamp >= yesterday) yesterdayItems.push(e);
    else if (e.timestamp >= lastWeek) lastWeekItems.push(e);
    else olderItems.push(e);
  }

  const groups: { label: string; items: CompositionEntry[] }[] = [];
  if (todayItems.length) groups.push({ label: 'Today', items: todayItems });
  if (yesterdayItems.length) groups.push({ label: 'Yesterday', items: yesterdayItems });
  if (lastWeekItems.length) groups.push({ label: 'Last Week', items: lastWeekItems });
  if (olderItems.length) groups.push({ label: 'Older', items: olderItems });

  return groups;
}

/** Format a timestamp for display */
function formatTimestamp(timestamp: number): string {
  const now = new Date();
  const today = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
  const date = new Date(timestamp);

  const timeStr = date.toLocaleTimeString('en-US', {
    hour: 'numeric',
    minute: '2-digit',
    hour12: true,
  });

  if (timestamp >= today) {
    return timeStr;
  }

  const dateStr = date.toLocaleDateString('en-US', {
    month: 'short',
    day: 'numeric',
  });

  return `${dateStr}, ${timeStr}`;
}

/** Mock data for initial display */
function getMockCompositions(): CompositionEntry[] {
  const now = Date.now();
  return [
    {
      id: '1',
      title: 'VPC with 3 private subnets, EKS cluster, and RDS PostgreSQL database',
      timestamp: now - 3_600_000,
      moduleCount: 3,
      status: 'completed',
    },
    {
      id: '2',
      title: 'S3 bucket with versioning and CloudFront distribution',
      timestamp: now - 7_200_000,
      moduleCount: 2,
      status: 'in_progress',
    },
    {
      id: '3',
      title: 'Lambda functions with API Gateway and DynamoDB',
      timestamp: now - 86_400_000 - 3_600_000,
      moduleCount: 4,
      status: 'completed',
    },
    {
      id: '4',
      title: 'Multi-region disaster recovery setup with Route53 failover',
      timestamp: now - 86_400_000 - 28_800_000,
      moduleCount: 6,
      status: 'failed',
    },
    {
      id: '5',
      title: 'IAM roles and policies for EKS service accounts',
      timestamp: now - 5 * 86_400_000,
      moduleCount: 2,
      status: 'completed',
    },
    {
      id: '6',
      title: 'RDS Aurora cluster with read replicas and automated backups',
      timestamp: now - 6 * 86_400_000,
      moduleCount: 3,
      status: 'completed',
    },
  ];
}

/** Load compositions from localStorage, falling back to mock data */
function loadCompositions(): CompositionEntry[] {
  try {
    const stored = localStorage.getItem(STORAGE_KEY);
    if (stored) {
      return JSON.parse(stored) as CompositionEntry[];
    }
  } catch {
    // ignore parse errors
  }
  const mock = getMockCompositions();
  localStorage.setItem(STORAGE_KEY, JSON.stringify(mock));
  return mock;
}

/** Save a new composition entry to localStorage */
export function addComposition(entry: CompositionEntry): void {
  const existing = loadCompositions();
  existing.unshift(entry);
  localStorage.setItem(STORAGE_KEY, JSON.stringify(existing));
}

function StatusBadge({ status }: { status: CompositionEntry['status'] }) {
  if (status === 'completed') {
    return (
      <span className="inline-flex items-center rounded-full bg-success-muted px-2 py-0.5 text-[11px] font-semibold text-success">
        Completed
      </span>
    );
  }
  if (status === 'in_progress') {
    return (
      <span className="inline-flex items-center rounded-full bg-accent-muted px-2 py-0.5 text-[11px] font-semibold text-accent">
        <span className="mr-1 inline-block h-1.5 w-1.5 animate-pulse rounded-full bg-accent" />
        In Progress
      </span>
    );
  }
  return (
    <span className="inline-flex items-center rounded-full bg-danger-muted px-2 py-0.5 text-[11px] font-semibold text-danger">
      Failed
    </span>
  );
}

function CompositionCard({ entry }: { entry: CompositionEntry }) {
  const iconBg =
    entry.status === 'in_progress'
      ? 'bg-accent-muted'
      : entry.status === 'failed'
        ? 'bg-danger-muted'
        : 'bg-[rgba(132,79,186,0.15)]';

  const iconColor =
    entry.status === 'in_progress'
      ? 'text-accent'
      : entry.status === 'failed'
        ? 'text-danger'
        : 'text-[#844fba]';

  const borderClass = entry.status === 'in_progress' ? 'border-accent' : 'border-border';

  return (
    <div
      className={`flex cursor-pointer items-center gap-4 rounded-md border bg-surface p-4 transition-colors hover:border-fg-subtle ${borderClass}`}
    >
      <div className={`flex h-10 w-10 shrink-0 items-center justify-center rounded-md ${iconBg}`}>
        <Cube className={`h-5 w-5 ${iconColor}`} />
      </div>
      <div className="min-w-0 flex-1">
        <div className="mb-0.5 truncate text-sm font-medium text-fg">{entry.title}</div>
        <div className="flex items-center gap-3 text-xs text-fg-subtle">
          <span className="flex items-center gap-1">
            <Clock className="h-3 w-3" />
            {formatTimestamp(entry.timestamp)}
          </span>
          <span className="rounded-full bg-surface-emphasis px-2 py-0.5 font-mono text-[11px] text-fg-muted">
            {entry.moduleCount} {entry.moduleCount === 1 ? 'module' : 'modules'}
          </span>
          <StatusBadge status={entry.status} />
        </div>
      </div>
      <div className="shrink-0">
        {entry.status === 'in_progress' ? (
          <Link
            to="/terraform"
            className="inline-flex items-center gap-1.5 rounded-md border border-transparent bg-accent-emphasis px-2 py-1 text-xs font-medium text-white transition-colors hover:bg-accent"
          >
            <ArrowSquareOut className="h-3.5 w-3.5" />
            Resume
          </Link>
        ) : (
          <Link
            to="/terraform"
            className="inline-flex items-center gap-1.5 rounded-md border border-border bg-surface-subtle px-2 py-1 text-xs font-medium text-fg transition-colors hover:border-fg-subtle hover:bg-surface-emphasis"
          >
            <ArrowSquareOut className="h-3.5 w-3.5" />
            Reopen
          </Link>
        )}
      </div>
    </div>
  );
}

export function TerraformCompositionHistory(): React.JSX.Element {
  const [search, setSearch] = useState('');
  const compositions = useMemo(() => loadCompositions(), []);

  const filtered = useMemo(() => {
    if (!search.trim()) return compositions;
    const q = search.toLowerCase();
    return compositions.filter((c) => c.title.toLowerCase().includes(q));
  }, [compositions, search]);

  const groups = useMemo(() => groupByDate(filtered), [filtered]);
  const isEmpty = compositions.length === 0;

  if (isEmpty) {
    return (
      <div className="flex flex-1 flex-col overflow-y-auto p-6">
        <div className="mb-6 flex items-baseline gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Composition History</h2>
        </div>
        <div className="flex flex-1 flex-col items-center justify-center gap-4 py-8 text-center">
          <div className="flex h-14 w-14 items-center justify-center rounded-xl bg-surface-emphasis">
            <Clock className="h-7 w-7 text-fg-subtle" />
          </div>
          <h3 className="text-base font-semibold text-fg">No compositions yet</h3>
          <p className="max-w-[360px] text-[13px] leading-relaxed text-fg-muted">
            Start a new composition in the Compose view. Your past compositions will appear here so
            you can revisit and iterate on them.
          </p>
          <Link
            to="/terraform"
            className="inline-flex items-center gap-2 rounded-md bg-accent-emphasis px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent"
          >
            <ChatCircle className="h-4 w-4" />
            Start Composing
          </Link>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 overflow-y-auto p-6">
      {/* Header */}
      <div className="mb-6 flex items-center justify-between">
        <div className="flex items-baseline gap-2">
          <h2 className="text-lg font-semibold tracking-tight">Composition History</h2>
          <span className="text-[13px] text-fg-muted">
            {filtered.length} {filtered.length === 1 ? 'composition' : 'compositions'}
          </span>
        </div>
        <div className="relative inline-flex items-center">
          <MagnifyingGlass className="pointer-events-none absolute left-3 h-3.5 w-3.5 text-fg-subtle" />
          <input
            type="text"
            value={search}
            onChange={(e) => setSearch(e.target.value)}
            placeholder="Search compositions..."
            className="h-9 w-80 rounded-md border border-border bg-surface pl-9 pr-3 text-sm text-fg placeholder:text-fg-subtle focus:border-accent focus:outline-none focus:ring-[3px] focus:ring-accent-muted"
          />
        </div>
      </div>

      {/* Composition list */}
      <div className="flex flex-col gap-3">
        {groups.map((group, gi) => (
          <div key={group.label} className={gi > 0 ? 'mt-4' : ''}>
            <div className="mb-2 py-2 text-xs font-semibold uppercase tracking-wide text-fg-subtle">
              {group.label}
            </div>
            <div className="flex flex-col gap-3">
              {group.items.map((entry) => (
                <CompositionCard key={entry.id} entry={entry} />
              ))}
            </div>
          </div>
        ))}

        {filtered.length === 0 && compositions.length > 0 && (
          <div className="flex flex-col items-center gap-2 py-12 text-center">
            <MagnifyingGlass className="h-6 w-6 text-fg-subtle" />
            <p className="text-sm text-fg-muted">No compositions match your search.</p>
          </div>
        )}
      </div>
    </div>
  );
}
