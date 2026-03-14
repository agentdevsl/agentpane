# Terraform No-Code Composer - Production Implementation

## Goal

New "Terraform" sidebar tab with chat-based infrastructure composer. Syncs real HCP Terraform private module registry to local DB. Users describe infrastructure needs in natural language, system matches to stored modules, clarifies requirements, then composes Terraform configurations using real AI streaming.

**Branch:** `feature/terraform-nocode-composer`
**Existing Wireframe:** `specs/application/wireframes/terraform-nocode-composer.html` (4 scenarios)

## Architecture

- **Registry Sync**: Direct HCP Terraform REST API v2 (`/api/v2/organizations/:org/registry-modules`) syncs all private modules to SQLite. Token stored in settings table. Scheduled sync via existing scheduler pattern.
- **Chat UI**: Two-panel composer - chat left, module matches + code preview right. SSE streaming for real-time AI output.
- **Composition**: Anthropic SDK streaming with full module context as system prompt. All module metadata (inputs, outputs, descriptions, readme) cached locally for zero-latency matching.
- **Layout**: Parent route `/terraform` with Outlet, child routes for Compose (index) and Modules catalog. Follows CLI Monitor pattern.

## Phase 0: Wireframes (3 new wireframes using frontend-design skill)

Create 3 additional wireframes in `specs/application/wireframes/` following design-tokens.css:

### Wireframe 1: `terraform-settings-panel.html`
Settings configuration for Terraform integration:
- Settings page section for "Terraform" under Admin
- TFE Token input field (password type, with test connection button)
- HCP Terraform Organization name input
- Sync interval dropdown (5min, 15min, 30min, 1hr, manual only)
- Registry status card: last synced, module count, sync errors
- Manual "Sync Now" button with spinner state
- Success/error toast states

### Wireframe 2: `terraform-module-detail.html`
Full module detail view (click-through from catalog card):
- Full-width layout within the Modules tab
- Back navigation breadcrumb: Terraform / Modules / terraform-aws-vpc
- Module header: name, provider badge, version, source URL, published date
- Tab bar: Overview | Inputs | Outputs | Dependencies | Readme
- **Overview tab**: description, usage example code block, dependency graph (simple list)
- **Inputs tab**: table with columns: Name, Type, Description, Default, Required (red badge)
- **Outputs tab**: table with columns: Name, Description
- **Dependencies tab**: provider requirements list, module dependencies
- **Readme tab**: rendered markdown content area
- "Use in Composer" button → navigates to Compose tab with module pre-selected

### Wireframe 3: `terraform-composition-history.html`
History of past compositions:
- List view showing previous composition sessions
- Each row: timestamp, summary (first user message truncated), module count, status badge (completed/draft/error)
- Click to reopen composition in Compose view
- Search/filter by date range
- "New Composition" button
- Empty state when no history

## Implementation (4 concurrent opus agents)

### Agent 1: Schema, Sync Service & DB

**Files to create:**

1. **`src/db/schema/terraform.ts`** - Two Drizzle tables (follows `marketplaces.ts` pattern):

   **`terraform_registries` table:**
   - `id` text PK (`createId()`), `name` text NOT NULL
   - `orgName` text NOT NULL (HCP Terraform organization)
   - `tokenSettingKey` text NOT NULL (key in settings table, e.g. `terraform.token`)
   - `status` text `$type<'active' | 'syncing' | 'error'>()`
   - `lastSyncedAt` text, `syncError` text, `moduleCount` integer
   - `syncIntervalMinutes` integer (nullable), `nextSyncAt` text (nullable)
   - `createdAt`, `updatedAt` with datetime defaults

   **`terraform_modules` table:**
   - `id` text PK (`createId()`), `registryId` text NOT NULL (FK)
   - `name` text NOT NULL, `namespace` text NOT NULL, `provider` text NOT NULL
   - `version` text NOT NULL, `source` text NOT NULL (e.g. `app.terraform.io/myorg/vpc/aws`)
   - `description` text, `readme` text
   - `inputs` JSON `$type<TerraformVariable[]>()` - name, type, description, default?, required, sensitive?
   - `outputs` JSON `$type<TerraformOutput[]>()` - name, description
   - `dependencies` JSON `$type<string[]>()`
   - `publishedAt` text, `createdAt`, `updatedAt`

   **TypeScript interfaces:**
   - `TerraformVariable { name, type, description?, default?, required, sensitive? }`
   - `TerraformOutput { name, description? }`
   - Export `TerraformRegistry`, `NewTerraformRegistry`, `TerraformModule`, `NewTerraformModule`

