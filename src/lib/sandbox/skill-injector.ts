/**
 * Skill Injector for Sandboxes
 *
 * Materializes org/template skills into the sandbox filesystem so the agent
 * can read them from `.claude/skills/`. Skills from templates that don't already
 * exist in the project's .claude/skills/ are written to
 * /workspace/.claude/skills/{skillId}/SKILL.md.
 *
 * This runs during container startup, after credentials injection.
 */

import type { MergedAgent, MergedSkill } from '../config/template-merge.js';
import { createLogger } from '../logging/logger.js';
import type { Sandbox } from './providers/sandbox-provider.js';

const log = createLogger('SkillInjector');

/** Only allow directory-safe characters in skill IDs */
const SAFE_SKILL_ID = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface SkillInjectionResult {
  injected: number;
  skipped: number;
  errors: Array<{ skillId: string; message: string }>;
}

/**
 * Escape a string for use as a YAML double-quoted value.
 */
function escapeYamlValue(value: string): string {
  return value
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/\n/g, '\\n')
    .replace(/\r/g, '\\r');
}

/**
 * Build SKILL.md content with frontmatter metadata and skill body.
 */
function buildSkillMarkdown(skill: MergedSkill): string {
  const lines = ['---'];
  lines.push(`name: "${escapeYamlValue(skill.name)}"`);
  if (skill.description) {
    lines.push(`description: "${escapeYamlValue(skill.description)}"`);
  }
  if (skill.tags && skill.tags.length > 0) {
    lines.push(`tags: ${skill.tags.join(', ')}`);
  }
  lines.push(`source: ${skill.sourceType}`);
  lines.push('---');
  lines.push(skill.content);
  return lines.join('\n');
}

/**
 * List existing skill directory names in the workspace.
 * Returns an empty set if the directory doesn't exist yet.
 */
async function listExistingSkills(sandbox: Sandbox, skillsDir: string): Promise<Set<string>> {
  try {
    const result = await sandbox.exec('ls', ['-1', skillsDir]);
    if (result.exitCode !== 0) {
      // Directory likely doesn't exist — treat as empty
      log.debug('Skills directory listing failed (treating as empty)', {
        data: { skillsDir, exitCode: result.exitCode, stderr: result.stderr },
      });
      return new Set();
    }
    const names = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    return new Set(names);
  } catch (error) {
    log.warn('Failed to list existing skills in sandbox — treating all as missing', {
      data: {
        skillsDir,
        error: error instanceof Error ? error.message : String(error),
      },
    });
    return new Set();
  }
}

/**
 * Materialize org/template skills into the sandbox filesystem.
 *
 * Skills from templates that don't already exist in the project's .claude/skills/
 * are written to {workspacePath}/.claude/skills/{skill.id}/SKILL.md.
 *
 * This is non-fatal — if injection fails for a skill, the rest continue.
 */
