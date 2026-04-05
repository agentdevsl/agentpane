# tf-consumer-plan Flow Diagram

Mapping of the `tf-consumer-plan` orchestrator skill and its interaction with the `tf-consumer-research` and `tf-consumer-design` agents.

## Full Flow

```
┌──────────────────────────────────────────────────────────────────────────┐
│                    tf-consumer-plan (Orchestrator Skill)                 │
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
│  │          MCP: list_terraform_orgs (verify TFE_TOKEN)               │  │
│  │          Consumer workflows deploy to HCP Terraform —              │  │
│  │          TFE_TOKEN is critical.                                    │  │
│  │          Fails? ──▶ STOP                                           │  │
│  │                │ OK                                                │  │
│  │                ▼                                                   │  │
│  │  Step 2: Parse $ARGUMENTS (project name, provider, description)    │  │
│  │          Incomplete? ──▶ AskUserQuestion                           │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 3: Create GitHub issue                                       │  │
│  │          - Read issue-body-template.md                             │  │
│  │          - Fill placeholders (consumer context — modules           │  │
│  │            composed, not resources created)                        │  │
│  │          - gh issue create --title "Consumer: {project-name}"      │  │
│  │            → capture $ISSUE_NUMBER                                 │  │
│  │          (issue body updated again after Step 6 with               │  │
│  │           module selections and scope boundaries)                  │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 4: create-new-feature.sh --json --workflow consumer          │  │
│  │          --issue $ISSUE_NUMBER --short-name "<project-name>"       │  │
│  │          "<feature description>"                                   │  │
│  │          → capture $BRANCH_NAME as $FEATURE and $DESIGN_FILE       │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 5: Scan requirements against tf-domain-category              │  │
│  │          Focus: module composition ambiguity, networking           │  │
│  │          integration, workspace configuration decisions            │  │
│  │                │                                                   │  │
│  │                ▼                                                   │  │
│  │  Step 6: AskUserQuestion (up to 4 questions)                       │  │
│  │          MUST include ALL of:                                      │  │
│  │          ┌──────────────────────────────────────────────┐          │  │
│  │          │ Q1: Module selection — which private registry│          │  │
│  │          │     modules and approximate versions?        │          │  │
│  │          │ Q2: Environment/workspace — target workspace,│          │  │
│  │          │     region, credential pattern (dynamic      │          │  │
│  │          │     credentials, assume_role)?               │          │  │
│  │          │ Q3: Security — encryption, public access,    │          │  │
│  │          │     IAM considerations                       │          │  │
│  │          │ Q4: Scope/integration — networking,          │          │  │
│  │          │     monitoring, cross-workspace dependencies │          │  │
│  │          └──────────────────┬───────────────────────────┘          │  │
│  │                             │                                      │  │
│  │                             ▼                                      │  │
│  │  Step 7: Launch 3-4 CONCURRENT tf-consumer-research agents         │  │
│  │          (run in foreground — they use MCP tools)                   │  │
│  │          Wait for all to complete.                                  │  │
│  │          Verify research files exist at                             │  │
│  │          specs/{FEATURE}/research-*.md via Glob.                    │  │
│  │                                                                    │  │
│  │  ┌──────────────┐ ┌──────────────┐ ┌──────────────┐ ┌──────────┐ │  │
│  │  │tf-consumer-  │ │tf-consumer-  │ │tf-consumer-  │ │tf-consmr-│ │  │
│  │  │research      │ │research      │ │research      │ │research  │ │  │
│  │  │ (Agent 1)    │ │ (Agent 2)    │ │ (Agent 3)    │ │(Agent 4) │ │  │
│  │  │              │ │              │ │              │ │ optional  │ │  │
│  │  │ Private      │ │ AWS          │ │ Module       │ │Workspace │ │  │
│  │  │ registry     │ │ architecture │ │ wiring       │ │& deploy  │ │  │
│  │  │ modules      │ │              │ │              │ │          │ │  │
│  │  │              │ │              │ │              │ │          │ │  │
│  │  │ INPUT:       │ │ INPUT:       │ │ INPUT:       │ │ INPUT:   │ │  │
│  │  │ 1 question   │ │ 1 question   │ │ 1 question   │ │1 question│ │  │
│  │  │              │ │              │ │              │ │          │ │  │
│  │  │ MCP calls:   │ │ MCP calls:   │ │ MCP calls:   │ │MCP calls:│ │  │
│  │  │ -search_     │ │ -aws_search  │ │ -get_private │ │-list_    │ │  │
│  │  │  private_    │ │ -aws_read    │ │  _module_    │ │ variable │ │  │
│  │  │  modules     │ │              │ │  details     │ │ _sets    │ │  │
│  │  │ -get_private │ │              │ │ -search_     │ │-get_     │ │  │
│  │  │  _module_    │ │              │ │  private_    │ │ workspace│ │  │
│  │  │  details     │ │              │ │  modules     │ │ _details │ │  │
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
│  │  Step 8: Launch tf-consumer-design agent                           │  │
│  │  ┌──────────────────────────────────────────────────────────────┐  │  │
│  │  │             tf-consumer-design (Agent)                       │  │  │
│  │  │                                                              │  │  │
│  │  │  INPUT (via $ARGUMENTS):                                     │  │  │
│  │  │  - FEATURE path                                              │  │  │
│  │  │  - Clarified requirements                                    │  │  │
│  │  │                                                              │  │  │
│  │  │  READS ITSELF:                                               │  │  │
│  │  │  - specs/{FEATURE}/research-*.md (research findings)         │  │  │
│  │  │  - .foundations/memory/consumer-constitution.md               │  │  │
│  │  │  - .foundations/templates/consumer-design-template.md         │  │  │
│  │  │                                                              │  │  │
│  │  │  PRODUCES 6 SECTIONS:                                        │  │  │
│  │  │  ┌────────────────────────────────────────────────────────┐  │  │  │
│  │  │  │ § 1. Purpose & Requirements                            │  │  │  │
│  │  │  │ § 2. Module Inventory & Wiring (composition map)      │  │  │  │
│  │  │  │ § 3. Interface Contract (variables + outputs)         │  │  │  │
│  │  │  │ § 4. Security Controls                                │  │  │  │
│  │  │  │ § 5. Implementation Checklist                         │  │  │  │
│  │  │  │ § 6. Open Questions                                   │  │  │  │
│  │  │  │                                                        │  │  │  │
│  │  │  │ NOTE: No Test Scenarios section — consumer workflows   │  │  │  │
│  │  │  │ do not include a test-writer agent.                    │  │  │  │
│  │  │  └────────────────────────────────────────────────────────┘  │  │  │
│  │  │                                                              │  │  │
│  │  │  OUTPUT: specs/{FEATURE}/consumer-design.md                  │  │  │
│  │  └──────────────────────────────────────────────────────────────┘  │  │
│  │                         │                                          │  │
│  │                         ▼                                          │  │
│  │  Step 9:  Glob — specs/{FEATURE}/consumer-design.md exists?        │  │
│  │           No? → Re-launch tf-consumer-design once                  │  │
│  │                         │ Yes                                      │  │
│  │                         ▼                                          │  │
│  │  Step 10: Grep — all 6 sections present?                           │  │
│  │           (## 1. Purpose through ## 6. Open Questions)             │  │
│  │           Missing? → Fix inline                                    │  │
│  │                         │ All present                              │  │
│  │                         ▼                                          │  │
│  │  Step 11: AskUserQuestion — present design summary                 │  │
│  │           ┌─────────────────────────────────────────────┐          │  │
│  │           │ Summary: module count, wiring connection    │          │  │
│  │           │ count, variable count, security controls,   │          │  │
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
│  Design approved at specs/{FEATURE}/consumer-design.md                   │
│  Run /tf-consumer-implement $FEATURE to build.                           │
└──────────────────────────────────────────────────────────────────────────┘
```

