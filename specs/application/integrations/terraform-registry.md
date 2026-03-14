# Terraform No-Code Composer

The Terraform No-Code Composer is a chat-based infrastructure composition system that syncs private modules from HCP Terraform registries to a local database, then uses the Claude Agent SDK to generate Terraform HCL configurations from natural language descriptions.

## Architecture Overview

```
User describes infrastructure in chat
  |
  v
POST /api/terraform/compose  (returns sessionId immediately)
  |
  v
TerraformComposeService.startCompose()
  |-- Loads module catalog from SQLite (via TerraformRegistryService.getModuleContext)
  |-- Builds system prompt with full module metadata (compose-prompt.ts)
  |-- Creates Claude Agent SDK session (unstable_v2_createSession)
  |-- Streams text deltas to Caddy durable stream
  |-- Extracts HCL code blocks from response
  |-- Matches referenced modules against catalog
  |-- Validates HCL via @cdktf/hcl2json
  |-- Publishes terraform:done event
  |
  v
Client subscribes to /v1/stream/terraform/{sessionId} (Caddy durable streams)
  |
  v
UI renders: chat messages, clarifying questions, module matches, code preview, dependency diagram
```

## Compose Modes

The system supports two composition modes:

| Mode | Output | File Extension | Description |
|------|--------|----------------|-------------|
| `terraform` (default) | Single `main.tf` | `.tf` | Standard Terraform HCL with `module` blocks |
| `stacks` | Multiple files | `.tfcomponent.hcl`, `.tfdeploy.hcl` | Terraform Stacks with `component` and `deployment` blocks |

The mode is selected via the `composeMode` field on the compose request and a toggle in the chat input UI.

## Database Schema

Two SQLite tables defined in `src/db/schema/sqlite/terraform.ts`:

### `terraform_registries`

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | cuid2 |
| `name` | text NOT NULL | Display name |
| `org_name` | text NOT NULL | HCP Terraform organization |
| `token_setting_key` | text NOT NULL | Key in `settings` table (e.g. `tfe_api_token`) |
| `status` | text NOT NULL | `active` / `syncing` / `error` |
| `last_synced_at` | text | ISO timestamp of last successful sync |
| `sync_error` | text | Error message from last failed sync |
| `module_count` | integer | Number of synced modules |
| `sync_interval_minutes` | integer | Auto-sync interval (nullable = manual only) |
| `next_sync_at` | text | When the next scheduled sync is due |
| `created_at` | text | Auto-set datetime |
| `updated_at` | text | Auto-set datetime |

### `terraform_modules`

| Column | Type | Description |
|--------|------|-------------|
| `id` | text PK | cuid2 |
| `registry_id` | text NOT NULL | FK to `terraform_registries.id` |
| `name` | text NOT NULL | Module name |
| `namespace` | text NOT NULL | Registry namespace |
| `provider` | text NOT NULL | Provider (e.g. `aws`, `azurerm`, `google`) |
| `version` | text NOT NULL | Latest published version |
| `source` | text NOT NULL | Registry source path (e.g. `app.terraform.io/org/vpc/aws`) |
| `description` | text | Module description |
| `readme` | text | Full README content |
| `inputs` | JSON | `TerraformVariable[]` -- name, type, description, default, required, sensitive |
| `outputs` | JSON | `TerraformOutput[]` -- name, description |
| `dependencies` | JSON | `string[]` -- provider dependency source paths |
| `published_at` | text | When the version was published |
| `created_at` | text | Auto-set datetime |
| `updated_at` | text | Auto-set datetime |

### Relations (`src/db/schema/sqlite/relations.ts`)

```
terraformRegistries  1 --< N  terraformModules  (via registryId)
```

### TypeScript Types

```typescript
interface TerraformVariable {
  name: string;
  type: string;
  description?: string;
  default?: unknown;
  required: boolean;
  sensitive?: boolean;
}

interface TerraformOutput {
  name: string;
  description?: string;
}

type TerraformRegistryStatus = 'active' | 'syncing' | 'error';
```

## Services

### TerraformRegistryService (`src/services/terraform-registry.service.ts`)

CRUD operations for registries and modules, plus sync orchestration.

**Registry CRUD:**
- `createRegistry(input)` -- validates uniqueness by `orgName`, inserts with status `active`
- `getRegistryById(id)` / `listRegistries()` / `updateRegistry(id, input)` / `deleteRegistry(id)`
- `deleteRegistry` cascades: deletes modules first, then registry

