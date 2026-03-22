/**
 * MemoryCaptureService — Implements message capture for Honcho memory.
 *
 * Manages session lifecycle and message recording:
 *   startSession  → creates Honcho session with agent/user peers
 *   captureMessage → records individual turns (with length filtering + truncation)
 *   finalizeSession → triggers Honcho deriver for conclusion extraction
 *
 * All methods return Result<T, MemoryError>. The facade (MemoryService)
 * wraps these in fire-and-forget semantics so capture never blocks agents.
 */

import type { MemoryError } from '../../lib/errors/memory-errors.js';
import { MemoryErrors } from '../../lib/errors/memory-errors.js';
import { createLogger } from '../../lib/logging/logger.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { SettingsService } from '../settings.service.js';
import type { MemoryCaptureServiceInterface } from './memory.service.js';
import type { MemoryClientService } from './memory-client.service.js';
import type { HonchoSessionRef } from './types.js';

const log = createLogger('MemoryCapture');

/** Default minimum content length for capture (characters). */
const DEFAULT_MIN_TURN_LENGTH = 50;

/** Maximum content length before truncation (characters). */
const MAX_CONTENT_LENGTH = 4000;

export class MemoryCaptureService implements MemoryCaptureServiceInterface {
  constructor(
    private client: MemoryClientService,
    private settingsService: SettingsService
  ) {}

  /**
   * Create a Honcho session for tracking an agent run.
   * Sets up agent and user peers with session metadata.
   */
  async startSession(params: {
    codespaceId: string;
    agentId: string;
    taskId: string;
    sessionId: string;
    phase: 'planning' | 'execution';
    model: string;
  }): Promise<Result<HonchoSessionRef, MemoryError>> {
    try {
      const csClient = this.client.getCodespaceClient(params.codespaceId);

      const agentPeerResult = await this.client.ensurePeer(csClient, `agent-${params.agentId}`);
      if (!agentPeerResult.ok) return agentPeerResult;

      const userPeerResult = await this.client.ensurePeer(csClient, 'user-default');
      if (!userPeerResult.ok) return userPeerResult;

      const metadata = {
        agentpane_session_id: params.sessionId,
        task_id: params.taskId,
        agent_id: params.agentId,
        codespace_id: params.codespaceId,
        phase: params.phase,
        model: params.model,
        started_at: new Date().toISOString(),
      };

      const sessionResult = await this.client.createSession(
        csClient,
        params.sessionId,
        agentPeerResult.value,
        userPeerResult.value,
        metadata
      );

      if (!sessionResult.ok) return sessionResult;

      log.info('Memory session started', {
        data: {
          sessionId: params.sessionId,
          codespaceId: params.codespaceId,
          phase: params.phase,
        },
      });

      return sessionResult;
    } catch (error) {
      log.warn('Failed to start memory session', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { sessionId: params.sessionId },
      });
      return err(MemoryErrors.SESSION_ERROR(`Failed to start session: ${String(error)}`));
    }
  }

  /**
   * Capture a single message (turn) from an agent session.
   * Filters out short messages and truncates long ones.
   */
  async captureMessage(params: {
    honchoSessionRef: HonchoSessionRef;
    role: 'user' | 'assistant';
    content: string;
    metadata?: Record<string, unknown>;
  }): Promise<Result<void, MemoryError>> {
    try {
      // Read minimum turn length from settings
      const minLength = await this.settingsService.getValue<number>(
        'memory.captureMinTurnLength',
        DEFAULT_MIN_TURN_LENGTH
      );

      // Skip messages that are too short to be meaningful
      if (params.content.length < minLength) {
        return ok(undefined);
      }

      // Truncate overly long content to stay within Honcho limits
      let truncatedContent = params.content;
      if (truncatedContent.length > MAX_CONTENT_LENGTH) {
        const originalLength = truncatedContent.length;
        truncatedContent = `${truncatedContent.slice(0, MAX_CONTENT_LENGTH)}\n\n[truncated: ${originalLength} chars]`;
      }

      // Extract codespaceId from workspaceId (format: "codespace-{codespaceId}")
      const codespaceId = params.honchoSessionRef.workspaceId.replace('codespace-', '');
      const csClient = this.client.getCodespaceClient(codespaceId);

      // Determine which peer authored the message
      const peerId =
        params.role === 'assistant'
          ? params.honchoSessionRef.agentPeerId
          : params.honchoSessionRef.userPeerId;

      return await this.client.addMessage(
        csClient,
        params.honchoSessionRef,
        peerId,
        truncatedContent,
        params.metadata
      );
    } catch (error) {
      log.warn('Failed to capture message', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { role: params.role, sessionId: params.honchoSessionRef.sessionId },
      });
      return err(MemoryErrors.CAPTURE_ERROR(`Failed to capture message: ${String(error)}`));
    }
  }

  /**
   * Finalize a Honcho session, triggering the deriver for conclusion extraction.
   */
  async finalizeSession(ref: HonchoSessionRef): Promise<Result<void, MemoryError>> {
    try {
      const codespaceId = ref.workspaceId.replace('codespace-', '');
      const csClient = this.client.getCodespaceClient(codespaceId);

      const result = await this.client.finalizeSession(csClient, ref);

      if (result.ok) {
        log.info('Memory session finalized', {
          data: { sessionId: ref.sessionId },
        });
      }

      return result;
    } catch (error) {
      log.warn('Failed to finalize memory session', {
        error: error instanceof Error ? error : new Error(String(error)),
        data: { sessionId: ref.sessionId },
      });
      return err(MemoryErrors.SESSION_ERROR(`Failed to finalize session: ${String(error)}`));
    }
  }
}
