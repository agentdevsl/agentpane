/**
 * WorktreeInitService - Worktree creation, path translation, and remote workspace initialization.
 *
 * Responsibilities:
 * - Create isolated git worktrees for planning/execution
 * - Translate host filesystem paths to container paths
 * - Initialize remote workspaces (clone + worktree) in K8s/Nomad pods
 * - Recover existing worktrees for execution phase
 */

import { eq } from 'drizzle-orm';

import { codespaces, tasks } from '../../db/schema';
import { CONTAINER_WORKSPACE_PATH } from '../../lib/constants/sandbox.js';
import { createLogger } from '../../lib/logging/logger.js';
import { deriveGitHubFromPath, resolveGitToken } from '../../lib/sandbox/git-token-resolver.js';
import type { SandboxExec } from '../../lib/sandbox/k8s-workspace-initializer.js';
import { initializeK8sWorkspace as initializeRemoteWorkspaceInPod } from '../../lib/sandbox/k8s-workspace-initializer.js';
import type { AgentPhase, ContainerAgentDeps } from './types.js';

const log = createLogger('WorktreeInitService');

export class WorktreeInitService {
  constructor(private deps: ContainerAgentDeps) {}

  /**
   * Translate a host filesystem path to the corresponding container path.
   * The container bind-mounts the codespace root at /workspace, so we replace
   * the host codespace path prefix with /workspace.
   */
  translatePathForContainer(hostWorktreePath: string, hostProjectPath: string): string {
    if (hostWorktreePath.startsWith(hostProjectPath)) {
      return `${CONTAINER_WORKSPACE_PATH}${hostWorktreePath.slice(hostProjectPath.length)}`;
    }
    log.info('Path mismatch, defaulting to container workspace', {
      data: { hostWorktreePath, hostProjectPath },
    });
    return CONTAINER_WORKSPACE_PATH;
  }

