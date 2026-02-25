/**
 * Result of a Nomad cluster health check (discriminated union on `healthy`)
 */
export type NomadHealthCheckResult =
  | {
      healthy: true;
      leader: string;
      version: string;
      namespaceExists: boolean;
      datacenter: string;
    }
  | {
      healthy: false;
      leader: string | null;
      version: string | null;
      namespaceExists: boolean;
      datacenter: string | null;
      error: string;
    };
