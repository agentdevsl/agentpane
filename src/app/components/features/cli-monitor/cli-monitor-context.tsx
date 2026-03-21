import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
} from 'react';
import { useEventListener } from '@/app/hooks/use-event-listener';
import { useMountEffect } from '@/app/hooks/use-mount-effect';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import { useCliSessions } from '@/lib/cli-monitor/hooks';
import { startCliMonitorSync } from '@/lib/cli-monitor/sync';
import type { AggregateStatus, AlertToast, CliSession, PageState } from './cli-monitor-types';
import { deriveAggregateStatus } from './cli-monitor-utils';

interface CliMonitorContextValue {
  pageState: PageState;
  sessions: CliSession[];
  daemonConnected: boolean;
  aggregateStatus: AggregateStatus;
  alerts: AlertToast[];
  dismissAlert: (id: string) => void;
  connectionError: boolean;
  isOffline: boolean;
}

const CliMonitorContext = createContext<CliMonitorContextValue | null>(null);

export function useCliMonitor(): CliMonitorContextValue {
  const ctx = useContext(CliMonitorContext);
  if (!ctx) throw new Error('useCliMonitor must be used within CliMonitorProvider');
  return ctx;
}

export function CliMonitorProvider({ children }: { children: ReactNode }) {
  const sessions = useCliSessions();
  const [pageState, setPageState] = useState<PageState>('install');
  const [daemonConnected, setDaemonConnected] = useState(false);
  const [alerts, setAlerts] = useState<AlertToast[]>([]);
  const [connectionError, setConnectionError] = useState(false);
  const [isOffline, setIsOffline] = useState(!navigator.onLine);
  const alertTimersRef = useRef<Map<string, ReturnType<typeof setTimeout>>>(new Map());

  const dismissAlert = useCallback((id: string) => {
    const timer = alertTimersRef.current.get(id);
    if (timer) {
      clearTimeout(timer);
      alertTimersRef.current.delete(id);
    }
    setAlerts((prev) => prev.filter((a) => a.id !== id));
  }, []);

  const addAlert = useCallback((alert: Omit<AlertToast, 'id' | 'createdAt'>) => {
    const id = `alert-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
    const newAlert: AlertToast = { ...alert, id, createdAt: Date.now() };
    setAlerts((prev) => [newAlert, ...prev].slice(0, 5));

    if (alert.autoDismiss) {
      const timeout = alert.type === 'new-session' ? 3000 : 5000;
      const timer = setTimeout(() => {
        alertTimersRef.current.delete(id);
        setAlerts((prev) => prev.filter((a) => a.id !== id));
      }, timeout);
      alertTimersRef.current.set(id, timer);
    }
  }, []);

  // Cleanup alert timers on unmount
  useMountEffect(() => {
    return () => {
      for (const timer of alertTimersRef.current.values()) {
        clearTimeout(timer);
      }
      alertTimersRef.current.clear();
    };
  });

  // Browser offline/online detection
  useEventListener(window, 'online', () => setIsOffline(false));
  useEventListener(window, 'offline', () => setIsOffline(true));

  // SSE sync via collection-backed sync module
  useMountEffect(() => {
    const cleanup = startCliMonitorSync(apiClient.cliMonitor.getStreamUrl(), {
      onDaemonConnected: () => setDaemonConnected(true),
      onDaemonDisconnected: () => {
        setDaemonConnected(false);
        // Don't reset to 'install' — historical sessions from DB may still be available
      },
      onPageStateChange: setPageState,
      onConnectionOpen: () => setConnectionError(false),
      onConnectionError: () => setConnectionError(true),
      onSessionUpdate: (session, previousStatus) => {
        if (previousStatus && previousStatus !== session.status) {
          if (session.status === 'waiting_for_approval') {
            addAlert({
              type: 'approval',
              title: 'Approval needed',
              detail: `${session.sessionId.slice(0, 7)} \u2014 ${session.goal || 'Unknown task'}`,
              sessionId: session.sessionId,
              autoDismiss: false,
            });
          } else if (session.status === 'waiting_for_input') {
            addAlert({
              type: 'input',
              title: 'Input required',
              detail: `${session.sessionId.slice(0, 7)} \u2014 ${session.goal || 'Unknown task'}`,
              sessionId: session.sessionId,
              autoDismiss: false,
            });
          } else if (session.status === 'idle' && previousStatus === 'working') {
            addAlert({
              type: 'complete',
              title: 'Session completed',
              detail: `${session.sessionId.slice(0, 7)} \u2014 ${session.goal || 'Unknown task'}`,
              sessionId: session.sessionId,
              autoDismiss: true,
            });
          }
        }
      },
      onSessionNew: (session) => {
        addAlert({
          type: 'new-session',
          title: 'New session detected',
          detail: `${session.projectName} \u2014 ${session.goal || session.sessionId.slice(0, 7)}`,
          sessionId: session.sessionId,
          autoDismiss: true,
        });
      },
      onSessionRemoved: () => {
        // Page state is handled reactively via sessions array length
      },
    });

    return cleanup;
  });

  // Derive page state from sessions (including historical DB data)
  // Only upgrade pageState, never downgrade from 'active' — the SSE snapshot
  // handler in sync.ts is the primary authority, this effect catches async
  // collection updates that arrive after the snapshot callback.
  useWatchEffect(() => {
    if (sessions.length > 0) {
      setPageState('active');
    } else if (daemonConnected) {
      setPageState((prev) => (prev === 'active' ? 'active' : 'waiting'));
    }
  }, [sessions.length, daemonConnected]);

  const aggregateStatus = useMemo(() => deriveAggregateStatus(sessions), [sessions]);

  const contextValue = useMemo(
    () => ({
      pageState,
      sessions,
      daemonConnected,
      aggregateStatus,
      alerts,
      dismissAlert,
      connectionError,
      isOffline,
    }),
    [
      pageState,
      sessions,
      daemonConnected,
      aggregateStatus,
      alerts,
      dismissAlert,
      connectionError,
      isOffline,
    ]
  );

  return <CliMonitorContext.Provider value={contextValue}>{children}</CliMonitorContext.Provider>;
}
