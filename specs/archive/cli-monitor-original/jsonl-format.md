# JSONL Format — Claude Code CLI Events

Reference for the JSONL event format written by Claude Code CLI to `~/.claude/projects/{hash}/{sessionId}.jsonl`.

---

## File Structure

- **Location**: `~/.claude/projects/{projectHash}/{sessionId}.jsonl`
- **Format**: One JSON object per line (newline-delimited)
- **Encoding**: UTF-8
- **Growth**: Append-only during a session

The `projectHash` directory is a hash of the project's absolute path. Each session gets its own `.jsonl` file named by the session UUID.

---

## Event Types

```typescript
type RawCliEventType =
  | 'user'
  | 'assistant'
  | 'system'
  | 'queue-operation'
  | 'summary'
  | 'progress'
  | 'file-history-snapshot';
```

| Type | Description |
|------|-------------|
| `user` | User message (prompt or tool result) |
| `assistant` | Claude response (text, thinking, tool use, or combination) |
| `system` | System events (permission mode, hook summaries, operations) |
| `queue-operation` | Internal queue management |
| `summary` | Session summary (generated when session becomes idle) |
| `progress` | Hook execution progress (PreToolUse, PostToolUse, Stop, SubagentStop) |
| `file-history-snapshot` | File backup tracking |

---

## Raw Event Schema

```typescript
interface RawCliEvent {
  // ── Common fields (all events) ──
  type: RawCliEventType;
  uuid: string;                          // Unique event ID
  timestamp: string;                     // ISO 8601 timestamp
  sessionId: string;                     // Session UUID
  cwd: string;                           // Working directory
  version: string;                       // Claude Code CLI version
  gitBranch?: string;                    // Current git branch
  parentUuid: string | null;             // Parent event (for threading)
  isSidechain: boolean;                  // True if side conversation
  userType: 'external';                  // Always "external"
  agentId?: string;                      // Present for subagent sessions

  // ── Assistant-specific fields ──
  requestId?: string;                    // API request ID
  isMeta?: boolean;                      // Meta message flag
  thinkingMetadata?: {                   // Thinking configuration
    maxThinkingTokens: number;
  };

  // ── Tool result linking ──
  sourceToolAssistantUUID?: string;      // Links tool result to requesting assistant

  // ── Summary-specific fields ──
  leafUuid?: string;                     // Leaf UUID on summary events

  // ── System event fields ──
  subtype?: string;                      // e.g. "local_command", "stop_hook_summary"
  level?: string;                        // e.g. "info", "suggestion"
  hookCount?: number;                    // Number of hooks configured
  hookInfos?: Array<{ command: string }>;// Hook command details
  hookErrors?: unknown[];                // Hook execution errors
  preventedContinuation?: boolean;       // Hook prevented continuation
  stopReason?: string;                   // Stop reason from hooks
  hasOutput?: boolean;                   // Whether hook produced output
  toolUseID?: string;                    // Associated tool use ID

  // ── Message payload ──
  message?: {
    role: 'user' | 'assistant';
    id?: string;                         // Message ID
    type?: string;                       // Always 'message'
    model?: string;                      // e.g. "claude-sonnet-4-6"
    content: string | ContentBlock[];
    usage?: TokenUsage;
    stop_reason?: string | null;         // e.g. "end_turn", "tool_use"
    stop_sequence?: string | null;
  };

  // ── Other fields ──
  permissionMode?: string;
  summary?: string;
  operation?: string;
  toolUseResult?: string | {
    stdout: string;
    stderr: string;
    interrupted: boolean;
    isImage: boolean;
  };

  // ── Progress event data ──
  progressData?: {
    type: 'hook_progress';
    hookEvent: string;                   // e.g. "PreToolUse", "PostToolUse", "Stop"
    hookName: string;
    command: string;
  };
}
```

---

## Content Blocks

Assistant and user messages may contain structured content blocks:

```typescript
type ContentBlock =
  | ContentBlockText
  | ContentBlockThinking
  | ContentBlockToolUse
  | ContentBlockToolResult;
```

### Text Block

```typescript
interface ContentBlockText {
  type: 'text';
  text: string;
}
```

### Thinking Block

```typescript
interface ContentBlockThinking {
  type: 'thinking';
  thinking: string;       // The thinking text content
  signature: string;      // Cryptographic signature
}
```

Thinking blocks contain the model's extended thinking output. They appear before text/tool_use blocks in the content array when thinking is enabled.

### Tool Use Block

```typescript
interface ContentBlockToolUse {
  type: 'tool_use';
  id: string;             // Tool invocation ID
  name: string;           // Tool name (e.g. "Read", "Write", "Bash")
  input: unknown;         // Tool parameters
}
```

### Tool Result Block

```typescript
interface ContentBlockToolResult {
  type: 'tool_result';
  tool_use_id: string;    // Matches tool_use.id
  content: string;        // Tool output
  is_error?: boolean;     // True if tool failed
}
```

---

## Token Usage

Present on assistant messages in `message.usage`:

```typescript
interface TokenUsage {
  input_tokens: number;
  output_tokens: number;
  cache_creation_input_tokens: number;
  cache_read_input_tokens: number;
  cache_creation?: {
    ephemeral_5m_input_tokens: number;   // 5-minute ephemeral cache tokens
    ephemeral_1h_input_tokens: number;   // 1-hour ephemeral cache tokens
  };
  service_tier?: string;                 // e.g. "standard"
}
```

