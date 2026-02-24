/**
 * Options for buffered exec
 */
export interface ExecOptions {
  /** Allocation ID to exec into */
  allocId: string;
  /** Task name within the allocation */
  task: string;
  /** Command to execute (array of args) */
  command: string[];
  /** Allocate a TTY */
  tty?: boolean;
  /** Timeout in milliseconds (default: 60000) */
  timeoutMs?: number;
}

/**
 * Result of a buffered exec command
 */
export interface ExecResult {
  exitCode: number;
  stdout: string;
  stderr: string;
}

/**
 * Options for streaming exec (inherits all fields from ExecOptions including timeoutMs)
 */
export type ExecStreamOptions = ExecOptions;

/**
 * Result of a streaming exec
 */
export interface ExecStreamResult {
  /** Readable stream for stdout */
  stdout: ReadableStream<Uint8Array>;
  /** Readable stream for stderr */
  stderr: ReadableStream<Uint8Array>;
  /** Writable stream for stdin */
  stdin: WritableStream<Uint8Array>;
  /** Wait for the process to exit */
  wait(): Promise<{ exitCode: number }>;
  /** Kill the process */
  kill(): void;
}
