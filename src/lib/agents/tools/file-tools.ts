import fs from 'node:fs/promises';
<<<<<<< ours
import path from 'node:path';
=======
import { errorMessage } from '../../utils/error-message';
>>>>>>> theirs
import type { ToolContext, ToolResponse } from '../types.js';

/** Blocked system directories that agents must never access */
const BLOCKED_SYSTEM_DIRS = [
  '/etc',
  '/usr',
  '/bin',
  '/sbin',
  '/boot',
  '/dev',
  '/proc',
  '/sys',
  '/var/run',
  '/var/log',
  '/root',
];

/**
 * Validate that a file path does not escape the working directory via
 * traversal and does not target any system directories. Returns an error
 * response if the path is invalid, or null if the path is safe.
 */
function validateFilePath(filePath: string, cwd: string): ToolResponse | null {
  const resolved = path.resolve(cwd, filePath);

  // For relative paths, ensure they resolve within the cwd (prevent ../../ traversal)
  if (!path.isAbsolute(filePath) && !resolved.startsWith(cwd)) {
    return {
      content: [
        {
          type: 'text',
          text: `Path traversal blocked: ${filePath} resolves outside working directory`,
        },
      ],
      is_error: true,
    };
  }

  // Block access to system directories (applies to both relative and absolute paths)
  for (const blocked of BLOCKED_SYSTEM_DIRS) {
    if (resolved.startsWith(blocked)) {
      return {
        content: [
          {
            type: 'text',
            text: `Access denied: ${filePath} targets blocked system directory ${blocked}`,
          },
        ],
        is_error: true,
      };
    }
  }

  return null;
}

export interface ReadFileArgs {
  file_path: string;
  encoding?: 'utf-8' | 'base64';
}

export interface EditFileArgs {
  file_path: string;
  old_string: string;
  new_string: string;
  replace_all?: boolean;
}

export interface WriteFileArgs {
  file_path: string;
  content: string;
}

export async function readFile(args: ReadFileArgs, context: ToolContext): Promise<ToolResponse> {
  const pathError = validateFilePath(args.file_path, context.cwd);
  if (pathError) return pathError;

  try {
    const content = await fs.readFile(args.file_path, {
      encoding: args.encoding === 'base64' ? 'base64' : 'utf-8',
    });

    return {
      content: [{ type: 'text', text: content }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to read file: ${errorMessage(error)}`,
        },
      ],
      is_error: true,
    };
  }
}

export async function editFile(args: EditFileArgs, context: ToolContext): Promise<ToolResponse> {
  const pathError = validateFilePath(args.file_path, context.cwd);
  if (pathError) return pathError;

  try {
    let content = await fs.readFile(args.file_path, 'utf-8');

    if (!content.includes(args.old_string)) {
      return {
        content: [
          {
            type: 'text',
            text: `Could not find text to replace in ${args.file_path}`,
          },
        ],
        is_error: true,
      };
    }

    if (args.replace_all) {
      content = content.replaceAll(args.old_string, args.new_string);
    } else {
      content = content.replace(args.old_string, args.new_string);
    }

    await fs.writeFile(args.file_path, content, 'utf-8');

    return {
      content: [{ type: 'text', text: `Successfully edited ${args.file_path}` }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to edit file: ${errorMessage(error)}`,
        },
      ],
      is_error: true,
    };
  }
}

export async function writeFile(args: WriteFileArgs, context: ToolContext): Promise<ToolResponse> {
  const pathError = validateFilePath(args.file_path, context.cwd);
  if (pathError) return pathError;

  try {
    await fs.writeFile(args.file_path, args.content, 'utf-8');

    return {
      content: [{ type: 'text', text: `Successfully wrote ${args.file_path}` }],
    };
  } catch (error) {
    return {
      content: [
        {
          type: 'text',
          text: `Failed to write file: ${errorMessage(error)}`,
        },
      ],
      is_error: true,
    };
  }
}
