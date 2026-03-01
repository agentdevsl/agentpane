# Tag System Specification

## Overview

Tags are team-scoped labels used for organizing projects and tasks, and for restricting API token access to specific subsets of resources. Each tag belongs to exactly one team and has a unique name within that team.

---

## Data Model

### Tags Table

```typescript
// db/schema/tags.ts
import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { createId } from '@paralleldrive/cuid2';
import { teams } from './teams';

export const tags = sqliteTable('tags', {
  id: text('id')
    .primaryKey()
    .$defaultFn(() => createId()),

  // Team scope
  teamId: text('team_id')
    .notNull()
    .references(() => teams.id, { onDelete: 'cascade' }),

  // Tag content
  name: text('name').notNull(),          // e.g. "frontend", "infrastructure"
  color: text('color').notNull(),         // Hex color code, e.g. "#3B82F6"

  // Timestamps
  createdAt: text('created_at').default(sql`(datetime('now'))`).notNull(),
  updatedAt: text('updated_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  // UNIQUE constraint: no duplicate tag names within a team
  teamNameUnique: uniqueIndex('tags_team_name_idx').on(table.teamId, table.name),
}));

export type Tag = typeof tags.$inferSelect;
export type NewTag = typeof tags.$inferInsert;
```

### Project Tags Junction Table

```typescript
// db/schema/project-tags.ts
import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { projects } from './projects';
import { tags } from './tags';

export const projectTags = sqliteTable('project_tags', {
  projectId: text('project_id')
    .notNull()
    .references(() => projects.id, { onDelete: 'cascade' }),

  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),

  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.projectId, table.tagId] }),
}));

export type ProjectTag = typeof projectTags.$inferSelect;
export type NewProjectTag = typeof projectTags.$inferInsert;
```

### Task Tags Junction Table

```typescript
// db/schema/task-tags.ts
import { sqliteTable, text, primaryKey } from 'drizzle-orm/sqlite-core';
import { sql } from 'drizzle-orm';
import { tasks } from './tasks';
import { tags } from './tags';

export const taskTags = sqliteTable('task_tags', {
  taskId: text('task_id')
    .notNull()
    .references(() => tasks.id, { onDelete: 'cascade' }),

  tagId: text('tag_id')
    .notNull()
    .references(() => tags.id, { onDelete: 'cascade' }),

  assignedAt: text('assigned_at').default(sql`(datetime('now'))`).notNull(),
}, (table) => ({
  pk: primaryKey({ columns: [table.taskId, table.tagId] }),
}));

export type TaskTag = typeof taskTags.$inferSelect;
export type NewTaskTag = typeof taskTags.$inferInsert;
```

### Indexes

```typescript
import { index } from 'drizzle-orm/sqlite-core';

export const tagIndexes = {
  teamIdx: index('tags_team_idx').on(tags.teamId),
};

export const projectTagIndexes = {
  projectIdx: index('project_tags_project_idx').on(projectTags.projectId),
  tagIdx: index('project_tags_tag_idx').on(projectTags.tagId),
};

export const taskTagIndexes = {
  taskIdx: index('task_tags_task_idx').on(taskTags.taskId),
  tagIdx: index('task_tags_tag_idx').on(taskTags.tagId),
};
```

---

## Constraints

### Uniqueness

- **Tag name per team**: `UNIQUE(team_id, name)` -- two different teams can each have a tag called "frontend", but within a single team, tag names must be unique.
- **Tag assignment per resource**: The composite primary key on junction tables (`projectId + tagId` or `taskId + tagId`) prevents duplicate assignments.

### Cascade Deletes

All tag-related foreign keys use `ON DELETE CASCADE`:

| Parent Deleted | Cascaded Deletes |
|----------------|-----------------|
| Team deleted | All tags for that team are deleted |
| Tag deleted | All `project_tags` and `task_tags` rows referencing that tag are deleted |
| Project deleted | All `project_tags` rows for that project are deleted |
| Task deleted | All `task_tags` rows for that task are deleted |

