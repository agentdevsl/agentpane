import { eq } from 'drizzle-orm';
import { settings } from '../../db/schema';
import { isMultiTenantEnabled } from '../../server/bootstrap/server-config.js';
import type { Database } from '../../types/database.js';
import type { SandboxError } from '../errors/sandbox-errors.js';
import { SandboxErrors } from '../errors/sandbox-errors.js';
import { createLogger } from '../logging/logger.js';
import { errorMessage } from '../utils/error-message';
import { readCredentialsFile } from '../utils/resolve-anthropic-key.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { Sandbox } from './providers/sandbox-provider.js';
import type { OAuthCredentials } from './types.js';
import { SANDBOX_DEFAULTS } from './types.js';

const log = createLogger('CredentialsInjector');

/**
 * Path to OAuth credentials file inside container.
 *
 * F06-NEW-02 (P0) / arch29-W1-E: This is a single hard-coded path shared by
 * every codespace agent in shared-sandbox mode. When `MULTI_TENANT=true` is
 * set, callers MUST resolve the sandbox mode and refuse to inject in
 * shared mode — otherwise a hostile tenant agent can read this file from
 * `${userHome}/.claude/.credentials.json` and exfiltrate the global
 * Anthropic OAuth token. The gate is enforced via `assertInjectionAllowed()`
 * below when callers pass an `InjectionContext`.
 */
function getContainerCredentialsPath(): string {
  return `${SANDBOX_DEFAULTS.userHome}/.claude/.credentials.json`;
}

/**
 * Optional context for `inject()` and `refresh()`. When provided, the
 * multi-tenant gate (F06-NEW-02 / arch29-W1-E) is enforced before the
 * credentials file is written. Tests and legacy callers may omit this
 * context to preserve existing behaviour.
 */
export interface InjectionContext {
  /** Database handle used to read the `sandbox.mode` setting. */
  db: Database;
  /** Codespace ID for the sandbox being injected. Surfaced in error details. */
  codespaceId?: string;
  /** Optional env override for testing (defaults to `process.env`). */
  env?: NodeJS.ProcessEnv;
}

/**
 * F06-NEW-02 / arch29-W1-E — Multi-tenant gate for credentials injection.
 *
 * Returns an error Result when:
 *   - `MULTI_TENANT=true` is set in the environment, AND
 *   - the resolved `sandbox.mode` setting is `'shared'`.
 *
 * In shared mode the credentials file at `~/.claude/.credentials.json` is
 * a single global secret that every tenant agent in the shared container
 * could read. The full multi-tenant FS/UID isolation rebuild is L-effort
 * and tracked as a follow-up; this gate is the fail-safe.
 *
 * No-op when `MULTI_TENANT` is unset/false (default) — self-hosted
 * single-team installs see no behaviour change.
 */
async function assertInjectionAllowed(ctx: InjectionContext): Promise<Result<void, SandboxError>> {
  const env = ctx.env ?? process.env;
  if (!isMultiTenantEnabled(env)) return ok(undefined);
  let mode: 'shared' | 'per-project' = 'shared';
  try {
    const row = await ctx.db.query.settings.findFirst({
      where: eq(settings.key, 'sandbox.mode'),
    });
    if (row?.value) {
      const parsed = JSON.parse(row.value) as unknown;
      if (parsed === 'per-project') mode = 'per-project';
      else if (parsed === 'shared') mode = 'shared';
      // unrecognised values default to shared (safer)
    }
  } catch (readErr) {
    log.warn('Failed to read sandbox.mode setting (treating as shared)', {
      data: { error: readErr instanceof Error ? readErr.message : String(readErr) },
    });
  }
  if (mode === 'shared') {
    log.error(
      'Multi-tenant gate violated: shared sandbox mode forbidden for credentials injection',
      {
        data: { codespaceId: ctx.codespaceId, mode },
      }
    );
    return err(SandboxErrors.MULTI_TENANT_REQUIRES_PER_PROJECT_SANDBOX(ctx.codespaceId));
  }
  return ok(undefined);
}

/**
 * Load OAuth credentials from host filesystem using the shared credential reader.
 * Wraps readCredentialsFile() with sandbox-specific error types.
 */
export async function loadHostCredentials(): Promise<Result<OAuthCredentials, SandboxError>> {
  const credentials = await readCredentialsFile();
  if (!credentials) {
    return err(SandboxErrors.CREDENTIALS_NOT_FOUND);
  }
  return ok(credentials);
}

/**
 * Credentials injector for sandboxes
 *
 * Injects credentials into sandbox containers, enabling Claude CLI/API access
 * from within the sandbox. Credentials are written to the standard Claude
 * credentials path (~/.claude/.credentials.json) with restricted permissions (600)
 * to protect sensitive authentication tokens.
 */