export async function injectSkills(
  sandbox: Sandbox,
  skills: MergedSkill[],
  workspacePath = '/workspace'
): Promise<SkillInjectionResult> {
  const result: SkillInjectionResult = {
    injected: 0,
    skipped: 0,
    errors: [],
  };

  if (skills.length === 0) {
    log.debug('No skills to inject');
    return result;
  }

  const skillsDir = `${workspacePath}/.claude/skills`;

  // Discover which skills already exist on disk
  const existing = await listExistingSkills(sandbox, skillsDir);

  // Filter to skills not already present
  const toInject = skills.filter((s) => !existing.has(s.id));
  result.skipped = skills.length - toInject.length;

  if (toInject.length === 0) {
    log.info('All skills already present on disk', {
      data: { total: skills.length, skipped: result.skipped },
    });
    return result;
  }

  log.info('Injecting skills into sandbox', {
    data: { total: skills.length, toInject: toInject.length, skipped: result.skipped },
  });

  for (const skill of toInject) {
    // Validate skill ID for filesystem safety
    if (!SAFE_SKILL_ID.test(skill.id)) {
      const msg = `Unsafe skill ID rejected: "${skill.id}"`;
      log.error(msg, { data: { skillId: skill.id, skillName: skill.name } });
      result.errors.push({ skillId: skill.id, message: msg });
      continue;
    }

    const skillDir = `${skillsDir}/${skill.id}`;
    const skillFilePath = `${skillDir}/SKILL.md`;

    try {
      // Create skill directory — use exec without sh -c to avoid shell metacharacters
      const mkdirResult = await sandbox.exec('mkdir', ['-p', skillDir]);

      if (mkdirResult.exitCode !== 0) {
        const msg = `Failed to create directory at "${skillDir}": ${mkdirResult.stderr}`;
        log.error(msg, { data: { skillId: skill.id, skillDir, exitCode: mkdirResult.exitCode } });
        result.errors.push({ skillId: skill.id, message: msg });
        continue;
      }

      // Build content and base64-encode to prevent shell injection
      const content = buildSkillMarkdown(skill);
      const encoded = Buffer.from(content).toString('base64');

      // Decode base64 into file, then verify non-empty (catches decode failures).
      // Avoid `set -o pipefail` — it's a bashism unsupported by dash/ash in K8s pods.
      const writeResult = await sandbox.exec('sh', [
        '-c',
        `printf '%s' "$1" | base64 -d > "$2" && test -s "$2"`,
        '--',
        encoded,
        skillFilePath,
      ]);

      if (writeResult.exitCode !== 0) {
        const msg = `Failed to write SKILL.md for "${skill.name}" at "${skillFilePath}": ${writeResult.stderr}`;
        log.error(msg, {
          data: { skillId: skill.id, skillFilePath, exitCode: writeResult.exitCode },
        });
        result.errors.push({ skillId: skill.id, message: msg });
        continue;
      }

      log.info('Injected skill', {
        data: { skillId: skill.id, name: skill.name, source: skill.sourceType },
      });
      result.injected++;
    } catch (error) {
      const msg = `Unexpected error injecting skill "${skill.name}": ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { data: { skillId: skill.id } });
      result.errors.push({ skillId: skill.id, message: msg });
    }
  }

  log.info('Skill injection complete', {
    data: { injected: result.injected, skipped: result.skipped, errors: result.errors.length },
  });

  return result;
}

/** Only allow directory-safe characters in agent names */
const SAFE_AGENT_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

export interface AgentInjectionResult {
  injected: number;
  skipped: number;
  errors: Array<{ name: string; message: string }>;
}

/**
 * Build agent .md content with frontmatter metadata and agent body.
 */
function buildAgentMarkdown(agent: MergedAgent): string {
  const lines = ['---'];
  lines.push(`name: "${escapeYamlValue(agent.name)}"`);
  if (agent.description) {
    lines.push(`description: "${escapeYamlValue(agent.description)}"`);
  }
  lines.push(`source: ${agent.sourceType}`);
  lines.push('---');
  lines.push(agent.content);
  return lines.join('\n');
}

/**
 * Materialize org/template agents into the sandbox filesystem.
 *
 * Agents from templates that don't already exist in the project's .claude/agents/
 * are written to {workspacePath}/.claude/agents/{agent.name}.md.
 *
 * This is non-fatal — if injection fails for an agent, the rest continue.
 */
export async function injectAgents(
  sandbox: Sandbox,
  agents: MergedAgent[],
  workspacePath = '/workspace'
): Promise<AgentInjectionResult> {
  const result: AgentInjectionResult = {
    injected: 0,
    skipped: 0,
    errors: [],
  };

  if (agents.length === 0) {
    log.debug('No agents to inject');
    return result;
  }

  const agentsDir = `${workspacePath}/.claude/agents`;

  // Check which agents already exist
  let existing: Set<string>;
  try {
    const ls = await sandbox.exec('ls', ['-1', agentsDir]);
    existing =
      ls.exitCode === 0
        ? new Set(
            ls.stdout
              .split('\n')
              .map((s) => s.trim().replace(/\.md$/, ''))
              .filter(Boolean)
          )
        : new Set();
  } catch {
    existing = new Set();
  }

  const toInject = agents.filter((a) => !existing.has(a.name));
  result.skipped = agents.length - toInject.length;

  if (toInject.length === 0) {
    log.info('All agents already present on disk', {
      data: { total: agents.length, skipped: result.skipped },
    });
    return result;
  }

  log.info('Injecting agents into sandbox', {
    data: { total: agents.length, toInject: toInject.length, skipped: result.skipped },
  });

  // Ensure agents directory exists
  await sandbox.exec('mkdir', ['-p', agentsDir]);

  for (const agent of toInject) {
    if (!SAFE_AGENT_NAME.test(agent.name)) {
      const msg = `Unsafe agent name rejected: "${agent.name}"`;
      log.error(msg, { data: { name: agent.name } });
      result.errors.push({ name: agent.name, message: msg });
      continue;
    }

    const filePath = `${agentsDir}/${agent.name}.md`;

    try {
      const content = buildAgentMarkdown(agent);
      const encoded = Buffer.from(content).toString('base64');

      const writeResult = await sandbox.exec('sh', [
        '-c',
        `printf '%s' "$1" | base64 -d > "$2" && test -s "$2"`,
        '--',
        encoded,
        filePath,
      ]);

      if (writeResult.exitCode !== 0) {
        const msg = `Failed to write agent "${agent.name}" at "${filePath}": ${writeResult.stderr}`;
        log.error(msg, { data: { name: agent.name, exitCode: writeResult.exitCode } });
        result.errors.push({ name: agent.name, message: msg });
        continue;
      }

      log.info('Injected agent', {
        data: { name: agent.name, source: agent.sourceType },
      });
      result.injected++;
    } catch (error) {
      const msg = `Unexpected error injecting agent "${agent.name}": ${error instanceof Error ? error.message : String(error)}`;
      log.error(msg, { data: { name: agent.name } });
      result.errors.push({ name: agent.name, message: msg });
    }
  }

  log.info('Agent injection complete', {
    data: { injected: result.injected, skipped: result.skipped, errors: result.errors.length },
  });

  return result;
}