**Module queries:**
- `listModules(options?)` -- supports `search` (LIKE on name/description), `provider` filter, `registryId` filter, pagination via `limit`/`offset`
- `getModuleById(id)` -- full module detail

**Sync:**
- `sync(id)` -- reads token from `settings` table via `tokenSettingKey`, calls `syncAllModules()` from registry client, replaces all existing modules with fresh data in a single batch insert
- Sets registry status to `syncing` during operation, `active` on success, `error` on failure
- Sanitizes error messages to strip credential content

**AI prompt context:**
- `getModuleContext(registryId?)` -- formats all modules as structured markdown for injection into the AI system prompt. Includes module source, version, all inputs with types/defaults/required flags, all outputs, and dependencies.

### TerraformComposeService (`src/services/terraform-compose.service.ts`)

Chat-based HCL generation using the Claude Agent SDK.

**Session management:**
- In-memory `Map<sessionId, ComposeSession>` with 30-minute TTL
- Maximum 100 concurrent sessions; oldest evicted on overflow
- Sessions track messages, matched modules, and generated code

**Compose pipeline (6 stages):**

1. **`loading_catalog`** -- Load module context from `TerraformRegistryService.getModuleContext()`
2. **`analyzing`** -- Create Claude Agent SDK session, stream response
3. **`matching_modules`** -- Match modules referenced in response text against catalog
4. **`generating_code`** -- Extract HCL code blocks from response
5. **`validating_hcl`** -- Validate extracted HCL via `@cdktf/hcl2json` (standard mode only)
6. **`finalizing`** -- Publish done event with results

**Model selection cascade:**
`TERRAFORM_COMPOSE_MODEL` env var > global `default_model` setting > `DEFAULT_AGENT_MODEL` constant

**Event delivery:** All events are published to Caddy durable streams via `DurableStreamsService`. The stream ID is `terraform:{sessionId}`.

**HCL extraction:**
- Standard mode: regex matches ` ```hcl `, ` ```terraform `, ` ```tf ` fenced blocks, joins multiple blocks
- Stacks mode: extracts multiple files using ` ```hcl title="filename.tfcomponent.hcl" ` annotations, with content-based filename inference as fallback

**Module matching:**
Three confidence tiers:
- 1.0: Module `source` path appears in response text
- 0.8: Module name + provider both referenced
- 0.5: Module name mentioned (excludes generic names like "module", "main", "test")

**Clarifying questions:**
The service captures `AskUserQuestion` tool calls from the Agent SDK via the `canUseTool` callback. Falls back to parsing numbered question patterns from response text.

**HCL validation:**
Uses `@cdktf/hcl2json` for pure-JS validation (no terraform binary needed). Validates both `main.tf` and optional `terraform.tfvars`.

### Terraform Sync Scheduler (`src/services/terraform-sync-scheduler.ts`)

Background service that checks every 60 seconds for registries due for sync.

- Queries registries where `syncIntervalMinutes IS NOT NULL AND nextSyncAt <= now`
- Deduplicates via `syncInProgress` Set to prevent concurrent syncs of the same registry
- Updates `nextSyncAt` after each sync attempt (success or failure)
- Minimum sync interval: 5 minutes

## Registry Client (`src/lib/terraform/registry-client.ts`)

Pure HTTP client for HCP Terraform REST API.

**API endpoints used:**
- `GET /api/v2/organizations/:org/registry-modules` (JSONAPI v2) -- lists all modules with pagination
- `GET /api/registry/v1/modules/:namespace/:name/:provider/:version` (Registry v1) -- fetches full detail including inputs, outputs, readme

**Rate limiting:** Retries on HTTP 429 with exponential backoff (up to 3 retries), respects `Retry-After` header.

**Batching:** Fetches module details in batches of 2 with 500ms delays between batches to respect HCP Terraform rate limits (~4 req/s effective throughput).

**Module source format:** `app.terraform.io/{orgName}/{name}/{provider}`

## Prompt System

### Compose Prompt (`src/lib/terraform/compose-prompt.ts`)

`buildCompositionSystemPrompt(moduleContext, settingsService?, mode?, stacksReference?)` builds the system prompt:

- **Standard mode:** Uses the `terraform-compose` prompt from the prompt registry, substituting `{{moduleContext}}` with the formatted module catalog
- **Stacks mode:** Uses the `terraform-compose-stacks` prompt, substituting both `{{moduleContext}}` and `{{stacksReference}}` (loaded from `.claude/skills/terraform-stacks/SKILL.md`)

