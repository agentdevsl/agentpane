import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { useSessionSubscription } from '@/app/hooks/use-session-subscription';
import type { ConnectionState, SessionCallbacks } from '@/lib/streams/client';

let latestCallbacks: SessionCallbacks | null = null;
let rawConnectionState: ConnectionState = 'connected';
const unsubscribeMock = vi.fn();

vi.mock('@/lib/streams/client', () => ({
  subscribeToSession: (_sessionId: string, callbacks: SessionCallbacks) => {
    latestCallbacks = callbacks;

    return {
      unsubscribe: unsubscribeMock,
      getState: () => rawConnectionState,
      getLastCursor: () => 'cursor-1',
      getLastOffset: () => 1,
    };
  },
}));

describe('useSessionSubscription', () => {
  beforeEach(() => {
    latestCallbacks = null;
    rawConnectionState = 'connected';
    unsubscribeMock.mockClear();
    window.dispatchEvent(new Event('online'));
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns the shared stream connection state while the browser is online', async () => {
    const { result } = renderHook(() => useSessionSubscription('session-1', {}));

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    expect(result.current.getLastCursor()).toBe('cursor-1');
  });

  it('surfaces disconnected state while the browser is offline', async () => {
    const { result } = renderHook(() => useSessionSubscription('session-1', {}));

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.connectionState).toBe('disconnected');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });
  });

  it('restores the underlying stream state after the browser comes back online', async () => {
    const { result } = renderHook(() => useSessionSubscription('session-1', {}));

    await waitFor(() => {
      expect(result.current.connectionState).toBe('connected');
    });

    act(() => {
      window.dispatchEvent(new Event('offline'));
    });

    expect(result.current.connectionState).toBe('disconnected');

    act(() => {
      rawConnectionState = 'reconnecting';
      latestCallbacks?.onConnectionStateChange?.('reconnecting');
    });

    expect(result.current.connectionState).toBe('disconnected');

    act(() => {
      window.dispatchEvent(new Event('online'));
    });

    await waitFor(() => {
      expect(result.current.connectionState).toBe('reconnecting');
    });
  });
});
