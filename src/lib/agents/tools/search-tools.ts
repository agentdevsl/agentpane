import { exec } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../../utils/error-message';
import type { ToolContext, ToolResponse } from '../types.js';

const execAsync = promisify(exec);

export interface GlobArgs {
  pattern: string;
  cwd?: string;
  limit?: number;
}

export interface GrepArgs {
  pattern: string;
  path: string;
  glob?: string;
  max_results?: number;
}

export async function globTool(args: GlobArgs, context: ToolContext): Promise<ToolResponse> {
  const cwd = args.cwd ?? context.cwd;
  const limit = args.limit ?? 100;

  try {
    // Use find command with glob pattern for cross-platform compatibility
    const { stdout } = await execAsync(
      `find . -type f -name "${args.pattern}" 2>/dev/null | head -n ${limit}`,
      { cwd }
    );

    const files = stdout.trim().split('\n').filter(Boolean);

    return {
      content: [
        {
          type: 'text',
          text: files.length > 0 ? files.join('\n') : '(no matches)',
        },
      ],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Glob failed: ${errorMessage(error)}`,
        },
      ],
      is_error: true,
    };
  }
}

export async function grepTool(args: GrepArgs, context: ToolContext): Promise<ToolResponse> {
  const maxResults = args.max_results ?? 50;
  const searchPath = path.isAbsolute(args.path) ? args.path : path.join(context.cwd, args.path);

  try {
    // Check if path exists
    await fs.access(searchPath);

    // Build ripgrep command
    let cmd = `rg "${args.pattern}" --max-count ${maxResults}`;

    if (args.glob) {
      cmd += ` --glob "${args.glob}"`;
    }

    cmd += ` "${searchPath}"`;

    const { stdout } = await execAsync(cmd, {
      cwd: context.cwd,
      timeout: 60000,
    });

    return {
      content: [
        {
          type: 'text',
          text: stdout || '(no matches)',
        },
      ],
    };
  } catch (error) {
    // ripgrep returns exit code 1 when no matches found, which is not an error
    const err = error as { code?: number; stdout?: string };
    if (err.code === 1 && !err.stdout) {
      return {
        content: [{ type: 'text', text: '(no matches)' }],
      };
    }

    return {
      content: [
        {
          type: 'text',
          text: `Grep failed: ${errorMessage(error)}`,
        },
      ],
      is_error: true,
    };
  }
}
