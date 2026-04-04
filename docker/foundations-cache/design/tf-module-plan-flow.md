# tf-module-plan Flow Diagram

Mapping of the `tf-module-plan` orchestrator skill and its interaction with the `tf-module-research` and `tf-module-design` agents.

## Full Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                      tf-module-plan (Orchestrator Skill)                     │
│                           Phases 1 + 2                                   │
├──────────────────────────────────────────────────────────────────────────┤
│                                                                          │
│  PHASE 1: REQUIREMENTS & RESEARCH                                        │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Step 1: Run validate-env.sh --json                                │  │
│  │          gate_passed=false? ──Yes──▶ STOP                          │  │
│  │                │ OK                                                │  │
│  │                ▼                                                   │  │
│  │  Step 2: Parse $ARGUMENTS (module name, provider, description)     │  │
│  │          Incomplete? ──▶ AskUserQuestion                           │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 3: Create GitHub issue                                       │  │
│  │          - Read issue-body-template.md                             │  │
│  │          - Fill placeholders                                       │  │
│  │          - gh issue create → capture $ISSUE_NUMBER                 │  │
│  │          (issue body updated again after Step 6)                   │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 4: create-new-feature.sh --json --issue $ISSUE_NUMBER        │  │
│  │          --short-name "<module-name>" "<feature description>"       │  │
│  │          → capture $BRANCH_NAME as $FEATURE and $DESIGN_FILE       │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 5: Scan requirements against tf-domain-category              │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 6: AskUserQuestion (up to 4 questions)                       │  │
│  │          MUST include security-defaults question                   │  │
│  │          ┌──────────────────────────────────┐                      │  │
│  │          │ User answers clarifications      │                      │  │
│  │          └──────────────┬───────────────────┘                      │  │
│  │                         │                                          │  │
│  │                         ▼                                          │  │
│  │  Step 7: Launch 3-4 CONCURRENT tf-module-research agents                 │  │
│  │          Wait for all to complete.                                  │  │
│  │          Verify research files exist at                             │  │
│  │          specs/{FEATURE}/research-*.md via Glob.                    │  │
│  │                                                                    │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ │  │
│  │  │ tf-module-research │ │ tf-module-research │ │ tf-module-research │ │ tf-module-research │ │  │
│  │  │  (Agent 1)   │ │  (Agent 2)   │ │  (Agent 3)   │ │  (Agent 4)   │ │  │
│  │  │              │ │              │ │              │ │  optional    │ │  │
│  │  │ Provider     │ │ AWS best     │ │ Registry     │ │ Edge         │ │  │
│  │  │ docs         │ │ practices    │ │ patterns     │ │ cases        │ │  │
│  │  │              │ │              │ │              │ │              │ │  │
│  │  │ INPUT:       │ │ INPUT:       │ │ INPUT:       │ │ INPUT:       │ │  │
│  │  │ 1 question   │ │ 1 question   │ │ 1 question   │ │ 1 question   │ │  │
│  │  │              │ │              │ │              │ │              │ │  │
│  │  │ MCP calls:   │ │ MCP calls:   │ │ MCP calls:   │ │ MCP calls:   │ │  │
│  │  │ -get_provider│ │ -aws_search  │ │ -search      │ │ -aws_read    │ │  │
│  │  │ -search_provs│ │ -aws_read    │ │  _modules    │ │ -get_provs   │ │  │
│  │  │              │ │ -aws_recomm  │ │ -get_module  │ │              │ │  │
│  │  │ OUTPUT:      │ │ OUTPUT:      │ │ OUTPUT:      │ │ OUTPUT:      │ │  │
│  │  │ research-    │ │ research-    │ │ research-    │ │ research-    │ │  │
│  │  │ {slug}.md    │ │ {slug}.md    │ │ {slug}.md    │ │ {slug}.md    │ │  │
│  │  │ TO DISK      │ │ TO DISK      │ │ TO DISK      │ │ TO DISK      │ │  │
│  │  └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ └──────┬───────┘ │  │
│  │         │                │                │              │        │  │
│  │         └────────────────┴────────┬───────┴──────────────┘        │  │
│  │                                   │                               │  │
│  │                    All findings written to disk as                  │  │
│  │                    specs/{FEATURE}/research-{slug}.md              │  │
│  └───────────────────────────────────┬───────────────────────────────┘  │
│                                      │                                  │
│            Orchestrator holds:                                           │
│            - Clarified requirements (from Step 6)                        │
│            - $FEATURE path                                               │
│            Research files on disk at specs/{FEATURE}/research-*.md       │
│                                      │                                  │
│                                      ▼                                  │
│  PHASE 2: DESIGN                                                         │
│  ┌────────────────────────────────────────────────────────────────────┐  │
│  │                                                                    │  │
│  │  Step 8: Launch tf-module-design agent                                   │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │               tf-module-design (Agent)                              │  │  │
│  │  │                                                              │  │  │
│  │  │  INPUT (via $ARGUMENTS):                                     │  │  │
│  │  │  - FEATURE path                                              │  │  │
│  │  │  - Clarified requirements                                    │  │  │
│  │  │                                                              │  │  │
│  │  │  READS ITSELF:                                               │  │  │
│  │  │  - specs/{FEATURE}/research-*.md (research findings)         │  │  │
│  │  │  - .foundations/memory/module-constitution.md                        │  │  │
│  │  │  - .foundations/templates/module-design-template.md            │  │  │
│  │  │                                                              │  │  │
│  │  │  PRODUCES 7 SECTIONS:                                        │  │  │
│  │  │  ┌────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │ § 1. Purpose & Requirements                            │  │  │  │
│  │  │  │ § 2. Resources & Architecture (resource inventory)    │  │  │  │
│  │  │  │ § 3. Interface Contract (variables + outputs)         │  │  │  │
│  │  │  │ § 4. Security Controls (6 domains)                    │  │  │  │
│  │  │  │ § 5. Test Scenarios (5 scenario groups)               │  │  │  │
│  │  │  │ § 6. Implementation Checklist (4-8 items)             │  │  │  │
│  │  │  │ § 7. Open Questions                                   │  │  │  │
│  │  │  └────────────────────────────────────────────────────────┘  │  │  │
│  │  │                                                              │  │  │
│  │  │  VALIDATES before writing:                                   │  │  │
│  │  │  - Every variable has Type + Description                     │  │  │
│  │  │  - Every resource has Logical Name + Key Config              │  │  │
│  │  │  - Every security control has CIS/WA reference               │  │  │
│  │  │  - Security controls map to test assertions                  │  │  │
│  │  │  - All 5 scenario groups present                             │  │  │
│  │  │  - Every scenario has >= 2 assertions                        │  │  │
│  │  │  - Checklist has 4-8 items                                   │  │  │
│  │  │  - No cross-section line references                          │  │  │
│  │  │  - Variable/resource names appear exactly once               │  │  │
│  │  │                                                              │  │  │
│  │  │  OUTPUT: specs/{FEATURE}/design.md                           │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                         │                                          │  │
│  │                         ▼                                          │  │
│  │  Step 9:  Glob — specs/{FEATURE}/design.md exists?                 │  │
│  │           No? → Re-launch tf-module-design once                          │  │
│  │                         │ Yes                                      │  │
│  │                         ▼                                          │  │
│  │  Step 10: Grep — all 7 sections present?                           │  │
│  │           (## 1. Purpose through ## 7. Open Questions)             │  │
│  │           Missing? → Fix inline                                    │  │
│  │                         │ All present                              │  │
│  │                         ▼                                          │  │
│  │  Step 11: AskUserQuestion — present design summary                 │  │
│  │           ┌─────────────────────────────────────────────┐          │  │
│  │           │ Summary: input/output counts, resource      │          │  │
│  │           │ count, security controls, test scenarios,   │          │  │
│  │           │ checklist items                             │          │  │
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
│  Design approved at specs/{FEATURE}/design.md                            │
│  Run /tf-module-implement $FEATURE to build.                                    │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

```
User prompt
    │
    ▼
tf-module-plan orchestrator
    │
    ├──▶ Parse arguments + AskUserQuestion (clarifications)
    │         │
    │         ▼
    │    Clarified requirements ─────────────────────────────────┐
    │                                                            │
    ├──▶ 3-4x tf-module-research agents (concurrent, write to disk)   │
    │    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
    │    │ Provider  │ │ AWS best │ │ Registry │ │ Edge     │   │
    │    │ docs Q    │ │ practice │ │ patterns │ │ cases    │   │
    │    └─────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
    │          └───────────┴────────────┴─────────────┘         │
    │                      │                                     │
    │              Research files: specs/{FEATURE}/research-*.md │
    │                                                            │
    │                                                            ▼
    ├──▶ tf-module-design agent ◀──── requirements + $FEATURE
    │         │
    │         │  Also reads (itself):
    │         │  - specs/{FEATURE}/research-*.md
    │         │  - module-constitution.md
    │         │  - module-design-template.md
    │         │
    │         ▼
    │    specs/{FEATURE}/design.md   ◀── SINGLE OUTPUT ARTIFACT
    │
    ├──▶ Orchestrator verifies (Glob + Grep, never reads content)
    │
    └──▶ User approval gate (AskUserQuestion)
              │
              ▼
         /tf-module-implement picks up from here
```

## Handoff to tf-module-implement

```
┌─────────────┐                              ┌──────────────┐
│ tf-module-plan  │  produces                    │ tf-module-implement  │
│ (Phases 1-2)│ ──────▶ design.md ──────▶    │ (Phases 3-4)  │
│             │         (approved)           │               │
└─────────────┘                              └──────────────┘

The ONLY artifact passed between the two skills is:
    specs/{FEATURE}/design.md

Research artifacts (specs/{FEATURE}/research-*.md) persist on disk but are consumed only by the design agent.
```

## Analysis: Does the Flow Make Sense?

**Yes, the flow is well-structured.** It faithfully implements AGENTS.md principles P1, P3, P4, P6, and P8.

### What's Right

1. **Single design artifact (P1)**: The planning phase produces one design file: `specs/{FEATURE}/design.md`. Research files (`specs/{FEATURE}/research-*.md`) are intermediate artifacts consumed by the design agent.

2. **Research persisted to disk (P4)**: The tf-module-research agents write findings to `specs/{FEATURE}/research-{slug}.md`. The design agent reads these files directly — the orchestrator only verifies they exist via Glob and passes the FEATURE path.

3. **Security embedded in design (P3)**: Security is woven through at three points:
   - Step 5: Ambiguity scan flags security-configurable features
   - Step 6: Mandatory security-defaults clarification question
   - tf-module-design agent: Mandatory Section 4 (Security Controls) with CIS/WA references, plus security assertions required in Section 5 tests

4. **Orchestrator directs, doesn't accumulate (P6)**: The orchestrator passes short context (requirements, file paths) to agents. It verifies research and design files exist via Glob and checks section presence via Grep. It never reads the full content itself.

5. **Phase order is fixed (P8)**: Understand must complete before Design starts. Research agents must all return before tf-module-design launches. User must approve before /tf-module-implement can run.

6. **Agents have one job (P5)**: Each tf-module-research agent answers exactly ONE question. The tf-module-design agent takes requirements + findings and produces exactly ONE file.

### One Thing to Watch

The GitHub issue is created at Step 3 (before clarification) and updated after Step 6 (after clarification). This means there's a window where the issue exists with incomplete information. This is intentional — the issue serves as a tracking anchor from the start — but if the workflow fails between Steps 3 and 6, there's an orphaned issue with placeholder content. Not a design flaw, just an operational edge case worth being aware of.
