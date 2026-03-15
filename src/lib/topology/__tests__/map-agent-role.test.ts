import { describe, expect, it } from 'vitest';
import { deriveAgentName, mapAgentRole } from '../map-agent-role.js';

describe('mapAgentRole', () => {
  it('maps deploy keywords before plan keywords', () => {
    expect(mapAgentRole(undefined, 'Execute deployment plan')).toBe('deployer');
  });

  it('maps planner from agentType', () => {
    expect(mapAgentRole('planner')).toBe('planner');
  });

  it('maps planner from description', () => {
    expect(mapAgentRole(undefined, 'Plan the implementation')).toBe('planner');
  });

  it('maps reviewer from code-review agentType', () => {
    expect(mapAgentRole('code-review')).toBe('reviewer');
  });

  it('maps reviewer from description', () => {
    expect(mapAgentRole(undefined, 'Review authentication module')).toBe('reviewer');
  });

  it('maps tester from pr-test', () => {
    expect(mapAgentRole('pr-test-analyzer')).toBe('tester');
  });

  it('maps tester from description', () => {
    expect(mapAgentRole(undefined, 'Run integration tests')).toBe('tester');
  });

  it('maps scanner from security keyword', () => {
    expect(mapAgentRole('security-advisor')).toBe('scanner');
  });

  it('maps scanner from silent-failure', () => {
    expect(mapAgentRole('silent-failure-hunter')).toBe('scanner');
  });

  it('maps scanner from scan keyword', () => {
    expect(mapAgentRole(undefined, 'Scan for vulnerabilities')).toBe('scanner');
  });

  it('maps deployer', () => {
    expect(mapAgentRole('deployer')).toBe('deployer');
  });

  it('maps orchestrator from orchestrate keyword', () => {
    expect(mapAgentRole(undefined, 'Orchestrate the team')).toBe('orchestrator');
  });

  it('maps orchestrator from lead keyword', () => {
    expect(mapAgentRole('team-lead')).toBe('orchestrator');
  });

  it('maps orchestrator from team keyword', () => {
    expect(mapAgentRole(undefined, 'Team coordinator task')).toBe('orchestrator');
  });

  it('maps orchestrator from coordinator keyword', () => {
    expect(mapAgentRole('coordinator')).toBe('orchestrator');
  });

  it('defaults to coder when no keyword matches', () => {
    expect(mapAgentRole('general-purpose')).toBe('coder');
  });

  it('defaults to coder with no arguments', () => {
    expect(mapAgentRole()).toBe('coder');
  });

  it('is case insensitive', () => {
    expect(mapAgentRole('PLANNER')).toBe('planner');
    expect(mapAgentRole(undefined, 'REVIEW code')).toBe('reviewer');
  });

  it('combines agentType and description for matching', () => {
    expect(mapAgentRole('general', 'review the code')).toBe('reviewer');
  });
});

describe('deriveAgentName', () => {
  it('prefers description over agentType', () => {
    expect(deriveAgentName('code-reviewer', 'Review auth module')).toBe('Review auth module');
  });

  it('converts kebab-case agentType to title case', () => {
    expect(deriveAgentName('code-reviewer')).toBe('Code Reviewer');
  });

  it('returns agentType title-cased for single word', () => {
    expect(deriveAgentName('planner')).toBe('Planner');
  });

  it('does not truncate description at exactly 40 chars', () => {
    const desc40 = 'a'.repeat(40);
    expect(deriveAgentName(undefined, desc40)).toBe(desc40);
  });

  it('truncates description longer than 40 chars', () => {
    const desc41 = 'a'.repeat(41);
    expect(deriveAgentName(undefined, desc41)).toBe(`${'a'.repeat(37)}...`);
  });

  it('returns Agent when both undefined', () => {
    expect(deriveAgentName()).toBe('Agent');
  });

  it('returns Agent when both empty strings', () => {
    expect(deriveAgentName('', '')).toBe('Agent');
  });
});
