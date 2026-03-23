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

describe('Agent session stream durability', () => {
  it('surfaces durability labels from parsed stream metadata', () => {
    render(
      <ParserProbe
        chunks={[
          {
            text: 'transient output',
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
        ]}
        toolCalls={[
          {
            id: 'tool-1',
            tool: 'Bash',
            input: { command: 'pwd' },
            output: 'ok',
            status: 'complete',
            timestamp: 20,
            cursor: 'cursor-2',
            meta: {
              schemaVersion: 1,
              eventId: 'evt-2',
              streamId: 'session-1',
              blockId: 'tool-1',
              partType: 'tool_result',
              durability: 'durable',
              sequence: null,
              createdAt: new Date('2026-03-23T10:00:01.000Z').toISOString(),
            },
          },
        ]}
        terminal={[]}
      />
    );

    expect(screen.getByText('transient')).toBeInTheDocument();
    expect(screen.getByText('durable')).toBeInTheDocument();
    expect(screen.getByText('transient output')).toBeInTheDocument();
    expect(screen.getByText('ok')).toBeInTheDocument();
  });
});
