/**
 * K8s Workspace Initializer
 *
 * Encapsulates git clone + worktree operations inside K8s pods via sandbox.exec().
 * All failures are non-fatal:
 *  - Clone failure: falls back to empty /workspace (pod has no source code)
 *  - Worktree failure (after successful clone): falls back to /workspace root
 *    (has code from clone, but no branch isolation)
 */

import { CONTAINER_WORKSPACE_PATH } from '../constants/sandbox.js';
import { createLogger } from '../logging/logger.js';
import { errorMessage } from '../utils/error-message.js';
import { slugify } from '../utils/slugify.js';
import type { GitTokenResult } from './git-token-resolver.js';
import type { ExecResult } from './types.js';

const log = createLogger('K8sWorkspaceInitializer');

const WORKTREES_DIR = `${CONTAINER_WORKSPACE_PATH}/.worktrees`;

/**
 * Minimal sandbox interface for workspace initialization.
 */
export interface SandboxExec {
  exec(cmd: string, args?: string[]): Promise<ExecResult>;
}

export interface K8sWorkspaceOptions {
  readonly sandbox: SandboxExec;
  readonly gitToken: GitTokenResult;
  readonly taskTitle: string;
  readonly taskId: string;
  /** Base branch to clone and create worktree from. Defaults to 'main'. */
  readonly baseBranch?: string;
  /** Existing branch name to reuse instead of generating one from taskTitle/taskId.
   *  Typically set from task.branch during the execution phase after planning already created the branch. */
  readonly existingBranch?: string;
}

export interface K8sWorkspaceResult {
  readonly worktreePath: string;
  readonly branch: string | null;
  /** Error message when clone or worktree creation failed */
  readonly error?: string;
}

/** Strip credentials from a string to prevent token leakage in logs. */
function sanitizeCredentials(str: string): string {
  return str.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
}

/** Validate that a string is a valid GitHub owner or repo name. */
const GITHUB_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Check if the workspace has been cloned (i.e. /workspace/.git exists).
 */
async function isWorkspaceCloned(sandbox: SandboxExec): Promise<boolean> {
  try {
    const result = await sandbox.exec('test', ['-d', `${CONTAINER_WORKSPACE_PATH}/.git`]);
    return result.exitCode === 0;
  } catch (err) {
    log.debug('Failed to check workspace clone status', { error: err });
    return false;
  }
}

/**
 * Clone the repository into /workspace.
 * Uses shallow clone (--depth 1) with --no-single-branch to keep all branch refs
 * available for worktree creation while minimizing download size.
 * Returns true on success, false on failure.
 */
async function cloneRepository(
  sandbox: SandboxExec,
  token: string,
  owner: string,
  repo: string,
  baseBranch: string
): Promise<{ ok: boolean; error?: string }> {
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    return { ok: false, error: `Invalid owner/repo format: ${owner}/${repo}` };
  }

  // Token is embedded in the clone URL for simplicity (git credential helpers
  // may not be available in the pod). We strip it from the remote immediately
  // after clone to prevent credential leakage via `git remote -v` or logs.
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  try {
    // Initialize git repo in /workspace if not already a repo.
    // We use init+fetch instead of clone because /workspace may be non-empty
    // (entrypoint.sh copies skills/agents/config there first).
    const isCloned = await isWorkspaceCloned(sandbox);
    if (!isCloned) {
      try {
        await sandbox.exec('git', ['init', CONTAINER_WORKSPACE_PATH]);
      } catch (initErr) {
        log.debug('git init threw (workspace may already be initialized)', {
          error: errorMessage(initErr),
        });
      }
    }

    // Configure git safe.directory to avoid ownership warnings in containers
    try {
      await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'config',
        '--global',
        'safe.directory',
        CONTAINER_WORKSPACE_PATH,
      ]);
    } catch {
      // Non-critical — may already be configured
    }

    // Set origin remote URL (add if missing, update if exists)
    try {
      const addResult = await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'remote',
        'add',
        'origin',
        cloneUrl,
      ]);
      if (addResult.exitCode !== 0) {
        // Origin already exists — update its URL to use the fresh token
        await sandbox.exec('git', [
          '-C',
          CONTAINER_WORKSPACE_PATH,
          'remote',
          'set-url',
          'origin',
          cloneUrl,
        ]);
      }
    } catch {
      // If remote add threw, try set-url as fallback
      try {
        await sandbox.exec('git', [
          '-C',
          CONTAINER_WORKSPACE_PATH,
          'remote',
          'set-url',
          'origin',
          cloneUrl,
        ]);
      } catch (setUrlErr) {
        return { ok: false, error: `Failed to configure git remote: ${errorMessage(setUrlErr)}` };
      }
    }

    // Fetch the requested branch (shallow). If that fails, fetch the default branch.
    let cloneResult = await sandbox.exec('git', [
      '-C',
      CONTAINER_WORKSPACE_PATH,
      'fetch',
      '--depth',
      '1',
      'origin',
      baseBranch,
    ]);

    if (cloneResult.exitCode !== 0) {
      // Branch may not exist — fetch default branch instead
      log.info('Branch fetch failed, fetching default branch', {
        data: { baseBranch, owner, repo },
      });
      cloneResult = await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'fetch',
        '--depth',
        '1',
        'origin',
      ]);
    }

    if (cloneResult.exitCode !== 0) {
      // Sanitize and return error early
      const safeStderr = sanitizeCredentials(cloneResult.stderr ?? '');
      log.warn('Git fetch failed', {
        data: { owner, repo, exitCode: cloneResult.exitCode, stderr: safeStderr },
      });
      return {
        ok: false,
        error: safeStderr || `git fetch exited with code ${cloneResult.exitCode}`,
      };
    }

    // Checkout the base branch (try specified branch, fall back to remote HEAD)
    cloneResult = await sandbox.exec('git', [
      '-C',
      CONTAINER_WORKSPACE_PATH,
      'checkout',
      '-f',
      `origin/${baseBranch}`,
    ]);

    if (cloneResult.exitCode !== 0) {
      // Branch not found — try origin/HEAD
      log.info('Branch not found, trying default branch', { data: { baseBranch, owner, repo } });
      cloneResult = await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'checkout',
        '-f',
        'FETCH_HEAD',
      ]);
    }

    // Create a local tracking branch
    if (cloneResult.exitCode === 0) {
      const branchResult = await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'checkout',
        '-B',
        baseBranch,
      ]);
      if (branchResult.exitCode !== 0) {
        log.warn('Failed to create local branch', {
          data: { baseBranch, exitCode: branchResult.exitCode },
        });
      }
    }

    if (cloneResult.exitCode !== 0) {
      // Sanitize stderr to remove tokens before logging
      const safeStderr = sanitizeCredentials(cloneResult.stderr ?? '');
      log.warn('Git clone failed', {
        data: { owner, repo, baseBranch, exitCode: cloneResult.exitCode, stderr: safeStderr },
      });
      return {
        ok: false,
        error: safeStderr || `git clone exited with code ${cloneResult.exitCode}`,
      };
    }

    // Strip token from remote URL to prevent leaking credentials
    const stripResult = await sandbox.exec('git', [
      '-C',
      CONTAINER_WORKSPACE_PATH,
      'remote',
      'set-url',
      'origin',
      `https://github.com/${owner}/${repo}.git`,
    ]);
    if (stripResult.exitCode !== 0) {
      return { ok: false, error: 'Failed to strip token from remote URL' };
    }

    // Disable credential helper to prevent token persistence
    const credResult = await sandbox.exec('git', [
      '-C',
      CONTAINER_WORKSPACE_PATH,
      'config',
      'credential.helper',
      '',
    ]);
    if (credResult.exitCode !== 0) {
      log.debug('Failed to disable credential helper', { data: { exitCode: credResult.exitCode } });
    }
    return { ok: true };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn('Failed to clone repository', { error: msg });
    return { ok: false, error: msg };
  }
}

