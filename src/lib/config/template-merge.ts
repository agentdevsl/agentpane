import type { CachedAgent, CachedCommand, CachedSkill, Template } from '../../db/schema';

/**
 * Merged configuration from multiple template sources
 */
export interface MergedTemplateConfig {
  skills: MergedSkill[];
  commands: MergedCommand[];
  agents: MergedAgent[];
}

export interface MergedSkill extends CachedSkill {
  sourceType: 'org' | 'project' | 'local';
  sourceId?: string;
  sourceName?: string;
}

export interface MergedCommand extends CachedCommand {
  sourceType: 'org' | 'project' | 'local';
  sourceId?: string;
  sourceName?: string;
}

export interface MergedAgent extends CachedAgent {
  sourceType: 'org' | 'project' | 'local';
  sourceId?: string;
  sourceName?: string;
}

/**
 * Local configuration content (from project's .claude directory)
 */
export interface LocalConfig {
  skills: CachedSkill[];
  commands: CachedCommand[];
  agents: CachedAgent[];
}

/**
 * Merge templates following precedence order:
 * 1. Local Project Config (highest)
 * 2. Project Templates
 * 3. Org Templates (lowest)
 *
 * Items with the same ID/name are overwritten by higher precedence sources.
 */
export function mergeTemplates(
  orgTemplates: Template[],
  projectTemplates: Template[],
  localConfig?: LocalConfig
): MergedTemplateConfig {
  // Use Maps to track items by ID/name, later entries overwrite earlier ones
  const skillsMap = new Map<string, MergedSkill>();
  const commandsMap = new Map<string, MergedCommand>();
  const agentsMap = new Map<string, MergedAgent>();

  // Process org templates (lowest precedence)
  for (const template of orgTemplates) {
    if (!template.cachedSkills && !template.cachedCommands && !template.cachedAgents) {
      continue;
    }

    // Add skills
    for (const skill of template.cachedSkills ?? []) {
      skillsMap.set(skill.id, {
        ...skill,
        sourceType: 'org',
        sourceId: template.id,
        sourceName: template.name,
      });
    }

    // Add commands
    for (const command of template.cachedCommands ?? []) {
      commandsMap.set(command.name, {
        ...command,
        sourceType: 'org',
        sourceId: template.id,
        sourceName: template.name,
      });
    }

    // Add agents
    for (const agent of template.cachedAgents ?? []) {
      agentsMap.set(agent.name, {
        ...agent,
        sourceType: 'org',
        sourceId: template.id,
        sourceName: template.name,
      });
    }
  }

  // Process project templates (higher precedence than org)
  for (const template of projectTemplates) {
    if (!template.cachedSkills && !template.cachedCommands && !template.cachedAgents) {
      continue;
    }

    // Add/overwrite skills
    for (const skill of template.cachedSkills ?? []) {
      skillsMap.set(skill.id, {
        ...skill,
        sourceType: 'project',
        sourceId: template.id,
        sourceName: template.name,
      });
    }

    // Add/overwrite commands
    for (const command of template.cachedCommands ?? []) {
      commandsMap.set(command.name, {
        ...command,
        sourceType: 'project',
        sourceId: template.id,
        sourceName: template.name,
      });
    }

    // Add/overwrite agents
    for (const agent of template.cachedAgents ?? []) {
      agentsMap.set(agent.name, {
        ...agent,
        sourceType: 'project',
        sourceId: template.id,
        sourceName: template.name,
      });
    }
  }

  // Process local config (highest precedence)
  if (localConfig) {
    for (const skill of localConfig.skills) {
      skillsMap.set(skill.id, {
        ...skill,
        sourceType: 'local',
      });
    }

    for (const command of localConfig.commands) {
      commandsMap.set(command.name, {
        ...command,
        sourceType: 'local',
      });
    }

    for (const agent of localConfig.agents) {
      agentsMap.set(agent.name, {
        ...agent,
        sourceType: 'local',
      });
    }
  }

  return {
    skills: Array.from(skillsMap.values()),
    commands: Array.from(commandsMap.values()),
    agents: Array.from(agentsMap.values()),
  };
}

export interface SourceCounts {
  org: { skills: number; commands: number; agents: number };
  project: { skills: number; commands: number; agents: number };
  local: { skills: number; commands: number; agents: number };
  total: { skills: number; commands: number; agents: number };
}

/**
 * Count items by source type from a merged template config.
 */
export function getSourceCounts(config: MergedTemplateConfig): SourceCounts {
  const count = (items: Array<{ sourceType: string }>, type: string) =>
    items.filter((i) => i.sourceType === type).length;

  return {
    org: {
      skills: count(config.skills, 'org'),
      commands: count(config.commands, 'org'),
      agents: count(config.agents, 'org'),
    },
    project: {
      skills: count(config.skills, 'project'),
      commands: count(config.commands, 'project'),
      agents: count(config.agents, 'project'),
    },
    local: {
      skills: count(config.skills, 'local'),
      commands: count(config.commands, 'local'),
      agents: count(config.agents, 'local'),
    },
    total: {
      skills: config.skills.length,
      commands: config.commands.length,
      agents: config.agents.length,
    },
  };
}
