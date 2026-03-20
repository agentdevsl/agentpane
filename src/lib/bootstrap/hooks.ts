import { useCallback, useEffect, useRef, useState } from 'react';
import { BootstrapService } from './service.js';
import type { BootstrapContext, BootstrapState } from './types.js';

export const useBootstrap = (): {
  state: BootstrapState;
  context: BootstrapContext | null;
  retry: () => Promise<void>;
} => {
  const [state, setState] = useState<BootstrapState>({
    phase: 'sqlite',
    progress: 0,
    isComplete: false,
    phaseTimings: {},
  });
  const [context, setContext] = useState<BootstrapContext | null>(null);
  const serviceRef = useRef<BootstrapService | null>(null);

  useEffect(() => {
    const service = new BootstrapService();
    serviceRef.current = service;
    const unsubscribe = service.subscribe(setState);

    void service.run().then((result) => {
      if (result.ok) {
        setContext(result.value);
      }
    });

    return unsubscribe;
  }, []);

  const retry = useCallback(async () => {
    if (!serviceRef.current) {
      return;
    }

    const result = await serviceRef.current.run();
    if (result.ok) {
      setContext(result.value);
    }
  }, []);

  return { state, context, retry };
};
