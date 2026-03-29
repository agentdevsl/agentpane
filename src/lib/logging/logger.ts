/**
 * Structured JSON Logger
 *
 * Provides structured logging with levels, context, and request IDs.
 * Outputs JSON in production, human-readable in development.
 */

import { getRequestId } from '../context/request-context.js';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

// --- Sensitive data masking ---

const SENSITIVE_FIELD_NAMES = new Set([
  'token',
  'key',
  'secret',
  'password',
  'credential',
  'authorization',
  'cookie',
  'apikey',
  'api_key',
  'privatekey',
  'private_key',
]);

const SENSITIVE_VALUE_PATTERNS: RegExp[] = [
  /^sk-ant-.*/,
  /^ghp_.*/,
  /^ghs_.*/,
  /^gho_.*/,
  /^github_pat_.*/,
];

function isSensitiveFieldName(name: string): boolean {
  return SENSITIVE_FIELD_NAMES.has(name.toLowerCase());
}

function isSensitiveValue(value: string): boolean {
  return SENSITIVE_VALUE_PATTERNS.some((pattern) => pattern.test(value));
}

/**
 * Recursively masks sensitive data in objects and arrays.
 * Returns a new object — does not mutate the input.
 */
export function maskSensitiveData<T>(obj: T): T {
  if (obj === null || obj === undefined) {
    return obj;
  }

  if (typeof obj === 'string') {
    return (isSensitiveValue(obj) ? '[REDACTED]' : obj) as T;
  }

  if (Array.isArray(obj)) {
    return obj.map((item) => maskSensitiveData(item)) as T;
  }

  if (typeof obj === 'object') {
    const result: Record<string, unknown> = {};
    for (const [fieldName, value] of Object.entries(obj as Record<string, unknown>)) {
      if (isSensitiveFieldName(fieldName)) {
        result[fieldName] = '[REDACTED]';
      } else {
        result[fieldName] = maskSensitiveData(value);
      }
    }
    return result as T;
  }

  return obj;
}

const LOG_LEVELS: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LogEntry {
  level: LogLevel;
  service: string;
  environment: string;
  message: string;
  timestamp: string;
  context?: string;
  requestId?: string;
  data?: Record<string, unknown>;
  error?: {
    message: string;
    stack?: string;
    code?: string;
  };
}

// Computed once at module load for performance
const serviceName = process.env.SERVICE_NAME || 'agentpane';
const environment = process.env.NODE_ENV || 'development';

const VALID_LOG_LEVELS = new Set<string>(['debug', 'info', 'warn', 'error']);

const minLevel: LogLevel = (() => {
  const envLevel = process.env.LOG_LEVEL;
  if (envLevel) {
    if (VALID_LOG_LEVELS.has(envLevel)) {
      return envLevel as LogLevel;
    }
    console.warn(
      `[Logger] Invalid LOG_LEVEL="${envLevel}", expected one of: debug, info, warn, error. Falling back to default.`
    );
  }
  return process.env.NODE_ENV === 'production' ? 'info' : 'debug';
})();

const isProduction = process.env.NODE_ENV === 'production';

function shouldLog(level: LogLevel): boolean {
  return LOG_LEVELS[level] >= LOG_LEVELS[minLevel];
}

function formatEntry(entry: LogEntry): string {
  if (isProduction) {
    return JSON.stringify(entry);
  }

  // Human-readable for development
  const prefix = entry.context ? `[${entry.context}]` : '';
  const reqId = entry.requestId ? ` (req:${entry.requestId.slice(0, 8)})` : '';
  const dataStr = entry.data ? ` ${JSON.stringify(entry.data)}` : '';
  const errStr = entry.error ? ` err=${entry.error.message}` : '';
  return `${entry.level.toUpperCase()} ${prefix}${reqId} ${entry.message}${dataStr}${errStr}`;
}

function serializeError(err: unknown): LogEntry['error'] | undefined {
  if (!err) return undefined;
  if (err instanceof Error) {
    return {
      message: err.message,
      stack: err.stack,
      code: (err as { code?: string }).code,
    };
  }
  return { message: String(err) };
}

function log(
  level: LogLevel,
  message: string,
  opts?: { context?: string; requestId?: string; data?: Record<string, unknown>; error?: unknown }
) {
  if (!shouldLog(level)) return;

  const requestId = opts?.requestId ?? getRequestId();

  const entry: LogEntry = {
    level,
    service: serviceName,
    environment,
    message,
    timestamp: new Date().toISOString(),
    context: opts?.context,
    requestId,
    data: opts?.data ? maskSensitiveData(opts.data) : undefined,
    error: maskSensitiveData(serializeError(opts?.error)),
  };

  const formatted = formatEntry(entry);

  switch (level) {
    case 'error':
      console.error(formatted);
      break;
    case 'warn':
      console.warn(formatted);
      break;
    case 'debug':
      console.debug(formatted);
      break;
    default:
      console.log(formatted);
  }
}

/**
 * Create a logger with a fixed context prefix.
 *
 * @example
 * const log = createLogger('TaskService');
 * log.info('Task created', { data: { taskId: '123' } });
 */
export function createLogger(context: string) {
  return {
    debug: (
      message: string,
      opts?: { requestId?: string; data?: Record<string, unknown>; error?: unknown }
    ) => log('debug', message, { ...opts, context }),
    info: (
      message: string,
      opts?: { requestId?: string; data?: Record<string, unknown>; error?: unknown }
    ) => log('info', message, { ...opts, context }),
    warn: (
      message: string,
      opts?: { requestId?: string; data?: Record<string, unknown>; error?: unknown }
    ) => log('warn', message, { ...opts, context }),
    error: (
      message: string,
      opts?: { requestId?: string; data?: Record<string, unknown>; error?: unknown }
    ) => log('error', message, { ...opts, context }),
  };
}

export type Logger = ReturnType<typeof createLogger>;
