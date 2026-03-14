# 08 - Prompts, Templates & Workflows Architecture Review

**Reviewer:** reviewer-8
**Date:** 2026-02-17
**Scope:** Prompt registry, Terraform Compose pipeline, Workflow Designer, template sync, SSE streaming

---

## 1. Overview

AgentPane has three interconnected subsystems for prompt management, infrastructure code generation, and visual workflow design:

1. **Prompt Registry** (`src/lib/prompts/`) -- A centralized registry of all configurable system prompts with a settings-based override mechanism. Prompts are identified by string IDs, categorized, and resolved through a layered lookup (user override via settings, then default).

2. **Terraform Compose** (`src/services/terraform-compose.service.ts`, `src/lib/terraform/compose-prompt.ts`) -- An AI-powered HCL code generation pipeline that takes natural language, matches private registry modules, streams output via SSE, and extracts fenced code blocks from model responses.

3. **Workflow Designer** (`src/app/components/features/workflow-designer/`, `src/lib/workflow-dsl/`) -- A visual node-graph editor built on React Flow 12 with ELK layout, AI-powered workflow generation from templates, and a rich DSL type system validated with Zod.

4. **Template Sync** (`src/services/template-sync-scheduler.ts`, `src/lib/github/template-sync.ts`) -- Background scheduler that periodically syncs skill/command/agent definitions from GitHub repositories, caching them for use by the workflow designer.

The overall architecture is well-structured with clear separation of concerns. The prompt registry pattern provides a sound foundation for prompt management, and the Terraform Compose pipeline demonstrates sophisticated SSE streaming with proper buffering and fallback extraction. The workflow designer's DSL type system and ELK integration are architecturally sound, though there are areas where code duplication and missing validation create maintenance risks.

---

## 2. Prompt Registry

### Architecture

The prompt registry follows a three-layer resolution pattern:

```
PROMPT_REGISTRY (default text) → SettingsService (user override) → {{variable}} substitution
```

**Key files:**

| File | Purpose |
|------|---------|
| `src/lib/prompts/types.ts` | Type definitions for `PromptCategory`, `PromptDefinition` |
| `src/lib/prompts/prompt-registry.ts` | Default prompt texts and the `PROMPT_REGISTRY` record |
| `src/lib/prompts/prompt-service.ts` | `resolvePromptServer()` -- layered resolution with variable substitution |
| `src/lib/prompts/index.ts` | Public barrel exports |

### Registration Pattern

Each prompt is registered as a `PromptDefinition` with:
- `id` -- unique string identifier (e.g., `'terraform-compose'`)
- `category` -- one of four categories: `agent-execution`, `task-creation`, `terraform-compose`, `workflow-designer`
- `settingsKey` -- settings lookup key (e.g., `'prompt.terraform-compose'`)
- `defaultText` -- the full prompt text, extracted from the original source files
- `dynamicVariables` -- list of `{{placeholder}}` names for documentation/validation
- `wordCount` -- precomputed word count for UI display

There are 8 registered prompts across 4 categories:

| ID | Category | Dynamic Variables |
|----|----------|-------------------|
| `plan-mode-default` | agent-execution | none |
| `task-creation` | task-creation | none |
| `terraform-compose` | terraform-compose | `moduleContext` |
| `terraform-compose-stacks` | terraform-compose | `moduleContext`, `stacksReference` |
| `workflow-generation-system` | workflow-designer | none |
| `workflow-analysis` | workflow-designer | 6 variables |
| `workflow-validation` | workflow-designer | `workflowJson` |
| `workflow-from-description` | workflow-designer | `description` |

### Override Mechanism

`resolvePromptServer()` at `src/lib/prompts/prompt-service.ts:19-45` implements the override:
1. Look up `PromptDefinition` from registry (throws on unknown ID)
2. Query `settingsService.getValue(settingsKey)` for user override
3. If override is non-empty, use it; otherwise use `defaultText`
4. Replace all `{{variable}}` placeholders via `String.replaceAll()`

### Strengths