Prompts are admin-editable via the Settings > Prompts UI. The default texts live in `src/lib/prompts/prompt-registry.ts` and can be overridden via the `settings` table.

### Prompt Registry Entries

| Prompt ID | Category | Dynamic Variables |
|-----------|----------|-------------------|
| `terraform-compose` | terraform-compose | `moduleContext` |
| `terraform-compose-stacks` | terraform-compose | `moduleContext`, `stacksReference` |

### Standard Compose Prompt Behavior

The system prompt instructs the model to:
1. On **first response**: ask 3-5 clarifying questions (region, environment, sizing, etc.) -- no HCL code blocks allowed
2. On **subsequent responses**: generate complete HCL with `terraform {}` block, using exact `source` paths from the catalog and `module.X.output_name` cross-references
3. Prefer private registry modules over native Terraform resources in all cases

### Critical: Do NOT use `permissionMode: 'plan'`

The compose service creates an Agent SDK session via `unstable_v2_createSession()` without a `permissionMode`. Setting `permissionMode: 'plan'` would inject Claude Code's planning system instructions, causing the model to ask for plan approval instead of generating HCL code.

## Zod Validation Schemas (`src/lib/terraform/schema.ts`)

| Schema | Fields |
|--------|--------|
| `composeRequestSchema` | `sessionId?`, `messages[]` (role + content), `registryId?`, `composeMode?` (`terraform`/`stacks`) |
| `createRegistrySchema` | `name`, `orgName`, `tokenSettingKey`, `syncIntervalMinutes?` (min: 5) |
| `updateRegistrySchema` | All fields optional, `syncIntervalMinutes` nullable |
| `moduleMatchSchema` | `moduleId`, `name`, `provider`, `version`, `source`, `confidence` (0-1), `matchReason` |

## API Routes (`src/server/routes/terraform.ts`)

All routes are mounted at `/api/terraform`.

### Registry Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/registries` | List all registries (strips `tokenSettingKey`) |
| `POST` | `/registries` | Create registry (validates via `createRegistrySchema`) |
| `GET` | `/registries/:id` | Get registry by ID |
| `PATCH` | `/registries/:id` | Update registry settings |
| `DELETE` | `/registries/:id` | Delete registry and all its modules |
| `POST` | `/registries/:id/sync` | Trigger manual sync |

### Module Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `GET` | `/modules` | List modules (query params: `search`, `provider`, `registryId`, `limit` max 200) |
| `GET` | `/modules/:id` | Get module detail |

### Composition Endpoints

| Method | Path | Description |
|--------|------|-------------|
| `POST` | `/compose` | Start compose job. Returns `202` with `{ sessionId }`. Client subscribes to durable stream. |
| `POST` | `/validate` | Validate HCL code (and optional tfvars) via `@cdktf/hcl2json` |

**SSE note:** There is no SSE endpoint on the API server. Clients subscribe to Caddy durable streams at `/v1/stream/terraform/{sessionId}` directly.

## Streaming Event Protocol

Events are published to `DurableStreamsService` with stream ID `terraform:{sessionId}`.

| Event Type | Payload | Description |
|------------|---------|-------------|
| `terraform:status` | `{ jobId, stage }` | Pipeline stage transition |
| `terraform:text` | `{ jobId, delta }` | Streaming text delta from the model |
| `terraform:modules` | `{ jobId, modules[] }` | Matched modules with confidence scores |
| `terraform:questions` | `{ jobId, questions[] }` | Clarifying questions (category, question, options) |
| `terraform:code` | `{ jobId, code, files? }` | Extracted HCL code (single or multi-file) |
| `terraform:done` | `{ jobId, matchedModules?, generatedCode?, generatedFiles?, usage }` | Completion with token usage |
| `terraform:error` | `{ jobId, error }` | Error message |

## Client-Side Architecture

### TerraformContext (`src/app/components/features/terraform/terraform-context.tsx`)

React context providing:

**State:** `messages`, `matchedModules`, `generatedCode`, `generatedFiles`, `composeMode`, `registries`, `modules`, `syncStatus`, `isStreaming`, `composeStage`, `composeComplete`, `error`, `selectedModuleId`

**Actions:** `sendMessage(content)`, `resetConversation()`, `refreshModules()`, `syncRegistry(id)`, `setComposeMode()`, `clearError()`

