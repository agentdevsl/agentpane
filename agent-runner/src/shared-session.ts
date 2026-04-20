/**
 * SC-023: Shared logic extracted from index.ts and agentcore-handler.ts.
 *
 * Both the Docker agent-runner (index.ts) and the AgentCore handler
 * (agentcore-handler.ts) duplicate the following concerns:
 *   - OAuth credential file writing
 *   - Stop-file checking for cancellation
 *   - Assistant text extraction from SDK messages
 *   - File-change detection from tool calls
 *   - ExitPlanMode type definitions
 *
 * This module provides shared implementations to eliminate that duplication.
 */
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import type { AgentFileChangedData } from './event-emitter.js';

// ---------------------------------------------------------------------------
// OAuth credential writing
// ---------------------------------------------------------------------------

/**
 * Far-future sentinel (~year 5138) used when the host does not supply a real
 * OAuth token expiry. theme-03 F11: the previous 24h fiction caused revoked
 * tokens to appear valid to the SDK for up to a day.
 */
const OAUTH_EXPIRES_AT_SENTINEL = 100_000_000_000_000;

/**
 * Options accepted by `writeCredentialsFile`. All fields except `oauthToken`
 * are optional; when absent a safe default is substituted.
 */
export interface WriteCredentialsOptions {
  /** Real OAuth token expiry (ms since epoch). Defaults to a far-future sentinel. */
  expiresAt?: number;
  /** OAuth refresh token from the host. Defaults to null (SDK rejects empty string). */
  refreshToken?: string | null;
}

/**
 * Write OAuth credentials to `$HOME/.claude/.credentials.json`.
 * The Claude Agent SDK reads this file for authentication.
 * OAuth tokens passed via ANTHROPIC_API_KEY env var are blocked by the API.
 *
 * SC-014: The credentials file is written with mode 0o600 (owner-read-only)
 * to mitigate token exposure risk on shared filesystems.
 *
 * theme-03 F11: `expiresAt` and `refreshToken` are now threaded through from
 * the host when available. `homedir()` (which reads `process.env.HOME`) is
 * used so the host can place each concurrent agent-runner invocation under a
 * distinct HOME and avoid interleaved writes to a shared credentials file.
 */
export async function writeCredentialsFile(
  oauthToken: string,
  options: WriteCredentialsOptions = {}
): Promise<void> {
  const home = homedir();
  const claudeDir = join(home, '.claude');
  const credentialsFile = join(claudeDir, '.credentials.json');

  if (!oauthToken) {
    throw new Error('No OAuth token provided');
  }

  const credentials = {
    claudeAiOauth: {
      accessToken: oauthToken,
      refreshToken: options.refreshToken ?? null,
      expiresAt: options.expiresAt ?? OAUTH_EXPIRES_AT_SENTINEL,
      scopes: ['user:inference', 'user:profile', 'user:sessions:claude_code'],
      subscriptionType: 'max',
    },
  };

  await mkdir(claudeDir, { recursive: true, mode: 0o700 });
  await writeFile(credentialsFile, JSON.stringify(credentials), { mode: 0o600 });

  // Verify the file is readable and valid JSON
  const written = await readFile(credentialsFile, 'utf-8');
  const parsed = JSON.parse(written) as { claudeAiOauth?: { accessToken?: string } };
  if (!parsed.claudeAiOauth?.accessToken) {
    throw new Error('Credentials file written but accessToken missing');
  }

  console.error(`[shared-session] Credentials file written to ${credentialsFile}`);
}

// ---------------------------------------------------------------------------
// Stop-file checking
// ---------------------------------------------------------------------------

/**
 * Check if the agent should stop (sentinel file exists).
 */
export async function shouldStop(stopFile: string | undefined): Promise<boolean> {
  if (!stopFile) return false;
  try {
    await access(stopFile);
    return true;
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return false;
    }
    // Permission errors or other filesystem failures mean we can't reliably
    // check for cancellation — stop the agent to avoid uncontrolled execution.
    console.error(`[shared-session] Error checking stop file: ${(err as Error).message}`);
    return true;
  }
}

// ---------------------------------------------------------------------------
// Assistant text extraction
// ---------------------------------------------------------------------------

/**
 * Extract text content from an assistant message returned by the SDK.
 */
export function getAssistantText(msg: unknown): string | null {
  const message = (msg as { message?: unknown }).message as {
    content?: Array<{ type: string; text?: string }>;
  };

  if (!message?.content) return null;

  const textBlocks = message.content.filter(
    (block): block is { type: 'text'; text: string } =>
      block.type === 'text' && typeof block.text === 'string'
  );

  return textBlocks.map((b) => b.text).join('') || null;
}

// ---------------------------------------------------------------------------
// File-change detection
// ---------------------------------------------------------------------------

/** File-modifying tool names and how to extract the path from their input */
export const FILE_MODIFY_TOOLS: Record<
  string,
  { pathKey: string; action: (input: Record<string, unknown>) => AgentFileChangedData['action'] }
> = {
  Write: { pathKey: 'file_path', action: () => 'create' },
  Edit: { pathKey: 'file_path', action: () => 'modify' },
  NotebookEdit: { pathKey: 'notebook_path', action: () => 'modify' },
};

/** Extract file change info from a tool call, if applicable */
export function extractFileChange(
  toolName: string,
  input: Record<string, unknown>
): AgentFileChangedData | null {
  const spec = FILE_MODIFY_TOOLS[toolName];
  if (!spec) return null;
  const filePath = input[spec.pathKey];
  if (typeof filePath !== 'string' || !filePath) return null;
  return {
    path: filePath,
    action: spec.action(input),
    toolName,
  };
}

// ---------------------------------------------------------------------------
// ExitPlanMode types
// ---------------------------------------------------------------------------

/** ExitPlanMode options captured from the tool call. */
export interface ExitPlanModeOptions {
  allowedPrompts?: Array<{ tool: 'Bash'; prompt: string }>;
  remoteSessionId?: string;
  remoteSessionUrl?: string;
  remoteSessionTitle?: string;
}

/** Typed input from ExitPlanMode tool call, extending options with plan content. */
export interface ExitPlanModeInput extends ExitPlanModeOptions {
  plan?: string;
}
