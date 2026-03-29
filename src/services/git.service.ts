import { eq } from 'drizzle-orm';
import { codespaces } from '../db/schema';
import type { GitError } from '../lib/errors/git-errors.js';
import { GitErrors } from '../lib/errors/git-errors.js';
import { createLogger } from '../lib/logging/logger.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { CommandRunner } from './worktree.service.js';

const log = createLogger('GitService');

/**
 * Escape a string for safe use in a shell command argument.
 * Wraps the value in single quotes with proper escaping of embedded single quotes.
 */
function shellEscape(value: string): string {
  // Replace each single quote with end-quote, escaped-single-quote, start-quote
  return `'${value.replace(/'/g, "'\\''")}'`;
}

/**
 * Validate that a git branch name is safe.
 * Prevents command injection by only allowing safe characters.
 */
function isValidBranchName(branch: string): boolean {
  if (!branch || typeof branch !== 'string') return false;
  if (branch.length < 1 || branch.length > 250) return false;
  if (branch.includes('..')) return false;
  return /^[a-zA-Z0-9_\-/.]+$/.test(branch);
}

export type GitStatus = {
  repoName: string;
  currentBranch: string;
  status: 'dirty' | 'clean';
  staged: number;
  unstaged: number;
  untracked: number;
  ahead: number;
  behind: number;
};

export type GitBranch = {
  name: string;
  commitHash: string;
  shortHash: string;
  commitCount: number;
  isHead: boolean;
  status: 'ahead' | 'behind' | 'diverged' | 'up-to-date' | 'no-upstream';
};

export type GitCommit = {
  hash: string;
  shortHash: string;
  message: string;
  author: string;
  date: string;
  additions?: number;
  deletions?: number;
  filesChanged?: number;
};

export type GitRemoteBranch = {
  name: string;
  fullName: string;
  commitHash: string;
  shortHash: string;
  commitCount: number;
};

export class GitService {
  private pathCache = new Map<string, { path: string; name: string; expiresAt: number }>();
  private lastFetchTime = new Map<string, number>();
  private static readonly FETCH_THROTTLE_MS = 30_000;
  private static readonly PATH_CACHE_TTL_MS = 60_000;

  constructor(
    private db: Database,
    private commandRunner: CommandRunner
  ) {}

  /**
   * Resolve a codespace's filesystem path by codespace ID.
   * Eliminates repeated codespace lookups across git endpoints.
   */
  private async resolveCodespacePath(
    codespaceId: string
  ): Promise<Result<{ path: string; name: string }, GitError>> {
    const now = Date.now();
    const cached = this.pathCache.get(codespaceId);
    if (cached && cached.expiresAt > now) {
      return ok({ path: cached.path, name: cached.name });
    }

    try {
      const codespace = await this.db.query.codespaces.findFirst({
        where: eq(codespaces.id, codespaceId),
      });

      if (!codespace) {
        return err(GitErrors.PROJECT_NOT_FOUND);
      }

      this.pathCache.set(codespaceId, {
        path: codespace.path,
        name: codespace.name,
        expiresAt: now + GitService.PATH_CACHE_TTL_MS,
      });

      return ok({ path: codespace.path, name: codespace.name });
    } catch (error) {
      log.warn('Failed to lookup codespace', { error });
      return err(GitErrors.DATABASE_ERROR('Failed to lookup codespace'));
    }
  }

  async getStatus(codespaceId: string): Promise<Result<GitStatus, GitError>> {
    const codespaceResult = await this.resolveCodespacePath(codespaceId);
    if (!codespaceResult.ok) {
      return codespaceResult;
    }

    const { path: codespacePath, name: codespaceName } = codespaceResult.value;

    try {
      // Get current branch
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git rev-parse --abbrev-ref HEAD',
        codespacePath
      );
      const currentBranch = branchOutput.trim();

      // Get repo name from path
      const repoName = codespacePath.split('/').pop() || codespaceName;

      // Get git status (porcelain format for easy parsing)
      const { stdout: statusOutput } = await this.commandRunner.exec(
        'git status --porcelain',
        codespacePath
      );

      const statusLines = statusOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim());
      const staged = statusLines.filter((line) => /^[MADRC]/.test(line)).length;
      const unstaged = statusLines.filter((line) => /^.[MADRC]/.test(line)).length;
      const untracked = statusLines.filter((line) => line.startsWith('??')).length;
      const hasChanges = statusLines.length > 0;

