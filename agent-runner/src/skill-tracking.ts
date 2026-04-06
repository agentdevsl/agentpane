/**
 * Shared skill-tracking utilities for planning and execution phases.
 *
 * Extracts duplicated tracking state and helper functions used by both
 * runPlanningPhase() and runExecutionPhase() in index.ts.
 */

import type { SkillCallRecord } from './event-emitter.js';

/** Mutable tracking state for skill calls, file changes, and token usage. */
export interface SkillTrackingState {
  /** Active tools currently being tracked, keyed by toolUseID */
  activeTools: Map<string, { toolName: string; startTime: number; skillName?: string }>;
  /** Accumulated Skill tool call records */
  skillCalls: SkillCallRecord[];
  /** Unique file paths modified by Write/Edit/NotebookEdit */
  fileChangeSet: Set<string>;
  /** Total lines added across all file changes */
  totalLinesAdded: number;
  /** Total lines removed across all file changes */
  totalLinesRemoved: number;
  /** Total input tokens accumulated from assistant messages */
  totalInputTokens: number;
  /** Total output tokens accumulated from assistant messages */
  totalOutputTokens: number;
}

/** Create a fresh tracking state for a new phase. */
export function createTrackingState(): SkillTrackingState {
  return {
    activeTools: new Map(),
    skillCalls: [],
    fileChangeSet: new Set(),
    totalLinesAdded: 0,
    totalLinesRemoved: 0,
    totalInputTokens: 0,
    totalOutputTokens: 0,
  };
}

/**
 * Build enriched fields for complete/error events from the current tracking state.
 * Returns only non-empty fields to avoid polluting the event payload.
 */
export function buildEnrichedFields(
  state: SkillTrackingState,
  config: { skillId?: string; skillName?: string }
): Record<string, unknown> {
  return {
    ...(config.skillId ? { skillId: config.skillId } : {}),
    ...(config.skillName ? { skillName: config.skillName } : {}),
    ...(state.totalInputTokens > 0 || state.totalOutputTokens > 0
      ? { usage: { inputTokens: state.totalInputTokens, outputTokens: state.totalOutputTokens } }
      : {}),
    ...(state.fileChangeSet.size > 0
      ? {
          fileChanges: {
            filesModified: state.fileChangeSet.size,
            linesAdded: state.totalLinesAdded,
            linesRemoved: state.totalLinesRemoved,
          },
        }
      : {}),
  };
}

/** Return skillCalls array only if non-empty, undefined otherwise. */
export function optionalSkillCalls(calls: SkillCallRecord[]): SkillCallRecord[] | undefined {
  return calls.length > 0 ? calls : undefined;
}