- Clean separation of concerns -- prompts are data, resolution is a service
- Every prompt has a documented list of dynamic variables
- Settings-based overrides allow per-deployment customization without code changes
- Word count pre-calculation enables UI display of prompt size

### Weaknesses

- No runtime validation that required dynamic variables are supplied (see PT-001)
- The `dynamicVariables` array is purely informational -- not enforced programmatically (see PT-002)
- All 8 prompt texts are defined as module-level constants in a single 591-line file (see PT-003)

---

## 3. Terraform Compose

### System Prompt Construction

The compose prompt is built by `buildCompositionSystemPrompt()` at `src/lib/terraform/compose-prompt.ts:15-40`:

```
mode === 'stacks'?
  ├── settingsService → resolvePromptServer('terraform-compose-stacks', {moduleContext, stacksReference})
  └── fallback → TERRAFORM_COMPOSE_STACKS_TEXT with manual replaceAll
mode === 'terraform'?
  ├── settingsService → resolvePromptServer('terraform-compose', {moduleContext})
  └── fallback → getPromptDefaultText('terraform-compose').replaceAll(...)
```

The dual codepath (settings-aware vs manual fallback) is necessary because `buildCompositionSystemPrompt` can be called without a `settingsService` (e.g., during tests or direct usage). The stacks reference content is loaded from `.claude/skills/terraform-stacks/SKILL.md` via `loadStacksSkillContent()` with in-memory caching.

### Settings Integration

Model selection follows a three-level cascade at `src/services/terraform-compose.service.ts:367-370`:
```
TERRAFORM_COMPOSE_MODEL env → global default_model setting → DEFAULT_AGENT_MODEL constant
```

### HCL Extraction Pipeline

Code extraction at `src/services/terraform-compose.service.ts:713-767`:

