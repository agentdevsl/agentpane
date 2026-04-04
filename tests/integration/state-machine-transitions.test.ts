/**
 * Integration tests for state machine transitions.
 *
 * Covers:
 * - Session lifecycle machine (idle → active → closed)
 * - Worktree lifecycle machine (creating → active → merging → removed)
 * - Task workflow machine (backlog → in_progress → waiting_approval → verified)
 *
 * IT-IDs: IT-1800 through IT-1829
 */
import { describe, expect, it } from 'vitest';
import type { AppError } from '../../src/lib/errors/base';
import { createSessionLifecycleMachine } from '../../src/lib/state-machines/session-lifecycle/machine';
import { createTaskWorkflowMachine } from '../../src/lib/state-machines/task-workflow/machine';
import { createWorktreeLifecycleMachine } from '../../src/lib/state-machines/worktree-lifecycle/machine';

// ── Session Lifecycle Machine ────────────────────────────────────────────────

describe('Session Lifecycle Machine', () => {
  it('IT-1800: starts in idle state with default context', () => {
    const machine = createSessionLifecycleMachine();
    expect(machine.state).toBe('idle');
    expect(machine.context.status).toBe('idle');
    expect(machine.context.participants).toEqual([]);
    expect(machine.context.maxParticipants).toBe(4);
  });

  it('IT-1801: starts with custom initial context', () => {
    const machine = createSessionLifecycleMachine({
      maxParticipants: 8,
      participants: ['user-1'],
    });
    expect(machine.context.maxParticipants).toBe(8);
    expect(machine.context.participants).toEqual(['user-1']);
  });

  it('IT-1802: transitions idle → initializing → active', () => {
    const machine = createSessionLifecycleMachine();
    const r1 = machine.send({ type: 'INITIALIZE' });
    expect(r1.ok).toBe(true);
    expect(machine.state).toBe('initializing');

    const r2 = machine.send({ type: 'READY' });
    expect(r2.ok).toBe(true);
    expect(machine.state).toBe('active');
    expect(machine.context.status).toBe('active');
  });

  it('IT-1803: allows JOIN when session has capacity', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const result = machine.send({ type: 'JOIN', userId: 'user-1' });
    expect(result.ok).toBe(true);
    expect(machine.context.participants).toContain('user-1');
    expect(machine.state).toBe('active');
  });

  it('IT-1804: rejects JOIN when session is full', () => {
    const machine = createSessionLifecycleMachine({ maxParticipants: 1, participants: ['user-0'] });
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const result = machine.send({ type: 'JOIN', userId: 'user-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('SESSION_CAPACITY_REACHED');
    }
  });

  it('IT-1805: allows LEAVE for participants', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });
    machine.send({ type: 'JOIN', userId: 'user-1' });

    const result = machine.send({ type: 'LEAVE', userId: 'user-1' });
    expect(result.ok).toBe(true);
    expect(machine.context.participants).not.toContain('user-1');
  });

  it('IT-1806: rejects LEAVE for non-participants', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const result = machine.send({ type: 'LEAVE', userId: 'ghost' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('SESSION_NOT_PARTICIPANT');
    }
  });

  it('IT-1807: HEARTBEAT updates lastActivity timestamp', () => {
    const machine = createSessionLifecycleMachine({
      lastActivity: Date.now() - 5000,
    });
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const before = machine.context.lastActivity;
    const result = machine.send({ type: 'HEARTBEAT' });
    expect(result.ok).toBe(true);
    expect(machine.context.lastActivity).toBeGreaterThanOrEqual(before);
  });

  it('IT-1808: transitions active → paused → active (RESUME)', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const r1 = machine.send({ type: 'PAUSE' });
    expect(r1.ok).toBe(true);
    expect(machine.state).toBe('paused');

    const r2 = machine.send({ type: 'RESUME' });
    expect(r2.ok).toBe(true);
    expect(machine.state).toBe('active');
  });

  it('IT-1809: transitions active → closing → closed', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const r1 = machine.send({ type: 'CLOSE' });
    expect(r1.ok).toBe(true);
    expect(machine.state).toBe('closing');

    const r2 = machine.send({ type: 'CLOSE' });
    expect(r2.ok).toBe(true);
    expect(machine.state).toBe('closed');
  });

  it('IT-1810: transitions paused → closing via CLOSE', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });
    machine.send({ type: 'PAUSE' });

    const result = machine.send({ type: 'CLOSE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('closing');
  });

  it('IT-1811: ERROR transitions any non-closed state to error', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const error = {
      code: 'TEST_ERROR',
      message: 'Something went wrong',
      status: 500,
    } as AppError;

    const result = machine.send({ type: 'ERROR', error });
    expect(result.ok).toBe(false);
    expect(machine.state).toBe('error');
    expect(machine.context.error).toBeDefined();
  });

  it('IT-1812: error state can transition to closed via CLOSE', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });
    machine.send({
      type: 'ERROR',
      error: { code: 'E', message: 'err', status: 500 } as AppError,
    });

    const result = machine.send({ type: 'CLOSE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('closed');
  });

  it('IT-1813: rejects invalid transitions', () => {
    const machine = createSessionLifecycleMachine();
    // idle → READY is not valid (must INITIALIZE first)
    const result = machine.send({ type: 'READY' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('SESSION_INVALID_TRANSITION');
    }
  });

  it('IT-1814: TIMEOUT transitions active to closing when session is stale', () => {
    const now = Date.now();
    const machine = createSessionLifecycleMachine({
      // Set lastActivity to 2 minutes ago (> 60s staleness threshold)
      lastActivity: now - 120_000,
    });
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const result = machine.send({ type: 'TIMEOUT' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('closing');
  });

  it('IT-1815: TIMEOUT does NOT transition active session that is not stale', () => {
    const machine = createSessionLifecycleMachine();
    machine.send({ type: 'INITIALIZE' });
    machine.send({ type: 'READY' });

    const result = machine.send({ type: 'TIMEOUT' });
    expect(result.ok).toBe(false);
  });

  it('IT-1816: chained send via result object works', () => {
    const machine = createSessionLifecycleMachine();
    const result = machine.send({ type: 'INITIALIZE' });
    expect(result.ok).toBe(true);
    // Use the send from the result to chain transitions
    const r2 = result.send({ type: 'READY' });
    expect(r2.ok).toBe(true);
    expect(r2.state).toBe('active');
  });
});

// ── Worktree Lifecycle Machine ───────────────────────────────────────────────

describe('Worktree Lifecycle Machine', () => {
  it('IT-1817: starts in creating state with branch context', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/new' });
    expect(machine.state).toBe('creating');
    expect(machine.context.branch).toBe('feat/new');
    expect(machine.context.branchExists).toBe(false);
    expect(machine.context.pathAvailable).toBe(true);
    expect(machine.context.hasUncommittedChanges).toBe(false);
    expect(machine.context.conflictFiles).toEqual([]);
  });

  it('IT-1818: transitions creating → active via INIT_COMPLETE when canCreate', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/new' });
    const result = machine.send({ type: 'INIT_COMPLETE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('active');
  });

  it('IT-1819: rejects INIT_COMPLETE when branch already exists', () => {
    const machine = createWorktreeLifecycleMachine({
      branch: 'feat/new',
      branchExists: true,
    });
    const result = machine.send({ type: 'INIT_COMPLETE' });
    expect(result.ok).toBe(false);
  });

  it('IT-1820: rejects INIT_COMPLETE when path is not available', () => {
    const machine = createWorktreeLifecycleMachine({
      branch: 'feat/new',
      pathAvailable: false,
    });
    const result = machine.send({ type: 'INIT_COMPLETE' });
    expect(result.ok).toBe(false);
  });

  it('IT-1821: transitions active → dirty via MODIFY', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });

    const result = machine.send({ type: 'MODIFY' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('dirty');
    expect(machine.context.hasUncommittedChanges).toBe(true);
  });

  it('IT-1822: transitions dirty → committing via COMMIT', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });
    machine.send({ type: 'MODIFY' });

    const result = machine.send({ type: 'COMMIT' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('committing');
    expect(machine.context.hasUncommittedChanges).toBe(false);
  });

  it('IT-1823: transitions active → merging via MERGE (no uncommitted changes)', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });

    const result = machine.send({ type: 'MERGE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('merging');
  });

  it('IT-1824: rejects MERGE from active when there are uncommitted changes', () => {
    const machine = createWorktreeLifecycleMachine({
      branch: 'feat/x',
      hasUncommittedChanges: true,
    });
    machine.send({ type: 'INIT_COMPLETE' });
    // machine is active but hasUncommittedChanges is from context init -- need to set it via MODIFY
    // Actually, canMerge checks hasUncommittedChanges which was set to true initially
    // but INIT_COMPLETE doesn't reset it. Let's test differently.
    const machine2 = createWorktreeLifecycleMachine({ branch: 'feat/y' });
    machine2.send({ type: 'INIT_COMPLETE' });
    machine2.send({ type: 'MODIFY' }); // sets hasUncommittedChanges = true

    const result = machine2.send({ type: 'MERGE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('WORKTREE_DIRTY');
    }
  });

  it('IT-1825: transitions merging → conflict via MODIFY when has conflicts', () => {
    // Start in merging state directly with conflict files present
    const machine = createWorktreeLifecycleMachine({
      branch: 'feat/x',
      status: 'merging',
      conflictFiles: ['file.ts'],
    });
    expect(machine.state).toBe('merging');

    const result = machine.send({ type: 'MODIFY' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('conflict');
  });

  it('IT-1826: transitions conflict → active via RESOLVE_CONFLICT', () => {
    // Start in merging state with conflicts, then transition to conflict
    const machine = createWorktreeLifecycleMachine({
      branch: 'feat/x',
      status: 'merging',
      conflictFiles: ['file.ts'],
    });
    machine.send({ type: 'MODIFY' });
    expect(machine.state).toBe('conflict');

    const result = machine.send({ type: 'RESOLVE_CONFLICT' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('active');
    expect(machine.context.conflictFiles).toEqual([]);
  });

  it('IT-1827: transitions active → removing → removed', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });

    const r1 = machine.send({ type: 'REMOVE' });
    expect(r1.ok).toBe(true);
    expect(machine.state).toBe('removing');

    const r2 = machine.send({ type: 'REMOVE' });
    expect(r2.ok).toBe(true);
    expect(machine.state).toBe('removed');
  });

  it('IT-1828: ERROR transitions any state to error', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });

    const result = machine.send({ type: 'ERROR' });
    expect(result.ok).toBe(false);
    expect(machine.state).toBe('error');
  });

  it('IT-1829: committing → merging via MERGE', () => {
    const machine = createWorktreeLifecycleMachine({ branch: 'feat/x' });
    machine.send({ type: 'INIT_COMPLETE' });
    machine.send({ type: 'MODIFY' });
    machine.send({ type: 'COMMIT' });
    expect(machine.state).toBe('committing');

    const result = machine.send({ type: 'MERGE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('merging');
  });
});

