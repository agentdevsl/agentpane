import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { integer, real, sqliteTable, text } from 'drizzle-orm/sqlite-core';
import { SANDBOX_TYPES } from '../shared/enums';

export const sandboxConfigs = sqliteTable('sandbox_configs', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),
  name: text('name').notNull(),
  description: text('description'),
  type: text('type', { enum: SANDBOX_TYPES }).notNull().default('docker'),
  isDefault: integer('is_default', { mode: 'boolean' }).default(false),
  baseImage: text('base_image').notNull().default('node:22-slim'),
  memoryMb: integer('memory_mb').notNull().default(8192),
  cpuCores: real('cpu_cores').notNull().default(4.0),
  maxProcesses: integer('max_processes').notNull().default(256),
  timeoutMinutes: integer('timeout_minutes').notNull().default(60),
  /** Volume mount path from local host for docker sandboxes (e.g., /home/user/projects) */
  volumeMountPath: text('volume_mount_path'),

  // Kubernetes-specific configuration fields
  /** Path to kubeconfig file (e.g., ~/.kube/config) */
  kubeConfigPath: text('kube_config_path'),
  /** Kubernetes context name to use */
  kubeContext: text('kube_context'),
  /** Kubernetes namespace for sandbox pods */
  kubeNamespace: text('kube_namespace').default('agentpane-sandboxes'),
  /** Enable network policies for K8s sandboxes */
  networkPolicyEnabled: integer('network_policy_enabled', { mode: 'boolean' }).default(true),
  /** JSON array of allowed egress hosts for network policies */
  allowedEgressHosts: text('allowed_egress_hosts', { mode: 'json' }).$type<string[]>(),

  // Nomad-specific configuration fields
  /** Nomad cluster HTTP address (e.g., http://nomad.example.com:4646) */
  nomadAddress: text('nomad_address'),
  /** Nomad ACL token for authentication */
  nomadToken: text('nomad_token'),
  /** Nomad namespace for sandbox jobs */
  nomadNamespace: text('nomad_namespace').default('default'),
  /** Nomad datacenter for job placement */
  nomadDatacenter: text('nomad_datacenter'),
  /** Nomad region */
  nomadRegion: text('nomad_region'),

  // AWS Bedrock AgentCore-specific configuration fields. Bootstrap migration
  // v14 adds these columns; the Drizzle schema must mirror them so service
  // inserts can persist credentials and ARNs (otherwise Drizzle silently
  // drops the values).
  /** AWS access key ID for the Bedrock AgentCore runtime account. */
  awsAccessKeyId: text('aws_access_key_id'),
  /** AWS secret access key (encrypted at rest, decrypted in-memory only). */
  awsSecretAccessKey: text('aws_secret_access_key'),
  /** AWS region where the AgentCore runtime is hosted. */
  awsRegion: text('aws_region'),
  /** ARN of the AgentCore runtime to invoke. */
  agentcoreRuntimeArn: text('agentcore_runtime_arn'),
  /** ECR repository URI for the AgentCore container image. */
  ecrRepositoryUri: text('ecr_repository_uri'),

  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at')
    .default(sql`(datetime('now'))`)
    .notNull()
    .$onUpdate(() => new Date().toISOString()),
});

export type SandboxConfig = typeof sandboxConfigs.$inferSelect;
export type NewSandboxConfig = typeof sandboxConfigs.$inferInsert;
