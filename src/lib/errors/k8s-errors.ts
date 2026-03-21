import type { AppError } from './base.js';
import { createError } from './base.js';

export type K8sError = AppError;

/**
 * Sentry error IDs for K8s errors.
 * Use these to group and track errors in Sentry/monitoring systems.
 * Format: K8S-XXX where XXX is a category-specific number.
 */
export const K8S_ERROR_IDS = {
  // Cluster connectivity (001-099)
  CLUSTER_UNREACHABLE: 'K8S-001',
  KUBECONFIG_NOT_FOUND: 'K8S-002',
  KUBECONFIG_INVALID: 'K8S-003',
  CONTEXT_NOT_FOUND: 'K8S-004',

  // Namespace (100-199)
  NAMESPACE_NOT_FOUND: 'K8S-100',
  NAMESPACE_CREATION_FAILED: 'K8S-101',
  NAMESPACE_ACCESS_DENIED: 'K8S-102',

  // Pod lifecycle (200-299)
  POD_NOT_FOUND: 'K8S-200',
  POD_CREATION_FAILED: 'K8S-201',
  POD_STARTUP_TIMEOUT: 'K8S-202',
  POD_DELETION_FAILED: 'K8S-203',
  POD_NOT_RUNNING: 'K8S-204',
  POD_ALREADY_EXISTS: 'K8S-205',

  // Exec (300-399)
  EXEC_FAILED: 'K8S-300',
  EXEC_TIMEOUT: 'K8S-301',
  EXEC_CONNECTION_FAILED: 'K8S-302',

  // Image (400-499)
  IMAGE_PULL_FAILED: 'K8S-400',
  IMAGE_PULL_BACKOFF: 'K8S-401',
  IMAGE_NOT_FOUND: 'K8S-402',

  // tmux (500-599)
  TMUX_SESSION_NOT_FOUND: 'K8S-500',
  TMUX_SESSION_ALREADY_EXISTS: 'K8S-501',
  TMUX_CREATION_FAILED: 'K8S-502',

  // Resources (600-699)
  INSUFFICIENT_RESOURCES: 'K8S-600',

  // API (700-799)
  API_ERROR: 'K8S-700',
  INTERNAL_ERROR: 'K8S-701',

  // Network Policy (800-899)
  NETWORK_POLICY_CREATION_FAILED: 'K8S-800',
  NETWORK_POLICY_NOT_FOUND: 'K8S-801',
  NETWORK_POLICY_UPDATE_FAILED: 'K8S-802',
  NETWORK_POLICY_DELETION_FAILED: 'K8S-803',

  // RBAC (900-999)
  SERVICE_ACCOUNT_CREATION_FAILED: 'K8S-900',
  ROLE_CREATION_FAILED: 'K8S-901',
  ROLE_BINDING_CREATION_FAILED: 'K8S-902',
  LIMIT_RANGE_CREATION_FAILED: 'K8S-903',

  // Security (1000-1099)
  POD_SECURITY_VIOLATION: 'K8S-1000',

  // Warm Pool (1100-1199)
  WARM_POOL_EMPTY: 'K8S-1100',
  WARM_POOL_EXHAUSTED: 'K8S-1101',
  WARM_POOL_ALLOCATION_FAILED: 'K8S-1102',
  WARM_POOL_NOT_ENABLED: 'K8S-1103',
  WARM_POD_NOT_FOUND: 'K8S-1104',
  WARM_POOL_DISCOVERY_FAILED: 'K8S-1105',
} as const;

export type K8sErrorId = (typeof K8S_ERROR_IDS)[keyof typeof K8S_ERROR_IDS];

