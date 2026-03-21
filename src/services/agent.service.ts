/**
 * AgentService - Facade composing CRUD, Execution, and Queue services.
 *
 * This class maintains backward compatibility with existing code while
 * delegating to focused service implementations:
 * - AgentCrudService: CRUD operations
 * - AgentExecutionService: Agent lifecycle and execution
 * - AgentQueueService: Queue management
 *
 * For new code, consider importing the focused services directly from
 * './agent/index.js' for clearer dependency management.
 */

import type { AgentConfig, NewAgent } from '../db/schema';
import type { AgentError } from '../lib/errors/agent-errors.js';
import type { ConcurrencyError } from '../lib/errors/concurrency-errors.js';
import type { ValidationError } from '../lib/errors/validation-errors.js';
import type { Result } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import { AgentCrudService } from './agent/agent-crud.service.js';
import { AgentExecutionService } from './agent/agent-execution.service.js';
import { AgentQueueService } from './agent/agent-queue.service.js';
import type {
  Agent,
  AgentRunResult,
  AgentStartResult,
  QueuePosition,
  QueueStats,
  SessionServiceInterface,
  TaskService,
  WorktreeService,
} from './agent/types.js';

// Re-export types for backward compatibility
export type {
  AgentExecutionContext,
  AgentRunResult,
  QueuePosition,
  QueueStats,
} from './agent/types.js';

/**
 * AgentService facade - maintains backward compatibility while delegating to focused services.
 *
 * This class provides the same public API as the original AgentService,
 * ensuring existing code continues to work without modification.
 */
export class AgentService {
  private readonly crudService: AgentCrudService;
  private readonly executionService: AgentExecutionService;
  private readonly queueService: AgentQueueService;

  constructor(
    db: Database,
    worktreeService: WorktreeService,
    taskService: TaskService,
    sessionService: SessionServiceInterface
  ) {
    this.crudService = new AgentCrudService(db);
    this.executionService = new AgentExecutionService(
      db,
      worktreeService,
      taskService,
      sessionService
    );
    this.queueService = new AgentQueueService(db);

    // Wire queue service into execution service for auto-dequeue on completion
    this.executionService.setQueueService(this.queueService);
  }

  // =========================================================================
  // CRUD Operations (delegated to AgentCrudService)
  // =========================================================================

  /**
   * Create a new agent with configuration defaults from the codespace.
   */
  async create(input: NewAgent): Promise<Result<Agent, ValidationError>> {
    return this.crudService.create(input);
  }

  /**
   * Get an agent by ID.
   */
  async getById(id: string): Promise<Result<Agent, AgentError>> {
    return this.crudService.getById(id);
  }

  /**
   * List agents for a specific codespace, ordered by most recently updated.
   */
  async list(codespaceId: string): Promise<Result<Agent[], never>> {
    return this.crudService.list(codespaceId);
  }

  /**
   * List all agents across all projects, ordered by most recently updated.
   */
  async listAll(): Promise<Result<Agent[], never>> {
    return this.crudService.listAll();
  }

  /**
   * Get the count of all running agents across all projects.
   */
  async getRunningCountAll(): Promise<Result<number, never>> {
    return this.crudService.getRunningCountAll();
  }

  /**
   * Update an agent's configuration.
   * Prevents updating critical config (allowedTools, model) while agent is running.
   */
  async update(
    id: string,
    input: Partial<AgentConfig>
  ): Promise<Result<Agent, AgentError | ValidationError>> {
    return this.crudService.update(id, input);
  }

  /**
   * Delete an agent by ID.
   */
  async delete(id: string): Promise<Result<void, AgentError>> {
    return this.crudService.delete(id);
  }

  // =========================================================================
  // Execution Operations (delegated to AgentExecutionService)
  // =========================================================================

  /**
   * Start an agent with an optional specific task.
   * If no task is specified, picks the next available task from the backlog.
   */
  async start(
    agentId: string,
    taskId?: string
  ): Promise<Result<AgentStartResult, AgentError | ConcurrencyError>> {
    return this.executionService.start(agentId, taskId);
  }

  /**
   * Stop a running agent by aborting its execution.
   */
  async stop(agentId: string): Promise<Result<void, AgentError>> {
    return this.executionService.stop(agentId);
  }

  /**
   * Pause a running agent.
   */
  async pause(agentId: string): Promise<Result<void, AgentError>> {
    return this.executionService.pause(agentId);
  }

  /**
   * Resume a paused agent with optional feedback.
   */
  async resume(agentId: string, feedback?: string): Promise<Result<AgentRunResult, AgentError>> {
    return this.executionService.resume(agentId, feedback);
  }

  /**
   * Check if a codespace has availability for a new running agent.
   */
  async checkAvailability(codespaceId: string): Promise<Result<boolean, never>> {
    return this.executionService.checkAvailability(codespaceId);
  }

  /**
   * Get the count of running agents for a specific codespace.
   */
  async getRunningCount(codespaceId: string): Promise<Result<number, never>> {
    return this.executionService.getRunningCount(codespaceId);
  }

  // =========================================================================
  // Queue Operations (delegated to AgentQueueService)
  // =========================================================================

  /**
   * Queue a task for execution when agent availability permits.
   */
  async queueTask(
    codespaceId: string,
    taskId: string
  ): Promise<Result<QueuePosition, ConcurrencyError>> {
    return this.queueService.queueTask(codespaceId, taskId);
  }

  /**
   * Get the queue position for an agent.
   */
  async getQueuePosition(agentId: string): Promise<Result<QueuePosition | null, AgentError>> {
    return this.queueService.getQueuePosition(agentId);
  }

  /**
   * Get queue statistics for a codespace or globally.
   */
  async getQueueStats(codespaceId?: string): Promise<Result<QueueStats, never>> {
    return this.queueService.getQueueStats(codespaceId);
  }

  /**
   * Get all queued tasks for a codespace or globally.
   */
  async getQueuedTasks(codespaceId?: string): Promise<Result<QueuePosition[], never>> {
    return this.queueService.getQueuedTasks(codespaceId);
  }
}
