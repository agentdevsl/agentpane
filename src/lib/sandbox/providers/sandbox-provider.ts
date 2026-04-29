import type { Readable } from 'node:stream';
import type {
  ExecResult,
  SandboxConfig,
  SandboxHealthCheck,
  SandboxInfo,
  SandboxMetrics,
  TmuxSession,
} from '../types.js';

/**
 * Options for streaming exec
 */
export interface ExecStreamOptions {
  /** Command to execute */
  cmd: string;
  /** Command arguments */
  args?: string[];
  /** Environment variables to set */
  env?: Record<string, string>;
  /** Working directory */
  cwd?: string;
  /** Run as root */
  asRoot?: boolean;
}

/**
 * Result of a streaming exec
 */
export interface ExecStreamResult {
  /** Readable stream for stdout */
  stdout: Readable;
  /** Readable stream for stderr */
  stderr: Readable;
  /** Promise that resolves when the process exits */
  wait(): Promise<{ exitCode: number }>;
  /** Kill the process */
  kill(): void | Promise<void>;
}

/**
 * Sandbox instance interface
 * Represents a running sandbox container
 */
export interface Sandbox {
  /** Unique sandbox ID */
  readonly id: string;

  /** Codespace this sandbox belongs to */
  readonly codespaceId: string;

  /** Underlying container ID */
  readonly containerId: string;

  /** Current sandbox status */
  readonly status: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error';

  /**
   * Execute a command inside the sandbox as the default user
   */
  exec(cmd: string, args?: string[]): Promise<ExecResult>;

  /**
   * Execute a command inside the sandbox as root
   */
  execAsRoot(cmd: string, args?: string[]): Promise<ExecResult>;

  /**
   * Create a new tmux session
   */
  createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession>;

  /**
   * List all tmux sessions
   */
  listTmuxSessions(): Promise<TmuxSession[]>;

  /**
   * Kill a tmux session
   */
  killTmuxSession(sessionName: string): Promise<void>;

  /**
   * Send keys to a tmux session
   */
  sendKeysToTmux(sessionName: string, keys: string): Promise<void>;

  /**
   * Capture tmux pane output
   */
  captureTmuxPane(sessionName: string, lines?: number): Promise<string>;

  /**
   * Stop the sandbox
   */
  stop(): Promise<void>;

  /**
   * Get resource metrics
   */
  getMetrics(): Promise<SandboxMetrics>;

  /**
   * Update last activity timestamp
   */
  touch(): void;

  /**
   * Get last activity timestamp
   */
  getLastActivity(): Date;

  /**
   * Execute a command with streaming output.
   * Returns readable streams for stdout/stderr instead of buffered strings.
   */
  execStream?(options: ExecStreamOptions): Promise<ExecStreamResult>;

  /**
   * Write a file inside the sandbox without going through an exec `sh -c` path.
   *
   * theme-04 P1-05: Credential material must never appear in argv (visible via
   * `ps`, proc entries, and container audit logs). Providers that support
   * out-of-band file transfer (Docker via `putArchive`, K8s/Nomad via `cp`)
   * implement this so credentials can be streamed over the file channel
   * rather than embedded in a shell command.
   *
   * If the provider does not implement this, callers should fall back to the
   * existing shell-exec path and accept the risk.
   */
  writeFile?(path: string, content: string | Buffer, mode?: number): Promise<void>;
}

/**
 * Result of a provider recovery sweep on startup.
 *
 * theme-04 P1-03: Every provider must run `recover()` at boot so orphaned
 * sandboxes from the previous process are discovered, either re-registered in
 * memory or torn down. The Docker provider also tracks how many stale-image
 * containers were removed; K8s / Nomad providers populate `recovered` and may
 * leave `removed` at zero.
 */
export interface RecoverResult {
  /** Number of sandboxes re-registered into the in-memory cache. */
  recovered: number;
  /** Number of stale/stopped sandboxes torn down during the sweep. */
  removed: number;
}

/**
 * Sandbox provider interface
 * Abstraction over different container runtimes (Docker, OrbStack, Apple Container, etc.)
 */
export interface SandboxProvider {
  /** Provider name (e.g., 'docker', 'orbstack') */
  readonly name: string;

  /**
   * Create a new sandbox from configuration
   */
  create(config: SandboxConfig): Promise<Sandbox>;

  /**
   * Get an existing sandbox by codespace ID
   */
  get(codespaceId: string): Promise<Sandbox | null>;

  /**
   * Get sandbox by sandbox ID
   */
  getById(sandboxId: string): Promise<Sandbox | null>;

  /**
   * List all sandboxes.
   *
   * theme-04 P1-01: every provider implements this — Docker, K8s, Nomad. On
   * transient failures the provider should throw (K8s/Nomad) or return an
   * empty list (Docker) consistent with its cluster listing semantics. Callers
   * should treat a thrown `list()` as "unknown", not "none".
   */
  list(): Promise<SandboxInfo[]>;

  /**
   * Reconcile in-memory state with the runtime on boot.
   *
   * theme-04 P1-03: crash-safe startup — scan the runtime for agentpane
   * sandboxes, re-register running ones into the in-memory cache, tear down
   * stale/stopped ones. Implemented by Docker, K8s and Nomad providers. The
   * default implementation is a no-op for providers that do not persist state
   * across restarts (e.g. AgentCore).
   */
  recover(): Promise<RecoverResult>;

  /**
   * Pull a container image
   */
  pullImage(image: string): Promise<void>;

  /**
   * Check if an image is available locally
   */
  isImageAvailable(image: string): Promise<boolean>;

  /**
   * Perform a health check
   */
  healthCheck(): Promise<SandboxHealthCheck>;

  /**
   * Clean up stopped or idle sandboxes
   */
  cleanup(options?: { olderThan?: Date; status?: string[] }): Promise<number>;
}

/**
 * Event emitted by sandbox provider
 */
export type SandboxProviderEvent =
  | { type: 'sandbox:creating'; sandboxId: string; codespaceId: string }
  | { type: 'sandbox:created'; sandboxId: string; codespaceId: string; containerId: string }
  | { type: 'sandbox:starting'; sandboxId: string }
  | { type: 'sandbox:started'; sandboxId: string }
  | { type: 'sandbox:idle'; sandboxId: string; idleSince: Date }
  | { type: 'sandbox:stopping'; sandboxId: string; reason: string }
  | { type: 'sandbox:stopped'; sandboxId: string }
  | { type: 'sandbox:error'; sandboxId: string; error: Error };

/**
 * Sandbox provider event listener
 */
export type SandboxProviderEventListener = (event: SandboxProviderEvent) => void;

/**
 * Extended sandbox provider with event support
 */
export interface EventEmittingSandboxProvider extends SandboxProvider {
  /**
   * Add an event listener
   */
  on(listener: SandboxProviderEventListener): () => void;

  /**
   * Remove an event listener
   */
  off(listener: SandboxProviderEventListener): void;
}
