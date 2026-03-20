import fs from 'node:fs/promises';
import type { ToolContext, ToolResponse } from '../types.js';

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

export async function readFile(args: ReadFileArgs, _context: ToolContext): Promise<ToolResponse> {
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
          text: `Failed to read file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      is_error: true,
    };
  }
}

export async function editFile(args: EditFileArgs, _context: ToolContext): Promise<ToolResponse> {
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
          text: `Failed to edit file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      is_error: true,
    };
  }
}

export async function writeFile(args: WriteFileArgs, _context: ToolContext): Promise<ToolResponse> {
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
          text: `Failed to write file: ${error instanceof Error ? error.message : String(error)}`,
        },
      ],
      is_error: true,
    };
  }
}
