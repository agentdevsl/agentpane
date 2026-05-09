/**
 * Integration coverage for src/lib/plan-mode/interaction-handler.ts.
 * The module already has a unit suite at tests/lib/plan-mode/
 * interaction-handler.test.ts; this file lifts the integration project's
 * measurement.
 *
 * Run: npx vitest run --project integration tests/integration/plan-mode-interaction-handler.test.ts
 */
import { describe, expect, it } from 'vitest';
import {
  createInteractionHandler,
  InteractionHandler,
} from '../../src/lib/plan-mode/interaction-handler';
import type { PlanSession, PlanTurn, UserInteraction } from '../../src/lib/plan-mode/types';

function buildSession(turns: PlanTurn[]): PlanSession {
  return {
    id: 'sess-1',
    codespaceId: 'cs-1',
    taskId: 'task-1',
    status: 'waiting_user',
    turns,
    createdAt: new Date().toISOString(),
    lastActivityAt: new Date().toISOString(),
  } as PlanSession;
}

const handler = new InteractionHandler();

describe('lib/plan-mode/interaction-handler', () => {
  it('createInteractionHandler returns an InteractionHandler', () => {
    const h = createInteractionHandler();
    expect(h).toBeInstanceOf(InteractionHandler);
  });

  it('createInteraction yields { id, type:"question", questions }', () => {
    const interaction = handler.createInteraction({
      questions: [
        {
          header: 'Topic',
          question: 'Pick one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          multiSelect: false,
        },
      ],
    });
    expect(interaction.id).toBeTruthy();
    expect(interaction.type).toBe('question');
    expect(interaction.questions.length).toBe(1);
  });

  it('createInteractionTurn produces an assistant PlanTurn with the interaction attached', () => {
    const interaction = handler.createInteraction({ questions: [] });
    const turn = handler.createInteractionTurn('Why?', interaction);
    expect(turn.role).toBe('assistant');
    expect(turn.content).toBe('Why?');
    expect(turn.interaction?.id).toBe(interaction.id);
  });

  it('findPendingInteraction returns the most recent unanswered assistant interaction', () => {
    const interaction: UserInteraction = {
      id: 'int-1',
      type: 'question',
      questions: [],
    };
    const session = buildSession([
      { id: 't1', role: 'user', content: 'hi', timestamp: '' },
      { id: 't2', role: 'assistant', content: 'q', interaction, timestamp: '' },
    ]);
    expect(handler.findPendingInteraction(session)).toEqual(interaction);
  });

  it('findPendingInteraction returns null when the most recent interaction is already answered', () => {
    const answered: UserInteraction = {
      id: 'int-2',
      type: 'question',
      questions: [],
      answers: { Topic: 'A' },
      answeredAt: new Date().toISOString(),
    };
    const session = buildSession([
      { id: 't1', role: 'assistant', content: 'q', interaction: answered, timestamp: '' },
    ]);
    expect(handler.findPendingInteraction(session)).toBeNull();
  });

  it('findPendingInteraction returns null when no interactions exist', () => {
    const session = buildSession([{ id: 't1', role: 'user', content: 'hi', timestamp: '' }]);
    expect(handler.findPendingInteraction(session)).toBeNull();
  });

  it('answerInteraction returns INTERACTION_NOT_FOUND when id is missing', () => {
    const session = buildSession([]);
    const r = handler.answerInteraction(session, 'no-such-id', { Topic: 'A' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PLAN_INTERACTION_NOT_FOUND');
  });

  it('answerInteraction returns INTERACTION_ALREADY_ANSWERED when answered', () => {
    const interaction: UserInteraction = {
      id: 'int-already',
      type: 'question',
      questions: [
        {
          header: 'Q',
          question: 'q?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
      answers: { Q: 'A' },
      answeredAt: new Date().toISOString(),
    };
    const session = buildSession([
      { id: 't1', role: 'assistant', content: 'q', interaction, timestamp: '' },
    ]);
    const r = handler.answerInteraction(session, 'int-already', { Q: 'A' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error.code).toBe('PLAN_INTERACTION_ALREADY_ANSWERED');
  });

  it('answerInteraction success: appends user response turn and resumes session', () => {
    const interaction: UserInteraction = {
      id: 'int-3',
      type: 'question',
      questions: [
        {
          header: 'Topic',
          question: 'Pick one',
          options: [
            { label: 'A', description: '' },
            { label: 'B', description: '' },
          ],
          multiSelect: false,
        },
      ],
    };
    const session = buildSession([
      { id: 't1', role: 'assistant', content: 'q', interaction, timestamp: '' },
    ]);
    const r = handler.answerInteraction(session, 'int-3', { Topic: 'A' });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const { updatedSession, responseTurn } = r.value;
    expect(updatedSession.status).toBe('active');
    expect(updatedSession.turns.length).toBe(2);
    expect(responseTurn.role).toBe('user');
    expect(responseTurn.content).toContain('**Topic**');
    expect(responseTurn.content).toContain('A');
  });

  it('validateAnswers: empty answers are allowed (lenient validation)', () => {
    const interaction: UserInteraction = {
      id: 'int-v',
      type: 'question',
      questions: [
        {
          header: 'Q1',
          question: 'q?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
    };
    const r = handler.validateAnswers(interaction, {});
    expect(r.ok).toBe(true);
  });

  it('validateAnswers: matches option label is ok', () => {
    const interaction: UserInteraction = {
      id: 'int-v2',
      type: 'question',
      questions: [
        {
          header: 'Q1',
          question: 'q?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
    };
    const r = handler.validateAnswers(interaction, { Q1: 'A' });
    expect(r.ok).toBe(true);
  });

  it('validateAnswers: free-form / Other: prefix accepted', () => {
    const interaction: UserInteraction = {
      id: 'int-v3',
      type: 'question',
      questions: [
        {
          header: 'Q1',
          question: 'q?',
          options: [{ label: 'A', description: '' }],
          multiSelect: false,
        },
      ],
    };
    const r1 = handler.validateAnswers(interaction, { Q1: 'Other: my answer' });
    expect(r1.ok).toBe(true);
    // Free-form unmatched answer is also accepted (logged but not rejected)
    const r2 = handler.validateAnswers(interaction, { Q1: 'totally novel response' });
    expect(r2.ok).toBe(true);
  });
});
