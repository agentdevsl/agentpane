# mcp-skill

This is an auto-generated Claude Code skill from an MCP server.

## Installation

1. Copy this directory to your Claude Code skills location
2. The skill will be available for use in Claude Code

## Contents

- `SKILL.md` - Main skill documentation
- `scripts/` - TypeScript wrapper functions organized by category
  - `scripts/variables/` - Variables (11 wrapper functions)
  - `scripts/runs/` - Runs (3 wrapper functions)
  - `scripts/workspaces/` - Workspaces (5 wrapper functions)
  - `scripts/public-registry/` - Public Registry (9 wrapper functions)
  - `scripts/private-registry/` - Private Registry (4 wrapper functions)
  - `scripts/organization/` - Organization (2 wrapper functions)

Each category contains:

- Individual `.ts` files for each tool with input/output interfaces and wrapper functions
- `index.ts` - Barrel export for easy importing

## Original MCP Server

**Command:** `docker run -i --rm -e TFE_TOKEN=***REDACTED*** hashicorp/terraform-mcp-server`

**Tools:** 34 available

## Tool Categories

- **Variables** (11 tools): Variable and variable set management
- **Runs** (3 tools): Terraform run creation and monitoring
- **Workspaces** (5 tools): Workspace creation, configuration, and management
- **Public Registry** (9 tools): Tools for accessing public Terraform registry (modules, providers, policies)
- **Private Registry** (4 tools): Tools for accessing private Terraform modules and providers
- **Organization** (2 tools): Organization and project listing

## Usage

Import wrapper functions from category modules:

```typescript
import { CreateWorkspace, UpdateWorkspace } from './scripts/workspaces/index.js';

// Use type-safe wrapper functions
const result = await CreateWorkspace({
  workspace_name: 'my-workspace',
  terraform_org_name: 'my-org',
});
```
