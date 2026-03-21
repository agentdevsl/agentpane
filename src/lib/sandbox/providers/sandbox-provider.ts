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
   * List all sandboxes
   */
  list(): Promise<SandboxInfo[]>;

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