export class CredentialsInjector {
  /**
   * Inject credentials into a sandbox.
   *
   * F06-NEW-02 / arch29-W1-E: when `context` is provided and
   * `MULTI_TENANT=true` is set in the environment, this method refuses to
   * inject in shared sandbox mode. Callers that don't pass `context` (test
   * code, legacy callers) keep the previous behaviour to avoid breaking
   * fixture-driven tests.
   */
  async inject(
    sandbox: Sandbox,
    credentials?: OAuthCredentials,
    context?: InjectionContext
  ): Promise<Result<void, SandboxError>> {
    // F06-NEW-02 / arch29-W1-E: enforce the multi-tenant gate before
    // writing the credentials file.
    if (context) {
      const gate = await assertInjectionAllowed(context);
      if (!gate.ok) return gate;
    }

    // Load credentials if not provided
    let creds = credentials;
    if (!creds) {
      const loaded = await loadHostCredentials();
      if (!loaded.ok) {
        return loaded;
      }
      creds = loaded.value;
    }

    try {
      // Create .claude directory
      const mkdirResult = await sandbox.exec('mkdir', [
        '-p',
        `${SANDBOX_DEFAULTS.userHome}/.claude`,
      ]);

      if (mkdirResult.exitCode !== 0) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to create .claude directory: ${mkdirResult.stderr}`
          )
        );
      }

      const credentialsJson = JSON.stringify(creds, null, 2);
      const containerPath = getContainerCredentialsPath();

      // theme-04 P1-05: Prefer out-of-band file upload (Docker putArchive,
      // K8s/Nomad cp) when the provider supports it. This keeps the token
      // out of argv / `/proc/*/cmdline` / audit logs. Providers that do not
      // implement `writeFile` fall back to the legacy base64-encoded
      // `sh -c 'echo ... | base64 -d > ...'` path; those code paths are
      // tracked as follow-up.
      if (typeof sandbox.writeFile === 'function') {
        try {
          await sandbox.writeFile(containerPath, credentialsJson, 0o600);
        } catch (writeErr) {
          return err(
            SandboxErrors.CREDENTIALS_INJECTION_FAILED(
              `Failed to write credentials via file upload: ${errorMessage(writeErr)}`
            )
          );
        }
      } else {
        // Legacy fallback for providers that do not implement `writeFile`.
        // Base64 encode to safely pass through shell without injection risk,
        // but the encoded blob is still visible in the container's argv —
        // tracked as follow-up work per theme-04 P1-05.
        const encoded = Buffer.from(credentialsJson).toString('base64');
        const writeResult = await sandbox.exec('sh', [
          '-c',
          `echo "${encoded}" | base64 -d > ${containerPath}`,
        ]);

        if (writeResult.exitCode !== 0) {
          return err(
            SandboxErrors.CREDENTIALS_INJECTION_FAILED(
              `Failed to write credentials: ${writeResult.stderr}`
            )
          );
        }

        // Set proper permissions (600 = owner read/write only). writeFile()
        // sets mode atomically via the tar entry; only needed on fallback.
        const chmodResult = await sandbox.exec('chmod', ['600', containerPath]);

        if (chmodResult.exitCode !== 0) {
          return err(
            SandboxErrors.CREDENTIALS_INJECTION_FAILED(
              `Failed to set permissions: ${chmodResult.stderr}`
            )
          );
        }
      }

      // Verify the file was created
      const verifyResult = await sandbox.exec('test', ['-f', containerPath]);

      if (verifyResult.exitCode !== 0) {
        return err(SandboxErrors.CREDENTIALS_INJECTION_FAILED('Credentials file was not created'));
      }

      return ok(undefined);
    } catch (error) {
      const message = errorMessage(error);
      return err(SandboxErrors.CREDENTIALS_INJECTION_FAILED(message));
    }
  }

  /**
   * Remove credentials from a sandbox
   */
  async remove(sandbox: Sandbox): Promise<Result<void, SandboxError>> {
    try {
      const containerPath = getContainerCredentialsPath();

      // Remove credentials file
      await sandbox.exec('rm', ['-f', containerPath]);

      return ok(undefined);
    } catch (error) {
      const message = errorMessage(error);
      return err(SandboxErrors.CREDENTIALS_INJECTION_FAILED(message));
    }
  }

  /**
   * Check if credentials exist in a sandbox
   *
   * Note: Returns false on any error (container issues, exec failures).
   * This is intentional - we treat errors as "credentials not confirmed to exist".
   */
  async exists(sandbox: Sandbox): Promise<boolean> {
    try {
      const containerPath = getContainerCredentialsPath();
      const result = await sandbox.exec('test', ['-f', containerPath]);
      return result.exitCode === 0;
    } catch (_error) {
      // Log unexpected errors for debugging but return false
      // This is intentional - errors mean we can't confirm credentials exist
      return false;
    }
  }

  /**
   * Refresh credentials in a sandbox.
   * Useful when host credentials have been updated.
   *
   * F06-NEW-02 / arch29-W1-E: forwards the optional injection context so
   * the multi-tenant gate fires on refresh as well as initial injection.
   */
  async refresh(sandbox: Sandbox, context?: InjectionContext): Promise<Result<void, SandboxError>> {
    // Simply re-inject from host
    return this.inject(sandbox, undefined, context);
  }
}

/**
 * Create a credentials injector
 */
export function createCredentialsInjector(): CredentialsInjector {
  return new CredentialsInjector();
}
