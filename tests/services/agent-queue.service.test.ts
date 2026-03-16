import { describe, expect, it } from 'vitest';
import { AgentQueueService } from '../../src/services/agent/agent-queue.service';

describe('AgentQueueService', () => {
  const service = new AgentQueueService({} as never);

  it('queueTask returns err with QUEUE_FULL code', async () => {
    const result = await service.queueTask('project-1', 'task-1');
    expect(result.ok).toBe(false);
    if (!result.ok) {
      expect(result.error.code).toBe('QUEUE_FULL');
    }
  });

  it('getQueuePosition returns ok(null)', async () => {
    const result = await service.getQueuePosition('agent-1');
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toBeNull();
    }
  });

  it('getQueueStats returns ok with zero values', async () => {
    const result = await service.getQueueStats();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual({
        totalQueued: 0,
        averageCompletionMs: 0,
        recentCompletions: 0,
      });
    }
  });

  it('getQueuedTasks returns ok with empty array', async () => {
    const result = await service.getQueuedTasks();
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.value).toEqual([]);
    }
  });
});