1. **Standard mode**: `extractHclCode()` matches `` ```hcl ``, `` ```terraform ``, `` ```tf `` fenced blocks, joins multiple blocks with `\n\n`
2. **Stacks mode**: `extractStacksFiles()` extracts multiple files with `title="filename"` annotations; falls back to `inferStacksFilename()` based on HCL block types (`deployment`, `provider`, `variable`, etc.)
3. **Deduplication**: Stacks files are merged by filename when the model generates multiple blocks for the same file

### Clarifying Questions

The compose service has two question detection paths:

1. **Tool-based** (`src/services/terraform-compose.service.ts:379-397`): Intercepts `AskUserQuestion` tool calls via `canUseTool` callback, capturing structured questions with categories and options
2. **Text-based fallback** (`src/services/terraform-compose.service.ts:844-871`): `parseClarifyingQuestionsFromText()` parses numbered questions from plain text when the model writes questions instead of using the tool

### Module Matching

`matchModulesInResponse()` at `src/services/terraform-compose.service.ts:792-837` uses a three-tier confidence system:
- **1.0**: Module `source` string found literally in response
- **0.8**: Module name + provider both referenced
- **0.5**: Module name alone referenced (excludes generic names like "module", "test", "main")

### Key Architectural Decision

The CLAUDE.md explicitly warns: **Do NOT use `permissionMode: 'plan'`** for Compose sessions. The compose service creates sessions without a `permissionMode` to avoid Claude Code's planning system instructions, which would cause the model to request approval instead of generating HCL code. This is correctly implemented at `src/services/terraform-compose.service.ts:410-414`.

---

## 4. Workflow Designer

### React Flow Integration

The workflow designer uses React Flow 12 (`@xyflow/react`) with:

- **8 standard node types** + **5 compact node types** (v3 pill design)
- **4 edge types**: sequential, handoff, dataflow, conditional
- **ELK layout** (`elkjs`) for automatic hierarchical positioning

**Key files:**

| File | Purpose |
|------|---------|
| `src/app/components/features/workflow-designer/index.tsx` | Main `WorkflowDesigner` component |
| `src/app/components/features/workflow-designer/WorkflowCanvas.tsx` | React Flow canvas wrapper |
| `src/app/components/features/workflow-designer/AIGenerateDialog.tsx` | AI workflow generation dialog |
| `src/app/components/features/workflow-designer/nodes/index.ts` | Node type registry (13 types) |
| `src/app/components/features/workflow-designer/edges/index.ts` | Edge type registry (4 types) |
| `src/lib/workflow-dsl/types.ts` | Zod-validated DSL type system |
| `src/lib/workflow-dsl/layout.ts` | ELK layout + ReactFlow conversion |
| `src/lib/workflow-dsl/ai-prompts.ts` | AI prompt builders for workflow generation |
| `src/server/routes/workflow-designer.ts` | Server-side `/analyze` endpoint |

### Node Types

The DSL defines 8 node types via Zod discriminated unions (`src/lib/workflow-dsl/types.ts:193-203`):

| Type | Schema | Purpose |
|------|--------|---------|
| `start` | `startNodeSchema` | Entry point with optional typed inputs |
| `end` | `endNodeSchema` | Exit point with optional output mappings |
| `skill` | `skillNodeSchema` | Skill invocation (`/` prefixed) |
| `context` | `contextNodeSchema` | Prompting/context content |
| `agent` | `agentNodeSchema` | AI agent with model, temperature, tools, handoffs |
| `conditional` | `conditionalNodeSchema` | Branching with expression + branches |
| `loop` | `loopNodeSchema` | Iteration with body node references |
| `parallel` | `parallelNodeSchema` | Concurrent execution branches |

### Layout (ELK)

The layout system at `src/lib/workflow-dsl/layout.ts` provides:

- **Dynamic node width calculation** (`estimateNodeWidth`): Approximates pixel width from label + secondary text lengths using character-width constants
- **ELK options**: Layered algorithm, orthogonal edge routing, LINEAR_SEGMENTS node placement, LAYER_SWEEP crossing minimization
- **Position normalization**: Post-layout shift to start at x=0
- **Fallback**: Simple vertical stacking if ELK fails
- **Lazy initialization**: ELK instance is loaded on first use to avoid server-side worker issues

### AI Workflow Generation

The `/api/workflow-designer/analyze` endpoint at `src/server/routes/workflow-designer.ts:388-595`:

1. Receives skills/commands/agents (inline or via `templateId` lookup)
2. Builds prompt via `resolveWorkflowAnalysisPrompt()` (settings-aware) or `createWorkflowAnalysisPrompt()` (fallback)
3. Calls `agentQuery()` (one-shot, non-streaming)
4. Parses AI JSON response with extensive validation and repair:
   - Validates nodes/edges against Zod schemas (skips invalid ones with warnings)
   - Removes edges referencing non-existent nodes
   - Auto-generates missing start/end nodes
   - Uses `findChainHeadAndTail()` BFS to determine correct start/end connections
   - Runs full BFS reachability check, connecting unreachable nodes from array-order predecessors
5. Applies ELK layout for final positioning
6. Returns the complete workflow with AI confidence score (0-100)

### Workflow Validation

`validateWorkflowStructure()` at `src/lib/workflow-dsl/types.ts:337-409` checks:
- Exactly one start node
- At least one end node
- All edge references point to valid nodes
- Loop body node references exist
- Parallel branch node references exist
- Conditional branch target references exist

---

## 5. Template Sync

### Sync Architecture

Templates are synced from GitHub repositories using a background scheduler:

1. **Scheduler** (`src/services/template-sync-scheduler.ts`): Runs every 60 seconds, queries for templates with `nextSyncAt <= now` and `syncIntervalMinutes` set
2. **Sync process** (`src/services/template.service.ts` -> `src/lib/github/template-sync.ts`): Fetches `.claude/` directory from GitHub, parses YAML frontmatter from markdown files, extracts skills/commands/agents
3. **Caching**: Results stored in `cachedSkills`, `cachedCommands`, `cachedAgents` columns on the `templates` table

### Update Patterns

- **Minimum sync interval**: 5 minutes (`MIN_SYNC_INTERVAL_MINUTES`)
- **Concurrency guard**: `syncInProgress` Set prevents overlapping syncs for the same template
- **Status guard**: Templates with `status === 'syncing'` are skipped
- **Next sync scheduling**: `calculateNextSyncAt()` updates `nextSyncAt` after each sync, regardless of success/failure

### How Templates Stay in Sync with Workflows

Templates and workflows are loosely coupled:
- The workflow designer fetches templates on mount via `fetch('/api/templates?scope=org')` (`src/app/components/features/workflow-designer/index.tsx:248`)
- The AI generation dialog uses `cachedSkills`, `cachedCommands`, `cachedAgents` from the fetched templates
- **There is no reactive/push mechanism** -- if a template is synced while the designer is open, the user must reload the page to see updated content (see PT-009)

---

## 6. SSE Streaming in Compose

### Event Protocol

The compose service uses a custom SSE protocol defined as a discriminated union at `src/lib/terraform/types.ts:78-92`:

| Event Type | Payload | Purpose |
|------------|---------|---------|
| `status` | `{ stage: ComposeStage }` | Pipeline progress (6 stages) |
| `text` | `{ content: string }` | Streaming text deltas from model |
| `modules` | `{ modules: ModuleMatch[] }` | Matched registry modules |
| `code` | `{ code: string, files?: GeneratedFile[] }` | Extracted HCL code |
| `questions` | `{ questions: ClarifyingQuestion[] }` | Clarifying questions |
| `done` | `{ sessionId, matchedModules?, generatedCode?, generatedFiles?, usage }` | Completion with all results |
| `error` | `{ error: string }` | Error message |

### Pipeline Stages

```
loading_catalog → analyzing → matching_modules → generating_code → validating_hcl → finalizing
```

### Code Extraction Pipeline

The extraction follows a dual-path pattern with server and client fallbacks:

**Server-side** (`src/services/terraform-compose.service.ts`):
1. Accumulate `fullResponse` from `content_block_delta` stream events
2. After streaming, extract HCL from `fullResponse`
3. Send `code` SSE event if found
4. Send `done` event with `generatedCode` as redundant delivery

**Client-side fallback** (`src/app/components/features/terraform/terraform-context.tsx:498-509`):
1. In `finally` block, if no `code` event received from server
2. `extractHclFromText()` tries `hcl`/`terraform`/`tf` fences, then plain `` ``` `` blocks containing HCL keywords
3. `extractStacksFilesFromText()` for stacks mode with same filename inference logic

