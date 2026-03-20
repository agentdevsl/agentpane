import { createId } from '@paralleldrive/cuid2';
import { and, desc, eq, like, or } from 'drizzle-orm';
import { createLogger } from '../lib/logging/logger.js';

const log = createLogger('TerraformRegistryService');

import type {
  NewTerraformRegistry,
  TerraformModule,
  TerraformOutput,
  TerraformRegistry,
  TerraformVariable,
} from '../db/schema';
import { settings, terraformModules, terraformRegistries } from '../db/schema';
import { decryptToken, encryptToken } from '../lib/crypto/server-encryption.js';
import type { TerraformError } from '../lib/errors/terraform-errors.js';
import { TerraformErrors } from '../lib/errors/terraform-errors.js';
import { type RegistryConfig, syncAllModules } from '../lib/terraform/registry-client.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

export interface CreateRegistryInput {
  name: string;
  orgName: string;
  apiToken: string;
  syncIntervalMinutes?: number | null;
}

export interface UpdateRegistryInput {
  name?: string;
  orgName?: string;
  apiToken?: string;
  syncIntervalMinutes?: number | null;
}

export interface ListModulesOptions {
  search?: string;
  provider?: string;
  registryId?: string;
  limit?: number;
  offset?: number;
}

export interface SyncResult {
  registryId: string;
  moduleCount: number;
  syncedAt: string;
}

export class TerraformRegistryService {
  constructor(private db: Database) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  private getTokenSettingKey(registryId: string): string {
    return `terraform.registry.${registryId}.apiToken`;
  }

  private async saveEncryptedToken(
    key: string,
    apiToken: string,
    updatedAt: string
  ): Promise<void> {
    const encryptedToken = encryptToken(apiToken);
    await this.db
      .insert(settings)
      .values({
        key,
        value: encryptedToken,
        updatedAt,
      })
      .onConflictDoUpdate({
        target: settings.key,
        set: {
          value: encryptedToken,
          updatedAt,
        },
      });
  }

