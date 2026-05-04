import { useCallback, useMemo, useState } from 'react';
import { useWatchEffect } from '@/app/hooks/use-watch-effect';
import { apiClient } from '@/lib/api/client';
import type {
  SessionDetail,
  SessionFilters,
  SessionListItem,
  SessionSort,
  StreamEntry,
  StreamEntryType,
  ToolCallEntry,
  ToolCallStats,
} from '../types';
import { calculateTimeOffset, formatDuration, formatTimeOffset } from '../utils/format-duration';
import { calculateToolCallStats, parseToolCallsFromEvents } from '../utils/parse-tool-calls';

// Types for API responses
interface SessionListResponse {
  sessions: SessionListItem[];
  total: number;
  hasMore: boolean;
}

interface SessionDetailResponse {
  session: SessionDetail;
}

/**
 * Hook for fetching sessions list
 */
export function useSessions(codespaceId: string, filters?: SessionFilters, sort?: SessionSort) {
  const [data, setData] = useState<SessionListResponse | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<{ message: string } | null>(null);

  const fetchSessions = useCallback(async () => {
    setIsLoading(true);
    setError(null);

    try {
      const result = await apiClient.sessions.list({
        codespaceId,
        limit: 50,
      });

      if (result.ok) {
        // Transform the response to match our expected type
        const items = (result.data as SessionListItem[]) ?? [];

        // Apply client-side filtering in a single pass
        const statusSet = filters?.status?.length ? new Set(filters.status) : null;
        const searchLower = filters?.search?.toLowerCase() ?? null;

        let fromDate: Date | null = null;
        if (filters?.dateFrom) {
          const d = new Date(filters.dateFrom);
          if (Number.isNaN(d.getTime())) {
            console.warn('[useSessions] Invalid dateFrom filter value:', filters.dateFrom);
          } else {
            fromDate = d;
          }
        }

        let toDate: Date | null = null;
        if (filters?.dateTo) {
          const d = new Date(filters.dateTo);
          if (Number.isNaN(d.getTime())) {
            console.warn('[useSessions] Invalid dateTo filter value:', filters.dateTo);
          } else {
            toDate = d;
          }
        }

        let filtered = items.filter((s) => {
          if (statusSet && !statusSet.has(s.status)) return false;
          if (filters?.agentId && s.agentId !== filters.agentId) return false;
          if (filters?.taskId && s.taskId !== filters.taskId) return false;
          if (searchLower) {
            if (
              !s.title?.toLowerCase().includes(searchLower) &&
              !s.taskTitle?.toLowerCase().includes(searchLower) &&
              !s.agentName?.toLowerCase().includes(searchLower)
            ) {
              return false;
            }
          }
          if (fromDate && new Date(s.createdAt) < fromDate) return false;
          if (toDate && new Date(s.createdAt) > toDate) return false;
          return true;
        });

        // Apply sorting
        if (sort) {
          filtered = [...filtered].sort((a, b) => {
            let aVal: number;
            let bVal: number;

            switch (sort.field) {
              case 'lastActivityAt': {
                // Falls back to createdAt if the server didn't include
                // lastActivityAt (older API responses) so old clients
                // still get a sensible order rather than treating
                // missing fields as 0.
                const aRecency = a.lastActivityAt ?? a.createdAt;
                const bRecency = b.lastActivityAt ?? b.createdAt;
                aVal = new Date(aRecency).getTime();
                bVal = new Date(bRecency).getTime();
                break;
              }
              case 'createdAt':
                aVal = new Date(a.createdAt).getTime();
                bVal = new Date(b.createdAt).getTime();
                break;
              case 'closedAt':
                aVal = a.closedAt ? new Date(a.closedAt).getTime() : 0;
                bVal = b.closedAt ? new Date(b.closedAt).getTime() : 0;
                break;
              case 'duration':
                aVal = a.duration ?? 0;
                bVal = b.duration ?? 0;
                break;
              default: {
                const aRecency = a.lastActivityAt ?? a.createdAt;
                const bRecency = b.lastActivityAt ?? b.createdAt;
                aVal = new Date(aRecency).getTime();
                bVal = new Date(bRecency).getTime();
              }
            }

            return sort.direction === 'asc' ? aVal - bVal : bVal - aVal;
          });
        }

        setData({
          sessions: filtered,
          total: filtered.length,
          hasMore: false,
        });
      } else {
        setError({ message: result.error.message });
      }
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Failed to fetch sessions' });
    } finally {
      setIsLoading(false);
    }
  }, [codespaceId, filters, sort]);

  useWatchEffect(() => {
    void fetchSessions();
  }, [fetchSessions]);

  return { data, isLoading, error, refetch: fetchSessions };
}