When a tag is deleted, API tokens that reference it in their `scopeTags` array lose that scope entry. If the `scopeTags` array becomes empty after deletion, the token becomes unrestricted (no tag filter) -- this is intentional to avoid silently breaking integrations.

---

## Tag Scoping for API Tokens

API tokens can optionally carry a `scopeTags` array -- a list of tag IDs. When present, the token restricts access to only those resources that are tagged with **at least one** of the specified tags.

### Scoping Rules

1. **Token without `scopeTags`** (null or empty): The token has access to all resources within its team (subject to role restrictions).

2. **Token with `scopeTags`**: The token can only see and operate on resources that have at least one matching tag assignment.

3. **Resource with no tags**: Resources that have no tags assigned are **invisible** to tag-restricted tokens. This is a security-first default -- untagged resources are hidden, not exposed.

4. **Tag matching is OR-based**: If a token has `scopeTags: ["tag-a", "tag-b"]`, a resource tagged with either "tag-a" or "tag-b" (or both) is accessible.

5. **Hierarchical tag scoping**:
   - For **projects**: The token checks project tags directly.
   - For **tasks**: The token checks both the task's own tags AND the parent project's tags. A task is accessible if either the task itself or its parent project has a matching tag.
   - For **sessions and agents**: Access follows the parent task or project chain.

### Query Pattern

When listing resources with a tag-scoped token, the query adds a filter:

```typescript
// Pseudocode for tag-scoped project listing
function listProjectsWithTagScope(teamId: string, scopeTags: string[]) {
  return db
    .select()
    .from(projects)
    .innerJoin(projectTags, eq(projectTags.projectId, projects.id))
    .where(
      and(
        eq(projects.teamId, teamId),
        inArray(projectTags.tagId, scopeTags)
      )
    )
    .groupBy(projects.id);
}

// Pseudocode for tag-scoped task listing
function listTasksWithTagScope(projectId: string, scopeTags: string[]) {
  // A task is visible if it has a matching tag OR its project has a matching tag
  const projectHasTag = db
    .select({ projectId: projectTags.projectId })
    .from(projectTags)
    .where(inArray(projectTags.tagId, scopeTags));

  const taskHasTag = db
    .select({ taskId: taskTags.taskId })
    .from(taskTags)
    .where(inArray(taskTags.tagId, scopeTags));

  return db
    .select()
    .from(tasks)
    .where(
      and(
        eq(tasks.projectId, projectId),
        or(
          inArray(tasks.id, taskHasTag),
          inArray(tasks.projectId, projectHasTag)
        )
      )
    );
}
```

### Token Scope Validation

When creating an API token with `scopeTags`, validate:

1. All tag IDs exist in the database.
2. All tags belong to the same team as the token's `teamId`.
3. The creating user has at least `member` role in the team.

```typescript
const validateTokenScopeTags = async (teamId: string, tagIds: string[]) => {
  const foundTags = await db
    .select()
    .from(tags)
    .where(
      and(
        inArray(tags.id, tagIds),
        eq(tags.teamId, teamId)
      )
    );

  if (foundTags.length !== tagIds.length) {
    const foundIds = new Set(foundTags.map(t => t.id));
    const missing = tagIds.filter(id => !foundIds.has(id));
    throw createError('TAG_NOT_FOUND', `Tags not found: ${missing.join(', ')}`, 404);
  }
};
```

---

## Color Format

Tag colors are stored as 6-digit hex strings with a `#` prefix. The UI renders these as background colors for tag badges.

### Suggested Default Palette

These colors are offered in the tag creation UI as quick-pick options:

| Name | Hex | Usage |
|------|-----|-------|
| Blue | `#3B82F6` | General purpose |
| Green | `#22C55E` | Success / production |
| Yellow | `#EAB308` | Warning / staging |
| Red | `#EF4444` | Critical / urgent |
| Purple | `#A855F7` | Infrastructure |
| Pink | `#EC4899` | Design |
| Orange | `#F97316` | In progress |
| Teal | `#14B8A6` | Testing |
| Gray | `#6B7280` | Archived / low priority |
| Indigo | `#6366F1` | Backend |

