/**
 * GitHub credentials injector for sandboxes.
 *
 * Mirrors the Anthropic OAuth credential pattern in `credentials-injector.ts`:
 * the GitHub token is written to disk inside the sandbox via
 * `sandbox.writeFile()` (out-of-band tar upload — Docker `putArchive`,
 * K8s/Nomad cp). The token never appears in argv (`/proc/<pid>/cmdline`,
 * `ps`, audit logs) and never lands in the container env (`/proc/<pid>/environ`,
 * `printenv`, crash dumps). Providers that do not implement `writeFile` are
 * fail-closed — we refuse to fall through to a `sh -c 'echo $TOKEN > file'`
 * path because that re-introduces argv exposure.
 *
 * Two artifacts are written, both mode 0600:
 *
 *   ~/.git-credentials   →  https://x-access-token:<TOKEN>@github.com
 *                           Used by `git` when `credential.helper=store` is
 *                           set on the global gitconfig.
 *
 *   ~/.config/gh/hosts.yml →  GitHub CLI auth config so `gh pr create`,
 *                              `gh issue …`, etc. authenticate as the
 *                              token's principal.
 *
 * The matching gitconfig snippet (`[credential] helper=store`) is appended
 * idempotently so git uses the credentials file. We do NOT modify
 * `user.name` / `user.email` here — those are baked into the sandbox image
 * (`docker/Dockerfile.agent-sandbox`) so commits authored by the agent are
 * always attributed to the same principal.
 */

import type { SandboxError } from '../errors/sandbox-errors.js';
import { SandboxErrors } from '../errors/sandbox-errors.js';
import { createLogger } from '../logging/logger.js';
import { errorMessage } from '../utils/error-message.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { Sandbox } from './providers/sandbox-provider.js';
import { SANDBOX_DEFAULTS } from './types.js';

const log = createLogger('GitHubCredentialsInjector');

const GIT_CREDENTIALS_FILENAME = '.git-credentials';
const GH_CONFIG_DIR = '.config/gh';
const GH_HOSTS_FILENAME = 'hosts.yml';

export interface GitHubInjectionInput {
  /** GitHub token (PAT, OAuth, or App installation token). */
  readonly token: string;
  /**
   * Login the token authenticates as. Used by `gh` to populate
   * `hosts.yml`'s `user:` field. When unknown (e.g. App installation tokens
   * that authenticate as a bot), pass `'x-access-token'` — `gh` accepts the
   * generic principal and `git` does not care.
   */
  readonly githubLogin?: string;
}

function gitCredentialsPath(): string {
  return `${SANDBOX_DEFAULTS.userHome}/${GIT_CREDENTIALS_FILENAME}`;
}

function ghHostsPath(): string {
  return `${SANDBOX_DEFAULTS.userHome}/${GH_CONFIG_DIR}/${GH_HOSTS_FILENAME}`;
}

/**
 * Build the contents of `~/.git-credentials`. Format is one URL per line,
 * with the token embedded as the password. Git matches by host so a
 * single line covers all repos under github.com.
 */
function buildGitCredentialsFile(token: string): string {
  // x-access-token is the canonical username for both PATs and App
  // installation tokens — GitHub ignores it but the credential helper
  // requires *some* username component.
  return `https://x-access-token:${token}@github.com\n`;
}

/**
 * Build the contents of `~/.config/gh/hosts.yml`. The schema is taken from
 * `gh auth login`'s output — `gh` reads this file when no env var is set.
 */
function buildGhHostsFile(token: string, login: string): string {
  return [
    'github.com:',
    `    oauth_token: ${token}`,
    `    user: ${login}`,
    '    git_protocol: https',
    '',
  ].join('\n');
}

export class GitHubCredentialsInjector {
  /**
   * Write GitHub credentials into the sandbox. Fails closed if the provider
   * does not implement `writeFile` — we refuse to put the token in argv via
   * a shell-exec fallback (theme-04 P1-05 / arch29-W2-I parity).
   */
  async inject(sandbox: Sandbox, input: GitHubInjectionInput): Promise<Result<void, SandboxError>> {
    if (typeof sandbox.writeFile !== 'function') {
      return err(
        SandboxErrors.CREDENTIALS_INJECTION_FAILED(
          'Sandbox provider does not implement writeFile — refusing to inject GitHub credentials via shell exec (would leak token via argv).'
        )
      );
    }

    const login = input.githubLogin?.trim() || 'x-access-token';

    try {
      // Ensure ~/.config/gh exists before writeFile lands files in it.
      // mkdir -p is idempotent and arguments are fixed (no user data).
      // -m 700 forces restrictive permissions even when the sandbox umask
      // is permissive, since this directory holds the gh oauth_token.
      const mkdirResult = await sandbox.exec('mkdir', [
        '-m',
        '700',
        '-p',
        `${SANDBOX_DEFAULTS.userHome}/${GH_CONFIG_DIR}`,
      ]);
      if (mkdirResult.exitCode !== 0) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to create ~/.config/gh: ${mkdirResult.stderr}`
          )
        );
      }

      // ~/.git-credentials — the actual token, mode 600
      try {
        await sandbox.writeFile(gitCredentialsPath(), buildGitCredentialsFile(input.token), 0o600);
      } catch (writeErr) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to write ~/.git-credentials: ${errorMessage(writeErr)}`
          )
        );
      }

      // ~/.config/gh/hosts.yml — gh CLI auth, mode 600
      try {
        await sandbox.writeFile(ghHostsPath(), buildGhHostsFile(input.token, login), 0o600);
      } catch (writeErr) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to write ~/.config/gh/hosts.yml: ${errorMessage(writeErr)}`
          )
        );
      }

      // Set credential.helper=store via `git config --global` instead of
      // overwriting ~/.gitconfig. Idempotent — replaces the helper line and
      // preserves any existing user config (aliases, image-baked settings).
      const configResult = await sandbox.exec('git', [
        'config',
        '--global',
        'credential.helper',
        'store',
      ]);
      if (configResult.exitCode !== 0) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to configure git credential.helper: ${configResult.stderr}`
          )
        );
      }

      log.info('GitHub credentials injected', {
        data: { login, hasToken: input.token.length > 0 },
      });
      return ok(undefined);
    } catch (error) {
      return err(SandboxErrors.CREDENTIALS_INJECTION_FAILED(errorMessage(error)));
    }
  }

  /**
   * Best-effort scrub: overwrite the credential files with empty content
   * before the sandbox is reused or returned to the pool. We do not call
   * this for short-lived per-task sandboxes (the container is destroyed at
   * end of run), but shared sandboxes need it so a later tenant cannot
   * read the previous tenant's token.
   */
  async remove(sandbox: Sandbox): Promise<Result<void, SandboxError>> {
    try {
      // rm -f is idempotent; missing files exit 0.
      await sandbox.exec('rm', ['-f', gitCredentialsPath(), ghHostsPath()]);
      // Leave .gitconfig alone — the credential.helper=store line is harmless
      // without ~/.git-credentials present.
      return ok(undefined);
    } catch (error) {
      return err(SandboxErrors.CREDENTIALS_INJECTION_FAILED(errorMessage(error)));
    }
  }
}

/**
 * Factory.
 */
export function createGitHubCredentialsInjector(): GitHubCredentialsInjector {
  return new GitHubCredentialsInjector();
}