## Data Flow Summary

```
User prompt
    │
    ▼
tf-consumer-plan orchestrator
    │
    ├──▶ validate-env.sh + MCP list_terraform_orgs (TFE_TOKEN gate)
    │
    ├──▶ Parse arguments + AskUserQuestion (4 clarifications)
    │         │
    │         ▼
    │    Clarified requirements ─────────────────────────────────┐
    │    (module selection, workspace, security, scope)           │
    │                                                            │
    ├──▶ 3-4x tf-consumer-research agents (concurrent, write to disk)
    │    ┌──────────┐ ┌──────────┐ ┌──────────┐ ┌──────────┐   │
    │    │ Private  │ │ AWS      │ │ Module   │ │Workspace │   │
    │    │ registry │ │ architec │ │ wiring   │ │& deploy  │   │
    │    │ modules  │ │ ture     │ │ patterns │ │          │   │
    │    └─────┬────┘ └────┬─────┘ └────┬─────┘ └────┬─────┘   │
    │          └───────────┴────────────┴─────────────┘         │
    │                      │                                     │
    │              Research files: specs/{FEATURE}/research-*.md │
    │                                                            │
    │                                                            ▼
    ├──▶ tf-consumer-design agent ◀──── requirements + $FEATURE
    │         │
    │         │  Also reads (itself):
    │         │  - specs/{FEATURE}/research-*.md
    │         │  - consumer-constitution.md
    │         │  - consumer-design-template.md
    │         │
    │         ▼
    │    specs/{FEATURE}/consumer-design.md   ◀── SINGLE OUTPUT ARTIFACT
    │
    ├──▶ Orchestrator verifies (Glob + Grep, never reads content)
    │
    └──▶ User approval gate (AskUserQuestion)
              │
              ▼
         /tf-consumer-implement picks up from here
```

