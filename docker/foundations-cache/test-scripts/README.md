# Demo Repo Scripts

Create and delete demo repositories across GitHub.com and GitHub Enterprise instances. Scripts handle the lifecycle: **setup** your environment, **create** repos from templates, **delete** them when done, **bulk-run** Claude Code across multiple repos, and **clean up** afterwards.

## Prerequisites

- **zsh** (default on macOS)
- [**GitHub CLI (`gh`)**](https://cli.github.com/) — `brew install gh`
- Authentication to each GitHub host (see [Authentication](#authentication))

## Quick Start

```zsh
# 1. Configure your targets and templates (one-time)
./setup-demo-env.zsh

# 2. Restart your shell (or source the env file)
source ~/.demo-repos.env

# 3. Create demo repos (interactive)
./create-demo-repos.zsh

# 4. Delete demo repos when done
./delete-demo-repos.zsh
```

## Setup — `setup-demo-env.zsh`

Interactive wizard that writes `~/.demo-repos.env` with two environment variables consumed by the create and delete scripts:

| Variable | Format | Example |
|---|---|---|
| `DEMO_REPO_TARGETS` | Comma-separated `HOST::ACCOUNT` pairs | `github.com::MyOrg,ghe.company.com::MyTeam` |
| `DEMO_REPO_TEMPLATES` | Comma-separated `ORG/REPO` or `HOST::ORG/REPO` | `MyOrg/app-template,github.ibm.com::Team/iac-template` |

The setup script will:

- Load existing entries from `~/.demo-repos.env` (if present) and deduplicate
- Optionally add a `source` line to `~/.zshrc`

Both `DEMO_REPO_TARGETS` and `DEMO_REPO_TEMPLATES` must be set before running the create or delete scripts.

## Authentication

The scripts delegate authentication entirely to the `gh` CLI, which natively resolves tokens per host:

| Variable | Scope |
|---|---|
| `GH_TOKEN` | All hosts (global override) |
| `GITHUB_TOKEN` | github.com only |
| `GH_ENTERPRISE_TOKEN` | Enterprise hosts only |

If none of these are set, `gh` falls back to its own auth store. You can authenticate interactively:

```zsh
gh auth login                              # github.com
gh auth login --hostname your-ghe.com      # GitHub Enterprise
```

## Create — `create-demo-repos.zsh`

Creates demo repositories by cloning a template (all branches and tags) and pushing to a target account.

```zsh
./create-demo-repos.zsh [OPTIONS]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `-t`, `--template NUM\|ORG/REPO` | Template selection (index or direct reference) | Interactive menu |
| `-c`, `--count NUMBER` | Number of repos to create | `1` |
| `-a`, `--account NAME` | Target GitHub account/org | First `DEMO_REPO_TARGETS` entry |
| `-n`, `--name BASE_NAME` | Base repo name | Auto-derived from template (`*-template` → `*-demo`) |
| `-p`, `--path PATH` | Local clone directory | `~/Documents/repos` |
| `-h`, `--host HOST` | GitHub Enterprise hostname | First `DEMO_REPO_TARGETS` entry |
| `-v`, `--visibility TYPE` | `public` or `private` | `public` |
| `--help` | Show help | |

### Examples

```zsh
# Interactive mode — pick template and destination via arrow keys
./create-demo-repos.zsh

# Use template #1, create 5 repos
./create-demo-repos.zsh -t 1 -c 5

# Different account, private repos
./create-demo-repos.zsh -a MyOrg -v private -t 2 -c 3
```

Repos are numbered sequentially (e.g., `ai-iac-consumer-demo01`, `demo02`, ...). The script auto-detects existing repos and starts numbering from the next available slot.

## Delete — `delete-demo-repos.zsh`

Deletes demo repositories both remotely (via `gh`) and locally (the cloned directory).

```zsh
./delete-demo-repos.zsh [OPTIONS] [REPO_NAME ...]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `-a`, `--account NAME` | GitHub account/org | Interactive menu |
| `-H`, `--host HOST` | GitHub hostname | Interactive menu |
| `-p`, `--path PATH` | Local base path | `~/Documents/repos` |
| `-f`, `--file FILE` | Read repo names from file (one per line) | |
| `-y`, `--yes` | Skip confirmation prompt | `false` |
| `--dry-run` | Show what would be deleted without doing it | `false` |
| `--help` | Show help | |

### Examples

```zsh
# Interactive mode — pick target and repo via arrow keys
./delete-demo-repos.zsh

# Delete specific repos
./delete-demo-repos.zsh -a MyOrg -H github.example.com ai-iac-consumer-demo01 ai-iac-consumer-demo02

# Delete a range (zsh brace expansion)
./delete-demo-repos.zsh ai-iac-consumer-demo{01..10}

# Dry run first, then delete
./delete-demo-repos.zsh --dry-run ai-iac-consumer-demo{01..05}
./delete-demo-repos.zsh -y ai-iac-consumer-demo{01..05}

# Delete from a file
./delete-demo-repos.zsh -f repos-to-delete.txt
```

## Bulk Run — `bulk-run-demo.zsh`

Creates demo repos from a template, clones them to a local directory, and runs Claude Code with a prompt inside each one. Supports sequential and parallel execution.

```zsh
./bulk-run-demo.zsh [OPTIONS]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `-t`, `--template NUM\|ORG/REPO` | Template selection (index or direct reference) | Interactive menu |
| `-c`, `--count N` | Number of repos to create | `3` |
| `-x`, `--execute PROMPT` | Claude prompt (inline string) | |
| `--prompt-file FILE` | Read prompt from file (takes precedence over `-x`) | |
| `--prompt-dir DIR` | Dir of prompt files (one repo per file, overrides `--count`) | |
| `--prompt-glob PATTERN` | Glob filter for `--prompt-dir` | `*.md` |
| `-p`, `--path PATH` | Clone directory | `/workspace/demo-runs` |
| `--parallel N` | Max concurrent sessions (`0` = sequential) | `3` |
| `-a`, `--account NAME` | Target GitHub account/org | First `DEMO_REPO_TARGETS` entry |
| `-h`, `--host HOST` | GitHub Enterprise hostname | First `DEMO_REPO_TARGETS` entry |
| `-n`, `--name BASE_NAME` | Base repo name | Auto-derived from template |
| `-v`, `--visibility TYPE` | `public` or `private` | `public` |
| `--dry-run` | Show plan without executing | |
| `--cleanup` | Delete repos after execution | |
| `--help` | Show help | |

### Examples

```zsh
# Dry run — see what would happen
./bulk-run-demo.zsh -t 1 -c 3 -x '/help' --dry-run

# Sequential execution
./bulk-run-demo.zsh -t 1 -c 2 -x 'echo hello' --parallel 0

# Parallel execution (2 at a time) with prompt file
./bulk-run-demo.zsh -t 1 -c 3 --prompt-file prompt.txt --parallel 2

# One repo per prompt file (count auto-derived from file count)
./bulk-run-demo.zsh -t 1 --prompt-dir ./prompts --parallel 3

# Run and clean up after
./bulk-run-demo.zsh -t 2 -c 5 -x '/help' --cleanup
```

Each repo gets a `.claude-run.log` file with the Claude session output. A summary table is displayed at the end showing pass/fail status, duration, and log file paths.

## Bulk Run Cleanup — `cleanup-bulk-run.zsh`

Scans a directory for demo repos (by inspecting git remotes) and deletes them. Companion to `bulk-run-demo.zsh`.

```zsh
./cleanup-bulk-run.zsh [OPTIONS]
```

### Options

| Flag | Description | Default |
|---|---|---|
| `-p`, `--path PATH` | Base directory to scan | `/workspace/demo-runs` |
| `-a`, `--account NAME` | GitHub account filter | |
| `-H`, `--host HOST` | GitHub hostname filter | |
| `-y`, `--yes` | Skip confirmation | `false` |
| `--dry-run` | Show what would be deleted | `false` |
| `--local-only` | Only delete local clones (skip remote deletion) | `false` |
| `--help` | Show help | |

### Examples

```zsh
# See what would be deleted
./cleanup-bulk-run.zsh --dry-run

# Delete everything without confirmation
./cleanup-bulk-run.zsh -y

# Only delete local clones
./cleanup-bulk-run.zsh --local-only -y

# Filter by account and host
./cleanup-bulk-run.zsh -a MyOrg -H github.example.com
```

The cleanup script automatically identifies repos by scanning subdirectories and reading their git remote URLs (supports both `https://` and `git@` formats).

## Included Prompt Files

The `prompts/` directory contains ready-made prompt files for use with `--prompt-dir`. Each file defines a non-interactive infrastructure scenario for Claude Code.

| File | Scenario |
|---|---|
| `consumer_ec2.md` | EC2 instances with ALB and Nginx |
| `consumer_asg.md` | Auto-Scaling Group with ALB |
| `consumer_cloudfront.md` | CloudFront with static content (S3 + ACM) |
| `consumer_elastic.md` | ElastiCache Redis with ECS application tier |
| `consumer_serverless.md` | Lambda + API Gateway + DynamoDB |
| `consumer_sqs.md` | SQS with Lambda and SNS |

```zsh
# Run all consumer prompts in parallel (one repo per prompt file)
./bulk-run-demo.zsh -t 1 --prompt-dir ./prompts --parallel 3

# Run a subset using glob filter
./bulk-run-demo.zsh -t 1 --prompt-dir ./prompts --prompt-glob "consumer_ec2.md"
```

## Environment Variables

| Variable | Used by | Description | Default |
|---|---|---|---|
| `DEMO_REPO_TARGETS` | create, delete, bulk-run, cleanup | `HOST::ACCOUNT` pairs (comma-separated) | *Required* — set via `setup-demo-env.zsh` |
| `DEMO_REPO_TEMPLATES` | create, bulk-run | Template repos (comma-separated) | *Required* — set via `setup-demo-env.zsh` |
| `GH_TOKEN` | gh CLI | Auth token for all hosts (global override) | |
| `GITHUB_TOKEN` | gh CLI | Auth token for github.com | |
| `GH_ENTERPRISE_TOKEN` | gh CLI | Auth token for enterprise hosts | |
| `GITHUB_HOST` | create, bulk-run | Default GitHub Enterprise hostname | First `DEMO_REPO_TARGETS` entry |
| `GITHUB_ACCOUNT` | create, bulk-run | Default target account | First `DEMO_REPO_TARGETS` entry |
| `CLONE_BASE_PATH` | create, delete, bulk-run | Local directory for cloned repos | `~/Documents/repos` (create/delete), `/workspace/demo-runs` (bulk-run) |
| `SCAN_PATH` | cleanup | Base directory to scan for repos | `/workspace/demo-runs` |
| `REPO_COUNT` | create, bulk-run | Number of repos to create | `1` (create), `3` (bulk-run) |
| `REPO_VISIBILITY` | create, bulk-run | Repo visibility (`public`/`private`) | `public` |
| `PARALLEL_MAX` | bulk-run | Max concurrent Claude sessions (`0` = sequential) | `3` |