2. **`src/db/schema/index.ts`** - Add `export * from './terraform'`

3. **`src/db/schema/relations.ts`** - Add `terraformRegistriesRelations` and `terraformModulesRelations`

4. **`src/lib/bootstrap/phases/schema.ts`** - Add CREATE TABLE + CREATE INDEX migration SQL

5. **`src/lib/terraform/registry-client.ts`** - Pure HTTP client for HCP Terraform REST API v2:
   - `listRegistryModules(config)` → `GET /api/v2/organizations/:org/registry-modules`
   - `getModuleVersions(config, namespace, name, provider)` → `GET .../versions`
   - `getModuleDetail(config, namespace, name, provider, version)` → full detail with inputs/outputs
   - `syncAllModules(config)` → list + batch fetch details (5 concurrent requests)
   - Auth: Bearer token from config, JSONAPI response parsing
   - Returns `Result<T, TerraformError>`

6. **`src/services/terraform-registry.service.ts`** - Registry sync service (follows `MarketplaceService`):
   - Constructor takes `(db: Database)`
   - `createRegistry(input)`, `getRegistryById(id)`, `listRegistries()`, `updateRegistry()`, `deleteRegistry()`
   - `sync(id)` - fetch token from settings → set status syncing → call syncAllModules → delete old modules → insert new → update status
   - `listModules(options?)` - query with search/provider filters
   - `getModuleById(id)` - full detail
   - `getModuleContext()` - **key method**: returns all modules as formatted string for AI system prompt

7. **`src/lib/errors/terraform-errors.ts`** - Error definitions following `marketplace-errors.ts`:
   - `REGISTRY_NOT_FOUND`, `MODULE_NOT_FOUND`, `SYNC_FAILED(reason)`, `INVALID_TOKEN`, `COMPOSE_FAILED(reason)`, `NO_MODULES_SYNCED`

8. **`src/services/terraform-sync-scheduler.ts`** - Follows `template-sync-scheduler.ts` exactly:
   - 60s check interval, queries registries where `syncIntervalMinutes IS NOT NULL AND nextSyncAt <= now`
   - Deduplication via `syncInProgress` Set
   - Calculates `nextSyncAt` after each sync

### Agent 2: Compose Service & AI Integration

**Files to create:**

9. **`src/services/terraform-compose.service.ts`** - Composition service using Anthropic SDK:
   - Constructor takes `(db: Database, registryService: TerraformRegistryService)`
   - `compose(messages: Message[], registryId?: string)` - streaming chat:
     1. Fetch module context via `registryService.getModuleContext()`
     2. Build system prompt with full module catalog (names, descriptions, all inputs with types/defaults/required, all outputs, module source paths)
     3. Call `anthropic.messages.stream()` with conversation history
     4. Return ReadableStream for SSE
   - System prompt instructs AI to: match modules from catalog, ask clarifying questions for required variables, generate Terraform HCL using exact source paths and `module.X.output_name` references
   - In-memory session store: `Map<sessionId, { messages, matchedModules, generatedCode }>`

10. **`src/lib/terraform/compose-prompt.ts`** - System prompt builder:
    - `buildModuleContextPrompt(modules: TerraformModule[])` → formatted string with all module metadata
    - `buildCompositionSystemPrompt(moduleContext: string)` → full system prompt with instructions
    - Estimated ~20-30K tokens for ~50 modules (within context window)

11. **`src/lib/terraform/schema.ts`** - Zod schemas:
    - `composeRequestSchema` - messages array, optional registryId
    - `moduleMatchSchema` - moduleId, name, provider, version, confidence, matchReason
    - `composeMessageSchema` - role, content, moduleMatches?, generatedCode?

12. **`src/lib/terraform/index.ts`** - Barrel exports

### Agent 3: API Routes & Server Wiring

**Files to create:**

13. **`src/server/routes/terraform.ts`** - Hono API routes (follows `marketplaces.ts`):
    ```
    // Registry CRUD
    GET  /registries           - list registries
    POST /registries           - create registry
    GET  /registries/:id       - get registry
    POST /registries/:id/sync  - trigger manual sync

    // Modules (from cached DB)
    GET  /modules              - list all modules (query: search, provider, limit)
    GET  /modules/:id          - module detail (inputs, outputs, readme)

    // Composition (streaming)
    POST /compose              - send messages, return SSE stream
    ```

    The `/compose` endpoint uses Hono streaming:
    ```typescript
    app.post('/compose', async (c) => {
      const { messages, registryId } = await c.req.json();
      const stream = await composeService.compose(messages, registryId);
      return new Response(stream, { headers: { 'Content-Type': 'text/event-stream' } });
    });
    ```

