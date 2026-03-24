import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SessionStreamService } from '../../src/services/session/session-stream.service';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

describe('IT-026: SessionStreamService.getChannelFromEventType()', () => {
  let service: SessionStreamService;

  beforeEach(async () => {
    await setupTestDatabase();
    const db = getTestDb();
    const mockStreams = {} as any;
    service = new SessionStreamService(db as any, mockStreams);
  });

  afterEach(async () => {
    await clearTestDatabase();
  });

  it('maps "chunk" to "chunks"', () => {
    expect(service.getChannelFromEventType('chunk')).toBe('chunks');
  });

  it('maps tool:start to "toolCalls"', () => {
    expect(service.getChannelFromEventType('tool:start')).toBe('toolCalls');
  });

  it('maps tool:result to "toolCalls"', () => {
    expect(service.getChannelFromEventType('tool:result')).toBe('toolCalls');
  });

  it('maps agent:started to "agent"', () => {
    expect(service.getChannelFromEventType('agent:started')).toBe('agent');
  });

  it('maps agent:completed to "agent"', () => {
    expect(service.getChannelFromEventType('agent:completed')).toBe('agent');
  });

  it('maps agent:error to "agent"', () => {
    expect(service.getChannelFromEventType('agent:error')).toBe('agent');
  });

  it('maps agent:turn to "agent"', () => {
    expect(service.getChannelFromEventType('agent:turn')).toBe('agent');
  });

  it('maps agent:plan_ready to "agent"', () => {
    expect(service.getChannelFromEventType('agent:plan_ready')).toBe('agent');
  });

  it('maps agent:planning to "agent"', () => {
    expect(service.getChannelFromEventType('agent:planning')).toBe('agent');
  });

  it('maps agent:turn_limit to "agent"', () => {
    expect(service.getChannelFromEventType('agent:turn_limit')).toBe('agent');
  });

  it('maps agent:warning to "agent"', () => {
    expect(service.getChannelFromEventType('agent:warning')).toBe('agent');
  });

  it('maps agent:resumed to "agent"', () => {
    expect(service.getChannelFromEventType('agent:resumed')).toBe('agent');
  });

  it('maps terminal:output to "terminal"', () => {
    expect(service.getChannelFromEventType('terminal:output')).toBe('terminal');
  });

  it('maps terminal:input to "terminal"', () => {
    expect(service.getChannelFromEventType('terminal:input')).toBe('terminal');
  });

  it('maps presence:joined to "presence"', () => {
    expect(service.getChannelFromEventType('presence:joined')).toBe('presence');
  });

  it('maps presence:left to "presence"', () => {
    expect(service.getChannelFromEventType('presence:left')).toBe('presence');
  });

  it('maps presence:cursor to "presence"', () => {
    expect(service.getChannelFromEventType('presence:cursor')).toBe('presence');
  });

  it('maps approval:requested to "approval"', () => {
    expect(service.getChannelFromEventType('approval:requested')).toBe('approval');
  });

  it('maps approval:approved to "approval"', () => {
    expect(service.getChannelFromEventType('approval:approved')).toBe('approval');
  });

  it('maps state:update to "state"', () => {
    expect(service.getChannelFromEventType('state:update')).toBe('state');
  });

  it('maps unknown event types to "other"', () => {
    expect(service.getChannelFromEventType('unknown_type' as any)).toBe('other');
  });

  it('maps container-agent: prefixed events to "other"', () => {
    expect(service.getChannelFromEventType('container-agent:started')).toBe('other');
  });

  it('maps topology: prefixed events to "other"', () => {
    expect(service.getChannelFromEventType('topology:agent_spawned')).toBe('other');
  });
});
