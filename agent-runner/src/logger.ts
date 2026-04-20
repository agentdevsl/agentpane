/**
 * F10-05 — structured logger for the agent-runner.
 *
 * The runner previously emitted raw `console.*` strings, which the host
 * parsed as "this wasn't JSON so it must be non-event output" and dropped on
 * the floor. This logger emits one JSON object per line on STDERR:
 *
 *   {"level":"info","msg":"...","ts":"2026-04-20T12:34:56.789Z","correlationId":"req-..."}
 *
 * STDERR is chosen on purpose — the host bridge reads STDOUT for structured
 * events (`agent:*`) and STDERR for diagnostics. The host-side parser in
 * `container-bridge.ts` now recognises any JSON line with a `level` field as a
 * log line and routes it through `createLogger('agent-runner')` with the
 * correlation id preserved.
 */

const LEVELS = ['debug', 'info', 'warn', 'error'] as const;
export type LogLevel = (typeof LEVELS)[number];

export interface AgentRunnerLogRecord {
  /** Always 'agent-runner-log' so the host bridge can distinguish logs from events cheaply. */
  channel: 'agent-runner-log';
  level: LogLevel;
  msg: string;
  ts: string;
  correlationId?: string | null;
  taskId?: string | null;
  sessionId?: string | null;
  [key: string]: unknown;
}

function coerceLevel(value: string | undefined): LogLevel {
  if (!value) return 'info';
  return (LEVELS as readonly string[]).includes(value) ? (value as LogLevel) : 'info';
}

const envLevel = coerceLevel(process.env.AGENT_RUNNER_LOG_LEVEL?.toLowerCase());
const LEVEL_RANK: Record<LogLevel, number> = {
  debug: 10,
  info: 20,
  warn: 30,
  error: 40,
};

/**
 * Create a runner logger bound to a taskId + sessionId + correlationId.
 *
 * Values are read from the environment as the default — this matches the
 * runner's existing pattern where every process instance is scoped to exactly
 * one task.
 */
export function createAgentRunnerLogger(
  defaults?: Partial<Pick<AgentRunnerLogRecord, 'correlationId' | 'taskId' | 'sessionId'>>
) {
  const baseCorrelationId =
    defaults?.correlationId ??
    process.env.CORRELATION_ID ??
    process.env.AGENT_CORRELATION_ID ??
    null;
  const baseTaskId = defaults?.taskId ?? process.env.AGENT_TASK_ID ?? null;
  const baseSessionId = defaults?.sessionId ?? process.env.AGENT_SESSION_ID ?? null;

  function write(level: LogLevel, msg: string, extra?: Record<string, unknown>): void {
    if (LEVEL_RANK[level] < LEVEL_RANK[envLevel]) return;
    const record: AgentRunnerLogRecord = {
      channel: 'agent-runner-log',
      level,
      msg,
      ts: new Date().toISOString(),
      correlationId: baseCorrelationId,
      taskId: baseTaskId,
      sessionId: baseSessionId,
      ...(extra ?? {}),
    };
    try {
      // Emit on STDERR so the host bridge can split events (stdout) from logs
      // (stderr) without regex'ing the type field. A trailing newline is
      // required for line-delimited JSON parsing on the host.
      process.stderr.write(`${JSON.stringify(record)}\n`);
    } catch {
      // Fallback to console.error if stderr write fails — this should not
      // happen but we never want logging to crash the runner.
      // biome-ignore lint/suspicious/noConsole: fallback path only
      console.error(`[agent-runner] log serialise failed: ${msg}`);
    }
  }

  return {
    debug(msg: string, extra?: Record<string, unknown>) {
      write('debug', msg, extra);
    },
    info(msg: string, extra?: Record<string, unknown>) {
      write('info', msg, extra);
    },
    warn(msg: string, extra?: Record<string, unknown>) {
      write('warn', msg, extra);
    },
    error(msg: string, extra?: Record<string, unknown>) {
      write('error', msg, extra);
    },
  };
}

export type AgentRunnerLogger = ReturnType<typeof createAgentRunnerLogger>;

/**
 * Check whether a parsed JSON object looks like an agent-runner log record.
 * Used by the host-side container bridge to distinguish logs from events.
 */
export function isAgentRunnerLogRecord(value: unknown): value is AgentRunnerLogRecord {
  if (!value || typeof value !== 'object') return false;
  const rec = value as Record<string, unknown>;
  return (
    rec.channel === 'agent-runner-log' &&
    typeof rec.level === 'string' &&
    typeof rec.msg === 'string'
  );
}
