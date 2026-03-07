import {
  type BedrockAgentCoreClient,
  InvokeAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore';
import {
  type BedrockAgentCoreControlClient,
  GetAgentRuntimeCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import { AgentCoreErrors } from '../../errors/agentcore-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { ExecResult, SandboxMetrics, SandboxStatus, TmuxSession } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import type { ExecStreamOptions, ExecStreamResult, Sandbox } from './sandbox-provider.js';

const log = createLogger('AgentCoreSandboxInstance');

/**
 * Map AgentCore runtime status to SandboxStatus.
 *
 * AgentCore statuses: 'CREATING' | 'CREATE_FAILED' | 'UPDATING' | 'UPDATE_FAILED' | 'READY' | 'DELETING' | 'DELETED'
 * SandboxStatus: 'stopped' | 'creating' | 'running' | 'idle' | 'stopping' | 'error'
 */
export function mapAgentCoreStatus(status?: string): SandboxStatus {
  switch (status) {
    case 'CREATING':
    case 'UPDATING':
      return 'creating';
    case 'READY':
      return 'running';
    case 'DELETING':
      return 'stopping';
    case 'DELETED':
      return 'stopped';
    case 'CREATE_FAILED':
    case 'UPDATE_FAILED':
      return 'error';
    default:
      if (!status) return 'stopped';
      log.warn(`Unknown AgentCore runtime status: "${status}", treating as error`);
      return 'error';
  }
}

/**
 * Sandbox instance backed by an AWS Bedrock AgentCore Runtime.
 *
 * Implements the Sandbox interface defined in sandbox-provider.ts by delegating
 * to the AgentCore SDK clients. The control plane client handles lifecycle
 * queries; the data plane client handles invocations (exec).
 */
export class AgentCoreSandboxInstance implements Sandbox {
  private _lastActivity: Date;
  private _status: SandboxStatus = 'creating';
  private readonly _createdAt = new Date();
  private _lastRefreshError: Error | null = null;

  constructor(
    /** Unique sandbox ID (cuid2) */
    public readonly id: string,
    /** AgentCore Runtime ARN (used as containerId and for data plane invocations) */
    private readonly runtimeArn: string,
    /** AgentCore Runtime ID (used for control plane operations) */
    private readonly runtimeId: string,
    /** Project this sandbox belongs to */
    public readonly projectId: string,
    /** AgentCore control plane client */
    private readonly controlClient: BedrockAgentCoreControlClient,
    /** AgentCore data plane client */
    private readonly dataClient: BedrockAgentCoreClient
  ) {
    if (!id) throw new Error('AgentCoreSandboxInstance requires a non-empty id');
    if (!runtimeArn) throw new Error('AgentCoreSandboxInstance requires a non-empty runtimeArn');
    if (!runtimeId) throw new Error('AgentCoreSandboxInstance requires a non-empty runtimeId');
    this._lastActivity = new Date();
  }

  /**
   * Maps to the AgentCore Runtime ARN for interface compatibility.
   * The Sandbox interface requires a containerId; for AgentCore sandboxes
   * the runtime ARN serves this purpose.
   */
  get containerId(): string {
    return this.runtimeArn;
  }

  get status(): SandboxStatus {
    return this._status;
  }

  private assertRunning(): void {
    if (this._status !== 'running') {
      throw AgentCoreErrors.RUNTIME_NOT_ACTIVE(this.runtimeArn, this._status);
    }
  }

  async exec(cmd: string, args: string[] = []): Promise<ExecResult> {
    this.assertRunning();
    this.touch();

    try {
      const payload = JSON.stringify({
        action: 'exec',
        cmd,
        args,
      });

      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.runtimeArn,
        payload: new TextEncoder().encode(payload),
      });

      const invocation = await this.dataClient.send(command);

      // Parse the streaming response body
      let responseBody = '{}';
      if (invocation.response) {
        // response is a StreamingBlobPayloadOutputTypes — use transformToString/transformToByteArray
        const bytes = await invocation.response.transformToByteArray();
        responseBody = new TextDecoder().decode(bytes);
      }

      let result: { exitCode?: number; stdout?: string; stderr?: string };
      try {
        result = JSON.parse(responseBody);
      } catch (parseError) {
        const preview = responseBody.slice(0, 500);
        log.error(`Failed to parse exec response from ${this.runtimeArn}`, {
          error: parseError instanceof Error ? parseError : new Error(String(parseError)),
          data: { cmd, responsePreview: preview },
        });
        throw AgentCoreErrors.INVOCATION_FAILED(
          this.runtimeArn,
          `exec ${cmd}: response is not valid JSON (preview: ${preview})`
        );
      }

      if (result.exitCode === undefined) {
        log.warn(
          `exec response missing exitCode for cmd "${cmd}" on ${this.runtimeArn}, defaulting to 0`
        );
      }
      return {
        exitCode: result.exitCode ?? 0,
        stdout: (result.stdout ?? '').trim(),
        stderr: (result.stderr ?? '').trim(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);

      log.error(`Failed to exec command on ${this.runtimeArn}`, {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { cmd },
      });

      // Check for throttling
      if (error instanceof Error && error.name === 'ThrottlingException') {
        throw AgentCoreErrors.INVOCATION_THROTTLED(this.runtimeArn);
      }

      throw AgentCoreErrors.INVOCATION_FAILED(this.runtimeArn, `exec ${cmd}: ${message}`);
    }
  }

  async execAsRoot(_cmd: string, _args: string[] = []): Promise<ExecResult> {
    throw AgentCoreErrors.INVOCATION_FAILED(
      this.runtimeArn,
      'Root execution is not supported by the AgentCore sandbox provider'
    );
  }

  async stop(): Promise<void> {
    this._status = 'stopping';

    try {
      // Signal the current session to end (does NOT delete the runtime)
      const payload = JSON.stringify({ action: 'stop' });
      const command = new InvokeAgentRuntimeCommand({
        agentRuntimeArn: this.runtimeArn,
        payload: new TextEncoder().encode(payload),
      });

      await this.dataClient.send(command);
      this._status = 'stopped';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to stop sandbox ${this.runtimeArn}`, {
        error: error instanceof Error ? error : new Error(String(error)),
      });
      this._status = 'error';
      throw AgentCoreErrors.INVOCATION_FAILED(this.runtimeArn, `stop: ${message}`);
    }
  }

  /**
   * Execute a command with streaming output.
   * Not supported by AgentCore sandbox provider.
   */
  execStream?: (options: ExecStreamOptions) => Promise<ExecStreamResult>;

  // --- tmux session management ---

  async createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession> {
    this.assertRunning();
    this.touch();

    // Check if session already exists (handle "no tmux server" case gracefully)
    let sessionExists = false;
    try {
      const listResult = await this.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
      sessionExists = listResult.stdout.split('\n').includes(sessionName);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no server running') || message.includes('no sessions')) {
        sessionExists = false;
      } else {
        throw err;
      }
    }
    if (sessionExists) {
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `tmux session '${sessionName}' already exists`
      );
    }

    // Create new tmux session
    const result = await this.exec('tmux', ['new-session', '-d', '-s', sessionName]);
    if (result.exitCode !== 0) {
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `Failed to create tmux session '${sessionName}': ${result.stderr}`
      );
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

    let result: ExecResult;
    try {
      result = await this.exec('tmux', [
        'list-sessions',
        '-F',
        '#{session_name}:#{session_windows}:#{session_attached}',
      ]);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes('no server running') || message.includes('no sessions')) {
        return [];
      }
      throw err;
    }

    if (result.exitCode !== 0) {
      if (result.stderr.includes('no server running') || result.stderr.includes('no sessions')) {
        return [];
      }
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `tmux list-sessions: ${result.stderr}`
      );
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
    this.assertRunning();
    this.touch();

    const result = await this.exec('tmux', ['kill-session', '-t', sessionName]);
    if (result.exitCode !== 0) {
      if (
        result.stderr.includes('session not found') ||
        result.stderr.includes("can't find session")
      ) {
        return;
      }
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `tmux kill-session -t ${sessionName}: ${result.stderr}`
      );
    }
  }

  async sendKeysToTmux(sessionName: string, keys: string): Promise<void> {
    this.assertRunning();
    this.touch();

    const result = await this.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
    if (result.exitCode !== 0) {
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `tmux send-keys -t ${sessionName}: ${result.stderr}`
      );
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
      throw AgentCoreErrors.INVOCATION_FAILED(
        this.runtimeArn,
        `tmux capture-pane -t ${sessionName}: ${result.stderr}`
      );
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
      // Verify runtime still exists before reporting metrics.
      const command = new GetAgentRuntimeCommand({
        agentRuntimeId: this.runtimeId,
      });
      await this.controlClient.send(command);

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
      log.error(`Failed to get metrics for ${this.runtimeArn}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw AgentCoreErrors.INTERNAL_ERROR(
        `Failed to get metrics for ${this.runtimeArn}: ${message}`
      );
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
   * Refresh status from the actual AgentCore runtime status.
   * Called by the provider after constructing an instance from an API query.
   */
  async refreshStatus(): Promise<void> {
    try {
      const command = new GetAgentRuntimeCommand({
        agentRuntimeId: this.runtimeId,
      });
      const response = await this.controlClient.send(command);
      const runtimeStatus = response.status;

      this._status = mapAgentCoreStatus(runtimeStatus);
      this._lastRefreshError = null;
    } catch (error) {
      // Check for not found
      if (
        error instanceof Error &&
        (error.name === 'ResourceNotFoundException' || error.name === 'NotFoundException')
      ) {
        log.info(`Runtime ${this.runtimeArn} no longer exists in AWS, marking as stopped`);
        this._status = 'stopped';
        this._lastRefreshError = null;
      } else {
        const wrappedError = error instanceof Error ? error : new Error(String(error));
        log.error(`refreshStatus failed for runtime ${this.runtimeArn}`, {
          error: wrappedError,
        });
        this._lastRefreshError = wrappedError;
        this._status = 'error';
      }
    }
  }

  /** The last error encountered during refreshStatus, if any. */
  get lastRefreshError(): Error | null {
    return this._lastRefreshError;
  }
}
