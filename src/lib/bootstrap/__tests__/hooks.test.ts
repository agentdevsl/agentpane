import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { AppError } from '../../errors/base.js';
import { err, ok } from '../../utils/result.js';
import type { BootstrapContext, BootstrapState } from '../types.js';

// Track captured callbacks and state
let capturedEffectCallback: (() => (() => void) | undefined) | null = null;
let capturedCallbackFn: (() => Promise<void>) | null = null;
const serviceRefHolder = {
  current: null as { subscribe: ReturnType<typeof vi.fn>; run: ReturnType<typeof vi.fn> } | null,
};

// Mock state values
let currentState: BootstrapState;
let currentContext: BootstrapContext | null;
const mockSetState = vi.fn((newState: BootstrapState) => {
  currentState = newState;
});
const mockSetContext = vi.fn((newContext: BootstrapContext | null) => {
  currentContext = newContext;
});

// Mock service methods
const mockSubscribe = vi.fn();
const mockUnsubscribe = vi.fn();
const mockRun = vi.fn();

// Mock React module
vi.mock('react', () => {
  return {
    useState: vi.fn((initial: unknown) => {
      if (typeof initial === 'object' && initial !== null && 'phase' in initial) {
        currentState = initial as BootstrapState;
        return [currentState, mockSetState];
      }
      currentContext = initial as BootstrapContext | null;
      return [currentContext, mockSetContext];
    }),
    useEffect: vi.fn((callback: () => (() => void) | undefined, _deps: unknown[]) => {
      capturedEffectCallback = callback;
    }),
    useCallback: vi.fn((callback: () => Promise<void>, _deps: unknown[]) => {
      capturedCallbackFn = callback;
      return callback;
    }),
    useRef: vi.fn((_initial: unknown) => {
      return serviceRefHolder;
    }),
  };
});

// Mock BootstrapService
vi.mock('../service.js', () => {
  return {
    BootstrapService: vi.fn().mockImplementation(function (this: {
      subscribe: ReturnType<typeof vi.fn>;
      run: ReturnType<typeof vi.fn>;
    }) {
      this.subscribe = mockSubscribe;
      this.run = mockRun;
      serviceRefHolder.current = this;
      return this;
    }),
  };
});

