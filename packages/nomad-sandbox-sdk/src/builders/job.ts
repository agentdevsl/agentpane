import { NOMAD_DEFAULTS, NOMAD_META } from '../constants.js';
import type { NomadJob, NomadTask, NomadTaskGroup } from '../types/job.js';

/**
 * Fluent builder for creating Nomad job specifications.
 *
 * @example
 * ```ts
 * const job = new NomadJobBuilder('my-sandbox')
 *   .namespace('agentpane')
 *   .datacenter('dc1')
 *   .image('ubuntu:22.04')
 *   .resources(500, 512)
 *   .env({ NODE_ENV: 'production' })
 *   .meta(NOMAD_META.PROJECT_ID, 'proj-123')
 *   .volumes(['/host/path:/container/path'])
 *   .build();
 * ```
 */
export class NomadJobBuilder {
  private spec: Partial<NomadJob>;
  private taskSpec: Partial<NomadTask>;
  private groupSpec: Partial<NomadTaskGroup>;

  constructor(name: string) {
    this.spec = {
      ID: name,
      Name: name,
      Type: 'service',
      Datacenters: [NOMAD_DEFAULTS.datacenter],
      Namespace: NOMAD_DEFAULTS.namespace,
      Meta: {},
    };
    this.taskSpec = {
      Name: 'sandbox',
      Driver: 'docker',
      Config: { Image: '' },
      Resources: { CPU: 500, MemoryMB: 256 },
      Env: {},
      Meta: {},
    };
    this.groupSpec = {
      Name: 'main',
      Count: 1,
    };
  }

  /** Set the Nomad namespace */
  namespace(ns: string): this {
    this.spec.Namespace = ns;
    return this;
  }

  /** Set the datacenter */
  datacenter(dc: string): this {
    this.spec.Datacenters = [dc];
    return this;
  }

  /** Set the Docker image */
  image(img: string): this {
    if (!this.taskSpec.Config) {
      this.taskSpec.Config = { Image: img };
    } else {
      this.taskSpec.Config.Image = img;
    }
    return this;
  }

  /** Set CPU (MHz) and memory (MB) resources */
  resources(cpu: number, memoryMb: number): this {
    this.taskSpec.Resources = { CPU: cpu, MemoryMB: memoryMb };
    return this;
  }

  /** Set environment variables on the task */
  env(vars: Record<string, string>): this {
    this.taskSpec.Env = { ...this.taskSpec.Env, ...vars };
    return this;
  }

  /** Set job-level meta key */
  meta(key: string, value: string): this {
    if (!this.spec.Meta) this.spec.Meta = {};
    this.spec.Meta[key] = value;
    return this;
  }

  /** Set Docker volume mounts */
  volumes(mounts: string[]): this {
    if (!this.taskSpec.Config) {
      this.taskSpec.Config = { Image: '', Volumes: mounts };
    } else {
      this.taskSpec.Config.Volumes = mounts;
    }
    return this;
  }

  /** Set the Docker command and optional args */
  command(cmd: string, args?: string[]): this {
    if (!this.taskSpec.Config) {
      this.taskSpec.Config = { Image: '', Command: cmd, Args: args };
    } else {
      this.taskSpec.Config.Command = cmd;
      if (args) this.taskSpec.Config.Args = args;
    }
    return this;
  }

  /** Add a placement constraint */
  constraint(attribute: string, operator: string, value: string): this {
    if (!this.spec.Constraints) this.spec.Constraints = [];
    this.spec.Constraints.push({
      LTarget: attribute,
      Operand: operator,
      RTarget: value,
    });
    return this;
  }

  /** Set AgentPane context meta keys */
  agentPaneContext(ctx: { projectId: string; taskId?: string; sandboxId?: string }): this {
    this.meta(NOMAD_META.PROJECT_ID, ctx.projectId);
    if (ctx.taskId) this.meta(NOMAD_META.TASK_ID, ctx.taskId);
    if (ctx.sandboxId) this.meta(NOMAD_META.SANDBOX_ID, ctx.sandboxId);
    return this;
  }

  /** Set the job type (default: 'service') */
  type(jobType: 'service' | 'batch' | 'system' | 'sysbatch'): this {
    this.spec.Type = jobType;
    return this;
  }

  /** Set the restart policy */
  restartPolicy(attempts: number, mode: 'delay' | 'fail' = 'fail'): this {
    this.groupSpec.RestartPolicy = { Attempts: attempts, Mode: mode };
    return this;
  }

  /** Set ephemeral disk size */
  ephemeralDisk(sizeMb: number): this {
    this.groupSpec.EphemeralDisk = { SizeMB: sizeMb };
    return this;
  }

  /**
   * Build the complete Nomad job specification.
   */
  build(): NomadJob {
    const task: NomadTask = {
      Name: this.taskSpec.Name ?? 'sandbox',
      Driver: this.taskSpec.Driver ?? 'docker',
      Config: this.taskSpec.Config,
      Resources: this.taskSpec.Resources,
      Env: this.taskSpec.Env,
      Meta: this.taskSpec.Meta,
      Constraints: this.taskSpec.Constraints,
    };

    const group: NomadTaskGroup = {
      Name: this.groupSpec.Name ?? 'main',
      Count: this.groupSpec.Count ?? 1,
      Tasks: [task],
      RestartPolicy: this.groupSpec.RestartPolicy,
      EphemeralDisk: this.groupSpec.EphemeralDisk,
      Networks: this.groupSpec.Networks,
      Constraints: this.groupSpec.Constraints,
    };

    return {
      ID: this.spec.ID ?? '',
      Name: this.spec.Name ?? '',
      Type: this.spec.Type,
      Namespace: this.spec.Namespace,
      Datacenters: this.spec.Datacenters,
      Meta: this.spec.Meta,
      Constraints: this.spec.Constraints,
      TaskGroups: [group],
    };
  }
}
