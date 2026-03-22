# Skill-Centric Task Architecture

Skills become the orchestration layer for tasks. Each task can reference a skill that defines *how* the task should be executed — driving agent behavior, delegating to sub-agents, and composing other skills.

## Specs

| Document | Description |
|----------|-------------|
| [skill-centric-tasks.md](skill-centric-tasks.md) | Core architecture: data model, API, UI, backward compatibility |
| [skill-resolution.md](skill-resolution.md) | How skills get onto the sandbox filesystem and how agents read them |
| [skill-orchestration.md](skill-orchestration.md) | Prompt directive, execution paths, plan approval flow |
| [skill-composition.md](skill-composition.md) | Skills referencing sub-skills, team mode, composition patterns |
| [data-model.md](data-model.md) | Schema changes, type definitions, validation schemas |

## Key Concepts

- **Skills are filesystem artifacts**: They live at `.claude/skills/{name}/SKILL.md` — either checked into the project git repo or materialized into the sandbox from org/template sources.
- **Lightweight prompt directive**: The prompt says `use skill {name}`. The agent reads the full skill content from disk using its `Read` tool.
- **Shared filesystem**: All agents in a sandbox (orchestrator + sub-agents) share `/workspace/.claude/skills/` and can read any skill.
- **Skill materialization**: Org/template skills not in the project repo are written to the sandbox filesystem before agent execution, similar to credential injection.
- **Natural language composition**: Skills reference other skills by name. The agent reads them from disk and follows instructions naturally.

## Design Principles

1. **Filesystem-first**: Skills are files, not prompt content. No prompt bloat. Agent reads on-demand.
2. **Lightweight directive**: `use skill {name}` — one line in the prompt, agent does the rest.
3. **Shared access**: All agents in the sandbox can read all skills. Sub-agents don't need skill content re-injected.
4. **Backward compatible**: `skillId` is nullable. Existing tasks work exactly as before.
5. **Live skills**: Agent reads from disk at execution time. Git updates are immediately visible.
6. **No persistence burden**: No skill content in `StoredPlanOptions`. Filesystem is the persistence layer.

## Default Skills Path

```
.claude/skills/{skillname}/SKILL.md
```

| Environment | Resolved Path |
|-------------|---------------|
| Host | `/path/to/project/.claude/skills/{name}/SKILL.md` |
| Container | `/workspace/.claude/skills/{name}/SKILL.md` |
| Worktree | `/workspace/.worktrees/{branch}/.claude/skills/{name}/SKILL.md` |
