import { PassThrough, type Readable } from 'node:stream';
import { type AgentSandboxClient, NotFoundError } from '@agentpane/agent-sandbox-sdk';
import { K8sErrors } from '../../errors/k8s-errors.js';
import { createLogger } from '../../logging/logger.js';
import { errorMessage } from '../../utils/error-message';
import type { ExecResult, SandboxMetrics, SandboxStatus, TmuxSession } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import type { ExecStreamOptions, ExecStreamResult, Sandbox } from './sandbox-provider.js';

const log = createLogger('AgentSandboxInstance');

/**
 * Sandbox instance backed by an Agent Sandbox CRD resource.
 *
 * Implements the Sandbox interface (sandbox-provider.ts:45-118) by delegating
 * to the SDK client's exec and lifecycle methods. The CRD controller manages
 * the underlying pod; this class provides the application-layer abstraction.
 */
export class AgentSandboxInstance implements Sandbox {
  private _lastActivity: Date;
  private _status: SandboxStatus = 'creating';

  constructor(
    /** Unique sandbox ID (cuid2) */
    public readonly id: string,
    /** CRD sandbox resource name (also serves as containerId) */
    private readonly sandboxName: string,
    /** Codespace this sandbox belongs to */
    public readonly codespaceId: string,
    /** Kubernetes namespace */
    _namespace: string,
    /** Agent Sandbox SDK client */
    private readonly client: AgentSandboxClient
  ) {
    this._lastActivity = new Date();
  }

  /**
   * Maps to the CRD sandbox name for interface compatibility.
   * The Sandbox interface requires a containerId; for CRD sandboxes
   * the resource name serves this purpose.
   */
  get containerId(): string {
    return this.sandboxName;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    this.touch();

    try {
      const result = await this.client.exec({
        sandboxName: this.sandboxName,
        command: [cmd, ...args],
        container: 'sandbox',
      });

      return {
        exitCode: result.exitCode,
        stdout: result.stdout.trim(),
        stderr: result.stderr.trim(),
      };
    } catch (error) {
      const message = errorMessage(error);
      throw K8sErrors.EXEC_FAILED(cmd, message);
    }
  }

  async execAsRoot(cmd: string, args: string[] = []): Promise<ExecResult> {
    // CRD sandboxes run as non-root (UID 1000) by default.
    // Root execution is not supported -- same behavior as K8sSandbox.execAsRoot
    // at k8s-sandbox.ts:73-87.
    log.warn('execAsRoot called but CRD sandboxes run as non-root. Executing as default user.');
    return this.exec(cmd, args);
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    try {
      // Delete the Sandbox CRD resource. The controller handles pod cleanup,
      // network policy removal, and any associated PVC cleanup.
      await this.client.deleteSandbox(this.sandboxName);
      this._status = 'stopped';
    } catch (error) {
      const message = errorMessage(error);
      this._status = 'error';
      throw K8sErrors.POD_DELETION_FAILED(this.sandboxName, message);
    }
  }

  /**
   * Escape a string for safe use in shell commands.
   * Uses single quotes and handles embedded single quotes.
   * Matches the DockerSandbox.shellEscape pattern (docker-provider.ts:261-264).
   */
  private shellEscape(str: string): string {
    return `'${str.replace(/'/g, "'\\''")}'`;
  }

  /**
   * Execute a command with streaming output.
   *
   * Builds the same kind of `sh -c "cd <cwd> && exec <cmd> <args>"` shell
   * command that DockerSandbox uses (docker-provider.ts:279-288), then delegates
   * to the SDK's execStream which manages the K8s Exec WebSocket.
   *
   * Returns PassThrough streams for stdout/stderr, matching the ExecStreamResult
   * contract that ContainerAgentService.startAgent() relies on at
   * container-agent.service.ts:901.
   */
  async execStream(options: ExecStreamOptions): Promise<ExecStreamResult> {
    this.touch();

    const { cmd, args = [], env = {}, cwd } = options;

    // Build the command with cwd handling.
    // When cwd is specified, use sh -c to handle the cd + exec pattern.
    // This matches DockerSandbox.execStream (docker-provider.ts:279-288).
    let fullCmd: string[];
    if (cwd) {
      const escapedCwd = this.shellEscape(cwd);
      const escapedCmd = this.shellEscape(cmd);
      const escapedArgs = args.map((arg) => this.shellEscape(arg)).join(' ');
      fullCmd = ['sh', '-c', `cd ${escapedCwd} && exec ${escapedCmd} ${escapedArgs}`];
    } else {
      // Without cwd, pass command directly without shell (safer)
      fullCmd = [cmd, ...args];
    }

    // Build environment variables for the exec.
    // K8s exec doesn't support setting env vars directly on the exec call,
    // so we prefix the command with env assignments in the shell.
    const envEntries = Object.entries(env);
    if (envEntries.length > 0) {
      // Validate env keys to prevent command injection (keys are not shell-escaped)
      const ENV_KEY_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/;
      for (const [key] of envEntries) {
        if (!ENV_KEY_PATTERN.test(key)) {
          throw K8sErrors.EXEC_FAILED(cmd, `Invalid environment variable key: ${key}`);
        }
      }

      const envPrefix = envEntries.map(([k, v]) => `${k}=${this.shellEscape(v)}`).join(' ');

      if (fullCmd[0] === 'sh' && fullCmd[1] === '-c') {
        // Already wrapped in shell -- inject env before `exec` so they scope to the
        // exec'd command. Placing them before `cd` only scopes them to `cd` itself.
        // Pattern: sh -c 'cd /cwd && VAR=val exec cmd args'
        const shBody = fullCmd[2] ?? '';
        const execIdx = shBody.indexOf('exec ');
        if (execIdx !== -1) {
          fullCmd = [
            'sh',
            '-c',
            `${shBody.slice(0, execIdx)}${envPrefix} ${shBody.slice(execIdx)}`,
          ];
        } else {
          // No exec keyword — fall back to export approach
          fullCmd = [
            'sh',
            '-c',
            `export ${envEntries.map(([k, v]) => `${k}=${this.shellEscape(v)}`).join(' ')}; ${shBody}`,
          ];
        }
      } else {
        // Values are passed as separate argv entries to env, so shell escaping is not needed
        // here (unlike the sh -c path above where values are embedded in a shell string).
        fullCmd = ['env', ...envEntries.map(([k, v]) => `${k}=${v}`), ...fullCmd];
      }
    }

    // Delegate to the SDK's execStream which manages the K8s Exec WebSocket.
    const sdkStream = await this.client.execStream({
      sandboxName: this.sandboxName,
      command: fullCmd,
      container: 'sandbox',
    });

    // Pipe SDK output through PassThrough streams for the ContainerBridge contract.
    const stdoutStream = new PassThrough();
    const stderrStream = new PassThrough();

    sdkStream.stdout.pipe(stdoutStream);
    sdkStream.stderr.pipe(stderrStream);

    return {
      stdout: stdoutStream as Readable,
      stderr: stderrStream as Readable,

      async wait(): Promise<{ exitCode: number }> {
        return sdkStream.wait();
      },

      async kill(): Promise<void> {
        sdkStream.stdout.unpipe(stdoutStream);
        sdkStream.stderr.unpipe(stderrStream);
        stdoutStream.end();
        stderrStream.end();
        await sdkStream.kill();
      },
    };
  }

