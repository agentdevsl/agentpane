/** biome-ignore-all lint/nursery/noFloatingPromises: fc.assert is synchronous when the property function is sync; the rule can't infer this from the overloaded return type. */

import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { VALID_TRANSITIONS } from '../../../services/task-transitions.js';
import type { AppError } from '../../errors/base.js';
import { createError } from '../../errors/base.js';
import {
  canPause,
  canResume,
  canStart,
  isToolAllowed,
  withinTurnLimit,
} from '../agent-lifecycle/guards.js';
import { createAgentLifecycleMachine } from '../agent-lifecycle/machine.js';
import type {
  AgentLifecycleContext,
  AgentLifecycleEvent,
  AgentLifecycleState,
} from '../agent-lifecycle/types.js';
import {
  canClose,
  hasCapacity,
  isParticipant,
  isStale as isSessionStale,
} from '../session-lifecycle/guards.js';
import { createSessionLifecycleMachine } from '../session-lifecycle/machine.js';
import type {
  SessionLifecycleContext,
  SessionLifecycleEvent,
  SessionLifecycleState,
} from '../session-lifecycle/types.js';
import {
  canApprove,
  canAssign,
  canReject,
  hasDiff,
  withinConcurrencyLimit,
} from '../task-workflow/guards.js';
import { createTaskWorkflowMachine } from '../task-workflow/machine.js';
import type { TaskColumn, TaskWorkflowContext, TaskWorkflowEvent } from '../task-workflow/types.js';
import {
  canCreate,
  canMerge,
  canRemove,
  hasConflicts,
  isStale as isWorktreeStale,
} from '../worktree-lifecycle/guards.js';
import { createWorktreeLifecycleMachine } from '../worktree-lifecycle/machine.js';
import type {
  WorktreeLifecycleContext,
  WorktreeLifecycleEvent,
  WorktreeLifecycleState,
} from '../worktree-lifecycle/types.js';

// ---------------------------------------------------------------------------
// Section 1: Shared Arbitraries
// ---------------------------------------------------------------------------

const appErrorArb: fc.Arbitrary<AppError> = fc
  .record({
    code: fc.string({ minLength: 1 }),
    message: fc.string(),
    status: fc.constantFrom(400, 403, 404, 409, 500),
  })
  .map(({ code, message, status }) => createError(code, message, status));

// --- Agent lifecycle ---

const agentStates: AgentLifecycleState[] = [
  'idle',
  'starting',
  'running',
  'paused',
  'completed',
  'error',
];
const agentStateArb: fc.Arbitrary<AgentLifecycleState> = fc.constantFrom(...agentStates);

const agentEventArb: fc.Arbitrary<AgentLifecycleEvent> = fc.oneof(
  fc.record({ type: fc.constant('START' as const), taskId: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('STEP' as const), turn: fc.nat() }),
  fc.record({ type: fc.constant('PAUSE' as const), reason: fc.string() }),
  fc.record({
    type: fc.constant('RESUME' as const),
    feedback: fc.option(fc.string(), { nil: undefined }),
  }),
  fc.record({ type: fc.constant('ERROR' as const), error: appErrorArb }),
  fc.record({ type: fc.constant('COMPLETE' as const), result: fc.anything() }),
  fc.record({ type: fc.constant('ABORT' as const) }),
  fc.record({
    type: fc.constant('TOOL' as const),
    tool: fc.oneof(
      fc.constantFrom('Read', 'Edit', 'Bash', 'Glob', 'Grep'),
      fc.string({ minLength: 1 })
    ),
  })
);

// --- Task workflow ---

const taskStates: TaskColumn[] = [
  'backlog',
  'queued',
  'in_progress',
  'waiting_approval',
  'verified',
];
const taskStateArb: fc.Arbitrary<TaskColumn> = fc.constantFrom(...taskStates);

const taskEventArb: fc.Arbitrary<TaskWorkflowEvent> = fc.oneof(
  fc.record({ type: fc.constant('QUEUE' as const) }),
  fc.record({ type: fc.constant('DEQUEUE' as const) }),
  fc.record({ type: fc.constant('ASSIGN' as const), agentId: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('COMPLETE' as const) }),
  fc.record({ type: fc.constant('APPROVE' as const) }),
  fc.record({
    type: fc.constant('REJECT' as const),
    reason: fc.option(fc.string(), { nil: undefined }),
  }),
  fc.record({ type: fc.constant('CANCEL' as const) }),
  fc.record({ type: fc.constant('REOPEN' as const) })
);

// --- Session lifecycle ---

const sessionStates: SessionLifecycleState[] = [
  'idle',
  'initializing',
  'active',
  'paused',
  'closing',
  'closed',
  'error',
];
const sessionStateArb: fc.Arbitrary<SessionLifecycleState> = fc.constantFrom(...sessionStates);

const sessionEventArb: fc.Arbitrary<SessionLifecycleEvent> = fc.oneof(
  fc.record({ type: fc.constant('INITIALIZE' as const) }),
  fc.record({ type: fc.constant('READY' as const) }),
  fc.record({ type: fc.constant('JOIN' as const), userId: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('LEAVE' as const), userId: fc.string({ minLength: 1 }) }),
  fc.record({ type: fc.constant('HEARTBEAT' as const) }),
  fc.record({ type: fc.constant('PAUSE' as const) }),
  fc.record({ type: fc.constant('RESUME' as const) }),
  fc.record({ type: fc.constant('CLOSE' as const) }),
  fc.record({ type: fc.constant('TIMEOUT' as const) }),
  fc.record({ type: fc.constant('ERROR' as const), error: appErrorArb })
);

