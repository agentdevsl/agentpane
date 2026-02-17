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
import { slugify } from '../utils/slugify.js';
import type { GitTokenResult } from './git-token-resolver.js';
import type { ExecResult } from './types.js';

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
}

function formatError(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
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
    console.warn(
      `[K8sWorkspaceInit] Failed to check clone status (will attempt fresh clone): ${formatError(err)}`
    );
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
): Promise<boolean> {
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    console.warn(`[K8sWorkspaceInit] Invalid owner/repo format: ${owner}/${repo}`);
    return false;
  }

  // Token is embedded in the clone URL for simplicity (git credential helpers
  // may not be available in the pod). We strip it from the remote immediately
  // after clone to prevent credential leakage via `git remote -v` or logs.
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

  console.log(
    `[K8sWorkspaceInit] Cloning ${owner}/${repo} (branch: ${baseBranch}) into ${CONTAINER_WORKSPACE_PATH}`
  );

  try {
    const cloneResult = await sandbox.exec('git', [
      'clone',
      '--depth',
      '1',
      '--no-single-branch',
      '--branch',
      baseBranch,
      cloneUrl,
      CONTAINER_WORKSPACE_PATH,
    ]);

    if (cloneResult.exitCode !== 0) {
      console.warn(
        `[K8sWorkspaceInit] Clone failed (exit ${cloneResult.exitCode}): ${sanitizeCredentials(cloneResult.stderr)}`
      );
      return false;
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
      console.error(
        `[K8sWorkspaceInit] SECURITY: Failed to strip token from remote URL (exit ${stripResult.exitCode}). Aborting clone.`
      );
      return false;
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
      console.warn(
        `[K8sWorkspaceInit] Failed to disable credential helper (exit ${credResult.exitCode})`
      );
    }

    console.log(`[K8sWorkspaceInit] Clone successful`);
    return true;
  } catch (err) {
    console.warn(`[K8sWorkspaceInit] Clone threw: ${sanitizeCredentials(formatError(err))}`);
    return false;
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
      console.log(`[K8sWorkspaceInit] Worktree already exists at ${worktreePath}`);
      return worktreePath;
    }
  } catch (err) {
    console.warn(
      `[K8sWorkspaceInit] Failed to check worktree existence for branch=${branch}: ${formatError(err)}`
    );
  }

  // Ensure the worktrees parent directory exists
  try {
    await sandbox.exec('mkdir', ['-p', WORKTREES_DIR]);
  } catch (err) {
    console.warn(`[K8sWorkspaceInit] Failed to create worktrees dir: ${formatError(err)}`);
    return null;
  }

  console.log(
    `[K8sWorkspaceInit] Creating worktree: branch=${branch}, base=${baseBranch}, path=${worktreePath}`
  );

  // Try creating worktree with a new branch (-b), then retry without -b if branch already exists
  try {
    const result = await tryWorktreeAdd(sandbox, worktreePath, branch, baseBranch);
    if (result.exitCode === 0) {
      console.log(`[K8sWorkspaceInit] Worktree created successfully at ${worktreePath}`);
      return worktreePath;
    }
    console.log(
      `[K8sWorkspaceInit] Worktree -b failed (exit ${result.exitCode}), retrying without -b`
    );
  } catch (err) {
    console.warn(`[K8sWorkspaceInit] Worktree -b threw: ${formatError(err)}, retrying without -b`);
  }

  // Retry without -b (branch already exists from a prior planning phase, or existingBranch was provided)
  try {
    const retryResult = await tryWorktreeAdd(sandbox, worktreePath, branch);
    if (retryResult.exitCode === 0) {
      console.log(`[K8sWorkspaceInit] Worktree created (existing branch) at ${worktreePath}`);
      return worktreePath;
    }
    console.warn(
      `[K8sWorkspaceInit] Worktree retry failed (exit ${retryResult.exitCode}): ${retryResult.stderr}`
    );
    return null;
  } catch (err) {
    console.warn(`[K8sWorkspaceInit] Worktree retry threw: ${formatError(err)}`);
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

  const fallback: K8sWorkspaceResult = { worktreePath: CONTAINER_WORKSPACE_PATH, branch: null };

  // Step 1: Clone if needed
  const cloned = await isWorkspaceCloned(sandbox);
  if (!cloned) {
    const cloneOk = await cloneRepository(sandbox, token, owner, repo, baseBranch);
    if (!cloneOk) {
      console.warn(`[K8sWorkspaceInit] Clone failed, falling back to ${CONTAINER_WORKSPACE_PATH}`);
      return fallback;
    }
  } else {
    console.log(`[K8sWorkspaceInit] Workspace already cloned, skipping clone`);
  }

  // Step 2: Create worktree
  const branch = existingBranch ?? `${slugify(taskTitle)}-${taskId.slice(0, 6)}`;
  const worktreePath = await createWorktree(sandbox, branch, baseBranch);

  if (!worktreePath) {
    console.warn(
      `[K8sWorkspaceInit] Worktree creation failed, falling back to ${CONTAINER_WORKSPACE_PATH}`
    );
    return { worktreePath: CONTAINER_WORKSPACE_PATH, branch: null };
  }

  return { worktreePath, branch };
}