### Event Buffering

The `sendEvent()` method at `src/services/terraform-compose.service.ts:226-267` implements a resilient buffering strategy:
- If no controller connected yet, buffers `error`, `done`, and `code` events (up to `MAX_PENDING_EVENTS = 50`)
- If controller breaks mid-stream, nulls it out and falls back to buffering
- On subscriber connect, replays all pending events before live streaming
- Keepalive pings every 15 seconds prevent proxy/Bun idle timeouts

### Subscriber Wait Pattern

`waitForSubscriber()` at `src/services/terraform-compose.service.ts:296-302` polls every 50ms (up to 10s) for a controller to be attached. This handles the two-step protocol where POST returns the session ID and GET connects the SSE stream.

---

## 7. Findings

### PT-001: Unreplaced Template Variables Silently Passed to Model

**Severity:** Medium
**Description:** If a caller of `resolvePromptServer()` omits a required dynamic variable, the `{{placeholder}}` string is passed verbatim to the model. There is no validation that all declared `dynamicVariables` are supplied.
**Affected files:**
- `src/lib/prompts/prompt-service.ts:38-42` -- substitution loop does not check for remaining `{{...}}` patterns
- `src/lib/prompts/prompt-registry.ts:524-531` -- `workflow-analysis` declares 6 variables but no enforcement
**Recommendation:** Add a post-substitution check that warns or throws if any `{{...}}` patterns remain in the resolved text. This is especially important for the `workflow-analysis` prompt which has 6 dynamic variables.

### PT-002: Dynamic Variables Declaration is Informational Only

