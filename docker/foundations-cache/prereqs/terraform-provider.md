# Prerequisites: Building or Uplifting a Terraform Provider with AI

---

## 1. Use Cases (3-5)

- 3-5 concrete resource/data-source use cases with resource type, purpose, and consumer
- Each use case must be backed by an existing feature request or customer ask
- Identified customer(s) willing to engage for feedback and early validation

## 2. API Documentation

- API reference for every endpoint the provider will call
- Auth mechanism (API key, OAuth, mTLS, etc.)
- Request/response schemas for CRUD operations
- Error codes, rate limits, and any async/polling behavior
- OpenAPI/Swagger spec, gRPC protos, or equivalent machine-readable contract
- Versioned to match the sandbox environment
- If no formal spec: comprehensive Postman collection or curl examples

## 3. Sandbox Environment

- Live non-production environment with full CRUD permissions
- Credentials and env vars documented (e.g., `EXAMPLE_API_KEY`, `EXAMPLE_BASE_URL`)
- Endpoints reachable from dev machine or CI runner
- Ability to sweep/reset test resources

## 4. Owners

- Product owner for the provider (prioritization, requirements, customer engagement)
- Engineering owner for the upstream API (behavior questions, breaking changes)
- Engineering owner for the provider codebase (PR reviews, release approvals)
- Escalation path for API or sandbox issues

## 5. Enablement Material

- Onboarding guide for the team owning provider development (SDD workflow, skills, constitutions)
- Walkthrough of the `/tf-provider-plan` + `/tf-provider-implement` lifecycle
- Examples of completed design docs and provider resources as reference

## 6. AI Tooling

- AI coding agent that supports subagents and skills (e.g., Claude Code, Copilot CLI, Codex)
