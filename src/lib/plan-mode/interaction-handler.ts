import { createId } from '@paralleldrive/cuid2';
import type { PlanModeError } from '../errors/plan-mode-errors.js';
import { PlanModeErrors } from '../errors/plan-mode-errors.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { PlanSession, PlanTurn, UserInteraction } from './types.js';

/**
 * Handler for user interactions during plan mode.
 *
 * Processes the AskUserQuestion tool responses from Claude and manages the
 * question/answer flow. When Claude needs clarification, it calls the
 * AskUserQuestion tool and this handler formats the questions for the UI
 * and processes user responses back into the conversation.
 */
export class InteractionHandler {
  /**
   * Create a new interaction from tool call input
   */
  createInteraction(input: {
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>;
  }): UserInteraction {
    return {
      id: createId(),
      type: 'question',
      questions: input.questions,
    };
  }

  /**
   * Create an assistant turn with an interaction
   */
  createInteractionTurn(content: string, interaction: UserInteraction): PlanTurn {
    return {
      id: createId(),
      role: 'assistant',
      content,
      interaction,
      timestamp: new Date().toISOString(),
    };
  }

  /**
   * Find the pending interaction in a session
   */
  findPendingInteraction(session: PlanSession): UserInteraction | null {
    // Look for the most recent assistant turn with an unanswered interaction
    for (let i = session.turns.length - 1; i >= 0; i--) {
      const turn = session.turns[i];
      if (turn && turn.role === 'assistant' && turn.interaction && !turn.interaction.answers) {
        return turn.interaction;
      }
    }
    return null;
  }

  /**
   * Answer an interaction and create the response turn
   */
  answerInteraction(
    session: PlanSession,
    interactionId: string,
    answers: Record<string, string>
  ): Result<{ updatedSession: PlanSession; responseTurn: PlanTurn }, PlanModeError> {
    // Find the turn with this interaction
    const turnIndex = session.turns.findIndex((t) => t.interaction?.id === interactionId);

    if (turnIndex === -1) {
      return err(PlanModeErrors.INTERACTION_NOT_FOUND(interactionId));
    }

    const turn = session.turns[turnIndex];
    if (!turn || !turn.interaction) {
      return err(PlanModeErrors.INTERACTION_NOT_FOUND(interactionId));
    }

    if (turn.interaction.answers) {
      return err(PlanModeErrors.INTERACTION_ALREADY_ANSWERED(interactionId));
    }

    // Update the interaction with answers
    const updatedInteraction: UserInteraction = {
      ...turn.interaction,
      answers,
      answeredAt: new Date().toISOString(),
    };

    const updatedTurn: PlanTurn = {
      ...turn,
      interaction: updatedInteraction,
    };

    // Create the user response turn
    const responseTurn: PlanTurn = {
      id: createId(),
      role: 'user',
      content: this.formatAnswersAsContent(turn.interaction.questions, answers),
      interaction: updatedInteraction,
      timestamp: new Date().toISOString(),
    };

    // Update session turns
    const updatedTurns = [...session.turns];
    updatedTurns[turnIndex] = updatedTurn;
    updatedTurns.push(responseTurn);

    const updatedSession: PlanSession = {
      ...session,
      turns: updatedTurns,
      status: 'active', // Resume from waiting_user
    };

    return ok({ updatedSession, responseTurn });
  }

  /**
   * Format answers into readable content
   */
  private formatAnswersAsContent(
    questions: Array<{
      question: string;
      header: string;
      options: Array<{ label: string; description: string }>;
      multiSelect: boolean;
    }>,
    answers: Record<string, string>
  ): string {
    const parts: string[] = [];

    for (const q of questions) {
      const answer = answers[q.header] || answers[q.question];
      if (answer) {
        parts.push(`**${q.header}**: ${answer}`);
      }
    }

    return parts.join('\n\n');
  }

  /**
   * Validate that answers match the questions
   *
   * Note: This performs lenient validation - answers are allowed to be:
   * - One of the predefined option labels
   * - A custom answer prefixed with "Other:"
   * - Empty (for optional questions)
   *
   * Invalid answers are logged but not rejected to allow flexibility.
   */
  validateAnswers(
    interaction: UserInteraction,
    answers: Record<string, string>
  ): Result<void, PlanModeError> {
    for (const question of interaction.questions) {
      const answer = answers[question.header] || answers[question.question];
      if (!answer) {
        // Allow empty answers for optional questions
        continue;
      }

      // Validate that answer is one of the options (or custom "Other")
      const validOptions = question.options.map((o) => o.label);
      if (!validOptions.includes(answer) && !answer.startsWith('Other:')) {
        // Answer doesn't match known options — accept it as free-form input
      }
    }

    return ok(undefined);
  }
}

/**
 * Create default interaction handler
 */
export function createInteractionHandler(): InteractionHandler {
  return new InteractionHandler();
}
