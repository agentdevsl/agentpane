/**
 * Options for creating a Nomad HTTP client
 */
export interface NomadClientOptions {
  /** Nomad HTTP address (default: http://127.0.0.1:4646) */
  address?: string;
  /** ACL token for authentication */
  token?: string;
  /** Default namespace (default: 'default') */
  namespace?: string;
  /** Region to target */
  region?: string;
}

/**
 * Nomad job status
 */
export type NomadJobStatus = 'pending' | 'running' | 'dead';

/**
 * Nomad allocation client status
 */
export type NomadAllocClientStatus = 'pending' | 'running' | 'complete' | 'failed' | 'lost';

/**
 * Nomad task state
 */
export type NomadTaskState = 'pending' | 'running' | 'dead';
