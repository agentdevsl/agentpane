# Skill Composition: Skills Invoking Sub-Skills

## Overview

Skills can reference and invoke other skills. Since all skills live on the filesystem at `.claude/skills/`, the agent can read any skill on-demand. Composition is **natural language** — skills reference other skills by name, and the agent reads them from disk.

## Composition Model

### Directive-Based References

A skill's SKILL.md can reference other skills by name:

```markdown
# Feature Implementation Skill

## Workflow

1. **Plan**: Analyze the task requirements and create an implementation plan
2. **Implement**: `use skill implement-validate` for code implementation
3. **Test**: `use skill terraform-test` to validate infrastructure changes
4. **Review**: Review all changes for consistency and completeness

## Sub-Agent Delegation

When working in team mode, assign sub-agents:
- Infrastructure changes → `use skill terraform-stacks`
- Code implementation → `use skill implement-validate`
- Test execution → `use skill terraform-test`
```

The agent reads the referenced skills from `.claude/skills/{name}/SKILL.md` on the shared filesystem.

### Why Filesystem + Natural Language?

| Approach | Pros | Cons |
|----------|------|------|
| **Filesystem + natural language** (chosen) | Simple, flexible, agent reads on-demand, no prompt bloat | Agent interprets references, not guaranteed |
| Programmatic chaining | Deterministic | Complex framework, rigid |
| Prompt-embedded content | Self-contained | Bloated prompts, stale content |

All skills live at the same path. The agent can discover, read, and follow any skill without system intervention.

## Team Mode Integration

### Planning Phase

The orchestrator agent reads its assigned skill, which may instruct team delegation. The agent:

1. Reads its own skill from disk
2. Lists available skills: `ls .claude/skills/`
3. Reads relevant sub-skills to understand their scope
4. Creates a plan that assigns skills to sub-agents
5. Calls `ExitPlanMode` with `launchSwarm: true`

### Execution Phase — Sub-Agent Prompts

When the orchestrator spawns sub-agents, each sub-agent's prompt includes:

```
use skill {assigned-skill-name}

{sub-task description from the plan}
```

The sub-agent reads the skill from the **shared filesystem** — all agents in the sandbox have access to `/workspace/.claude/skills/`.

### Shared Filesystem Advantage

All agents (orchestrator + sub-agents) share the same `/workspace` mount. This means:
- Sub-agents don't need skill content injected into their prompts
- A one-line directive is enough — the sub-agent reads the skill itself
- If a skill is updated mid-execution (rare but possible), agents see the update

## Composition Patterns

### Sequential Composition

Skills execute in order, each building on the previous:

```markdown
## Workflow
1. First, `use skill design-engineer` to create the interface design
2. Then, `use skill implement-validate` to implement the design
3. Finally, run verification
```

### Parallel Composition (Team Mode)

Skills execute concurrently via sub-agents:

```markdown
## Parallel Execution
Use team mode with 3 sub-agents:
- Agent 1: `use skill terraform-stacks` for infrastructure
- Agent 2: `use skill implement-validate` for application code
- Agent 3: `use skill terraform-test` for test suite
```

### Conditional Composition

Skills selected based on task characteristics:

```markdown
## Skill Selection
- If the task involves infrastructure changes: `use skill terraform-stacks`
- If the task involves UI components: `use skill design-engineer`
- If the task involves API changes: `use skill implement-validate`
- Always finish with `use skill terraform-test` for validation
```

### Nested Composition

A skill references another skill that itself references further skills:

```markdown
# Full-Stack Feature Skill

Use `skill feature-implementation`, which internally delegates to:
- `use skill design-engineer` for UI
- `use skill implement-validate` for backend
- `use skill terraform-stacks` for infrastructure
```

The agent handles nesting naturally — it reads each skill from disk as needed.

## Skill Discovery

The agent discovers available skills by listing the skills directory:

```bash
ls .claude/skills/
```

This returns all skill directories (both local git skills and materialized template skills). The agent can read any SKILL.md to understand its purpose before deciding to use it.

This means an orchestrator skill can say "choose the most appropriate skill for each sub-task" and the agent can browse what's available — no hardcoded references required.

## Cross-Sandbox Skill Resolution

### Container Path

All skills are on the filesystem at `/workspace/.claude/skills/`. Local skills from git are there via the bind mount. Org/template skills are materialized by the skill injector. All agents read from the same path.

### AgentCore Path (Bedrock)

The remote runtime has no filesystem access. For this path:
- The primary skill's content is embedded in the prompt (not just a directive)
- Sub-skill content for composition must also be embedded
- This is the one exception to the filesystem model

### Host-Mode Path

Agent has direct filesystem access. Same as container path — reads from `.claude/skills/`.

## Limits and Guardrails

- **Sub-agent depth**: The Claude SDK's turn limits provide natural bounds. Skills referencing skills won't create infinite loops.
- **Skill conflicts**: If two referenced skills give contradictory instructions, the agent resolves the conflict using context and the primary skill's intent.
- **Filesystem reads**: Each skill read is a single file operation (~1-50KB). Even reading 10 skills adds negligible overhead.
- **Materialized skill cleanup**: Skills written by the skill injector exist only in the container's writable layer. They don't affect git state.
- **Plan rejection preserves skill**: When a user rejects a plan, `task.skillId` stays. The next attempt re-reads the skill from disk (may have been updated).
- **Missing skills**: If a referenced sub-skill doesn't exist on disk, the agent reports the issue and continues with available context. No system-level error.
