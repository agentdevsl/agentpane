import type { AppError } from '../../errors/base.js';
import type { ExecResult, TmuxSession } from '../types.js';

/**
 * Minimal interface required by the tmux operations mixin.
 * Every sandbox implementation (Docker, K8s CRD, Nomad) satisfies this.
 */
export interface TmuxHost {
  /** Unique sandbox ID — used as `sandboxId` in returned TmuxSession objects. */
  readonly id: string;
  /** Execute a command inside the sandbox. */
  exec(cmd: string, args?: string[]): Promise<ExecResult>;
  /** Update last-activity timestamp. */
  touch(): void;
}

/**
 * Provider-specific error factories injected into the mixin so each provider
 * keeps its own error codes (SandboxErrors / K8sErrors / NomadErrors).
 */
export interface TmuxErrors {
  sessionAlreadyExists(sessionName: string): AppError;
  creationFailed(sessionName: string, stderr: string): AppError;
  execFailed(description: string, stderr: string): AppError;
}

/**
 * Creates the five tmux operations that every Sandbox implementation needs.
 *
 * Previously duplicated across DockerSandbox, AgentSandboxInstance, and
 * NomadSandboxInstance (~100 lines each). This factory extracts the common
 * logic and delegates to `host.exec()` for the actual command execution.
 *
 * SC-037: shared tmux mixin.
 */
export function createTmuxOperations(host: TmuxHost, errors: TmuxErrors) {
  return {
    async createTmuxSession(sessionName: string, taskId?: string): Promise<TmuxSession> {
      host.touch();

      // Check if session already exists (handle "no tmux server" gracefully)
      let sessionExists = false;
      try {
        const listResult = await host.exec('tmux', ['list-sessions', '-F', '#{session_name}']);
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
        throw errors.sessionAlreadyExists(sessionName);
      }

      // Create new tmux session
      const result = await host.exec('tmux', ['new-session', '-d', '-s', sessionName]);
      if (result.exitCode !== 0) {
        throw errors.creationFailed(sessionName, result.stderr);
      }

      return {
        name: sessionName,
        sandboxId: host.id,
        taskId,
        createdAt: new Date().toISOString(),
        windowCount: 1,
        attached: false,
      };
    },

    async listTmuxSessions(): Promise<TmuxSession[]> {
      host.touch();

      let result: ExecResult;
      try {
        result = await host.exec('tmux', [
          'list-sessions',
          '-F',
          '#{session_name}:#{session_windows}:#{session_attached}',
        ]);
      } catch (err) {
        // Some providers throw on non-zero exit — handle "no tmux server" gracefully
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
        throw errors.execFailed('tmux list-sessions', result.stderr);
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
            sandboxId: host.id,
            createdAt: new Date().toISOString(),
            windowCount: parseInt(windows, 10) || 1,
            attached: attached === '1',
          };
        })
        .filter((session) => session.name !== '');
    },

    async killTmuxSession(sessionName: string): Promise<void> {
      host.touch();

      const result = await host.exec('tmux', ['kill-session', '-t', sessionName]);
      if (result.exitCode !== 0) {
        // Treat "session not found" / "can't find session" as success
        if (
          result.stderr.includes('session not found') ||
          result.stderr.includes("can't find session")
        ) {
          return;
        }
        throw errors.execFailed(`tmux kill-session -t ${sessionName}`, result.stderr);
      }
    },

    async sendKeysToTmux(sessionName: string, keys: string): Promise<void> {
      host.touch();

      const result = await host.exec('tmux', ['send-keys', '-t', sessionName, keys, 'Enter']);
      if (result.exitCode !== 0) {
        throw errors.execFailed(`tmux send-keys -t ${sessionName}`, result.stderr);
      }
    },

    async captureTmuxPane(sessionName: string, lines = 100): Promise<string> {
      host.touch();

      const result = await host.exec('tmux', [
        'capture-pane',
        '-t',
        sessionName,
        '-p',
        '-S',
        `-${lines}`,
      ]);

      if (result.exitCode !== 0) {
        throw errors.execFailed(`tmux capture-pane -t ${sessionName}`, result.stderr);
      }

      return result.stdout;
    },
  };
}