  // --- tmux methods (reused from k8s-sandbox.ts:164-346) ---

  async createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession> {
    this.touch();

    // Check if session already exists
    const listResult = await this.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
    if (listResult.stdout.split('\n').includes(sessionName)) {
      throw K8sErrors.TMUX_SESSION_ALREADY_EXISTS(sessionName);
    }

    // Create new tmux session
    const result = await this.exec('tmux', ['new-session', '-d', '-s', sessionName]);
    if (result.exitCode !== 0) {
      throw K8sErrors.TMUX_CREATION_FAILED(sessionName, result.stderr);
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
      throw K8sErrors.EXEC_FAILED('tmux list-sessions', result.stderr);
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
      // Match the K8sSandbox behavior: treat "session not found" as success
      if (
        result.stderr.includes('session not found') ||
        result.stderr.includes("can't find session")
      ) {
        return;
      }
      throw K8sErrors.EXEC_FAILED(`tmux kill-session -t ${sessionName}`, result.stderr);
    }
  }

  async sendKeysToTmux(sessionName: string, keys: string): Promise<void> {
    this.touch();

    const result = await this.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
    if (result.exitCode !== 0) {
      throw K8sErrors.EXEC_FAILED(`tmux send-keys -t ${sessionName}`, result.stderr);
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
      throw K8sErrors.EXEC_FAILED(`tmux capture-pane -t ${sessionName}`, result.stderr);
    }

    return result.stdout;
  }

  // --- Metrics ---

  async getMetrics(): Promise<SandboxMetrics> {
    this.touch();

    try {
      const sandbox = await this.client.getSandbox(this.sandboxName);

      // Calculate uptime from sandbox creation timestamp
      const createdAt = sandbox?.metadata?.creationTimestamp;
      const uptime = createdAt ? Date.now() - new Date(createdAt).getTime() : 0;

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
      // Same fallback pattern as K8sSandbox.getMetrics (k8s-sandbox.ts:318-336)
      log.warn(`Failed to get metrics for ${this.sandboxName}, returning placeholder values`, {
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
   * Refresh status from the actual Sandbox CRD conditions.
   * Called by the provider after constructing an instance from a cluster query.
   */
  async refreshStatus(): Promise<void> {
    try {
      const sandbox = await this.client.getSandbox(this.sandboxName);
      this._status = this.mapConditionsToStatus(sandbox);
    } catch (error) {
      if (error instanceof NotFoundError) {
        this._status = 'stopped';
      } else {
        this._status = 'error';
      }
    }
  }

  /**
   * Map CRD conditions to SandboxStatus.
   *
   * v0.2.1 CRD uses status.conditions[] instead of status.phase.
   * Also checks spec.replicas === 0 for paused (idle) sandboxes.
   * Matches AgentSandboxProvider.mapConditionsToStatus() for consistency.
   */
  private mapConditionsToStatus(sandbox: {
    spec?: { replicas?: number };
    status?: { conditions?: Array<{ type?: string; status?: string; reason?: string }> };
  }): SandboxStatus {
    if (sandbox.spec?.replicas === 0) return 'idle';
    const conditions = sandbox.status?.conditions;
    const ready = conditions?.find((c) => c.type === 'Ready');
    if (!ready) return 'creating';
    if (ready.status === 'True') return 'running';
    if (ready.reason === 'SandboxExpired') return 'stopped';
    return 'error';
  }
}
