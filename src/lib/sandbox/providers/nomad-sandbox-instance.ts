import { PassThrough, type Readable } from 'node:stream';
import type { NomadAllocClientStatus } from '@agentpane/nomad-sandbox-sdk';
import {
  ConnectionError,
  type NomadSandboxClient,
  NotFoundError,
  TimeoutError,
} from '@agentpane/nomad-sandbox-sdk';
import { NomadErrors } from '../../errors/nomad-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { ExecResult, SandboxMetrics, SandboxStatus, TmuxSession } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import { mapNomadJobStatus } from './nomad-sandbox-provider.js';
import type { ExecStreamOptions, ExecStreamResult, Sandbox } from './sandbox-provider.js';

const log = createLogger('NomadSandboxInstance');

/**
 * Sandbox instance backed by a Nomad job.
 *
 * Implements the Sandbox interface defined in sandbox-provider.ts by delegating
 * to the Nomad SDK client's exec and lifecycle methods. Nomad handles the
 * underlying allocation scheduling; this class provides the application-layer
 * abstraction.
 */
export class NomadSandboxInstance implements Sandbox {
  private _lastActivity: Date;
  private _status: SandboxStatus = 'creating';
  private readonly _createdAt = new Date();

  constructor(
    /** Unique sandbox ID (cuid2) */
    public readonly id: string,
    /** Nomad job name (also serves as containerId) */
    private readonly jobName: string,
    /** Allocation ID for exec operations */
    private allocId: string,
    /** Project this sandbox belongs to */
    public readonly projectId: string,
    /** Nomad namespace */
    readonly namespace: string,
    /** Nomad SDK client */
    private readonly client: NomadSandboxClient
  ) {
    this._lastActivity = new Date();
  }

