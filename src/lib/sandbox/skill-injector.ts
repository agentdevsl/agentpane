/**
 * Skill & Agent Injector for Sandboxes
 *
 * Materializes org/template skills and agents into the sandbox filesystem so the
 * Claude agent can discover them from `.claude/skills/` and `.claude/agents/`.
 *
 * - Skills: written to {workspace}/.claude/skills/{skillId}/SKILL.md
 * - Agents: written to {workspace}/.claude/agents/{agentName}.md
 *
 * Only items that don't already exist on disk are injected (idempotent).
 * Runs during container startup, after credentials injection.
 */

import type { MergedAgent, MergedSkill } from '../config/template-merge.js';
import { createLogger } from '../logging/logger.js';
import type { Sandbox } from './providers/sandbox-provider.js';

const log = createLogger('SkillInjector');

/** Only allow directory-safe characters in IDs/names */
const SAFE_NAME = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

// ---------------------------------------------------------------------------
// Shared types & helpers
// ---------------------------------------------------------------------------

export interface SkillInjectionResult {
  injected: number;
  skipped: number;
  errors: Array<{ skillId: string; message: string }>;
}

export interface AgentInjectionResult {
  injected: number;
  skipped: number;
  errors: Array<{ name: string; message: string }>;
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
 * List names in a sandbox directory, returning an empty set on failure.
 * When `stripSuffix` is provided (e.g. `.md`), it is removed from each entry.
 */
async function listExistingNames(
  sandbox: Sandbox,
  dir: string,
  stripSuffix?: string
): Promise<Set<string>> {
  try {
    const result = await sandbox.exec('ls', ['-1', dir]);
    if (result.exitCode !== 0) {
      log.debug('Directory listing failed (treating as empty)', {
        data: { dir, exitCode: result.exitCode, stderr: result.stderr },
      });
      return new Set();
    }
    const entries = result.stdout
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean);
    if (stripSuffix) {
      const re = new RegExp(`${stripSuffix.replace('.', '\\.')}$`);
      return new Set(entries.map((e) => e.replace(re, '')));
    }
    return new Set(entries);
  } catch (error) {
    log.warn('Failed to list directory in sandbox - treating all as missing', {
      data: { dir, error: error instanceof Error ? error.message : String(error) },
    });
    return new Set();
  }
}

/**
 * Base64-encode `content` and write it into the sandbox at `filePath`.
 * Creates parent directories as needed. Returns null on success or an
 * error message string on failure.
 */
async function writeBase64File(
  sandbox: Sandbox,
  filePath: string,
  content: string
): Promise<string | null> {
  const parentDir = filePath.replace(/\/[^/]+$/, '');
  const mkdirResult = await sandbox.exec('mkdir', ['-p', parentDir]);
  if (mkdirResult.exitCode !== 0) {
    return `Failed to create directory "${parentDir}": ${mkdirResult.stderr}`;
  }

  const encoded = Buffer.from(content).toString('base64');
  // Decode base64 into file, then verify non-empty (catches decode failures).
  // Avoid `set -o pipefail` - it's a bashism unsupported by dash/ash in K8s pods.
  const writeResult = await sandbox.exec('sh', [
    '-c',
    `printf '%s' "$1" | base64 -d > "$2" && test -s "$2"`,
    '--',
    encoded,
    filePath,
  ]);

  if (writeResult.exitCode !== 0) {
    return `Failed to write "${filePath}": ${writeResult.stderr}`;
  }

  return null;
}

// ---------------------------------------------------------------------------
// Skill injection
// ---------------------------------------------------------------------------

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
  const result: SkillInjectionResult = { injected: 0, skipped: 0, errors: [] };

  if (skills.length === 0) {
    log.debug('No skills to inject');
    return result;
  }

  const skillsDir = `${workspacePath}/.claude/skills`;
  const existing = await listExistingNames(sandbox, skillsDir);
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
    if (!SAFE_NAME.test(skill.id)) {
      const msg = `Unsafe skill ID rejected: "${skill.id}"`;
      log.error(msg, { data: { skillId: skill.id, skillName: skill.name } });
      result.errors.push({ skillId: skill.id, message: msg });
      continue;
    }

    const filePath = `${skillsDir}/${skill.id}/SKILL.md`;
    try {
      const writeError = await writeBase64File(sandbox, filePath, buildSkillMarkdown(skill));
      if (writeError) {
        log.error(writeError, { data: { skillId: skill.id } });
        result.errors.push({ skillId: skill.id, message: writeError });
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

  const existing = await listExistingNames(sandbox, agentsDir, '.md');
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

  for (const agent of toInject) {
    if (!SAFE_NAME.test(agent.name)) {
      const msg = `Unsafe agent name rejected: "${agent.name}"`;
      log.error(msg, { data: { name: agent.name } });
      result.errors.push({ name: agent.name, message: msg });
      continue;
    }

    const filePath = `${agentsDir}/${agent.name}.md`;

    try {
      const writeError = await writeBase64File(sandbox, filePath, buildAgentMarkdown(agent));
      if (writeError) {
        log.error(writeError, { data: { name: agent.name } });
        result.errors.push({ name: agent.name, message: writeError });
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