**Files to modify:**

14. **`src/server/router.ts`**:
    - Import `TerraformRegistryService`, `TerraformComposeService` types
    - Add to `RouterDependencies`: `terraformRegistryService?`, `terraformComposeService?`
    - Add route: `app.route('/api/terraform', createTerraformRoutes({...}))`

15. **`src/server/api.ts`**:
    - Instantiate `TerraformRegistryService` and `TerraformComposeService`
    - Pass to `createRouter()` deps
    - Start `startTerraformSyncScheduler()` after template scheduler
    - Add migration execution block

16. **`src/lib/api/client.ts`** - Add `terraform` namespace:
    ```typescript
    terraform: {
      listRegistries: () => apiFetch('/api/terraform/registries'),
      createRegistry: (body) => apiFetch(..., { method: 'POST', body }),
      syncRegistry: (id) => apiFetch(`/api/terraform/registries/${id}/sync`, { method: 'POST' }),
      listModules: (params?) => apiFetch(`/api/terraform/modules?${qs}`),
      getModule: (id) => apiFetch(`/api/terraform/modules/${id}`),
      compose: (body) => fetch('/api/terraform/compose', { method: 'POST', body, headers }),
    }
    ```

### Agent 4: UI Components & Routes

**Files to create:**

17. **`src/app/routes/terraform.tsx`** - Layout route (follows `cli-monitor.tsx`):
    - `createFileRoute('/terraform')`, `TerraformProvider` wrapper
    - `LayoutShell` with breadcrumbs, `centerAction={<TerraformViewSwitcher />}`
    - `actions`: Sync Registry button (conditional), New button, Download .tf (conditional)
    - Sync bar below header showing module count + last sync time
    - `<Outlet />` for child routes

18. **`src/app/routes/terraform/index.tsx`** - Compose view (default):
    - Two-panel grid: `grid-template-columns: 1fr 380px`
    - Left: chat panel (messages + input + welcome state)
    - Right: tabbed panel (Matched Modules / Code Preview)

19. **`src/app/routes/terraform/modules.tsx`** - Module catalog:
    - Catalog grid with search and provider filter chips
    - Module cards matching wireframe scenario 4

20. **`src/app/components/features/terraform/terraform-context.tsx`** - React context:
    - `messages` state, `matchedModules`, `generatedCode`, `isStreaming`
    - `registries` + `modules` from API
    - `syncStatus` (lastSynced, moduleCount)
    - `sendMessage(content)`, `resetConversation()` functions
    - SSE connection management for streaming compose responses

21. **`src/app/components/features/terraform/terraform-composer.tsx`** - Main composer panel:
    - Left panel: welcome state → chat messages → streaming → code generated
    - Right panel: module matches tab + code preview tab
    - Quick-start prompts: "VPC with private subnets", "EKS cluster", "RDS database", etc.

22. **`src/app/components/features/terraform/terraform-chat-panel.tsx`** - Chat UI:
    - User/assistant message bubbles (blue/dark styling)
    - Inline module match indicators with confidence dots
    - Clarifying questions as interactive option cards
    - Success banner with generation stats
    - Streaming dots indicator
    - Auto-scroll on new messages

23. **`src/app/components/features/terraform/terraform-right-panel.tsx`** - Right panel:
    - Tab switcher: Matched Modules / Code Preview
    - Module cards with confidence bars, provider badges, variable lists
    - Code preview with syntax highlighting

24. **`src/app/components/features/terraform/terraform-module-card.tsx`** - Module card:
    - Name (monospace), version, provider badge (AWS orange, Azure blue, GCP)
    - Confidence bar (green/yellow), input/output/dep counts
    - Expandable variable list with type, required badge, default value

25. **`src/app/components/features/terraform/terraform-code-preview.tsx`** - Code viewer:
    - File header with `main.tf` filename, copy + download buttons
    - `<pre>` with HCL syntax highlighting via CSS classes
    - Token classes: `.hl-kw` (purple), `.hl-str` (green), `.hl-attr` (blue), `.hl-val` (orange), `.hl-ref` (accent), `.hl-cmt` (gray)

