import type { ToolContext, ToolResponse } from '../types.js';
import { type BashArgs, bashTool } from './bash-tool.js';
import {
  type EditFileArgs,
  editFile,
  type ReadFileArgs,
  readFile,
  type WriteFileArgs,
  writeFile,
} from './file-tools.js';
import { type GlobArgs, type GrepArgs, globTool, grepTool } from './search-tools.js';

export type ToolName = 'read_file' | 'edit_file' | 'write_file' | 'bash' | 'glob' | 'grep';

export type ToolArgs = ReadFileArgs | EditFileArgs | WriteFileArgs | BashArgs | GlobArgs | GrepArgs;

export interface ToolDefinition {
  name: ToolName;
  description: string;
  handler: (args: ToolArgs, context: ToolContext) => Promise<ToolResponse>;
}

export const TOOL_REGISTRY: Record<ToolName, ToolDefinition> = {
  read_file: {
    name: 'read_file',
    description: 'Read the contents of a file at the specified path',
    handler: (args, context) => readFile(args as ReadFileArgs, context),
  },
  edit_file: {
    name: 'edit_file',
    description: 'Replace specific text in a file. The old_string must match exactly.',
    handler: (args, context) => editFile(args as EditFileArgs, context),
  },
  write_file: {
    name: 'write_file',
    description: 'Create or overwrite a file with the specified content',
    handler: (args, context) => writeFile(args as WriteFileArgs, context),
  },
  bash: {
    name: 'bash',
    description: 'Execute a bash command in the agent worktree',
    handler: (args, context) => bashTool(args as BashArgs, context),
  },
  glob: {
    name: 'glob',
    description: 'Find files matching a glob pattern',
    handler: (args, context) => globTool(args as GlobArgs, context),
  },
  grep: {
    name: 'grep',
    description: 'Search for text patterns in files using regex',
    handler: (args, context) => grepTool(args as GrepArgs, context),
  },
};

export function getToolHandler(
  toolName: string
): ((args: ToolArgs, context: ToolContext) => Promise<ToolResponse>) | undefined {
  return TOOL_REGISTRY[toolName as ToolName]?.handler;
}

export function getAvailableTools(): ToolName[] {
  return Object.keys(TOOL_REGISTRY) as ToolName[];
}

export type { BashArgs, EditFileArgs, GlobArgs, GrepArgs, ReadFileArgs, WriteFileArgs };
export { bashTool, editFile, globTool, grepTool, readFile, writeFile };
