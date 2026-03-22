# Skill Orchestration: How Skills Drive Agent Behavior

## Overview

When a task has an associated skill, the prompt includes a lightweight **directive** — `use skill {skillname}` — that tells the agent which skill to load from the filesystem. The agent reads the skill's SKILL.md file from the default skills path and follows its instructions. The skill defines the "how"; the task provides the "what".

## Prompt Assembly

### Current Structure (no skill)

```
Work on the following task:

Title: {title}
Description: {description}
Labels: {labels}
Priority: {priority}

The codespace is mounted at /workspace...
```

### New Structure (with skill)

```
use skill {skillName}

Work on the following task:

Title: {title}
Description: {description}
Labels: {labels}
Priority: {priority}

The codespace is mounted at /workspace...
```

That's it. The skill directive is a single line. The agent reads the full skill content from `/workspace/.claude/skills/{skillName}/SKILL.md` using its `Read` tool.

### Why Filesystem-Based?

| Approach | Prompt Size | Freshness | Sub-Agent Access | Complexity |
|----------|-------------|-----------|------------------|------------|
| **Filesystem** (chosen) | Minimal (+1 line) | Always current (reads from disk) | All agents can read | Low |
| Prompt injection | Bloated (+10KB+) | Frozen at prompt time | Only if re-injected | High (persistence, plan approval) |

Key advantages:
1. **No prompt bloat** — skills can be 10-50KB; the prompt stays small
2. **Always fresh** — agent reads current version from disk, not a snapshot
3. **Sub-agents inherit access** — all agents in the sandbox can read `.claude/skills/`
4. **No persistence problem** — no need to store skill content in `planOptions` for plan approval
5. **Natural** — mirrors how Claude Code works locally with skills

## Planning Phase Integration

In the planning phase (`permissionMode: 'plan'`):

1. Agent receives prompt with `use skill {skillName}`
2. Agent reads `/workspace/.claude/skills/{skillName}/SKILL.md`
3. Skill instructions shape the plan (e.g., "use concurrent agents", "run tests first")
4. Agent can also discover other skills by listing `.claude/skills/`

**No changes needed** to the stream handler or planning infrastructure.

## Execution Phase Integration

In the execution phase (`permissionMode: 'acceptEdits'`):

1. Agent still has filesystem access — can re-read the skill if needed
2. The approved plan already incorporates skill instructions from planning
3. Skill is available on disk for reference throughout execution

**No plan approval persistence changes needed.** The skill is on the filesystem, not in the prompt. When `PlanApprovalService.approvePlan` starts the execution phase, the agent can re-read the skill from disk. No `skillContent` or `skillManifest` fields in `StoredPlanOptions`.

## Execution Paths

### Prompt Building Location

The prompt is assembled in `TaskService.triggerContainerAgent`:

```
TaskService.moveColumn(taskId, 'in_progress')
  → triggerContainerAgent(task, sessionId)
    → buildTaskPrompt(task)   // includes "use skill {skillName}" if task.skillId is set
    → containerAgentService.startAgent({ prompt, ... })
```

The change to `buildTaskPrompt` is minimal — prepend `use skill {skillName}\n\n` when `task.skillId` is set.

### Container Agent Path (Docker/K8s/Nomad)

```
1. Skill injector materializes org/template skills to /workspace/.claude/skills/
2. buildTaskPrompt prepends "use skill {skillName}"
3. Prompt passed as AGENT_PROMPT env var
4. agent-runner sends prompt to Claude SDK
5. Agent reads skill from /workspace/.claude/skills/{skillName}/SKILL.md
```

**Files changed**: Only `buildTaskPrompt` in `TaskService`. Everything downstream is unchanged.

### AgentCore Path (Bedrock)

> **FOLLOW-UP REQUIRED**: The AgentCore path needs further research before implementation. The interaction between skill content embedding, AgentCore invoke payloads, and Bedrock runtime context windows needs investigation. This section describes the intended design but has not been implemented. Track as a separate work item.

The AgentCore runtime is remote — no filesystem access. This is the **one exception** where skill content must be embedded in the prompt:

```
1. Detect AgentCore execution mode
2. Resolve skill content from templateService.getMergedConfig()
3. Embed full skill content in prompt (instead of directive)
4. Send enriched prompt via provider.invoke()
```

This keeps the AgentCore path working without filesystem access. The `buildTaskPrompt` function accepts an `embedSkillContent: boolean` flag to switch between directive and embedded modes.

**Open questions for follow-up:**
- What is the AgentCore invoke payload size limit?
- How does skill content interact with AgentCore's own system prompt?
- Should large skills be truncated or summarized for the AgentCore path?
- Can AgentCore mount volumes or access external storage for skills?

### Host-Mode Agent Path

```
1. Agent runs on host with direct filesystem access
2. buildTaskPrompt prepends "use skill {skillName}"
3. Agent reads /path/to/project/.claude/skills/{skillName}/SKILL.md
```

Same as container path — agent reads from disk.

## Available Skills Discovery

The agent discovers available skills by listing the directory:

```bash
ls .claude/skills/
```

