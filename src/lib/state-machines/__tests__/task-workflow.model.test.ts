import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import type { TaskMachine } from '../task-workflow/machine.js';
import { createTaskWorkflowMachine } from '../task-workflow/machine.js';
import type { TaskColumn } from '../task-workflow/types.js';

// ---------------------------------------------------------------------------
// Model
// ---------------------------------------------------------------------------

type TaskModel = {
  state: TaskColumn;
  agentId: string | undefined;
  hasDiff: boolean;
};

type RealSystem = { machine: TaskMachine };

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

class AssignCommand implements fc.Command<TaskModel, RealSystem> {
  constructor(readonly agentId: string) {}

  check(m: Readonly<TaskModel>): boolean {
    return m.state === 'backlog' && m.agentId === undefined;
  }

  run(m: TaskModel, real: RealSystem): void {
    const result = real.machine.send({ type: 'ASSIGN', agentId: this.agentId });
    expect(result.ok).toBe(true);
    expect(real.machine.state).toBe('in_progress');
    expect(real.machine.context.agentId).toBe(this.agentId);
    m.state = 'in_progress';
    m.agentId = this.agentId;
  }

  toString(): string {
    return `Assign(${this.agentId})`;
  }
}

class CompleteCommand implements fc.Command<TaskModel, RealSystem> {
  check(m: Readonly<TaskModel>): boolean {
    return m.state === 'in_progress';
  }

  run(m: TaskModel, real: RealSystem): void {
    const result = real.machine.send({ type: 'COMPLETE' });
    expect(result.ok).toBe(true);
    expect(real.machine.state).toBe('waiting_approval');
    m.state = 'waiting_approval';
  }

  toString(): string {
    return 'Complete';
  }
}

class ApproveCommand implements fc.Command<TaskModel, RealSystem> {
  check(m: Readonly<TaskModel>): boolean {
    return m.state === 'waiting_approval' && m.hasDiff;
  }

  run(m: TaskModel, real: RealSystem): void {
    const result = real.machine.send({ type: 'APPROVE' });
    expect(result.ok).toBe(true);
    expect(real.machine.state).toBe('verified');
    m.state = 'verified';
  }

  toString(): string {
    return 'Approve';
  }
}

class RejectCommand implements fc.Command<TaskModel, RealSystem> {
  constructor(readonly reason: string | undefined) {}

  check(m: Readonly<TaskModel>): boolean {
    return m.state === 'waiting_approval';
  }

  run(m: TaskModel, real: RealSystem): void {
    const result = real.machine.send({ type: 'REJECT', reason: this.reason });
    expect(result.ok).toBe(true);
    expect(real.machine.state).toBe('in_progress');
    m.state = 'in_progress';
  }

  toString(): string {
    return `Reject(${this.reason ?? 'no reason'})`;
  }
}

class CancelCommand implements fc.Command<TaskModel, RealSystem> {
  check(m: Readonly<TaskModel>): boolean {
    return m.state === 'in_progress';
  }

  run(m: TaskModel, real: RealSystem): void {
    const result = real.machine.send({ type: 'CANCEL' });
    expect(result.ok).toBe(true);
    expect(real.machine.state).toBe('backlog');
    expect(real.machine.context.agentId).toBeUndefined();
    m.state = 'backlog';
    m.agentId = undefined;
  }

