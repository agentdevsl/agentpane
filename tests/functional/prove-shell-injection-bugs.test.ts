/**
 * Functional Bug-Proving Tests for shell-injection patterns
 *
 * Each test exercises a real tool that composes a `sh -c` string from a
 * caller-supplied argument and checks that an injection payload cannot
 * execute extra commands.
 *
 * The check is concrete: each test asks the tool to "look at" a string that
 * contains a shell-metacharacter sequence wired to write a sentinel file in
 * the OS temp directory. After the call, the test fails iff the sentinel
 * file exists — proving the metacharacters were interpreted by `sh`.
 *
 * Run: npx vitest run --project functional tests/functional/prove-shell-injection-bugs.test.ts
 */
import { existsSync, mkdtempSync, rmSync, unlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { globTool, grepTool } from '../../src/lib/agents/tools/search-tools';
import type { ToolContext } from '../../src/lib/agents/types';

function uniqueSentinel(): string {
  return join(
    tmpdir(),
    `agentpane-injection-sentinel-${Date.now()}-${Math.random().toString(36).slice(2)}`
  );
}

function safeRm(path: string) {
  try {
    if (existsSync(path)) unlinkSync(path);
  } catch {
    // best-effort cleanup
  }
}

describe('Bug-Proving Tests: shell injection in lib/agents/tools/search-tools.ts', () => {
  let workDir: string;
  let sentinel: string;
  const context: ToolContext = { cwd: tmpdir() };

  beforeEach(() => {
    workDir = mkdtempSync(join(tmpdir(), 'inject-test-'));
    writeFileSync(join(workDir, 'real.txt'), 'hello world\n');
    sentinel = uniqueSentinel();
    safeRm(sentinel);
  });

  afterEach(() => {
    safeRm(sentinel);
    rmSync(workDir, { recursive: true, force: true });
  });

  it('globTool: pattern argument MUST NOT allow shell injection', async () => {
    // The injection payload closes the double-quoted -name argument and
    // tacks on a `touch <sentinel>` command. If `globTool` interpolates
    // `pattern` into a shell string, the sentinel file appears.
    const payload = `*.txt" 2>/dev/null; touch ${sentinel}; echo "`;

    await globTool({ pattern: payload, cwd: workDir }, context);

    expect(existsSync(sentinel)).toBe(false);
  });

  it('grepTool: pattern argument MUST NOT allow shell injection', async () => {
    // Closes the double-quoted pattern in `rg "<pattern>" --max-count ...`,
    // injects `touch <sentinel>`, and re-opens a quote so the rest of the
    // command still parses.
    const payload = `hello" /dev/null; touch ${sentinel}; echo "`;

    await grepTool({ pattern: payload, path: workDir }, context);

    expect(existsSync(sentinel)).toBe(false);
  });

  it('grepTool: glob argument MUST NOT allow shell injection', async () => {
    // Closes the double-quoted --glob argument, injects `touch`, then a
    // backgrounded `:` keeps the rest of the command syntactically valid
    // while ensuring the call returns promptly.
    const payload = `*.txt" /dev/null 2>/dev/null; touch ${sentinel}; : "`;

    await grepTool({ pattern: 'hello', glob: payload, path: workDir }, context);

    expect(existsSync(sentinel)).toBe(false);
  }, 15_000);
});
