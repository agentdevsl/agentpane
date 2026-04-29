/**
 * Mock builders for git operations used in WorktreeService testing
 *
 * This module provides type-safe mock builders for the CommandRunner interface
 * used by WorktreeService to execute git commands. These mocks eliminate the need
 * for real git operations during testing while maintaining realistic behavior.
 *
 * @module tests/mocks/mock-git
 */

import { vi } from 'vitest';
import type { CommandResult, CommandRunner } from '../../src/services/worktree.service.js';

// =============================================================================
// Types
// =============================================================================

/**
 * Configuration for command responses - maps command patterns to responses
 */
export type CommandResponseMap = Record<
  string,
  CommandResult | ((cmd: string, cwd: string) => CommandResult | Promise<CommandResult>)
>;

/**
 * Worktree entry descriptor for porcelain format output
 */
export interface WorktreeEntry {
  path: string;
  branch: string;
  head: string;
  detached?: boolean;
  bare?: boolean;
  prunable?: string;
}

/**
 * File change descriptor for diff output
 */
export interface DiffFileChange {
  path: string;
  additions: number;
  deletions: number;
  status?: 'added' | 'modified' | 'deleted' | 'renamed';
}

// =============================================================================
// Base Command Runner Mocks
// =============================================================================

/**
 * Creates a basic mock CommandRunner with configurable responses.
 *
 * Command patterns support partial matching:
 * - 'git status' matches any command containing 'git status'
 * - Use more specific patterns for precise matching
 *
 * Responses can be static CommandResult objects or functions that return
 * CommandResult objects (useful for dynamic behavior based on command/cwd).
 *
 * Falls back to empty output if no pattern matches.
 *
 * @param responses - Map of command patterns to responses
 * @returns Mocked CommandRunner
 *
 * @example
 * ```typescript
 * const runner = createMockCommandRunner({
 *   'git status': { stdout: 'On branch main', stderr: '' },
 *   'git diff': (cmd, cwd) => ({ stdout: `Diff in ${cwd}`, stderr: '' }),
 * });
 *
 * const result = await runner.exec('git status', '/project');
 * // Returns: { stdout: 'On branch main', stderr: '' }
 * ```
 */
export function createMockCommandRunner(responses: CommandResponseMap = {}): CommandRunner {
  const exec = vi
    .fn()
    .mockImplementation(async (command: string, cwd: string): Promise<CommandResult> => {
      // Find matching pattern
      for (const [pattern, response] of Object.entries(responses)) {
        if (command.includes(pattern)) {
          if (typeof response === 'function') {
            const result = response(command, cwd);
            return result instanceof Promise ? await result : result;
          }
          return response;
        }
      }

      // Default fallback
      return { stdout: '', stderr: '' };
    });

  // F06-NEW-01: WorktreeService now uses positional `execArgs` for every
  // git/cp invocation. Map the argv form back to the `command` pattern
  // matcher by joining argv with spaces — this lets existing tests using
  // patterns like 'branch --list' or 'worktree add' continue to match.
  const execArgs = vi
    .fn()
    .mockImplementation(async (argv: string[], cwd: string): Promise<CommandResult> => {
      const command = argv.join(' ');
      for (const [pattern, response] of Object.entries(responses)) {
        if (command.includes(pattern)) {
          if (typeof response === 'function') {
            const result = response(command, cwd);
            return result instanceof Promise ? await result : result;
          }
          return response;
        }
      }
      return { stdout: '', stderr: '' };
    });

  return { exec, execArgs };
}

// =============================================================================
// Git-Specific Command Runners
// =============================================================================

/**
 * Creates a CommandRunner pre-configured for common git worktree operations.
 *
 * Provides sensible defaults for:
 * - Project root detection (rev-parse --show-toplevel)
 * - Branch existence checks (branch --list)
 * - Worktree operations (add, remove, list)
 * - Current branch detection (rev-parse --abbrev-ref HEAD)
 * - Diff operations (diff --stat, diff)
 * - Commit operations (add, commit, status)
 * - Merge operations (checkout, pull, merge)
 * - Branch deletion (branch -D)
 *
 * @param projectPath - Project root path (default: '/project')
 * @returns Mocked CommandRunner with git defaults
 *
 * @example
 * ```typescript
 * const runner = createMockGitRunner('/home/user/my-project');
 * const result = await runner.exec('git rev-parse --show-toplevel', '/some/path');
 * // Returns: { stdout: '/home/user/my-project', stderr: '' }
 * ```
 */