/**
 * Try adding a git worktree. Returns the ExecResult for exit code inspection.
 */
async function tryWorktreeAdd(
  sandbox: SandboxExec,
  worktreePath: string,
  branch: string,
  baseBranch?: string
): Promise<ExecResult> {
  const args = ['-C', CONTAINER_WORKSPACE_PATH, 'worktree', 'add', worktreePath];
  if (baseBranch) {
    args.push('-b', branch, baseBranch);
  } else {
    args.push(branch);
  }
  return sandbox.exec('git', args);
}

/**
 * Create a worktree for the given branch.
 * Returns the worktree path on success, or null on failure.
 */
async function createWorktree(
  sandbox: SandboxExec,
  branch: string,
  baseBranch: string
): Promise<string | null> {
  const worktreePath = `${WORKTREES_DIR}/${branch}`;

  // Check if this worktree path already exists
  try {
    const result = await sandbox.exec('test', ['-d', worktreePath]);
    if (result.exitCode === 0) {
      return worktreePath;
    }
  } catch (err) {
    log.debug('Worktree path check failed', { error: err });
  }

  // Ensure the worktrees parent directory exists
  try {
    await sandbox.exec('mkdir', ['-p', WORKTREES_DIR]);
  } catch (err) {
    log.warn('Failed to create worktrees directory', { error: err });
    return null;
  }

  // Try creating worktree with a new branch (-b), then retry without -b if branch already exists
  try {
    const result = await tryWorktreeAdd(sandbox, worktreePath, branch, baseBranch);
    if (result.exitCode === 0) {
      return worktreePath;
    }
  } catch (err) {
    log.debug('Worktree add with new branch failed, will retry', { error: err });
  }

  // Retry without -b (branch already exists from a prior planning phase, or existingBranch was provided)
  try {
    const retryResult = await tryWorktreeAdd(sandbox, worktreePath, branch);
    if (retryResult.exitCode === 0) {
      return worktreePath;
    }
    return null;
  } catch (err) {
    log.debug('Worktree add retry failed', { error: err });
    return null;
  }
}

/**
 * Initialize the workspace inside a K8s pod.
 *
 * 1. Clones the repo if not already cloned
 * 2. Creates a worktree for branch isolation
 * 3. Falls back gracefully on any failure
 */
export async function initializeK8sWorkspace(
  options: K8sWorkspaceOptions
): Promise<K8sWorkspaceResult> {
  const { sandbox, gitToken, taskTitle, taskId, baseBranch = 'main', existingBranch } = options;
  const { token, owner, repo } = gitToken;

  // Step 1: Clone if needed
  const cloned = await isWorkspaceCloned(sandbox);
  if (!cloned) {
    const cloneResult = await cloneRepository(sandbox, token, owner, repo, baseBranch);
    if (!cloneResult.ok) {
      return { worktreePath: CONTAINER_WORKSPACE_PATH, branch: null, error: cloneResult.error };
    }
  }

  // Step 2: Create worktree
  const branch = existingBranch ?? `${slugify(taskTitle)}-${taskId.slice(0, 6)}`;
  const worktreePath = await createWorktree(sandbox, branch, baseBranch);

  if (!worktreePath) {
    return {
      worktreePath: CONTAINER_WORKSPACE_PATH,
      branch: null,
      error: `Failed to create worktree for branch "${branch}"`,
    };
  }

  return { worktreePath, branch };
}