  /**
   * Maps to the Nomad job name for interface compatibility.
   * The Sandbox interface requires a containerId; for Nomad sandboxes
   * the job name serves this purpose.
   */
  get containerId(): string {
    return this.jobName;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  private assertRunning(): void {
    if (this._status !== 'running' && this._status !== 'creating') {
      throw NomadErrors.JOB_NOT_RUNNING(this.jobName, this._status);
    }
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    this.assertRunning();
    this.touch();

    try {
      const result = await this.client.exec({
        allocId: this.allocId,
        task: 'sandbox',
        command: [cmd, ...args],
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    } catch (error) {
      if (error instanceof TimeoutError) {
        throw NomadErrors.EXEC_TIMEOUT(cmd, 60_000);
      }
      if (error instanceof ConnectionError) {
        throw NomadErrors.CLUSTER_UNREACHABLE('nomad', error.message);
      }
      const message = error instanceof Error ? error.message : String(error);
      throw NomadErrors.EXEC_FAILED(cmd, message);
    }
  }

  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
    log.warn(
      'execAsRoot called but Nomad provider does not support root execution, running as default user',
      { data: { cmd } }
    );
    const result = await this.exec(cmd, args);
    return {
      ...result,
      stderr: `[WARNING: Running as default user - root execution not supported by Nomad provider]\n${result.stderr}`,
    };
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    try {
      // Stop the Nomad job with purge=true to remove it entirely.
      await this.client.stopJob(this.jobName, true);
      this._status = 'stopped';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this._status = 'error';
      throw NomadErrors.JOB_STOP_FAILED(this.jobName, message);
    }
  }

  /**
   * Escape a string for safe use in shell commands.
   * Uses single quotes and handles embedded single quotes.
   * Matches the DockerSandbox.shellEscape pattern used across sandbox implementations.
   */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Execute a command with streaming output.
   *
   * Wraps the SDK's Web API ReadableStreams in Node.js PassThrough streams
   * to match the ExecStreamResult contract (which expects Node Readable).
   */
  async execStream(options: ExecStreamOptions): Promise<ExecStreamResult> {
    this.assertRunning();
    this.touch();

    const { cmd, args = [], env = {}, cwd } = options;

    // Build the command with cwd handling.
    let fullCmd: string[];
    if (cwd) {
      const escapedCwd = this.shellEscape(cwd);
      const escapedCmd = this.shellEscape(cmd);
      const escapedArgs = args.map((arg) => this.shellEscape(arg)).join(' ');
      fullCmd = ['sh', '-c', `cd ${escapedCwd} && exec ${escapedCmd} ${escapedArgs}`];
    } else {
      fullCmd = [cmd, ...args];
    }

    // Build environment variables for the exec.
    const envEntries = Object.entries(env);
    if (envEntries.length > 0) {
      // Validate env keys to prevent command injection
      const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
      for (const [key] of envEntries) {
        if (!ENV_KEY_PATTERN.test(key)) {
          throw NomadErrors.EXEC_FAILED(cmd, `Invalid environment variable key: ${key}`);
        }
      }

      const envPrefix = envEntries.map(([k, v]) => `${k}=${this.shellEscape(v)}`).join(' ');

      if (fullCmd[0] === 'sh' && fullCmd[1] === '-c') {
        // Already wrapped in shell -- inject env before `exec`
        const shBody = fullCmd[2] ?? '';
        const execIdx = shBody.indexOf('exec ');
        if (execIdx !== -1) {
          fullCmd = [
            'sh',
            '-c',
            `${shBody.slice(0, execIdx)}${envPrefix} ${shBody.slice(execIdx)}`,
          ];
        } else {
          fullCmd = [
            'sh',
            '-c',
            `export ${envEntries.map(([k, v]) => `${k}=${this.shellEscape(v)}`).join(' ')}; ${shBody}`,
          ];
        }
      } else {
        fullCmd = ['env', ...envEntries.map(([k, v]) => `${k}=${this.shellEscape(v)}`), ...fullCmd];
      }
    }

    // Delegate to the SDK's execStream which manages the Nomad exec WebSocket.
    const sdkStream = this.client.execStream({
      allocId: this.allocId,
      task: 'sandbox',
      command: fullCmd,
    });

    // Pipe SDK web ReadableStreams through PassThrough Node streams for the
    // ExecStreamResult interface, which requires Node Readable streams. We use
    // pipeTo with a WritableStream adapter that writes chunks into the PassThrough.
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    // Track abort controllers so kill() can cancel the pipe
    const stdoutAbort = new AbortController();
    const stderrAbort = new AbortController();

    sdkStream.stdout
      .pipeTo(
        new WritableStream({
          write(chunk) {
            stdoutStream.write(chunk);
          },
        }),
        { signal: stdoutAbort.signal }
      )
      .then(() => stdoutStream.end())
      .catch((err) => {
        if (err?.name !== 'AbortError') {
          log.warn('stdout pipe error during execStream', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
        stdoutStream.end();
      });

    sdkStream.stderr
      .pipeTo(
        new WritableStream({
          write(chunk) {
            stderrStream.write(chunk);
          },
        }),
        { signal: stderrAbort.signal }
      )
      .then(() => stderrStream.end())
      .catch((err) => {
        if (err?.name !== 'AbortError') {
          log.warn('stderr pipe error during execStream', {
            error: err instanceof Error ? err : new Error(String(err)),
          });
        }
        stderrStream.end();
      });

    return {
      stdout: stdoutStream as Readable,
      stderr: stderrStream as Readable,

      async wait(): Promise<{ exitCode: number }> {
        return sdkStream.wait();
      },

      async kill(): Promise<void> {
        stdoutAbort.abort();
        stderrAbort.abort();
        stdoutStream.end();
        stderrStream.end();
        sdkStream.kill();
      },
    };
  }

  // --- tmux session management ---

  async createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession> {
    this.assertRunning();
    this.touch();

    // Check if session already exists
    const listResult = await this.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    if (listResult.stdout.split('\n').includes(sessionName)) {
      throw NomadErrors.TMUX_SESSION_ALREADY_EXISTS(sessionName);
    }

    // Create new tmux session
    const result = await this.exec('tmux', ['new-session', '-d', '-s', sessionName]);
    if (result.exitCode !== 0) {
      throw NomadErrors.TMUX_CREATION_FAILED(sessionName, result.stderr);
    }

    return {
      name: sessionName,
      sandboxId: this.id,
      taskId,
      createdAt: new Date().toISOString(),
      windowCount: 1,
      attached: false,
    };
  }

  async listTmuxSessions(): Promise<TmuxSession[]> {
    this.assertRunning();
    this.touch();

    const result = await this.exec('tmux', [
      'list-sessions',
      '-F',
      '#{session_name}:#{session_windows}:#{session_attached}',
    ]);

    if (result.exitCode !== 0) {
      // Expected: no tmux server running = no sessions
      if (result.stderr.includes('no server running') || result.stderr.includes('no sessions')) {
        return [];
      }
      throw NomadErrors.EXEC_FAILED('tmux list-sessions', result.stderr);
    }

    return result.stdout
      .split('\n')
      .filter(Boolean)
      .map((line) => {
        const parts = line.split(':');
        const name = parts[0] ?? '';
        const windows = parts[1] ?? '1';
        const attached = parts[2] ?? '0';
        return {
          name,
          sandboxId: this.id,
          createdAt: new Date().toISOString(),
          windowCount: parseInt(windows, 10) || 1,
          attached: attached === '1',
        };
      })
      .filter((session) => session.name !== '');
  }

  async killTmuxSession(sessionName: string): Promise<void> {
    this.touch();

    const result = await this.exec('tmux', ['kill-session', '-t', sessionName]);
    if (result.exitCode !== 0) {
      // Treat "session not found" as success
      if (
        result.stderr.includes('session not found') ||
        result.stderr.includes("can't find session")
      ) {
        return;
      }
      throw NomadErrors.EXEC_FAILED(`tmux kill-session -t ${sessionName}`, result.stderr);
    }
  }

  async sendKeysToTmux(sessionName: string, keys: string): Promise<void> {
    this.assertRunning();
    this.touch();

    const result = await this.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
    if (result.exitCode !== 0) {
      throw NomadErrors.EXEC_FAILED(`tmux send-keys -t ${sessionName}`, result.stderr);
    }
  }

  async captureTmuxPane(sessionName: string, lines = 100): Promise<string> {
    this.assertRunning();
    this.touch();

    const result = await this.exec('tmux', [
      'capture-pane',
      '-t',
      sessionName,
      '-p',
      '-S',
      `-${lines}`,
    ]);

    if (result.exitCode !== 0) {
      throw NomadErrors.EXEC_FAILED(`tmux capture-pane -t ${sessionName}`, result.stderr);
    }

    return result.stdout;
  }

  // --- Metrics ---

  /**
   * Placeholder metrics implementation. All resource values are hardcoded to zero.
   * Uptime is calculated from the instance creation time.
   */
  async getMetrics(): Promise<SandboxMetrics> {
    try {
      // Verify job still exists in the cluster before reporting metrics.
      await this.client.getJob(this.jobName);
      const uptime = Date.now() - this._createdAt.getTime();

      return {
        cpuUsagePercent: 0,
        memoryUsageMb: 0,
        memoryLimitMb: SANDBOX_DEFAULTS.memoryMb,
        diskUsageMb: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        uptime,
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to get metrics for ${this.jobName}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw NomadErrors.EXEC_FAILED('getMetrics', message);
    }
  }

  // --- Activity tracking ---

  touch(): void {
    this._lastActivity = new Date();
  }

  getLastActivity(): Date {
    return this._lastActivity;
  }

  /**
   * Refresh status from the actual Nomad job status.
   * Called by the provider after constructing an instance from a cluster query.
   */
  async refreshStatus(): Promise<void> {
    try {
      const job = await this.client.getJob(this.jobName);
      const jobStatus = job?.Status;

      if (jobStatus === 'dead') {
        // Check allocation status for more detail
        const allocs = await this.client.getJobAllocations(this.jobName);
        const latestAlloc = allocs[0];
        if (latestAlloc) {
          this._status = this.mapAllocStatusToSandboxStatus(latestAlloc.ClientStatus);
        } else {
          this._status = 'stopped';
        }
      } else {
        this._status = mapNomadJobStatus(jobStatus);

        // Update allocId in case of reschedule
        if (jobStatus === 'running') {
          const allocs = await this.client.getJobAllocations(this.jobName);
          const runningAlloc = allocs.find((a) => a.ClientStatus === 'running');
          if (runningAlloc && runningAlloc.ID !== this.allocId) {
            log.info(
              `Allocation rescheduled for ${this.jobName}: ${this.allocId} → ${runningAlloc.ID}`
            );
            this.allocId = runningAlloc.ID;
          }
        }
      }
    } catch (error) {
      if (error instanceof NotFoundError) {
        this._status = 'stopped';
      } else {
        log.error(`refreshStatus failed for job ${this.jobName}`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this._status = 'error';
      }
    }
  }

  /**
   * Map Nomad allocation client status to SandboxStatus for dead jobs.
   *
   * Nomad alloc statuses: 'pending' | 'running' | 'complete' | 'failed' | 'lost'
   */
  private mapAllocStatusToSandboxStatus(clientStatus?: NomadAllocClientStatus): SandboxStatus {
    switch (clientStatus) {
      case 'complete':
        return 'stopped';
      case 'failed':
      case 'lost':
        return 'error';
      default:
        return 'stopped';
    }
  }
}
