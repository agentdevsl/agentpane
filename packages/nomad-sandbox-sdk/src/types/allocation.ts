import type { NomadAllocClientStatus, NomadTaskState } from './common.js';

/**
 * Desired status for an allocation
 */
export type NomadAllocDesiredStatus = 'run' | 'stop' | 'evict';

/**
 * Event that occurred during task execution
 */
export interface NomadTaskEvent {
  Type: string;
  Time: number;
  Message?: string;
  DisplayMessage?: string;
  Details?: Record<string, string>;
  FailsTask?: boolean;
  RestartReason?: string;
  SetupError?: string;
  DriverError?: string;
  DriverMessage?: string;
  ExitCode?: number;
  Signal?: number;
  KillReason?: string;
  KillTimeout?: number;
  KillError?: string;
  StartDelay?: number;
  DownloadError?: string;
  ValidationError?: string;
  TaskSignalReason?: string;
  TaskSignal?: string;
}

/**
 * State of a single task within an allocation
 */
export interface NomadTaskStateInfo {
  State: NomadTaskState;
  Failed: boolean;
  Restarts: number;
  LastRestart?: string;
  StartedAt?: string;
  FinishedAt?: string;
  Events: NomadTaskEvent[];
}

/**
 * Nomad allocation
 */
export interface NomadAllocation {
  ID: string;
  EvalID: string;
  Name: string;
  Namespace: string;
  NodeID: string;
  NodeName?: string;
  JobID: string;
  TaskGroup: string;
  ClientStatus: NomadAllocClientStatus;
  ClientDescription?: string;
  DesiredStatus: NomadAllocDesiredStatus;
  DesiredDescription?: string;
  TaskStates?: Record<string, NomadTaskStateInfo>;
  CreateIndex: number;
  ModifyIndex: number;
  CreateTime: number;
  ModifyTime: number;
}

/**
 * Resource usage statistics for a task
 */
export interface NomadTaskResourceUsage {
  CpuStats?: {
    SystemMode?: number;
    UserMode?: number;
    TotalTicks?: number;
    Percent?: number;
    ThrottledPeriods?: number;
    ThrottledTime?: number;
  };
  MemoryStats?: {
    RSS?: number;
    Cache?: number;
    Swap?: number;
    Usage?: number;
    MaxUsage?: number;
    KernelUsage?: number;
    KernelMaxUsage?: number;
  };
}

/**
 * Allocation resource usage statistics
 */
export interface NomadAllocStats {
  ResourceUsage?: NomadTaskResourceUsage;
  Tasks?: Record<string, { ResourceUsage?: NomadTaskResourceUsage }>;
  Timestamp: number;
}