26. **`src/app/components/features/terraform/terraform-view-switcher.tsx`** - Compose | Modules tabs:
    - Follows `cli-monitor/view-switcher.tsx`, uses `ChatCircle` + `Cube` Phosphor icons

27. **`src/app/components/features/terraform/terraform-sync-bar.tsx`** - Sync status:
    - Green dot, "N modules synced from HCP Terraform · Last sync: X min ago"

28. **`src/app/components/features/terraform/terraform-welcome-state.tsx`** - Empty state:
    - Terraform cube icon, title, description, quick-start pill buttons

29. **`src/app/components/features/terraform/terraform-catalog-view.tsx`** - Module catalog:
    - Search input, filter chips, grid of catalog cards

**Files to modify:**

30. **`src/app/components/features/sidebar.tsx`** - Add to `contentNavItems`:
    ```typescript
    { label: 'Terraform', to: '/terraform', icon: Cube, testId: 'nav-terraform' }
    ```
    (`Cube` is already imported from `@phosphor-icons/react`)

## Conversation Flow (Real)

```
User: "I need a VPC with 3 private subnets and an EKS cluster"
  ↓
API: Query local DB for all modules → send to Anthropic API with user message
  ↓ (Anthropic matches modules, returns ranked list)
SSE: Stream module matches + response text
  ↓
API: Inspect matched modules' required variables → generate clarifying questions
  ↓
SSE: Stream clarifying questions (region, CIDR, instance type, etc.)
  ↓
User: Answers questions via UI
  ↓
API: Inject full module interfaces + user answers into Anthropic API
  ↓ (Anthropic generates composed HCL using module sources, variables, outputs)
SSE: Stream generated Terraform code
  ↓
Code preview: Shows composed main.tf with real module sources from private registry
```

## Build Order

Phases 1+2 can run in parallel (no cross-dependencies). Phase 3 depends on 1+2. Phase 4 depends on 3.

```
Phase 0: Wireframes (3 HTML files)     ← can be concurrent with Phase 1
Phase 1: Agent 1 (Schema + Sync)       ← no dependencies
Phase 2: Agent 2 (Compose + AI)        ← depends on schema types from Agent 1
Phase 3: Agent 3 (Routes + Wiring)     ← depends on services from Agents 1+2
Phase 4: Agent 4 (UI + Components)     ← depends on API from Agent 3
```

For max parallelism: run Agent 1 first, then Agents 2+3+4 concurrently once schema is committed.

## Execution

4 concurrent opus subagents. Agent 1 runs first (schema), then Agents 2-4 run in parallel.

| Agent | Focus | Files Created |
|-------|-------|---------------|
| 1 | Schema + Sync + Scheduler | 8 files: schema, client, service, errors, scheduler |
| 2 | Compose Service + AI | 4 files: compose service, prompt builder, schemas, barrel |
| 3 | API Routes + Wiring | 4 files modified: routes, router, api.ts, client |
| 4 | UI + Routes | 14 files: 3 routes, 10 components, 1 sidebar modification |

**Total: ~30 files** (22 new, 8 modified)

## Critical Reference Files

| Pattern | File to Follow |
|---------|---------------|
| DB Schema | `src/db/schema/marketplaces.ts` |
| Service | `src/services/marketplace.service.ts` |
| API Routes | `src/server/routes/marketplaces.ts` |
| Route Layout | `src/app/routes/cli-monitor.tsx` |
| View Switcher | CLI Monitor view switcher pattern |
| Sidebar Nav | `src/app/components/features/sidebar.tsx` lines 49-54 |
| Sync Scheduler | `src/services/template-sync-scheduler.ts` |
| Error Types | `src/lib/errors/marketplace-errors.ts` |

## Verification

1. `npm run dev` - both servers start
2. Configure TFE token in Settings → API Keys
3. Create registry via API: `POST /api/terraform/registries` with org name
4. Trigger sync: `POST /api/terraform/registries/:id/sync`
5. Verify modules cached: `GET /api/terraform/modules` returns real HCP modules
6. Navigate to `/terraform/modules` - real private modules rendered in catalog grid
7. Navigate to `/terraform` - composer loads with welcome state + quick-starts
8. Type "I need a VPC with private subnets and an EKS cluster"
9. AI streams response matching real modules from catalog, asks clarifying questions
10. Answer questions → generates real HCL with `app.terraform.io/org/module/provider` sources
11. Code preview panel shows valid Terraform with module cross-references
12. Download .tf button produces valid file