interface PartialErrors {
  events?: string;
  summary?: string;
}

interface UseSessionDetailReturn {
  data: SessionDetailResponse | null;
  isLoading: boolean;
  error: { message: string } | null;
  partialErrors: PartialErrors | null;
  refetch: () => Promise<void>;
}

/**
 * Hook for fetching session detail with events and summary.
 * Returns partial errors when events or summary fail but session succeeds.
 */
export function useSessionDetail(sessionId: string | null): UseSessionDetailReturn {
  const [data, setData] = useState<SessionDetailResponse | null>(null);
  const [isLoading, setIsLoading] = useState(false);
  const [error, setError] = useState<{ message: string } | null>(null);
  const [partialErrors, setPartialErrors] = useState<PartialErrors | null>(null);

  const fetchDetail = useCallback(async () => {
    if (!sessionId) {
      setData(null);
      setPartialErrors(null);
      return;
    }

    setIsLoading(true);
    setError(null);
    setPartialErrors(null);

    try {
      // Fetch session, events, and summary in parallel
      const [sessionResult, eventsResult, summaryResult] = await Promise.all([
        apiClient.sessions.get(sessionId),
        apiClient.sessions.getEvents(sessionId, { limit: 1000 }),
        apiClient.sessions.getSummary(sessionId),
      ]);

      if (!sessionResult.ok) {
        setError({ message: sessionResult.error.message });
        return;
      }

      // Track partial errors for non-critical failures
      const errors: PartialErrors = {};

      // Transform the response to match our expected type
      const session = sessionResult.data as unknown as SessionDetail;

      // Get events from the events endpoint
      let events: SessionDetail['events'] = [];
      if (eventsResult.ok && eventsResult.data) {
        events = eventsResult.data.map((e) => ({
          id: e.id,
          type: e.type as SessionDetail['events'][0]['type'],
          timestamp: e.timestamp,
          data: e.data,
        }));
      } else if (!eventsResult.ok) {
        errors.events = eventsResult.error.message;
      }

      // Get metrics from summary
      type SummaryData = {
        sessionId: string;
        durationMs: number | null;
        turnsCount: number;
        tokensUsed: number;
        filesModified: number;
        linesAdded: number;
        linesRemoved: number;
        costUsd?: number | null;
        finalStatus: 'success' | 'failed' | 'cancelled' | null;
        session: { id: string; status: string; title: string | null };
      };
      let summary: SummaryData | null = null;
      if (summaryResult.ok) {
        summary = summaryResult.data;
      } else {
        errors.summary = summaryResult.error.message;
      }

      // Set partial errors if any occurred
      if (Object.keys(errors).length > 0) {
        setPartialErrors(errors);
      }

      // Ensure required fields have defaults
      setData({
        session: {
          ...session,
          events,
          filesModified: summary?.filesModified ?? session.filesModified ?? 0,
          linesAdded: summary?.linesAdded ?? session.linesAdded ?? 0,
          linesRemoved: summary?.linesRemoved ?? session.linesRemoved ?? 0,
          testsRun: session.testsRun ?? 0,
          testsPassed: session.testsPassed ?? 0,
          turnsUsed: summary?.turnsCount ?? session.turnsUsed ?? 0,
          tokensUsed: summary?.tokensUsed ?? session.tokensUsed ?? 0,
          duration: summary?.durationMs ?? session.duration ?? null,
          costUsd: summary?.costUsd ?? session.costUsd ?? null,
          skillId: session.skillId ?? null,
          skillName: session.skillName ?? null,
        },
      });
    } catch (err) {
      setError({ message: err instanceof Error ? err.message : 'Failed to fetch session' });
    } finally {
      setIsLoading(false);
    }
  }, [sessionId]);

  useWatchEffect(() => {
    void fetchDetail();
  }, [fetchDetail]);

  return { data, isLoading, error, partialErrors, refetch: fetchDetail };
}

