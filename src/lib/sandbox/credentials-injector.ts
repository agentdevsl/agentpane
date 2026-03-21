import type { SandboxError } from '../errors/sandbox-errors.js';
import { SandboxErrors } from '../errors/sandbox-errors.js';
import { errorMessage } from '../utils/error-message';
import { readCredentialsFile } from '../utils/resolve-anthropic-key.js';
import type { Result } from '../utils/result.js';
import { err, ok } from '../utils/result.js';
import type { Sandbox } from './providers/sandbox-provider.js';
import type { OAuthCredentials } from './types.js';
import { SANDBOX_DEFAULTS } from './types.js';

/**
 * Path to OAuth credentials file inside container
 */
function getContainerCredentialsPath(): string {
  return `${SANDBOX_DEFAULTS.userHome}/.claude/.credentials.json`;
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
   * Inject credentials into a sandbox
   */
  async inject(
    sandbox: Sandbox,
    credentials?: OAuthCredentials
  ): Promise<Result<void, SandboxError>> {
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

      // Write credentials file using base64 to prevent command injection
      const credentialsJson = JSON.stringify(creds, null, 2);
      const containerPath = getContainerCredentialsPath();

      // Base64 encode to safely pass through shell without injection risk
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

      // Set proper permissions (600 = owner read/write only)
      const chmodResult = await sandbox.exec('chmod', ['600', containerPath]);

      if (chmodResult.exitCode !== 0) {
        return err(
          SandboxErrors.CREDENTIALS_INJECTION_FAILED(
            `Failed to set permissions: ${chmodResult.stderr}`
          )
        );
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
   * Refresh credentials in a sandbox
   * Useful when host credentials have been updated
   */
  async refresh(sandbox: Sandbox): Promise<Result<void, SandboxError>> {
    // Simply re-inject from host
    return this.inject(sandbox);
  }
}

/**
 * Create a credentials injector
 */
export function createCredentialsInjector(): CredentialsInjector {
  return new CredentialsInjector();
}