  /**
   * Initialize workspace inside a remote sandbox (K8s pod or Nomad allocation)
   * by cloning the repo and creating a worktree.
   * Falls back to empty /workspace on any failure (non-fatal).
   */
  async initializeRemoteWorkspace(params: {
    sandbox: SandboxExec;
    codespace: {
      githubOwner: string | null;
      githubRepo: string | null;
      githubInstallationId: string | null;
      name: string;
      path: string | null;
      id: string;
      config?: { defaultBranch?: string } | null;
    };
    task: { title: string; branch?: string | null };
    taskId: string;
    sessionId: string;
    phase: AgentPhase;
  }): Promise<{ worktreePath: string; branch: string } | null> {
    const { sandbox, codespace, task, taskId, sessionId, phase } = params;
    const { db, streams, githubTokenService } = this.deps;

    // Auto-derive owner/repo from git remote when not explicitly configured
    let { githubOwner, githubRepo } = codespace;
    if ((!githubOwner || !githubRepo) && codespace.path) {
      const derived = deriveGitHubFromPath(codespace.path);
      if (derived) {
        githubOwner = derived.owner;
        githubRepo = derived.repo;
        log.info('Derived GitHub owner/repo from git remote', {
          data: { taskId, owner: derived.owner, repo: derived.repo, codespacePath: codespace.path },
        });
        // Backfill the DB so future calls skip derivation
        try {
          await db
            .update(codespaces)
            .set({
              githubOwner: derived.owner,
              githubRepo: derived.repo,
            })
            .where(eq(codespaces.id, codespace.id));
          log.info('Backfilled GitHub config to codespace', {
            data: { codespaceId: codespace.id, owner: derived.owner, repo: derived.repo },
          });
        } catch (dbErr) {
          const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
          log.info('Failed to backfill GitHub config (non-critical)', {
            data: { codespaceId: codespace.id, error: msg },
          });
        }
      }
    }

    if (!githubOwner || !githubRepo) {
      log.info('Codespace has no GitHub config and no git remote, using empty workspace', {
        data: { taskId },
      });
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content:
          "No GitHub repository configured for this codespace. The agent will work without git isolation — changes cannot be pushed or PR'd.",
      });
      return null;
    }

    // For execution phase, check if worktree from planning still exists in pod
    if (phase === 'execute' && task.branch) {
      const worktreePath = `${CONTAINER_WORKSPACE_PATH}/.worktrees/${task.branch}`;
      try {
        const testResult = await sandbox.exec('test', ['-d', worktreePath]);
        if (testResult.exitCode === 0) {
          log.info('Reusing existing worktree from planning phase', {
            data: { taskId, branch: task.branch, worktreePath },
          });
          return { worktreePath, branch: task.branch };
        }
        log.info('Planning worktree not found in pod, re-cloning', {
          data: { taskId, branch: task.branch },
        });
      } catch (checkErr) {
        log.warn('Failed to check existing worktree, proceeding to full clone', {
          data: { taskId, branch: task.branch },
          error: checkErr,
        });
      }
    }

    // Resolve git token
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'creating_sandbox',
      message: 'Resolving git credentials...',
    });

    const tokenResult = await resolveGitToken(
      { ...codespace, githubOwner, githubRepo },
      { db, githubTokenService }
    );

    if (!tokenResult) {
      log.warn('No git token available, using empty workspace', { data: { taskId } });
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: 'No GitHub credentials available -- agent will work in empty workspace',
      });
      return null;
    }

    // Clone + create worktree
    await streams.publish(sessionId, 'container-agent:status', {
      taskId,
      sessionId,
      stage: 'creating_sandbox',
      message: 'Cloning repository...',
    });
    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Cloning ${tokenResult.owner}/${tokenResult.repo} into K8s pod...`,
    });

    const baseBranch =
      (codespace.config as { defaultBranch?: string } | null)?.defaultBranch ?? 'main';
    const result = await initializeRemoteWorkspaceInPod({
      sandbox,
      gitToken: tokenResult,
      taskTitle: task.title,
      taskId,
      baseBranch,
      existingBranch: task.branch ?? undefined,
    });

    if (!result.branch) {
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content:
          "Workspace initialization failed: repository clone or worktree creation failed. The agent will work without git isolation — changes cannot be pushed or PR'd.",
      });
      return null;
    }

    // Save branch to task for recovery on pod recycle
    try {
      await db
        .update(tasks)
        .set({
          branch: result.branch,
        })
        .where(eq(tasks.id, taskId));
    } catch (dbErr) {
      const msg = dbErr instanceof Error ? dbErr.message : String(dbErr);
      log.warn(
        'Failed to save branch to task -- pod recycle recovery will not work for this task',
        { data: { taskId, branch: result.branch, error: msg } }
      );
    }

    await streams.publish(sessionId, 'container-agent:message', {
      taskId,
      sessionId,
      role: 'system',
      content: `Workspace ready: branch "${result.branch}" at ${result.worktreePath}`,
    });

    return { worktreePath: result.worktreePath, branch: result.branch };
  }

  /**
   * Resolve the worktree path for the agent, creating a new one
   * for planning or recovering an existing one for execution.
   */
  async resolveWorktree(params: {
    phase: AgentPhase;
    taskId: string;
    sessionId: string;
    codespaceId: string;
    codespace: { path: string; name: string };
    task: { title: string; worktreeId: string | null };
    agentId: string;
    sandbox: { id: string };
  }): Promise<{ worktreeId?: string; worktreePath: string }> {
    const { phase, taskId, sessionId, codespaceId, codespace, task, agentId } = params;
    const { db, streams, worktreeService } = this.deps;
    let worktreeId: string | undefined;
    let worktreePath = CONTAINER_WORKSPACE_PATH;

    if (worktreeService && phase === 'execute' && task.worktreeId) {
      try {
        const wts = await worktreeService.getStatus(task.worktreeId);
        if (wts.ok) {
          worktreeId = wts.value.id;
          worktreePath = this.translatePathForContainer(wts.value.path, codespace.path);
          log.info('Recovered worktree for execution', {
            data: {
              worktreeId,
              branch: wts.value.branch,
              hostPath: wts.value.path,
              containerPath: worktreePath,
            },
          });
        } else {
          log.info('Failed to recover worktree, using main workspace', {
            data: { taskId, worktreeId: task.worktreeId, error: String(wts.error) },
          });
        }
      } catch (wtErr) {
        const msg = wtErr instanceof Error ? wtErr.message : String(wtErr);
        log.info('Error recovering worktree, using main workspace', {
          data: { taskId, error: msg },
        });
      }
    }

    if (worktreeService && phase === 'plan') {
      await streams.publish(sessionId, 'container-agent:status', {
        taskId,
        sessionId,
        stage: 'creating_sandbox',
        message: 'Creating worktree...',
      });
      await streams.publish(sessionId, 'container-agent:message', {
        taskId,
        sessionId,
        role: 'system',
        content: `Creating isolated git worktree for task "${task.title}"...`,
      });

      const publishFallback = async (error: unknown): Promise<void> => {
        const errorMsg = error instanceof Error ? error.message : String(error);
        log.warn('Worktree creation failed, continuing without isolation', {
          data: { taskId, error: errorMsg },
        });
        await streams.publish(sessionId, 'container-agent:message', {
          taskId,
          sessionId,
          role: 'system',
          content: 'Could not create worktree -- agent will work in main workspace',
        });
        await streams.publish(sessionId, 'container-agent:status', {
          taskId,
          sessionId,
          stage: 'creating_sandbox',
          message: 'Worktree creation failed -- falling back to main workspace',
        });
      };

      try {
        const worktreeResult = await worktreeService.create(
          {
            codespaceId,
            agentId,
            taskId,
            taskTitle: task.title,
          },
          {
            skipEnvCopy: true,
            skipDepsInstall: true,
            skipInitScript: true,
          }
        );

        if (worktreeResult.ok) {
          worktreeId = worktreeResult.value.id;
          worktreePath = this.translatePathForContainer(worktreeResult.value.path, codespace.path);
          log.info('Worktree created', {
            data: {
              worktreeId,
              branch: worktreeResult.value.branch,
              hostPath: worktreeResult.value.path,
              containerPath: worktreePath,
            },
          });

          try {
            await db
              .update(tasks)
              .set({
                worktreeId,
                branch: worktreeResult.value.branch,
              })
              .where(eq(tasks.id, taskId));
          } catch (dbErr) {
            const eMsg = dbErr instanceof Error ? dbErr.message : String(dbErr);
            log.info('Failed to link worktree to task (non-critical)', {
              data: { taskId, worktreeId, error: eMsg },
            });
          }

          await streams.publish(sessionId, 'container-agent:worktree', {
            taskId,
            sessionId,
            worktreeId,
            branch: worktreeResult.value.branch,
            containerPath: worktreePath,
          });

          await streams.publish(sessionId, 'container-agent:message', {
            taskId,
            sessionId,
            role: 'system',
            content: `Worktree created: branch "${worktreeResult.value.branch}"`,
          });
        } else {
          await publishFallback(worktreeResult.error);
        }
      } catch (wtErr) {
        await publishFallback(wtErr);
      }
    }

    return { worktreeId, worktreePath };
  }

  /**
   * Clean up a worktree by removing it via WorktreeService.
   * Best-effort: logs errors but does not throw.
   */
  async cleanupWorktree(taskId: string, worktreeId: string): Promise<void> {
    const { worktreeService } = this.deps;
    if (!worktreeService) {
      log.info('WorktreeService not available, skipping cleanup', {
        data: { taskId, worktreeId },
      });
      return;
    }

    try {
      const result = await worktreeService.remove(worktreeId, true);
      if (result.ok) {
        log.info('Worktree removed', { data: { taskId, worktreeId } });
      } else {
        // Treat NOT_FOUND as success -- worktree is already gone (Gap 7)
        const errorCode = (result.error as { code?: string })?.code;
        if (errorCode === 'WORKTREE_NOT_FOUND') {
          log.info('Worktree already removed (not found)', { data: { taskId, worktreeId } });
        } else {
          log.info('Worktree removal returned error', {
            data: { taskId, worktreeId, error: String(result.error) },
          });
        }
      }
    } catch (removeErr) {
      log.info('Failed to remove worktree', {
        data: {
          taskId,
          worktreeId,
          error: removeErr instanceof Error ? removeErr.message : String(removeErr),
        },
      });
    }
  }
}
