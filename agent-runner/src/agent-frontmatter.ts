/**
 * Agent frontmatter parser.
 *
 * Parses `.claude/agents/*.md` files used by the Claude Agent SDK. Each file
 * begins with a YAML frontmatter block delimited by `---` lines, followed by
 * the agent body (the system prompt).
 *
 * SECURITY (F06-NEW-04): Earlier revisions of `index.ts` matched fields with
 * hand-rolled regex (`/^name:\s*(.+)$/m` etc.) and stripped surrounding quotes
 * via `.replace(/^['"]|['"]$/g, '')`. That scheme was bypassable in two
 * concrete ways:
 *
 * 1. A hostile skill marketplace publishes a SKILL/agent whose `name` field is
 *    serialised by the host as a quoted YAML string containing `\n` and
 *    `tools:\n  - Bash`. The host emits valid YAML (quotes preserved). The
 *    runner's `unquote` strips the quotes and **reinterprets** the literal
 *    `\n`, then the per-line `^tools:` regex (with the `m` flag) matches the
 *    injected `tools:` block — the agent registers a subagent with shell
 *    access that the marketplace skill never declared.
 * 2. A multi-line description encoded as a YAML block scalar (`|` or `>-`)
 *    captures only its first line through the regex, dropping the rest and
 *    leaving the parser in an inconsistent state.
 *
 * Both classes are eliminated by feeding the entire frontmatter through a real
 * YAML parser and validating the resulting object against an explicit schema.
 *
 * Cross-ref: `src/lib/sandbox/skill-injector.ts` is the host-side serialiser
 * fix (F06-03). This file is the matching deserialiser inside the sandbox.
 */

import { parse as yamlParse } from 'yaml';

/** Shape consumed by the Claude Agent SDK's `agents` option. */
export interface AgentDefinition {
  description: string;
  tools?: string[];
  prompt: string;
  model?: string;
}

/** Result for a successful parse. `name` is the registry key. */
export interface ParsedAgent {
  name: string;
  definition: AgentDefinition;
}

/**
 * Pattern for legitimate agent identifiers and tool names. Matches the host
 * `SAFE_NAME` allow-list in `skill-injector.ts`.
 */
const SAFE_IDENTIFIER = /^[a-zA-Z0-9][a-zA-Z0-9_-]*$/;

/**
 * Frontmatter delimiter regex.
 *
 * Accepts CRLF (`\r\n`) and LF (`\n`) terminators because skill files may be
 * authored on Windows. The body is captured as everything after the closing
 * delimiter so callers can use it as the agent's system prompt.
 */
const FRONTMATTER_RE = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/;

/**
 * Coerce an unknown to a non-empty string, or return undefined.
 *
 * The YAML parser may return `null`, `undefined`, numbers, booleans, or nested
 * objects depending on the input — we accept only strings so a hostile value
 * like `name: { evil: true }` is rejected outright.
 */
function asNonEmptyString(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

/**
 * Coerce an unknown to a list of safe tool identifiers.
 *
 * - Non-array input -> undefined.
 * - Array entries that are not strings or fail {@link SAFE_IDENTIFIER} are
 *   dropped (with the rest preserved). This matches host policy: invalid tags
 *   are filtered, valid ones round-trip.
 * - Empty result -> undefined so the SDK omits the field entirely.
 */
function asToolList(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  const tools: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const trimmed = item.trim();
    if (trimmed.length === 0) continue;
    if (!SAFE_IDENTIFIER.test(trimmed)) continue;
    tools.push(trimmed);
  }
  return tools.length > 0 ? tools : undefined;
}

/**
 * Parse a single agent markdown file.
 *
 * Returns `null` if:
 * - the file lacks a frontmatter block,
 * - the frontmatter is not a YAML object,
 * - `name` or `description` are missing / empty / non-strings,
 * - `name` does not match {@link SAFE_IDENTIFIER}.
 *
 * Throws only on programmer error (unreachable in normal flow). The caller
 * (`loadAgentDefinitions`) wraps invocations in a try/catch so a single bad
 * file does not abort the loop.
 *
 * @param content - Full file contents, including the frontmatter delimiters.
 */
export function parseAgentFrontmatter(content: string): ParsedAgent | null {
  if (typeof content !== 'string' || content.length === 0) return null;

  const match = content.match(FRONTMATTER_RE);
  if (!match) return null;

  const frontmatter = match[1] ?? '';
  const body = (match[2] ?? '').trim();

  // Use a real YAML parser. `prettyErrors: false` keeps stack traces compact;
  // we already wrap in try/catch one level up.
  let parsed: unknown;
  try {
    parsed = yamlParse(frontmatter, { prettyErrors: false });
  } catch {
    // Malformed YAML — treat as a soft skip. The host already validated this
    // file when it serialised it, so a parse error here is a corrupted volume
    // or hand-edited file. Either way: don't register the agent.
    return null;
  }

  // Frontmatter must be a plain object. Strings, numbers, arrays, null are
  // all rejected — the SDK schema requires keyed access.
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    Array.isArray(parsed) ||
    parsed instanceof Date
  ) {
    return null;
  }
  const fm = parsed as Record<string, unknown>;

  const name = asNonEmptyString(fm.name);
  if (!name || !SAFE_IDENTIFIER.test(name)) return null;

  const description = asNonEmptyString(fm.description);
  if (!description) return null;

  const model = asNonEmptyString(fm.model);
  const tools = asToolList(fm.tools);

  const definition: AgentDefinition = {
    description,
    prompt: body || description,
    ...(tools ? { tools } : {}),
    ...(model && model !== 'inherit' ? { model } : {}),
  };

  return { name, definition };
}