**Stream handling:**
1. `POST /api/terraform/compose` to start the job (receives `sessionId`)
2. Connect to `durableStream({ url: /v1/stream/terraform/{sessionId}, live: 'sse' })`
3. Route events by type to state setters
4. Client-side fallbacks: extract HCL from assistant text if no `terraform:code` event received; parse clarifying questions from numbered patterns in text

### Frontend Routes

| Route | Component | Description |
|-------|-----------|-------------|
| `/terraform` | Layout with `TerraformProvider`, `TerraformViewSwitcher`, `TerraformSyncBar`, `Outlet` | Parent layout |
| `/terraform/` (index) | Two-panel: `TerraformChatPanel` + `TerraformRightPanel` | Compose view |
| `/terraform/modules` | `TerraformCatalogView` or `TerraformModuleDetail` | Module catalog |
| `/terraform/modules/:moduleId` | `TerraformModuleDetail` | Module detail with tabs |
| `/terraform/settings` | `TerraformSettingsPanel` | Registry configuration |
| `/terraform/history` | `TerraformCompositionHistory` | Past compositions (localStorage) |

### UI Components

| Component | File | Description |
|-----------|------|-------------|
| `TerraformChatPanel` | `terraform-chat-panel.tsx` | Chat with messages, quick-start prompts, clarifying questions UI, compose progress indicator, error bubbles |
| `TerraformRightPanel` | `terraform-right-panel.tsx` | Tabbed panel: Code (with Shiki syntax highlighting), Dependencies (diagram), Variables (form with smart widgets) |
| `TerraformDependencyDiagram` | `terraform-dependency-diagram.tsx` | ReactFlow graph with ELK layout, showing module/component dependency relationships |
| `TerraformVariablesForm` | `terraform-variables-form.tsx` | Parsed HCL variables with smart widgets (select for regions/environments, switch for bools, textarea for maps/lists) |
| `TerraformCatalogView` | `terraform-catalog-view.tsx` | Module grid with search and provider filter chips |
| `TerraformModuleDetail` | `terraform-module-detail.tsx` | Full module detail with Overview/Inputs/Outputs/Dependencies/Readme tabs |
| `TerraformSettingsPanel` | `terraform-settings-panel.tsx` | Registry config: TFE token, org name, sync interval, status card, sync/delete buttons |
| `TerraformViewSwitcher` | `terraform-view-switcher.tsx` | Compose / Modules tab switcher |
| `TerraformSyncBar` | `terraform-sync-bar.tsx` | Status bar: module count, last sync time, sync/error indicators |
| `TerraformCompositionHistory` | `terraform-composition-history.tsx` | Past compositions grouped by date (localStorage-backed) |
| `TerraformModuleNode` | `terraform-module-node.tsx` | ReactFlow custom node with provider icon, confidence dot, provider badge |
| `TerraformDependencyEdge` | `terraform-dependency-edge.tsx` | ReactFlow custom edge: solid for explicit deps, dashed for implicit, ELK bend point routing |
| `ProviderIcon` | `provider-icons.tsx` | Inline SVG icons for AWS, Azure, GCP, generic cloud |

## HCL Parsing Libraries

### `parse-hcl-dependencies.ts`

Parses standard Terraform `module` blocks from HCL code:
- Extracts explicit `depends_on` references
- Extracts implicit `module.X.output_name` cross-references
- Produces a `TerraformGraph` with typed edges (explicit/implicit) for the dependency diagram

### `parse-stacks-dependencies.ts`

Parses Terraform Stacks `component` blocks:
- Concatenates all generated files
- Extracts `component.X.output_name` cross-references (stacks components do not use `depends_on`)
- Produces the same `TerraformGraph` format

### `parse-hcl-variables.ts`

Extracts `variable` blocks from HCL using brace-counting:
- Parses type, description, default, sensitive, required
- Normalizes types to: `string`, `number`, `bool`, `list`, `map`, `object`, `unknown`
- `inferSmartWidget()` maps variable names to appropriate form controls (region selects, bool switches, etc.)

### `generate-tfvars.ts`

Generates `terraform.tfvars` content from parsed variables and user-supplied values. Handles type-appropriate formatting (quoted strings, bare numbers/bools, pass-through for complex types).

## Error Catalog (`src/lib/errors/terraform-errors.ts`)

