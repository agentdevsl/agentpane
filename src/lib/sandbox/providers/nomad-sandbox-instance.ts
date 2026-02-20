import { PassThrough, type Readable } from 'node:stream';
import type { NomadSandboxClient } from '@agentpane/nomad-sandbox-sdk';
import { NomadErrors } from '../../errors/nomad-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { ExecResult, SandboxMetrics, SandboxStatus, TmuxSession } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
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

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
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
      const message = error instanceof Error ? error.message : String(error);
      throw NomadErrors.EXEC_FAILED(cmd, message);
    }
  }

  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
    // Nomad sandboxes run as non-root by default.
    // Root execution is not supported -- same behavior as K8s instance.
    log.warn('execAsRoot called but Nomad sandboxes run as non-root. Executing as default user.');
    return this.exec(cmd, args);
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
   * Matches the AgentSandboxInstance.shellEscape pattern.
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
    // ContainerBridge contract. We use pipeTo with a WritableStream adapter
    // that writes chunks into the PassThrough.
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
    this.touch();

    const result = await this.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
    if (result.exitCode !== 0) {
      throw NomadErrors.EXEC_FAILED(`tmux send-keys -t ${sessionName}`, result.stderr);
    }
  }

  async captureTmuxPane(sessionName: string, lines = 100): Promise<string> {
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

  async getMetrics(): Promise<SandboxMetrics> {
    this.touch();

    try {
      // Verify job exists. Using last activity as a cheap uptime proxy
      // (Nomad allocations expose CreateTime but we skip the extra API call).
      await this.client.getJob(this.jobName);
      const uptime = Date.now() - this._lastActivity.getTime();

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
      log.warn(`Failed to get metrics for ${this.jobName}, returning placeholder values`, {
        error,
      });
      return {
        cpuUsagePercent: 0,
        memoryUsageMb: 0,
        memoryLimitMb: 0,
        diskUsageMb: 0,
        networkRxBytes: 0,
        networkTxBytes: 0,
        uptime: Date.now() - this._lastActivity.getTime(),
      };
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
        this._status = this.mapJobStatusToSandboxStatus(jobStatus);

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
      if (error instanceof Error && error.name === 'NotFoundError') {
        this._status = 'stopped';
      } else {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`refreshStatus failed for job ${this.jobName}`, {
          error: error instanceof Error ? error : new Error(message),
          data: { jobName: this.jobName, allocId: this.allocId, projectId: this.projectId },
        });
        this._status = 'error';
      }
    }
  }

  /**
   * Map Nomad job status to SandboxStatus.
   *
   * Nomad job statuses: 'pending' | 'running' | 'dead'
   * SandboxStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
   */
  private mapJobStatusToSandboxStatus(status?: string): SandboxStatus {
    switch (status) {
      case 'running':
        return 'running';
      case 'pending':
        return 'creating';
      case 'dead':
        return 'stopped';
      default:
        log.warn(`Unknown Nomad job status: "${status}", treating as error`);
        return 'error';
    }
  }

  /**
   * Map Nomad allocation client status to SandboxStatus for dead jobs.
   *
   * Nomad alloc statuses: 'pending' | 'running' | 'complete' | 'failed' | 'lost'
   */
  private mapAllocStatusToSandboxStatus(clientStatus?: string): SandboxStatus {
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