/**
 * Tool start event data structure
 */
interface ToolStartData {
  id?: string;
  tool?: string;
  name?: string;
  input?: Record<string, unknown>;
}

/**
 * Tool result event data structure
 */
interface ToolResultData {
  id?: string;
  tool?: string;
  name?: string;
  input?: Record<string, unknown>;
  output?: unknown;
  error?: string;
  isError?: boolean;
  duration?: number;
}

/**
 * Parse session events into stream entries for display.
 * Consolidates tool:start and tool:result events into single entries.
 * Marks events before first tool call as "startup" events for separate display.
 */
export function parseEventsToStreamEntries(
  events: SessionDetail['events'],
  sessionStartTime: number
): StreamEntry[] {
  if (!events || events.length === 0) {
    return [];
  }

  // Build a map of tool:start events by ID for pairing
  // Support both standard (tool:start) and container-agent events
  const toolStartEvents = new Map<
    string,
    { event: SessionDetail['events'][0]; data: ToolStartData }
  >();

  for (const event of events) {
    const isToolStart = event.type === 'tool:start' || event.type === 'container-agent:tool:start';
    if (isToolStart) {
      // Normalize container-agent data: toolId -> id, toolName -> tool
      const rawData = event.data as Record<string, unknown>;
      const data: ToolStartData = {
        id: (rawData.toolId as string) ?? (rawData.id as string),
        tool: (rawData.toolName as string) ?? (rawData.tool as string),
        name: (rawData.name as string) ?? (rawData.toolName as string),
        input: rawData.input as Record<string, unknown> | undefined,
      };
      if (data.id) {
        toolStartEvents.set(data.id, { event, data });
      }
    }
  }

  // Build map of tool:result events by ID for instant lookup
  const toolResultEvents = new Map<
    string,
    { event: SessionDetail['events'][0]; data: Record<string, unknown> }
  >();
  for (const event of events) {
    const isToolResult =
      event.type === 'tool:result' || event.type === 'container-agent:tool:result';
    if (isToolResult) {
      const rawData = event.data as Record<string, unknown>;
      const toolId = (rawData.toolId as string) ?? (rawData.id as string);
      if (toolId) {
        toolResultEvents.set(toolId, { event, data: rawData });
      }
    }
  }

  // Track which tool:start events have been paired with results
  const pairedToolStartIds = new Set<string>();

  const entries: StreamEntry[] = [];

  for (const event of events) {
    const timeOffsetMs = calculateTimeOffset(event.timestamp, sessionStartTime);
    const timeOffset = formatTimeOffset(timeOffsetMs);

    // Determine entry type based on event type
    let type: StreamEntryType = 'system';
    let content = '';
    let toolCall: StreamEntry['toolCall'];

    // Handle container-agent events by normalizing to standard processing
    const eventType = event.type;

    // Container-agent tool events - normalize data and process
    if (eventType === 'container-agent:tool:start') {
      const rawData = event.data as Record<string, unknown>;
      const toolData: ToolStartData = {
        id: (rawData.toolId as string) ?? (rawData.id as string),
        tool: (rawData.toolName as string) ?? (rawData.tool as string),
        name: (rawData.name as string) ?? (rawData.toolName as string),
        input: rawData.input as Record<string, unknown> | undefined,
      };
      const toolId = toolData.id;

      // Check for matching result using pre-built map
      const hasMatchingResult = toolId ? toolResultEvents.has(toolId) : false;

      if (hasMatchingResult) continue;

      type = 'tool';
      const toolName = toolData.tool ?? toolData.name ?? 'Unknown';
      content = toolName;
      toolCall = {
        name: toolName,
        input: toolData.input ?? {},
        status: 'running',
        startTimeOffset: timeOffset,
      };

      entries.push({
        id: event.id,
        type,
        timestamp: event.timestamp,
        timeOffset,
        content,
        toolCall,
      });
      continue;
    }

    if (eventType === 'container-agent:tool:result') {
      type = 'tool';
      const rawData = event.data as Record<string, unknown>;
      const resultData = {
        id: (rawData.toolId as string) ?? (rawData.id as string),
        tool: (rawData.toolName as string) ?? (rawData.tool as string),
        name: (rawData.name as string) ?? (rawData.toolName as string),
        input: rawData.input as Record<string, unknown> | undefined,
        output: rawData.output ?? rawData.result,
        error: rawData.error as string | undefined,
        isError: rawData.isError as boolean | undefined,
        duration: rawData.durationMs as number | undefined,
      };
      const toolId = resultData.id;
      const toolName = resultData.tool ?? resultData.name ?? 'Unknown';
      const hasError = resultData.error || resultData.isError;

      let startTimeOffset = timeOffset;
      let duration: number | undefined;

      if (toolId) {
        const startEntry = toolStartEvents.get(toolId);
        if (startEntry) {
          pairedToolStartIds.add(toolId);
          const startOffsetMs = calculateTimeOffset(startEntry.event.timestamp, sessionStartTime);
          startTimeOffset = formatTimeOffset(startOffsetMs);
          duration = resultData.duration ?? event.timestamp - startEntry.event.timestamp;
        }
      }

      content = toolName;
      toolCall = {
        name: toolName,
        input:
          (toolId ? toolStartEvents.get(toolId)?.data.input : undefined) ?? resultData.input ?? {},
        output: resultData.output,
        status: hasError ? 'error' : 'complete',
        startTimeOffset,
        endTimeOffset: timeOffset,
        duration,
        // When `isError` is set on a tool:result, the failure reason is
        // commonly in the result/output text (the SDK and our synthetic
        // orphan-flush emit both populate `result`, not a separate
        // `error` field). Fall through to the output before the generic
        // "Tool execution failed" sentinel so the UI surfaces the real
        // message — e.g. "Agent runner terminated before this tool
        // returned" — instead of swallowing it under a placeholder.
        error: hasError
          ? (resultData.error ??
            (typeof resultData.output === 'string' ? resultData.output : null) ??
            'Tool execution failed')
          : undefined,
      };

      entries.push({
        id: event.id,
        type,
        timestamp: event.timestamp,
        timeOffset,
        content,
        toolCall,
      });
      continue;
    }

    // Skip only high-frequency token events
    if (eventType === 'container-agent:token') {
      continue;
    }

    // Handle container-agent system events
    if (eventType === 'container-agent:started') {
      type = 'system';
      content = `Session started`;
      entries.push({
        id: event.id,
        type,
        timestamp: event.timestamp,
        timeOffset,
        content,
        isStartup: true, // Always startup
      } as StreamEntry);
      continue;
    }
    if (eventType === 'container-agent:complete') {
      type = 'system';
      content = `Session completed successfully`;
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventType === 'container-agent:turn') {
      const turnData = event.data as { turn?: number; maxTurns?: number };
      type = 'system';
      content = `Turn ${turnData.turn ?? '?'}/${turnData.maxTurns ?? '?'}`;
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventType === 'container-agent:error') {
      type = 'system';
      content = `Error: ${(event.data as { error?: string })?.error ?? 'Unknown error'}`;
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventType === 'container-agent:message') {
      const msgData = event.data as { role?: string; content?: string };
      const msgContent = msgData.content ?? '';

      // Map role to entry type. The 'approval' role is reserved for the
      // plan-approval flow (`Plan ready — waiting for human approval`,
      // `Plan auto-approved by agent`, etc.) and renders as its own
      // distinct entry type so the UI can lift these out of the muted
      // "startup" pile and surface them as scannable state changes.
      if (msgData.role === 'user') {
        type = 'user';
      } else if (msgData.role === 'approval') {
        type = 'approval';
      } else if (msgData.role === 'system') {
        type = 'system';
      } else {
        type = 'assistant';
      }
      content = msgContent;

      // Only true `system` messages are startup/status. Approval entries
      // are state-change events and must NOT be marked startup, otherwise
      // they get the same muted styling as `Sandbox container ready`.
      const isStartup = type === 'system';
      entries.push({
        id: event.id,
        type,
        timestamp: event.timestamp,
        timeOffset,
        content,
        isStartup,
      } as StreamEntry);
      continue;
    }
    if (eventType === 'container-agent:plan_ready' || eventType === 'container-agent:cancelled') {
      continue; // Skip these events in the stream view
    }

    // Task creation events (type not in strict union, compare as string)
    const eventTypeStr = event.type as string;
    if (eventTypeStr === 'task-creation:started') {
      type = 'system';
      content = 'Task creation session started';
      entries.push({
        id: event.id,
        type,
        timestamp: event.timestamp,
        timeOffset,
        content,
        isStartup: true,
      } as StreamEntry);
      continue;
    }
    if (eventTypeStr === 'task-creation:message') {
      const msgData = event.data as { role?: string; content?: string };
      // Skip assistant messages that contain raw JSON task_suggestion — the
      // task-creation:suggestion event renders a cleaner version
      if (msgData.role === 'assistant' && msgData.content?.includes('"task_suggestion"')) {
        continue;
      }
      if (msgData.role === 'user') {
        type = 'user';
      } else if (msgData.role === 'assistant') {
        type = 'assistant';
      } else {
        type = 'system';
      }
      content = msgData.content ?? '';
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventTypeStr === 'task-creation:questions') {
      const qData = event.data as {
        questions?: { questions?: Array<{ header?: string; question?: string }> };
      };
      const questions = qData.questions?.questions ?? [];
      type = 'assistant';
      content = questions
        .map((q) => `**${q.header ?? 'Question'}**\n${q.question ?? ''}`)
        .join('\n\n');
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventTypeStr === 'task-creation:processing') {
      const procData = event.data as { message?: string };
      type = 'system';
      content = procData.message ?? 'Processing...';
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventTypeStr === 'task-creation:suggestion') {
      const sugData = event.data as { suggestion?: { title?: string; description?: string } };
      type = 'assistant';
      content = sugData.suggestion?.description
        ? `**${sugData.suggestion.title ?? 'Task Suggestion'}**\n\n${sugData.suggestion.description}`
        : (sugData.suggestion?.title ?? 'Task suggestion generated');
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventTypeStr === 'task-creation:completed') {
      type = 'system';
      content = 'Task created successfully';
      entries.push({ id: event.id, type, timestamp: event.timestamp, timeOffset, content });
      continue;
    }
    if (eventTypeStr === 'task-creation:cancelled') {
      continue;
    }

    // Memory events
    if (eventTypeStr === 'memory:insights_injected') {
      continue; // Skip internal memory events
    }

    switch (event.type) {
      case 'agent:started':
        type = 'system';
        content = `Session started. ${(event.data as { message?: string })?.message ?? ''}`;
        break;

      case 'agent:completed':
        type = 'system';
        content = `Session completed successfully. ${(event.data as { message?: string })?.message ?? ''}`;
        break;

      case 'agent:error':
        type = 'system';
        content = `Error: ${(event.data as { error?: string })?.error ?? 'Unknown error'}`;
        break;

      case 'chunk': {
        const chunkData = event.data as {
          role?: string;
          content?: string;
          model?: string;
          usage?: { inputTokens?: number; outputTokens?: number; totalTokens?: number };
        };
        if (chunkData.role === 'user') {
          type = 'user';
          content = chunkData.content ?? '';
        } else if (chunkData.role === 'assistant') {
          type = 'assistant';
          const rawContent = chunkData.content ?? '';
          // Extract markdown from JSON task_suggestion responses
          // The assistant may return a ```json code fence containing a task_suggestion object
          const jsonMatch = rawContent.match(
            /```(?:json)?\s*\n?\s*\{[\s\S]*?"type"\s*:\s*"task_suggestion"[\s\S]*?"description"\s*:\s*"([\s\S]*?)"\s*,?\s*\n?\s*"(?:labels|priority)/
          );
          if (jsonMatch) {
            try {
              // Try to parse the full JSON to get the clean description
              const jsonStr = rawContent
                .replace(/```(?:json)?\s*\n?/, '')
                .replace(/\n?```\s*$/, '');
              const parsed = JSON.parse(jsonStr);
              if (parsed.description) {
                content = `**${parsed.title ?? 'Task Suggestion'}**\n\n${parsed.description}`;
              } else {
                content = rawContent;
              }
            } catch (parseErr) {
              console.warn('[session-events] Failed to parse task_suggestion JSON', parseErr);
              content = rawContent;
            }
          } else {
            content = rawContent;
          }
        } else {
          type = 'system';
          content = chunkData.content ?? '';
        }
        // Extract model and usage for display
        const model = chunkData.model;
        const usage = chunkData.usage
          ? {
              inputTokens: chunkData.usage.inputTokens ?? 0,
              outputTokens: chunkData.usage.outputTokens ?? 0,
              totalTokens: chunkData.usage.totalTokens ?? 0,
            }
          : undefined;

        entries.push({
          id: event.id,
          type,
          timestamp: event.timestamp,
          timeOffset,
          content,
          model,
          usage,
        });
        continue;
      }

      case 'tool:start': {
        // Check if this start event will be paired with a result
        const toolData = event.data as ToolStartData;
        const toolId = toolData.id;

        // Check for matching result using pre-built map
        const hasMatchingResult = toolId ? toolResultEvents.has(toolId) : false;

        if (hasMatchingResult) {
          // Skip this event - it will be consolidated with the result
          continue;
        }

        // No matching result - show as running
        type = 'tool';
        const toolName = toolData.tool ?? toolData.name ?? 'Unknown';
        content = `${toolName}`;
        toolCall = {
          name: toolName,
          input: toolData.input ?? {},
          status: 'running',
          startTimeOffset: timeOffset,
        };
        break;
      }

      case 'tool:result': {
        type = 'tool';
        const resultData = event.data as ToolResultData;
        const toolId = resultData.id;

        // Get tool name from result or paired start event
        const toolName = resultData.tool ?? resultData.name ?? 'Unknown';
        const hasError = resultData.error || resultData.isError;

        // Find the paired start event for timing info
        let startTimeOffset = timeOffset;
        let duration: number | undefined;

        if (toolId) {
          const startEntry = toolStartEvents.get(toolId);
          if (startEntry) {
            pairedToolStartIds.add(toolId);
            const startOffsetMs = calculateTimeOffset(startEntry.event.timestamp, sessionStartTime);
            startTimeOffset = formatTimeOffset(startOffsetMs);
            duration = resultData.duration ?? event.timestamp - startEntry.event.timestamp;
          }
        }

        content = toolName;
        toolCall = {
          name: toolName,
          input:
            (toolId ? toolStartEvents.get(toolId)?.data.input : undefined) ??
            resultData.input ??
            {},
          output: resultData.output,
          status: hasError ? 'error' : 'complete',
          startTimeOffset,
          endTimeOffset: timeOffset,
          duration,
          // When `isError` is set on a tool:result, the failure reason is
          // commonly in the result/output text (the SDK and our synthetic
          // orphan-flush emit both populate `result`, not a separate
          // `error` field). Fall through to the output before the generic
          // "Tool execution failed" sentinel so the UI surfaces the real
          // message — e.g. "Agent runner terminated before this tool
          // returned" — instead of swallowing it under a placeholder.
          error: hasError
            ? (resultData.error ??
              (typeof resultData.output === 'string' ? resultData.output : null) ??
              'Tool execution failed')
            : undefined,
        };
        break;
      }

      case 'terminal:input':
        type = 'user';
        content = (event.data as { input?: string })?.input ?? '';
        break;

      case 'terminal:output':
        type = 'assistant';
        content = (event.data as { output?: string })?.output ?? '';
        break;

      case 'state:update': {
        // Show state:update events with stage info in the startup section
        const stateData = event.data as Record<string, unknown>;
        if (stateData.stage || stateData.taskId || stateData.sessionId) {
          type = 'system';
          // Format nicely: show stage and message
          const stage = stateData.stage as string | undefined;
          const message = stateData.message as string | undefined;
          content = message || stage || 'Status update';
          entries.push({
            id: event.id,
            type,
            timestamp: event.timestamp,
            timeOffset,
            content,
            isStartup: true,
          } as StreamEntry);
          continue;
        }
        type = 'system';
        content = JSON.stringify(event.data);
        break;
      }

      case 'agent:metrics': {
        type = 'system';
        const metricsData = event.data as {
          totalCostUsd?: number;
          durationMs?: number;
          numTurns?: number;
          stopReason?: string;
        };
        const parts: string[] = [];
        if (metricsData.totalCostUsd != null)
          parts.push(`Cost: $${metricsData.totalCostUsd.toFixed(3)}`);
        if (metricsData.durationMs != null)
          parts.push(`Duration: ${formatDuration(metricsData.durationMs)}`);
        if (metricsData.numTurns != null) parts.push(`Turns: ${metricsData.numTurns}`);
        if (metricsData.stopReason) parts.push(`Stop: ${metricsData.stopReason}`);
        content =
          parts.length > 0 ? `Session Metrics — ${parts.join(' · ')}` : 'Session metrics recorded';
        break;
      }

      case 'agent:tool_progress': {
        type = 'system';
        const progressData = event.data as { toolName?: string; elapsedSeconds?: number };
        content = `Tool ${progressData.toolName ?? 'unknown'} running (${progressData.elapsedSeconds?.toFixed(1) ?? '?'}s)`;
        break;
      }

      case 'agent:compacted': {
        type = 'system';
        const compactData = event.data as { trigger?: string; preTokens?: number };
        content = `Context compacted (${compactData.trigger ?? 'auto'}, ${compactData.preTokens?.toLocaleString() ?? '?'} tokens before)`;
        break;
      }

      default: {
        // Show events with stage info in the startup section
        const rawData = event.data as Record<string, unknown>;
        if (rawData && typeof rawData === 'object') {
          if (rawData.stage || (rawData.taskId && rawData.sessionId && rawData.message)) {
            type = 'system';
            const stage = rawData.stage as string | undefined;
            const message = rawData.message as string | undefined;
            content = message || stage || 'Status update';
            entries.push({
              id: event.id,
              type,
              timestamp: event.timestamp,
              timeOffset,
              content,
              isStartup: true,
            } as StreamEntry);
            continue;
          }
        }
        type = 'system';
        content = JSON.stringify(event.data);
      }
    }

    entries.push({
      id: event.id,
      type,
      timestamp: event.timestamp,
      timeOffset,
      content,
      toolCall,
    });
  }

  return entries;
}

const EMPTY_STATS: ToolCallStats = {
  totalCalls: 0,
  errorCount: 0,
  avgDurationMs: 0,
  totalDurationMs: 0,
  toolBreakdown: [],
};

const EMPTY_RESULT = {
  entries: [] as StreamEntry[],
  toolCalls: [] as ToolCallEntry[],
  toolCallStats: EMPTY_STATS,
  isLoading: false,
  error: undefined as string | undefined,
};

/**
 * Hook for session events with parsed stream entries and tool call data.
 * Memoizes parsing results to avoid recomputation on every render.
 */
export function useSessionEvents(session: SessionDetail | null) {
  return useMemo(() => {
    if (!session) {
      return EMPTY_RESULT;
    }

    // Validate session timestamp
    const sessionStartDate = new Date(session.createdAt);
    const sessionStartTime = sessionStartDate.getTime();

    if (Number.isNaN(sessionStartTime)) {
      console.error(
        '[useSessionEvents] Invalid session createdAt timestamp:',
        session.createdAt,
        'Session ID:',
        session.id
      );
      return {
        ...EMPTY_RESULT,
        error: 'Session has invalid timestamp data',
      };
    }

    const entries = parseEventsToStreamEntries(session.events, sessionStartTime);
    const toolCalls = parseToolCallsFromEvents(session.events, sessionStartTime);
    const toolCallStats = calculateToolCallStats(toolCalls);

    return { entries, toolCalls, toolCallStats, isLoading: false, error: undefined };
  }, [session]);
}
