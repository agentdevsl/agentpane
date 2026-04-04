export type TopologyAgentRole =
  | 'orchestrator'
  | 'planner'
  | 'coder'
  | 'reviewer'
  | 'tester'
  | 'scanner'
  | 'deployer';

export type TopologyAgentStatus =
  | 'queued'
  | 'running'
  | 'verifying'
  | 'completed'
  | 'blocked'
  | 'failed'
  | 'stopped';

export type TopologyDecisionType =
  | 'auto_verify'
  | 'route'
  | 'retry'
  | 'escalate'
  | 'spawn'
  | 'tool_select'
  | 'delegate'
  | 'throttle'
  | 'prioritize';

export interface TopologyDecision {
  id: string;
  agentId: string;
  type: TopologyDecisionType;
  summary: string;
  confidence: number; // 0-1
  timestamp: number;
  alternatives?: string[];
}

export interface TopologyNode {
  id: string;
  name: string;
  role: TopologyAgentRole;
  /** Real SDK agent type (subagent_type / task_type) — e.g. "general-purpose", "Explore", "Plan" */
  agentType: string | null;
  status: TopologyAgentStatus;
  parentId: string | null;
  childIds: string[];
  progress: number; // 0-100
  tokens: number;
  cost: number;
  turns: number;
  messages: number;
  startedAt: number | null;
  completedAt: number | null;
  verified: boolean;
  verificationScore: number; // 0-100
  decisions: TopologyDecision[];
}

export interface TopologyEdge {
  id: string;
  sourceId: string;
  targetId: string;
}

export interface TopologyGraph {
  nodes: TopologyNode[];
  edges: TopologyEdge[];
  taskId: string;
  taskName: string;
  taskPriority: string;
  /** Skill associated with the task (from task.skillId) */
  skillId: string | null;
  /** Skill display name (from task.skillName) */
  skillName: string | null;
}
