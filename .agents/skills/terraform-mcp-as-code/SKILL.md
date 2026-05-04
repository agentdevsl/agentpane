---
name: Terraform Infrastructure as Code
description: Automate Terraform Cloud/Enterprise operations: create workspaces, trigger runs, manage variables, and search registries for infrastructure-as-code projects.
version: 1.0.0
dependencies: docker, node.js
---

# Terraform Infrastructure as Code

Automate HashiCorp Cloud Platform (HCP) Terraform infrastructure management through type-safe TypeScript wrappers for Terraform Cloud and Terraform Enterprise.

## When to Use This Skill

Invoke this skill when you need to:

- **Create, configure, or update** Terraform Cloud/Enterprise workspaces
- **Trigger and monitor** Terraform runs programmatically
- **Manage** workspace variables and variable sets
- **Search** for public Terraform modules, providers, or policies
- **Access** private registry modules and providers
- **List** organizations and projects in your Terraform Cloud/Enterprise account

This skill is ideal for infrastructure-as-code automation and programmatic HCP Terraform management workflows.

## Prerequisites

**Required:**

- Terraform Cloud/Enterprise account
- `TFE_TOKEN` environment variable with a valid Terraform API token
- Docker (for running the MCP server)

**MCP Server Command:**

```bash
docker run -i --rm -e TFE_TOKEN=your_token hashicorp/terraform-mcp-server
```

## Security Best Practices

⚠️ **Important Security Guidelines:**

- **Never hardcode credentials**: Always use environment variables for `TFE_TOKEN`
- **Token security**: Store tokens in secure credential managers or environment configuration
- **Least privilege**: Use workspace-specific or organization-specific tokens when possible
- **Review before execution**: Examine all generated code before running in production environments
- **No secrets in code**: Never commit tokens to version control

**Example of secure token handling:**

```typescript
// ✅ Correct: Use environment variables
const token = process.env.TFE_TOKEN;

// ❌ Wrong: Hardcoded token
const token = 'abc123...'; // NEVER DO THIS
```

## Available Tools

This skill provides 34 type-safe tools organized into 6 categories:

- **Workspaces** (7 tools) - `scripts/workspaces/`
  - Create, configure, update workspaces
  - Manage workspace tags
  - Create No Code module workspaces

- **Runs** (3 tools) - `scripts/runs/`
  - Create and trigger runs
  - Get run details and status
  - List runs with filtering

- **Variables** (9 tools) - `scripts/variables/`
  - Create/update/delete workspace variables
  - Manage variable sets
  - Attach/detach variable sets to workspaces

- **Public Registry** (9 tools) - `scripts/public-registry/`
  - Search modules, providers, and policies
  - Get module/provider details and documentation
  - Get provider capabilities

- **Private Registry** (4 tools) - `scripts/private-registry/`
  - Search private modules and providers
  - Get private module/provider details

- **Organization** (2 tools) - `scripts/organization/`
  - List Terraform organizations
  - List projects in an organization

**For detailed parameters and types**, see the TypeScript files in each category directory. All functions include full type definitions and JSDoc comments for IDE autocomplete.

## Quick Start

```typescript
import { initializeMCPClient, closeMCPClient } from './scripts/client.js';
import { CreateWorkspace } from './scripts/workspaces/index.js';
import { CreateRun } from './scripts/runs/index.js';

// 1. Initialize connection
await initializeMCPClient({
  command: 'docker',
  args: [
    'run',
    '-i',
    '--rm',
    '-e',
    `TFE_TOKEN=${process.env.TFE_TOKEN}`,
    'hashicorp/terraform-mcp-server',
  ],
});

try {
  // 2. Create a workspace
  const workspace = await CreateWorkspace({
    workspace_name: 'my-infrastructure',
    terraform_org_name: 'my-org',
    auto_apply: 'false',
  });

  // 3. Trigger a run
  const run = await CreateRun({
    workspace_name: 'my-infrastructure',
    terraform_org_name: 'my-org',
    message: 'Initial deployment',
  });
} finally {
  // 4. Clean up
  await closeMCPClient();
}
```

## Common Workflows

### Workflow 1: Create Infrastructure Workspace

```typescript
// Use case: Setting up a new production environment for an API service
import { CreateWorkspace } from './scripts/workspaces/index.js';

const workspace = await CreateWorkspace({
  workspace_name: 'production-api',
  terraform_org_name: 'acme-corp',
  description: 'Production API infrastructure',
  auto_apply: 'false', // Require manual approval for production
  execution_mode: 'remote',
  terraform_version: '1.6.0',
  tags: 'production,api,critical',
});
```