This returns all skill directories. The agent can read any skill's SKILL.md to understand its purpose. No manifest in the prompt is needed — the filesystem IS the manifest.

For team mode, the orchestrator agent can:
1. List available skills
2. Read relevant skills
3. Include skill directives in sub-agent prompts: "use skill {name}"
4. Sub-agents read the skill from the shared filesystem

## Skill Flow Through Plan Approval and Rejection

### Plan Approval

No special handling needed. When the plan is approved:
1. Execution phase starts with `PlanApprovalService.approvePlan`
2. Execution prompt includes the plan + task context + `use skill {skillName}`
3. Agent reads the skill from disk (same as planning phase)

**No `skillContent` persistence in `PlanData` or `StoredPlanOptions`** — the filesystem is the persistence layer.

### Plan Rejection and Re-Execution

When a plan is rejected:
1. Task moves to `backlog`, plan cleared
2. `task.skillId` and `task.skillName` are **NOT cleared**
3. User drags task back to `in_progress`
4. New prompt generated with `use skill {skillName}`
5. Agent reads skill from disk — may have been updated since last attempt

### Server Restart Recovery

If the server restarts while a plan is pending:
1. Task still has `skillId` in the database
2. Skill is still on the filesystem (bind mount persists)
3. When plan is approved, execution prompt includes `use skill {skillName}`
4. Agent reads skill from disk — no crash recovery data needed

## Model Override Interaction

Skills may contain natural language guidance about models (e.g., "Use Opus for complex analysis"). Skills do **not** have a programmatic `model` field.

The model resolution cascade is unchanged:
```
Task.modelOverride → Agent.config.model → Codespace.config.model → Global setting → Default
```

## Skills and Worktree Isolation

- Skills at `.claude/skills/` are included in worktrees (part of the project tree)
- Worktree path: `/workspace/.worktrees/feature-x/.claude/skills/`
- No special handling needed — git worktrees include the full tree

## Skills and Team Mode (ExitPlanModeOptions)

1. Orchestrator reads skill → decides team size and delegation
2. Calls `ExitPlanMode` with `launchSwarm: true`, `teammateCount: N`
3. Sub-agent prompts include `use skill {skillName}` for relevant skills
4. Sub-agents read skills from the shared `/workspace/.claude/skills/` filesystem

**Skills do not programmatically set `teammateCount`**. The agent decides based on skill instructions + task scope.

## Fallback Behavior

| Condition | Behavior |
|-----------|----------|
| `task.skillId` is `null` | No skill directive in prompt — generic execution |
| `task.skillId` set, skill on disk | `use skill {name}` in prompt — agent reads from disk |
| `task.skillId` set, skill NOT on disk | `use skill {name}` in prompt — agent reports file not found, proceeds generically |
| AgentCore path (no filesystem) | Embed full skill content in prompt instead of directive |

## Topology Tracking

No changes needed. Skill-driven tasks may produce richer topologies (more sub-agents, structured roles), but the tracking infrastructure handles this transparently.

## Skill-to-Sandbox Mapping: Complete Data Flow

### Phase 1: Skill Injection (before agent execution)

```
ContainerExecService.startAgent(input)
  │
  ├─ Stage: credentials → inject OAuth credentials
  ├─ Stage: injecting_skills (NEW)
  │   └─ skillInjector.injectSkills(sandbox, codespaceId)
  │       ├─ templateService.getMergedConfig(codespaceId)
  │       ├─ Filter skills not already in /workspace/.claude/skills/
  │       └─ Write each missing skill to /workspace/.claude/skills/{id}/SKILL.md
  └─ Stage: executing → start agent-runner
```

### Phase 2: Prompt Delivery

```
TaskService.buildTaskPrompt(task)
  │
  ├─ If task.skillId: prepend "use skill {task.skillId}\n\n"
  └─ Append task context (title, description, labels, priority)
```

### Phase 3: Agent Reads Skill

```
Agent receives: "use skill terraform-stacks\n\nWork on the following task:..."
  │
  ├─ Agent uses Read tool: /workspace/.claude/skills/terraform-stacks/SKILL.md
  ├─ Agent follows skill instructions
  └─ Agent can discover more skills: ls /workspace/.claude/skills/
```

### Files Requiring Modification

| File | Change |
|------|--------|
| `src/services/task.service.ts` | Update `buildTaskPrompt` to prepend `use skill {name}` |
| `src/lib/sandbox/skill-injector.ts` | **New file**: materialize org/template skills to sandbox |
| `src/services/container-agent/container-exec.service.ts` | Add skill injection stage |
| `src/services/container-agent/types.ts` | Add `injecting_skills` stage to `ContainerAgentStage` |

### Files NOT Modified

| File | Reason |
|------|--------|
| `agent-runner/src/index.ts` | Receives prompt as-is — skill reading is the agent's job |
| `src/lib/agents/stream-handler.ts` | Receives prompt from caller — unchanged |
| `src/lib/agents/container-bridge.ts` | Parses stdout events — skill-unaware |
| `src/services/container-agent/plan-approval.service.ts` | No skill persistence needed — filesystem is the source |
| `src/db/schema` (StoredPlanOptions) | No skill fields needed — filesystem is the source |
