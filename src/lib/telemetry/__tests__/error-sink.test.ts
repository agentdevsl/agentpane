import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  __resetErrorSink,
  captureException,
  getRecentCapturedErrors,
  initSentryIfConfigured,
  setErrorSink,
} from '../error-sink.js';

describe('ErrorSink (F10-04)', () => {
  beforeEach(() => {
    __resetErrorSink();
  });

  afterEach(() => {
    __resetErrorSink();
  });

  it('stores captured errors in the ring buffer with context', () => {
    const err = new Error('boom');
    captureException(err, {
      source: 'test',
      requestId: 'req-1',
      route: '/api/tasks/:id',
      method: 'PATCH',
    });

    const recent = getRecentCapturedErrors();
    expect(recent).toHaveLength(1);
    expect(recent[0]?.message).toBe('boom');
    expect(recent[0]?.name).toBe('Error');
    expect(recent[0]?.context.source).toBe('test');
    expect(recent[0]?.context.requestId).toBe('req-1');
    expect(recent[0]?.context.route).toBe('/api/tasks/:id');
  });

  it('forwards to a registered sink adapter', () => {
    const sink = { capture: vi.fn() };
    setErrorSink(sink);
    const err = new Error('adapter test');
    captureException(err, { source: 'adapter-test', requestId: 'req-2' });
    expect(sink.capture).toHaveBeenCalledTimes(1);
    expect(sink.capture).toHaveBeenCalledWith(
      err,
      expect.objectContaining({ source: 'adapter-test', requestId: 'req-2' })
    );
  });

  it('normalises non-Error values', () => {
    captureException('just a string', { source: 'string-test' });
    captureException({ weird: 'object' }, { source: 'object-test' });

    const recent = getRecentCapturedErrors();
    expect(recent[0]?.message).toBe('just a string');
    expect(recent[1]?.message).toContain('weird');
  });

  it('never throws when the sink itself errors', () => {
    setErrorSink({
      capture() {
        throw new Error('sink failed');
      },
    });
    expect(() => captureException(new Error('underlying'), { source: 'test' })).not.toThrow();
  });

  it('initSentryIfConfigured is a no-op when SENTRY_DSN is absent', () => {
    const prev = process.env.SENTRY_DSN;
    process.env.SENTRY_DSN = undefined;
    try {
      expect(() => initSentryIfConfigured()).not.toThrow();
    } finally {
      if (prev === undefined) {
        process.env.SENTRY_DSN = undefined;
      } else {
        process.env.SENTRY_DSN = prev;
      }
    }
  });
});