export const K8sErrors = {
  // Cluster connectivity errors
  CLUSTER_UNREACHABLE: (message: string) =>
    createError('K8S_CLUSTER_UNREACHABLE', `Kubernetes cluster is unreachable: ${message}`, 503),

  KUBECONFIG_NOT_FOUND: (path?: string) =>
    createError(
      'K8S_KUBECONFIG_NOT_FOUND',
      path ? `Kubeconfig not found at: ${path}` : 'Kubeconfig not found',
      404,
      { path }
    ),

  KUBECONFIG_INVALID: (message: string) =>
    createError('K8S_KUBECONFIG_INVALID', `Invalid kubeconfig: ${message}`, 400),

  CONTEXT_NOT_FOUND: (context: string) =>
    createError('K8S_CONTEXT_NOT_FOUND', `Kubernetes context not found: ${context}`, 404, {
      context,
    }),

  // Namespace errors
  NAMESPACE_NOT_FOUND: (namespace: string) =>
    createError('K8S_NAMESPACE_NOT_FOUND', `Namespace not found: ${namespace}`, 404, { namespace }),

  NAMESPACE_CREATION_FAILED: (namespace: string, message: string) =>
    createError(
      'K8S_NAMESPACE_CREATION_FAILED',
      `Failed to create namespace ${namespace}: ${message}`,
      500,
      { namespace }
    ),

  NAMESPACE_ACCESS_DENIED: (namespace: string) =>
    createError('K8S_NAMESPACE_ACCESS_DENIED', `Access denied to namespace: ${namespace}`, 403, {
      namespace,
    }),

  // Pod lifecycle errors
  POD_NOT_FOUND: (podName: string, namespace: string) =>
    createError('K8S_POD_NOT_FOUND', `Pod not found: ${podName} in namespace ${namespace}`, 404, {
      podName,
      namespace,
    }),

  POD_CREATION_FAILED: (podName: string, message: string) =>
    createError('K8S_POD_CREATION_FAILED', `Failed to create pod ${podName}: ${message}`, 500, {
      podName,
    }),

  POD_STARTUP_TIMEOUT: (podName: string, timeoutSeconds: number) =>
    createError(
      'K8S_POD_STARTUP_TIMEOUT',
      `Pod ${podName} failed to start within ${timeoutSeconds}s`,
      408,
      { podName, timeoutSeconds }
    ),

  POD_DELETION_FAILED: (podName: string, message: string) =>
    createError('K8S_POD_DELETION_FAILED', `Failed to delete pod ${podName}: ${message}`, 500, {
      podName,
    }),

  POD_NOT_RUNNING: (podName: string, currentPhase: string) =>
    createError(
      'K8S_POD_NOT_RUNNING',
      `Pod ${podName} is not running (current phase: ${currentPhase})`,
      400,
      { podName, currentPhase }
    ),

  POD_ALREADY_EXISTS: (codespaceId: string) =>
    createError('K8S_POD_ALREADY_EXISTS', 'Pod already exists for codespace', 409, { codespaceId }),

  // Exec errors
  EXEC_FAILED: (command: string, message: string) =>
    createError('K8S_EXEC_FAILED', `Command execution failed: ${message}`, 500, { command }),

  EXEC_TIMEOUT: (command: string, timeoutMs: number) =>
    createError('K8S_EXEC_TIMEOUT', `Command timed out after ${timeoutMs}ms`, 408, {
      command,
      timeoutMs,
    }),

  EXEC_CONNECTION_FAILED: (podName: string, message: string) =>
    createError(
      'K8S_EXEC_CONNECTION_FAILED',
      `Failed to establish exec connection to pod ${podName}: ${message}`,
      503,
      { podName }
    ),

  // Image errors
  IMAGE_PULL_FAILED: (image: string, message: string) =>
    createError('K8S_IMAGE_PULL_FAILED', `Failed to pull image ${image}: ${message}`, 500, {
      image,
    }),

  IMAGE_PULL_BACKOFF: (image: string, reason: string) =>
    createError('K8S_IMAGE_PULL_BACKOFF', `Image pull backoff for ${image}: ${reason}`, 500, {
      image,
      reason,
    }),

  IMAGE_NOT_FOUND: (image: string) =>
    createError('K8S_IMAGE_NOT_FOUND', `Image not found: ${image}`, 404, { image }),

  // tmux errors (reuse sandbox pattern)
  TMUX_SESSION_NOT_FOUND: (sessionName: string) =>
    createError('K8S_TMUX_SESSION_NOT_FOUND', `tmux session not found: ${sessionName}`, 404, {
      sessionName,
    }),

  TMUX_SESSION_ALREADY_EXISTS: (sessionName: string) =>
    createError('K8S_TMUX_SESSION_EXISTS', `tmux session already exists: ${sessionName}`, 409, {
      sessionName,
    }),

  TMUX_CREATION_FAILED: (sessionName: string, message: string) =>
    createError('K8S_TMUX_CREATION_FAILED', `Failed to create tmux session: ${message}`, 500, {
      sessionName,
    }),

  // Resource errors
  INSUFFICIENT_RESOURCES: (resource: string, requested: string, available: string) =>
    createError(
      'K8S_INSUFFICIENT_RESOURCES',
      `Insufficient ${resource}: requested ${requested}, available ${available}`,
      400,
      { resource, requested, available }
    ),

  // API errors
  API_ERROR: (statusCode: number, message: string) =>
    createError('K8S_API_ERROR', `Kubernetes API error (${statusCode}): ${message}`, statusCode),

  // Generic internal error
  INTERNAL_ERROR: (message: string) => createError('K8S_INTERNAL_ERROR', message, 500),

  // NetworkPolicy errors
  NETWORK_POLICY_CREATION_FAILED: (policyName: string, message: string) =>
    createError(
      'K8S_NETWORK_POLICY_CREATION_FAILED',
      `Failed to create network policy ${policyName}: ${message}`,
      500,
      { policyName }
    ),

  NETWORK_POLICY_NOT_FOUND: (policyName: string, namespace: string) =>
    createError(
      'K8S_NETWORK_POLICY_NOT_FOUND',
      `Network policy not found: ${policyName} in namespace ${namespace}`,
      404,
      { policyName, namespace }
    ),

  NETWORK_POLICY_UPDATE_FAILED: (policyName: string, message: string) =>
    createError(
      'K8S_NETWORK_POLICY_UPDATE_FAILED',
      `Failed to update network policy ${policyName}: ${message}`,
      500,
      { policyName }
    ),

  NETWORK_POLICY_DELETION_FAILED: (policyName: string, message: string) =>
    createError(
      'K8S_NETWORK_POLICY_DELETION_FAILED',
      `Failed to delete network policy ${policyName}: ${message}`,
      500,
      { policyName }
    ),

  // RBAC errors
  SERVICE_ACCOUNT_CREATION_FAILED: (name: string, message: string) =>
    createError(
      'K8S_SERVICE_ACCOUNT_CREATION_FAILED',
      `Failed to create service account ${name}: ${message}`,
      500,
      { name }
    ),

  ROLE_CREATION_FAILED: (name: string, message: string) =>
    createError('K8S_ROLE_CREATION_FAILED', `Failed to create role ${name}: ${message}`, 500, {
      name,
    }),

  ROLE_BINDING_CREATION_FAILED: (name: string, message: string) =>
    createError(
      'K8S_ROLE_BINDING_CREATION_FAILED',
      `Failed to create role binding ${name}: ${message}`,
      500,
      { name }
    ),

  // LimitRange errors
  LIMIT_RANGE_CREATION_FAILED: (name: string, message: string) =>
    createError(
      'K8S_LIMIT_RANGE_CREATION_FAILED',
      `Failed to create limit range ${name}: ${message}`,
      500,
      { name }
    ),

  // Security validation errors
  POD_SECURITY_VIOLATION: (podName: string, violation: string) =>
    createError(
      'K8S_POD_SECURITY_VIOLATION',
      `Pod ${podName} violates security policy: ${violation}`,
      400,
      { podName, violation }
    ),

  // Warm pool errors
  WARM_POOL_EMPTY: () =>
    createError('K8S_WARM_POOL_EMPTY', 'No warm pods available in the pool', 503),

  WARM_POOL_EXHAUSTED: (maxSize: number) =>
    createError('K8S_WARM_POOL_EXHAUSTED', `Warm pool has reached maximum size (${maxSize})`, 503, {
      maxSize,
    }),

  WARM_POOL_ALLOCATION_FAILED: (podName: string, message: string) =>
    createError(
      'K8S_WARM_POOL_ALLOCATION_FAILED',
      `Failed to allocate warm pod ${podName}: ${message}`,
      500,
      { podName }
    ),

  WARM_POOL_NOT_ENABLED: () =>
    createError('K8S_WARM_POOL_NOT_ENABLED', 'Warm pool is not enabled', 400),

  WARM_POD_NOT_FOUND: (podName: string) =>
    createError('K8S_WARM_POD_NOT_FOUND', `Warm pod not found: ${podName}`, 404, { podName }),

  WARM_POOL_DISCOVERY_FAILED: (message: string) =>
    createError(
      'K8S_WARM_POOL_DISCOVERY_FAILED',
      `Failed to discover existing warm pool pods: ${message}`,
      500
    ),
};
