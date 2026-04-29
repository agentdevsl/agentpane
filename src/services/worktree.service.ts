import { access } from 'node:fs/promises';
import path from 'node:path';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Worktree, WorktreeStatus } from '../db/schema';
import { agents, codespaces, worktrees } from '../db/schema';
import { ServiceErrors } from '../lib/errors/service-errors.js';
import type { WorktreeError } from '../lib/errors/worktree-errors.js';
import { WorktreeErrors } from '../lib/errors/worktree-errors.js';
import { softInvariant } from '../lib/utils/invariant.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import { slugify } from '../lib/utils/slugify.js';
import type { Database } from '../types/database.js';

export type WorktreeCreateInput = {
  codespaceId: string;
  agentId: string;
  taskId: string;
  taskTitle: string;
  baseBranch?: string;
};

export type WorktreeSetupOptions = {
  skipEnvCopy?: boolean;
  skipDepsInstall?: boolean;
  skipInitScript?: boolean;
};

export type DiffHunk = {
  oldStart: number;
  oldLines: number;
  newStart: number;
  newLines: number;
  content: string;
};

export type DiffFile = {
  path: string;
  status: 'added' | 'modified' | 'deleted' | 'renamed';
  additions: number;
  deletions: number;
  hunks: DiffHunk[];
};

export type GitDiff = {
  files: DiffFile[];
  stats: {
    filesChanged: number;
    additions: number;
    deletions: number;
  };
};

export type WorktreeStatusInfo = {
  id: string;
  branch: string;
  status: WorktreeStatus;
  path: string;
  updatedAt: string | null;
};

export type PruneResult = {
  pruned: number;
  failed: Array<{ worktreeId: string; branch: string; error: string }>;
};

export type WorktreeServiceResult<T> = Promise<Result<T, WorktreeError>>;

/**
 * Asserts that a CommandRunner exposes the safe positional-argv `execArgs`
 * primitive (F06-NEW-01). All production runners — `createBunCommandRunner`
 * and `createSandboxCommandRunner` — supply it. The only places that hit
 * this assertion are tests using a minimal `{ exec: vi.fn() }` mock; those
 * tests must add an `execArgs` mock to keep the safe path covered.
 */
const requireExecArgs = (runner: CommandRunner): NonNullable<CommandRunner['execArgs']> => {
  if (!runner.execArgs) {
    throw new Error(
      'CommandRunner.execArgs is required (F06-NEW-01); update the test stub or runner factory'
    );
  }
  return runner.execArgs;
};

const extractHunks = (diff: string, filePath: string): DiffHunk[] => {
  const hunks = diff.split(`diff --git a/${filePath} b/${filePath}`);
  const hunkContent = hunks[1];
  if (!hunkContent) {
    return [];
  }

  const lines = hunkContent.split('\n');
  const hunkHeaders = lines.filter((line) => line.startsWith('@@'));

  return hunkHeaders.map((header) => {
    // Parse hunk header like "@@ -1,3 +1,5 @@"
    const match = header.match(/@@ -(\d+),?(\d*) \+(\d+),?(\d*) @@/);
    if (!match) {
      return {
        oldStart: 0,
        oldLines: 0,
        newStart: 0,
        newLines: 0,
        content: header,
      };
    }
    return {
      oldStart: Number.parseInt(match[1] ?? '0', 10),
      oldLines: Number.parseInt(match[2] || '1', 10),
      newStart: Number.parseInt(match[3] ?? '0', 10),
      newLines: Number.parseInt(match[4] || '1', 10),
      content: header,
    };
  });
};

export type CommandResult = {
  stdout: string;
  stderr: string;
};

/**
 * Runs commands either as shell-parsed strings (`exec`) or as a literal
 * argv array with no shell involvement (`execArgs`). New callers should
 * prefer {@link CommandRunner.execArgs} to avoid shell-interpolation risk
 * entirely — `exec` remains for legacy callers that compose git commands
 * as strings (F06-02).
 */
