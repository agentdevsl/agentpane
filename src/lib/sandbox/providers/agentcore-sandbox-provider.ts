import { BedrockAgentCoreClient } from '@aws-sdk/client-bedrock-agentcore';
import {
  BedrockAgentCoreControlClient,
  CreateAgentRuntimeCommand,
  DeleteAgentRuntimeCommand,
  GetAgentRuntimeCommand,
  ListAgentRuntimesCommand,
} from '@aws-sdk/client-bedrock-agentcore-control';
import {
  DescribeImagesCommand,
  ECRClient,
  GetAuthorizationTokenCommand,
} from '@aws-sdk/client-ecr';
import { GetCallerIdentityCommand, STSClient } from '@aws-sdk/client-sts';
import { createId } from '@paralleldrive/cuid2';
import { AgentCoreErrors } from '../../errors/agentcore-errors.js';
import { createLogger } from '../../logging/logger.js';
import type { SandboxConfig, SandboxHealthCheck, SandboxInfo } from '../types.js';
import { SANDBOX_DEFAULTS } from '../types.js';
import { AgentCoreSandboxInstance, mapAgentCoreStatus } from './agentcore-sandbox-instance.js';
import type {
  EventEmittingSandboxProvider,
  Sandbox,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './sandbox-provider.js';

const log = createLogger('AgentCoreSandboxProvider');

/**
 * Configuration for AgentCoreSandboxProvider.
 */
export interface AgentCoreSandboxProviderOptions {
  /** AWS IAM Access Key ID */
  awsAccessKeyId?: string;
  /** AWS IAM Secret Access Key */
  awsSecretAccessKey?: string;
  /** AWS region (e.g., us-west-2). Default: 'us-east-1' */
  awsRegion?: string;
  /** ECR repository URI for agent-runner image */
  ecrRepositoryUri?: string;
  /** Container image for sandbox. Default: SANDBOX_DEFAULTS.image */
  image?: string;
  /** IAM role ARN for the AgentCore Runtime to assume */
  roleArn?: string;
  /** Timeout in seconds for runtime to reach READY state. Default: 300 */
  readyTimeoutSeconds?: number;
}

const PROVIDER_DEFAULTS = {
  region: 'us-east-1',
  readyTimeoutSeconds: 300,
} as const;

/**
 * Extract the runtime ID from an AgentCore Runtime ARN.
 *
 * ARN format: arn:aws:bedrock-agentcore:<region>:<account>:runtime/<runtime-id>
 * Falls back to the full string if parsing fails.
 */
function extractRuntimeId(arn: string): string {
  const parts = arn.split('/');
  return parts[parts.length - 1] ?? arn;
}

/**
 * AgentCore sandbox provider.
 *
 * Manages sandbox lifecycle using AWS Bedrock AgentCore Runtimes. Each sandbox
 * is an AgentCore Runtime running the agent sandbox container image. The
 * provider uses runtime name prefixes to track sandbox-to-project mappings.
 *
 * Implements EventEmittingSandboxProvider so it can be used as a drop-in
 * replacement for DockerProvider/NomadSandboxProvider in ContainerAgentService.
 */
export class AgentCoreSandboxProvider implements EventEmittingSandboxProvider {
  readonly name = 'agentcore';

  private readonly controlClient: BedrockAgentCoreControlClient;
  private readonly dataClient: BedrockAgentCoreClient;
  private readonly ecrClient: ECRClient;
  private readonly stsClient: STSClient;
  private readonly region: string;
  private readonly image: string;
  private readonly readyTimeoutSeconds: number;
  private readonly ecrRepositoryUri?: string;
  private readonly roleArn?: string;

  private sandboxes = new Map<string, AgentCoreSandboxInstance>();
  private projectToSandbox = new Map<string, string>();
  private listeners = new Set<SandboxProviderEventListener>();
  private creatingProjects = new Set<string>();

  constructor(options: AgentCoreSandboxProviderOptions = {}) {
    const credentials =
      options.awsAccessKeyId && options.awsSecretAccessKey
        ? {
            accessKeyId: options.awsAccessKeyId,
            secretAccessKey: options.awsSecretAccessKey,
          }
        : undefined;
    const region = options.awsRegion ?? PROVIDER_DEFAULTS.region;

    this.region = region;
    this.image = options.image ?? SANDBOX_DEFAULTS.image;
    this.readyTimeoutSeconds = options.readyTimeoutSeconds ?? PROVIDER_DEFAULTS.readyTimeoutSeconds;
    this.ecrRepositoryUri = options.ecrRepositoryUri;
    this.roleArn = options.roleArn;

    this.controlClient = new BedrockAgentCoreControlClient({ region, credentials });
    this.dataClient = new BedrockAgentCoreClient({ region, credentials });
    this.ecrClient = new ECRClient({ region, credentials });
    this.stsClient = new STSClient({ region, credentials });
  }

  // --- SandboxProvider interface ---

  async create(config: SandboxConfig): Promise<Sandbox> {
    // Guard against concurrent create() calls for the same project
    if (this.creatingProjects.has(config.projectId)) {
      throw AgentCoreErrors.RUNTIME_ALREADY_EXISTS(config.projectId);
    }

    // Check for existing sandbox for this project
    const existing = this.projectToSandbox.get(config.projectId);
    if (existing) {
      const sandbox = this.sandboxes.get(existing);
      if (sandbox && sandbox.status !== 'stopped') {
        throw AgentCoreErrors.RUNTIME_ALREADY_EXISTS(config.projectId);
      }
    }

    this.creatingProjects.add(config.projectId);
    const sandboxId = createId();
    // Runtime names must be DNS-compatible: lowercase alphanumeric and hyphens
    const runtimeName = `agentpane-${config.projectId.slice(0, 20)}-${sandboxId.slice(0, 8)}`
      .toLowerCase()
      .replace(/[^a-z0-9-]/g, '-');

    this.emit({
      type: 'sandbox:creating',
      sandboxId,
      projectId: config.projectId,
    });

    try {
      // Create the AgentCore Runtime
      const createCommand = new CreateAgentRuntimeCommand({
        agentRuntimeName: runtimeName,
        description: `AgentPane sandbox for project ${config.projectId}`,
        agentRuntimeArtifact: {
          containerConfiguration: {
            containerUri: config.image || this.image,
          },
        },
        roleArn: this.roleArn ?? '',
        networkConfiguration: { networkMode: 'PUBLIC' },
      });

      const createResponse = await this.controlClient.send(createCommand);
      const runtimeArn = createResponse.agentRuntimeArn;

      if (!runtimeArn) {
        throw AgentCoreErrors.RUNTIME_CREATION_FAILED(
          runtimeName,
          'No runtime ARN returned from CreateAgentRuntimeCommand'
        );
      }

      const runtimeId = extractRuntimeId(runtimeArn);

      // Poll GetAgentRuntimeCommand until status is READY (with timeout)
      const startTime = Date.now();
      const timeoutMs = this.readyTimeoutSeconds * 1000;

      while (Date.now() - startTime < timeoutMs) {
        const getCommand = new GetAgentRuntimeCommand({
          agentRuntimeId: runtimeId,
        });
        const getResponse = await this.controlClient.send(getCommand);
        const status = getResponse.status;

        if (status === 'READY') {
          break;
        }
        if (status === 'CREATE_FAILED') {
          throw AgentCoreErrors.RUNTIME_CREATION_FAILED(
            runtimeName,
            `Runtime reached CREATE_FAILED state: ${getResponse.failureReason ?? 'unknown reason'}`
          );
        }

        // Wait 5 seconds before polling again
        await new Promise((resolve) => setTimeout(resolve, 5000));
      }

      // Verify final status
      const verifyCommand = new GetAgentRuntimeCommand({
        agentRuntimeId: runtimeId,
      });
      const verifyResponse = await this.controlClient.send(verifyCommand);

      if (verifyResponse.status !== 'READY') {
        throw AgentCoreErrors.RUNTIME_STARTUP_TIMEOUT(runtimeArn, this.readyTimeoutSeconds);
      }

      // Create the Sandbox interface wrapper
      const instance = new AgentCoreSandboxInstance(
        sandboxId,
        runtimeArn,
        runtimeId,
        config.projectId,
        this.controlClient,
        this.dataClient
      );

      await instance.refreshStatus();

      this.sandboxes.set(sandboxId, instance);
      this.projectToSandbox.set(config.projectId, sandboxId);

      this.emit({
        type: 'sandbox:created',
        sandboxId,
        projectId: config.projectId,
        containerId: runtimeArn,
      });

      this.emit({ type: 'sandbox:started', sandboxId });

      return instance;
    } catch (error) {
      // Best-effort cleanup of the created AgentCore runtime
      try {
        // Attempt to find and delete the runtime by name
        const listCommand = new ListAgentRuntimesCommand({});
        const listResponse = await this.controlClient.send(listCommand);
        const runtime = (listResponse.agentRuntimes ?? []).find(
          (r) => r.agentRuntimeName === runtimeName
        );
        if (runtime?.agentRuntimeId) {
          await this.controlClient.send(
            new DeleteAgentRuntimeCommand({
              agentRuntimeId: runtime.agentRuntimeId,
            })
          );
        }
      } catch (cleanupError) {
        log.warn(`Failed to clean up runtime ${runtimeName} after creation failure`, {
          error: cleanupError instanceof Error ? cleanupError : new Error(String(cleanupError)),
        });
      }

      this.emit({
        type: 'sandbox:error',
        sandboxId,
        error: error instanceof Error ? error : new Error(String(error)),
      });

      // Check for specific AWS error types
      if (error instanceof Error) {
        if (error.name === 'AccessDeniedException' || error.name === 'UnauthorizedException') {
          throw AgentCoreErrors.AWS_CREDENTIALS_INVALID(error.message);
        }
        if (error.name === 'ExpiredTokenException') {
          throw AgentCoreErrors.AWS_CREDENTIALS_EXPIRED();
        }
      }

      // Re-throw if already an AgentCore error
      if (error instanceof Error && 'id' in error) {
        throw error;
      }

      const message = error instanceof Error ? error.message : String(error);
      throw AgentCoreErrors.RUNTIME_CREATION_FAILED(runtimeName, message);
    } finally {
      this.creatingProjects.delete(config.projectId);
    }
  }

  async validateSandboxes(): Promise<void> {
    const toEvict: string[] = [];
    for (const [sandboxId, instance] of this.sandboxes) {
      try {
        await instance.refreshStatus();
      } catch (error) {
        log.error(`refreshStatus failed for sandbox ${sandboxId}, treating as error`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        toEvict.push(sandboxId);
        continue;
      }
      if (instance.status === 'error' || instance.status === 'stopped') {
        toEvict.push(sandboxId);
      }
    }
    for (const sandboxId of toEvict) {
      const instance = this.sandboxes.get(sandboxId);
      if (instance) {
        log.info('Evicting stale sandbox from cache', {
          data: { sandboxId, projectId: instance.projectId, status: instance.status },
        });
        this.sandboxes.delete(sandboxId);
        this.projectToSandbox.delete(instance.projectId);
      }
    }
  }

  async get(projectId: string): Promise<Sandbox | null> {
    // Check in-memory cache first
    const sandboxId = this.projectToSandbox.get(projectId);
    if (sandboxId) {
      const cached = this.sandboxes.get(sandboxId);
      if (cached) {
        // Refresh status from API to avoid stale 'creating' status
        try {
          await cached.refreshStatus();
        } catch (error) {
          log.error(`refreshStatus failed for sandbox ${sandboxId} in get()`, {
            error: error instanceof Error ? error : new Error(String(error)),
            data: { projectId },
          });
          this.sandboxes.delete(sandboxId);
          this.projectToSandbox.delete(projectId);
          // Fall through to API query below
        }
        if (this.sandboxes.has(sandboxId)) {
          if (cached.status === 'error' || cached.status === 'stopped') {
            log.info('Evicting stale sandbox from get() cache', {
              data: { sandboxId, projectId, status: cached.status },
            });
            this.sandboxes.delete(sandboxId);
            this.projectToSandbox.delete(projectId);
            // Fall through to API query below
          } else {
            return cached;
          }
        }
      }
    }

    try {
      // Fall through to API query using ListAgentRuntimes
      const listCommand = new ListAgentRuntimesCommand({});
      const listResponse = await this.controlClient.send(listCommand);
      const runtimes = listResponse.agentRuntimes ?? [];

      // Find a runtime with matching name prefix that is READY
      const namePrefix = `agentpane-${projectId.slice(0, 20)}`
        .toLowerCase()
        .replace(/[^a-z0-9-]/g, '-');

      for (const runtime of runtimes) {
        if (!runtime.agentRuntimeArn || !runtime.agentRuntimeId) continue;
        if (runtime.agentRuntimeName?.startsWith(namePrefix) && runtime.status === 'READY') {
          const id = createId();
          const instance = new AgentCoreSandboxInstance(
            id,
            runtime.agentRuntimeArn,
            runtime.agentRuntimeId,
            projectId,
            this.controlClient,
            this.dataClient
          );
          await instance.refreshStatus();

          // Cache it
          this.sandboxes.set(id, instance);
          this.projectToSandbox.set(projectId, id);

          return instance;
        }
      }

      if (projectId !== 'default') {
        log.warn(`No AgentCore Runtime found for project ${projectId}`);
      }
      return null;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'ResourceNotFoundException' || error.name === 'NotFoundException')
      ) {
        return null;
      }
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to get sandbox for project ${projectId}: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw error;
    }
  }

  async getById(sandboxId: string): Promise<Sandbox | null> {
    const cached = this.sandboxes.get(sandboxId);
    if (cached) {
      try {
        await cached.refreshStatus();
      } catch (error) {
        log.error(`refreshStatus failed for sandbox ${sandboxId} in getById`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
        this.sandboxes.delete(sandboxId);
        this.projectToSandbox.delete(cached.projectId);
        return null;
      }
      if (cached.status === 'error' || cached.status === 'stopped') {
        this.sandboxes.delete(sandboxId);
        this.projectToSandbox.delete(cached.projectId);
        return null;
      }
    }
    return cached ?? null;
  }

  async list(): Promise<SandboxInfo[]> {
    await this.validateSandboxes();
    try {
      const listCommand = new ListAgentRuntimesCommand({});
      const listResponse = await this.controlClient.send(listCommand);
      const runtimes = listResponse.agentRuntimes ?? [];

      return runtimes
        .filter((runtime) => runtime.agentRuntimeName?.startsWith('agentpane-'))
        .map((runtime) => ({
          id: runtime.agentRuntimeArn ?? '',
          projectId: '', // Would need tag lookup for accurate project mapping
          containerId: runtime.agentRuntimeArn ?? '',
          status: mapAgentCoreStatus(runtime.status),
          image: this.image,
          createdAt: runtime.lastUpdatedAt?.toISOString() ?? new Date().toISOString(),
          lastActivityAt: runtime.lastUpdatedAt?.toISOString() ?? new Date().toISOString(),
          memoryMb: 0,
          cpuCores: 0,
        }));
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      log.error(`Failed to list AgentCore runtimes: ${message}`, {
        error: error instanceof Error ? error : new Error(message),
      });
      throw error;
    }
  }

  async pullImage(image: string): Promise<void> {
    // Validate ECR access by requesting an authorization token.
    // AgentCore handles image pulling internally; this just verifies connectivity.
    if (!image || image.trim() === '') {
      throw AgentCoreErrors.ECR_IMAGE_NOT_FOUND(image);
    }

    try {
      const command = new GetAuthorizationTokenCommand({});
      await this.ecrClient.send(command);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      throw AgentCoreErrors.ECR_AUTH_FAILED(message);
    }
  }

  async isImageAvailable(image: string): Promise<boolean> {
    if (!image || image.trim() === '') {
      return false;
    }

    // If no ECR repository URI configured, assume image is available
    if (!this.ecrRepositoryUri) {
      return true;
    }

    try {
      // Parse repository name and image tag from the image string
      const parts = image.split(':');
      const tag = parts[1] ?? 'latest';

      // Extract repository name from the ECR URI
      const repoName = this.ecrRepositoryUri.split('/').pop() ?? this.ecrRepositoryUri;

      const command = new DescribeImagesCommand({
        repositoryName: repoName,
        imageIds: [{ imageTag: tag }],
      });

      await this.ecrClient.send(command);
      return true;
    } catch (error) {
      if (
        error instanceof Error &&
        (error.name === 'ImageNotFoundException' || error.name === 'RepositoryNotFoundException')
      ) {
        return false;
      }
      // Treat other errors as "unknown availability" and log
      const message = error instanceof Error ? error.message : String(error);
      log.warn(`Failed to check image availability for ${image}: ${message}`);
      return false;
    }
  }

  async healthCheck(): Promise<SandboxHealthCheck> {
    try {
      // 1. Validate AWS credentials via STS
      const stsCommand = new GetCallerIdentityCommand({});
      const stsResponse = await this.stsClient.send(stsCommand);
      const accountId = stsResponse.Account;

      // 2. Verify AgentCore API access
      const listCommand = new ListAgentRuntimesCommand({});
      await this.controlClient.send(listCommand);

      return {
        healthy: true,
        details: {
          provider: 'agentcore',
          region: this.region,
          accountId,
          apiAccessible: true,
        },
      };
    } catch (error) {
      if (error instanceof Error) {
        // Treat known infrastructure/auth errors as "unhealthy"
        if (
          error.name === 'AccessDeniedException' ||
          error.name === 'UnauthorizedException' ||
          error.name === 'ExpiredTokenException' ||
          error.name === 'InvalidIdentityTokenException' ||
          error.name === 'UnrecognizedClientException' ||
          error.name === 'ServiceException' ||
          error.name === 'NetworkingError'
        ) {
          log.error(`AgentCore health check failed: ${error.message}`, { error });
          return {
            healthy: false,
            message: `AgentCore health check failed: ${error.message}`,
            details: {
              provider: 'agentcore',
              region: this.region,
              errorName: error.name,
            },
          };
        }
      }
      // Let programming errors propagate
      throw error;
    }
  }

  async cleanup(options?: { olderThan?: Date; status?: string[] }): Promise<number> {
    let cleaned = 0;
    const toClean: string[] = [];

    for (const [sandboxId, instance] of this.sandboxes) {
      const shouldClean =
        (options?.status?.includes(instance.status) ?? instance.status === 'stopped') &&
        (!options?.olderThan || instance.getLastActivity() < options.olderThan);
      if (shouldClean) {
        toClean.push(sandboxId);
      }
    }

    for (const sandboxId of toClean) {
      const instance = this.sandboxes.get(sandboxId);
      if (!instance) continue;
      try {
        if (instance.status !== 'stopped') {
          // Delete the AgentCore runtime
          const runtimeId = extractRuntimeId(instance.containerId);
          const deleteCommand = new DeleteAgentRuntimeCommand({
            agentRuntimeId: runtimeId,
          });
          await this.controlClient.send(deleteCommand);
        }
        cleaned++;
      } catch (error) {
        log.error(`Failed to delete runtime ${sandboxId} during cleanup — removing from cache`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
      // Always evict from cache regardless of delete success/failure
      this.sandboxes.delete(sandboxId);
      this.projectToSandbox.delete(instance.projectId);
    }

    return cleaned;
  }

  // --- Event emission (same pattern as NomadSandboxProvider) ---

  on(listener: SandboxProviderEventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  off(listener: SandboxProviderEventListener): void {
    this.listeners.delete(listener);
  }

  private emit(event: SandboxProviderEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        log.error(`Event listener error during ${event.type}`, {
          error: error instanceof Error ? error : new Error(String(error)),
        });
      }
    }
  }
}

/**
 * Factory function (mirrors createNomadSandboxProvider pattern).
 */
export function createAgentCoreSandboxProvider(
  options?: AgentCoreSandboxProviderOptions
): AgentCoreSandboxProvider {
  return new AgentCoreSandboxProvider(options);
}
