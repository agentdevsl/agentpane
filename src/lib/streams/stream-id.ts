/**
 * Branded stream-ID types. F05-01.
 *
 * Stream IDs carry a prefix that determines routing (see specs/application/integrations/durable-streams.md).
 * A bare CUID is a session stream, `plan:{id}` is a plan stream, etc. Before these branded
 * types existed, every publish site composed the prefix via string concatenation and nothing
 * rejected a plan-typed event published to a bare CUID — it would silently land in
 * session_events and be delivered at the session SSE URL.
 *
 * These tagged types make the kind-of-stream-id a compile-time invariant. Factory functions
 * own the prefix concatenation. `DurableStreamsService.publish` accepts the union.
 *
 * Migration note: existing call sites still pass raw strings; they are gradually migrated to
 * factory calls. The runtime `assertStreamIdKind` helper verifies the prefix at publish time.
 */

const BRAND = Symbol('StreamIdBrand');

type Branded<T extends string> = string & { readonly [BRAND]: T };

export type PlanStreamId = Branded<'plan'>;
export type SandboxStreamId = Branded<'sandbox'>;
export type TerraformStreamId = Branded<'terraform'>;
export type SessionStreamId = Branded<'session'>;
export type CliMonitorStreamId = Branded<'cli-monitor'>;

/** Union of all typed stream IDs. */
export type StreamId =
  | PlanStreamId
  | SandboxStreamId
  | TerraformStreamId
  | SessionStreamId
  | CliMonitorStreamId;

/** Literal singleton for the CLI monitor stream. */
export const CLI_MONITOR_STREAM_ID = 'cli-monitor' as CliMonitorStreamId;

const STREAM_ID_BODY = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

function assertNonEmptyBody(id: string, label: string): void {
  if (!id || typeof id !== 'string' || !STREAM_ID_BODY.test(id)) {
    throw new Error(`[stream-id] ${label} stream ID body '${id}' is not a valid identifier`);
  }
}

/** Construct a plan stream ID (`plan:{id}`). */
export function planStreamId(id: string): PlanStreamId {
  assertNonEmptyBody(id, 'plan');
  return `plan:${id}` as PlanStreamId;
}

/** Construct a sandbox stream ID (`sandbox:{id}`). */
export function sandboxStreamId(id: string): SandboxStreamId {
  assertNonEmptyBody(id, 'sandbox');
  return `sandbox:${id}` as SandboxStreamId;
}

/** Construct a terraform stream ID (`terraform:{jobId}`). */
export function terraformStreamId(id: string): TerraformStreamId {
  assertNonEmptyBody(id, 'terraform');
  return `terraform:${id}` as TerraformStreamId;
}

/** Construct a session stream ID (bare CUID). */
export function sessionStreamId(id: string): SessionStreamId {
  assertNonEmptyBody(id, 'session');
  return id as SessionStreamId;
}

export type StreamIdKind = 'plan' | 'sandbox' | 'terraform' | 'session' | 'cli-monitor';

/**
 * Identify the kind of a raw stream-ID string.
 * Returns null if it doesn't match any known convention.
 */
export function classifyStreamId(id: string): StreamIdKind | null {
  if (!id || typeof id !== 'string') return null;
  if (id === 'cli-monitor') return 'cli-monitor';
  if (id.startsWith('plan:')) return 'plan';
  if (id.startsWith('sandbox:')) return 'sandbox';
  if (id.startsWith('terraform:')) return 'terraform';
  // Bare strings without a known prefix are treated as session streams.
  if (!id.includes(':')) return 'session';
  return null;
}

/**
 * Runtime assertion: at a publish site, verify that the stream ID's prefix
 * matches the expected kind. Throws on mismatch — use when branded types
 * cannot be enforced at compile time (e.g. values crossing service boundaries
 * as plain strings).
 */
export function assertStreamIdKind(id: string, expected: StreamIdKind): void {
  const actual = classifyStreamId(id);
  if (actual !== expected) {
    throw new Error(
      `[stream-id] Expected ${expected} stream ID, got '${actual ?? 'unknown'}' for '${id}'`
    );
  }
}

/** Expected stream-ID kind for a given event type prefix. */
export function expectedStreamIdKindForEventType(type: string): StreamIdKind {
  if (type.startsWith('plan:')) return 'plan';
  if (type.startsWith('sandbox:')) return 'sandbox';
  if (type.startsWith('terraform:')) return 'terraform';
  // container-agent, task-creation, topology, and raw session events all
  // run on session streams.
  return 'session';
}
