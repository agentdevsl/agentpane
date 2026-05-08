import { afterEach, describe, expect, it } from 'vitest';
import {
  agentStateCollection,
  chunksCollection,
  clearSessionCollections,
  messagesCollection,
  presenceCollection,
  terminalCollection,
  toolCallsCollection,
  workflowCollection,
} from './collections.js';

afterEach(() => {
  clearSessionCollections();
});

describe('clearSessionCollections', () => {
  it('removes only the requested session data', () => {
    chunksCollection.insert({
      id: 'chunk-session-1',
      sessionId: 'session-1',
      text: 'hello',
      timestamp: 1,
    });
    chunksCollection.insert({
      id: 'chunk-session-2',
      sessionId: 'session-2',
      text: 'world',
      timestamp: 2,
    });

    toolCallsCollection.insert({
      id: 'tool-session-1',
      sessionId: 'session-1',
      tool: 'bash',
      input: {},
      status: 'complete',
      timestamp: 1,
    });
    toolCallsCollection.insert({
      id: 'tool-session-2',
      sessionId: 'session-2',
      tool: 'bash',
      input: {},
      status: 'running',
      timestamp: 2,
    });

    presenceCollection.insert({
      userId: 'user-1',
      sessionId: 'session-1',
      lastSeen: 1,
    });
    presenceCollection.insert({
      userId: 'user-2',
      sessionId: 'session-2',
      lastSeen: 2,
    });

    terminalCollection.insert({
      id: 'terminal-session-1',
      sessionId: 'session-1',
      type: 'output',
      data: 'line-1',
      timestamp: 1,
    });
    terminalCollection.insert({
      id: 'terminal-session-2',
      sessionId: 'session-2',
      type: 'output',
      data: 'line-2',
      timestamp: 2,
    });

    workflowCollection.insert({
      id: 'workflow-session-1',
      sessionId: 'session-1',
      type: 'agent:resumed',
      payload: {},
      timestamp: 1,
    });
    workflowCollection.insert({
      id: 'workflow-session-2',
      sessionId: 'session-2',
      type: 'agent:resumed',
      payload: {},
      timestamp: 2,
    });

    agentStateCollection.insert({
      agentId: 'agent-1',
      sessionId: 'session-1',
      status: 'running',
      turn: 1,
      timestamp: 1,
    });
    agentStateCollection.insert({
      agentId: 'agent-2',
      sessionId: 'session-2',
      status: 'idle',
      turn: 2,
      timestamp: 2,
    });

    messagesCollection.insert({
      id: 'message-session-1',
      agentId: 'agent-1',
      sessionId: 'session-1',
      text: 'first',
      turn: 1,
      timestamp: 1,
    });
    messagesCollection.insert({
      id: 'message-session-2',
      agentId: 'agent-2',
      sessionId: 'session-2',
      text: 'second',
      turn: 2,
      timestamp: 2,
    });

    clearSessionCollections('session-1');

    expect(chunksCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(toolCallsCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(presenceCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(terminalCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(workflowCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(agentStateCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);
    expect(messagesCollection.toArray.every((item) => item.sessionId !== 'session-1')).toBe(true);

    expect(chunksCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(toolCallsCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(presenceCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(terminalCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(workflowCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(agentStateCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
    expect(messagesCollection.toArray.some((item) => item.sessionId === 'session-2')).toBe(true);
  });

  it('clears all session collections when sessionId is omitted', () => {
    chunksCollection.insert({
      id: 'chunk-session-1',
      sessionId: 'session-1',
      text: 'hello',
      timestamp: 1,
    });
    terminalCollection.insert({
      id: 'terminal-session-1',
      sessionId: 'session-1',
      type: 'output',
      data: 'line-1',
      timestamp: 1,
    });

    clearSessionCollections();

    expect(chunksCollection.toArray).toHaveLength(0);
    expect(terminalCollection.toArray).toHaveLength(0);
  });
});
