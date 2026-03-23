import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';
import { StreamPanel } from '@/app/components/features/agent-session-view/stream-panel';
import { useStreamParser } from '@/app/components/features/agent-session-view/use-stream-parser';
import type { SessionChunk, SessionTerminal, SessionToolCall } from '@/app/hooks/use-session';

function ParserProbe({
  chunks,
  toolCalls,
  terminal,
}: {
  chunks: SessionChunk[];
  toolCalls: SessionToolCall[];
  terminal: SessionTerminal[];
}): React.JSX.Element {
  const lines = useStreamParser(chunks, toolCalls, terminal);
  return <StreamPanel lines={lines} isStreaming={false} connectionState="connected" />;
}

describe('Agent session stream grouping', () => {
  it('groups chunk deltas by blockId and orders them by sequence', () => {
    const chunkEvents: SessionChunk[] = [
      {
        text: 'world',
        timestamp: 20,
        cursor: 'cursor-2',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-2',
          streamId: 'session-1',
          blockId: 'block-1',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
          createdAt: new Date('2026-03-23T10:00:01.000Z').toISOString(),
        },
      },
      {
        text: 'hello ',
        timestamp: 10,
        cursor: 'cursor-1',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-1',
          streamId: 'session-1',
          blockId: 'block-1',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 0,
          createdAt: new Date('2026-03-23T10:00:00.000Z').toISOString(),
        },
      },
    ];

    render(<ParserProbe chunks={chunkEvents} toolCalls={[]} terminal={[]} />);

    expect(screen.getByText('hello world')).toBeInTheDocument();
    expect(screen.queryByText('hello ')).not.toBeInTheDocument();
    expect(screen.queryByText('world')).not.toBeInTheDocument();
  });

  it('prefers the durable chunk_end snapshot over replaying transient deltas separately', () => {
    const chunkEvents: SessionChunk[] = [
      {
        text: 'hello ',
        timestamp: 10,
        cursor: 'cursor-1',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-1',
          streamId: 'session-1',
          blockId: 'block-2',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 0,
          createdAt: new Date('2026-03-23T10:00:00.000Z').toISOString(),
        },
      },
      {
        text: 'world',
        timestamp: 20,
        cursor: 'cursor-2',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-2',
          streamId: 'session-1',
          blockId: 'block-2',
          partType: 'chunk_delta',
          durability: 'transient',
          sequence: 1,
          createdAt: new Date('2026-03-23T10:00:01.000Z').toISOString(),
        },
      },
      {
        text: 'hello world',
        timestamp: 30,
        cursor: 'cursor-3',
        meta: {
          schemaVersion: 1,
          eventId: 'evt-3',
          streamId: 'session-1',
          blockId: 'block-2',
          partType: 'chunk_end',
          durability: 'durable',
          sequence: null,
          createdAt: new Date('2026-03-23T10:00:02.000Z').toISOString(),
        },
      },
    ];

    render(<ParserProbe chunks={chunkEvents} toolCalls={[]} terminal={[]} />);

    expect(screen.getAllByText('hello world')).toHaveLength(1);
    expect(screen.getByText('durable')).toBeInTheDocument();
  });
});