// --- Worktree lifecycle ---

const worktreeStates: WorktreeLifecycleState[] = [
  'creating',
  'active',
  'dirty',
  'committing',
  'merging',
  'conflict',
  'removing',
  'removed',
  'error',
];
const worktreeStateArb: fc.Arbitrary<WorktreeLifecycleState> = fc.constantFrom(...worktreeStates);

const worktreeEventArb: fc.Arbitrary<WorktreeLifecycleEvent> = fc.oneof(
  fc.record({ type: fc.constant('INIT_COMPLETE' as const) }),
  fc.record({ type: fc.constant('MODIFY' as const) }),
  fc.record({ type: fc.constant('COMMIT' as const) }),
  fc.record({ type: fc.constant('MERGE' as const) }),
  fc.record({ type: fc.constant('RESOLVE_CONFLICT' as const) }),
  fc.record({ type: fc.constant('REMOVE' as const) }),
  fc.record({ type: fc.constant('ERROR' as const) })
);

// ---------------------------------------------------------------------------
// Section 2: Invariant Properties
// ---------------------------------------------------------------------------

describe('property: invariants', () => {
  describe('agent lifecycle', () => {
    it('any sequence of events always produces a valid state', () => {
      fc.assert(
        fc.property(fc.array(agentEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createAgentLifecycleMachine();
          const validStates: string[] = [
            'idle',
            'starting',
            'running',
            'paused',
            'completed',
            'error',
          ];
          for (const event of events) {
            machine.send(event);
            expect(validStates).toContain(machine.state);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('completed and error states reject non-ERROR events', () => {
      fc.assert(
        fc.property(
          fc.constantFrom('completed' as const, 'error' as const),
          fc.array(agentEventArb, { minLength: 1, maxLength: 10 }),
          (terminalState, events) => {
            const machine = createAgentLifecycleMachine({ status: terminalState });
            for (const event of events) {
              const result = machine.send(event);
              // completed/error are terminal states — no transitions are defined
              // TOOL with disallowed tool returns AGENT_TOOL_NOT_ALLOWED
              // Everything else returns AGENT_INVALID_TRANSITION
              if (
                event.type !== 'TOOL' ||
                machine.context.allowedTools.includes((event as { tool: string }).tool)
              ) {
                expect(result.ok).toBe(false);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('context always preserves required fields', () => {
      fc.assert(
        fc.property(fc.array(agentEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createAgentLifecycleMachine();
          for (const event of events) {
            machine.send(event);
            expect(machine.context).toHaveProperty('status');
            expect(machine.context).toHaveProperty('currentTurn');
            expect(machine.context).toHaveProperty('maxTurns');
            expect(machine.context).toHaveProperty('allowedTools');
            expect(typeof machine.context.currentTurn).toBe('number');
            expect(typeof machine.context.maxTurns).toBe('number');
            expect(Array.isArray(machine.context.allowedTools)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('state and context.status remain synchronized', () => {
      fc.assert(
        fc.property(fc.array(agentEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createAgentLifecycleMachine();
          for (const event of events) {
            machine.send(event);
            expect(machine.state).toBe(machine.context.status);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('currentTurn never decreases except on COMPLETE or ABORT', () => {
      fc.assert(
        fc.property(fc.array(agentEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createAgentLifecycleMachine();
          let prevTurn = machine.context.currentTurn;
          for (const event of events) {
            machine.send(event);
            const currentTurn = machine.context.currentTurn;
            if (event.type !== 'COMPLETE' && event.type !== 'ABORT') {
              expect(currentTurn).toBeGreaterThanOrEqual(prevTurn);
            }
            prevTurn = currentTurn;
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('task workflow', () => {
    it('any sequence of events always produces a valid state', () => {
      fc.assert(
        fc.property(fc.array(taskEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
          const validStates: string[] = [
            'backlog',
            'queued',
            'in_progress',
            'waiting_approval',
            'verified',
          ];
          for (const event of events) {
            machine.send(event);
            expect(validStates).toContain(machine.state);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('verified only reopens to backlog', () => {
      fc.assert(
        fc.property(fc.array(taskEventArb, { minLength: 1, maxLength: 20 }), (events) => {
          // Drive to verified: ASSIGN -> COMPLETE -> APPROVE (with diff)
          const machine = createTaskWorkflowMachine({
            taskId: 'task-1',
            diffSummary: { filesChanged: 1 },
          });
          machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
          machine.send({ type: 'COMPLETE' });
          machine.send({ type: 'APPROVE' });
          expect(machine.state).toBe('verified');

          for (const event of events) {
            const result = machine.send(event);
            if (event.type === 'REOPEN') {
              expect(result.ok).toBe(true);
              expect(machine.state).toBe('backlog');
              machine.send({ type: 'ASSIGN', agentId: 'agent-1' });
              machine.send({ type: 'COMPLETE' });
              machine.send({ type: 'APPROVE' });
              expect(machine.state).toBe('verified');
            } else {
              expect(machine.state).toBe('verified');
              expect(result.ok).toBe(false);
            }
          }
        }),
        { numRuns: 200 }
      );
    });

    it('context always preserves required fields', () => {
      fc.assert(
        fc.property(fc.array(taskEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
          for (const event of events) {
            machine.send(event);
            expect(machine.context).toHaveProperty('taskId');
            expect(machine.context).toHaveProperty('column');
            expect(machine.context).toHaveProperty('runningAgents');
            expect(machine.context).toHaveProperty('maxConcurrentAgents');
            expect(typeof machine.context.runningAgents).toBe('number');
            expect(typeof machine.context.maxConcurrentAgents).toBe('number');
          }
        }),
        { numRuns: 200 }
      );
    });

    it('state and context.column remain synchronized', () => {
      fc.assert(
        fc.property(fc.array(taskEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
          for (const event of events) {
            machine.send(event);
            expect(machine.state).toBe(machine.context.column);
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('session lifecycle', () => {
    it('any sequence of events always produces a valid state', () => {
      fc.assert(
        fc.property(fc.array(sessionEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createSessionLifecycleMachine();
          const validStates: string[] = [
            'idle',
            'initializing',
            'active',
            'paused',
            'closing',
            'closed',
            'error',
          ];
          for (const event of events) {
            machine.send(event);
            expect(validStates).toContain(machine.state);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('ERROR event transitions from any non-terminal state to error', () => {
      fc.assert(
        fc.property(sessionStateArb, appErrorArb, (initialState, error) => {
          const machine = createSessionLifecycleMachine({ status: initialState });
          const result = machine.send({ type: 'ERROR', error });
          if (initialState === 'closed') {
            // closed is terminal — ERROR should be rejected
            expect(result.ok).toBe(false);
            expect(machine.state).toBe('closed');
          } else {
            expect(machine.state).toBe('error');
          }
        }),
        { numRuns: 200 }
      );
    });

    it('context always preserves required fields', () => {
      fc.assert(
        fc.property(fc.array(sessionEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createSessionLifecycleMachine();
          for (const event of events) {
            machine.send(event);
            expect(machine.context).toHaveProperty('status');
            expect(machine.context).toHaveProperty('participants');
            expect(machine.context).toHaveProperty('maxParticipants');
            expect(machine.context).toHaveProperty('lastActivity');
            expect(Array.isArray(machine.context.participants)).toBe(true);
            expect(typeof machine.context.maxParticipants).toBe('number');
            expect(typeof machine.context.lastActivity).toBe('number');
          }
        }),
        { numRuns: 200 }
      );
    });

    it('state and context.status remain synchronized', () => {
      fc.assert(
        fc.property(fc.array(sessionEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createSessionLifecycleMachine();
          for (const event of events) {
            machine.send(event);
            expect(machine.state).toBe(machine.context.status);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('participants count never exceeds maxParticipants', () => {
      fc.assert(
        fc.property(fc.array(sessionEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createSessionLifecycleMachine({ maxParticipants: 4 });
          for (const event of events) {
            machine.send(event);
            expect(machine.context.participants.length).toBeLessThanOrEqual(
              machine.context.maxParticipants
            );
          }
        }),
        { numRuns: 200 }
      );
    });
  });

  describe('worktree lifecycle', () => {
    it('any sequence of events always produces a valid state', () => {
      fc.assert(
        fc.property(fc.array(worktreeEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createWorktreeLifecycleMachine({ branch: 'feature-branch' });
          const validStates: string[] = [
            'creating',
            'active',
            'dirty',
            'committing',
            'merging',
            'conflict',
            'removing',
            'removed',
            'error',
          ];
          for (const event of events) {
            machine.send(event);
            expect(validStates).toContain(machine.state);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('ERROR event transitions from any state to error', () => {
      fc.assert(
        fc.property(worktreeStateArb, (initialState) => {
          // All 9 worktree states are covered by the arbitrary
          const machine = createWorktreeLifecycleMachine({
            branch: 'feature-branch',
            status: initialState,
          });
          machine.send({ type: 'ERROR' });
          expect(machine.state).toBe('error');
        }),
        { numRuns: 200 }
      );
    });

    it('context always preserves required fields', () => {
      fc.assert(
        fc.property(fc.array(worktreeEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createWorktreeLifecycleMachine({ branch: 'feature-branch' });
          for (const event of events) {
            machine.send(event);
            expect(machine.context).toHaveProperty('status');
            expect(machine.context).toHaveProperty('branch');
            expect(machine.context).toHaveProperty('branchExists');
            expect(machine.context).toHaveProperty('pathAvailable');
            expect(machine.context).toHaveProperty('hasUncommittedChanges');
            expect(machine.context).toHaveProperty('conflictFiles');
            expect(typeof machine.context.branchExists).toBe('boolean');
            expect(typeof machine.context.pathAvailable).toBe('boolean');
            expect(typeof machine.context.hasUncommittedChanges).toBe('boolean');
            expect(Array.isArray(machine.context.conflictFiles)).toBe(true);
          }
        }),
        { numRuns: 200 }
      );
    });

    it('state and context.status remain synchronized', () => {
      fc.assert(
        fc.property(fc.array(worktreeEventArb, { minLength: 1, maxLength: 30 }), (events) => {
          const machine = createWorktreeLifecycleMachine({ branch: 'feature-branch' });
          for (const event of events) {
            machine.send(event);
            expect(machine.state).toBe(machine.context.status);
          }
        }),
        { numRuns: 200 }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Section 3: Reachability Properties
// ---------------------------------------------------------------------------

describe('property: reachability', () => {
  // Known paths to reach each agent state
  const agentPaths: Record<AgentLifecycleState, AgentLifecycleEvent[] | null> = {
    idle: [], // initial state
    // 'starting' is in the type but UNREACHABLE — no transition produces it
    starting: null,
    running: [{ type: 'START', taskId: 'task-1' }],
    paused: [
      { type: 'START', taskId: 'task-1' },
      { type: 'PAUSE', reason: 'break' },
    ],
    completed: [
      { type: 'START', taskId: 'task-1' },
      { type: 'COMPLETE', result: 'done' },
    ],
    error: [
      { type: 'START', taskId: 'task-1' },
      { type: 'ERROR', error: createError('TEST', 'test error', 500) },
    ],
  };

  it('all reachable agent states can be reached via known paths', () => {
    for (const [state, path] of Object.entries(agentPaths)) {
      if (path === null) {
        // 'starting' is unreachable
        continue;
      }
      const machine = createAgentLifecycleMachine();
      for (const event of path) {
        machine.send(event);
      }
      expect(machine.state).toBe(state);
    }
  });

  it('unreachable agent states (starting) cannot be reached via any event sequence', () => {
    // 'starting' is defined in the type but no transition produces it
    fc.assert(
      fc.property(fc.array(agentEventArb, { minLength: 0, maxLength: 50 }), (events) => {
        const machine = createAgentLifecycleMachine();
        for (const event of events) {
          machine.send(event);
        }
        expect(machine.state).not.toBe('starting');
      }),
      { numRuns: 200 }
    );
  });

  // Known paths to reach each task state
  const taskPaths: Record<TaskColumn, TaskWorkflowEvent[]> = {
    backlog: [], // initial state
    queued: [{ type: 'QUEUE' }],
    in_progress: [{ type: 'ASSIGN', agentId: 'agent-1' }],
    waiting_approval: [{ type: 'ASSIGN', agentId: 'agent-1' }, { type: 'COMPLETE' }],
    verified: [{ type: 'ASSIGN', agentId: 'agent-1' }, { type: 'COMPLETE' }, { type: 'APPROVE' }],
  };

  it('all task states can be reached via known paths', () => {
    for (const [state, path] of Object.entries(taskPaths)) {
      const machine = createTaskWorkflowMachine({
        taskId: 'task-1',
        diffSummary: { filesChanged: 1 },
      });
      for (const event of path) {
        machine.send(event);
      }
      expect(machine.state).toBe(state);
    }
  });

  const serviceTransitionEvents: Array<{
    from: TaskColumn;
    to: TaskColumn;
    event: TaskWorkflowEvent;
  }> = [
    { from: 'backlog', to: 'queued', event: { type: 'QUEUE' } },
    { from: 'backlog', to: 'in_progress', event: { type: 'ASSIGN', agentId: 'agent-1' } },
    { from: 'queued', to: 'in_progress', event: { type: 'ASSIGN', agentId: 'agent-1' } },
    { from: 'queued', to: 'backlog', event: { type: 'DEQUEUE' } },
    { from: 'in_progress', to: 'waiting_approval', event: { type: 'COMPLETE' } },
    { from: 'in_progress', to: 'backlog', event: { type: 'CANCEL' } },
    { from: 'waiting_approval', to: 'verified', event: { type: 'APPROVE' } },
    { from: 'waiting_approval', to: 'in_progress', event: { type: 'REJECT' } },
    { from: 'waiting_approval', to: 'backlog', event: { type: 'CANCEL' } },
    { from: 'verified', to: 'backlog', event: { type: 'REOPEN' } },
  ];

  it('task workflow machine covers the TaskService transition matrix', () => {
    const expectedPairs = new Set(
      Object.entries(VALID_TRANSITIONS).flatMap(([from, targets]) =>
        targets.map((to) => `${from}->${to}`)
      )
    );
    const actualPairs = new Set(serviceTransitionEvents.map(({ from, to }) => `${from}->${to}`));
    expect(actualPairs).toEqual(expectedPairs);

    for (const { from, to, event } of serviceTransitionEvents) {
      const machine = createTaskWorkflowMachine({
        taskId: 'task-1',
        column: from,
        diffSummary: { filesChanged: 1 },
      });
      const result = machine.send(event);
      expect(result.ok).toBe(true);
      expect(machine.state).toBe(to);
    }
  });

  // Known paths to reach each session state
  const sessionPaths: Record<SessionLifecycleState, SessionLifecycleEvent[]> = {
    idle: [], // initial state
    initializing: [{ type: 'INITIALIZE' }],
    active: [{ type: 'INITIALIZE' }, { type: 'READY' }],
    paused: [{ type: 'INITIALIZE' }, { type: 'READY' }, { type: 'PAUSE' }],
    closing: [{ type: 'INITIALIZE' }, { type: 'READY' }, { type: 'PAUSE' }, { type: 'CLOSE' }],
    closed: [
      { type: 'INITIALIZE' },
      { type: 'READY' },
      { type: 'PAUSE' },
      { type: 'CLOSE' },
      { type: 'CLOSE' },
    ],
    error: [{ type: 'ERROR', error: createError('TEST', 'test', 500) }],
  };

  it('all session states can be reached via known paths', () => {
    for (const [state, path] of Object.entries(sessionPaths)) {
      const machine = createSessionLifecycleMachine();
      for (const event of path) {
        machine.send(event);
      }
      expect(machine.state).toBe(state);
    }
  });

  // Known paths to reach each worktree state
  const worktreePaths: Record<WorktreeLifecycleState, WorktreeLifecycleEvent[] | null> = {
    creating: [], // initial state
    active: [{ type: 'INIT_COMPLETE' }],
    dirty: [{ type: 'INIT_COMPLETE' }, { type: 'MODIFY' }],
    committing: [{ type: 'INIT_COMPLETE' }, { type: 'MODIFY' }, { type: 'COMMIT' }],
    merging: [{ type: 'INIT_COMPLETE' }, { type: 'MODIFY' }, { type: 'COMMIT' }, { type: 'MERGE' }],
    conflict: null, // Requires conflictFiles to be non-empty, which no standard transition sets
    removing: [{ type: 'INIT_COMPLETE' }, { type: 'REMOVE' }],
    removed: [{ type: 'INIT_COMPLETE' }, { type: 'REMOVE' }, { type: 'REMOVE' }],
    error: [{ type: 'ERROR' }],
  };

  it('all reachable worktree states can be reached via known paths', () => {
    for (const [state, path] of Object.entries(worktreePaths)) {
      if (path === null) {
        continue;
      }
      const machine = createWorktreeLifecycleMachine({ branch: 'feature-branch' });
      for (const event of path) {
        machine.send(event);
      }
      expect(machine.state).toBe(state);
    }
  });

  it('worktree conflict state can be reached with conflictFiles set', () => {
    // conflict requires: merging state + MODIFY event + hasConflicts (conflictFiles.length > 0)
    const machine = createWorktreeLifecycleMachine({
      branch: 'feature-branch',
      status: 'merging',
      conflictFiles: ['file1.ts'],
    });
    machine.send({ type: 'MODIFY' });
    expect(machine.state).toBe('conflict');
  });

  // 'initializing' state was removed from WorktreeLifecycleState — no transition ever produced it
});

// ---------------------------------------------------------------------------
// Section 4: Idempotence Properties
// ---------------------------------------------------------------------------

describe('property: idempotence', () => {
  describe('agent lifecycle', () => {
    it('failed transitions that do not change state produce the same error code when retried', () => {
      fc.assert(
        fc.property(
          fc.array(agentEventArb, { minLength: 1, maxLength: 20 }),
          agentEventArb,
          (setupEvents, testEvent) => {
            const machine = createAgentLifecycleMachine();
            for (const event of setupEvents) {
              machine.send(event);
            }
            const stateBefore = machine.state;
            const result1 = machine.send(testEvent);
            // Only check idempotence if the failed transition did not mutate state
            // (e.g., ERROR from running transitions to error state even though result is err)
            if (!result1.ok && machine.state === stateBefore) {
              const result2 = machine.send(testEvent);
              expect(result2.ok).toBe(false);
              if (!result2.ok) {
                expect(result2.error.code).toBe(result1.error.code);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('guard functions are deterministic — same input produces same output', () => {
      fc.assert(
        fc.property(
          fc.record({
            status: agentStateArb,
            currentTurn: fc.nat({ max: 200 }),
            maxTurns: fc.nat({ max: 200 }),
            allowedTools: fc.array(fc.string()),
            taskId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          }),
          (partialCtx) => {
            const ctx: AgentLifecycleContext = { ...partialCtx };
            expect(canStart(ctx)).toBe(canStart(ctx));
            expect(withinTurnLimit(ctx)).toBe(withinTurnLimit(ctx));
            expect(canPause(ctx)).toBe(canPause(ctx));
            expect(canResume(ctx)).toBe(canResume(ctx));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('task workflow', () => {
    it('failed transitions produce the same error code when retried', () => {
      fc.assert(
        fc.property(
          fc.array(taskEventArb, { minLength: 1, maxLength: 20 }),
          taskEventArb,
          (setupEvents, testEvent) => {
            const machine = createTaskWorkflowMachine({ taskId: 'task-1' });
            for (const event of setupEvents) {
              machine.send(event);
            }
            const result1 = machine.send(testEvent);
            if (!result1.ok) {
              const result2 = machine.send(testEvent);
              expect(result2.ok).toBe(false);
              if (!result2.ok) {
                expect(result2.error.code).toBe(result1.error.code);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('guard functions are deterministic — same input produces same output', () => {
      fc.assert(
        fc.property(
          fc.record({
            taskId: fc.string({ minLength: 1 }),
            column: taskStateArb,
            agentId: fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
            diffSummary: fc.option(fc.record({ filesChanged: fc.nat() }), { nil: null }),
            runningAgents: fc.nat({ max: 10 }),
            maxConcurrentAgents: fc.nat({ max: 10 }),
          }),
          (ctx) => {
            const context = ctx as TaskWorkflowContext;
            expect(canAssign(context)).toBe(canAssign(context));
            expect(withinConcurrencyLimit(context)).toBe(withinConcurrencyLimit(context));
            expect(hasDiff(context)).toBe(hasDiff(context));
            expect(canApprove(context)).toBe(canApprove(context));
            expect(canReject(context)).toBe(canReject(context));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('session lifecycle', () => {
    it('failed transitions produce the same error code when retried', () => {
      fc.assert(
        fc.property(
          fc.array(sessionEventArb, { minLength: 1, maxLength: 20 }),
          sessionEventArb,
          (setupEvents, testEvent) => {
            const machine = createSessionLifecycleMachine();
            for (const event of setupEvents) {
              machine.send(event);
            }
            const result1 = machine.send(testEvent);
            if (!result1.ok) {
              const result2 = machine.send(testEvent);
              expect(result2.ok).toBe(false);
              if (!result2.ok) {
                expect(result2.error.code).toBe(result1.error.code);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('guard functions are deterministic — same input produces same output', () => {
      fc.assert(
        fc.property(
          fc.record({
            status: sessionStateArb,
            participants: fc.array(fc.string({ minLength: 1 }), { maxLength: 10 }),
            maxParticipants: fc.integer({ min: 1, max: 10 }),
            lastActivity: fc.nat(),
          }),
          (ctx) => {
            const context = ctx as SessionLifecycleContext;
            expect(hasCapacity(context)).toBe(hasCapacity(context));
            expect(canClose(context)).toBe(canClose(context));
          }
        ),
        { numRuns: 100 }
      );
    });
  });

  describe('worktree lifecycle', () => {
    it('failed transitions produce the same error code when retried', () => {
      fc.assert(
        fc.property(
          fc.array(worktreeEventArb, { minLength: 1, maxLength: 20 }),
          worktreeEventArb,
          (setupEvents, testEvent) => {
            const machine = createWorktreeLifecycleMachine({ branch: 'feature-branch' });
            for (const event of setupEvents) {
              machine.send(event);
            }
            const result1 = machine.send(testEvent);
            if (!result1.ok) {
              const result2 = machine.send(testEvent);
              expect(result2.ok).toBe(false);
              if (!result2.ok) {
                expect(result2.error.code).toBe(result1.error.code);
              }
            }
          }
        ),
        { numRuns: 200 }
      );
    });

    it('guard functions are deterministic — same input produces same output', () => {
      fc.assert(
        fc.property(
          fc.record({
            status: worktreeStateArb,
            branch: fc.string({ minLength: 1 }),
            path: fc.option(fc.string(), { nil: undefined }),
            lastActivity: fc.nat(),
            branchExists: fc.boolean(),
            pathAvailable: fc.boolean(),
            hasUncommittedChanges: fc.boolean(),
            conflictFiles: fc.array(fc.string()),
          }),
          (ctx) => {
            const context = ctx as WorktreeLifecycleContext;
            expect(canCreate(context)).toBe(canCreate(context));
            expect(canMerge(context)).toBe(canMerge(context));
            expect(canRemove(context)).toBe(canRemove(context));
            expect(isWorktreeStale(context)).toBe(isWorktreeStale(context));
            expect(hasConflicts(context)).toBe(hasConflicts(context));
          }
        ),
        { numRuns: 100 }
      );
    });
  });
});

// ---------------------------------------------------------------------------
// Section 5: Guard Boundary Properties
// ---------------------------------------------------------------------------

describe('property: guard boundaries', () => {
  describe('agent lifecycle guards', () => {
    it('withinTurnLimit: true when currentTurn < maxTurns, false at boundary', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 500 }), (maxTurns) => {
          const base: AgentLifecycleContext = {
            status: 'running',
            currentTurn: 0,
            maxTurns,
            allowedTools: [],
          };

          // Below limit — should be true
          expect(withinTurnLimit({ ...base, currentTurn: maxTurns - 1 })).toBe(true);
          // At limit — should be false (uses strict <)
          expect(withinTurnLimit({ ...base, currentTurn: maxTurns })).toBe(false);
          // Above limit — should be false
          expect(withinTurnLimit({ ...base, currentTurn: maxTurns + 1 })).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('canStart: true only when status is idle AND taskId is set', () => {
      fc.assert(
        fc.property(
          agentStateArb,
          fc.option(fc.string({ minLength: 1 }), { nil: undefined }),
          (status, taskId) => {
            const ctx: AgentLifecycleContext = {
              status,
              currentTurn: 0,
              maxTurns: 50,
              allowedTools: [],
              taskId,
            };
            const expected = status === 'idle' && !!taskId;
            expect(canStart(ctx)).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('isToolAllowed: always true for non-TOOL events', () => {
      fc.assert(
        fc.property(
          fc.record({
            status: agentStateArb,
            currentTurn: fc.nat(),
            maxTurns: fc.nat(),
            allowedTools: fc.array(fc.string()),
          }),
          agentEventArb.filter((e) => e.type !== 'TOOL'),
          (ctx, event) => {
            expect(isToolAllowed(ctx as AgentLifecycleContext, event)).toBe(true);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('isToolAllowed: for TOOL events, true only if tool is in allowedTools', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 }), { minLength: 1, maxLength: 10 }),
          fc.string({ minLength: 1 }),
          (allowedTools, tool) => {
            const ctx: AgentLifecycleContext = {
              status: 'running',
              currentTurn: 0,
              maxTurns: 50,
              allowedTools,
            };
            const event: AgentLifecycleEvent = { type: 'TOOL', tool };
            const expected = allowedTools.includes(tool);
            expect(isToolAllowed(ctx, event)).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('canPause: true only when status is running', () => {
      fc.assert(
        fc.property(agentStateArb, (status) => {
          const ctx: AgentLifecycleContext = {
            status,
            currentTurn: 0,
            maxTurns: 50,
            allowedTools: [],
          };
          expect(canPause(ctx)).toBe(status === 'running');
        }),
        { numRuns: 100 }
      );
    });

    it('canResume: true only when status is paused', () => {
      fc.assert(
        fc.property(agentStateArb, (status) => {
          const ctx: AgentLifecycleContext = {
            status,
            currentTurn: 0,
            maxTurns: 50,
            allowedTools: [],
          };
          expect(canResume(ctx)).toBe(status === 'paused');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('task workflow guards', () => {
    it('withinConcurrencyLimit: true when runningAgents < maxConcurrentAgents', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 100 }), (max) => {
          const base: TaskWorkflowContext = {
            taskId: 'task-1',
            column: 'backlog',
            runningAgents: 0,
            maxConcurrentAgents: max,
            diffSummary: null,
          };

          // Below limit — true
          expect(withinConcurrencyLimit({ ...base, runningAgents: max - 1 })).toBe(true);
          // At limit — false (strict <)
          expect(withinConcurrencyLimit({ ...base, runningAgents: max })).toBe(false);
          // Above limit — false
          expect(withinConcurrencyLimit({ ...base, runningAgents: max + 1 })).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('canAssign: always false when agentId is set', () => {
      fc.assert(
        fc.property(fc.string({ minLength: 1 }), taskStateArb, (agentId, column) => {
          const ctx: TaskWorkflowContext = {
            taskId: 'task-1',
            column,
            agentId,
            runningAgents: 0,
            maxConcurrentAgents: 3,
            diffSummary: null,
          };
          expect(canAssign(ctx)).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('canAssign: true only when column is backlog or queued and no agentId', () => {
      fc.assert(
        fc.property(taskStateArb, (column) => {
          const ctx: TaskWorkflowContext = {
            taskId: 'task-1',
            column,
            agentId: undefined,
            runningAgents: 0,
            maxConcurrentAgents: 3,
            diffSummary: null,
          };
          expect(canAssign(ctx)).toBe(column === 'backlog' || column === 'queued');
        }),
        { numRuns: 100 }
      );
    });

    it('hasDiff: false when diffSummary is null or filesChanged is 0', () => {
      fc.assert(
        fc.property(
          fc.oneof(
            fc.constant(null),
            fc.constant({ filesChanged: 0 }),
            fc.record({ filesChanged: fc.integer({ min: 1, max: 100 }) })
          ),
          (diffSummary) => {
            const ctx: TaskWorkflowContext = {
              taskId: 'task-1',
              column: 'waiting_approval',
              runningAgents: 0,
              maxConcurrentAgents: 3,
              diffSummary,
            };
            const expected = !!diffSummary && diffSummary.filesChanged > 0;
            expect(hasDiff(ctx)).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('canApprove: true only when column is waiting_approval', () => {
      fc.assert(
        fc.property(taskStateArb, (column) => {
          const ctx: TaskWorkflowContext = {
            taskId: 'task-1',
            column,
            runningAgents: 0,
            maxConcurrentAgents: 3,
            diffSummary: null,
          };
          expect(canApprove(ctx)).toBe(column === 'waiting_approval');
        }),
        { numRuns: 100 }
      );
    });

    it('canReject: true only when column is waiting_approval', () => {
      fc.assert(
        fc.property(taskStateArb, (column) => {
          const ctx: TaskWorkflowContext = {
            taskId: 'task-1',
            column,
            runningAgents: 0,
            maxConcurrentAgents: 3,
            diffSummary: null,
          };
          expect(canReject(ctx)).toBe(column === 'waiting_approval');
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('session lifecycle guards', () => {
    it('hasCapacity: true when participants.length < maxParticipants', () => {
      fc.assert(
        fc.property(fc.integer({ min: 1, max: 20 }), (max) => {
          const base: SessionLifecycleContext = {
            status: 'active',
            participants: [],
            maxParticipants: max,
            lastActivity: Date.now(),
          };

          // Below capacity — true
          const belowParticipants = Array.from({ length: max - 1 }, (_, i) => `user-${i}`);
          expect(hasCapacity({ ...base, participants: belowParticipants })).toBe(true);

          // At capacity — false (strict <)
          const atParticipants = Array.from({ length: max }, (_, i) => `user-${i}`);
          expect(hasCapacity({ ...base, participants: atParticipants })).toBe(false);

          // Over capacity — false
          const overParticipants = Array.from({ length: max + 1 }, (_, i) => `user-${i}`);
          expect(hasCapacity({ ...base, participants: overParticipants })).toBe(false);
        }),
        { numRuns: 100 }
      );
    });

    it('isParticipant: true only if userId is in participants array', () => {
      fc.assert(
        fc.property(
          fc.array(fc.string({ minLength: 1 }), { maxLength: 10 }),
          fc.string({ minLength: 1 }),
          (participants, userId) => {
            const ctx: SessionLifecycleContext = {
              status: 'active',
              participants,
              maxParticipants: 10,
              lastActivity: Date.now(),
            };
            expect(isParticipant(ctx, userId)).toBe(participants.includes(userId));
          }
        ),
        { numRuns: 100 }
      );
    });

    it('isStale (session): true when Date.now() - lastActivity > 60000', () => {
      // Use a fixed point in time to avoid Date.now() drift
      const now = Date.now();
      fc.assert(
        fc.property(fc.integer({ min: 0, max: 200000 }), (elapsed) => {
          const ctx: SessionLifecycleContext = {
            status: 'active',
            participants: [],
            maxParticipants: 4,
            lastActivity: now - elapsed,
          };
          // The guard uses Date.now() internally, so we check the relationship
          // If elapsed > 60000, then Date.now() - (now - elapsed) >= elapsed > 60000
          // But Date.now() may have advanced slightly, so we can only be precise for large gaps
          if (elapsed > 61000) {
            expect(isSessionStale(ctx)).toBe(true);
          }
          if (elapsed === 0) {
            expect(isSessionStale(ctx)).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('canClose: false only when status is closed or closing', () => {
      fc.assert(
        fc.property(sessionStateArb, (status) => {
          const ctx: SessionLifecycleContext = {
            status,
            participants: [],
            maxParticipants: 4,
            lastActivity: Date.now(),
          };
          const expected = status !== 'closed' && status !== 'closing';
          expect(canClose(ctx)).toBe(expected);
        }),
        { numRuns: 100 }
      );
    });
  });

  describe('worktree lifecycle guards', () => {
    it('canCreate: true only when branchExists is false AND pathAvailable is true', () => {
      fc.assert(
        fc.property(fc.boolean(), fc.boolean(), (branchExists, pathAvailable) => {
          const ctx: WorktreeLifecycleContext = {
            status: 'creating',
            branch: 'feature',
            lastActivity: Date.now(),
            branchExists,
            pathAvailable,
            hasUncommittedChanges: false,
            conflictFiles: [],
          };
          expect(canCreate(ctx)).toBe(!branchExists && pathAvailable);
        }),
        { numRuns: 100 }
      );
    });

    it('canMerge: false when hasUncommittedChanges is true OR conflictFiles is non-empty', () => {
      fc.assert(
        fc.property(
          fc.boolean(),
          fc.array(fc.string({ minLength: 1 }), { maxLength: 5 }),
          (hasUncommittedChanges, conflictFiles) => {
            const ctx: WorktreeLifecycleContext = {
              status: 'active',
              branch: 'feature',
              lastActivity: Date.now(),
              branchExists: false,
              pathAvailable: true,
              hasUncommittedChanges,
              conflictFiles,
            };
            const expected = !hasUncommittedChanges && conflictFiles.length === 0;
            expect(canMerge(ctx)).toBe(expected);
          }
        ),
        { numRuns: 100 }
      );
    });

    it('canRemove: false for creating, merging, committing — true for others', () => {
      fc.assert(
        fc.property(worktreeStateArb, (status) => {
          const ctx: WorktreeLifecycleContext = {
            status,
            branch: 'feature',
            lastActivity: Date.now(),
            branchExists: false,
            pathAvailable: true,
            hasUncommittedChanges: false,
            conflictFiles: [],
          };
          const blockedStates: WorktreeLifecycleState[] = ['creating', 'merging', 'committing'];
          expect(canRemove(ctx)).toBe(!blockedStates.includes(status));
        }),
        { numRuns: 100 }
      );
    });

    it('isStale (worktree): true when elapsed > 7 days', () => {
      const now = Date.now();
      const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;
      fc.assert(
        fc.property(fc.integer({ min: 0, max: sevenDaysMs * 3 }), (elapsed) => {
          const ctx: WorktreeLifecycleContext = {
            status: 'active',
            branch: 'feature',
            lastActivity: now - elapsed,
            branchExists: false,
            pathAvailable: true,
            hasUncommittedChanges: false,
            conflictFiles: [],
          };
          // Guard uses Date.now() internally; allow margin for test execution time
          if (elapsed > sevenDaysMs + 1000) {
            expect(isWorktreeStale(ctx)).toBe(true);
          }
          if (elapsed === 0) {
            expect(isWorktreeStale(ctx)).toBe(false);
          }
        }),
        { numRuns: 100 }
      );
    });

    it('hasConflicts: true only when conflictFiles is non-empty', () => {
      fc.assert(
        fc.property(fc.array(fc.string({ minLength: 1 }), { maxLength: 10 }), (conflictFiles) => {
          const ctx: WorktreeLifecycleContext = {
            status: 'merging',
            branch: 'feature',
            lastActivity: Date.now(),
            branchExists: false,
            pathAvailable: true,
            hasUncommittedChanges: false,
            conflictFiles,
          };
          expect(hasConflicts(ctx)).toBe(conflictFiles.length > 0);
        }),
        { numRuns: 100 }
      );
    });
  });
});
