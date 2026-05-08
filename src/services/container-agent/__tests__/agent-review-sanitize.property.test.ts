/** biome-ignore-all lint/nursery/noFloatingPromises: fc.assert is synchronous for these properties. */
import * as fc from 'fast-check';
import { describe, expect, it } from 'vitest';
import { sanitizeForPrompt } from '../agent-review.service';

const closingTag = /<\/(plan|task_title|task_description)>/i;
const openingTag = /<(plan|task_title|task_description)>/i;

describe('AgentReviewService sanitizeForPrompt', () => {
  it('never leaves review prompt boundary tags intact', () => {
    fc.assert(
      fc.property(fc.string(), (input) => {
        const sanitized = sanitizeForPrompt(input, 10_000);

        expect(sanitized).not.toMatch(closingTag);
        expect(sanitized).not.toMatch(openingTag);
      })
    );
  });

  it('always clamps sanitized content to the requested maximum length', () => {
    fc.assert(
      fc.property(fc.string(), fc.integer({ min: 0, max: 1_000 }), (input, maxChars) => {
        expect(sanitizeForPrompt(input, maxChars).length).toBeLessThanOrEqual(maxChars);
      })
    );
  });
});
