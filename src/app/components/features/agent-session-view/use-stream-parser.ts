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
  durability?: 'transient' | 'durable';
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
      durability: undefined,
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
  durability?: 'transient' | 'durable';
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

type NormalizedChunkEvent = SessionChunk & {
  _eventId: string;
  _groupId: string;
};

type ChunkBlock = {
  id: string;
  text: string;
  timestamp: number;
  agentId?: string;
  durability?: 'transient' | 'durable';
};

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

function compareChunkSequence(a: NormalizedChunkEvent, b: NormalizedChunkEvent): number {
  const aSequence = a.meta?.sequence;
  const bSequence = b.meta?.sequence;

  if (typeof aSequence === 'number' && typeof bSequence === 'number' && aSequence !== bSequence) {
    return aSequence - bSequence;
  }

  if (a.timestamp !== b.timestamp) {
    return a.timestamp - b.timestamp;
  }

  return a._eventId.localeCompare(b._eventId);
}

function normalizeChunkEvents(chunks: SessionChunk[]): NormalizedChunkEvent[] {
  return chunks.map((chunk) => {
    const eventId = getStableEventId(
      'chunk',
      [chunk.timestamp, chunk.agentId],
      chunk.meta,
      chunk.cursor
    );
    const blockId = chunk.meta?.blockId;

    return {
      ...chunk,
      _eventId: eventId,
      _groupId: blockId ? `chunk:block:${blockId}` : `chunk:event:${eventId}`,
    };
  });
}

function buildChunkBlock(events: NormalizedChunkEvent[]): ChunkBlock | null {
  if (events.length === 0) {
    return null;
  }

  const ordered = [...events].sort(compareChunkSequence);
  const durableEvent = [...ordered]
    .filter((event) => event.meta?.durability === 'durable')
    .sort((a, b) => b.timestamp - a.timestamp)[0];
  const canonical = durableEvent ?? ordered[0];
  const firstEvent = ordered[0];

  if (!canonical || !firstEvent) {
    return null;
  }

  const text = durableEvent ? durableEvent.text : ordered.map((event) => event.text).join('');
  if (text.length === 0) {
    return null;
  }

  return {
    id: firstEvent._groupId,
    text,
    timestamp: firstEvent.timestamp,
    agentId: canonical.agentId ?? firstEvent.agentId,
    durability: durableEvent?.meta?.durability ?? ordered[ordered.length - 1]?.meta?.durability,
  };
}

function groupChunkBlocks(chunks: SessionChunk[]): ChunkBlock[] {
  const blocks = new Map<string, NormalizedChunkEvent[]>();

  for (const chunk of normalizeChunkEvents(chunks)) {
    const group = blocks.get(chunk._groupId) ?? [];
    group.push(chunk);
    blocks.set(chunk._groupId, group);
  }

  return [...blocks.values()]
    .map(buildChunkBlock)
    .filter((block): block is ChunkBlock => block !== null)
    .sort((a, b) => a.timestamp - b.timestamp);
}

export function useStreamParser(
  chunks: SessionChunk[],
  toolCalls: SessionToolCall[],
  terminal: SessionTerminal[]
): StreamLine[] {
  return useMemo(() => {
    const lines: StreamLine[] = [];
    const chunkBlocks = groupChunkBlocks(chunks);

    // Merge and sort all events by timestamp
    const allEvents: StreamEvent[] = [
      ...chunkBlocks.map((chunkBlock) => ({
        text: chunkBlock.text,
        timestamp: chunkBlock.timestamp,
        agentId: chunkBlock.agentId,
        _source: 'chunk' as const,
        durability: chunkBlock.durability,
        _eventId: chunkBlock.id,
      })),
      ...toolCalls.map((toolCall) => ({
        ...toolCall,
        _source: 'tool' as const,
        durability: toolCall.meta?.durability,
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
        durability: terminalEvent.meta?.durability,
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
        ).map((line) => ({
          ...line,
          durability: event.durability,
        }));
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
            durability: event.durability,
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
              durability: event.durability,
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
            durability: event.durability,
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
            durability: event.durability,
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
