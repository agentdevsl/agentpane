import { and, count, desc, eq, ne } from 'drizzle-orm';
import type { NewSandboxConfig, SandboxConfig, SandboxType } from '../db/schema';
import { codespaces, sandboxConfigs } from '../db/schema';
import { decryptToken, encryptToken } from '../lib/crypto/server-encryption.js';
import type { SandboxConfigError } from '../lib/errors/sandbox-config-errors.js';
import { SandboxConfigErrors } from '../lib/errors/sandbox-config-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import { isDigestPinnedImage, SANDBOX_DEFAULTS } from '../lib/sandbox/types.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';

/**
 * Per-tenant sandbox quota enforced by {@link SandboxConfigService.assertQuota}.
 *
 * theme-04 P1-07: enforced before a sandbox is created. A config whose resource
 * limits exceed the supplied tenant ceiling is rejected with
 * `SANDBOX_QUOTA_EXCEEDED`.
 */
export interface SandboxQuota {
  /** Maximum concurrent sandboxes the tenant may run. */
  maxSandboxes: number;
  /** Maximum CPU cores per sandbox. */
  maxCpuCores: number;
  /** Maximum memory (MB) per sandbox. */
  maxMemoryMb: number;
}

/**
 * Arguments to {@link SandboxConfigService.assertQuota}.
 */
export interface QuotaCheckArgs {
  /** Active sandbox count for this tenant (at the moment of the check). */
  activeSandboxes: number;
  /** Sandbox config being validated. */
  memoryMb: number;
  cpuCores: number;
}

export type CreateSandboxConfigInput = {
  name: string;
  description?: string;
  type?: SandboxType;
  isDefault?: boolean;
  baseImage?: string;
  memoryMb?: number;
  cpuCores?: number;
  maxProcesses?: number;
  timeoutMinutes?: number;
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath?: string;

  // Kubernetes-specific configuration
  /** Path to kubeconfig file (e.g., ~/.kube/config) */
  kubeConfigPath?: string;
  /** Kubernetes context name to use */
  kubeContext?: string;
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace?: string;
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled?: boolean;
  /** Allowed egress hosts for network policies */
  allowedEgressHosts?: string[];

  // Nomad-specific configuration
  /** Nomad cluster HTTP address */
  nomadAddress?: string;
  /** Nomad ACL token */
  nomadToken?: string;
  /** Nomad namespace for sandbox jobs */
  nomadNamespace?: string;
  /** Nomad datacenter for job placement */
  nomadDatacenter?: string;
  /** Nomad region for job placement */
  nomadRegion?: string;
};

export type UpdateSandboxConfigInput = {
  name?: string;
  description?: string;
  type?: SandboxType;
  isDefault?: boolean;
  baseImage?: string;
  memoryMb?: number;
  cpuCores?: number;
  maxProcesses?: number;
  timeoutMinutes?: number;
  /** Volume mount path from local host for docker sandboxes */
  volumeMountPath?: string;

  // Kubernetes-specific configuration
  /** Path to kubeconfig file (e.g., ~/.kube/config) */
  kubeConfigPath?: string;
  /** Kubernetes context name to use */
  kubeContext?: string;
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace?: string;
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled?: boolean;
  /** Allowed egress hosts for network policies */
  allowedEgressHosts?: string[];

  // Nomad-specific configuration
  /** Nomad cluster HTTP address */
  nomadAddress?: string;
  /** Nomad ACL token */
  nomadToken?: string;
  /** Nomad namespace for sandbox jobs */
  nomadNamespace?: string;
  /** Nomad datacenter for job placement */
  nomadDatacenter?: string;
  /** Nomad region for job placement */
  nomadRegion?: string;
};

export type ListSandboxConfigsOptions = {
  limit?: number;
  offset?: number;
};

const log = createLogger('SandboxConfigService');

export class SandboxConfigService {
  constructor(private db: Database) {}

  private updateTimestamp(): string {
    return new Date().toISOString();
  }

