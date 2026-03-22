# Skill-Centric Tasks: Core Architecture

## Overview

Each task may optionally reference a skill. The prompt includes a lightweight directive — `use skill {skillname}` — and the agent reads the full skill content from the filesystem at `.claude/skills/{skillname}/SKILL.md`. Skills are stored in git or materialized into the sandbox from org/template sources.

## Key Principle: Skills Are Filesystem Artifacts

Skills are **not** embedded in prompts. They live on disk:

```
.claude/skills/{skillname}/SKILL.md     (in project git repo)
/workspace/.claude/skills/{skillname}/   (in sandbox container)
```

The agent reads skills using its `Read` tool, just like Claude Code does locally. The prompt only carries a directive: `use skill {skillname}`.

## Data Model Changes

### Tasks Table

Add two columns (both SQLite and PostgreSQL):

| Column | Type | Nullable | Description |
|--------|------|----------|-------------|
| `skill_id` | text | yes | Skill directory name (e.g., `terraform-stacks`) |
| `skill_name` | text | yes | Denormalized display name for UI |

Both nullable for backward compatibility. See [data-model.md](data-model.md) for full details.

### No StoredPlanOptions Changes

Skill content is on the filesystem, not in the database. The agent reads skills from disk during both planning and execution. No crash recovery persistence needed.

## Prompt Directive

When a task has `skillId` set, the prompt prepends:

```
use skill {skillId}
```

That's the entire change to the prompt. The agent:
1. Reads `/workspace/.claude/skills/{skillId}/SKILL.md`
2. Follows the skill's instructions
3. Can discover other skills by listing `.claude/skills/`

## Skill Sources

| Source | Location | How It Gets There |
|--------|----------|-------------------|
| **Project git** | `.claude/skills/` in repo | Bind-mounted to `/workspace` automatically |
| **Org/template** | External git repo | Materialized by skill injector before execution |

See [skill-resolution.md](skill-resolution.md) for the materialization flow.

## API Changes

### Modified Endpoints

**POST /api/tasks** and **PUT /api/tasks/:id** — Accept optional `skillId` + `skillName`.

**GET /api/tasks** and **GET /api/tasks/:id** — Response includes `skillId` and `skillName`.

### New Endpoints

**GET /api/codespaces/:id/skills** — Merged skills list (template merge + local filesystem scan):
```json
{
  "ok": true,
  "data": [
    { "id": "terraform-stacks", "name": "terraform-stacks", "description": "...", "sourceType": "local" }
  ]
}
```

**GET /api/codespaces/:id/skills/:skillId** — Full skill content (reads from filesystem or template cache).

## UI Touchpoints

### Skill Picker (New Component)

**File**: `src/app/components/features/skill-picker.tsx`

Radix Select-based dropdown used in new task dialog and task detail dialog:
- Fetches available skills via `GET /api/codespaces/:id/skills`
- Groups by `sourceType` (Organization / Project / Local)
- Shows skill name, description, and tags as small badges
- **Tag filtering**: Clickable tag chips above the skill list. Multiple tags use AND logic.
- Allow clearing the selection (no skill)
- Props: `codespaceId`, `value` (current skillId), `onChange(skillId, skillName)`
- `SkillPickerInline` variant for compact metadata sections
- Self-hides when no skills are available and none selected

### Kanban Card Skill Badge

**Files**: `src/app/components/features/kanban-board/kanban-card.tsx`, `src/app/components/features/kanban-card.tsx`

Small pill displayed on kanban cards when `task.skillName` is truthy:
- `BookOpen` Phosphor icon + skill name
- `accent-subtle` background with `accent` text color
- Positioned between description preview and footer
- Display-only — no click handlers
- Uses denormalized `task.skillName` — no API calls

### Task Detail Dialog — Skill Section

**File**: `src/app/components/features/task-detail-dialog/task-skill.tsx`

Dedicated `TaskSkill` component rendered below the description:
- **Skill assigned**: Shows skill name as a pill with `Lightning` icon in `claude` (orange) color. "Change" button opens dropdown, "X" button clears.
- **No skill**: Shows "Add skill" button with dashed border. Clicking opens dropdown that lazily fetches skills.
- On change: sets `skillId`/`skillName` in `pendingChanges`, saved via `PUT /api/tasks/:id`

Also integrated into:
- `task-metadata.tsx` — Skill row in metadata section with `BookOpen` icon
- `task-details-collapsible.tsx` — Skill name in read-only metadata grid

### New Task Dialog Integration

**File**: `src/app/components/features/new-task-dialog.tsx`

- `SkillPicker` added to `TaskDetailsSidebar` between Tags and "Create manually" button
- `selectedSkillId`/`selectedSkillName` state passed to `apiClient.tasks.create()`
- State resets when dialog closes

## Backward Compatibility

| Scenario | Behavior |
|----------|----------|
| Existing tasks (no skillId) | Work exactly as before — no directive in prompt |
| No templates configured | Skill picker shows only local `.claude/skills/` |
| Agent execution with null skillId | Current prompt format unchanged |
| Agent execution with valid skillId | `use skill {name}` in prompt — agent reads from disk |
| Agent execution, skill not on disk | Agent reports file not found, proceeds generically |

## Implementation Sequence

1. **Data Model** — Add `skillId` and `skillName` columns, migration, validation schemas
2. **Skill Injector** — New `src/lib/sandbox/skill-injector.ts` to materialize org/template skills
3. **Container Startup** — Add `injecting_skills` stage to `ContainerExecService`
4. **Prompt Builder** — Update `buildTaskPrompt` to prepend `use skill {name}`
5. **API** — Accept `skillId`/`skillName` in task create/update routes
6. **Skills Endpoint** — `GET /api/codespaces/:id/skills` (merge templates + local scan)
7. **UI** — Skill picker, kanban badge, task detail section

### Implementation Risks

| Risk | Mitigation |
|------|------------|
| Skill injector fails to write to sandbox | Non-fatal — agent proceeds without materialized skills, may fall back to generic |
| Large number of org skills to materialize | Only materialize skills not already in project git. Parallelize writes |
| AgentCore has no filesystem access | Embed skill content in prompt for AgentCore path only |
| Worktree doesn't include `.claude/skills/` | Git worktrees include the full tree — `.claude/` is present |
| Materialized skills appear in git diff | Write to overlay path or use `.gitignore` entry |