## Handoff to tf-consumer-implement

```
┌─────────────────┐                                    ┌──────────────────┐
│ tf-consumer-plan│  produces                          │tf-consumer-      │
│ (Phases 1-2)    │ ──────▶ consumer-design.md ──────▶ │implement         │
│                 │         (approved)                  │(Phases 3-4)      │
└─────────────────┘                                    └──────────────────┘

The ONLY artifact passed between the two skills is:
    specs/{FEATURE}/consumer-design.md

Research artifacts (specs/{FEATURE}/research-*.md) persist on disk but are consumed only by the design agent.
```

## Analysis: Consumer-Specific Rules

The consumer workflow diverges from the module workflow in several important ways. These differences are non-negotiable constraints baked into the orchestrator skill.

### 1. TFE_TOKEN is a Hard Gate

Unlike the module workflow (which can run locally against provider docs), the consumer workflow deploys to HCP Terraform. Step 1 performs a dual gate: `validate-env.sh` for general environment checks, then `list_terraform_orgs` via MCP to verify the TFE_TOKEN is valid and the organization is reachable. Both must pass before any work begins.

### 2. Private Modules Only

Consumer research agents call `search_private_modules` and `get_private_module_details` -- not the public registry equivalents (`search_modules`, `get_module_details`). Consumer workflows compose infrastructure from an organization's private registry. Public module references are not used.

### 3. 6 Design Sections, Not 7

The module workflow produces a `design.md` with 7 sections (including `## 5. Test Scenarios`). The consumer workflow produces a `consumer-design.md` with only 6 sections:

| Section | Module Workflow               | Consumer Workflow              |
|---------|-------------------------------|--------------------------------|
| 1       | Purpose & Requirements        | Purpose & Requirements         |
| 2       | Resources & Architecture      | Module Inventory & Wiring      |
| 3       | Interface Contract            | Interface Contract             |
| 4       | Security Controls             | Security Controls              |
| 5       | **Test Scenarios**            | Implementation Checklist       |
| 6       | Implementation Checklist      | Open Questions                 |
| 7       | Open Questions                | _(does not exist)_             |

The consumer workflow has no test-writer agent and no test scenarios section. Verification at Step 10 checks for 6 sections (`## 1. Purpose` through `## 6. Open Questions`), not 7.

### 4. No Test-Writer Agent

The consumer implementation phase (`tf-consumer-implement`) does not launch a `tf-consumer-test-writer`. Module composition is validated through `terraform validate`, `terraform plan`, and workspace-level checks -- not through `terraform test` with `.tftest.hcl` files.

### 5. GitHub Issue Uses "Consumer:" Prefix

Step 3 creates the issue with `--title "Consumer: {project-name}"`, distinguishing it from module issues (no prefix) and provider issues in the issue tracker.

### 6. Clarification Questions Target Composition Concerns

The 4 mandatory clarification areas are consumer-specific:

- **Module selection**: Which private registry modules, not which raw resources
- **Environment/workspace**: HCP Terraform workspace, region, credential pattern (dynamic credentials, assume_role)
- **Security**: Encryption, public access, IAM -- same domain but at the composition layer
- **Scope/integration**: Cross-workspace dependencies, networking, monitoring -- concerns that arise from wiring modules together rather than implementing individual resources
