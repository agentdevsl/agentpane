---
name: "tf-domain-category"
description: "8 category ambiguity taxonomy for Terraform infrastructure specifications. Structured scan methodology, prioritization heuristics, and clarification question patterns. Use when scanning Terraform specifications for ambiguity, missing decision points, or underspecified requirements."
source: image
---
# Terraform Specification Ambiguity Taxonomy

## Purpose

Detect and reduce ambiguity or missing decision points in feature specifications. Each category is scanned and marked: Clear / Partial / Missing.

## 8-Category Taxonomy

### 1. Functional Scope & Behavior

- Core user goals & success criteria
- Explicit out-of-scope declarations
- User roles / personas differentiation

### 2. Domain & Data Model

- Entities, attributes, relationships
- Identity & uniqueness rules
- Lifecycle/state transitions
- Data volume / scale assumptions

### 3. Operational Workflows & Day-2 Operations

- Provisioning and deployment sequences
- Day-2 operations (scaling, patching, rotation)
- Failure recovery and rollback procedures

### 4. Non-Functional Quality Attributes

- Performance (latency, throughput targets)
- Scalability (horizontal/vertical, limits)
- Reliability & availability (uptime, recovery expectations)
- Observability (logging, metrics, tracing signals)
- Security & privacy (authN/Z, data protection, threat assumptions)
- Compliance / regulatory constraints

### 5. Integration & External Dependencies

- External services/APIs and failure modes
- Data import/export formats
- Protocol/versioning assumptions

### 6. Edge Cases & Failure Handling

- Negative scenarios
- Rate limiting / throttling
- Resource dependency failures and circular references
- Service quota/limit exhaustion
- State drift and import scenarios

### 7. Constraints & Tradeoffs

- Technical constraints (language, storage, hosting)
- Explicit tradeoffs or rejected alternatives

### 8. Terminology & Consistency

- Canonical glossary terms
- Avoided synonyms / deprecated terms

## Bonus Categories (check but lower priority)

- **Completion Signals**: Acceptance criteria testability, measurable DoD indicators
- **Misc / Placeholders**: TODO markers, ambiguous adjectives ("highly available", "scalable", "secure") lacking quantification

## Prioritization Heuristic

Rank by `Impact x Uncertainty`:

- High impact + high uncertainty → ask first
- Low impact regardless of uncertainty → skip or defer
- Categories already Clear → skip entirely

## Question Constraints

- Maximum 6 questions per session, 10 across full session
- One question slot is **mandatory** and reserved for the security-defaults question: confirming which security defaults (encryption, IAM boundaries, logging) the user wants applied vs. customized. This counts toward the per-session maximum.
- Each question must be answerable with:
  - Multiple-choice (2-5 options), OR
  - Short answer (≤5 words)
- Only include questions whose answers materially impact: architecture, data modeling, task decomposition, test design, UX behavior, operational readiness, or compliance
- Cover highest-impact unresolved categories first

## Question Exclusions

- Already answered in spec
- Trivial stylistic preferences
- Plan-level execution details (unless blocking correctness)

## Terraform-Specific Focus Areas

When scanning Terraform infrastructure specs, pay special attention to:

- Network topology ambiguity (VPC layout, subnet strategy, connectivity)
- IAM permission scope (least privilege boundaries)
- Encryption requirements (at-rest, in-transit, key management)
- Multi-region/AZ strategy
- State management and backend configuration
- Environment promotion strategy
