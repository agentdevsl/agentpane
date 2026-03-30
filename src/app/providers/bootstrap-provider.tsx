import { createContext, useContext, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { ServiceProvider } from '@/app/services/service-context';
import type { Services } from '@/app/services/services';
import { useBootstrap } from '../../lib/bootstrap/hooks.js';
import type { BootstrapContext as BootstrapContextType } from '../../lib/bootstrap/types.js';
import type { AppError } from '../../lib/errors/base.js';

const BootstrapContext = createContext<BootstrapContextType | null>(null);

export const BootstrapProvider = ({ children }: { children: React.ReactNode }) => {
  const { state, context, retry } = useBootstrap();

  if (state.error) {
    return <BootstrapErrorUI error={state.error} onRetry={retry} />;
  }

  if (!state.isComplete || !context) {
    return <BootstrapLoadingUI phase={state.phase} progress={state.progress} />;
  }

  return (
    <BootstrapProviderInner context={context} retry={retry}>
      {children}
    </BootstrapProviderInner>
  );
};

// Check if running in browser environment
const isBrowser = typeof window !== 'undefined' && typeof document !== 'undefined';

const BootstrapProviderInner = ({
  context,
  retry,
  children,
}: {
  context: BootstrapContextType;
  retry: () => Promise<void>;
  children: React.ReactNode;
}) => {
  const [services, setServices] = useState<
    { ok: true; value: Services | null } | { ok: false; error: AppError } | null
  >(null);

  useWatchEffect(() => {
    if (isBrowser) {
      setServices({ ok: true, value: null });
      return;
    }

    // Server mode - dynamically import server-only modules
    void (async () => {
      try {
        const [{ drizzle }, { sqlite }, schemaModule, { createServices }] = await Promise.all([
          import('drizzle-orm/better-sqlite3'),
          import('@/db/client.js'),
          import('@/db/schema/index.js'),
          import('@/app/services/services'),
        ]);

        if (!sqlite) {
          setServices({ ok: true, value: null });
          return;
        }

        const db = drizzle(sqlite, { schema: schemaModule });
        type DurableStreamsServer = Parameters<typeof createServices>[0]['streams'];
        const streams = (context.streams as DurableStreamsServer) ?? {
          createStream: async () => undefined,
          publish: async () => undefined,
          subscribe: async function* () {
            yield { type: 'chunk', data: {} };
          },
        };
        setServices(createServices({ db, streams }));
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        setServices({
          ok: false,
          error: { code: 'SERVICE_INITIALIZATION_FAILED', message, status: 500 } as AppError,
        });
      }
    })();
  }, [context]);

  if (!services) {
    return <BootstrapLoadingUI phase="services" progress={90} />;
  }

  if (!services.ok) {
    return <BootstrapErrorUI error={services.error} onRetry={retry} />;
  }

  // Render with ServiceProvider (null on client, services on server)
  return (
    <BootstrapContext.Provider value={context}>
      <ServiceProvider services={services.value}>{children}</ServiceProvider>
    </BootstrapContext.Provider>
  );
};

export const useBootstrapContext = () => {
  const context = useContext(BootstrapContext);
  if (!context) {
    throw new Error('useBootstrapContext must be used within BootstrapProvider');
  }
  return context;
};

type LoadingProps = {
  phase: string;
  progress: number;
};

type ErrorProps = {
  error: AppError;
  onRetry: () => Promise<void>;
};

const BootstrapLoadingUI = ({ phase, progress }: LoadingProps) => (
  <div>
    <p>Bootstrapping: {phase}</p>
    <p>{Math.round(progress)}%</p>
  </div>
);

const BootstrapErrorUI = ({ error, onRetry }: ErrorProps) => (
  <div>
    <p>Bootstrap error: {error.message}</p>
    <button type="button" onClick={onRetry}>
      Retry
    </button>
  </div>
);
