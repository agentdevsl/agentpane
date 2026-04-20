import { describe, expect, it } from 'vitest';
import { deriveAgentName, extractSkillNamespace, mapAgentRole } from '../map-agent-role.js';

describe('mapAgentRole', () => {
  it('maps planner from agentType containing "plan"', () => {
    expect(mapAgentRole('Plan')).toBe('planner');
    expect(mapAgentRole('speckit.plan')).toBe('planner');
  });

  it('maps reviewer from agentType containing "review"', () => {
    expect(mapAgentRole('pr-review-toolkit:code-reviewer')).toBe('reviewer');
  });

  it('maps reviewer from agentType containing "analyz"', () => {
    expect(mapAgentRole('speckit.analyze')).toBe('reviewer');
    expect(mapAgentRole('pr-review-toolkit:type-design-analyzer')).toBe('reviewer');
  });

  it('maps tester from agentType containing "test"', () => {
    expect(mapAgentRole('pr-review-toolkit:pr-test-analyzer')).toBe('tester');
  });

  it('maps tester from agentType containing "verif"', () => {
    expect(mapAgentRole('agent-sdk-dev:agent-sdk-verifier-ts')).toBe('tester');
  });

  it('maps scanner from agentType containing "security"', () => {
    expect(mapAgentRole('aws-security-advisor')).toBe('scanner');
  });

  it('maps scanner from agentType containing "hunter"', () => {
    expect(mapAgentRole('pr-review-toolkit:silent-failure-hunter')).toBe('scanner');
  });

  it('maps deployer from agentType containing "deploy"', () => {
    expect(mapAgentRole('report-tf-deployment')).toBe('deployer');
  });

  it('maps explore to coder', () => {
    expect(mapAgentRole('Explore')).toBe('agent');
  });

  it('defaults to coder for general-purpose', () => {
    expect(mapAgentRole('general-purpose')).toBe('agent');
  });

  it('defaults to coder with no arguments', () => {
    expect(mapAgentRole()).toBe('agent');
  });

  it('defaults to coder with undefined', () => {
    expect(mapAgentRole(undefined)).toBe('agent');
  });

  it('is case insensitive', () => {
    expect(mapAgentRole('PLAN')).toBe('planner');
    expect(mapAgentRole('Review')).toBe('reviewer');
  });
});

describe('extractSkillNamespace', () => {
  it('extracts prefix from colon-separated types', () => {
    expect(extractSkillNamespace('pr-review-toolkit:code-reviewer')).toBe('pr-review-toolkit');
  });

  it('extracts prefix from dot-separated types', () => {
    expect(extractSkillNamespace('speckit.plan')).toBe('speckit');
  });

  it('returns null for bare SDK built-ins', () => {
    expect(extractSkillNamespace('Explore')).toBeNull();
    expect(extractSkillNamespace('Plan')).toBeNull();
    expect(extractSkillNamespace('general-purpose')).toBeNull();
  });

  it('prefers colon over dot when both present', () => {
    expect(extractSkillNamespace('toolkit:agent.sub')).toBe('toolkit');
  });

  it('handles single character prefix', () => {
    expect(extractSkillNamespace('a:runner')).toBe('a');
  });

  it('returns null for colon at position 0', () => {
    expect(extractSkillNamespace(':runner')).toBeNull();
  });

  it('returns null for dot at position 0', () => {
    expect(extractSkillNamespace('.plan')).toBeNull();
  });
});

describe('deriveAgentName', () => {
  it('prefers description over agentType', () => {
    expect(deriveAgentName('general-purpose', 'Review auth module')).toBe('Review auth module');
  });

  it('returns agentType directly when no description', () => {
    expect(deriveAgentName('general-purpose')).toBe('general-purpose');
  });

  it('does not truncate description at exactly 50 chars', () => {
    const desc50 = 'a'.repeat(50);
    expect(deriveAgentName(undefined, desc50)).toBe(desc50);
  });

  it('truncates description longer than 50 chars', () => {
    const desc51 = 'a'.repeat(51);
    expect(deriveAgentName(undefined, desc51)).toBe(`${'a'.repeat(47)}...`);
  });

  it('returns Agent when both undefined', () => {
    expect(deriveAgentName()).toBe('Agent');
  });

  it('returns Agent when both empty strings', () => {
    expect(deriveAgentName('', '')).toBe('Agent');
  });
});