**Severity:** Low
**Description:** The `dynamicVariables` array on each `PromptDefinition` is never used programmatically -- it exists only for documentation in the UI. There is no compile-time or runtime enforcement that the declared variables match the actual `{{...}}` placeholders in the `defaultText`.
**Affected files:**
- `src/lib/prompts/prompt-registry.ts:469` -- `dynamicVariables: []` for prompts that have no variables
- `src/lib/prompts/types.ts:25` -- `dynamicVariables: string[]` type definition
**Recommendation:** Add a startup-time validation that scans each prompt's `defaultText` for `{{...}}` patterns and verifies they match the declared `dynamicVariables` array. Alternatively, derive the list programmatically from the text.

### PT-003: Large Monolithic Prompt Registry File

**Severity:** Low
**Description:** All 8 prompt default texts are defined as module-level string constants in `prompt-registry.ts` (591 lines). The workflow prompts alone account for ~200 lines of template text. As more prompts are added, this file will become unwieldy.
**Affected files:**
- `src/lib/prompts/prompt-registry.ts:1-591` -- entire file
**Recommendation:** Consider splitting prompt texts into separate files per category (e.g., `prompts/defaults/terraform.ts`, `prompts/defaults/workflow.ts`), importing them into the registry. The stacks prompt already follows this pattern (`src/lib/terraform/stacks-prompt.ts`).

### PT-004: Duplicated `mapToCompactNodeType` Function

**Severity:** Medium
**Description:** The function `mapToCompactNodeType()` that converts standard node types to compact v3 types is duplicated in two locations with slightly different implementations. The layout version logs `console.warn` for control flow nodes while the designer version does not.
**Affected files:**
- `src/lib/workflow-dsl/layout.ts:432-462` -- layout version with exhaustiveness check
- `src/app/components/features/workflow-designer/index.tsx:39-63` -- designer version without exhaustiveness check
**Recommendation:** Extract to a shared utility function in `src/lib/workflow-dsl/` and import from both locations. The layout version's exhaustiveness check is the more robust implementation.

### PT-005: Duplicated HCL/Stacks Extraction Logic Between Server and Client

**Severity:** Medium
**Description:** The HCL code extraction and Stacks file inference logic is independently implemented on both server and client, creating a maintenance burden where bug fixes must be applied in two places.
**Affected files:**
- `src/services/terraform-compose.service.ts:713-767` -- server-side `extractHclCode()`, `extractStacksFiles()`, `inferStacksFilename()`
- `src/app/components/features/terraform/terraform-context.tsx:100-153` -- client-side `extractHclFromText()`, `extractStacksFilesFromText()`
**Recommendation:** Extract the extraction logic into `src/lib/terraform/` as shared utilities that can be imported by both server and client. The client already imports types from this location.

### PT-006: Duplicated Clarifying Question Parsers with Divergent Option Inference

**Severity:** Medium
**Description:** Two independent clarifying question parsers exist with similar but not identical option inference logic. The server-side `inferDefaultOptions()` returns different options than the client-side `inferOptions()` for the same input, leading to inconsistent UX depending on which parser runs.
**Affected files:**
- `src/services/terraform-compose.service.ts:844-884` -- server-side `parseClarifyingQuestionsFromText()` + `inferDefaultOptions()`
- `src/app/components/features/terraform/terraform-context.tsx:25-97` -- client-side `parseClarifyingQuestions()` + `inferOptions()`
**Recommendation:** Extract to a single shared implementation in `src/lib/terraform/`. The client version is more sophisticated (handles yes/no patterns, region patterns with 4 options instead of 3) and should be the canonical one.

### PT-007: Workflow Merge Prompt Not in Registry

**Severity:** Low
**Description:** The `createWorkflowMergePrompt()` function at `src/lib/workflow-dsl/ai-prompts.ts:174-202` defines its prompt inline rather than using the prompt registry. This means it cannot be customized via settings, unlike all other workflow prompts.
**Affected files:**
- `src/lib/workflow-dsl/ai-prompts.ts:174-202` -- hardcoded prompt text
**Recommendation:** Register a `'workflow-merge'` prompt in the registry and use `resolvePromptServer()` for consistency. Add an async `resolveWorkflowMergePrompt()` function alongside the existing pattern.

