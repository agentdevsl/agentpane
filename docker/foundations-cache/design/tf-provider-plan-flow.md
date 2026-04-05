# tf-provider-plan Flow Diagram

Mapping of the `tf-provider-plan` orchestrator skill and its interaction with the `tf-provider-research` and `tf-provider-design` agents.

## Full Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      tf-provider-plan (Orchestrator Skill)              │
│                           Phases 1 + 2                                  │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PHASE 1: REQUIREMENTS & RESEARCH                                        │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Step 1: Run validate-env.sh --json                                │  │
│  │          gate_passed=false? ──Yes──▶ STOP                          │  │
│  │                │ OK                                                │  │
│  │                ▼                                                   │  │
│  │          Run `go version` (Go >= 1.21 required)                    │  │
│  │          Go missing or < 1.21? ──Yes──▶ STOP                       │  │
│  │                │ OK                                                │  │
│  │                ▼                                                   │  │
│  │  Step 2: Parse $ARGUMENTS (resource name, provider)                │  │
│  │          Incomplete? ──▶ AskUserQuestion                           │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │          Create GitHub issue                                       │  │
│  │          - Read issue-body-template.md                             │  │
│  │          - Fill placeholders                                       │  │
│  │          - gh issue create                                         │  │
│  │            --title "Provider Resource: {provider}_{service}_{resource}" │  │
│  │          - Capture $ISSUE_NUMBER                                   │  │
│  │          (issue body updated again after Step 6)                   │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 4: create-new-feature.sh --json --workflow provider          │  │
│  │          --issue $ISSUE_NUMBER --short-name "<resource-name>"      │  │
│  │          Parse JSON → capture $BRANCH_NAME as $FEATURE             │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 5: Scan requirements against tf-domain-category              │  │
│  │          Focus on:                                                 │  │
│  │          - API behavior ambiguity                                  │  │
│  │          - State management decisions (ForceNew vs in-place)       │  │
│  │          - Error handling patterns                                 │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 6: AskUserQuestion (up to 5 questions)                       │  │
│  │          MUST include:                                             │  │
│  │          - Update behavior (ForceNew vs in-place update)           │  │
│  │          - Test environment                                        │  │
│  │          - Security questions                                      │  │
│  │          ┌──────────────────────────────────┐                      │  │
│  │          │ User answers clarifications      │                      │  │
│  │          └──────────────┬───────────────────┘                      │  │
│  │                         │                                          │  │
│  │                         ▼                                          │  │
│  │  Step 7: Launch 3-4 CONCURRENT tf-provider-research agents         │  │
│  │                                                                    │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ │  │
│  │  │tf-provider-  │ │tf-provider-  │ │tf-provider-  │ │tf-provdr-│ │  │
│  │  │research      │ │research      │ │research      │ │research  │ │  │
│  │  │  (Agent 1)   │ │  (Agent 2)   │ │  (Agent 3)   │ │(Agent 4) │ │  │
│  │  │              │ │              │ │              │ │ optional  │ │  │
│  │  │ API/SDK      │ │ Plugin       │ │ Existing     │ │ Import/  │ │  │
│  │  │ docs         │ │ Framework    │ │ provider     │ │ state    │ │  │
│  │  │              │ │ patterns     │ │ impls        │ │ patterns │ │  │
│  │  │              │ │              │ │              │ │          │ │  │
│  │  │ INPUT:       │ │ INPUT:       │ │ INPUT:       │ │ INPUT:   │ │  │
│  │  │ 1 question   │ │ 1 question   │ │ 1 question   │ │1 question│ │  │
│  │  │              │ │              │ │              │ │          │ │  │
│  │  │ MCP calls:   │ │ MCP calls:   │ │ MCP calls:   │ │MCP calls:│ │  │
│  │  │ -WebSearch   │ │ -WebSearch   │ │ -WebSearch   │ │-WebSearch│ │  │
│  │  │ -WebFetch    │ │ -WebFetch    │ │ -WebFetch    │ │-WebFetch │ │  │
│  │  │  (API docs)  │ │  (framework  │ │  (provider   │ │ (import  │ │  │
│  │  │              │ │   docs)      │ │   source)    │ │  specs)  │ │  │
│  │  │              │ │              │ │              │ │          │ │  │
│  │  │ OUTPUT:      │ │ OUTPUT:      │ │ OUTPUT:      │ │ OUTPUT:  │ │  │
│  │  │ research-    │ │ research-    │ │ research-    │ │research- │ │  │
│  │  │ {slug}.md    │ │ {slug}.md    │ │ {slug}.md    │ │{slug}.md │ │  │
│  │  │ TO DISK      │ │ TO DISK      │ │ TO DISK      │ │TO DISK   │ │  │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └────┬─────┘ │  │
│  │         │                │                │              │        │  │
│  │         └────────────────┴────────┬───────┴──────────────┘        │  │
│  │                                   │                               │  │
│  │                    All findings written to disk as                 │  │
│  │                    specs/{FEATURE}/research-{slug}.md              │  │
│  │                    Verified via Glob                               │  │
│  └───────────────────────────────────┬───────────────────────────────┘  │
│                                      │                                  │
│            Orchestrator holds:                                           │
│            - Clarified requirements (from Step 6)                        │
│            - $FEATURE path                                               │
│            - Resource name + provider                                    │
│            Research files on disk at specs/{FEATURE}/research-*.md       │
│                                      │                                  │
│                                      ▼                                  │
│  PHASE 2: DESIGN                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Step 8: Launch tf-provider-design agent                           │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │               tf-provider-design (Agent)                     │  │  │
│  │  │                                                              │  │  │
│  │  │  INPUT (via $ARGUMENTS):                                     │  │  │
│  │  │  - FEATURE path                                              │  │  │
│  │  │  - RESOURCE name                                             │  │  │
│  │  │  - Clarified requirements                                    │  │  │
│  │  │                                                              │  │  │
│  │  │  READS ITSELF:                                               │  │  │
│  │  │  - specs/{FEATURE}/research-*.md (research findings)         │  │  │
│  │  │  - .foundations/memory/provider-constitution.md               │  │  │
│  │  │  - .foundations/templates/provider-design-template.md         │  │  │
│  │  │                                                              │  │  │
│  │  │  PRODUCES 7 SECTIONS:                                        │  │  │
│  │  │  ┌────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │ § 1. Purpose                                           │  │  │  │
│  │  │  │ § 2. Schema & Attributes                               │  │  │  │
│  │  │  │ § 3. CRUD Operations                                   │  │  │  │
│  │  │  │ § 4. State Management & Import                         │  │  │  │
│  │  │  │ § 5. Test Scenarios                                    │  │  │  │
│  │  │  │ § 6. Implementation Checklist                          │  │  │  │
│  │  │  │ § 7. Open Questions                                    │  │  │  │
│  │  │  └────────────────────────────────────────────────────────┘  │  │  │
│  │  │                                                              │  │  │
│  │  │  VALIDATES before writing:                                   │  │  │
│  │  │  - Every attribute has Type + Description                    │  │  │
│  │  │  - CRUD operations defined (Create/Read/Update/Delete)       │  │  │
│  │  │  - ForceNew vs in-place decisions documented per attribute   │  │  │
│  │  │  - Import strategy specified                                 │  │  │
│  │  │  - Test scenarios cover CRUD + import + error paths          │  │  │
│  │  │  - Every scenario has >= 2 assertions                        │  │  │
│  │  │  - Checklist items present                                   │  │  │
│  │  │  - No cross-section line references                          │  │  │
│  │  │                                                              │  │  │
│  │  │  OUTPUT: specs/{FEATURE}/provider-design-{resource}.md       │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                         │                                          │  │
│  │                         ▼                                          │  │
│  │  Step 9:  Glob — specs/{FEATURE}/provider-design-{resource}.md    │  │
│  │           exists?                                                  │  │
│  │           No? → Re-launch tf-provider-design once                  │  │
│  │                         │ Yes                                      │  │
│  │                         ▼                                          │  │
│  │  Step 10: Grep — all 7 sections present?                           │  │
│  │           (## 1. Purpose through ## 7. Open Questions)             │  │
│  │           Missing? → Fix inline                                    │  │
│  │                         │ All present                              │  │
│  │                         ▼                                          │  │
│  │  Step 11: AskUserQuestion — present design summary                 │  │
│  │           ┌─────────────────────────────────────────────┐          │  │
│  │           │ Summary: attribute counts, CRUD operations, │          │  │
│  │           │ test scenario counts, checklist items       │          │  │
│  │           │                                             │          │  │
│  │           │ Options:                                    │          │  │
│  │           │   [Approve]  [Review file first]  [Changes] │          │  │
│  │           └──────────────────┬──────────────────────────┘          │  │
│  │                              │                                     │  │
│  │                   ┌──────────┼──────────┐                          │  │
│  │                   ▼          ▼          ▼                          │  │
│  │              Approve    Review     Request Changes                  │  │
│  │                 │       file first       │                          │  │
│  │                 │          │              │                          │  │
│  │                 │          │    Step 12: Apply changes,             │  │
│  │                 │          │    re-present (loop until approved)    │  │
│  │                 │          │              │                          │  │
│  │                 │          └──────────────┘                          │  │
│  │                 │                │                                  │  │
│  │                 ▼                ▼                                  │  │
│  │                 └────────┬───────┘                                  │  │
│  │                          │ APPROVED                                │  │
│  └──────────────────────────┼─────────────────────────────────────────┘  │
│                             │                                            │
│                             ▼                                            │
│  DONE                                                                    │
│  Design approved at specs/{FEATURE}/provider-design-{resource}.md        │
│  Run /tf-provider-implement $FEATURE $RESOURCE to build.                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

```
User prompt
    │
    ▼
tf-provider-plan orchestrator
    │
    ├──▶ Parse arguments + AskUserQuestion (clarifications)
    │         │
    │         ▼
    │    Clarified requirements ─────────────────────────────────┐
    │                                                            │
    ├──▶ 3-4x tf-provider-research agents (concurrent, write to disk)
    │    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
    │    │ API/SDK  │ │ Plugin   │ │ Existing │ │ Import/  │   │
    │    │ docs Q   │ │Framework │ │ provider │ │ state    │   │
    │    │          │ │ patterns │ │ impls    │ │ patterns │   │
    │    └─────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
    │          └───────────┴────────────┴─────────────┘         │
    │                      │                                     │
    │              Research files: specs/{FEATURE}/research-*.md │
    │                                                            │
    │                                                            ▼
    ├──▶ tf-provider-design agent ◀──── requirements + $FEATURE + $RESOURCE
    │         │
    │         │  Also reads (itself):
    │         │  - specs/{FEATURE}/research-*.md
    │         │  - provider-constitution.md
    │         │  - provider-design-template.md
    │         │
    │         ▼
    │    specs/{FEATURE}/provider-design-{resource}.md   ◀── SINGLE OUTPUT ARTIFACT
    │
    ├──▶ Orchestrator verifies (Glob + Grep, never reads content)
    │
    └──▶ User approval gate (AskUserQuestion)
              │
              ▼
         /tf-provider-implement picks up from here
```

## Handoff to tf-provider-implement

```
┌─────────────────┐                                    ┌──────────────────┐
│ tf-provider-plan │  produces                          │tf-provider-      │
│ (Phases 1-2)    │ ──────▶ provider-design-    ──────▶│implement         │
│                 │         {resource}.md               │(Phases 3-4)     │
│                 │         (approved)                  │                  │
└─────────────────┘                                    └──────────────────┘

The ONLY artifact passed between the two skills is:
    specs/{FEATURE}/provider-design-{resource}.md

Research artifacts (specs/{FEATURE}/research-*.md) persist on disk
but are consumed only by the design agent.
```

## Analysis: Does the Flow Make Sense?

**Yes, the flow is well-structured.** It faithfully adapts the module planning pattern for provider development while adding provider-specific gates and concerns.

### What's Right

1. **Go version gate (Step 1)**: Provider development requires Go, and the dual gate (validate-env.sh + explicit `go version` check) catches environment issues before any work begins. This is provider-specific and not present in the module flow.

2. **Single design artifact (P1)**: The planning phase produces one design file: `specs/{FEATURE}/provider-design-{resource}.md`. Research files (`specs/{FEATURE}/research-*.md`) are intermediate artifacts consumed by the design agent.

3. **Research persisted to disk (P4)**: The tf-provider-research agents write findings to `specs/{FEATURE}/research-{slug}.md`. The design agent reads these files directly -- the orchestrator only verifies they exist via Glob and passes the FEATURE path.

4. **Provider-specific research focus**: The four research lanes (API/SDK docs, Plugin Framework patterns, existing implementations, import/state patterns) target the exact knowledge a provider resource author needs. This contrasts with the module flow's research lanes (provider docs, AWS best practices, registry patterns, edge cases).

5. **State management decisions front-loaded**: The mandatory clarification question on ForceNew vs in-place update behavior (Step 6) and the ambiguity scan focus on state management (Step 5) ensure these critical provider decisions are resolved before design begins. ForceNew/in-place mistakes are expensive to fix post-implementation.

6. **Orchestrator directs, doesn't accumulate (P6)**: The orchestrator passes short context (requirements, file paths, resource name) to agents. It verifies research and design files exist via Glob and checks section presence via Grep. It never reads the full content itself.

7. **Agents have one job (P5)**: Each tf-provider-research agent answers exactly ONE question. The tf-provider-design agent takes requirements + findings and produces exactly ONE file.

### Things to Watch

1. **Step 3 is skipped in numbering**: The SKILL.md source goes 1, 2, 4, 5, 6, 7 -- there is no Step 3. This appears intentional (possibly a removed step) but could cause confusion when referencing step numbers in logs or error messages.

2. **GitHub issue created before clarification**: Same pattern as the module flow -- the issue is created at Step 2 and updated after Step 6. If the workflow fails between Steps 2 and 6, an orphaned issue with placeholder content exists. Operational edge case, not a design flaw.

3. **5 clarification questions vs module's 4**: The provider flow allows up to 5 questions (vs the module flow's 4). The extra question budget reflects the additional complexity of provider development (API behavior, state management, error handling) but increases user friction. Worth monitoring whether all 5 are typically needed.