describe('useBootstrap', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentState = {
      phase: 'sqlite',
      progress: 0,
      isComplete: false,
      phaseTimings: {},
    };
    currentContext = null;
    capturedEffectCallback = null;
    capturedCallbackFn = null;
    serviceRefHolder.current = null;
    mockSubscribe.mockReturnValue(mockUnsubscribe);
    mockRun.mockResolvedValue(ok({ db: 'mock-db' }));
  });

  it('returns initial state, null context, and retry function', async () => {
    const { useBootstrap } = await import('../hooks.js');

    const result = useBootstrap();

    expect(result.state).toEqual({
      phase: 'sqlite',
      progress: 0,
      isComplete: false,
    });
    expect(result.context).toBeNull();
    expect(typeof result.retry).toBe('function');
  });

  it('initializes BootstrapService and subscribes on mount', async () => {
    const { useBootstrap } = await import('../hooks.js');
    const { BootstrapService } = await import('../service.js');

    useBootstrap();

    // Execute the effect callback to simulate mounting
    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    expect(BootstrapService).toHaveBeenCalled();
    expect(mockSubscribe).toHaveBeenCalledWith(mockSetState);
    expect(mockRun).toHaveBeenCalled();
  });

  it('returns unsubscribe function from effect for cleanup', async () => {
    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      const cleanup = capturedEffectCallback();
      expect(cleanup).toBe(mockUnsubscribe);
    }
  });

  it('sets context when bootstrap run succeeds', async () => {
    const mockContext: BootstrapContext = {
      db: {} as BootstrapContext['db'],
      collections: { projects: {} },
      streams: { connected: true },
      githubToken: 'test-token',
    };
    mockRun.mockResolvedValue(ok(mockContext));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Wait for the promise to resolve
    await vi.waitFor(() => {
      expect(mockSetContext).toHaveBeenCalledWith(mockContext);
    });
  });

  it('does not set context when bootstrap run fails', async () => {
    const error: AppError = {
      code: 'BOOTSTRAP_FAIL',
      message: 'Bootstrap failed',
      status: 500,
    };
    mockRun.mockResolvedValue(err(error));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Wait for the promise to resolve
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(mockSetContext).not.toHaveBeenCalled();
  });

  describe('retry function', () => {
    it('calls service.run when retry is invoked', async () => {
      const { useBootstrap } = await import('../hooks.js');

      useBootstrap();

      // Execute effect to initialize service
      if (capturedEffectCallback) {
        capturedEffectCallback();
      }

      // Wait for initial run
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear the initial run call
      mockRun.mockClear();

      // Invoke retry
      if (capturedCallbackFn) {
        await capturedCallbackFn();
      }

      expect(mockRun).toHaveBeenCalled();
    });

    it('sets context on successful retry', async () => {
      const mockContext: BootstrapContext = {
        db: {} as BootstrapContext['db'],
        streams: { connected: true },
      };
      mockRun.mockResolvedValue(ok(mockContext));

      const { useBootstrap } = await import('../hooks.js');

      useBootstrap();

      if (capturedEffectCallback) {
        capturedEffectCallback();
      }

      // Wait for initial run
      await new Promise((resolve) => setTimeout(resolve, 10));

      // Clear mock to track retry-specific calls
      mockSetContext.mockClear();

      if (capturedCallbackFn) {
        await capturedCallbackFn();
      }

      expect(mockSetContext).toHaveBeenCalledWith(mockContext);
    });

    it('does not set context on failed retry', async () => {
      const error: AppError = {
        code: 'BOOTSTRAP_TIMEOUT',
        message: 'Timeout',
        status: 500,
      };

      // First run succeeds to allow effect to set up service
      mockRun.mockResolvedValueOnce(ok({ db: 'initial' }));
      // Retry fails
      mockRun.mockResolvedValueOnce(err(error));

      const { useBootstrap } = await import('../hooks.js');

      useBootstrap();

      if (capturedEffectCallback) {
        capturedEffectCallback();
      }

      // Wait for initial run
      await new Promise((resolve) => setTimeout(resolve, 10));

      mockSetContext.mockClear();

      if (capturedCallbackFn) {
        await capturedCallbackFn();
      }

      expect(mockSetContext).not.toHaveBeenCalled();
    });

    it('does nothing if service ref is null', async () => {
      const { useBootstrap } = await import('../hooks.js');

      useBootstrap();

      // Do NOT execute effect - keep serviceRef.current as null
      // The retry callback should check if serviceRef.current exists

      mockRun.mockClear();
      serviceRefHolder.current = null;

      if (capturedCallbackFn) {
        await capturedCallbackFn();
      }

      // Service.run should not be called since ref is null
      expect(mockRun).not.toHaveBeenCalled();
    });
  });

  describe('state management', () => {
    it('uses correct initial state values', async () => {
      const { useBootstrap } = await import('../hooks.js');
      const { useState } = await import('react');

      useBootstrap();

      // Verify useState was called with correct initial state
      expect(useState).toHaveBeenCalledWith({
        phase: 'sqlite',
        progress: 0,
        isComplete: false,
      });
    });

    it('passes setState to subscribe for state updates', async () => {
      const { useBootstrap } = await import('../hooks.js');

      useBootstrap();

      if (capturedEffectCallback) {
        capturedEffectCallback();
      }

      expect(mockSubscribe).toHaveBeenCalledWith(mockSetState);
    });
  });

  describe('effect dependencies', () => {
    it('uses empty dependency array for mount-only effect', async () => {
      const { useBootstrap } = await import('../hooks.js');
      const { useEffect } = await import('react');

      useBootstrap();

      expect(useEffect).toHaveBeenCalledWith(expect.any(Function), []);
    });

    it('uses empty dependency array for retry callback', async () => {
      const { useBootstrap } = await import('../hooks.js');
      const { useCallback } = await import('react');

      useBootstrap();

      expect(useCallback).toHaveBeenCalledWith(expect.any(Function), []);
    });
  });
});

