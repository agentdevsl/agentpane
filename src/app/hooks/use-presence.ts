import { useEffect, useState } from 'react';

export type PresenceUser = {
  userId: string;
  lastSeen: number;
  cursor?: { x: number; y: number };
  activeFile?: string;
};

export function usePresence(
  sessionId: string,
  _userId: string
): {
  users: PresenceUser[];
} {
  const [users, setUsers] = useState<PresenceUser[]>([]);

  useEffect(() => {
    let mounted = true;

    const refresh = async () => {
      try {
        const response = await fetch(`/api/sessions/${sessionId}/presence`);
        const data = await response.json();
        if (mounted && data.ok) {
          setUsers(data.data as PresenceUser[]);
        }
      } catch {
        // API may not be ready
      }
    };

    void refresh();
    const interval = window.setInterval(refresh, 8000);

    return () => {
      mounted = false;
      window.clearInterval(interval);
    };
  }, [sessionId]);

  // Note: POST heartbeat is intentionally omitted here.
  // useSession already sends presence heartbeats every 10s, and usePresence
  // is always used alongside useSession. This avoids duplicate POSTs.

  return { users };
}
