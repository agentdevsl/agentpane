import { and, count, desc, eq } from 'drizzle-orm';
import type { Agent, AgentConfig, NewAgent } from '../../db/schema';
import { agents, codespaces } from '../../db/schema';
import { ALLOW_ALL_TOOLS } from '../../lib/constants/tools.js';
import type { AgentError } from '../../lib/errors/agent-errors.js';
import { AgentErrors } from '../../lib/errors/agent-errors.js';
import type { ValidationError } from '../../lib/errors/validation-errors.js';
import { ValidationErrors } from '../../lib/errors/validation-errors.js';
import type { Result } from '../../lib/utils/result.js';
import { err, ok } from '../../lib/utils/result.js';
import type { Database } from '../../types/database.js';

/**
 * AgentCrudService handles CRUD operations for agents.
 *
 * Responsibilities:
 * - Create new agents with codespace config defaults
 * - Get agent by ID
 * - List agents by codespace or all
 * - Update agent configuration
 * - Delete agents
 * - Get running count for all agents
 */
export class AgentCrudService {
  constructor(private db: Database) {}

  /**
   * Create a new agent with configuration defaults from the codespace.
   */
  async create(input: NewAgent): Promise<Result<Agent, ValidationError>> {
    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, input.codespaceId),
    });

    if (!codespace) {
      return err(ValidationErrors.INVALID_ID('codespaceId'));
    }

    // F06-06: `[]` means "deny all tools" (fail-closed). When no explicit
    // config is set at either level, fall back to `ALLOW_ALL_TOOLS` (`['*']`)
    // to preserve the pre-F06-06 default of "no config = open access".
    const config: AgentConfig = {
      allowedTools: input.config?.allowedTools ?? codespace.config?.allowedTools ?? ALLOW_ALL_TOOLS,
      maxTurns: input.config?.maxTurns ?? codespace.config?.maxTurns ?? 50,
      model: input.config?.model ?? codespace.config?.model,
      systemPrompt: input.config?.systemPrompt ?? codespace.config?.systemPrompt,
      temperature: input.config?.temperature ?? codespace.config?.temperature,
    };

    const [agent] = await this.db
      .insert(agents)
      .values({
        ...input,
        config,
      })
      .returning();

    return ok(agent as Agent);
  }

  /**
   * Get an agent by ID.
   */
  async getById(id: string): Promise<Result<Agent, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    return ok(agent);
  }

  /**
   * List agents for a specific codespace, ordered by most recently updated.
   */
  async list(codespaceId: string): Promise<Result<Agent[], never>> {
    const items = await this.db.query.agents.findMany({
      where: eq(agents.codespaceId, codespaceId),
      orderBy: [desc(agents.updatedAt)],
    });

    return ok(items);
  }

  /**
   * List all agents across all projects, ordered by most recently updated.
   */
  async listAll(): Promise<Result<Agent[], never>> {
    const items = await this.db.query.agents.findMany({
      orderBy: [desc(agents.updatedAt)],
    });

    return ok(items);
  }

  /**
   * Get the count of all running agents across all projects.
   */
  async getRunningCountAll(): Promise<Result<number, never>> {
    const [result] = await this.db
      .select({ count: count() })
      .from(agents)
      .where(eq(agents.status, 'running'));
    return ok(result?.count ?? 0);
  }

  /**
   * Get the count of running agents for a specific codespace.
   */
  async getRunningCount(codespaceId: string): Promise<Result<number, never>> {
    const [result] = await this.db
      .select({ count: count() })
      .from(agents)
      .where(and(eq(agents.codespaceId, codespaceId), eq(agents.status, 'running')));
    return ok(result?.count ?? 0);
  }

  /**
   * Update an agent's configuration.
   * Prevents updating critical config (allowedTools, model) while agent is running.
   */
  async update(
    id: string,
    input: Partial<AgentConfig>
  ): Promise<Result<Agent, AgentError | ValidationError>> {
    const existing = await this.getById(id);
    if (!existing.ok) {
      return existing;
    }

    if (existing.value.status === 'running') {
      if (input.allowedTools || input.model) {
        return err(AgentErrors.ALREADY_RUNNING(existing.value.currentTaskId ?? undefined));
      }
    }

    const mergedConfig: AgentConfig = {
      // F06-06: see create() — fall back to ALLOW_ALL_TOOLS when no config set.
      allowedTools: input.allowedTools ?? existing.value.config?.allowedTools ?? ALLOW_ALL_TOOLS,
      maxTurns: input.maxTurns ?? existing.value.config?.maxTurns ?? 50,
      model: input.model ?? existing.value.config?.model,
      systemPrompt: input.systemPrompt ?? existing.value.config?.systemPrompt,
      temperature: input.temperature ?? existing.value.config?.temperature,
    };

    const [updated] = await this.db
      .update(agents)
      .set({ config: mergedConfig })
      .where(eq(agents.id, id))
      .returning();

    if (!updated) {
      return err(AgentErrors.NOT_FOUND);
    }

    return ok(updated);
  }

  /**
   * Delete an agent by ID.
   */
  async delete(id: string): Promise<Result<void, AgentError>> {
    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, id),
    });

    if (!agent) {
      return err(AgentErrors.NOT_FOUND);
    }

    await this.db.delete(agents).where(eq(agents.id, id));
    return ok(undefined);
  }
}