| Error Code | HTTP | Description |
|------------|------|-------------|
| `TERRAFORM_REGISTRY_NOT_FOUND` | 404 | Registry ID not found |
| `TERRAFORM_MODULE_NOT_FOUND` | 404 | Module ID not found |
| `TERRAFORM_REGISTRY_ALREADY_EXISTS` | 409 | Duplicate org name |
| `TERRAFORM_INVALID_TOKEN` | 401 | Missing or invalid API token |
| `TERRAFORM_NO_MODULES_SYNCED` | 404 | No modules with published versions |
| `TERRAFORM_REGISTRY_CREATE_FAILED` | 500 | Database insert failed |
| `TERRAFORM_SYNC_FAILED(reason)` | 500 | Sync operation failed |
| `TERRAFORM_COMPOSE_FAILED(reason)` | 500 | Composition pipeline failed |

## API Client (`src/lib/api/client.ts`)

The `apiClient.terraform` namespace provides typed methods:

```typescript
terraform: {
  listRegistries()
  createRegistry(data)
  getRegistry(id)
  deleteRegistry(id)
  updateRegistry(id, data)
  syncRegistry(id)
  listModules(params?)
  getModule(id)
  validateCode(data)
  getComposeUrl()  // returns URL for direct fetch (compose uses POST + durable stream)
}
```

## Key Implementation Files

| File | Purpose |
|------|---------|
| `src/db/schema/sqlite/terraform.ts` | Drizzle schema: `terraformRegistries`, `terraformModules` tables |
| `src/db/schema/sqlite/relations.ts` | One-to-many relation: registry -> modules |
| `src/services/terraform-registry.service.ts` | Registry CRUD, sync orchestration, module context builder |
| `src/services/terraform-compose.service.ts` | Claude Agent SDK composition pipeline, HCL extraction, module matching |
| `src/services/terraform-sync-scheduler.ts` | Background sync scheduler (60s check interval) |
| `src/lib/terraform/registry-client.ts` | HCP Terraform REST API client (v2 list + v1 detail) |
| `src/lib/terraform/compose-prompt.ts` | System prompt builder (standard + stacks modes) |
| `src/lib/terraform/stacks-prompt.ts` | Default stacks compose prompt text |
| `src/lib/terraform/schema.ts` | Zod validation schemas for API requests |
| `src/lib/terraform/types.ts` | TypeScript types: `ComposeMessage`, `ModuleMatch`, `ComposeEvent`, `ComposeStage`, etc. |
| `src/lib/terraform/parse-hcl-dependencies.ts` | HCL module dependency graph parser |
| `src/lib/terraform/parse-stacks-dependencies.ts` | Stacks component dependency graph parser |
| `src/lib/terraform/parse-hcl-variables.ts` | HCL variable parser with smart widget inference |
| `src/lib/terraform/generate-tfvars.ts` | `.tfvars` file generator |
| `src/lib/terraform/index.ts` | Barrel exports |
| `src/lib/prompts/prompt-registry.ts` | Prompt registry with default texts |
| `src/lib/errors/terraform-errors.ts` | Error definitions |
| `src/server/routes/terraform.ts` | Hono API routes (registries, modules, compose, validate) |
| `src/lib/api/client.ts` | Frontend API client (`terraform` namespace) |
| `src/app/components/features/terraform/terraform-context.tsx` | React context with durable stream subscription |
| `src/app/components/features/terraform/terraform-chat-panel.tsx` | Chat UI with clarifying questions, compose progress |
| `src/app/components/features/terraform/terraform-right-panel.tsx` | Code preview, dependency diagram, variables form |
| `src/app/components/features/terraform/terraform-catalog-view.tsx` | Module catalog grid |
| `src/app/components/features/terraform/terraform-module-detail.tsx` | Module detail with tabbed views |
| `src/app/components/features/terraform/terraform-settings-panel.tsx` | Registry settings form |
| `src/app/components/features/terraform/terraform-dependency-diagram.tsx` | ReactFlow + ELK dependency graph |
| `src/app/components/features/terraform/terraform-variables-form.tsx` | Smart variable editor |
| `src/app/components/features/terraform/terraform-view-switcher.tsx` | Compose/Modules tab switcher |
| `src/app/components/features/terraform/terraform-sync-bar.tsx` | Sync status indicator |
| `src/app/components/features/terraform/terraform-composition-history.tsx` | Composition history list |
| `src/app/components/features/terraform/terraform-module-node.tsx` | ReactFlow custom module node |
| `src/app/components/features/terraform/terraform-dependency-edge.tsx` | ReactFlow custom dependency edge |
| `src/app/components/features/terraform/provider-icons.tsx` | Provider SVG icons |
| `src/app/components/features/terraform/terraform-utils.ts` | Utility functions (time formatting, file download) |
