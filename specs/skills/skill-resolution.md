# Skill Resolution Pipeline

## Overview

Skills are **filesystem artifacts**. They live at a well-known default path and the agent reads them directly from disk. The system does not inject skill content into the prompt — it tells the agent which skill to use, and the agent reads it.

## Default Skills Path

```
.claude/skills/{skillname}/SKILL.md
```

Inside the sandbox container, this resolves to:

```
/workspace/.claude/skills/{skillname}/SKILL.md
```

Since the project directory is bind-mounted to `/workspace` (`docker-provider.ts` line 524-528), any skills checked into the project's git repo are automatically available at this path.

## Skill Sources

Skills can arrive in the sandbox filesystem from two sources:

### Source 1: Project Git Repository (Local Skills)

Skills checked into the project's `.claude/skills/` directory are automatically available because the project is mounted at `/workspace`. No additional action needed.

```
Host:      /Users/user/project/.claude/skills/terraform-stacks/SKILL.md
Container: /workspace/.claude/skills/terraform-stacks/SKILL.md
```

These are the simplest case — they're version-controlled with the project and always in sync.

### Source 2: Org/Template Skills (Materialized)

Skills from org or project templates (synced from external git repos) are NOT in the project's git repo. They must be **materialized** — written to the sandbox filesystem at the default skills path before agent execution.

This is analogous to how credentials are injected (`src/lib/sandbox/credentials-injector.ts`):

```
Skill Injection Flow:
1. Resolve merged skills from templateService.getMergedConfig(codespaceId)
2. Filter to skills NOT already present in project's .claude/skills/
3. Write each skill to /workspace/.claude/skills/{skillId}/SKILL.md in the sandbox
4. Agent now sees all skills (local + materialized) at the same path
```

#### Skill Injector Service

New service: `src/lib/sandbox/skill-injector.ts`

```typescript
interface SkillInjectorOptions {
  sandbox: SandboxInstance;
  codespaceId: string;
  templateService: TemplateService;
}

async function injectSkills(options: SkillInjectorOptions): Promise<void>
```

This runs as a new stage between "credentials" and "executing" in the container startup flow:

```
initializing → validating → credentials → injecting_skills → creating_sandbox → executing → running
```

#### Materialization Rules

| Condition | Action |
|-----------|--------|
| Skill exists in project git AND in template | Project version wins (already on disk) |
| Skill exists only in template | Write to `/workspace/.claude/skills/{id}/SKILL.md` |
| Skill exists only in project git | Already available, no action |
| Skill was materialized but template updated | Re-materialize on next execution |

#### Writing Skills to the Sandbox

Use the same exec-based file writing pattern as `credentials-injector.ts`:

```typescript
// Write SKILL.md content to the container filesystem
const content = Buffer.from(skill.content).toString('base64');
await sandbox.exec([
  'bash', '-c',
  `mkdir -p /workspace/.claude/skills/${skill.id} && echo "${content}" | base64 -d > /workspace/.claude/skills/${skill.id}/SKILL.md`
]);
```

Also write frontmatter metadata so the agent can discover skill name/description:

```markdown
---
name: terraform-stacks
description: Comprehensive guide for working with HashiCorp Terraform Stacks
source: org-template
---

{skill content body}
```

#### Cleanup

Materialized skills are NOT committed to git. They exist only in the container's writable layer on top of the bind mount. When the container is recreated, they're gone. This is correct — they're injected fresh each time from the current template state.

**Important**: Materialized files should NOT appear in the agent's git diff. To prevent this, add `/workspace/.claude/skills/.materialized` marker and configure `.gitignore` in the container, or write materialized skills to a separate overlay path.

**Recommended approach**: Write materialized skills to `/home/node/.claude/skills/` (outside `/workspace`) and configure the agent's `CLAUDE_SKILLS_PATH` or equivalent to search both paths. Alternatively, use a `.gitignore` entry.

## Resolution at the Agent Level

The agent resolves skills by reading from the filesystem. When the prompt says `use skill terraform-stacks`, the agent:

1. Reads `/workspace/.claude/skills/terraform-stacks/SKILL.md`
2. Parses the frontmatter for metadata
3. Follows the skill's instructions as its operating mode

