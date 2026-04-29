/**
 * F06-NEW-01 / F06-NEW-03 — property-based shell-injection fuzz test.
 *
 * Generates strings containing every shell metacharacter we know about and
 * verifies they survive LITERALLY to the spawned process when passed as
 * argv elements. The host runner (Bun.spawn) is the production path, but
 * we test the architectural invariant: argv elements are never composed
 * into a `sh -c` template.
 *
 * Without the fix:
 *   - `escapeShellString` lets `;`, `|`, `&` through because the helper
 *     only escapes `\\`, `"`, `` ` ``, `$`, and turns `\n` into the
 *     literal `\\n`. Composed into `git commit -m "$msg"` and run via
 *     `sh -c`, a hostile commit message of `evil"; rm -rf /; echo "ok`
 *     would terminate the quoted argument and execute `rm -rf /`.
 *
 * With the fix (this test):
 *   - All callers go through `runner.execArgs(argv, cwd)` which spawns
 *     directly (no shell). Each argv entry is delivered to the child
 *     process as one string, regardless of metacharacters.
 *
 * The test uses `createSandboxCommandRunner` because it works in pure-JS
 * Vitest (no Bun runtime needed) — the architectural property (argv
 * never reaches the shell template) holds for both `createBunCommandRunner`
 * and `createSandboxCommandRunner`. The strongest invariant we can assert
 * is BYTE-IDENTITY of the shell template across every input: the template
 * is `cd '<cwd>' && exec "$@"`, and any hostile payload travels past `--`
 * as a literal positional ($1...$N), never seen by `sh -c`.
 */

/** biome-ignore-all lint/nursery/noFloatingPromises: fc.assert is sync when the property fn is sync; the rule can't infer this from the overloaded return type. */

import * as fc from 'fast-check';
import { describe, expect, it, vi } from 'vitest';
import { createSandboxCommandRunner } from '../../../src/services/worktree.service.js';

/**
 * Arbitrary that generates strings containing at least one shell
 * metacharacter. Each char in the alphabet has been observed as an
 * injection vector in real shell runners.
 */
const HOSTILE_CHARS = [
  ';',
  '|',
  '&',
  '`',
  '$',
  '(',
  ')',
  '"',
  "'",
  '\\',
  '\n',
  '\r',
  '\t',
  '\v',
  '\u2028',
  '\u2029',
  '<',
  '>',
];

const hostileString = fc
  .stringMatching(/.+/)
  .filter((s) => HOSTILE_CHARS.some((c) => s.includes(c)));

/** Cwd for tests using `/tmp/cwd`. */
const TEMPLATE_CWD = `cd '/tmp/cwd' && exec "$@"`;
/** Cwd for tests using `/tmp` (shorter, used in focused tests). */
const TEMPLATE_TMP = `cd '/tmp' && exec "$@"`;