### PT-008: Environment Variable Filter Uses Allowlist-by-Exclusion Pattern

**Severity:** Medium
**Description:** The compose service filters environment variables passed to Agent SDK sessions by excluding a specific regex pattern of known sensitive keys. This is a denylist approach that will miss any new sensitive variables added later (e.g., `REDIS_PASSWORD`, `JWT_SECRET`).
**Affected files:**
- `src/services/terraform-compose.service.ts:401-408` -- regex filter for `DATABASE_URL|DB_.*|ENCRYPTION_KEY|SESSION_SECRET|GITHUB_APP_PRIVATE_KEY`
**Recommendation:** Consider inverting to an allowlist approach, only passing the specific environment variables the SDK needs (e.g., `ANTHROPIC_API_KEY`, `HOME`, `PATH`, etc.). This is a defense-in-depth measure.

### PT-009: No Reactive Template Updates in Workflow Designer

**Severity:** Low
**Description:** The workflow designer fetches templates once on mount via `useEffect` with an empty dependency array. If templates are synced in the background while the designer is open, the skill list becomes stale. Users must reload the page to see updated content.
**Affected files:**
- `src/app/components/features/workflow-designer/index.tsx:244-259` -- one-time fetch on mount
**Recommendation:** Add a "Refresh" button to the AI generation dialog, or use TanStack Query / polling to periodically refresh the template list. The Terraform module catalog already has a refresh pattern that could be reused.

### PT-010: Session Memory Leak in Compose Service

**Severity:** Medium
**Description:** The `TerraformComposeService` stores sessions in a `Map` with TTL-based cleanup (`SESSION_TTL_MS = 30 minutes`) and max-size eviction (`MAX_SESSIONS = 100`). However, `cleanupSessions()` is only called at the start of `startCompose()`, meaning sessions are never cleaned up between compose requests. If the server runs for hours without compose activity, expired sessions remain in memory.
**Affected files:**
- `src/services/terraform-compose.service.ts:103-122` -- `cleanupSessions()` only called from `startCompose()`
- `src/services/terraform-compose.service.ts:94-95` -- unbounded `sessions` and `jobs` Maps
**Recommendation:** Add periodic cleanup via `setInterval` or trigger cleanup from `subscribeToJob()` and `getSession()` as well. Alternatively, use a WeakRef-based cache or move to a dedicated cache layer.

### PT-011: `fullResponse` Accumulation Race Condition Risk

**Severity:** Low
**Description:** In the compose pipeline, `fullResponse` is built incrementally from `content_block_delta` events, and the `assistant` message handler only overwrites it when `!streamedTextToClient`. However, if the SDK delivers a `stream_event` with empty text followed by an `assistant` message, the flag `streamedTextToClient` would be `false` and the assistant content would overwrite the (empty) accumulated text. This is correctly documented in CLAUDE.md as a known pitfall, suggesting it was a real bug at some point.
**Affected files:**
- `src/services/terraform-compose.service.ts:418-478` -- `fullResponse` accumulation logic
**Recommendation:** The current guard (`!streamedTextToClient`) is correct for the common case. Consider adding a secondary guard based on `fullResponse.length > 0` to prevent overwriting non-empty accumulated content even if the flag logic has edge cases.

### PT-012: Workflow AI Response Parsing Silently Drops Invalid Nodes

**Severity:** Low
**Description:** The `parseAIResponse()` function at `src/server/routes/workflow-designer.ts:133-386` validates each node against Zod schemas and silently drops invalid ones with `console.warn`. If the AI generates many invalid nodes, the resulting workflow could be significantly different from what was intended, with no indication to the user.
**Affected files:**
- `src/server/routes/workflow-designer.ts:161-168` -- `console.warn` for skipped nodes
- `src/server/routes/workflow-designer.ts:174-179` -- `console.warn` for skipped edges
**Recommendation:** Include a count of dropped nodes/edges in the API response (e.g., `droppedNodes: 3, droppedEdges: 1`) so the UI can display a warning. The `aiConfidence` score should also be reduced proportionally.

