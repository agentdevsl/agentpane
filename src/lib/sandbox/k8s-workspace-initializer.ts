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

/** Strip credentials from a string to prevent token leakage in logs. */
function sanitizeCredentials(str: string): string {
  return str.replace(/x-access-token:[^@]+@/g, 'x-access-token:[REDACTED]@');
}

// Re-export for potential future use
void sanitizeCredentials;

/** Validate that a string is a valid GitHub owner or repo name. */
const GITHUB_NAME_RE = /^[a-zA-Z0-9._-]+$/;

/**
 * Check if the workspace has been cloned (i.e. /workspace/.git exists).
 */
async function isWorkspaceCloned(sandbox: SandboxExec): Promise<boolean> {
  try {
    const result = await sandbox.exec('test', ['-d', `${CONTAINER_WORKSPACE_PATH}/.git`]);
    return result.exitCode === 0;
  } catch (_err) {
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
    return false;
  }

  // Token is embedded in the clone URL for simplicity (git credential helpers
  // may not be available in the pod). We strip it from the remote immediately
  // after clone to prevent credential leakage via `git remote -v` or logs.
  const cloneUrl = `https://x-access-token:${token}@github.com/${owner}/${repo}.git`;

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
    }
    return true;
  } catch (_err) {
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
      return worktreePath;
    }
  } catch (_err) {}

  // Ensure the worktrees parent directory exists
  try {
    await sandbox.exec('mkdir', ['-p', WORKTREES_DIR]);
  } catch (_err) {
    return null;
  }

  // Try creating worktree with a new branch (-b), then retry without -b if branch already exists
  try {
    const result = await tryWorktreeAdd(sandbox, worktreePath, branch, baseBranch);
    if (result.exitCode === 0) {
      return worktreePath;
    }
  } catch (_err) {}

  // Retry without -b (branch already exists from a prior planning phase, or existingBranch was provided)
  try {
    const retryResult = await tryWorktreeAdd(sandbox, worktreePath, branch);
    if (retryResult.exitCode === 0) {
      return worktreePath;
    }
    return null;
  } catch (_err) {
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
      return fallback;
    }
  } else {
  }

  // Step 2: Create worktree
  const branch = existingBranch ?? `${slugify(taskTitle)}-${taskId.slice(0, 6)}`;
  const worktreePath = await createWorktree(sandbox, branch, baseBranch);

  if (!worktreePath) {
    return { worktreePath: CONTAINER_WORKSPACE_PATH, branch: null };
  }

  return { worktreePath, branch };
}
