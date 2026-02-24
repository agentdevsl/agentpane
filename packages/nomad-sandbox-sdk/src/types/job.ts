import type { NomadJobStatus } from './common.js';

/**
 * Docker driver configuration for a Nomad task
 */
export interface NomadDockerConfig {
  image: string;
  args?: string[];
  command?: string;
  volumes?: string[];
  port_map?: Record<string, number>;
}

/**
 * Resource requirements for a Nomad task
 */
export interface NomadResources {
  CPU: number;
  MemoryMB: number;
  DiskMB?: number;
}

/**
 * Constraint for job/group/task placement
 */
export interface NomadConstraint {
  LTarget?: string;
  RTarget?: string;
  Operand: string;
}

/**
 * Network configuration for a task group
 */
export interface NomadNetworkResource {
  Mode?: string;
  DynamicPorts?: Array<{ Label: string; To?: number }>;
  ReservedPorts?: Array<{ Label: string; Value: number; To?: number }>;
}

/**
 * Environment variables and config for a task
 */
export interface NomadTask {
  Name: string;
  Driver: 'docker';
  Config?: NomadDockerConfig;
  Resources?: NomadResources;
  Env?: Record<string, string>;
  Meta?: Record<string, string>;
  Constraints?: NomadConstraint[];
  Leader?: boolean;
}

/**
 * Task group within a job
 */
export interface NomadTaskGroup {
  Name: string;
  Count?: number;
  Tasks: NomadTask[];
  Networks?: NomadNetworkResource[];
  Constraints?: NomadConstraint[];
  RestartPolicy?: {
    Attempts?: number;
    Interval?: number;
    Delay?: number;
    Mode?: 'delay' | 'fail';
  };
  EphemeralDisk?: {
    SizeMB?: number;
    Sticky?: boolean;
    Migrate?: boolean;
  };
}

/**
 * Full Nomad job specification
 */
export interface NomadJob {
  ID: string;
  Name: string;
  Type?: 'service' | 'batch' | 'system' | 'sysbatch';
  Namespace?: string;
  Region?: string;
  Datacenters?: string[];
  Meta?: Record<string, string>;
  Constraints?: NomadConstraint[];
  TaskGroups: NomadTaskGroup[];
  Status?: NomadJobStatus;
  StatusDescription?: string;
  CreateIndex?: number;
  ModifyIndex?: number;
  JobModifyIndex?: number;
}

/**
 * Response from job registration
 */
export interface NomadJobRegisterResponse {
  EvalID: string;
  EvalCreateIndex?: number;
  JobModifyIndex?: number;
  Warnings?: string;
  Index?: number;
}

/**
 * Job list stub (returned by list endpoint)
 */
export interface NomadJobListStub {
  ID: string;
  Name: string;
  Namespace: string;
  Type?: 'service' | 'batch' | 'system' | 'sysbatch';
  Status: NomadJobStatus;
  StatusDescription: string;
  CreateIndex: number;
  ModifyIndex: number;
  JobModifyIndex: number;
  Meta?: Record<string, string>;
}
