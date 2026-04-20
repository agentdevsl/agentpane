// @vitest-environment node
/**
 * F05-11: Container-bridge decodes agent:token:batch into N agent:token events.
 *
 * The agent-runner emits a single JSON line containing `{ type:
 * 'agent:token:batch', data: { deltas: [...] } }` to reduce stdout round-trips.
 * The host bridge must expand this into individual agent:token publishes so
 * downstream consumers see the same wire shape as unbatched streaming.
 */

import { Readable } from 'node:stream';
import { describe, expect, it, vi } from 'vitest';
import {
  type ContainerBridgeOptions,
  createContainerBridge,
} from '../../../src/lib/agents/container-bridge';

function readableFromLines(lines: string[]): Readable {
  const stream = new Readable({
    read() {
      for (const line of lines) {
        this.push(`${line}\n`);
      }
      this.push(null);
    },
  });
  return stream;
}

function makeOptions(publishSpy: ReturnType<typeof vi.fn>): ContainerBridgeOptions {
  return {
    taskId: 'task-1',
    sessionId: 'session-1',
    codespaceId: 'proj-1',
    streams: { publish: publishSpy } as unknown as ContainerBridgeOptions['streams'],
  };
}

describe('container-bridge token batching (F05-11)', () => {
  it('decodes a single batch line into N agent:token publishes', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const bridge = createContainerBridge(makeOptions(publish));
    const batchLine = JSON.stringify({
      type: 'agent:token:batch',
      timestamp: Date.now(),
      taskId: 'task-1',
      sessionId: 'session-1',
      data: {
        deltas: [{ delta: 'one' }, { delta: 'two' }, { delta: 'three' }],
      },
    });
    await bridge.processStream(readableFromLines([batchLine]));

    const tokenCalls = publish.mock.calls.filter((call) => call[1] === 'container-agent:token');
    expect(tokenCalls).toHaveLength(3);
    expect(tokenCalls[0]?.[2]).toMatchObject({ delta: 'one' });
    expect(tokenCalls[1]?.[2]).toMatchObject({ delta: 'two' });
    expect(tokenCalls[2]?.[2]).toMatchObject({ delta: 'three' });
  });

  it('preserves delta order within a batch', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const bridge = createContainerBridge(makeOptions(publish));
    const order: string[] = [];
    publish.mockImplementation(async (_sid, _type, payload: { delta?: string }) => {
      if (payload.delta) order.push(payload.delta);
    });

    const deltas = ['a', 'b', 'c', 'd', 'e'];
    const batchLine = JSON.stringify({
      type: 'agent:token:batch',
      timestamp: 1,
      taskId: 'task-1',
      sessionId: 'session-1',
      data: { deltas: deltas.map((d) => ({ delta: d })) },
    });
    await bridge.processStream(readableFromLines([batchLine]));
    expect(order).toEqual(deltas);
  });

  it('still handles unbatched agent:token lines', async () => {
    const publish = vi.fn().mockResolvedValue(undefined);
    const bridge = createContainerBridge(makeOptions(publish));
    const singleLine = JSON.stringify({
      type: 'agent:token',
      timestamp: 1,
      taskId: 'task-1',
      sessionId: 'session-1',
      data: { delta: 'solo' },
    });
    await bridge.processStream(readableFromLines([singleLine]));
    expect(publish).toHaveBeenCalledWith(
      'session-1',
      'container-agent:token',
      expect.objectContaining({ delta: 'solo' })
    );
  });
});