export function createMockGitRunner(projectPath = '/project'): CommandRunner {
  return createMockCommandRunner({
    'rev-parse --show-toplevel': { stdout: projectPath, stderr: '' },
    'branch --list': { stdout: '', stderr: '' }, // No branch exists by default
    'worktree add': { stdout: `Preparing worktree\nBranch created`, stderr: '' },
    'worktree remove': { stdout: '', stderr: '' },
    'worktree list --porcelain': { stdout: '', stderr: '' }, // No worktrees by default
    'worktree prune': { stdout: '', stderr: '' },
    'rev-parse --abbrev-ref HEAD': { stdout: 'main', stderr: '' },
    'diff --stat': { stdout: '1 file changed, 10 insertions(+)', stderr: '' },
    'diff --numstat': { stdout: '10\t0\tREADME.md', stderr: '' },
    'diff ': {
      stdout: createMockGitDiffOutput([{ path: 'README.md', additions: 10, deletions: 0 }]),
      stderr: '',
    },
    'add -A': { stdout: '', stderr: '' },
    'status --porcelain': { stdout: 'M  README.md', stderr: '' },
    'commit -m': { stdout: '[main abc123] Commit message', stderr: '' },
    'rev-parse HEAD': { stdout: 'abc123def456', stderr: '' },
    checkout: { stdout: "Switched to branch 'main'", stderr: '' },
    'pull --rebase': { stdout: 'Already up to date.', stderr: '' },
    merge: { stdout: 'Merge made by the recursive strategy.', stderr: '' },
    'branch -D': { stdout: 'Deleted branch', stderr: '' },
    'cp ': { stdout: '', stderr: '' },
    'bun install': { stdout: 'Dependencies installed', stderr: '' },
  });
}

/**
 * Creates a CommandRunner where a specific branch already exists.
 *
 * Useful for testing branch conflict scenarios.
 *
 * @param branch - Name of the existing branch
 * @param projectPath - Project root path (default: '/project')
 * @returns Mocked CommandRunner with existing branch
 *
 * @example
 * ```typescript
 * const runner = createMockGitRunnerWithBranch('feature-abc123');
 * const result = await runner.exec('git branch --list "feature-abc123"', '/project');
 * // Returns: { stdout: '  feature-abc123', stderr: '' }
 * ```
 */
export function createMockGitRunnerWithBranch(
  branch: string,
  projectPath = '/project'
): CommandRunner {
  const base = createMockGitRunner(projectPath);

  // Override branch --list to return the branch
  return createMockCommandRunner({
    ...extractResponseMap(base),
    'branch --list': { stdout: `  ${branch}`, stderr: '' },
  });
}

/**
 * Creates a CommandRunner that returns porcelain-formatted worktree list output.
 *
 * Useful for testing worktree listing and synchronization.
 *
 * @param worktrees - Array of worktree descriptors
 * @param projectPath - Project root path (default: '/project')
 * @returns Mocked CommandRunner with worktree list
 *
 * @example
 * ```typescript
 * const runner = createMockGitRunnerWithWorktrees([
 *   { path: '/project', branch: 'main', head: 'abc123' },
 *   { path: '/project/.worktrees/feature', branch: 'feature', head: 'def456' },
 * ]);
 *
 * const result = await runner.exec('git worktree list --porcelain', '/project');
 * // Returns formatted worktree list
 * ```
 */
export function createMockGitRunnerWithWorktrees(
  worktrees: WorktreeEntry[],
  projectPath = '/project'
): CommandRunner {
  const base = createMockGitRunner(projectPath);
  const porcelainOutput = createMockWorktreeListOutput(worktrees);

  return createMockCommandRunner({
    ...extractResponseMap(base),
    'worktree list --porcelain': { stdout: porcelainOutput, stderr: '' },
  });
}

/**
 * Creates a CommandRunner that simulates a merge conflict.
 *
 * When 'merge' command is executed, throws an error with "CONFLICT" in stderr.
 * Useful for testing conflict detection and handling.
 *
 * @param projectPath - Project root path (default: '/project')
 * @returns Mocked CommandRunner that fails on merge
 *
 * @example
 * ```typescript
 * const runner = createMockGitRunnerWithConflict();
 *
 * try {
 *   await runner.exec('git merge feature', '/project');
 * } catch (error) {
 *   // Error thrown with conflict details
 * }
 * ```
 */
export function createMockGitRunnerWithConflict(projectPath = '/project'): CommandRunner {
  const base = createMockGitRunner(projectPath);

  return createMockCommandRunner({
    ...extractResponseMap(base),
    merge: (_cmd: string, _cwd: string) => {
      throw new Error(
        'CONFLICT (content): Merge conflict in README.md\nAutomatic merge failed; fix conflicts and then commit the result.'
      );
    },
    'diff --name-only --diff-filter=U': { stdout: 'README.md\nsrc/index.ts', stderr: '' },
  });
}

// =============================================================================
// Git Output Generators
// =============================================================================

/**
 * Generates realistic `git diff --stat` output.
 *
 * @param files - Array of file changes with additions/deletions
 * @returns Formatted diff stat string
 *
 * @example
 * ```typescript
 * const stats = createMockGitDiff([
 *   { path: 'README.md', additions: 10, deletions: 2 },
 *   { path: 'src/index.ts', additions: 5, deletions: 3 },
 * ]);
 * // Returns:
 * //  README.md    | 12 ++++++++++--
 * //  src/index.ts |  8 +++++---
 * //  2 files changed, 15 insertions(+), 5 deletions(-)
 * ```
 */
