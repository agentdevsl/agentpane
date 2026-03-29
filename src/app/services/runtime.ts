import type Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import * as schema from '@/db/schema/index.js';
import { createError } from '@/lib/errors/base';
import { err, ok, type Result } from '@/lib/utils/result';
import type { DurableStreamsServer } from '@/services/session.service';
import type { CommandRunner } from '@/services/worktree.service';
import type { Database as DrizzleDatabase } from '@/types/database';

type BunShellOutput = {
  stdout: Uint8Array | string;
  stderr: Uint8Array | string;
  exitCode?: number;
};

type BunShellPromise = Promise<BunShellOutput> & {
  cwd: (cwd: string) => BunShellPromise;
};

type BunRuntime = {
  $: (strings: TemplateStringsArray, ...values: string[]) => BunShellPromise;
};

type ShellErrorOutput = {
  stdout?: Uint8Array | string;
  stderr?: Uint8Array | string;
};

export type RuntimeContext = {
  db: DrizzleDatabase;
  runner: CommandRunner;
  streams?: DurableStreamsServer;
};

export type RuntimeResult = Result<RuntimeContext, ReturnType<typeof createError>>;

type RuntimeOptions = {
  db?: Database.Database;
  streams?: unknown;
};

const getBunRuntime = (): BunRuntime | null => {
  const globalWithBun = globalThis as { Bun?: BunRuntime };
  return globalWithBun.Bun ?? null;
};

const decodeOutput = (value: Uint8Array | string | null | undefined): string => {
  if (!value) {
    return '';
  }
  if (typeof value === 'string') {
    return value;
  }
  return new TextDecoder().decode(value);
};

const createRunner = (): CommandRunner => {
  const bun = getBunRuntime();
  if (!bun) {
    if (process.env.NODE_ENV === 'production') {
      console.warn('[Runtime] Command runner unavailable - worktree operations will not function');
    }
    return {
      exec: async (_command: string, _cwd: string) => ({
        stdout: '',
        stderr: '',
      }),
    };
  }

  const isTest = process.env.NODE_ENV === 'test' || process.env.VITEST === 'true';
  if (isTest) {
    return {
      exec: async (_command: string, _cwd: string) => ({
        stdout: '',
        stderr: '',
      }),
    };
  }

  return {
    exec: async (command: string, cwd: string) => {
      try {
        const output = await bun.$`bash -lc ${command}`.cwd(cwd);
        return {
          stdout: decodeOutput(output.stdout),
          stderr: decodeOutput(output.stderr),
        };
      } catch (error) {
        const details = error as ShellErrorOutput;
        const stdout = decodeOutput(details.stdout);
        const stderr = decodeOutput(details.stderr);
        const message =
          stderr || stdout || (error instanceof Error ? error.message : String(error));
        throw new Error(`[CommandRunner] ${command} failed: ${message}`, { cause: error });
      }
    },
  };
};

export function createRuntimeContext(options: RuntimeOptions): RuntimeResult {
  if (!options.db) {
    console.error('[Runtime] Database not available during initialization');
    return err(createError('SERVICES_DB_MISSING', 'Database not available', 500));
  }

  const database: DrizzleDatabase = drizzle(options.db, { schema });
  return ok({
    db: database,
    runner: createRunner(),
    streams: options.streams as DurableStreamsServer | undefined,
  });
}
