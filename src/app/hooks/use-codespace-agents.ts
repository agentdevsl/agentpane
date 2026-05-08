import { useState } from 'react';
import { apiClient } from '@/lib/api/client';
import type { KnownAgent } from '@/lib/topology/build-from-events';
import { useWatchEffect } from './use-watch-effect';

/**
 * Fetches the codespace's merged agent metadata (name, model, color, skills,
 * tools). Used by the topology view so `buildTopologyFromEvents` can resolve
 * `agentMeta.skills` and render the per-agent skill nodes — without this
 * lookup, the synthetic skill graph stays empty even when agents declare
 * skills in their frontmatter.
 *
 * Returns an empty array while loading or on error so the topology builder
 * still produces a graph (it just lacks skill nodes until agents arrive).
 */
export function useCodespaceAgents(codespaceId: string | null | undefined): KnownAgent[] {
  const [agents, setAgents] = useState<KnownAgent[]>([]);

  useWatchEffect(() => {
    if (!codespaceId) {
      setAgents([]);
      return;
    }
    let cancelled = false;
    void (async () => {
      try {
        const result = await apiClient.projects.getAgents(codespaceId);
        if (cancelled) return;
        if (!result.ok) {
          setAgents([]);
          return;
        }
        setAgents(result.data);
      } catch {
        if (!cancelled) {
          setAgents([]);
        }
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [codespaceId]);

  return agents;
}