export type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<CommandResult>;
  /**
   * Spawn `argv[0]` with the remaining argv as literal arguments. No shell
   * is invoked; metacharacters in argv entries are passed through to the
   * child process as-is and cannot be interpreted.
   *
   * Optional because some tests construct a minimal CommandRunner stub.
   * In production, both `createBunCommandRunner` and
   * `createSandboxCommandRunner` always provide it — callers should
   * guard with `if (runner.execArgs)` and fall back to the legacy
   * `exec` path with locally-escaped values.
   */
  execArgs?: (argv: string[], cwd: string) => Promise<CommandResult>;
};

/**
 * Validates that a shell command string does not contain injection metacharacters.
 * Throws if dangerous characters are detected.
 *
 * Exported so callers that must compose a shell string can opt in to the
 * same guard the sandbox runner applies (F06-02). Hardened in F06-NEW-06 to
 * reject:
 *   - U+0000 (NULL byte) — terminates the C-string in some shell parsers.
 *   - U+2028 / U+2029 (Unicode line separators) — bash 5+ treats these as
 *     ordinary, but `dash` (Alpine default in many sandboxes) and other
 *     shells passed through `sh -c` may not, and a future container
 *     migration could re-open the gap.
 *   - `\t` / `\v` — token separators in some shells, can split when
 *     combined with backslash quoting.
 *   - Standalone `&` (background) plus the existing `&&`.
 *   - `>` / `<` redirection, `${`/`$(` expansion, backslash-newline.
 */
