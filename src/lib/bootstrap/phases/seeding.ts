import { createId } from '@paralleldrive/cuid2';
import { createError } from '../../errors/base.js';
import { err, ok } from '../../utils/result.js';
import type { BootstrapContext } from '../types.js';

/**
 * Seed a K8s sandbox config if none exists yet.
 * Runs independently so existing installs also get the K8s profile.
 */
function seedK8sSandboxConfig(ctx: BootstrapContext, now: string) {
  if (!ctx.db) return;
  try {
    const existing = ctx.db
      .prepare("SELECT id FROM sandbox_configs WHERE type = 'kubernetes' LIMIT 1")
      .all();
    if (existing.length > 0) return;

    ctx.db
      .prepare(
        `INSERT INTO sandbox_configs (id, name, description, type, is_default, base_image, memory_mb, cpu_cores, max_processes, timeout_minutes, kube_namespace, network_policy_enabled, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        createId(),
        'Kubernetes Standard',
        'Standard K8s pod for agent sandboxes',
        'kubernetes',
        0,
        'node:22-slim',
        4096,
        2.0,
        256,
        60,
        'agentpane-sandboxes',
        1,
        now,
        now
      );
  } catch {
    // Non-critical — skip silently
  }
}

export const seedDefaults = async (ctx: BootstrapContext) => {
  if (!ctx.db) {
    return err(createError('BOOTSTRAP_NO_DATABASE', 'Database not initialized', 500));
  }

  try {
    const now = new Date().toISOString();

    // Always ensure a K8s sandbox profile exists (idempotent)
    seedK8sSandboxConfig(ctx, now);

    // Use better-sqlite3 API (synchronous)
    const existingProjects = ctx.db.prepare('SELECT id FROM projects LIMIT 1').all();
    if (existingProjects.length > 0) {
      return ok(undefined);
    }

    const projectId = createId();

    ctx.db
      .prepare(`
      INSERT INTO projects (id, name, path, description, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?)
    `)
      .run(
        projectId,
        'Default Project',
        process.cwd(),
        'Default project created on first run',
        now,
        now
      );

    const agentId = createId();
    const agentConfig = JSON.stringify({
      allowedTools: ['Read', 'Edit', 'Bash', 'Glob', 'Grep'],
      maxTurns: 50,
    });

    ctx.db
      .prepare(`
      INSERT INTO agents (id, project_id, name, type, status, config, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `)
      .run(agentId, projectId, 'Default Agent', 'task', 'idle', agentConfig, now, now);

    return ok(undefined);
  } catch (error) {
    return err(
      createError('BOOTSTRAP_SEED_FAILED', 'Failed to seed defaults', 500, {
        error: String(error),
      })
    );
  }
};