The `cache_creation` sub-object is present when ephemeral caching is active. These tokens are tracked separately in the daemon's session state as `ephemeral5mTokens` and `ephemeral1hTokens`.

---

## Status Derivation Rules

The daemon parser derives session status from event sequences:

| Condition | Derived Status |
|-----------|---------------|
| Assistant message contains `tool_use` block | `waiting_for_approval` |
| Assistant message contains `text` block | `working` |
| Assistant message has `stop_reason` set (and not already `waiting_for_approval`) | `waiting_for_input` |
| `summary` event received | `idle` |
| No events for 5 minutes | `idle` (timer-based) |

**Priority**: `waiting_for_approval` > `working` > `waiting_for_input` > `idle`

When an assistant message contains both `tool_use` and `text` blocks, `waiting_for_approval` takes precedence.

**Thinking blocks** do not affect status derivation — they are informational only.

**Progress and file-history-snapshot events** do not affect session state — they are silently consumed.

---

## Session Metadata Extraction

| Field | Source |
|-------|--------|
| `sessionId` | `event.sessionId` |
| `cwd` | `event.cwd` (from first event) |
| `projectName` | `path.basename(event.cwd)` |
| `projectHash` | Directory name under `~/.claude/projects/` |
| `gitBranch` | `event.gitBranch` (updated on each event) |
| `goal` | First user message text, truncated to 200 chars |
| `recentOutput` | Last assistant text content, truncated to 500 chars |
| `model` | `message.model` on assistant events |
| `isSubagent` | `/subagents/` in file path or `agentId` field present |
| `pendingToolUse` | Last `tool_use` block without matching `tool_result` |
| `tokenUsage.ephemeral5mTokens` | Accumulated from `usage.cache_creation.ephemeral_5m_input_tokens` |
| `tokenUsage.ephemeral1hTokens` | Accumulated from `usage.cache_creation.ephemeral_1h_input_tokens` |

---

## Example Events

### User Message

```json
{
  "type": "user",
  "uuid": "a1b2c3d4-...",
  "timestamp": "2025-01-31T10:00:00.000Z",
  "sessionId": "e5f6g7h8-...",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "gitBranch": "main",
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "message": {
    "role": "user",
    "content": "Fix the authentication bug in login.ts"
  }
}
```

### Assistant Message with Thinking and Tool Use

```json
{
  "type": "assistant",
  "uuid": "i9j0k1l2-...",
  "timestamp": "2025-01-31T10:00:05.000Z",
  "sessionId": "e5f6g7h8-...",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "parentUuid": "a1b2c3d4-...",
  "isSidechain": false,
  "userType": "external",
  "requestId": "req_abc123",
  "thinkingMetadata": { "maxThinkingTokens": 10000 },
  "message": {
    "role": "assistant",
    "id": "msg_xyz",
    "type": "message",
    "model": "claude-sonnet-4-6",
    "content": [
      { "type": "thinking", "thinking": "Let me analyze the login.ts file...", "signature": "sig_abc" },
      { "type": "text", "text": "I'll read the login.ts file first." },
      { "type": "tool_use", "id": "tu_123", "name": "Read", "input": { "file_path": "/Users/me/project/src/login.ts" } }
    ],
    "usage": {
      "input_tokens": 1500,
      "output_tokens": 200,
      "cache_creation_input_tokens": 0,
      "cache_read_input_tokens": 500,
      "cache_creation": {
        "ephemeral_5m_input_tokens": 100,
        "ephemeral_1h_input_tokens": 50
      }
    },
    "stop_reason": null
  }
}
```

### Progress Event

```json
{
  "type": "progress",
  "uuid": "p1q2r3s4-...",
  "timestamp": "2025-01-31T10:00:06.000Z",
  "sessionId": "e5f6g7h8-...",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "progressData": {
    "type": "hook_progress",
    "hookEvent": "PreToolUse",
    "hookName": "lint-check",
    "command": "npm run lint"
  }
}
```

### Summary Event

```json
{
  "type": "summary",
  "uuid": "m3n4o5p6-...",
  "timestamp": "2025-01-31T10:15:00.000Z",
  "sessionId": "e5f6g7h8-...",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "leafUuid": "i9j0k1l2-...",
  "summary": "Fixed authentication bug by updating token validation logic in login.ts"
}
```

### System Event (Hook Summary)

```json
{
  "type": "system",
  "uuid": "s5t6u7v8-...",
  "timestamp": "2025-01-31T10:00:07.000Z",
  "sessionId": "e5f6g7h8-...",
  "cwd": "/Users/me/project",
  "version": "1.0.0",
  "parentUuid": null,
  "isSidechain": false,
  "userType": "external",
  "subtype": "stop_hook_summary",
  "level": "info",
  "hookCount": 2,
  "hookInfos": [{ "command": "npm run lint" }, { "command": "npm test" }],
  "hookErrors": [],
  "preventedContinuation": false
}
```

---

## Parser Safety

| Concern | Handling |
|---------|----------|
| Lines > 1MB | Skipped entirely |
| Malformed JSON | Skipped (except last line, assumed incomplete write) |
| Missing `sessionId` or `type` | Skipped |
| File truncated mid-write | Offset reset on next read |
| Multi-byte UTF-8 split | Continuation bytes (0x80-0xBF) skipped at buffer start |
| Unrecognized event types | Silently ignored (future-proof) |
| Thinking blocks | Recognized but don't affect status derivation |
| Progress events | Recognized but don't affect session state |
| file-history-snapshot | Recognized but don't affect session state |
