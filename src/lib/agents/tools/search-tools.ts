import { execFile } from 'node:child_process';
import fs from 'node:fs/promises';
import path from 'node:path';
import { promisify } from 'node:util';
import { errorMessage } from '../../utils/error-message';
import type { ToolContext, ToolResponse } from '../types.js';

const execFileAsync = promisify(execFile);

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
    // Use execFile so `pattern` is passed as a literal argv entry to find(1)
    // rather than embedded into a shell string. This prevents shell-metacharacter
    // injection through the pattern.
    const { stdout } = await execFileAsync('find', ['.', '-type', 'f', '-name', args.pattern], {
      cwd,
    });

    const files = stdout.trim().split('\n').filter(Boolean).slice(0, limit);

    return {
      content: [
        {
          type: 'text',
          text: files.length > 0 ? files.join('\n') : '(no matches)',
        },
      ],
    };
  } catch (error) {
    // find returns non-zero on permission errors etc.; surface stdout when present.
    const err = error as { stdout?: string; code?: number };
    if (err.stdout) {
      const files = err.stdout.trim().split('\n').filter(Boolean).slice(0, limit);
      return {
        content: [
          {
            type: 'text',
            text: files.length > 0 ? files.join('\n') : '(no matches)',
          },
        ],
      };
    }
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

    // Build ripgrep argv. Each user-supplied value is a separate argv entry
    // so shell metacharacters cannot be interpreted.
    const argv: string[] = ['--max-count', String(maxResults)];
    if (args.glob) {
      argv.push('--glob', args.glob);
    }
    // `--` ends option processing so a pattern or path beginning with `-`
    // cannot be reinterpreted as a flag.
    argv.push('--', args.pattern, searchPath);

    const { stdout } = await execFileAsync('rg', argv, {
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