export function validateShellCommand(command: string): void {
  // F06-NEW-06: reject NULL byte (U+0000) and Unicode line separators
  // (U+2028, U+2029) unconditionally. \u escapes used so the source file
  // stays grep-able and editor-safe.
  if (/[\u0000\u2028\u2029]/.test(command)) {
    throw ServiceErrors.SHELL_INJECTION_DETECTED(command);
  }
  const DANGEROUS_PATTERN = /[;|&`<>]|\$\(|\$\{|&&|\|\||[\n\r\t\v]|\\\n/;
  if (DANGEROUS_PATTERN.test(command)) {
    throw ServiceErrors.SHELL_INJECTION_DETECTED(command);
  }
}

/**
 * Creates a CommandRunner that executes commands inside a sandbox container.
 * This allows WorktreeService to run git commands inside Docker containers
 * for isolated agent execution.
 */
export function createSandboxCommandRunner(sandbox: {
  exec: (
    cmd: string,
    args?: string[]
  ) => Promise<{ exitCode: number; stdout: string; stderr: string }>;
}): CommandRunner {
  return {
    exec: async (command: string, cwd: string): Promise<CommandResult> => {
      validateShellCommand(command);

      const escapedCwd = cwd.replace(/'/g, "'\\''");
      const result = await sandbox.exec('sh', ['-c', `cd '${escapedCwd}' && ${command}`]);
      if (result.exitCode !== 0) {
        throw ServiceErrors.COMMAND_FAILED(result.exitCode, result.stderr || result.stdout);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
    execArgs: async (argv: string[], cwd: string): Promise<CommandResult> => {
      // Positional-argv form (F06-02). We still tunnel through `sh -c` to
      // honor the cwd, but the user-supplied values are passed as
      // positional arguments ($1, $2, ...) so no interpolation occurs.
      if (argv.length === 0) {
        throw ServiceErrors.COMMAND_FAILED(1, 'argv must contain at least one element');
      }
      const escapedCwd = cwd.replace(/'/g, "'\\''");
      // Build `cd 'cwd' && exec "$@"` template and pass argv as positional.
      const result = await sandbox.exec('sh', [
        '-c',
        `cd '${escapedCwd}' && exec "$@"`,
        '--',
        ...argv,
      ]);
      if (result.exitCode !== 0) {
        throw ServiceErrors.COMMAND_FAILED(result.exitCode, result.stderr || result.stdout);
      }
      return { stdout: result.stdout, stderr: result.stderr };
    },
  };
}

export class WorktreeService {
  /** Track stale worktree IDs currently being cleaned up to prevent re-deletion attempts */
  private cleaningUpStaleIds = new Set<string>();

  constructor(
    private db: Database,
    private runner: CommandRunner
  ) {}

  async create(
    input: WorktreeCreateInput,
    options?: WorktreeSetupOptions
  ): WorktreeServiceResult<Worktree> {
    const { codespaceId, agentId, taskId, taskTitle, baseBranch = 'main' } = input;

    const codespace = await this.db.query.codespaces.findFirst({
      where: eq(codespaces.id, codespaceId),
    });

    if (!codespace) {
      return err(WorktreeErrors.CREATION_FAILED('unknown', 'Codespace not found'));
    }

    const agent = await this.db.query.agents.findFirst({
      where: eq(agents.id, agentId),
    });

    if (!agent) {
      return err(WorktreeErrors.CREATION_FAILED('unknown', 'Agent not found'));
    }

    // Create short, meaningful identifier from task title + short ID for uniqueness
    const taskSlug = slugify(taskTitle);
    const shortId = taskId.slice(0, 6);

    // Branch: {taskSlug}-{shortId}
    // Example: fix-login-validation-abc123
    const branch = `${taskSlug}-${shortId}`;

    // Path: .worktrees/{taskSlug}-{shortId}
    // Example: .worktrees/fix-login-validation-abc123
    const root = codespace.config?.worktreeRoot ?? '.worktrees';
    const worktreePath = path.join(codespace.path, root, branch);

    // F06-NEW-01: positional argv keeps user-influenced values out of the
    // shell. `git branch --list` accepts pattern as a literal arg, so a
    // hostile branch name like `'; rm -rf /;'` cannot escape into sh.
    const execArgs = requireExecArgs(this.runner);
    const branchCheck = await execArgs(['git', 'branch', '--list', branch], codespace.path);
    if (branchCheck.stdout.trim()) {
      return err(WorktreeErrors.BRANCH_EXISTS(branch));
    }

    try {
      // F06-NEW-01: argv form. `git worktree add <path> -b <branch> <base>`
      // is the documented signature; values pass literally via spawn.
      await execArgs(
        ['git', 'worktree', 'add', worktreePath, '-b', branch, baseBranch],
        codespace.path
      );
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(branch, String(error), error));
    }

    const [insertedWorktree] = await this.db
      .insert(worktrees)
      .values({
        codespaceId,
        agentId,
        taskId,
        branch,
        path: worktreePath,
        baseBranch,
        status: 'creating',
      })
      .returning();

    if (!insertedWorktree) {
      return err(WorktreeErrors.CREATION_FAILED(branch, 'Failed to insert worktree record'));
    }

    const worktreeId = insertedWorktree.id;

    // Run setup operations and check results - failures should prevent activation
    if (!options?.skipEnvCopy) {
      const envResult = await this.copyEnv(worktreeId);
      if (!envResult.ok) {
        const [updated] = await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId))
          .returning({ id: worktrees.id });
        softInvariant(!!updated, 'Failed to set worktree error status after env copy failure', {
          worktreeId,
        });
        return envResult;
      }
    }

    if (!options?.skipDepsInstall) {
      const depsResult = await this.installDeps(worktreeId);
      if (!depsResult.ok) {
        const [updated] = await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId))
          .returning({ id: worktrees.id });
        softInvariant(!!updated, 'Failed to set worktree error status after deps install failure', {
          worktreeId,
        });
        return depsResult;
      }
    }

    if (!options?.skipInitScript && codespace.config?.initScript) {
      const initResult = await this.runInitScript(worktreeId);
      if (!initResult.ok) {
        const [updated] = await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId))
          .returning({ id: worktrees.id });
        softInvariant(!!updated, 'Failed to set worktree error status after init script failure', {
          worktreeId,
        });
        return initResult;
      }
    }

    const [updatedWorktree] = await this.db
      .update(worktrees)
      .set({ status: 'active', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId))
      .returning();

    if (!updatedWorktree) {
      return err(WorktreeErrors.CREATION_FAILED(branch, 'Failed to activate worktree'));
    }

    return ok(updatedWorktree);
  }

  async remove(worktreeId: string, force = false): WorktreeServiceResult<void> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { codespace: true },
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    const [removing] = await this.db
      .update(worktrees)
      .set({ status: 'removing', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId))
      .returning({ id: worktrees.id });
    softInvariant(!!removing, 'Failed to set worktree status to removing', { worktreeId });

    try {
      // F06-NEW-01: argv form. `--force` is a flag; we add it conditionally
      // as a separate argv element rather than interpolating into a string.
      const execArgs = requireExecArgs(this.runner);
      const removeArgs = ['git', 'worktree', 'remove', worktree.path];
      if (force) {
        removeArgs.push('--force');
      }
      await execArgs(removeArgs, worktree.codespace.path);
      await execArgs(['git', 'branch', '-D', worktree.branch], worktree.codespace.path);

      const [removed] = await this.db
        .update(worktrees)
        .set({
          status: 'removed',
          removedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(worktrees.id, worktreeId))
        .returning({ id: worktrees.id });
      softInvariant(!!removed, 'Failed to set worktree status to removed', { worktreeId });

      return ok(undefined);
    } catch (error) {
      const [errorUpdated] = await this.db
        .update(worktrees)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId))
        .returning({ id: worktrees.id });
      softInvariant(!!errorUpdated, 'Failed to set worktree error status after removal failure', {
        worktreeId,
      });

      return err(WorktreeErrors.REMOVAL_FAILED(worktree.path, String(error), error));
    }
  }

  async prune(codespaceId: string): WorktreeServiceResult<PruneResult> {
    // Use ISO string for comparison since SQLite stores dates as TEXT
    const staleThreshold = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
    const stale = await this.db.query.worktrees.findMany({
      where: and(
        eq(worktrees.codespaceId, codespaceId),
        eq(worktrees.status, 'active'),
        lt(worktrees.updatedAt, staleThreshold)
      ),
    });

    let pruned = 0;
    const failed: PruneResult['failed'] = [];

    for (const worktree of stale) {
      const result = await this.remove(worktree.id, true);
      if (result.ok) {
        pruned += 1;
      } else {
        failed.push({
          worktreeId: worktree.id,
          branch: worktree.branch,
          error: String(result.error),
        });
      }
    }

    return ok({ pruned, failed });
  }

  async copyEnv(worktreeId: string): WorktreeServiceResult<void> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { codespace: true },
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    const envFile = worktree.codespace.config?.envFile ?? '.env';
    const sourcePath = path.join(worktree.codespace.path, envFile);
    const targetPath = path.join(worktree.path, envFile);

    try {
      // F06-NEW-01: argv form with `--` so a path beginning with `-`
      // cannot be interpreted as a flag by `cp`.
      const execArgs = requireExecArgs(this.runner);
      await execArgs(['cp', '--', sourcePath, targetPath], worktree.codespace.path);
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.ENV_COPY_FAILED(String(error), error));
    }
  }

  async installDeps(worktreeId: string): WorktreeServiceResult<void> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    try {
      // F06-NEW-01: literal argv with no user input. `bun install` reads
      // package.json from cwd; nothing is interpolated.
      const execArgs = requireExecArgs(this.runner);
      await execArgs(['bun', 'install'], worktree.path);
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.INIT_SCRIPT_FAILED('bun install', String(error), error));
    }
  }

  async runInitScript(worktreeId: string): WorktreeServiceResult<void> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { codespace: true },
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    const initScript = worktree.codespace.config?.initScript;
    if (!initScript) {
      return ok(undefined);
    }

    // Sanitize the init script - remove null bytes and control characters
    // Note: initScript is intentionally a user-configured shell command.
    // Security relies on access control for codespace config modifications.
    const sanitizedScript = initScript
      .replace(/\0/g, '') // Remove null bytes
      .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F]/g, '') // Remove control characters except \t, \n, \r
      .trim();

    if (!sanitizedScript) {
      return ok(undefined);
    }

    try {
      await this.runner.exec(sanitizedScript, worktree.path);
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.INIT_SCRIPT_FAILED(sanitizedScript, String(error), error));
    }
  }

  async commit(worktreeId: string, message: string): WorktreeServiceResult<string> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    try {
      // F06-NEW-01: positional argv. The commit message originates from
      // agent-completion text (LLM-controlled), so it MUST NOT touch the
      // shell. `git commit -m <msg>` accepts the message as a literal arg.
      const execArgs = requireExecArgs(this.runner);
      await execArgs(['git', 'add', '-A'], worktree.path);
      const status = await execArgs(['git', 'status', '--porcelain'], worktree.path);
      if (!status.stdout.trim()) {
        return ok('');
      }

      await execArgs(['git', 'commit', '-m', message], worktree.path);
      const sha = await execArgs(['git', 'rev-parse', 'HEAD'], worktree.path);

      const [committed] = await this.db
        .update(worktrees)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId))
        .returning({ id: worktrees.id });
      softInvariant(!!committed, 'Failed to update worktree timestamp after commit', {
        worktreeId,
      });

      return ok(sha.stdout.trim());
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error), error));
    }
  }

  async merge(worktreeId: string, targetBranch?: string): WorktreeServiceResult<void> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
      with: { codespace: true },
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    const target = targetBranch ?? worktree.baseBranch;

    const [merging] = await this.db
      .update(worktrees)
      .set({ status: 'merging', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId))
      .returning({ id: worktrees.id });
    softInvariant(!!merging, 'Failed to set worktree status to merging', { worktreeId });

    const commitResult = await this.commit(worktreeId, `Auto-commit before merge to ${target}`);
    if (!commitResult.ok) {
      return commitResult;
    }

    try {
      // F06-NEW-01: argv form. Branch names are codespace-config or
      // task-derived data; pass literally to git.
      const execArgs = requireExecArgs(this.runner);
      const mergeMessage = `Merge branch '${worktree.branch}'`;

      await execArgs(['git', 'checkout', target], worktree.codespace.path);
      await execArgs(['git', 'pull', '--rebase'], worktree.codespace.path);
      const merge = await execArgs(
        ['git', 'merge', worktree.branch, '--no-ff', '-m', mergeMessage],
        worktree.codespace.path
      );

      if (merge.stderr.includes('CONFLICT')) {
        const conflicts = await execArgs(
          ['git', 'diff', '--name-only', '--diff-filter=U'],
          worktree.codespace.path
        );

        // Abort the failed merge to leave the repo in a clean state
        try {
          await execArgs(['git', 'merge', '--abort'], worktree.codespace.path);
        } catch {
          // Merge abort can fail if merge wasn't in progress — ignore
        }

        // Reset worktree status back to active (not stuck in 'merging')
        const [conflictRecovery] = await this.db
          .update(worktrees)
          .set({ status: 'active', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId))
          .returning({ id: worktrees.id });
        softInvariant(!!conflictRecovery, 'Failed to reset worktree status after merge conflict', {
          worktreeId,
        });

        return err(
          WorktreeErrors.MERGE_CONFLICT(conflicts.stdout.trim().split('\n').filter(Boolean))
        );
      }

      const [merged] = await this.db
        .update(worktrees)
        .set({
          mergedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
        })
        .where(eq(worktrees.id, worktreeId))
        .returning({ id: worktrees.id });
      softInvariant(!!merged, 'Failed to update worktree status after successful merge', {
        worktreeId,
      });

      return ok(undefined);
    } catch (error) {
      // Reset worktree status on merge failure
      const [errorRecovery] = await this.db
        .update(worktrees)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId))
        .returning({ id: worktrees.id });
      softInvariant(!!errorRecovery, 'Failed to reset worktree status after merge error', {
        worktreeId,
      });

      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error), error));
    }
  }

  async getDiff(worktreeId: string): WorktreeServiceResult<GitDiff> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    try {
      // F06-NEW-01: argv form. The triple-dot revspec is appended to the
      // base-branch literal so git receives `<base>...HEAD` as a single
      // argv element — no shell interpolation.
      const execArgs = requireExecArgs(this.runner);
      const revspec = `${worktree.baseBranch}...HEAD`;

      // Get diff statistics for file-level analysis
      const numstat = await execArgs(['git', 'diff', '--numstat', revspec], worktree.path);
      const fullDiff = await execArgs(['git', 'diff', revspec], worktree.path);

      const files: DiffFile[] = numstat.stdout
        .trim()
        .split('\n')
        .filter(Boolean)
        .map((line) => {
          const parts = line.split('\t');
          const added = parts[0] ?? '0';
          const removed = parts[1] ?? '0';
          const filePath = parts[2] ?? '';
          return {
            path: filePath,
            status: 'modified' as const,
            additions: Number.parseInt(added, 10),
            deletions: Number.parseInt(removed, 10),
            hunks: extractHunks(fullDiff.stdout, filePath),
          };
        })
        .filter((file) => file.path !== '');

      const totals = files.reduce(
        (acc, file) => {
          acc.additions += file.additions;
          acc.deletions += file.deletions;
          return acc;
        },
        { additions: 0, deletions: 0 }
      );

      return ok({
        files,
        stats: {
          filesChanged: files.length,
          additions: totals.additions,
          deletions: totals.deletions,
        },
      });
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error), error));
    }
  }

  async getStatus(worktreeId: string): WorktreeServiceResult<WorktreeStatusInfo> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: eq(worktrees.id, worktreeId),
    });

    if (!worktree) {
      return err(WorktreeErrors.NOT_FOUND);
    }

    return ok({
      id: worktree.id,
      branch: worktree.branch,
      status: worktree.status,
      path: worktree.path,
      updatedAt: worktree.updatedAt,
    });
  }

  async list(codespaceId: string): Promise<Result<WorktreeStatusInfo[], never>> {
    const list = await this.db.query.worktrees.findMany({
      where: eq(worktrees.codespaceId, codespaceId),
    });

    // Sync with filesystem - remove records for worktrees that no longer exist
    const staleIds: string[] = [];
    const validWorktrees: Worktree[] = [];

    // Check filesystem in parallel (non-blocking)
    const checks = await Promise.all(
      list.map(async (wt) => {
        try {
          await access(wt.path);
          return { wt, exists: true };
        } catch {
          return { wt, exists: false };
        }
      })
    );

    for (const { wt, exists } of checks) {
      if (exists) {
        validWorktrees.push(wt);
      } else if (!this.cleaningUpStaleIds.has(wt.id)) {
        // SL-011: Only add if not already being cleaned up to prevent re-deletion attempts
        staleIds.push(wt.id);
      }
    }

    // Clean up stale records in background (don't block the response)
    if (staleIds.length > 0) {
      // Track IDs being cleaned up
      for (const id of staleIds) {
        this.cleaningUpStaleIds.add(id);
      }
      this.db
        .delete(worktrees)
        .where(inArray(worktrees.id, staleIds))
        .then(() => {
          // Stale worktree records cleaned up successfully
        })
        .catch((_deleteErr) => {
          // Best-effort: stale worktree DB cleanup failure is non-critical
        })
        .finally(() => {
          // Remove from tracking set regardless of success/failure
          for (const id of staleIds) {
            this.cleaningUpStaleIds.delete(id);
          }
        });
    }

    return ok(
      validWorktrees.map((wt: Worktree) => ({
        id: wt.id,
        branch: wt.branch,
        status: wt.status,
        path: wt.path,
        updatedAt: wt.updatedAt,
      }))
    );
  }

  async getByBranch(codespaceId: string, branch: string): Promise<Result<Worktree | null, never>> {
    const worktree = await this.db.query.worktrees.findFirst({
      where: and(eq(worktrees.codespaceId, codespaceId), eq(worktrees.branch, branch)),
    });

    return ok(worktree ?? null);
  }
}