  /**
   * Decrypt the nomadToken field on a config if present.
   * On decryption failure (key rotation, data corruption), logs the error and
   * clears nomadToken to undefined. The encrypted value in the DB is preserved
   * (only the in-memory copy is cleared).
   */
  private decryptConfigToken<T extends SandboxConfig | null>(config: T): T {
    if (!config || !config.nomadToken) {
      return config;
    }
    try {
      return { ...config, nomadToken: decryptToken(config.nomadToken) };
    } catch (error) {
      // Decryption failed (key changed, corrupted data). Log prominently so
      // operators know the token needs to be re-entered. The encrypted value
      // in the database is NOT modified — only this in-memory copy is cleared.
      log.error(
        'Failed to decrypt nomadToken — the token must be re-entered in Settings. ' +
          'This usually means the encryption key was rotated or the data is corrupted.',
        {
          data: { configId: config.id },
          error,
        }
      );
      return { ...config, nomadToken: null };
    }
  }

  /**
   * Validate a sandbox image reference is digest-pinned.
   *
   * theme-04 P0-01: tag-only image references (e.g. `:latest`) are rejected
   * because a compromised tag compromises every tenant.
   *
   * Returns `ok(undefined)` when the image is acceptable (unset, or a real
   * digest). Returns an error when the image is a bare repo or tag-pinned
   * reference.
   */
  validateImage(image: string | undefined | null): Result<void, SandboxConfigError> {
    if (!image) {
      return ok(undefined);
    }
    if (!isDigestPinnedImage(image)) {
      return err(SandboxConfigErrors.IMAGE_NOT_DIGEST_PINNED(image));
    }
    return ok(undefined);
  }

  /**
   * Enforce a per-tenant sandbox quota.
   *
   * theme-04 P1-07: prevents a single tenant from consuming the entire
   * cluster. The caller supplies the tenant's current active-sandbox count
   * and the config being validated; this method compares against the
   * supplied ceiling.
   */
  assertQuota(quota: SandboxQuota, args: QuotaCheckArgs): Result<void, SandboxConfigError> {
    if (args.activeSandboxes >= quota.maxSandboxes) {
      return err(
        SandboxConfigErrors.QUOTA_EXCEEDED(
          'maxSandboxes',
          args.activeSandboxes + 1,
          quota.maxSandboxes
        )
      );
    }
    if (args.cpuCores > quota.maxCpuCores) {
      return err(
        SandboxConfigErrors.QUOTA_EXCEEDED('maxCpuCores', args.cpuCores, quota.maxCpuCores)
      );
    }
    if (args.memoryMb > quota.maxMemoryMb) {
      return err(
        SandboxConfigErrors.QUOTA_EXCEEDED('maxMemoryMb', args.memoryMb, quota.maxMemoryMb)
      );
    }
    return ok(undefined);
  }

  private validateResourceLimits(
    input: Partial<CreateSandboxConfigInput>
  ): Result<void, SandboxConfigError> {
    if (input.memoryMb !== undefined) {
      if (input.memoryMb < 512 || input.memoryMb > 32768) {
        return err(SandboxConfigErrors.INVALID_MEMORY(input.memoryMb));
      }
    }

    if (input.cpuCores !== undefined) {
      if (input.cpuCores < 0.5 || input.cpuCores > 16) {
        return err(SandboxConfigErrors.INVALID_CPU(input.cpuCores));
      }
    }

    if (input.maxProcesses !== undefined) {
      if (input.maxProcesses < 32 || input.maxProcesses > 4096) {
        return err(SandboxConfigErrors.INVALID_PROCESSES(input.maxProcesses));
      }
    }

    if (input.timeoutMinutes !== undefined) {
      if (input.timeoutMinutes < 1 || input.timeoutMinutes > 1440) {
        return err(SandboxConfigErrors.INVALID_TIMEOUT(input.timeoutMinutes));
      }
    }

    return ok(undefined);
  }