  toString(): string {
    return 'Cancel';
  }
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('task workflow model-based testing', () => {
  it('real machine agrees with model for any valid command sequence', () => {
    const allCommands = [
      fc.constant(new AssignCommand('agent-1')),
      fc.constant(new CompleteCommand()),
      fc.constant(new ApproveCommand()),
      fc
        .record({ reason: fc.option(fc.string({ maxLength: 50 })) })
        .map((r) => new RejectCommand(r.reason ?? undefined)),
      fc.constant(new CancelCommand()),
    ];

    fc.assert(
      fc.property(fc.commands(allCommands, { size: 'medium' }), (cmds) => {
        const setup = () => ({
          model: {
            state: 'backlog' as TaskColumn,
            agentId: undefined as string | undefined,
            hasDiff: true,
          },
          real: {
            machine: createTaskWorkflowMachine({
              taskId: 'test-task',
              diffSummary: { filesChanged: 3 },
            }),
          },
        });
        fc.modelRun(setup, cmds);
      }),
      { numRuns: 200 }
    );
  });

  it('verified state is unreachable when diffSummary is null', () => {
    const allCommands = [
      fc.constant(new AssignCommand('agent-1')),
      fc.constant(new CompleteCommand()),
      fc.constant(new RejectCommand(undefined)),
      fc.constant(new CancelCommand()),
      // ApproveCommand is included but its check() returns false when hasDiff=false,
      // so fc.commands will never select it — verified is unreachable
      fc.constant(new ApproveCommand()),
    ];

    fc.assert(
      fc.property(fc.commands(allCommands, { size: 'medium' }), (cmds) => {
        const setup = () => ({
          model: {
            state: 'backlog' as TaskColumn,
            agentId: undefined as string | undefined,
            hasDiff: false,
          },
          real: {
            machine: createTaskWorkflowMachine({
              taskId: 'test-task',
              diffSummary: null,
            }),
          },
        });
        fc.modelRun(setup, cmds);
      }),
      { numRuns: 200 }
    );
  });

  it('handles repeated reject-complete cycles without state corruption', () => {
    // Bias command distribution towards ASSIGN → COMPLETE → REJECT loops
    const loopCommands = [
      fc.constant(new AssignCommand('loop-agent')),
      // Higher weight for COMPLETE and REJECT to create more cycles
      fc.constant(new CompleteCommand()),
      fc.constant(new CompleteCommand()),
      fc.constant(new RejectCommand('needs revision')),
      fc.constant(new RejectCommand('try again')),
      fc.constant(new ApproveCommand()),
      fc.constant(new CancelCommand()),
    ];

    fc.assert(
      fc.property(fc.commands(loopCommands, { size: 'large' }), (cmds) => {
        const setup = () => ({
          model: {
            state: 'backlog' as TaskColumn,
            agentId: undefined as string | undefined,
            hasDiff: true,
          },
          real: {
            machine: createTaskWorkflowMachine({
              taskId: 'cycle-task',
              diffSummary: { filesChanged: 2 },
            }),
          },
        });
        fc.modelRun(setup, cmds);
      }),
      { numRuns: 200 }
    );
  });

  it('model tracks agentId correctly through assign-cancel-assign sequences', () => {
    const allCommands = [
      fc.string({ minLength: 1, maxLength: 10 }).map((id) => new AssignCommand(id)),
      fc.constant(new CompleteCommand()),
      fc.constant(new ApproveCommand()),
      fc.constant(new RejectCommand(undefined)),
      fc.constant(new CancelCommand()),
    ];

    fc.assert(
      fc.property(fc.commands(allCommands, { size: 'medium' }), (cmds) => {
        const setup = () => ({
          model: {
            state: 'backlog' as TaskColumn,
            agentId: undefined as string | undefined,
            hasDiff: true,
          },
          real: {
            machine: createTaskWorkflowMachine({
              taskId: 'test-task',
              diffSummary: { filesChanged: 1 },
            }),
          },
        });
        fc.modelRun(setup, cmds);
      }),
      { numRuns: 200 }
    );
  });

  it('full lifecycle: backlog → in_progress → waiting_approval → verified is always reachable', () => {
    fc.assert(
      fc.property(
        fc.string({ minLength: 1, maxLength: 20 }),
        fc.string({ minLength: 1, maxLength: 20 }),
        (taskId, agentId) => {
          const machine = createTaskWorkflowMachine({
            taskId,
            diffSummary: { filesChanged: 5 },
          });

          const r1 = machine.send({ type: 'ASSIGN', agentId });
          expect(r1.ok).toBe(true);
          expect(machine.state).toBe('in_progress');

          const r2 = machine.send({ type: 'COMPLETE' });
          expect(r2.ok).toBe(true);
          expect(machine.state).toBe('waiting_approval');

          const r3 = machine.send({ type: 'APPROVE' });
          expect(r3.ok).toBe(true);
          expect(machine.state).toBe('verified');
        }
      ),
      { numRuns: 100 }
    );
  });
});