This is identical to how Claude Code resolves skills locally — the agent uses its `Read` tool to access the file.

## Skill Discovery

The agent can discover available skills by listing the skills directory:

```
ls /workspace/.claude/skills/
```

This returns all skill directories (both local and materialized). The agent can then read individual SKILL.md files to understand what's available.

For the UI (skill picker), the existing template merge pipeline is still used — the API endpoint `GET /api/codespaces/:id/skills` returns merged skills from templates. The filesystem is the agent's view; the API is the UI's view.

## Dangling Skill References

If a task references a `skillId` that doesn't exist on the filesystem:

### At Execution Time

The prompt says `use skill {skillname}`. The agent tries to read the file:
- If the file exists → agent follows the skill's instructions
- If the file doesn't exist → agent reports it can't find the skill and proceeds with the task using its own judgment (equivalent to generic execution)

No system-level fallback is needed — the agent handles missing files naturally.

### In the UI

- Kanban card: Show the denormalized `skillName` with a subtle warning indicator
- Task detail: Show "Skill not found" message with option to reassign or remove

### No Auto-Cleanup

The `skillId` stays on the task until manually updated. The skill might be temporarily missing (branch switch, sync error) and could return.

## Skill Tags

Skills support an optional `tags` field for categorization and filtering.

### Frontmatter Format

Tags are declared as a comma-separated string in SKILL.md frontmatter:

```yaml
---
name: terraform-stacks
description: Guide for Terraform Stacks
tags: terraform, infrastructure, stacks
---
```

### Data Model

- Stored as `tags?: string[]` on the `CachedSkill` type (both SQLite and PostgreSQL schemas)
- `MergedSkill` inherits `tags` from `CachedSkill` automatically
- Parsed during template sync: comma-separated string is split, trimmed, and stored as an array
- Returned from both `GET /:id/skills` (list) and `GET /:id/skills/:skillId` (detail) endpoints

### UI Filtering

The skill picker collects all unique tags from fetched skills and displays them as filter chips:

- Clicking a tag chip toggles it on/off
- Multiple tags can be selected simultaneously (AND logic: show skills matching ALL selected tags)
- Each skill item displays its tags as small badges
- Tag filters reset when the codespace changes

### Materialization

When skills are materialized into sandbox containers via the skill injector, tags are included in the generated SKILL.md frontmatter:

```yaml
---
name: "terraform-stacks"
description: "Guide for Terraform Stacks"
tags: terraform, infrastructure, stacks
source: org
---
```

## Skills for Codespace Endpoint

To power the skill picker UI:

**GET /api/codespaces/:id/skills** — Returns merged skills list:
1. Call `templateService.getMergedConfig(codespaceId)` for template skills
2. Also scan the project's `.claude/skills/` directory for local skills not in templates
3. Merge and deduplicate
4. Return `{ id, name, description, tags, sourceType }` sorted by name

**GET /api/codespaces/:id/skills/:skillId** — Returns full skill content:
1. Try template merge first
2. Fall back to reading from project's `.claude/skills/{skillId}/SKILL.md`
3. 404 if not found

## Resolution in Different Execution Paths

### Container Path (Docker/K8s/Nomad)

- Skills are at `/workspace/.claude/skills/` (bind mount)
- Org/template skills materialized by skill injector before execution
- Agent reads skills via filesystem — no prompt delivery needed

### AgentCore Path (Bedrock)

- Remote runtime has no access to the host filesystem
- Skills must be included in the invoke prompt (full content, not just directive)
- This is the ONE path where skill content is embedded in the prompt
- `buildTaskPrompt` detects AgentCore mode and embeds skill content

### Host-Mode Path

- Agent runs on the host with direct filesystem access
- Skills at the project's `.claude/skills/` directory
- Agent reads skills via filesystem — same as container path

## Worktree Considerations

When a worktree is created for task isolation, the `.claude/skills/` directory from the main branch is available in the worktree (git worktrees share the working tree structure). Skills are not branch-specific — they're configuration, not code.

If a worktree is created in a subdirectory (e.g., `/workspace/.worktrees/feature-x/`), the agent's CWD is set to that path. Skills would be at `/workspace/.worktrees/feature-x/.claude/skills/`. Since `.claude/` is typically in the project root and worktrees include it, this works automatically.