  async create(
    input: CreateSandboxConfigInput
  ): Promise<Result<SandboxConfig, SandboxConfigError>> {
    // Validate resource limits
    const validation = this.validateResourceLimits(input);
    if (!validation.ok) {
      return validation;
    }

    // theme-04 P0-01: reject tag-only image references
    if (input.baseImage !== undefined) {
      const imageValidation = this.validateImage(input.baseImage);
      if (!imageValidation.ok) {
        return imageValidation;
      }
    }

    // Check for existing config with same name
    const existing = await this.db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.name, input.name),
    });

    if (existing) {
      return err(SandboxConfigErrors.ALREADY_EXISTS);
    }

    // If setting as default, check if another default exists
    if (input.isDefault) {
      const existingDefault = await this.db.query.sandboxConfigs.findFirst({
        where: eq(sandboxConfigs.isDefault, true),
      });

      if (existingDefault) {
        // Clear the existing default
        await this.db
          .update(sandboxConfigs)
          .set({ isDefault: false, updatedAt: this.updateTimestamp() })
          .where(eq(sandboxConfigs.id, existingDefault.id));
      }
    }

    const now = this.updateTimestamp();

    const [config] = await this.db
      .insert(sandboxConfigs)
      .values({
        name: input.name,
        description: input.description,
        type: input.type ?? 'docker',
        isDefault: input.isDefault ?? false,
        // theme-04 P0-01: default to the digest-pinned sandbox image. Tag-only
        // refs like `node:22-slim` are rejected by validateImage on overrides.
        baseImage: input.baseImage ?? SANDBOX_DEFAULTS.image,
        memoryMb: input.memoryMb ?? 4096,
        cpuCores: input.cpuCores ?? 2.0,
        maxProcesses: input.maxProcesses ?? 256,
        timeoutMinutes: input.timeoutMinutes ?? 60,
        volumeMountPath: input.volumeMountPath,
        // Kubernetes-specific fields
        kubeConfigPath: input.kubeConfigPath,
        kubeContext: input.kubeContext,
        kubeNamespace: input.kubeNamespace ?? 'agentpane-sandboxes',
        networkPolicyEnabled: input.networkPolicyEnabled ?? true,
        allowedEgressHosts: input.allowedEgressHosts,
        // Nomad-specific fields
        nomadAddress: input.nomadAddress,
        nomadToken: input.nomadToken ? encryptToken(input.nomadToken) : undefined,
        nomadNamespace: input.nomadNamespace ?? 'default',
        nomadDatacenter: input.nomadDatacenter,
        nomadRegion: input.nomadRegion,
        createdAt: now,
        updatedAt: now,
      } satisfies NewSandboxConfig)
      .returning();

    if (!config) {
      return err(SandboxConfigErrors.NOT_FOUND);
    }

    return ok(this.decryptConfigToken(config));
  }

  async getById(id: string): Promise<Result<SandboxConfig, SandboxConfigError>> {
    const config = await this.db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, id),
    });

    if (!config) {
      return err(SandboxConfigErrors.NOT_FOUND);
    }

    return ok(this.decryptConfigToken(config));
  }

  async getDefault(): Promise<Result<SandboxConfig | null, SandboxConfigError>> {
    const config = await this.db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.isDefault, true),
    });

    return ok(this.decryptConfigToken(config ?? null));
  }

  async list(
    options?: ListSandboxConfigsOptions
  ): Promise<Result<{ items: SandboxConfig[]; totalCount: number }, SandboxConfigError>> {
    const limit = options?.limit ?? 50;
    const offset = options?.offset ?? 0;

    const [countResult] = await this.db.select({ count: count() }).from(sandboxConfigs);
    const totalCount = countResult?.count ?? 0;

    const items = await this.db.query.sandboxConfigs.findMany({
      orderBy: [desc(sandboxConfigs.isDefault), desc(sandboxConfigs.updatedAt)],
      limit,
      offset,
    });

    return ok({ items: items.map((c) => this.decryptConfigToken(c)), totalCount });
  }

  async update(
    id: string,
    input: UpdateSandboxConfigInput
  ): Promise<Result<SandboxConfig, SandboxConfigError>> {
    // Validate resource limits
    const validation = this.validateResourceLimits(input);
    if (!validation.ok) {
      return validation;
    }

    // theme-04 P0-01: reject tag-only image references on updates too
    if (input.baseImage !== undefined) {
      const imageValidation = this.validateImage(input.baseImage);
      if (!imageValidation.ok) {
        return imageValidation;
      }
    }

    // Check if config exists
    const existing = await this.db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, id),
    });

    if (!existing) {
      return err(SandboxConfigErrors.NOT_FOUND);
    }

    // Check name uniqueness if changing name
    if (input.name !== undefined && input.name !== existing.name) {
      const nameConflict = await this.db.query.sandboxConfigs.findFirst({
        where: and(eq(sandboxConfigs.name, input.name), ne(sandboxConfigs.id, id)),
      });

      if (nameConflict) {
        return err(SandboxConfigErrors.ALREADY_EXISTS);
      }
    }

    // If setting as default, clear any existing default
    if (input.isDefault === true && !existing.isDefault) {
      const existingDefault = await this.db.query.sandboxConfigs.findFirst({
        where: and(eq(sandboxConfigs.isDefault, true), ne(sandboxConfigs.id, id)),
      });

      if (existingDefault) {
        await this.db
          .update(sandboxConfigs)
          .set({ isDefault: false, updatedAt: this.updateTimestamp() })
          .where(eq(sandboxConfigs.id, existingDefault.id));
      }
    }

    const updates: Partial<SandboxConfig> = {
      updatedAt: this.updateTimestamp(),
    };

    if (input.name !== undefined) updates.name = input.name;
    if (input.description !== undefined) updates.description = input.description;
    if (input.type !== undefined) updates.type = input.type;
    if (input.isDefault !== undefined) updates.isDefault = input.isDefault;
    if (input.baseImage !== undefined) updates.baseImage = input.baseImage;
    if (input.memoryMb !== undefined) updates.memoryMb = input.memoryMb;
    if (input.cpuCores !== undefined) updates.cpuCores = input.cpuCores;
    if (input.maxProcesses !== undefined) updates.maxProcesses = input.maxProcesses;
    if (input.timeoutMinutes !== undefined) updates.timeoutMinutes = input.timeoutMinutes;
    if (input.volumeMountPath !== undefined) updates.volumeMountPath = input.volumeMountPath;
    // Kubernetes-specific fields
    if (input.kubeConfigPath !== undefined) updates.kubeConfigPath = input.kubeConfigPath;
    if (input.kubeContext !== undefined) updates.kubeContext = input.kubeContext;
    if (input.kubeNamespace !== undefined) updates.kubeNamespace = input.kubeNamespace;
    if (input.networkPolicyEnabled !== undefined)
      updates.networkPolicyEnabled = input.networkPolicyEnabled;
    if (input.allowedEgressHosts !== undefined)
      updates.allowedEgressHosts = input.allowedEgressHosts;
    // Nomad-specific fields
    if (input.nomadAddress !== undefined) updates.nomadAddress = input.nomadAddress;
    if (input.nomadToken !== undefined)
      updates.nomadToken = input.nomadToken ? encryptToken(input.nomadToken) : null;
    if (input.nomadNamespace !== undefined) updates.nomadNamespace = input.nomadNamespace;
    if (input.nomadDatacenter !== undefined) updates.nomadDatacenter = input.nomadDatacenter;
    if (input.nomadRegion !== undefined) updates.nomadRegion = input.nomadRegion;

    const [updated] = await this.db
      .update(sandboxConfigs)
      .set(updates)
      .where(eq(sandboxConfigs.id, id))
      .returning();

    if (!updated) {
      return err(SandboxConfigErrors.NOT_FOUND);
    }

    return ok(this.decryptConfigToken(updated));
  }

  async delete(id: string): Promise<Result<void, SandboxConfigError>> {
    const config = await this.db.query.sandboxConfigs.findFirst({
      where: eq(sandboxConfigs.id, id),
    });

    if (!config) {
      return err(SandboxConfigErrors.NOT_FOUND);
    }

    // Check if any codespaces are using this config
    const codespacesUsingConfig = await this.db.query.codespaces.findMany({
      where: eq(codespaces.sandboxConfigId, id),
    });

    if (codespacesUsingConfig.length > 0) {
      return err(SandboxConfigErrors.IN_USE(codespacesUsingConfig.length));
    }

    await this.db.delete(sandboxConfigs).where(eq(sandboxConfigs.id, id));

    return ok(undefined);
  }
}
