import { useMemo } from 'react';
import type { SessionChunk, SessionTerminal, SessionToolCall } from '@/app/hooks/use-session';

// Stream line types for color coding
export type StreamLineType =
  | 'prompt' // Agent prompt marker (green)
  | 'command' // Agent command text (default)
  | 'output' // Command output (muted)
  | 'thinking' // Agent thinking text (yellow, italic)
  | 'action' // Action indicator (blue)
  | 'tool' // Tool execution (purple)
  | 'success' // Success message (green)
  | 'error'; // Error message (red)

export interface StreamLine {
  id: string;
  type: StreamLineType;
  content: string;
  timestamp: number;
  agentId?: string;
  toolName?: string;
}

// ANSI escape code regex
const ANSI_REGEX = /\x1b\[[0-9;]*m/g;

function stripAnsiCodes(text: string): string {
  return text.replace(ANSI_REGEX, '');
}

function detectLineType(text: string): StreamLineType {
  const cleanText = stripAnsiCodes(text).trim();

  // Prompt patterns
  if (
    cleanText.startsWith('agent $') ||
    cleanText.startsWith('claude $') ||
    cleanText.startsWith('>')
  ) {
    return 'prompt';
  }

  // Thinking patterns
  if (
    cleanText.startsWith('Thinking:') ||
    cleanText.includes('thinking...') ||
    cleanText.startsWith('I will') ||
    cleanText.startsWith('Let me')
  ) {
    return 'thinking';
  }

  // Action patterns
  if (
    cleanText.startsWith('->') ||
    cleanText.startsWith('Reading') ||
    cleanText.startsWith('Editing') ||
    cleanText.startsWith('Writing') ||
    cleanText.startsWith('Running') ||
    cleanText.startsWith('Searching') ||
    cleanText.startsWith('Creating')
  ) {
    return 'action';
  }

  // Success patterns
  if (
    cleanText.startsWith('SUCCESS') ||
    cleanText.startsWith('OK') ||
    cleanText.startsWith('Done') ||
    cleanText.startsWith('Completed') ||
    cleanText.includes(' done')
  ) {
    return 'success';
  }

  // Error patterns
  if (
    cleanText.startsWith('ERROR') ||
    cleanText.startsWith('FAIL') ||
    cleanText.startsWith('Error:') ||
    cleanText.includes('failed')
  ) {
    return 'error';
  }

  // Default to output
  return 'output';
}

function parseTextToLines(
  text: string,
  timestamp: number,
  baseId: string,
  agentId?: string
): StreamLine[] {
  const lines: StreamLine[] = [];
  const textLines = text.split('\n');

  for (const [lineIndex, line] of textLines.entries()) {
    if (line.length === 0) continue;

    lines.push({
      id: `${baseId}:line:${lineIndex}`,
      type: detectLineType(line),
      content: stripAnsiCodes(line),
      timestamp,
      agentId,
    });
  }

  return lines;
}

function formatToolOutput(output: unknown): string {
  if (typeof output === 'string') {
    return output;
  }
  if (output === null || output === undefined) {
    return '';
  }
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

interface StreamEvent {
  _source: 'chunk' | 'tool' | 'terminal';
  _eventId: string;
  timestamp: number;
  // Chunk fields
  text?: string;
  agentId?: string;
  // Tool fields
  id?: string;
  tool?: string;
  status?: string;
  output?: unknown;
  // Terminal fields
  type?: 'input' | 'output';
  data?: string;
}

function getStableEventId(
  baseType: 'chunk' | 'tool' | 'terminal',
  fallbackParts: Array<string | number | undefined>,
  meta?: { eventId?: string | undefined },
  cursor?: string
): string {
  if (meta?.eventId) {
    return meta.eventId;
  }

  if (cursor) {
    return `${baseType}:${cursor}`;
  }

  return `${baseType}:${fallbackParts.map((part) => String(part ?? 'unknown')).join(':')}`;
}

export function useStreamParser(
  chunks: SessionChunk[],
  toolCalls: SessionToolCall[],
  terminal: SessionTerminal[]
): StreamLine[] {
  return useMemo(() => {
    const lines: StreamLine[] = [];

    // Merge and sort all events by timestamp
    const allEvents: StreamEvent[] = [
      ...chunks.map((chunk) => ({
        ...chunk,
        _source: 'chunk' as const,
        _eventId: getStableEventId(
          'chunk',
          [chunk.timestamp, chunk.agentId],
          chunk.meta,
          chunk.cursor
        ),
      })),
      ...toolCalls.map((toolCall) => ({
        ...toolCall,
        _source: 'tool' as const,
        _eventId: getStableEventId(
          'tool',
          [toolCall.id, toolCall.timestamp],
          toolCall.meta,
          toolCall.cursor
        ),
      })),
      ...terminal.map((terminalEvent) => ({
        ...terminalEvent,
        _source: 'terminal' as const,
        _eventId: getStableEventId(
          'terminal',
          [terminalEvent.timestamp, terminalEvent.type],
          terminalEvent.meta,
          terminalEvent.cursor
        ),
      })),
    ].sort((a, b) => a.timestamp - b.timestamp);

    for (const event of allEvents) {
      if (event._source === 'chunk') {
        const textLines = parseTextToLines(
          event.text ?? '',
          event.timestamp,
          event._eventId,
          event.agentId
        );
        lines.push(...textLines);
      } else if (event._source === 'tool') {
        if (event.status === 'running') {
          lines.push({
            id: `${event._eventId}:start`,
            type: 'tool',
            content: `-> ${event.tool}`,
            timestamp: event.timestamp,
            agentId: event.agentId,
            toolName: event.tool,
          });
        } else if (event.status === 'complete') {
          const output = formatToolOutput(event.output);
          if (output) {
            lines.push({
              id: `${event._eventId}:result`,
              type: 'output',
              content: output,
              timestamp: event.timestamp,
              agentId: event.agentId,
              toolName: event.tool,
            });
          }
        } else if (event.status === 'error') {
          lines.push({
            id: `${event._eventId}:error`,
            type: 'error',
            content: formatToolOutput(event.output) || 'Tool execution failed',
            timestamp: event.timestamp,
            agentId: event.agentId,
            toolName: event.tool,
          });
        }
      } else if (event._source === 'terminal') {
        const terminalType: StreamLineType = event.type === 'input' ? 'command' : 'output';
        if (event.data) {
          lines.push({
            id: `${event._eventId}:line`,
            type: terminalType,
            content: stripAnsiCodes(event.data),
            timestamp: event.timestamp,
          });
        }
      }
    }

    return lines;
  }, [chunks, toolCalls, terminal]);
}

// Group consecutive output lines for cleaner display
export function groupConsecutiveLines(lines: StreamLine[]): StreamLine[][] {
  if (lines.length === 0) return [];

  const firstLine = lines[0];
  if (!firstLine) return [];

  const groups: StreamLine[][] = [];
  let currentGroup: StreamLine[] = [firstLine];

  for (let i = 1; i < lines.length; i++) {
    const prevLine = lines[i - 1];
    const currentLine = lines[i];

    if (!prevLine || !currentLine) continue;

    // Group consecutive output lines together
    if (prevLine.type === 'output' && currentLine.type === 'output') {
      currentGroup.push(currentLine);
    } else {
      groups.push(currentGroup);
      currentGroup = [currentLine];
    }
  }

  groups.push(currentGroup);
  return groups;
}
