import { createId } from '@paralleldrive/cuid2';
import type { SandboxError } from '../errors/sandbox-errors.js';
import { SandboxErrors } from '../errors/sandbox-errors.js';
import { errorMessage } from '../utils/error-message';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { Sandbox, SandboxProvider } from './providers/sandbox-provider.js';
import type { TmuxSession } from './types.js';

/**
 * Options for creating a tmux session
 */
export interface CreateTmuxSessionOptions {
  sandboxId?: string;
  codespaceId?: string;
  taskId?: string;
  sessionName?: string;
  initialCommand?: string;
  workingDirectory?: string;
}

/**
 * Options for executing in a tmux session
 */
export interface TmuxExecOptions {
  waitForCompletion?: boolean;
  timeout?: number;
}

/**
 * tmux session manager
 *
 * Manages tmux sessions inside sandboxes. Each task gets its own tmux session
 * for process isolation and terminal multiplexing, allowing multiple agent tasks
 * to run in parallel within a single sandbox container. Session names follow
 * the pattern "agent-{taskId}" for easy identification.
 */
export class TmuxManager {
  private sessions = new Map<string, { sandboxId: string; session: TmuxSession }>();

  constructor(private provider: SandboxProvider) {}

  /**
   * Create a new tmux session in a sandbox
   */
  async createSession(
    options: CreateTmuxSessionOptions
  ): Promise<Result<TmuxSession, SandboxError>> {
    // Get sandbox
    let sandbox: Sandbox | null = null;

    if (options.sandboxId) {
      sandbox = await this.provider.getById(options.sandboxId);
    } else if (options.codespaceId) {
      sandbox = await this.provider.get(options.codespaceId);
    }

    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    // Generate session name if not provided
    const sessionName = options.sessionName ?? `agent-${options.taskId ?? createId().slice(0, 8)}`;

    try {
      // Create the tmux session
      const session = await sandbox.createTmuxSession(sessionName, options.taskId);

      // Change to working directory if specified
      if (options.workingDirectory) {
        await sandbox.sendKeysToTmux(sessionName, `cd ${options.workingDirectory}`);
      }

      // Run initial command if specified
      if (options.initialCommand) {
        await sandbox.sendKeysToTmux(sessionName, options.initialCommand);
      }

      // Store session reference
      this.sessions.set(sessionName, { sandboxId: sandbox.id, session });

      return ok(session);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        return err(error as SandboxError);
      }
      const message = errorMessage(error);
      return err(SandboxErrors.TMUX_CREATION_FAILED(sessionName, message));
    }
  }

  /**
   * Get a tmux session by name
   */
  async getSession(sessionName: string): Promise<Result<TmuxSession | null, SandboxError>> {
    const stored = this.sessions.get(sessionName);
    if (!stored) {
      return ok(null);
    }

    const sandbox = await this.provider.getById(stored.sandboxId);
    if (!sandbox) {
      // Sandbox no longer exists, clean up
      this.sessions.delete(sessionName);
      return ok(null);
    }

    try {
      const sessions = await sandbox.listTmuxSessions();
      const session = sessions.find((s) => s.name === sessionName);
      return ok(session ?? null);
    } catch (error) {
      // Return the actual error for diagnosis instead of silently returning null
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED('tmux list-sessions', message));
    }
  }

  /**
   * List all tmux sessions in a sandbox
   */
  async listSessions(sandboxId: string): Promise<Result<TmuxSession[], SandboxError>> {
    const sandbox = await this.provider.getById(sandboxId);
    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    try {
      const sessions = await sandbox.listTmuxSessions();
      return ok(sessions);
    } catch (error) {
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED('tmux list-sessions', message));
    }
  }

  /**
   * Send a command to a tmux session
   */
  async sendCommand(sessionName: string, command: string): Promise<Result<void, SandboxError>> {
    const stored = this.sessions.get(sessionName);
    if (!stored) {
      return err(SandboxErrors.TMUX_SESSION_NOT_FOUND(sessionName));
    }

    const sandbox = await this.provider.getById(stored.sandboxId);
    if (!sandbox) {
      this.sessions.delete(sessionName);
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    try {
      await sandbox.sendKeysToTmux(sessionName, command);
      return ok(undefined);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        return err(error as SandboxError);
      }
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED(`tmux send-keys -t ${sessionName}`, message));
    }
  }

  /**
   * Capture output from a tmux session
   */
  async captureOutput(sessionName: string, lines = 100): Promise<Result<string, SandboxError>> {
    const stored = this.sessions.get(sessionName);
    if (!stored) {
      return err(SandboxErrors.TMUX_SESSION_NOT_FOUND(sessionName));
    }

    const sandbox = await this.provider.getById(stored.sandboxId);
    if (!sandbox) {
      this.sessions.delete(sessionName);
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    try {
      const output = await sandbox.captureTmuxPane(sessionName, lines);
      return ok(output);
    } catch (error) {
      if (error && typeof error === 'object' && 'code' in error) {
        return err(error as SandboxError);
      }
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED(`tmux capture-pane -t ${sessionName}`, message));
    }
  }

  /**
   * Kill a tmux session
   */
  async killSession(sessionName: string): Promise<Result<void, SandboxError>> {
    const stored = this.sessions.get(sessionName);
    if (!stored) {
      // Session not tracked, but try to kill anyway
      return ok(undefined);
    }

    const sandbox = await this.provider.getById(stored.sandboxId);
    if (!sandbox) {
      this.sessions.delete(sessionName);
      return ok(undefined);
    }

    try {
      await sandbox.killTmuxSession(sessionName);
      this.sessions.delete(sessionName);
      return ok(undefined);
    } catch (error) {
      // Only ignore "session not found" - that's an expected condition
      const message = errorMessage(error);
      if (message.includes('session not found') || message.includes("can't find session")) {
        this.sessions.delete(sessionName);
        return ok(undefined);
      }
      // Propagate other errors (container issues, permissions, etc.)
      return err(SandboxErrors.EXEC_FAILED(`tmux kill-session -t ${sessionName}`, message));
    }
  }

  /**
   * Kill all tmux sessions in a sandbox
   *
   * Returns the count of successfully killed sessions. Individual session
   * kill errors are logged but don't fail the entire operation.
   */
  async killAllSessions(sandboxId: string): Promise<Result<number, SandboxError>> {
    const sandbox = await this.provider.getById(sandboxId);
    if (!sandbox) {
      return err(SandboxErrors.CONTAINER_NOT_FOUND);
    }

    try {
      const sessions = await sandbox.listTmuxSessions();
      let killed = 0;

      for (const session of sessions) {
        try {
          await sandbox.killTmuxSession(session.name);
          this.sessions.delete(session.name);
          killed++;
        } catch (_error) {
          // Log individual session kill errors but continue with others
        }
      }

      return ok(killed);
    } catch (error) {
      // Failed to list sessions - return the error instead of silently returning 0
      const message = errorMessage(error);
      return err(SandboxErrors.EXEC_FAILED('tmux list-sessions', message));
    }
  }

  /**
   * Create session name for a task
   */
  static createSessionName(taskId: string): string {
    return `agent-${taskId}`;
  }
}

/**
 * Create a tmux manager
 */
export function createTmuxManager(provider: SandboxProvider): TmuxManager {
  return new TmuxManager(provider);
}