  /**
   * Create a new Terraform registry
   */
  async createRegistry(
    input: CreateRegistryInput
  ): Promise<Result<TerraformRegistry, TerraformError>> {
    log.info('Creating registry', { data: { name: input.name } });

    // Check for duplicate by orgName
    const existing = await this.db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.orgName, input.orgName),
    });

    if (existing) {
      return err(TerraformErrors.REGISTRY_ALREADY_EXISTS);
    }

    const now = this.updateTimestamp();
    const registryId = createId();
    const tokenSettingKey = this.getTokenSettingKey(registryId);
    await this.saveEncryptedToken(tokenSettingKey, input.apiToken, now);

    const [created] = await this.db
      .insert(terraformRegistries)
      .values({
        id: registryId,
        name: input.name,
        orgName: input.orgName,
        tokenSettingKey,
        status: 'active',
        syncIntervalMinutes: input.syncIntervalMinutes ?? null,
        nextSyncAt: input.syncIntervalMinutes
          ? new Date(Date.now() + input.syncIntervalMinutes * 60 * 1000).toISOString()
          : null,
        createdAt: now,
        updatedAt: now,
      } satisfies NewTerraformRegistry)
      .returning();

    if (!created) {
      await this.db.delete(settings).where(eq(settings.key, tokenSettingKey));
      log.error('Failed to create registry');
      return err(TerraformErrors.REGISTRY_CREATE_FAILED);
    }

    log.info('Created registry', { data: { id: created.id } });
    return ok(created);
  }

  /**
   * Get a registry by ID
   */
  async getRegistryById(id: string): Promise<Result<TerraformRegistry, TerraformError>> {
    const registry = await this.db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.id, id),
    });

    if (!registry) {
      return err(TerraformErrors.REGISTRY_NOT_FOUND);
    }

    return ok(registry);
  }

  /**
   * List all registries ordered by most recently updated
   */
  async listRegistries(): Promise<Result<TerraformRegistry[], TerraformError>> {
    const items = await this.db.query.terraformRegistries.findMany({
      orderBy: [desc(terraformRegistries.updatedAt)],
    });

    return ok(items);
  }

  /**
   * Update a registry
   */
  async updateRegistry(
    id: string,
    input: UpdateRegistryInput
  ): Promise<Result<TerraformRegistry, TerraformError>> {
    const now = this.updateTimestamp();
    const existing = await this.db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.id, id),
    });

    if (!existing) {
      return err(TerraformErrors.REGISTRY_NOT_FOUND);
    }

    const previousTokenSetting = await this.db.query.settings.findFirst({
      where: eq(settings.key, existing.tokenSettingKey),
    });

    if (input.apiToken !== undefined) {
      await this.saveEncryptedToken(existing.tokenSettingKey, input.apiToken, now);
    }

    const updates: Partial<TerraformRegistry> = {
      updatedAt: now,
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.orgName !== undefined) updates.orgName = input.orgName;
    if (input.syncIntervalMinutes !== undefined) {
      updates.syncIntervalMinutes = input.syncIntervalMinutes;
      updates.nextSyncAt = input.syncIntervalMinutes
        ? new Date(Date.now() + input.syncIntervalMinutes * 60 * 1000).toISOString()
        : null;
    }

    const [updated] = await this.db
      .update(terraformRegistries)
      .set(updates)
      .where(eq(terraformRegistries.id, id))
      .returning();

    if (!updated) {
      if (input.apiToken !== undefined) {
        if (previousTokenSetting) {
          await this.db
            .insert(settings)
            .values(previousTokenSetting)
            .onConflictDoUpdate({
              target: settings.key,
              set: {
                value: previousTokenSetting.value,
                updatedAt: previousTokenSetting.updatedAt,
              },
            });
        } else {
          await this.db.delete(settings).where(eq(settings.key, existing.tokenSettingKey));
        }
      }

      return err(TerraformErrors.REGISTRY_NOT_FOUND);
    }

    return ok(updated);
  }

  /**
   * Delete a registry and all its modules
   */
  async deleteRegistry(id: string): Promise<Result<void, TerraformError>> {
    log.info('Deleting registry', { data: { id } });

    const registry = await this.db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.id, id),
    });

    if (!registry) {
      log.error('Registry not found for deletion', { data: { id } });
      return err(TerraformErrors.REGISTRY_NOT_FOUND);
    }

    this.db.transaction((tx) => {
      tx.delete(terraformModules).where(eq(terraformModules.registryId, id)).run();
      tx.delete(terraformRegistries).where(eq(terraformRegistries.id, id)).run();
      tx.delete(settings).where(eq(settings.key, registry.tokenSettingKey)).run();
    });

    log.info('Deleted registry', { data: { id } });
    return ok(undefined);
  }

  /**
   * Sync modules from the Terraform registry API
   */
  async sync(id: string): Promise<Result<SyncResult, TerraformError>> {
    log.info('Starting sync for registry', { data: { id } });

    const registry = await this.db.query.terraformRegistries.findFirst({
      where: eq(terraformRegistries.id, id),
    });

    if (!registry) {
      log.error('Registry not found for sync', { data: { id } });
      return err(TerraformErrors.REGISTRY_NOT_FOUND);
    }

    // Look up the API token from the settings table
    const tokenSetting = await this.db.query.settings.findFirst({
      where: eq(settings.key, registry.tokenSettingKey),
    });

    if (!tokenSetting) {
      log.error('Token setting not found', { data: { tokenSettingKey: registry.tokenSettingKey } });
      await this.db
        .update(terraformRegistries)
        .set({
          status: 'error',
          syncError: 'API token not configured. Set the token in Settings.',
          updatedAt: this.updateTimestamp(),
        })
        .where(eq(terraformRegistries.id, id));
      return err(TerraformErrors.INVALID_TOKEN);
    }

    // Mark as syncing
    await this.db
      .update(terraformRegistries)
      .set({ status: 'syncing', updatedAt: this.updateTimestamp() })
      .where(eq(terraformRegistries.id, id));

    try {
      let token: string;
      try {
        token = decryptToken(tokenSetting.value);
      } catch (decryptError) {
        log.warn('Token decryption failed, trying JSON parse fallback', { error: decryptError });
        try {
          token = JSON.parse(tokenSetting.value) as string;
        } catch (_parseError) {
          log.warn('Token value is not JSON-encoded, using raw value');
          token = tokenSetting.value;
        }
      }

      if (!token || typeof token !== 'string' || token.trim().length === 0) {
        await this.db
          .update(terraformRegistries)
          .set({
            status: 'error',
            syncError: 'API token is empty or invalid. Update the token in Settings.',
            updatedAt: this.updateTimestamp(),
          })
          .where(eq(terraformRegistries.id, id));
        return err(TerraformErrors.INVALID_TOKEN);
      }

      const config: RegistryConfig = {
        baseUrl: 'https://app.terraform.io',
        orgName: registry.orgName,
        token,
      };

      const modules = await syncAllModules(config);

      if (modules.length === 0) {
        const now = this.updateTimestamp();
        await this.db
          .update(terraformRegistries)
          .set({
            status: 'active',
            lastSyncedAt: now,
            syncError: 'No modules with published versions found',
            moduleCount: 0,
            updatedAt: now,
          })
          .where(eq(terraformRegistries.id, id));
        return err(TerraformErrors.NO_MODULES_SYNCED);
      }

      // Replace all existing modules with fresh data
      await this.db.delete(terraformModules).where(eq(terraformModules.registryId, id));

      const now = this.updateTimestamp();
      // Batch insert all modules at once for performance
      await this.db.insert(terraformModules).values(
        modules.map((module) => ({
          ...module,
          registryId: id,
          createdAt: now,
          updatedAt: now,
        }))
      );

      // Update registry status (nextSyncAt is managed by the sync scheduler)
      await this.db
        .update(terraformRegistries)
        .set({
          status: 'active',
          lastSyncedAt: now,
          syncError: null,
          moduleCount: modules.length,
          updatedAt: now,
        })
        .where(eq(terraformRegistries.id, id));

      log.info(`Sync complete for ${id}: ${modules.length} modules`);

      return ok({
        registryId: id,
        moduleCount: modules.length,
        syncedAt: now,
      });
    } catch (error) {
      const errorMessage = error instanceof Error ? error.message : String(error);
      log.error(`Sync error for ${id}`, { data: { errorMessage } });

      const lowerMessage = errorMessage.toLowerCase();
      const containsCredentials =
        lowerMessage.includes('bearer') ||
        lowerMessage.includes('token') ||
        lowerMessage.includes('authorization') ||
        lowerMessage.includes('sk-');
      const safeMessage = containsCredentials
        ? 'Sync failed due to an API error. Check your token and try again.'
        : errorMessage;

      await this.db
        .update(terraformRegistries)
        .set({
          status: 'error',
          syncError: safeMessage,
          updatedAt: this.updateTimestamp(),
        })
        .where(eq(terraformRegistries.id, id));

      return err(TerraformErrors.SYNC_FAILED(safeMessage));
    }
  }

  /**
   * List modules with optional search, provider filter, and pagination
   */
  async listModules(
    options?: ListModulesOptions
  ): Promise<Result<TerraformModule[], TerraformError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const conditions = [];

    if (options?.registryId) {
      conditions.push(eq(terraformModules.registryId, options.registryId));
    }

    if (options?.provider) {
      conditions.push(eq(terraformModules.provider, options.provider));
    }

    if (options?.search) {
      const searchPattern = `%${options.search}%`;
      const searchCondition = or(
        like(terraformModules.name, searchPattern),
        like(terraformModules.description, searchPattern)
      );
      if (searchCondition) {
        conditions.push(searchCondition);
      }
    }

    const items = await this.db.query.terraformModules.findMany({
      where: conditions.length > 0 ? and(...conditions) : undefined,
      orderBy: [desc(terraformModules.updatedAt)],
      limit,
      offset,
    });

    return ok(items);
  }

  /**
   * Get a single module by ID
   */
  async getModuleById(id: string): Promise<Result<TerraformModule, TerraformError>> {
    const module = await this.db.query.terraformModules.findFirst({
      where: eq(terraformModules.id, id),
    });

    if (!module) {
      return err(TerraformErrors.MODULE_NOT_FOUND);
    }

    return ok(module);
  }

  /**
   * Get module context formatted as structured text for AI prompts.
   * Optionally filter to a specific registry.
   */
  async getModuleContext(registryId?: string): Promise<Result<string, TerraformError>> {
    const conditions = registryId ? eq(terraformModules.registryId, registryId) : undefined;

    const modules = await this.db.query.terraformModules.findMany({
      where: conditions,
      orderBy: [desc(terraformModules.updatedAt)],
    });

    if (modules.length === 0) {
      return ok('No Terraform modules available.');
    }

    const lines: string[] = [`# Available Terraform Modules (${modules.length})`, ''];

    for (const module of modules) {
      lines.push(`## ${module.namespace}/${module.name}/${module.provider} v${module.version}`);
      lines.push(`Source: ${module.source}`);
      lines.push(`Version: ${module.version}`);

      if (module.description) {
        lines.push(`Description: ${module.description}`);
      }

      const inputs = module.inputs as TerraformVariable[] | null;
      if (inputs && inputs.length > 0) {
        lines.push('');
        lines.push('### Inputs');
        for (const input of inputs) {
          const requiredTag = input.required ? ' (required)' : '';
          const sensitiveTag = input.sensitive ? ' [sensitive]' : '';
          const defaultTag =
            input.default !== undefined ? ` = ${JSON.stringify(input.default)}` : '';
          lines.push(
            `- **${input.name}** (${input.type})${requiredTag}${sensitiveTag}${defaultTag}${input.description ? `: ${input.description}` : ''}`
          );
        }
      }

      const outputs = module.outputs as TerraformOutput[] | null;
      if (outputs && outputs.length > 0) {
        lines.push('');
        lines.push('### Outputs');
        for (const output of outputs) {
          lines.push(`- **${output.name}**${output.description ? `: ${output.description}` : ''}`);
        }
      }

      const deps = module.dependencies as string[] | null;
      if (deps && deps.length > 0) {
        lines.push('');
        lines.push(`Dependencies: ${deps.join(', ')}`);
      }

      lines.push('');
      lines.push('---');
      lines.push('');
    }

    return ok(lines.join('\n'));
  }
}
