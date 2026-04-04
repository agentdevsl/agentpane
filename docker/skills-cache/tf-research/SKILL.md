---
name: "tf-research"
description: "Research strategies for AWS documentation, provider docs, and public registry patterns. Use when researching AWS services, investigating provider resources, or studying public registry modules for design patterns."
source: image
---
# Terraform Research Heuristics

## Parallel Research Pattern

|  Focus | Primary MCP Tools | Question Type |
|-------------|-------------------|---------------|
| Provider resources | `search_providers` + `get_provider_details` | How do the main resources work? Arguments, attributes, gotchas? |

| Registry patterns | `search_modules` + `get_module_details` | How do popular modules structure their interface? |
| Edge cases | `search_documentation` (troubleshooting) | What breaks? Common mistakes? |

## Research Priority Order

When developing module resources, research in this order:

1. **Provider Documentation** — Understand resource arguments, attributes, and behavior
2. **Public Registry Patterns** — Study well-regarded modules for design conventions and interfaces
3. **Private Registry** — Check if the organization has existing modules to learn from or avoid duplication
4. **AWS Documentation** — Verify service behavior, limits, and best practices (e.g., security controls)

4. **Security-Adjacent Resources** — For each resource in the module, research what companion resources AWS recommends for security (e.g., bucket policies for TLS enforcement, ownership controls, access logging). Use `search_documentation("[service] security best practices")`.

## Provider Documentation Strategy

1. Use single-word service slug: "vpc", "instance", "bucket"
2. Select data type: `resources` for deploying, `data-sources` for reading
3. Review documentation for required vs optional arguments
4. Note computed attributes for outputs

### Resource Investigation Checklist

For each resource in the module:

- [ ] Required arguments identified
- [ ] Optional arguments with secure defaults identified
- [ ] Computed attributes documented (for outputs)
- [ ] Timeouts documented
- [ ] Import support verified
- [ ] Known issues or caveats noted

## Public Registry Pattern Study

### Strategy

Study well-regarded public modules to learn design patterns:

1. Search for popular modules implementing similar infrastructure
2. Study their variable interfaces (what they expose, naming conventions)
3. Study their output interfaces (what they export)
4. Note conditional creation patterns (`count`, `for_each` with enable variables)
5. Note how they handle tags, naming, and security defaults

### Key Patterns to Look For

- **Variable naming**: How do mature modules name their inputs?
- **Output structure**: What attributes do consumers typically need?
- **Conditional creation**: How are optional features toggled?
- **Dynamic blocks**: How are repeatable nested configs handled?
- **Locals**: How are computed values organized?
- **Submodules**: When and how are submodules used?

### MCP Tools (registry)

- `search_modules(query)` — Search public registry for design pattern reference
- `get_module_details(moduleID)` — Get module documentation, inputs, outputs
- `search_private_modules(query)` — Check org private registry for existing modules
- `get_private_module_details(moduleID)` — Get private module details

## Research Output Format

For each research question, document:

```markdown
### [Component/Resource Name]

**AWS Service**: [service name]
**Terraform Resources**: [list of resources to use]

**Key Arguments**:
- `argument_name` (required/optional) — description, secure default if applicable

**Key Outputs**:
- `output_name` (`type`) — description

**Security Considerations**:
- [encryption, access control, logging requirements]

**Design Decisions**:
- [conditional creation approach, variable interface, defaults]

**References**:
- [Cloud Service Provider documentation URL]
- [Provider doc URL]
- [Public module pattern URL if studied]
- [CIS/NIST/OWASP citation]
```

## Common Research Pitfalls

1. **Assuming resource behavior** — Always verify with provider docs. Resource arguments and defaults change between provider versions.
2. **Missing computed attributes** — Check what the resource exports. Some attributes are only available after apply.
3. **Ignoring deprecation warnings** — Provider docs note deprecated arguments. Use the recommended replacement.
4. **Over-constraining provider versions** — Modules should use `>=` constraints, not `~>`, to maximize consumer compatibility.
