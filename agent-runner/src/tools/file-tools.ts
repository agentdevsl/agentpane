/**
 * File operation tools for the agent-runner.
 */
import { readFile as fsReadFile, writeFile as fsWriteFile, realpath, stat } from 'node:fs/promises';
import { dirname, isAbsolute, resolve } from 'node:path';
import type { ToolContext, ToolResponse } from './types.js';

/** The sandbox workspace root - all file operations must stay within this directory */
const WORKSPACE_ROOT = process.env.AGENT_WORKSPACE_ROOT ?? '/workspace';

export interface ReadFileArgs {
  path: string;
  offset?: number;
  limit?: number;
}

export interface WriteFileArgs {
  path: string;
  content: string;
}

export interface EditFileArgs {
  path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

/**
 * Resolve a path relative to the working directory and validate it stays within the workspace.
 * Throws an error if the path would escape the sandbox.
 */
function resolvePath(path: string, cwd: string): string {
  const resolved = isAbsolute(path) ? path : resolve(cwd, path);
  // Normalize the path to resolve .. and . components
  const normalized = resolve(resolved);

  // Validate the path stays within the workspace
  if (!normalized.startsWith(`${WORKSPACE_ROOT}/`) && normalized !== WORKSPACE_ROOT) {
    throw new Error(`Access denied: path '${path}' resolves outside workspace`);
  }

  return normalized;
}

/**
 * Validate that a resolved path (after following symlinks) stays within the workspace.
 * This catches symlink-based escapes that resolvePath alone cannot detect.
 */
async function validateRealPath(filePath: string, allowMissing = false): Promise<void> {
  try {
    const real = await realpath(filePath);
    if (!real.startsWith(`${WORKSPACE_ROOT}/`) && real !== WORKSPACE_ROOT) {
      throw new Error(`Access denied: path resolves outside workspace via symlink`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Access denied')) {
      throw error;
    }

    if (
      allowMissing &&
      error &&
      typeof error === 'object' &&
      'code' in error &&
      (error as { code?: string }).code === 'ENOENT'
    ) {
      return;
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Validate that a file's parent directory (after following symlinks) stays within the workspace.
 * This prevents creating new files via a symlinked parent directory.
 */
async function validateParentRealPath(filePath: string): Promise<void> {
  const parent = dirname(filePath);
  try {
    const realParent = await realpath(parent);
    if (!realParent.startsWith(`${WORKSPACE_ROOT}/`) && realParent !== WORKSPACE_ROOT) {
      throw new Error(`Access denied: parent directory resolves outside workspace via symlink`);
    }
  } catch (error) {
    if (error instanceof Error && error.message.includes('Access denied')) {
      throw error;
    }

    if (error && typeof error === 'object' && 'code' in error) {
      if ((error as { code?: string }).code === 'ENOENT') {
        throw new Error('Parent directory does not exist');
      }
    }

    throw error instanceof Error ? error : new Error(String(error));
  }
}

/**
 * Read file contents with optional line range.
 */
export async function readFileTool(
  args: ReadFileArgs,
  context: ToolContext
): Promise<ToolResponse> {
  try {
    const filePath = resolvePath(args.path, context.cwd);

    // Validate the real path (following symlinks) stays in workspace
    await validateRealPath(filePath);

    // Check file exists and get stats
    const stats = await stat(filePath);
    if (stats.isDirectory()) {
      return {
        content: [{ type: 'text', text: `Error: ${args.path} is a directory, not a file` }],
        is_error: true,
      };
    }

    const content = await fsReadFile(filePath, 'utf-8');
    const lines = content.split('\n');

    const offset = args.offset ?? 0;
    const limit = args.limit ?? 2000;
    const selectedLines = lines.slice(offset, offset + limit);

    // Format with line numbers (cat -n style)
    const formatted = selectedLines
      .map((line, idx) => {
        const lineNum = offset + idx + 1;
        const truncated = line.length > 2000 ? `${line.slice(0, 2000)}...` : line;
        return `${String(lineNum).padStart(6)}\t${truncated}`;
      })
      .join('\n');

    return {
      content: [{ type: 'text', text: formatted }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error reading file: ${message}` }],
      is_error: true,
    };
  }
}

/**
 * Write content to a file.
 */
export async function writeFileTool(
  args: WriteFileArgs,
  context: ToolContext
): Promise<ToolResponse> {
  try {
    // nosemgrep: agentpane.path-safety.missing-realpath-validation — validated below
    const filePath = resolvePath(args.path, context.cwd);

    // Validate parent real path to prevent symlink escapes for new files
    await validateParentRealPath(filePath);
    // Validate real path for existing files (symlink escape protection)
    await validateRealPath(filePath, true);

    await fsWriteFile(filePath, args.content, 'utf-8');

    return {
      content: [
        { type: 'text', text: `Successfully wrote ${args.content.length} bytes to ${args.path}` },
      ],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error writing file: ${message}` }],
      is_error: true,
    };
  }
}

/**
 * Edit a file by replacing specific text.
 */
export async function editFileTool(
  args: EditFileArgs,
  context: ToolContext
): Promise<ToolResponse> {
  try {
    const filePath = resolvePath(args.path, context.cwd);

    // Validate real path (symlink escape protection)
    await validateRealPath(filePath);

    const content = await fsReadFile(filePath, 'utf-8');

    if (args.old_string.length === 0) {
      return {
        content: [{ type: 'text', text: 'Error: old_string must not be empty' }],
        is_error: true,
      };
    }

    if (args.old_string === args.new_string) {
      return {
        content: [{ type: 'text', text: 'Error: old_string and new_string are identical' }],
        is_error: true,
      };
    }

    if (!content.includes(args.old_string)) {
      return {
        content: [
          {
            type: 'text',
            text: `Error: old_string not found in file. Make sure it matches exactly including whitespace.`,
          },
        ],
        is_error: true,
      };
    }

    // Check if old_string is unique (unless replace_all is true)
    if (!args.replace_all) {
      const occurrences = content.split(args.old_string).length - 1;
      if (occurrences > 1) {
        return {
          content: [
            {
              type: 'text',
              text: `Error: old_string appears ${occurrences} times. Use replace_all: true or provide more context to make it unique.`,
            },
          ],
          is_error: true,
        };
      }
    }

    const newContent = args.replace_all
      ? content.replaceAll(args.old_string, args.new_string)
      : content.replace(args.old_string, args.new_string);

    await fsWriteFile(filePath, newContent, 'utf-8');

    return {
      content: [{ type: 'text', text: `Successfully edited ${args.path}` }],
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return {
      content: [{ type: 'text', text: `Error editing file: ${message}` }],
      is_error: true,
    };
  }
}
