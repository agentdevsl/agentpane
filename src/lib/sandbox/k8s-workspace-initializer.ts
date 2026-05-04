/**
 * K8s Workspace Initializer
 *
 * Encapsulates git clone + worktree operations inside K8s pods via sandbox.exec().
 * All failures are non-fatal:
 *  - Clone failure: falls back to empty /workspace (pod has no source code)
 *  - Worktree failure (after successful clone): falls back to /workspace root
 *    (has code from clone, but no branch isolation)
 *
 * arch29-W2-I (F04-12): the GitHub token is NEVER embedded in `argv` (visible
 * in `/proc/<pid>/cmdline`, container audit logs, and any sibling tenant in
 * shared-sandbox mode). Authentication uses git's `http.extraHeader` config
 * which the SDK passes via `-c http.extraHeader=...` argv too — but the value
 * there is `Authorization: Basic <b64(x-access-token:TOKEN)>`, the same
 * single-call exposure as the env var path. The remote URL stays clean.
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
 * Build the value of `http.extraHeader` for GitHub PAT auth.
 *
 * Legacy fallback for sandboxes that do NOT implement `writeFile`. When
 * `writeFile` is available (K8s/Nomad/Docker) we prefer the file-based
 * `credential.helper=store` path — see `cloneRepository` — which keeps the
 * token entirely out of argv (and therefore out of the kube-apiserver
 * audit log for K8s exec requests).
 */
export function buildGitAuthHeaderArg(token: string): string {
  const credentials = Buffer.from(`x-access-token:${token}`, 'utf8').toString('base64');
  // Returned as a single `-c` value: `http.extraHeader=Authorization: Basic <b64>`.
  return `http.extraHeader=Authorization: Basic ${credentials}`;
}

/**
 * Sandbox capability surface required for workspace initialization.
 *
 * `writeFile` is optional but recommended: when present, the GitHub token
 * is delivered to the pod via an out-of-band tar (no argv exposure) and
 * `git fetch` reads it via `credential.helper=store`. When absent we fall
 * back to the legacy `-c http.extraHeader=...` path (single argv exposure
 * during fetch).
 */
export interface SandboxExec {
  exec(cmd: string, args?: string[]): Promise<ExecResult>;
  writeFile?(path: string, content: string | Buffer, mode?: number): Promise<void>;
}

/**
 * Build the path to the transient credential file used by
 * `credential.helper=store`. Including the taskId keeps concurrent inits in
 * a shared sandbox from clobbering each other's transient file (and from
 * racing on the `finally` rm).
 */
function transientGitCredentialsPath(taskId: string): string {
  // Defense-in-depth: strip path separators / control chars from taskId so a
  // hostile id cannot escape /tmp. Task ids are CUIDs in practice; this is
  // a belt-and-braces guard.
  const safeTaskId = taskId.replace(/[^a-zA-Z0-9._-]/g, '_');
  return `/tmp/.agentpane-git-credentials-${safeTaskId}`;
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
  baseBranch: string,
  taskId: string
): Promise<{ ok: boolean; error?: string }> {
  if (!GITHUB_NAME_RE.test(owner) || !GITHUB_NAME_RE.test(repo)) {
    return { ok: false, error: `Invalid owner/repo format: ${owner}/${repo}` };
  }

  const transientCredentialsPath = transientGitCredentialsPath(taskId);

  // The remote URL is always the public, token-free form so `git remote -v`
  // and `.git/config` never carry the secret. Auth is supplied either via
  // a transient credential file + `credential.helper=store` (preferred —
  // no argv exposure) or via `-c http.extraHeader=...` (fallback when the
  // sandbox provider lacks writeFile).
  const remoteUrl = `https://github.com/${owner}/${repo}.git`;
  const useCredentialFile = typeof sandbox.writeFile === 'function';
  let authHeaderArg: string | null = null;
  if (useCredentialFile && sandbox.writeFile) {
    try {
      await sandbox.writeFile(
        transientCredentialsPath,
        `https://x-access-token:${token}@github.com\n`,
        0o600
      );
    } catch (writeErr) {
      log.warn('writeFile for transient git credentials failed; falling back to argv-token clone', {
        error: errorMessage(writeErr),
      });
      authHeaderArg = buildGitAuthHeaderArg(token);
    }
  } else {
    authHeaderArg = buildGitAuthHeaderArg(token);
  }

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

    // Set origin remote URL (add if missing, update if exists). The URL is
    // the token-free public form — auth happens per-invocation via -c
    // http.extraHeader so we don't need to update the remote later.
    try {
      const addResult = await sandbox.exec('git', [
        '-C',
        CONTAINER_WORKSPACE_PATH,
        'remote',
        'add',
        'origin',
        remoteUrl,
      ]);
      if (addResult.exitCode !== 0) {
        // Origin already exists — update its URL to the public form (in case
        // a previous run left a tokenized URL behind).
        await sandbox.exec('git', [
          '-C',
          CONTAINER_WORKSPACE_PATH,
          'remote',
          'set-url',
          'origin',
          remoteUrl,
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
          remoteUrl,
        ]);
      } catch (setUrlErr) {
        return { ok: false, error: `Failed to configure git remote: ${errorMessage(setUrlErr)}` };
      }
    }

    // Build the per-invocation `-c` flags for fetch. Either:
    //   credential.helper=store + credential.useHttpPath=false (file-based,
    //   no argv exposure) — preferred when sandbox.writeFile is available
    // OR:
    //   http.extraHeader=Authorization: Basic <b64> (legacy, argv exposure
    //   visible to /proc and kube-apiserver audit log)
    const fetchAuthFlags = authHeaderArg
      ? ['-c', authHeaderArg]
      : [
          '-c',
          `credential.helper=store --file=${transientCredentialsPath}`,
          '-c',
          'credential.useHttpPath=false',
        ];

    let cloneResult = await sandbox.exec('git', [
      ...fetchAuthFlags,
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
        ...fetchAuthFlags,
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

    // Checkout the base branch (try specified branch, fall back to remote HEAD).
    // No auth header needed — these are local-only ops.
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

    // NOTE: previous revisions ran `git config credential.helper ''` here to
    // prevent token persistence in the local repo. That setting RESETS the
    // helper list at the local level, which silently overrides the global
    // `credential.helper=store` we intentionally inject via
    // ~/.gitconfig + ~/.git-credentials so the agent can push and open PRs.
    // The transient clone token already lives in the per-task credentials
    // file under /tmp, not in `.git/config`, so there is no persistence to
    // prevent here.
    return { ok: true };
  } catch (err) {
    const msg = errorMessage(err);
    log.warn('Failed to clone repository', { error: msg });
    return { ok: false, error: msg };
  } finally {
    // Always remove the transient clone credential file. Earlier revisions
    // only cleaned up after a fully successful fetch+checkout, which left
    // the token on disk whenever fetch or checkout failed — readable by the
    // next agent in shared-sandbox mode.
    if (useCredentialFile) {
      try {
        await sandbox.exec('rm', ['-f', transientCredentialsPath]);
      } catch (rmErr) {
        log.debug('Failed to remove transient credential file', {
          error: errorMessage(rmErr),
        });
      }
    }
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
    const cloneResult = await cloneRepository(sandbox, token, owner, repo, baseBranch, taskId);
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