### Workflow 2: Find and Use Registry Module

```typescript
// Use case: Discovering the right VPC module for AWS infrastructure
import { SearchModules, GetModuleDetails } from './scripts/public-registry/index.js';

// 1. Search for VPC modules
const modules = await SearchModules({
  module_query: 'vpc aws terraform-aws-modules',
});

// 2. Get detailed documentation for the best match
const moduleDetails = await GetModuleDetails({
  module_id: 'terraform-aws-modules/vpc/aws/5.1.2',
});

console.log(moduleDetails.content[0].text);
```

### Workflow 3: Configure Workspace Variables

```typescript
// Use case: Setting up environment-specific configuration
import {
  CreateVariableSet,
  CreateVariableInVariableSet,
  AttachVariableSetToWorkspaces,
} from './scripts/variables/index.js';

// 1. Create a variable set for AWS credentials
const varSet = await CreateVariableSet({
  terraform_org_name: 'acme-corp',
  name: 'aws-production-credentials',
  description: 'AWS credentials for production workspaces',
  global: false,
});

// 2. Add variables to the set
await CreateVariableInVariableSet({
  variable_set_id: varSet.id,
  key: 'AWS_REGION',
  value: 'us-east-1',
  category: 'env',
  sensitive: false,
});

// 3. Attach to workspaces
await AttachVariableSetToWorkspaces({
  variable_set_id: varSet.id,
  workspace_ids: 'ws-123,ws-456,ws-789',
});
```

### Workflow 4: Trigger and Monitor Runs

```typescript
// Use case: Deploying infrastructure changes with monitoring
import { CreateRun, GetRunDetails } from './scripts/runs/index.js';

// 1. Trigger a run
const run = await CreateRun({
  workspace_name: 'production-api',
  terraform_org_name: 'acme-corp',
  message: 'Deploy v2.1.0 API changes',
  run_type: 'plan-and-apply',
});

// 2. Monitor run status
const runDetails = await GetRunDetails({
  run_id: run.id,
});

console.log(`Run status: ${runDetails.status}`);
console.log(`Plan output: ${runDetails.content[0].text}`);
```

## Using the TypeScript Wrappers

Import from category indexes or individual files:

```typescript
// Import from category index
import { CreateWorkspace, UpdateWorkspace, ListWorkspaces } from './scripts/workspaces/index.js';

// Or import specific tool with types
import {
  CreateWorkspace,
  CreateWorkspaceInput,
  CreateWorkspaceOutput,
} from './scripts/workspaces/createWorkspace.js';
```

All wrapper functions are fully typed with Input/Output interfaces. Use your IDE's autocomplete to discover parameters and see JSDoc documentation.

## Error Handling

```typescript
try {
  const result = await CreateWorkspace({
    workspace_name: 'my-workspace',
    terraform_org_name: 'my-org',
  });

  if (result.isError) {
    console.error('Workspace creation failed:', result.content);
  } else {
    console.log('Workspace created successfully');
  }
} catch (error) {
  console.error('MCP call failed:', error);
}
```

## Testing This Skill

**Before Using:**

1. Verify `TFE_TOKEN` is set: `echo $TFE_TOKEN`
2. Confirm Docker is running: `docker --version`
3. Test MCP server connectivity:
   ```bash
   docker run -i --rm -e TFE_TOKEN=$TFE_TOKEN hashicorp/terraform-mcp-server
   ```

**Troubleshooting:**

- **Connection errors**: Verify Docker is running and token is valid
- **Authentication failures**: Check `TFE_TOKEN` has correct permissions for the operation
- **Type errors**: Ensure you're using the correct Input interface for each function

## Architecture

- **`scripts/client.ts`** - MCP connection manager (`initializeMCPClient`, `callMCPTool`, `closeMCPClient`)
- **`scripts/{category}/`** - Type-safe wrapper functions organized by category
  - Each tool has its own `.ts` file with Input/Output interfaces
  - `index.ts` provides barrel exports for convenient importing
- **Full type safety** - All interfaces generated from JSON Schema definitions

## Limitations

**This skill is NOT suitable for:**

- Direct Terraform CLI operations (use Terraform CLI directly instead)
- Local Terraform state management (this is for Cloud/Enterprise only)
- Terraform configuration generation (use Terraform language skills instead)
- Non-Terraform infrastructure management

---

_This skill was auto-generated by [mcp-to-Codex-skill](https://github.com/hashi-demo-lab/mcp-to-Codex-skill)_