describe('F06-NEW-01: command-runner argv survives shell metacharacters', () => {
  it('every hostile string passed as argv arrives as a single shell positional, never composed into sh -c', () => {
    fc.assert(
      fc.property(hostileString, (hostile) => {
        const sandbox = {
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        };
        const runner = createSandboxCommandRunner(sandbox);

        // Pretend a hostile branch name reaches `git branch -D <branch>`.
        // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
        runner.execArgs!(['git', 'branch', '-D', hostile], '/tmp/cwd');

        // sandbox.exec is called as `('sh', ['-c', "cd '/tmp/cwd' && exec \"$@\"",
        // '--', 'git', 'branch', '-D', hostile])` — the hostile value is
        // a separate positional argument, never embedded in the shell
        // command string.
        expect(sandbox.exec).toHaveBeenCalledTimes(1);
        const [shellCmd, args] = sandbox.exec.mock.calls[0]!;
        expect(shellCmd).toBe('sh');
        // Byte-identity: the shell template is identical for every input,
        // because the hostile payload rides past `--` as a positional.
        expect(args[1]).toBe(TEMPLATE_CWD);
        // The hostile string lives at the end of the argv positionals,
        // delivered to git verbatim via "$@".
        expect(args[args.length - 1]).toBe(hostile);
      }),
      { numRuns: 200 }
    );
  });

  it('hostile arg containing `;` does NOT split into multiple shell statements', () => {
    fc.assert(
      fc.property(fc.constantFrom('foo;bar', 'foo;rm -rf /', 'a;;b', ';bar;'), (hostile) => {
        const sandbox = {
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        };
        const runner = createSandboxCommandRunner(sandbox);
        // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
        runner.execArgs!(['echo', hostile], '/tmp');
        const [, args] = sandbox.exec.mock.calls[0]!;
        expect(args[args.length - 1]).toBe(hostile);
        expect(args[1]).toBe(TEMPLATE_TMP);
      }),
      { numRuns: 50 }
    );
  });

  it('hostile arg containing `|` does NOT pipe through shell', () => {
    fc.assert(
      fc.property(fc.constantFrom('foo|bar', 'a|cat /etc/passwd', '||evil', '|'), (hostile) => {
        const sandbox = {
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        };
        const runner = createSandboxCommandRunner(sandbox);
        // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
        runner.execArgs!(['echo', hostile], '/tmp');
        const [, args] = sandbox.exec.mock.calls[0]!;
        expect(args[args.length - 1]).toBe(hostile);
        expect(args[1]).toBe(TEMPLATE_TMP);
      }),
      { numRuns: 50 }
    );
  });

  it('hostile arg containing `&` does NOT background a process', () => {
    fc.assert(
      fc.property(fc.constantFrom('foo&bar', 'a&&evil', '&background', '&', 'a&b&c'), (hostile) => {
        const sandbox = {
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        };
        const runner = createSandboxCommandRunner(sandbox);
        // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
        runner.execArgs!(['echo', hostile], '/tmp');
        const [, args] = sandbox.exec.mock.calls[0]!;
        expect(args[args.length - 1]).toBe(hostile);
        // Byte-identical template — even though it contains a literal
        // `&&` between `cd` and `exec`, the hostile payload was NOT
        // appended to it.
        expect(args[1]).toBe(TEMPLATE_TMP);
      }),
      { numRuns: 50 }
    );
  });

  it('hostile arg with command substitution `$()` is NOT evaluated', () => {
    fc.assert(
      fc.property(fc.constantFrom('$(whoami)', 'foo$(rm -rf /)', '`id`', '${HOME}'), (hostile) => {
        const sandbox = {
          exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
        };
        const runner = createSandboxCommandRunner(sandbox);
        // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
        runner.execArgs!(['echo', hostile], '/tmp');
        const [, args] = sandbox.exec.mock.calls[0]!;
        expect(args[args.length - 1]).toBe(hostile);
        expect(args[1]).toBe(TEMPLATE_TMP);
      }),
      { numRuns: 50 }
    );
  });

  it('hostile arg with newlines and Unicode line separators arrives literally', () => {
    fc.assert(
      fc.property(
        fc.constantFrom(
          'foo\nbar',
          'a\rb',
          'tab\there',
          'sep\u2028more',
          'para\u2029more',
          'multi\nline\rwith\u2028u2028'
        ),
        (hostile) => {
          const sandbox = {
            exec: vi.fn().mockResolvedValue({ exitCode: 0, stdout: '', stderr: '' }),
          };
          const runner = createSandboxCommandRunner(sandbox);
          // biome-ignore lint/style/noNonNullAssertion: createSandboxCommandRunner always supplies execArgs.
          runner.execArgs!(['printf', hostile], '/tmp');
          const [, args] = sandbox.exec.mock.calls[0]!;
          // Hostile chars are delivered as a single positional argument
          // exactly as supplied. The shell template is byte-identical.
          expect(args[args.length - 1]).toBe(hostile);
          expect(args[1]).toBe(TEMPLATE_TMP);
        }
      ),
      { numRuns: 50 }
    );
  });
});
