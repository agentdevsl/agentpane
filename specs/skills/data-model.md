# Data Model: Schema Changes and Types

## Database Migration

### SQLite (`src/db/schema/sqlite/tasks.ts`)

```sql
ALTER TABLE tasks ADD COLUMN skill_id TEXT;
ALTER TABLE tasks ADD COLUMN skill_name TEXT;
```

### PostgreSQL (`src/db/schema/postgres/tasks.ts`)

```sql
ALTER TABLE tasks ADD COLUMN skill_id TEXT;
ALTER TABLE tasks ADD COLUMN skill_name TEXT;
```

No foreign key constraint — `skillId` references a skill directory name in `.claude/skills/`, not a database row.

No index on `skill_id` initially. Add one if queries filtering by skill become common.

## Drizzle Schema Changes

### SQLite

```typescript
// src/db/schema/sqlite/tasks.ts
export const tasks = sqliteTable('tasks', {
  // ... existing columns ...

  /** Skill directory name (e.g., 'terraform-stacks') — maps to .claude/skills/{skillId}/SKILL.md */
  skillId: text('skill_id'),
  /** Denormalized skill display name (avoids filesystem lookup for reads) */
  skillName: text('skill_name'),

  // ... remaining columns ...
});
```

### PostgreSQL

```typescript
// src/db/schema/postgres/tasks.ts
export const tasks = pgTable('tasks', {
  // ... existing columns ...

  skillId: text('skill_id'),
  skillName: text('skill_name'),

  // ... remaining columns ...
});
```

## Type Changes

### CreateTaskInput (`src/services/task.service.ts`)

```typescript
export type CreateTaskInput = {
  codespaceId: string;
  title: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  skillId?: string;         // NEW — skill directory name
  skillName?: string;       // NEW — display name
};
```

### UpdateTaskInput (`src/services/task.service.ts`)

```typescript
export type UpdateTaskInput = {
  title?: string;
  description?: string;
  labels?: string[];
  priority?: 'high' | 'medium' | 'low';
  modelOverride?: string | null;
  skillId?: string | null;    // NEW — null to clear
  skillName?: string | null;  // NEW — null to clear
};
```

### StartAgentInput (`src/services/container-agent/types.ts`)

**No changes needed.** The prompt includes the lightweight `use skill {name}` directive. The agent reads skill content from the filesystem. No `skillContent` field required.

```typescript
// Unchanged
export interface StartAgentInput {
  codespaceId: string;
  taskId: string;
  sessionId: string;
  prompt: string;           // ← includes "use skill {name}" when applicable
  model?: string;
  maxTurns?: number;
  phase?: AgentPhase;
  sdkSessionId?: string;
}
```

### StoredPlanOptions

**No changes needed.** Skill content is on the filesystem, not persisted in the database. The agent reads skills from disk during both planning and execution phases. No crash recovery data needed for skills.

### ContainerAgentStage

Add skill injection stage:

```typescript
type ContainerAgentStage =
  | 'initializing'
  | 'validating'
  | 'credentials'
  | 'injecting_skills'    // NEW — materialize org/template skills
  | 'creating_sandbox'
  | 'executing'
  | 'running';
```

### Task Type (inferred from schema)

The `Task` type (`typeof tasks.$inferSelect`) automatically includes the new nullable fields:
```typescript
type Task = {
  // ... existing fields ...
  skillId: string | null;
  skillName: string | null;
};
```

## Default Skills Path

The canonical location for skills on the filesystem:

```
.claude/skills/{skillId}/SKILL.md
```

| Environment | Path |
|-------------|------|
| Host | `/path/to/project/.claude/skills/{skillId}/SKILL.md` |
| Container | `/workspace/.claude/skills/{skillId}/SKILL.md` |
| Worktree | `/workspace/.worktrees/{branch}/.claude/skills/{skillId}/SKILL.md` |

Skills follow the existing `.claude/skills/` convention established by Claude Code.

## Skill Injector Types

New types for the skill injection service:

```typescript
// src/lib/sandbox/skill-injector.ts

interface SkillInjectorOptions {
  sandbox: SandboxInstance;
  codespaceId: string;
  templateService: TemplateService;
  workspacePath?: string;  // default: '/workspace'
}

interface InjectedSkill {
  id: string;
  name: string;
  source: 'org' | 'project' | 'local';
  path: string;  // e.g., '/workspace/.claude/skills/terraform-stacks/SKILL.md'
}
```

## Validation Schema Changes

### Create Task (`src/server/validation.ts`)

```typescript
const createTaskSchema = z.object({
  codespaceId: idSchema,
  title: z.string().min(1).max(500),
  description: z.string().max(10000).optional(),
  labels: z.array(z.string().max(50)).max(20).optional(),
  priority: taskPrioritySchema.optional(),
  skillId: z.string().max(200).optional(),       // NEW
  skillName: z.string().max(200).optional(),      // NEW
});
```

### Update Task (`src/server/validation.ts`)

```typescript
const updateTaskSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  description: z.string().max(10000).optional(),
  labels: z.array(z.string().max(50)).max(20).optional(),
  priority: taskPrioritySchema.optional(),
  modelOverride: z.string().max(100).nullable().optional(),
  skillId: z.string().max(200).nullable().optional(),     // NEW
  skillName: z.string().max(200).nullable().optional(),   // NEW
}).refine(/* at least one field required */);
```

## Design Decisions

| Decision | Alternative | Rationale |
|----------|------------|-----------|
| Filesystem-based skill access | Embed skill content in prompt | No prompt bloat, always fresh, sub-agents inherit access |
| `use skill {name}` directive | Full content injection | Lightweight, agent reads on-demand, mirrors Claude Code behavior |
| Materialize org skills to sandbox | Embed in prompt for remote skills | Consistent experience — all skills at same path regardless of source |
| No `StoredPlanOptions` changes | Persist skill content for plan approval | Filesystem persists across plan phases — no crash recovery data needed |
| Denormalize `skillName` | Always read from filesystem | Avoids sandbox/filesystem access for kanban board rendering |
| `nullable` columns | Default to empty string | `null` semantics are clearer: null = no skill |
| `skillId` = directory name | Generate a CUID | Directory name is the natural identifier, human-readable |

## Migration Notes

- Both columns are nullable with no default — existing rows automatically have `null` values
- No data migration needed for existing tasks
- The migration is backward compatible and can be applied without downtime
- Drizzle Kit generates the migration via `bun drizzle-kit generate`
