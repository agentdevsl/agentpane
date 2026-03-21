import { existsSync } from 'node:fs';
import path from 'node:path';
import { and, eq, inArray, lt } from 'drizzle-orm';
import type { Worktree, WorktreeStatus } from '../db/schema';
import { agents, codespaces, worktrees } from '../db/schema';
import { ServiceErrors } from '../lib/errors/service-errors.js';
import type { WorktreeError } from '../lib/errors/worktree-errors.js';
import { WorktreeErrors } from '../lib/errors/worktree-errors.js';
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
 * Escapes a string for safe use in shell commands within double quotes.
 * Removes null bytes and escapes: backslash, double quote, backtick, dollar sign, and newlines.
 */
const escapeShellString = (str: string): string => {
  return str
    .replace(/\0/g, '') // Remove null bytes to prevent injection
    .replace(/\\/g, '\\\\')
    .replace(/"/g, '\\"')
    .replace(/`/g, '\\`')
    .replace(/\$/g, '\\$')
    .replace(/\n/g, '\\n');
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

export type CommandRunner = {
  exec: (command: string, cwd: string) => Promise<CommandResult>;
};

/**
 * Validates that a shell command string does not contain injection metacharacters.
 * Throws if dangerous characters are detected.
 */
function validateShellCommand(command: string): void {
  const DANGEROUS_PATTERN = /[;|`]|\$\(|&&|\|\||[\n\r]/;
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

    const escapedBranchForCheck = escapeShellString(branch);
    const branchCheck = await this.runner.exec(
      `git branch --list "${escapedBranchForCheck}"`,
      codespace.path
    );
    if (branchCheck.stdout.trim()) {
      return err(WorktreeErrors.BRANCH_EXISTS(branch));
    }

    try {
      const escapedPath = escapeShellString(worktreePath);
      const escapedBranch = escapeShellString(branch);
      const escapedBaseBranch = escapeShellString(baseBranch);

      await this.runner.exec(
        `git worktree add "${escapedPath}" -b "${escapedBranch}" "${escapedBaseBranch}"`,
        codespace.path
      );
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(branch, String(error)));
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
        await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId));
        return envResult;
      }
    }

    if (!options?.skipDepsInstall) {
      const depsResult = await this.installDeps(worktreeId);
      if (!depsResult.ok) {
        await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId));
        return depsResult;
      }
    }

    if (!options?.skipInitScript && codespace.config?.initScript) {
      const initResult = await this.runInitScript(worktreeId);
      if (!initResult.ok) {
        await this.db
          .update(worktrees)
          .set({ status: 'error', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId));
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

    await this.db
      .update(worktrees)
      .set({ status: 'removing', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId));

    try {
      const forceFlag = force ? '--force' : '';
      const escapedPath = escapeShellString(worktree.path);
      const escapedBranch = escapeShellString(worktree.branch);

      await this.runner.exec(
        `git worktree remove "${escapedPath}" ${forceFlag}`,
        worktree.codespace.path
      );
      await this.runner.exec(`git branch -D "${escapedBranch}"`, worktree.codespace.path);

      await this.db
        .update(worktrees)
        .set({
          status: 'removed',
          removedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        })
        .where(eq(worktrees.id, worktreeId));

      return ok(undefined);
    } catch (error) {
      await this.db
        .update(worktrees)
        .set({ status: 'error', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));

      return err(WorktreeErrors.REMOVAL_FAILED(worktree.path, String(error)));
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
      const escapedSource = escapeShellString(sourcePath);
      const escapedTarget = escapeShellString(targetPath);
      await this.runner.exec(`cp "${escapedSource}" "${escapedTarget}"`, worktree.codespace.path);
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.ENV_COPY_FAILED(String(error)));
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
      await this.runner.exec('bun install', worktree.path);
      return ok(undefined);
    } catch (error) {
      return err(WorktreeErrors.INIT_SCRIPT_FAILED('bun install', String(error)));
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
      return err(WorktreeErrors.INIT_SCRIPT_FAILED(sanitizedScript, String(error)));
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
      // Note: cwd parameter uses raw path (passed to process spawn, not shell interpolated)
      // Only command arguments need shell escaping
      await this.runner.exec('git add -A', worktree.path);
      const status = await this.runner.exec('git status --porcelain', worktree.path);
      if (!status.stdout.trim()) {
        return ok('');
      }

      const escapedMessage = escapeShellString(message);
      await this.runner.exec(`git commit -m "${escapedMessage}"`, worktree.path);
      const sha = await this.runner.exec('git rev-parse HEAD', worktree.path);

      await this.db
        .update(worktrees)
        .set({ updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));

      return ok(sha.stdout.trim());
    } catch (error) {
      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error)));
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

    await this.db
      .update(worktrees)
      .set({ status: 'merging', updatedAt: new Date().toISOString() })
      .where(eq(worktrees.id, worktreeId));

    const commitResult = await this.commit(worktreeId, `Auto-commit before merge to ${target}`);
    if (!commitResult.ok) {
      return commitResult;
    }

    try {
      // Note: cwd uses raw path; only command arguments need escaping
      const escapedTarget = escapeShellString(target);
      const escapedBranch = escapeShellString(worktree.branch);

      await this.runner.exec(`git checkout "${escapedTarget}"`, worktree.codespace.path);
      await this.runner.exec('git pull --rebase', worktree.codespace.path);
      const mergeMessage = escapeShellString(`Merge branch '${worktree.branch}'`);
      const merge = await this.runner.exec(
        `git merge "${escapedBranch}" --no-ff -m "${mergeMessage}"`,
        worktree.codespace.path
      );

      if (merge.stderr.includes('CONFLICT')) {
        const conflicts = await this.runner.exec(
          'git diff --name-only --diff-filter=U',
          worktree.codespace.path
        );

        // Abort the failed merge to leave the repo in a clean state
        try {
          await this.runner.exec('git merge --abort', worktree.codespace.path);
        } catch {
          // Merge abort can fail if merge wasn't in progress — ignore
        }

        // Reset worktree status back to active (not stuck in 'merging')
        await this.db
          .update(worktrees)
          .set({ status: 'active', updatedAt: new Date().toISOString() })
          .where(eq(worktrees.id, worktreeId));

        return err(
          WorktreeErrors.MERGE_CONFLICT(conflicts.stdout.trim().split('\n').filter(Boolean))
        );
      }

      await this.db
        .update(worktrees)
        .set({
          mergedAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          status: 'active',
        })
        .where(eq(worktrees.id, worktreeId));

      return ok(undefined);
    } catch (error) {
      // Reset worktree status on merge failure
      await this.db
        .update(worktrees)
        .set({ status: 'active', updatedAt: new Date().toISOString() })
        .where(eq(worktrees.id, worktreeId));

      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error)));
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
      // Note: cwd uses raw path; only command arguments need escaping
      const escapedBaseBranch = escapeShellString(worktree.baseBranch);

      // Get diff statistics for file-level analysis
      const numstat = await this.runner.exec(
        `git diff --numstat "${escapedBaseBranch}"...HEAD`,
        worktree.path
      );
      const fullDiff = await this.runner.exec(
        `git diff "${escapedBaseBranch}"...HEAD`,
        worktree.path
      );

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
      return err(WorktreeErrors.CREATION_FAILED(worktree.branch, String(error)));
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

    for (const wt of list) {
      if (existsSync(wt.path)) {
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
        .then(() => {})
        .catch((_deleteErr) => {})
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
