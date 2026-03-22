// @ts-nocheck — test assertions use array indexing that TS flags as possibly undefined
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { MemoryErrors } from '../../../lib/errors/memory-errors.js';
import { err, ok } from '../../../lib/utils/result.js';
import { MemoryCaptureService } from '../memory-capture.service.js';
import type { HonchoSessionRef } from '../types.js';

// ---------------------------------------------------------------------------
// Mock MemoryClientService
// ---------------------------------------------------------------------------

function createClientMock() {
  return {
    getCodespaceClient: vi.fn().mockReturnValue({ workspaceId: 'codespace-cs1' }),
    ensurePeer: vi.fn().mockResolvedValue(ok({ id: 'peer-1' })),
    createSession: vi.fn().mockResolvedValue(
      ok({
        workspaceId: 'codespace-cs1',
        sessionId: 'sess-1',
        agentPeerId: 'agent-a1',
        userPeerId: 'user-default',
      } satisfies HonchoSessionRef)
    ),
    addMessage: vi.fn().mockResolvedValue(ok(undefined)),
    finalizeSession: vi.fn().mockResolvedValue(ok(undefined)),
  };
}

// ---------------------------------------------------------------------------
// Mock SettingsService
// ---------------------------------------------------------------------------

function createSettingsMock(minTurnLength = 50) {
  return {
    get: vi.fn(),
    getValue: vi.fn().mockResolvedValue(minTurnLength),
    set: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const sessionParams = {
  codespaceId: 'cs1',
  agentId: 'a1',
  taskId: 't1',
  sessionId: 'sess-1',
  phase: 'execution' as const,
  model: 'claude-sonnet-4-6',
};

const honchoRef: HonchoSessionRef = {
  workspaceId: 'codespace-cs1',
  sessionId: 'sess-1',
  agentPeerId: 'agent-a1',
  userPeerId: 'user-default',
};

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('MemoryCaptureService', () => {
  let clientMock: ReturnType<typeof createClientMock>;
  let settingsMock: ReturnType<typeof createSettingsMock>;
  let service: MemoryCaptureService;

  beforeEach(() => {
    vi.clearAllMocks();
    clientMock = createClientMock();
    settingsMock = createSettingsMock();
    service = new MemoryCaptureService(clientMock as never, settingsMock as never);
  });

  // =========================================================================
  // startSession
  // =========================================================================

  describe('startSession()', () => {
    it('creates session with correct metadata', async () => {
      const agentPeer = { id: 'agent-a1' };
      const userPeer = { id: 'user-default' };
      clientMock.ensurePeer
        .mockResolvedValueOnce(ok(agentPeer))
        .mockResolvedValueOnce(ok(userPeer));

      const result = await service.startSession(sessionParams);

      expect(result.ok).toBe(true);

      // Verify getCodespaceClient was called with codespaceId
      expect(clientMock.getCodespaceClient).toHaveBeenCalledWith('cs1');

      // Verify both peers were ensured
      expect(clientMock.ensurePeer).toHaveBeenCalledTimes(2);
      expect(clientMock.ensurePeer).toHaveBeenCalledWith(expect.anything(), 'agent-a1');
      expect(clientMock.ensurePeer).toHaveBeenCalledWith(expect.anything(), 'user-default');

      // Verify createSession was called with correct metadata
      expect(clientMock.createSession).toHaveBeenCalledWith(
        expect.anything(), // csClient
        'sess-1', // sessionId
        agentPeer, // agentPeer
        userPeer, // userPeer
        expect.objectContaining({
          agentpane_session_id: 'sess-1',
          task_id: 't1',
          agent_id: 'a1',
          codespace_id: 'cs1',
          phase: 'execution',
          model: 'claude-sonnet-4-6',
          started_at: expect.any(String),
        })
      );
    });

    it('ensures both agent peer and user peer', async () => {
      clientMock.ensurePeer
        .mockResolvedValueOnce(ok({ id: 'agent-a1' }))
        .mockResolvedValueOnce(ok({ id: 'user-default' }));

      await service.startSession(sessionParams);

      const calls = clientMock.ensurePeer.mock.calls;
      expect(calls[0][1]).toBe('agent-a1');
      expect(calls[1][1]).toBe('user-default');
    });

    it('returns err when agent peer creation fails', async () => {
      clientMock.ensurePeer.mockResolvedValueOnce(err(MemoryErrors.WORKSPACE_ERROR('peer failed')));

      const result = await service.startSession(sessionParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      // createSession should not be called
      expect(clientMock.createSession).not.toHaveBeenCalled();
    });

    it('returns err when user peer creation fails', async () => {
      clientMock.ensurePeer
        .mockResolvedValueOnce(ok({ id: 'agent-a1' }))
        .mockResolvedValueOnce(err(MemoryErrors.WORKSPACE_ERROR('user peer failed')));

      const result = await service.startSession(sessionParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_WORKSPACE_ERROR');
      }
      expect(clientMock.createSession).not.toHaveBeenCalled();
    });

    it('returns err when session creation fails', async () => {
      clientMock.ensurePeer
        .mockResolvedValueOnce(ok({ id: 'agent-a1' }))
        .mockResolvedValueOnce(ok({ id: 'user-default' }));
      clientMock.createSession.mockResolvedValueOnce(
        err(MemoryErrors.SESSION_ERROR('session creation failed'))
      );

      const result = await service.startSession(sessionParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
      }
    });

    it('catches unexpected errors and returns SESSION_ERROR', async () => {
      clientMock.getCodespaceClient.mockImplementation(() => {
        throw new Error('unexpected');
      });

      const result = await service.startSession(sessionParams);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
        expect(result.error.message).toContain('unexpected');
      }
    });
  });

  // =========================================================================
  // captureMessage
  // =========================================================================

  describe('captureMessage()', () => {
    it('skips messages shorter than min turn length (50 chars)', async () => {
      const shortContent = 'x'.repeat(49);

      const result = await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: shortContent,
      });

      expect(result.ok).toBe(true);
      expect(clientMock.addMessage).not.toHaveBeenCalled();
    });

    it('captures messages at exactly 50 chars', async () => {
      const exactContent = 'x'.repeat(50);

      const result = await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: exactContent,
      });

      expect(result.ok).toBe(true);
      expect(clientMock.addMessage).toHaveBeenCalled();
    });

    it('respects custom min turn length from settings', async () => {
      settingsMock.getValue.mockResolvedValue(100);
      const content = 'x'.repeat(99);

      const result = await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'user',
        content,
      });

      expect(result.ok).toBe(true);
      expect(clientMock.addMessage).not.toHaveBeenCalled();

      // Verify settings was queried with correct key and default
      expect(settingsMock.getValue).toHaveBeenCalledWith('memory.captureMinTurnLength', 50);
    });

    it('truncates messages over 4000 chars with truncation marker', async () => {
      const longContent = 'a'.repeat(5000);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: longContent,
      });

      const capturedContent = clientMock.addMessage.mock.calls[0][3] as string;
      expect(capturedContent).toContain('[truncated: 5000 chars]');
      expect(capturedContent.length).toBeLessThan(longContent.length);
    });

    it('preserves first 4000 chars in truncated content', async () => {
      // Create content with a known prefix
      const prefix = 'PREFIX_';
      const longContent = prefix + 'x'.repeat(5000);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: longContent,
      });

      const capturedContent = clientMock.addMessage.mock.calls[0][3] as string;
      // First 4000 chars should be preserved
      expect(capturedContent.startsWith(prefix)).toBe(true);
      const beforeTruncation = capturedContent.split('\n\n[truncated:')[0];
      expect(beforeTruncation.length).toBe(4000);
    });

    it('does not truncate messages at exactly 4000 chars', async () => {
      const exactContent = 'b'.repeat(4000);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content: exactContent,
      });

      const capturedContent = clientMock.addMessage.mock.calls[0][3] as string;
      expect(capturedContent).toBe(exactContent);
      expect(capturedContent).not.toContain('[truncated');
    });

    it('routes assistant role to agentPeerId', async () => {
      const content = 'x'.repeat(100);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content,
      });

      // 3rd argument is the peerId
      expect(clientMock.addMessage.mock.calls[0][2]).toBe('agent-a1');
    });

    it('routes user role to userPeerId', async () => {
      const content = 'x'.repeat(100);

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'user',
        content,
      });

      expect(clientMock.addMessage.mock.calls[0][2]).toBe('user-default');
    });

    it('passes metadata through to addMessage', async () => {
      const content = 'x'.repeat(100);
      const metadata = { tool: 'Bash', exit_code: 0 };

      await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content,
        metadata,
      });

      // 5th argument is metadata
      expect(clientMock.addMessage.mock.calls[0][4]).toEqual(metadata);
    });

    it('returns err on client.addMessage failure', async () => {
      const content = 'x'.repeat(100);
      clientMock.addMessage.mockResolvedValueOnce(err(MemoryErrors.CAPTURE_ERROR('write failed')));

      const result = await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
      }
    });

    it('catches unexpected errors and returns CAPTURE_ERROR', async () => {
      const content = 'x'.repeat(100);
      clientMock.getCodespaceClient.mockImplementation(() => {
        throw new Error('client exploded');
      });

      const result = await service.captureMessage({
        honchoSessionRef: honchoRef,
        role: 'assistant',
        content,
      });

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_CAPTURE_ERROR');
        expect(result.error.message).toContain('client exploded');
      }
    });

    it('extracts codespaceId from workspaceId format', async () => {
      const content = 'x'.repeat(100);

      await service.captureMessage({
        honchoSessionRef: {
          ...honchoRef,
          workspaceId: 'codespace-my-project-123',
        },
        role: 'assistant',
        content,
      });

      expect(clientMock.getCodespaceClient).toHaveBeenCalledWith('my-project-123');
    });
  });

  // =========================================================================
  // finalizeSession
  // =========================================================================

  describe('finalizeSession()', () => {
    it('delegates to client.finalizeSession', async () => {
      const result = await service.finalizeSession(honchoRef);

      expect(result.ok).toBe(true);
      expect(clientMock.getCodespaceClient).toHaveBeenCalledWith('cs1');
      expect(clientMock.finalizeSession).toHaveBeenCalledWith(
        expect.anything(), // csClient
        honchoRef
      );
    });

    it('returns err on failure', async () => {
      clientMock.finalizeSession.mockResolvedValueOnce(
        err(MemoryErrors.SESSION_ERROR('finalize failed'))
      );

      const result = await service.finalizeSession(honchoRef);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
      }
    });

    it('catches unexpected errors and returns SESSION_ERROR', async () => {
      clientMock.getCodespaceClient.mockImplementation(() => {
        throw new Error('network down');
      });

      const result = await service.finalizeSession(honchoRef);

      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error.code).toBe('MEMORY_SESSION_ERROR');
        expect(result.error.message).toContain('network down');
      }
    });

    it('extracts codespaceId from workspaceId prefix', async () => {
      const ref: HonchoSessionRef = {
        ...honchoRef,
        workspaceId: 'codespace-xyz-456',
      };

      await service.finalizeSession(ref);

      expect(clientMock.getCodespaceClient).toHaveBeenCalledWith('xyz-456');
    });
  });
});