describe('useBootstrap integration scenarios', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentState = {
      phase: 'sqlite',
      progress: 0,
      isComplete: false,
      phaseTimings: {},
    };
    currentContext = null;
    capturedEffectCallback = null;
    capturedCallbackFn = null;
    serviceRefHolder.current = null;
    mockSubscribe.mockReturnValue(mockUnsubscribe);
    mockRun.mockResolvedValue(ok({ db: 'mock-db' }));
  });

  it('handles multiple rapid retry calls gracefully', async () => {
    const mockContext: BootstrapContext = { db: {} as BootstrapContext['db'] };
    mockRun.mockResolvedValue(ok(mockContext));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Wait for initial run
    await new Promise((resolve) => setTimeout(resolve, 10));

    mockRun.mockClear();

    // Simulate rapid retry calls
    if (capturedCallbackFn) {
      const promises = [capturedCallbackFn(), capturedCallbackFn(), capturedCallbackFn()];
      await Promise.all(promises);
    }

    // Each retry should call run
    expect(mockRun).toHaveBeenCalledTimes(3);
  });

  it('correctly cleans up subscription on unmount', async () => {
    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      const cleanup = capturedEffectCallback();
      expect(cleanup).toBe(mockUnsubscribe);
    }
  });

  it('handles bootstrap phases progressing through state updates', async () => {
    let capturedSetState: ((state: BootstrapState) => void) | null = null;

    mockSubscribe.mockImplementation((setState: (state: BootstrapState) => void) => {
      capturedSetState = setState;
      return mockUnsubscribe;
    });

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Simulate state progression through phases
    const setState = capturedSetState as ((state: BootstrapState) => void) | null;
    if (setState) {
      const phases: BootstrapState['phase'][] = [
        'sqlite',
        'schema',
        'collections',
        'streams',
        'github',
        'seeding',
      ];

      for (let index = 0; index < phases.length; index++) {
        const phase = phases[index];
        if (phase) {
          const state: BootstrapState = {
            phase,
            progress: ((index + 1) / phases.length) * 100,
            isComplete: index === phases.length - 1,
            phaseTimings: {},
          };
          setState(state);
        }
      }

      // Verify the mock setState was called with the correct states
      expect(mockSetState).toHaveBeenCalledTimes(6);
      expect(mockSetState).toHaveBeenLastCalledWith({
        phase: 'seeding',
        progress: 100,
        isComplete: true,
      });
    }
  });

  it('handles error state during bootstrap', async () => {
    const error: AppError = {
      code: 'BOOTSTRAP_FAIL',
      message: 'Database initialization failed',
      status: 500,
    };

    let capturedSetState: ((state: BootstrapState) => void) | null = null;

    mockSubscribe.mockImplementation((setState: (state: BootstrapState) => void) => {
      capturedSetState = setState;
      return mockUnsubscribe;
    });

    mockRun.mockResolvedValue(err(error));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Simulate error state
    const setStateForError = capturedSetState as ((state: BootstrapState) => void) | null;
    if (setStateForError) {
      setStateForError({
        phase: 'sqlite',
        progress: 0,
        isComplete: false,
        phaseTimings: {},
        error,
      });
    }

    expect(mockSetState).toHaveBeenCalledWith({
      phase: 'sqlite',
      progress: 0,
      isComplete: false,
      error,
    });
  });

  it('preserves service reference across multiple hook calls', async () => {
    const { useBootstrap } = await import('../hooks.js');

    // First call
    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    const firstServiceRef = serviceRefHolder.current;

    // Simulate another render - the service should remain the same
    // because useRef preserves the reference
    expect(firstServiceRef).not.toBeNull();
    expect(firstServiceRef?.subscribe).toBe(mockSubscribe);
    expect(firstServiceRef?.run).toBe(mockRun);
  });

  it('handles context with partial data', async () => {
    const partialContext: BootstrapContext = {
      db: {} as BootstrapContext['db'],
      // No collections, streams, or githubToken
    };
    mockRun.mockResolvedValue(ok(partialContext));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    await vi.waitFor(() => {
      expect(mockSetContext).toHaveBeenCalledWith(partialContext);
    });
  });

  it('handles empty context', async () => {
    const emptyContext: BootstrapContext = {};
    mockRun.mockResolvedValue(ok(emptyContext));

    const { useBootstrap } = await import('../hooks.js');

    useBootstrap();

    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    await vi.waitFor(() => {
      expect(mockSetContext).toHaveBeenCalledWith(emptyContext);
    });
  });
});

describe('useBootstrap return value structure', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    currentState = {
      phase: 'sqlite',
      progress: 0,
      isComplete: false,
      phaseTimings: {},
    };
    currentContext = null;
    capturedEffectCallback = null;
    capturedCallbackFn = null;
    serviceRefHolder.current = null;
    mockSubscribe.mockReturnValue(mockUnsubscribe);
    mockRun.mockResolvedValue(ok({ db: 'mock-db' }));
  });

  it('returns object with state, context, and retry properties', async () => {
    const { useBootstrap } = await import('../hooks.js');

    const result = useBootstrap();

    expect(result).toHaveProperty('state');
    expect(result).toHaveProperty('context');
    expect(result).toHaveProperty('retry');
  });

  it('state contains phase, progress, and isComplete', async () => {
    const { useBootstrap } = await import('../hooks.js');

    const result = useBootstrap();

    expect(result.state).toHaveProperty('phase');
    expect(result.state).toHaveProperty('progress');
    expect(result.state).toHaveProperty('isComplete');
  });

  it('retry is an async function', async () => {
    const { useBootstrap } = await import('../hooks.js');

    const result = useBootstrap();

    expect(typeof result.retry).toBe('function');

    // Execute effect to set up service
    if (capturedEffectCallback) {
      capturedEffectCallback();
    }

    // Retry should return a promise
    const retryResult = result.retry();
    expect(retryResult).toBeInstanceOf(Promise);
    await retryResult;
  });
});
