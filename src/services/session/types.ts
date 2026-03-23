/**
 * Shared types for session services
 */

export type SessionEventType =
  | 'chunk'
  | 'tool:start'
  | 'tool:result'
  | 'presence:joined'
  | 'presence:left'
  | 'presence:cursor'
  | 'presence:timeout'
  | 'terminal:input'
  | 'terminal:output'
  | 'approval:requested'
  | 'approval:approved'
  | 'approval:rejected' // AE-012: Deprecated, kept for backward compat with persisted events. Use 'agent:resumed' instead.
  | 'agent:resumed'
  | 'state:update'
  | 'agent:started'
  | 'agent:planning'
  | 'agent:plan_ready'
  | 'agent:turn'
  | 'agent:turn_limit'
  | 'agent:completed'
  | 'agent:error'
  | 'agent:warning'
  | 'agent:metrics'
  | 'agent:tool_progress'
  | 'agent:compacted'
  | 'agent:rate_limit'
  | 'agent:stopped'
  // Container agent event types
  | 'container-agent:started'
  | 'container-agent:token'
  | 'container-agent:turn'
  | 'container-agent:tool:start'
  | 'container-agent:tool:result'
  | 'container-agent:message'
  | 'container-agent:complete'
  | 'container-agent:error'
  | 'container-agent:cancelled'
  | 'container-agent:plan_ready'
  // Topology event types
  | 'topology:agent_spawned'
  | 'topology:agent_progress'
  | 'topology:agent_completed';

export type SessionEvent = {
  id: string;
  type: SessionEventType;
  timestamp: number;
  data: unknown;
};

export type CreateSessionInput = {
  codespaceId: string;
  taskId?: string;
  agentId?: string;
  title?: string;
};

export type ListSessionsOptions = {
  limit?: number;
  offset?: number;
  orderBy?: 'createdAt' | 'updatedAt';
  orderDirection?: 'asc' | 'desc';
};

export type PresenceUpdate = {
  cursor?: { x: number; y: number };
  activeFile?: string;
};

export type ActiveUser = {
  userId: string;
  lastSeen: number;
  cursor?: { x: number; y: number };
  activeFile?: string;
};

export type SubscribeOptions = {
  startTime?: number;
  includeHistory?: boolean;
};

export type HistoryOptions = {
  startTime?: number;
};

export type ListSessionsWithFiltersOptions = {
  status?: import('../../db/schema/index.js').SessionStatus[];
  agentId?: string;
  dateFrom?: string;
  dateTo?: string;
  search?: string;
  limit?: number;
  offset?: number;
};

export type GetEventsBySessionOptions = {
  limit?: number;
  offset?: number;
  afterEventId?: string;
};

export type SessionWithPresence = {
  id: string;
  codespaceId: string;
  taskId?: string | null;
  agentId?: string | null;
  title?: string | null;
  url: string;
  status: string;
  presence: ActiveUser[];
  createdAt?: string;
  updatedAt?: string;
  closedAt?: string | null;
  sandboxProvider?: string | null;
  sandboxContainerId?: string | null;
};

// Re-export DurableStreamsServer from the canonical location
export type { DurableStreamsServer } from '../durable-streams.service.js';

/**
 * Shared session service configuration
 */
export type SessionServiceConfig = {
  baseUrl: string;
};