### Color Validation

```typescript
const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/, 'Must be a valid hex color (e.g. #3B82F6)');
```

---

## UI Rendering

### Tag Badge Component

Tags are rendered as small colored badges with the tag name:

```typescript
// Pseudocode for tag badge
interface TagBadgeProps {
  name: string;
  color: string;       // Hex color
  onRemove?: () => void;
  size?: 'sm' | 'md';
}

// The badge uses the color as background with appropriate text contrast
// Light colors (#EAB308) get dark text; dark colors (#3B82F6) get white text
function getTextColor(hexBg: string): string {
  const rgb = hexToRgb(hexBg);
  const luminance = (0.299 * rgb.r + 0.587 * rgb.g + 0.114 * rgb.b) / 255;
  return luminance > 0.5 ? '#1F2937' : '#FFFFFF';
}
```

### Tag Picker

The tag picker is a dropdown that:

1. Lists all tags for the current team
2. Shows a color swatch next to each tag name
3. Allows multi-select (checkboxes)
4. Includes an inline "Create tag" action at the bottom
5. Filters tags as the user types

---

## Relations

```typescript
// db/schema/relations.ts (additions)
import { relations } from 'drizzle-orm';
import { tags } from './tags';
import { projectTags } from './project-tags';
import { taskTags } from './task-tags';
import { teams } from './teams';
import { projects } from './projects';
import { tasks } from './tasks';

export const tagsRelations = relations(tags, ({ one, many }) => ({
  team: one(teams, {
    fields: [tags.teamId],
    references: [teams.id],
  }),
  projectTags: many(projectTags),
  taskTags: many(taskTags),
}));

export const projectTagsRelations = relations(projectTags, ({ one }) => ({
  project: one(projects, {
    fields: [projectTags.projectId],
    references: [projects.id],
  }),
  tag: one(tags, {
    fields: [projectTags.tagId],
    references: [tags.id],
  }),
}));

export const taskTagsRelations = relations(taskTags, ({ one }) => ({
  task: one(tasks, {
    fields: [taskTags.taskId],
    references: [tasks.id],
  }),
  tag: one(tags, {
    fields: [taskTags.tagId],
    references: [tags.id],
  }),
}));
```

---

## Migration

```sql
-- Create tags table
CREATE TABLE tags (
  id TEXT PRIMARY KEY,
  team_id TEXT NOT NULL REFERENCES teams(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  color TEXT NOT NULL,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now'))
);

CREATE UNIQUE INDEX tags_team_name_idx ON tags(team_id, name);
CREATE INDEX tags_team_idx ON tags(team_id);

-- Create project_tags junction table
CREATE TABLE project_tags (
  project_id TEXT NOT NULL REFERENCES projects(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (project_id, tag_id)
);

CREATE INDEX project_tags_project_idx ON project_tags(project_id);
CREATE INDEX project_tags_tag_idx ON project_tags(tag_id);

-- Create task_tags junction table
CREATE TABLE task_tags (
  task_id TEXT NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  tag_id TEXT NOT NULL REFERENCES tags(id) ON DELETE CASCADE,
  assigned_at TEXT NOT NULL DEFAULT (datetime('now')),
  PRIMARY KEY (task_id, tag_id)
);

CREATE INDEX task_tags_task_idx ON task_tags(task_id);
CREATE INDEX task_tags_tag_idx ON task_tags(tag_id);
```

---

## Cross-References

| Spec | Relationship |
|------|--------------|
| [API Endpoints](./api-endpoints.md) | Tag CRUD and assignment endpoints |
| [GitHub Tokens](./github-tokens.md) | Tags used in same team context |
| [Database Schema](../application/database/schema.md) | Core tables (projects, tasks) referenced by junctions |
| [Component Patterns](../application/implementation/component-patterns.md) | CVA patterns for tag badge variants |
