// Client

// Builder
export { NomadJobBuilder } from './builders/job.js';
export { NomadSandboxClient } from './client.js';
// Constants
export { NOMAD_DEFAULTS, NOMAD_JOB_PREFIX, NOMAD_META } from './constants.js';
// Errors
export {
  ConnectionError,
  ExecError,
  NomadApiError,
  NotFoundError,
  TimeoutError,
} from './errors.js';
// HTTP Client
export { NomadHttpClient } from './http.js';

// Operations
export { getAllocation, getAllocationStats, getJobAllocations } from './operations/allocations.js';
export { execInAllocation, execStreamInAllocation } from './operations/exec.js';
export { getJob, listJobs, registerJob, stopJob } from './operations/jobs.js';
export { waitForRunning } from './operations/lifecycle.js';
export type { WatchHandle, WatchJobCallback, WatchOptions } from './operations/watch.js';
export { watchJob } from './operations/watch.js';
// Types — allocation
export type {
  NomadAllocation,
  NomadAllocDesiredStatus,
  NomadAllocStats,
  NomadTaskEvent,
  NomadTaskResourceUsage,
  NomadTaskStateInfo,
} from './types/allocation.js';
// Types — common
export type {
  NomadAllocClientStatus,
  NomadClientOptions,
  NomadJobStatus,
  NomadTaskState,
} from './types/common.js';
// Types — exec
export type {
  ExecOptions,
  ExecResult,
  ExecStreamOptions,
  ExecStreamResult,
} from './types/exec.js';
// Types — health
export type { NomadHealthCheckResult } from './types/health.js';
// Types — job
export type {
  NomadConstraint,
  NomadDockerConfig,
  NomadJob,
  NomadJobListStub,
  NomadJobRegisterResponse,
  NomadNetworkResource,
  NomadResources,
  NomadTask,
  NomadTaskGroup,
} from './types/job.js';
