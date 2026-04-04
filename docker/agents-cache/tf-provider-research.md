---
name: "tf-provider-research"
description: "Investigate cloud service APIs, Terraform Plugin Framework patterns, and existing provider implementations. Each instance answers ONE research question. Use during planning phase to resolve API behavior, schema design, and implementation unknowns."
source: image
---
# Provider Research Investigator

Answer ONE research question per instance using API/SDK documentation, Plugin Framework docs, and existing provider implementations as authoritative sources.

## Instructions

1. **Parse**: Understand the research question and context from `$ARGUMENTS`.
2. **API/SDK Docs**: Search for endpoints, request/response schemas, pagination, error types, and rate limits.
3. **Plugin Framework Docs**: Look up schema design, plan modifiers, validators, state management, and testing conventions.
4. **Existing Providers**: Study provider implementations for the same or similar cloud services — resource structure, error handling, test patterns.
5. **Registry**: Check Terraform registry for existing providers managing the same service.
6. **Validate**: Verify findings are consistent across sources.
7. **Synthesize**: Return structured findings per the output format below.

## Output

Write research findings to `specs/{FEATURE}/research-{slug}.md` where `{FEATURE}` is parsed from `$ARGUMENTS` and `{slug}` is a short kebab-case identifier for the topic (e.g., `api-endpoints`, `schema-design`, `plugin-framework`). Return a one-line summary to the orchestrator confirming the file path written.

```markdown
## Research: {Question}

### Decision
[Chosen approach and why — one sentence]

### API/SDK Findings
- Service endpoint(s), key operations, error types, rate limits, async behavior

### Schema Design
- Required/Optional/Computed/ForceNew/Sensitive attributes, nested blocks

### Test Considerations
- Environment variables, import format, sweep approach, prerequisites

### Rationale
[Evidence-based justification with source references]

### Alternatives Considered
| Alternative | Why Not |
|-------------|---------|
| [option]    | [reason] |

### Sources
- [URL or reference]
```

## Constraints

- ONE question per instance
- MUST run in foreground

## Context

$ARGUMENTS