// ── Task Workflow Machine ────────────────────────────────────────────────────

describe('Task Workflow Machine', () => {
  it('IT-1830: starts in backlog state with task context', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    expect(machine.state).toBe('backlog');
    expect(machine.context.taskId).toBe('task-1');
    expect(machine.context.column).toBe('backlog');
    expect(machine.context.runningAgents).toBe(0);
    expect(machine.context.maxConcurrentAgents).toBe(3);
    expect(machine.context.diffSummary).toBeNull();
  });

  it('IT-1831: transitions backlog → in_progress via ASSIGN', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    const result = machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('in_progress');
    expect(machine.context.agentId).toBe('agent-1');
  });

  it('IT-1832: rejects ASSIGN when already assigned', () => {
    const machine = createTaskWorkflowMachine({
      taskId: 'task-1',
      agentId: 'agent-already',
    });
    const result = machine.send({ type: 'ASSIGN', agentId: 'agent-2' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('TASK_ALREADY_ASSIGNED');
    }
  });

  it('IT-1833: rejects ASSIGN when concurrency limit exceeded', () => {
    const machine = createTaskWorkflowMachine({
      taskId: 'task-1',
      runningAgents: 3,
      maxConcurrentAgents: 3,
    });
    const result = machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('CONCURRENCY_LIMIT_EXCEEDED');
    }
  });

  it('IT-1834: transitions in_progress → waiting_approval via COMPLETE', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });

    const result = machine.send({ type: 'COMPLETE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('waiting_approval');
  });

  it('IT-1835: transitions in_progress → backlog via CANCEL', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });

    const result = machine.send({ type: 'CANCEL' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('backlog');
    expect(machine.context.agentId).toBeUndefined();
  });

  it('IT-1836: transitions waiting_approval → verified via APPROVE (with diff)', () => {
    const machine = createTaskWorkflowMachine({
      taskId: 'task-1',
      diffSummary: { filesChanged: 3 },
    });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    machine.send({ type: 'COMPLETE' });

    const result = machine.send({ type: 'APPROVE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('verified');
  });

  it('IT-1837: rejects APPROVE when there is no diff', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    machine.send({ type: 'COMPLETE' });

    const result = machine.send({ type: 'APPROVE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('TASK_NO_DIFF');
    }
  });

  it('IT-1838: transitions waiting_approval → in_progress via REJECT', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    machine.send({ type: 'COMPLETE' });

    const result = machine.send({ type: 'REJECT' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('in_progress');
  });

  it('IT-1839: verified is a terminal state — no further transitions', () => {
    const machine = createTaskWorkflowMachine({
      taskId: 'task-1',
      diffSummary: { filesChanged: 1 },
    });
    machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
    machine.send({ type: 'COMPLETE' });
    machine.send({ type: 'APPROVE' });
    expect(machine.state).toBe('verified');

    const result = machine.send({ type: 'CANCEL' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('TASK_INVALID_TRANSITION');
    }
  });

  it('IT-1840: rejects invalid backlog → COMPLETE transition', () => {
    const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
    const result = machine.send({ type: 'COMPLETE' });
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect((result.error as AppError).code).toBe('TASK_INVALID_TRANSITION');
    }
  });

  it('IT-1841: custom initial column and context', () => {
    const machine = createTaskWorkflowMachine({
      taskId: 'task-1',
      column: 'in_progress',
      agentId: 'agent-1',
      runningAgents: 1,
    });
    expect(machine.state).toBe('in_progress');
    expect(machine.context.agentId).toBe('agent-1');

    const result = machine.send({ type: 'COMPLETE' });
    expect(result.ok).toBe(true);
    expect(machine.state).toBe('waiting_approval');
  });
});
