/**
 * Agent Sandbox CRD API constants
 */
export const CRD_API = {
  /** API group for all Agent Sandbox CRDs */
  group: 'agents.x-k8s.io',

  /** Current API version */
  version: 'v1alpha1',

  /** Fully qualified apiVersion string */
  apiVersion: 'agents.x-k8s.io/v1alpha1',
} as const;

/**
 * Extensions group CRD API constants
 */
export const CRD_EXTENSIONS_API = {
  /** API group for extension CRDs */
  group: 'extensions.agents.x-k8s.io',

  /** Current API version */
  version: 'v1alpha1',

  /** Fully qualified apiVersion string */
  apiVersion: 'extensions.agents.x-k8s.io/v1alpha1',
} as const;

/**
 * Resource plurals for K8s API paths
 */
export const CRD_PLURALS = {
  sandbox: 'sandboxes',
  sandboxTemplate: 'sandboxtemplates',
  sandboxClaim: 'sandboxclaims',
  sandboxWarmPool: 'sandboxwarmpools',
} as const;

/**
 * Resource kinds
 */
export const CRD_KINDS = {
  sandbox: 'Sandbox',
  sandboxTemplate: 'SandboxTemplate',
  sandboxClaim: 'SandboxClaim',
  sandboxWarmPool: 'SandboxWarmPool',
} as const;

/**
 * Standard annotations used by the CRD controller
 */
export const CRD_ANNOTATIONS = {
  /** TTL for sandbox auto-cleanup (e.g. "1h", "30m") */
  ttl: 'agents.x-k8s.io/ttl',

  /** Pause reason annotation */
  pauseReason: 'agents.x-k8s.io/pause-reason',

  /** Creator identity */
  createdBy: 'agents.x-k8s.io/created-by',

  /** AgentPane-specific: sandbox ID mapping */
  sandboxId: 'agentpane.io/sandbox-id',

  /** AgentPane-specific: project ID mapping */
  projectId: 'agentpane.io/project-id',

  /** AgentPane-specific: task ID mapping */
  taskId: 'agentpane.io/task-id',
} as const;

/**
 * Standard condition types on Sandbox status
 */
export const CRD_CONDITIONS = {
  /** Sandbox is ready and accepting connections */
  ready: 'Ready',

  /** Pod is scheduled and running */
  podReady: 'PodReady',

  /** Network policy is applied */
  networkReady: 'NetworkReady',

  /** Storage (PVC) is bound */
  storageReady: 'StorageReady',

  /** Sandbox is paused */
  paused: 'Paused',

  /** Sandbox has expired (reason, not condition type) */
  expired: 'SandboxExpired',
} as const;

/**
 * Standard labels applied by the controller
 */
export const CRD_LABELS = {
  /** Managed by agentpane */
  managed: 'agentpane.io/managed',

  /** Sandbox marker */
  sandbox: 'agentpane.io/sandbox',

  /** Project association */
  projectId: 'agentpane.io/project-id',

  /** Warm pool membership */
  warmPool: 'agentpane.io/warm-pool',

  /** Warm pool state */
  warmPoolState: 'agentpane.io/warm-pool-state',

  /** Claim UID association */
  claimUid: 'agents.x-k8s.io/claim-uid',
} as const;