export function createMockGitDiff(files: DiffFileChange[]): string {
  const lines: string[] = [];

  let totalInsertions = 0;
  let totalDeletions = 0;

  for (const file of files) {
    const total = file.additions + file.deletions;
    const plusSigns = '+'.repeat(Math.min(file.additions, 20));
    const minusSigns = '-'.repeat(Math.min(file.deletions, 20));
    const changes = `${plusSigns}${minusSigns}`;

    lines.push(` ${file.path.padEnd(30)} | ${String(total).padStart(4)} ${changes}`);
    totalInsertions += file.additions;
    totalDeletions += file.deletions;
  }

  const fileWord = files.length === 1 ? 'file' : 'files';
  const summary = ` ${files.length} ${fileWord} changed, ${totalInsertions} insertions(+), ${totalDeletions} deletions(-)`;

  return [...lines, summary].join('\n');
}

/**
 * Generates realistic unified diff output for `git diff`.
 *
 * Creates a minimal but valid diff with hunks for each file.
 *
 * @param files - Array of file changes
 * @returns Formatted unified diff string
 *
 * @example
 * ```typescript
 * const diff = createMockGitDiffOutput([
 *   { path: 'README.md', additions: 2, deletions: 1 },
 * ]);
 * // Returns:
 * // diff --git a/README.md b/README.md
 * // index abc123..def456 100644
 * // --- a/README.md
 * // +++ b/README.md
 * // @@ -1,3 +1,4 @@
 * //  line 1
 * // -old line
 * // +new line
 * // +added line
 * ```
 */
export function createMockGitDiffOutput(files: DiffFileChange[]): string {
  const diffs: string[] = [];

  for (const file of files) {
    const lines: string[] = [];

    lines.push(`diff --git a/${file.path} b/${file.path}`);

    if (file.status === 'added') {
      lines.push('new file mode 100644');
      lines.push('index 0000000..abc123');
    } else if (file.status === 'deleted') {
      lines.push('deleted file mode 100644');
      lines.push('index abc123..0000000');
    } else {
      lines.push('index abc123..def456 100644');
    }

    lines.push(`--- ${file.status === 'added' ? '/dev/null' : `a/${file.path}`}`);
    lines.push(`+++ ${file.status === 'deleted' ? '/dev/null' : `b/${file.path}`}`);

    // Create a simple hunk
    const oldLines = file.status === 'added' ? 0 : Math.max(1, file.deletions);
    const newLines = file.status === 'deleted' ? 0 : Math.max(1, file.additions);

    lines.push(
      `@@ -${file.status === 'added' ? '0,0' : `1,${oldLines}`} +${file.status === 'deleted' ? '0,0' : `1,${newLines}`} @@`
    );

    // Add sample content
    if (file.status !== 'added') {
      for (let i = 0; i < file.deletions; i++) {
        lines.push(`-deleted line ${i + 1}`);
      }
    }

    if (file.status !== 'deleted') {
      for (let i = 0; i < file.additions; i++) {
        lines.push(`+added line ${i + 1}`);
      }
    }

    diffs.push(lines.join('\n'));
  }

  return diffs.join('\n\n');
}

/**
 * Generates porcelain-format output for `git worktree list --porcelain`.
 *
 * The porcelain format consists of blocks separated by blank lines:
 * - worktree <path>
 * - HEAD <sha>
 * - branch refs/heads/<name> (if not detached)
 * - detached (if HEAD is detached)
 * - bare (if bare repository)
 * - prunable <reason> (if prunable)
 *
 * @param entries - Array of worktree descriptors
 * @returns Formatted porcelain output
 *
 * @example
 * ```typescript
 * const output = createMockWorktreeListOutput([
 *   { path: '/project', branch: 'main', head: 'abc123' },
 *   { path: '/project/.worktrees/feature', branch: 'feature', head: 'def456' },
 * ]);
 * // Returns:
 * // worktree /project
 * // HEAD abc123
 * // branch refs/heads/main
 * //
 * // worktree /project/.worktrees/feature
 * // HEAD def456
 * // branch refs/heads/feature
 * ```
 */
export function createMockWorktreeListOutput(entries: WorktreeEntry[]): string {
  const blocks: string[] = [];

  for (const entry of entries) {
    const lines: string[] = [];

    lines.push(`worktree ${entry.path}`);
    lines.push(`HEAD ${entry.head}`);

    if (entry.detached) {
      lines.push('detached');
    } else if (entry.branch) {
      lines.push(`branch refs/heads/${entry.branch}`);
    }

    if (entry.bare) {
      lines.push('bare');
    }

    if (entry.prunable) {
      lines.push(`prunable ${entry.prunable}`);
    }

    blocks.push(lines.join('\n'));
  }

  return blocks.join('\n\n');
}

// =============================================================================
// Utility Functions
// =============================================================================

/**
 * Extracts the response map from a CommandRunner for override purposes.
 * This is a helper to allow extending base runners.
 *
 * @internal
 */
function extractResponseMap(_runner: CommandRunner): CommandResponseMap {
  // Since we control the creation, we can safely return an empty map
  // The actual implementation uses the runner's exec mock
  return {};
}
