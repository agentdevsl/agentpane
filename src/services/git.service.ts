import { eq } from 'drizzle-orm';
import { projects } from '../db/schema';
import type { GitError } from '../lib/errors/git-errors.js';
import { GitErrors } from '../lib/errors/git-errors.js';
import type { Result } from '../lib/utils/result.js';
import { err, ok } from '../lib/utils/result.js';
import type { Database } from '../types/database.js';
import type { CommandRunner } from './worktree.service.js';

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
  constructor(
    private db: Database,
    private commandRunner: CommandRunner
  ) {}

  /**
   * Resolve a project's filesystem path by project ID.
   * Eliminates repeated project lookups across git endpoints.
   */
  private async resolveProjectPath(
    projectId: string
  ): Promise<Result<{ path: string; name: string }, GitError>> {
    try {
      const project = await this.db.query.projects.findFirst({
        where: eq(projects.id, projectId),
      });

      if (!project) {
        return err(GitErrors.PROJECT_NOT_FOUND);
      }

      return ok({ path: project.path, name: project.name });
    } catch (error) {
      console.error('[GitService] Project lookup error:', error);
      return err(GitErrors.DATABASE_ERROR('Failed to lookup project'));
    }
  }

  async getStatus(projectId: string): Promise<Result<GitStatus, GitError>> {
    const projectResult = await this.resolveProjectPath(projectId);
    if (!projectResult.ok) {
      return projectResult;
    }

    const { path: projectPath, name: projectName } = projectResult.value;

    try {
      // Get current branch
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git rev-parse --abbrev-ref HEAD',
        projectPath
      );
      const currentBranch = branchOutput.trim();

      // Get repo name from path
      const repoName = projectPath.split('/').pop() || projectName;

      // Get git status (porcelain format for easy parsing)
      const { stdout: statusOutput } = await this.commandRunner.exec(
        'git status --porcelain',
        projectPath
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
      let ahead = 0;
      let behind = 0;
      try {
        const { stdout: aheadBehind } = await this.commandRunner.exec(
          'git rev-list --left-right --count HEAD...@{upstream} 2>/dev/null || echo "0\t0"',
          projectPath
        );
        const [aheadStr, behindStr] = aheadBehind.trim().split(/\s+/);
        ahead = parseInt(aheadStr || '0', 10) || 0;
        behind = parseInt(behindStr || '0', 10) || 0;
      } catch (error) {
        // No upstream tracking branch - this is expected for local-only branches
        console.debug(
          '[GitService] No upstream for branch:',
          error instanceof Error ? error.message : 'unknown'
        );
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
      console.error('[GitService] Get status error:', error);
      return err(GitErrors.COMMAND_FAILED('Failed to get git status'));
    }
  }

  async listBranches(projectId: string): Promise<Result<{ items: GitBranch[] }, GitError>> {
    const projectResult = await this.resolveProjectPath(projectId);
    if (!projectResult.ok) {
      return projectResult;
    }

    const projectPath = projectResult.value.path;

    try {
      // Get current HEAD branch
      const { stdout: headOutput } = await this.commandRunner.exec(
        'git rev-parse --abbrev-ref HEAD',
        projectPath
      );
      const currentBranch = headOutput.trim();

      // Get all local branches with their commit info
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git for-each-ref --format="%(refname:short)|%(objectname)|%(objectname:short)|%(upstream:track)" refs/heads/',
        projectPath
      );

      const branches = await Promise.all(
        branchOutput
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map(async (line) => {
            const [name, commitHash, shortHash, trackInfo] = line.split('|');
            if (!name || !commitHash) return null;

            // Get commit count (commits ahead of main/master)
            let commitCount = 0;
            try {
              if (!isValidBranchName(name)) {
                console.warn('[GitService] Skipping commit count for invalid branch name:', name);
              } else {
                // Use shellEscape for safe interpolation
                const escapedName = shellEscape(name);
                const { stdout: countOutput } = await this.commandRunner.exec(
                  `git rev-list --count main..${escapedName} 2>/dev/null || git rev-list --count master..${escapedName} 2>/dev/null || echo "0"`,
                  projectPath
                );
                commitCount = parseInt(countOutput.trim(), 10) || 0;
              }
            } catch (error) {
              console.debug(
                '[GitService] Could not get commit count for branch:',
                error instanceof Error ? error.message : 'unknown'
              );
            }

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
          })
      );

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
      console.error('[GitService] List branches error:', error);
      return err(GitErrors.COMMAND_FAILED('Failed to list branches'));
    }
  }

  async listCommits(
    projectId: string,
    options?: { branch?: string; limit?: number }
  ): Promise<Result<{ items: GitCommit[] }, GitError>> {
    const projectResult = await this.resolveProjectPath(projectId);
    if (!projectResult.ok) {
      return projectResult;
    }

    const projectPath = projectResult.value.path;
    const branch = options?.branch;
    const limit = options?.limit ?? 50;

    try {
      // Validate branch name if provided
      if (branch && !isValidBranchName(branch)) {
        return err(GitErrors.INVALID_BRANCH);
      }

      // Use shellEscape for the branch name; default to HEAD
      const targetBranch = branch ? shellEscape(branch) : 'HEAD';

      // Get commit log with format: hash|short|subject|author|date
      const { stdout: logOutput } = await this.commandRunner.exec(
        `git log ${targetBranch} --format="%H|%h|%s|%an|%aI" -n ${Number(limit)}`,
        projectPath
      );

      const commits = await Promise.all(
        logOutput
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map(async (line) => {
            const parts = line.split('|');
            const hash = parts[0] || '';
            const shortHash = parts[1] || '';
            const message = parts[2] || '';
            const author = parts[3] || '';
            const date = parts[4] || '';

            // Get file stats for each commit — hash is from git output, safe to interpolate
            let additions: number | undefined;
            let deletions: number | undefined;
            let filesChanged: number | undefined;

            try {
              const { stdout: statsOutput } = await this.commandRunner.exec(
                `git show ${shellEscape(hash)} --stat --format="" | tail -1`,
                projectPath
              );
              const statsLine = statsOutput.trim();
              const filesMatch = statsLine.match(/(\d+) files? changed/);
              const insertionsMatch = statsLine.match(/(\d+) insertions?\(\+\)/);
              const deletionsMatch = statsLine.match(/(\d+) deletions?\(-\)/);

              if (filesMatch) filesChanged = parseInt(filesMatch[1] || '0', 10);
              if (insertionsMatch) additions = parseInt(insertionsMatch[1] || '0', 10);
              if (deletionsMatch) deletions = parseInt(deletionsMatch[1] || '0', 10);
            } catch (error) {
              console.debug(
                '[GitService] Could not get stats for commit:',
                error instanceof Error ? error.message : 'unknown'
              );
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
          })
      );

      return ok({ items: commits });
    } catch (error) {
      console.error('[GitService] List commits error:', error);
      return err(GitErrors.COMMAND_FAILED('Failed to list commits'));
    }
  }

  async listRemoteBranches(
    projectId: string
  ): Promise<Result<{ items: GitRemoteBranch[] }, GitError>> {
    const projectResult = await this.resolveProjectPath(projectId);
    if (!projectResult.ok) {
      return projectResult;
    }

    const projectPath = projectResult.value.path;

    try {
      // Fetch latest from remote (don't fail if offline)
      try {
        await this.commandRunner.exec('git fetch --prune 2>/dev/null || true', projectPath);
      } catch (error) {
        console.debug(
          '[GitService] Fetch failed (may be offline):',
          error instanceof Error ? error.message : 'unknown'
        );
      }

      // Get all remote branches with their commit info
      const { stdout: branchOutput } = await this.commandRunner.exec(
        'git for-each-ref --format="%(refname:short)|%(objectname)|%(objectname:short)" refs/remotes/',
        projectPath
      );

      const branches = await Promise.all(
        branchOutput
          .trim()
          .split('\n')
          .filter((line) => line.trim())
          .map(async (line) => {
            const [fullName, commitHash, shortHash] = line.split('|');
            if (!fullName || !commitHash) return null;

            // Skip HEAD pointer
            if (fullName.endsWith('/HEAD')) return null;

            // Skip entries without a slash
            if (!fullName.includes('/')) return null;

            // Remove remote prefix
            const name = fullName.replace(/^[^/]+\//, '');

            // Get commit count from main/master
            let commitCount = 0;
            try {
              if (!isValidBranchName(fullName)) {
                console.warn(
                  '[GitService] Skipping commit count for invalid remote branch name:',
                  fullName
                );
              } else {
                const escapedFullName = shellEscape(fullName);
                const { stdout: countOutput } = await this.commandRunner.exec(
                  `git rev-list --count main..${escapedFullName} 2>/dev/null || git rev-list --count master..${escapedFullName} 2>/dev/null || echo "0"`,
                  projectPath
                );
                commitCount = parseInt(countOutput.trim(), 10) || 0;
              }
            } catch (error) {
              console.debug(
                '[GitService] Could not get commit count for remote branch:',
                error instanceof Error ? error.message : 'unknown'
              );
            }

            return {
              name,
              fullName: fullName || '',
              commitHash: commitHash || '',
              shortHash: shortHash || '',
              commitCount,
            };
          })
      );

      // Filter out nulls and sort by name
      const validBranches = branches
        .filter((b): b is NonNullable<typeof b> => b !== null)
        .sort((a, b) => a.name.localeCompare(b.name));

      return ok({ items: validBranches });
    } catch (error) {
      console.error('[GitService] List remote branches error:', error);
      return err(GitErrors.COMMAND_FAILED('Failed to list remote branches'));
    }
  }
}
