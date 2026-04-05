import type { TopologyAgentStatus, TopologyDecisionType } from '@/lib/topology/types';

export const AGENT_ROLE_CONFIG: Record<string, { icon: string; color: string; label: string }> = {
  orchestrator: { icon: '\u25C6', color: '#FFD866', label: 'Orchestrator' },
  planner: { icon: '\u25CF', color: '#A78BFA', label: 'Planner' },
  coder: { icon: '\u25CD', color: '#67E8F9', label: 'Coder' },
  reviewer: { icon: '\u2605', color: '#C084FC', label: 'Reviewer' },
  tester: { icon: '\u25A3', color: '#FCA572', label: 'Tester' },
  scanner: { icon: '\u25B3', color: '#F87171', label: 'Scanner' },
  deployer: { icon: '\u25B6', color: '#34D399', label: 'Deployer' },
  agent: { icon: '\u25CF', color: '#94A3B8', label: 'Agent' },
};

const DEFAULT_ROLE_CONFIG = { icon: '\u25CF', color: '#94A3B8', label: 'Agent' } as const;

export function getRoleConfig(role: string): { icon: string; color: string; label: string } {
  return AGENT_ROLE_CONFIG[role] ?? DEFAULT_ROLE_CONFIG;
}

export const STATUS_COLORS: Record<TopologyAgentStatus, string> = {
  completed: '#A78BFA',
  running: '#34D399',
  verifying: '#FFD866',
  blocked: '#FCA572',
  failed: '#F87171',
  stopped: '#94A3B8',
  queued: '#475569',
};

export const DECISION_TYPE_CONFIG: Record<
  TopologyDecisionType,
  { icon: string; color: string; label: string }
> = {
  auto_verify: { icon: '\u26A1', color: '#34D399', label: 'Auto Verify' },
  route: { icon: '\u2461', color: '#67E8F9', label: 'Route' },
  retry: { icon: '\u21BB', color: '#FCA572', label: 'Retry' },
  escalate: { icon: '\u25B2', color: '#F87171', label: 'Escalate' },
  spawn: { icon: '\u25C7', color: '#A78BFA', label: 'Spawn' },
  tool_select: { icon: '\u2699', color: '#FFD866', label: 'Tool Select' },
  delegate: { icon: '\u2192', color: '#67E8F9', label: 'Delegate' },
  throttle: { icon: '\u25D1', color: '#FCA572', label: 'Throttle' },
  prioritize: { icon: '\u2605', color: '#FFD866', label: 'Prioritize' },
};