### PT-013: ELK Layout Dimension Mismatch Between Server and Client

**Severity:** Low
**Description:** The server-side workflow analysis endpoint uses different ELK layout dimensions (`nodeWidth: 200, nodeHeight: 60, nodeSpacing: 50, layerSpacing: 80`) than the default client-side layout (`nodeWidth: 280, nodeHeight: 32, nodeSpacing: 30, layerSpacing: 45`). The client-side `layoutWorkflowForReactFlow()` then re-applies layout with its own defaults, but the `AIGenerateDialog` skips this with `skipConnectivityFix: true`, using the server layout directly.
**Affected files:**
- `src/server/routes/workflow-designer.ts:557-564` -- server layout with `nodeWidth: 200, nodeHeight: 60`
- `src/lib/workflow-dsl/layout.ts:53-61` -- client defaults with `nodeWidth: 280, nodeHeight: 32`
- `src/app/components/features/workflow-designer/AIGenerateDialog.tsx:311-314` -- uses `layoutWorkflowForReactFlow` which re-layouts
**Recommendation:** Define shared layout constants in `src/lib/workflow-dsl/layout.ts` and use them from both locations. Since the AI dialog re-applies layout client-side, the server layout dimensions are effectively ignored, making the server-side layout computation wasteful.

### PT-014: Hardcoded User Initials in Chat Panel

**Severity:** Low
**Description:** The Terraform chat panel hardcodes user initials as "SL" for the user avatar bubble.
**Affected files:**
- `src/app/components/features/terraform/terraform-chat-panel.tsx:698` -- `SL` hardcoded
**Recommendation:** Derive initials from the authenticated user's name, or use a generic user icon.

### PT-015: Conditional Edge Type Reuses Sequential Edge Component

**Severity:** Low
**Description:** The conditional edge type is mapped to the `SequentialEdge` component in the edge registry. While the comment says "Reuse with different styling via data.condition", the `SequentialEdge` component does not actually render condition labels or any visual differentiation.
**Affected files:**
- `src/app/components/features/workflow-designer/edges/index.ts:35` -- `conditional: SequentialEdge`
**Recommendation:** Either implement a dedicated `ConditionalEdge` component with condition label rendering, or document that conditional edges are visually identical to sequential edges by design.

---

## 8. Summary

### Architecture Strengths

1. **Well-designed prompt registry** with clean separation between default text, override lookup, and variable substitution
2. **Robust SSE streaming** in Terraform Compose with event buffering, keepalive pings, subscriber wait pattern, and graceful degradation
3. **Comprehensive workflow DSL** with Zod schema validation, discriminated unions, and structural validation helpers
4. **Sophisticated AI response repair** in the workflow analyzer -- BFS reachability checks, topological chain analysis, auto-generation of missing nodes
5. **Dual-mode compose** (standard Terraform + Stacks) cleanly handled through the prompt builder and extraction functions
6. **Lazy ELK initialization** avoids server-side worker issues

### Key Risks

1. **Code duplication** across server/client for HCL extraction (PT-005), question parsing (PT-006), and node type mapping (PT-004) creates divergence risk
2. **No variable substitution validation** (PT-001) means prompts can silently send `{{placeholder}}` text to models
3. **Environment variable denylist** (PT-008) may leak future sensitive variables
4. **Session memory leak** (PT-010) in long-running servers without compose activity

### Recommended Priority Actions

| Priority | Finding | Impact |
|----------|---------|--------|
| High | PT-005: Shared HCL extraction | Prevents dual-maintenance bugs |
| High | PT-006: Shared question parser | Prevents UX inconsistency |
| Medium | PT-001: Variable substitution validation | Prevents silent prompt corruption |
| Medium | PT-004: Shared mapToCompactNodeType | Reduces code duplication |
| Medium | PT-008: Env var allowlist | Improves security posture |
| Medium | PT-010: Session cleanup | Prevents memory leaks |
| Low | PT-003: Split prompt registry | Improves maintainability |
| Low | PT-007: Register merge prompt | Consistency |
| Low | PT-013: Shared layout constants | Reduces wasted computation |
