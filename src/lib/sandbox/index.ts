// Types

// Credentials Injector
export {
  CredentialsInjector,
  createCredentialsInjector,
  loadHostCredentials,
} from './credentials-injector.js';
export { AgentSandboxInstance } from './providers/agent-sandbox-instance.js';

// Agent Sandbox Provider (Phase 2 — CRD-based)
export {
  AgentSandboxProvider,
  createAgentSandboxProvider,
} from './providers/agent-sandbox-provider.js';
// Docker Provider
export { createDockerProvider, DockerProvider } from './providers/docker-provider.js';

// Nomad Provider
export { NomadSandboxInstance } from './providers/nomad-sandbox-instance.js';
export {
  createNomadSandboxProvider,
  NomadSandboxProvider,
} from './providers/nomad-sandbox-provider.js';

// Provider Interface
export type {
  EventEmittingSandboxProvider,
  Sandbox,
  SandboxProvider,
  SandboxProviderEvent,
  SandboxProviderEventListener,
} from './providers/sandbox-provider.js';
// tmux Manager
export type { CreateTmuxSessionOptions, TmuxExecOptions } from './tmux-manager.js';
export { createTmuxManager, TmuxManager } from './tmux-manager.js';
export type {
  CodespaceSandboxConfig,
  ExecResult,
  OAuthCredentials,
  SandboxConfig,
  SandboxHealthCheck,
  SandboxInfo,
  SandboxMetrics,
  SandboxStatus,
  TmuxSession,
  VolumeMountConfig,
} from './types.js';
export {
  projectSandboxConfigSchema,
  SANDBOX_DEFAULTS,
  sandboxConfigSchema,
  volumeMountConfigSchema,
} from './types.js';