      // Get ahead/behind info
      // AR-015: Replaced shell redirection (`2>/dev/null || echo "0\t0"`) with
      // proper try/catch in the service layer. Shell redirection is fragile and
      // can mask real errors; try/catch gives us explicit control over error handling.
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: aheadBehind } = await this.commandRunner.exec(
          'git rev-list --left-right --count HEAD...@{upstream}',
          codespacePath
        );
        const [aheadStr, behindStr] = aheadBehind.trim().split(/\s+/);
        ahead = Number.parseInt(aheadStr || '0', 10) || 0;
        behind = Number.parseInt(behindStr || '0', 10) || 0;
      } catch {
        // No upstream tracking branch — this is expected for local-only branches.
        // Default ahead/behind to 0 when no upstream exists.
      }

      return ok({
        repoName,
        currentBranch,
        status: hasChanges ? 'dirty' : 'clean',
        staged,
        unstaged,
        untracked,
        ahead,
        behind,
      });
    } catch (error) {
      log.warn('Failed to get git status', { error });
      return err(GitErrors.COMMAND_FAILED('Failed to get git status'));
    }
  }

  async listBranches(codespaceId: string): Promise<Result<{ items: GitBranch[] }, GitError>> {
    const codespaceResult = await this.resolveCodespacePath(codespaceId);
    if (!codespaceResult.ok) {
      return codespaceResult;
    }

    const codespacePath = codespaceResult.value.path;

    try {
      // Get current HEAD branch
      const { stdout: headOutput } = await this.commandRunner.exec(
        'git rev-parse --abbrev-ref HEAD',
        codespacePath
      );
      const currentBranch = headOutput.trim();

      // Get all local branches with their commit info
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git for-each-ref --format="%(refname:short)|%(objectname)|%(objectname:short)|%(upstream:track)" refs/heads/',
        codespacePath
      );

      // Detect default branch once
      let defaultBranch = 'main';
      try {
        const { stdout: defaultRef } = await this.commandRunner.exec(
          'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/main"',
          codespacePath
        );
        defaultBranch = defaultRef.trim().replace('refs/remotes/origin/', '') || 'main';
      } catch {
        /* keep main as default */
      }

      // Batch: get commit counts for all branches in one command
      const commitCounts = new Map<string, number>();
      try {
        const { stdout: countsOutput } = await this.commandRunner.exec(
          `git for-each-ref --format="%(refname:short)" refs/heads/ | while read branch; do count=$(git rev-list --count ${shellEscape(defaultBranch)}.."$branch" 2>/dev/null || echo "0"); echo "$branch|$count"; done`,
          codespacePath
        );
        for (const line of countsOutput
          .trim()
          .split('\n')
          .filter((l) => l.trim())) {
          const [name, count] = line.split('|');
          if (name) commitCounts.set(name, parseInt(count || '0', 10));
        }
      } catch (_error) {
        /* counts default to 0 */
      }

      const branches = branchOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [name, commitHash, shortHash, trackInfo] = line.split('|');
          if (!name || !commitHash) return null;

          const commitCount = commitCounts.get(name) ?? 0;

          // Parse tracking status
          let status: GitBranch['status'] = 'no-upstream';
          if (trackInfo) {
            if (trackInfo.includes('ahead') && trackInfo.includes('behind')) {
              status = 'diverged';
            } else if (trackInfo.includes('ahead')) {
              status = 'ahead';
            } else if (trackInfo.includes('behind')) {
              status = 'behind';
            } else if (trackInfo === '') {
              status = 'up-to-date';
            }
          }

          return {
            name: name || '',
            commitHash: commitHash || '',
            shortHash: shortHash || '',
            commitCount,
            isHead: name === currentBranch,
            status,
          };
        });

      // Filter out nulls and sort by isHead first, then by name
      const validBranches = branches
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => {
          if (a.isHead && !b.isHead) return -1;
          if (!a.isHead && b.isHead) return 1;
          return a.name.localeCompare(b.name);
        });

      return ok({ items: validBranches });
    } catch (error) {
      log.warn('Failed to list branches', { error });
      return err(GitErrors.COMMAND_FAILED('Failed to list branches'));
    }
  }

  async listCommits(
    codespaceId: string,
    options?: { branch?: string; limit?: number }
  ): Promise<Result<{ items: GitCommit[] }, GitError>> {
    const codespaceResult = await this.resolveCodespacePath(codespaceId);
    if (!codespaceResult.ok) {
      return codespaceResult;
    }

    const codespacePath = codespaceResult.value.path;
    const branch = options?.branch;
    const limit = options?.limit ?? 50;

    try {
      // Validate branch name if provided
      if (branch && !isValidBranchName(branch)) {
        return err(GitErrors.INVALID_BRANCH);
      }

      // Use shellEscape for the branch name; default to HEAD
      const targetBranch = branch ? shellEscape(branch) : 'HEAD';

      // Get commit log with stats inline in a single command.
      // Use record separator (\x1e) as field delimiter to avoid conflicts with
      // pipe characters that may appear in commit subjects.
      const SEP = '\x1e';
      const { stdout: logOutput } = await this.commandRunner.exec(
        `git log ${targetBranch} --format="COMMIT_START%H${SEP}%h${SEP}%s${SEP}%an${SEP}%aI" --stat -n ${Number(limit)}`,
        codespacePath
      );

      const commits = logOutput
        .split('COMMIT_START')
        .filter((block) => block.trim())
        .map((block) => {
          const lines = block.split('\n');
          const headerLine = lines[0] || '';
          const parts = headerLine.split(SEP);
          const hash = parts[0] || '';
          const shortHash = parts[1] || '';
          const message = parts[2] || '';
          const author = parts[3] || '';
          const date = parts[4] || '';

          // Parse stats from the last non-empty line of the block
          let additions: number | undefined;
          let deletions: number | undefined;
          let filesChanged: number | undefined;

          // Find the summary stats line (e.g. "3 files changed, 10 insertions(+), 5 deletions(-)")
          for (let i = lines.length - 1; i >= 1; i--) {
            const statsLine = lines[i]?.trim() || '';
            if (statsLine.includes('changed')) {
              const filesMatch = statsLine.match(/(\d+) files? changed/);
              const insertionsMatch = statsLine.match(/(\d+) insertions?\(\+\)/);
              const deletionsMatch = statsLine.match(/(\d+) deletions?\(-\)/);

              if (filesMatch) filesChanged = parseInt(filesMatch[1] || '0', 10);
              if (insertionsMatch) additions = parseInt(insertionsMatch[1] || '0', 10);
              if (deletionsMatch) deletions = parseInt(deletionsMatch[1] || '0', 10);
              break;
            }
          }

          return {
            hash,
            shortHash,
            message,
            author,
            date,
            ...(additions !== undefined && { additions }),
            ...(deletions !== undefined && { deletions }),
            ...(filesChanged !== undefined && { filesChanged }),
          };
        });

      return ok({ items: commits });
    } catch (error) {
      log.warn('Failed to list commits', { error });
      return err(GitErrors.COMMAND_FAILED('Failed to list commits'));
    }
  }

  async listRemoteBranches(
    codespaceId: string
  ): Promise<Result<{ items: GitRemoteBranch[] }, GitError>> {
    const codespaceResult = await this.resolveCodespacePath(codespaceId);
    if (!codespaceResult.ok) {
      return codespaceResult;
    }

    const codespacePath = codespaceResult.value.path;

    try {
      // Fetch latest from remote (throttled, don't fail if offline)
      const now = Date.now();
      const lastFetch = this.lastFetchTime.get(codespaceId) ?? 0;
      if (now - lastFetch >= GitService.FETCH_THROTTLE_MS) {
        try {
          await this.commandRunner.exec('git fetch --prune 2>/dev/null || true', codespacePath);
          this.lastFetchTime.set(codespaceId, Date.now());
        } catch (_error) {}
      }

      // Get all remote branches with their commit info
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git for-each-ref --format="%(refname:short)|%(objectname)|%(objectname:short)" refs/remotes/',
        codespacePath
      );

      // Detect default branch once
      let defaultBranch = 'main';
      try {
        const { stdout: defaultRef } = await this.commandRunner.exec(
          'git symbolic-ref refs/remotes/origin/HEAD 2>/dev/null || echo "refs/remotes/origin/main"',
          codespacePath
        );
        defaultBranch = defaultRef.trim().replace('refs/remotes/origin/', '') || 'main';
      } catch {
        /* keep main as default */
      }

      // Batch: get commit counts for all remote branches in one command
      const commitCounts = new Map<string, number>();
      try {
        const { stdout: countsOutput } = await this.commandRunner.exec(
          `git for-each-ref --format="%(refname:short)" refs/remotes/ | grep -v HEAD | while read branch; do count=$(git rev-list --count ${shellEscape(defaultBranch)}.."$branch" 2>/dev/null || echo "0"); echo "$branch|$count"; done`,
          codespacePath
        );
        for (const line of countsOutput
          .trim()
          .split('\n')
          .filter((l) => l.trim())) {
          const [name, count] = line.split('|');
          if (name) commitCounts.set(name, parseInt(count || '0', 10));
        }
      } catch (_error) {
        /* counts default to 0 */
      }

      const branches = branchOutput
        .trim()
        .split('\n')
        .filter((line) => line.trim())
        .map((line) => {
          const [fullName, commitHash, shortHash] = line.split('|');
          if (!fullName || !commitHash) return null;

          // Skip HEAD pointer
          if (fullName.endsWith('/HEAD')) return null;

          // Skip entries without a slash
          if (!fullName.includes('/')) return null;

          // Remove remote prefix
          const name = fullName.replace(/^[^/]+\//, '');

          const commitCount = commitCounts.get(fullName) ?? 0;

          return {
            name,
            fullName: fullName || '',
            commitHash: commitHash || '',
            shortHash: shortHash || '',
            commitCount,
          };
        });

      // Filter out nulls and sort by name
      const validBranches = branches
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      return ok({ items: validBranches });
    } catch (error) {
      log.warn('Failed to list remote branches', { error });
      return err(GitErrors.COMMAND_FAILED('Failed to list remote branches'));
    }
  }
}
