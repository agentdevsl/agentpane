import { createId } from '@paralleldrive/cuid2';
import type { Agent, AgentConfig, NewAgent } from '../../src/db/schema';
import { agents } from '../../src/db/schema';
import { getTestDb } from '../helpers/database';

type AgentStatus = 'idle' | 'starting' | 'planning' | 'running' | 'paused' | 'error' | 'completed';
type AgentType = 'task' | 'conversational' | 'background';

export type AgentFactoryOptions = Partial<Omit<NewAgent, 'projectId'>> & {
  projectId?: string;
  status?: AgentStatus;
  type?: AgentType;
  config?: Partial<AgentConfig>;
  currentTaskId?: string | null;
  currentSessionId?: string | null;
};

const DEFAULT_AGENT_CONFIG: AgentConfig = {
  allowedTools: ['Read', 'Write', 'Edit', 'Bash', 'Glob', 'Grep'],
  maxTurns: 50,
};

export function buildAgent(projectId: string, options: AgentFactoryOptions = {}): NewAgent {
  const id = options.id ?? createId();

  return {
    id,
    projectId,
    name: options.name ?? `Test Agent ${id.slice(0, 6)}`,
    type: options.type ?? 'task',
    status: options.status ?? 'idle',
    config: {
      ...DEFAULT_AGENT_CONFIG,
      ...options.config,
    },
    currentTaskId: options.currentTaskId ?? null,
    currentSessionId: options.currentSessionId ?? null,
    currentTurn: options.currentTurn ?? 0,
  };
}

export async function createTestAgent(
  projectId: string,
  options: AgentFactoryOptions = {}
): Promise<Agent> {
  const db = getTestDb();
  const data = buildAgent(projectId, options);

  const [agent] = await db.insert(agents).values(data).returning();

  if (!agent) {
    throw new Error('Failed to create test agent');
  }

  return agent;
}

export async function createTestAgents(
  projectId: string,
  count: number,
  options: AgentFactoryOptions = {}
): Promise<Agent[]> {
  const createdAgents: Agent[] = [];

  for (let i = 0; i < count; i++) {
    const agent = await createTestAgent(projectId, {
      ...options,
      name: options.name ?? `Test Agent ${i + 1}`,
    });
    createdAgents.push(agent);
  }

  return createdAgents;
}

export async function createRunningAgent(
  projectId: string,
  taskId: string,
  sessionId: string,
  options: AgentFactoryOptions = {}
): Promise<Agent> {
  return createTestAgent(projectId, {
    ...options,
    status: 'running',
    currentTaskId: taskId,
    currentSessionId: sessionId,
    currentTurn: options.currentTurn ?? 1,
  });
}
