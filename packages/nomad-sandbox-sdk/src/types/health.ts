/**
 * Result of a Nomad cluster health check
 */
export interface NomadHealthCheckResult {
  /** Whether the cluster is healthy and reachable */
  healthy: boolean;
  /** Leader address, or null if no leader */
  leader: string | null;
  /** Nomad version, or null if unreachable */
  version: string | null;
  /** Whether the configured namespace exists */
  namespaceExists: boolean;
  /** Datacenter name, or null if unreachable */
  datacenter: string | null;
}
