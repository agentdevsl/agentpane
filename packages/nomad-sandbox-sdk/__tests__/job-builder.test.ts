import { describe, expect, it } from 'vitest';
import { NomadJobBuilder } from '../src/builders/job.js';
import { NOMAD_META } from '../src/constants.js';

describe('NomadJobBuilder', () => {
  // ----------------------------------------------------------------
  // Constructor defaults
  // ----------------------------------------------------------------
  describe('constructor', () => {
    it('sets ID and Name from constructor argument', () => {
      const job = new NomadJobBuilder('my-sandbox').image('ubuntu:22.04').build();
      expect(job.ID).toBe('my-sandbox');
      expect(job.Name).toBe('my-sandbox');
    });

    it('sets default type to service', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      expect(job.Type).toBe('service');
    });

    it('sets default datacenter to dc1', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      expect(job.Datacenters).toEqual(['dc1']);
    });

    it('sets default namespace to default', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      expect(job.Namespace).toBe('default');
    });

    it('sets default resources (CPU 500, Memory 256)', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      const task = job.TaskGroups[0].Tasks[0];
      expect(task.Resources).toEqual({ CPU: 500, MemoryMB: 256 });
    });

    it('sets default task name to sandbox', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      expect(job.TaskGroups[0].Tasks[0].Name).toBe('sandbox');
    });

    it('sets default group name to main with count 1', () => {
      const job = new NomadJobBuilder('test').image('alpine').build();
      expect(job.TaskGroups[0].Name).toBe('main');
      expect(job.TaskGroups[0].Count).toBe(1);
    });
  });

  // ----------------------------------------------------------------
  // Fluent setters
  // ----------------------------------------------------------------
  describe('fluent setters', () => {
    it('.namespace() sets the namespace', () => {
      const job = new NomadJobBuilder('test').namespace('engineering').image('alpine').build();
      expect(job.Namespace).toBe('engineering');
    });

    it('.datacenter() sets the datacenter', () => {
      const job = new NomadJobBuilder('test').datacenter('us-east-1').image('alpine').build();
      expect(job.Datacenters).toEqual(['us-east-1']);
    });

    it('.image() sets the Docker image', () => {
      const job = new NomadJobBuilder('test').image('node:20-slim').build();
      expect(job.TaskGroups[0].Tasks[0].Config?.image).toBe('node:20-slim');
    });

    it('.resources() sets CPU and memory', () => {
      const job = new NomadJobBuilder('test').image('alpine').resources(1000, 2048).build();
      expect(job.TaskGroups[0].Tasks[0].Resources).toEqual({
        CPU: 1000,
        MemoryMB: 2048,
      });
    });

    it('.env() sets environment variables', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .env({ NODE_ENV: 'production', PORT: '3000' })
        .build();
      expect(job.TaskGroups[0].Tasks[0].Env).toEqual({
        NODE_ENV: 'production',
        PORT: '3000',
      });
    });

    it('.env() merges with existing env variables', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .env({ A: '1' })
        .env({ B: '2' })
        .build();
      expect(job.TaskGroups[0].Tasks[0].Env).toEqual({ A: '1', B: '2' });
    });

    it('.meta() sets job-level meta keys', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .meta('owner', 'team-a')
        .meta('env', 'staging')
        .build();
      expect(job.Meta).toEqual({ owner: 'team-a', env: 'staging' });
    });

    it('.volumes() sets Docker volume mounts', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .volumes(['/host/src:/container/src', '/data:/data'])
        .build();
      expect(job.TaskGroups[0].Tasks[0].Config?.volumes).toEqual([
        '/host/src:/container/src',
        '/data:/data',
      ]);
    });

    it('.command() sets Docker command and args', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .command('/bin/sh', ['-c', 'echo hello'])
        .build();
      const config = job.TaskGroups[0].Tasks[0].Config;
      expect(config?.command).toBe('/bin/sh');
      expect(config?.args).toEqual(['-c', 'echo hello']);
    });

    it('.command() sets command without args', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .command('/usr/local/bin/start')
        .build();
      const config = job.TaskGroups[0].Tasks[0].Config;
      expect(config?.command).toBe('/usr/local/bin/start');
      expect(config?.args).toBeUndefined();
    });

    it('.constraint() adds a placement constraint', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Nomad HCL constraint syntax
        .constraint('${attr.kernel.name}', '=', 'linux')
        .build();
      expect(job.Constraints).toEqual([
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Nomad HCL constraint syntax
        { LTarget: '${attr.kernel.name}', Operand: '=', RTarget: 'linux' },
      ]);
    });

    it('.constraint() appends multiple constraints', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Nomad HCL constraint syntax
        .constraint('${attr.kernel.name}', '=', 'linux')
        // biome-ignore lint/suspicious/noTemplateCurlyInString: Nomad HCL constraint syntax
        .constraint('${attr.cpu.arch}', '=', 'amd64')
        .build();
      expect(job.Constraints).toHaveLength(2);
    });

    it('.agentPaneContext() sets meta keys for project, task, sandbox', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .agentPaneContext({
          projectId: 'proj-123',
          taskId: 'task-456',
          sandboxId: 'sandbox-789',
        })
        .build();
      expect(job.Meta?.[NOMAD_META.PROJECT_ID]).toBe('proj-123');
      expect(job.Meta?.[NOMAD_META.TASK_ID]).toBe('task-456');
      expect(job.Meta?.[NOMAD_META.SANDBOX_ID]).toBe('sandbox-789');
    });

    it('.agentPaneContext() only sets projectId when others are undefined', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .agentPaneContext({ projectId: 'proj-123' })
        .build();
      expect(job.Meta?.[NOMAD_META.PROJECT_ID]).toBe('proj-123');
      expect(job.Meta?.[NOMAD_META.TASK_ID]).toBeUndefined();
      expect(job.Meta?.[NOMAD_META.SANDBOX_ID]).toBeUndefined();
    });

    it('.type() sets the job type', () => {
      const job = new NomadJobBuilder('test').image('alpine').type('batch').build();
      expect(job.Type).toBe('batch');
    });

    it('.restartPolicy() sets restart policy on the group', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .restartPolicy({ attempts: 3, mode: 'delay' })
        .build();
      expect(job.TaskGroups[0].RestartPolicy).toEqual({
        Attempts: 3,
        Mode: 'delay',
      });
    });

    it('.restartPolicy() defaults mode to fail', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .restartPolicy({ attempts: 0 })
        .build();
      expect(job.TaskGroups[0].RestartPolicy).toEqual({
        Attempts: 0,
        Mode: 'fail',
      });
    });

    it('.restartPolicy() accepts interval and delay', () => {
      const job = new NomadJobBuilder('test')
        .image('alpine')
        .restartPolicy({ attempts: 2, mode: 'delay', interval: 300000000000, delay: 15000000000 })
        .build();
      expect(job.TaskGroups[0].RestartPolicy).toEqual({
        Attempts: 2,
        Mode: 'delay',
        Interval: 300000000000,
        Delay: 15000000000,
      });
    });

    it('.ephemeralDisk() sets the disk size', () => {
      const job = new NomadJobBuilder('test').image('alpine').ephemeralDisk(1024).build();
      expect(job.TaskGroups[0].EphemeralDisk).toEqual({ SizeMB: 1024 });
    });
  });

  // ----------------------------------------------------------------
  // Fluent chaining
  // ----------------------------------------------------------------
  describe('fluent chaining', () => {
    it('all setters return this for chaining', () => {
      const builder = new NomadJobBuilder('test');

      // Each method should return the same builder instance
      expect(builder.namespace('ns')).toBe(builder);
      expect(builder.datacenter('dc1')).toBe(builder);
      expect(builder.image('alpine')).toBe(builder);
      expect(builder.resources(500, 256)).toBe(builder);
      expect(builder.env({ A: '1' })).toBe(builder);
      expect(builder.meta('k', 'v')).toBe(builder);
      expect(builder.volumes([])).toBe(builder);
      expect(builder.command('/bin/sh')).toBe(builder);
      expect(builder.constraint('a', '=', 'b')).toBe(builder);
      expect(builder.agentPaneContext({ projectId: 'p1' })).toBe(builder);
      expect(builder.type('batch')).toBe(builder);
      expect(builder.restartPolicy({ attempts: 0 })).toBe(builder);
      expect(builder.ephemeralDisk(100)).toBe(builder);
    });
  });

  // ----------------------------------------------------------------
  // build() output structure
  // ----------------------------------------------------------------
  describe('build()', () => {
    it('produces correct NomadJob structure with lowercase Docker config keys', () => {
      const job = new NomadJobBuilder('sandbox-1')
        .namespace('agentpane')
        .datacenter('dc1')
        .image('ubuntu:22.04')
        .resources(1000, 512)
        .command('/bin/bash', ['-c', 'sleep infinity'])
        .volumes(['/workspace:/workspace'])
        .env({ TERM: 'xterm-256color' })
        .meta('owner', 'agentpane')
        .build();

      // Top-level
      expect(job.ID).toBe('sandbox-1');
      expect(job.Name).toBe('sandbox-1');
      expect(job.Type).toBe('service');
      expect(job.Namespace).toBe('agentpane');
      expect(job.Datacenters).toEqual(['dc1']);
      expect(job.Meta).toEqual({ owner: 'agentpane' });

      // TaskGroups
      expect(job.TaskGroups).toHaveLength(1);
      const group = job.TaskGroups[0];
      expect(group.Name).toBe('main');
      expect(group.Count).toBe(1);

      // Task
      expect(group.Tasks).toHaveLength(1);
      const task = group.Tasks[0];
      expect(task.Name).toBe('sandbox');
      expect(task.Driver).toBe('docker');
      expect(task.Resources).toEqual({ CPU: 1000, MemoryMB: 512 });
      expect(task.Env).toEqual({ TERM: 'xterm-256color' });

      // Docker config uses lowercase keys
      const config = task.Config!;
      expect(config.image).toBe('ubuntu:22.04');
      expect(config.command).toBe('/bin/bash');
      expect(config.args).toEqual(['-c', 'sleep infinity']);
      expect(config.volumes).toEqual(['/workspace:/workspace']);
    });

    it('throws when ID is missing (empty string)', () => {
      // Use object manipulation to clear the ID since the constructor always sets it
      const builder = new NomadJobBuilder('');
      builder.image('alpine');
      // The builder checks for !this.spec.ID which is falsy for empty string
      expect(() => builder.build()).toThrow('job ID is required');
    });

    it('throws when image is not set', () => {
      const builder = new NomadJobBuilder('test');
      // image is empty string by default, which is falsy
      expect(() => builder.build()).toThrow('Docker image is required');
    });
  });

  // ----------------------------------------------------------------
  // .volumes() security
  // ----------------------------------------------------------------
  describe('.volumes() security', () => {
    const builder = () => new NomadJobBuilder('test').image('ubuntu:22.04');

    it('should allow valid volume mount paths', () => {
      expect(() => builder().volumes(['/data/project:/workspace'])).not.toThrow();
    });

    it('should block root mount /', () => {
      expect(() => builder().volumes(['/:/host'])).toThrow('blocked for security');
    });

    it('should block /etc and paths under it', () => {
      expect(() => builder().volumes(['/etc:/host-etc'])).toThrow('blocked for security');
      expect(() => builder().volumes(['/etc/passwd:/passwd'])).toThrow('blocked for security');
    });

    it('should block /proc', () => {
      expect(() => builder().volumes(['/proc:/proc'])).toThrow('blocked for security');
    });

    it('should block /sys', () => {
      expect(() => builder().volumes(['/sys:/sys'])).toThrow('blocked for security');
    });

    it('should block /dev', () => {
      expect(() => builder().volumes(['/dev:/dev'])).toThrow('blocked for security');
    });

    it('should block /tmp', () => {
      expect(() => builder().volumes(['/tmp:/tmp'])).toThrow('blocked for security');
    });

    it('should block /var/tmp', () => {
      expect(() => builder().volumes(['/var/tmp:/var/tmp'])).toThrow('blocked for security');
    });

    it('should block /home and paths under it', () => {
      expect(() => builder().volumes(['/home:/home'])).toThrow('blocked for security');
      expect(() => builder().volumes(['/home/user/.ssh:/ssh'])).toThrow('blocked for security');
    });

    it('should block path traversal attempts', () => {
      expect(() => builder().volumes(['/data/../etc:/workspace'])).toThrow('blocked for security');
    });

    it('should block paths with repeated slashes', () => {
      expect(() => builder().volumes(['///etc:/workspace'])).toThrow('blocked for security');
    });

    it('should normalize paths before checking blocklist', () => {
      // /var/./tmp normalizes to /var/tmp which is blocked
      expect(() => builder().volumes(['/var/./tmp:/workspace'])).toThrow('blocked for security');
      // /data/safe/../../etc normalizes to /etc which is blocked
      expect(() => builder().volumes(['/data/safe/../../etc:/workspace'])).toThrow(
        'blocked for security'
      );
    });
  });
});
