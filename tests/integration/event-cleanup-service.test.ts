import { createId } from '@paralleldrive/cuid2';
import { sql } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { eventLog, sessionEvents, settings } from '../../src/db/schema';
import { EventCleanupService } from '../../src/services/event-cleanup.service';
import { SettingsService } from '../../src/services/settings.service';
import { createTestProject } from '../factories/project.factory';
import { createTestSession } from '../factories/session.factory';
import { clearTestDatabase, getTestDb, setupTestDatabase } from '../helpers/database';

/**
 * Helper to insert a session_event with a specific created_at timestamp.
 */
async function insertSessionEvent(
  db: ReturnType<typeof getTestDb>,
  sessionId: string,
  createdAt: string,
  offset: number
) {
  // F05-25: bare CUIDs are session-kind streams.
  const streamKind: 'session' | 'plan' | 'sandbox' | 'terraform' | 'topology' | 'cli-monitor' =
    sessionId === 'cli-monitor'
      ? 'cli-monitor'
      : sessionId.startsWith('plan:')
        ? 'plan'
        : sessionId.startsWith('sandbox:')
          ? 'sandbox'
          : sessionId.startsWith('terraform:')
            ? 'terraform'
            : sessionId.startsWith('topology:')
              ? 'topology'
              : 'session';
  await db.insert(sessionEvents).values({
    id: createId(),
    sessionId,
    streamKind,
    offset,
    type: 'chunk',
    channel: 'chunks',
    data: { text: 'test event' },
    timestamp: Date.now(),
    createdAt,
  });
}

/**
 * Helper to insert an event_log entry with a specific received_at timestamp.
 */
async function insertEventLogEntry(
  db: ReturnType<typeof getTestDb>,
  receivedAt: string,
  deliveryId?: string
) {
  await db.insert(eventLog).values({
    id: createId(),
    eventType: 'push',
    action: 'created',
    status: 'received',
    payload: { test: true },
    deliveryId: deliveryId ?? createId(),
    receivedAt,
  });
}

/**
 * Return an ISO date string N days in the past.
 */
function daysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  return d.toISOString();
}

describe('EventCleanupService (IT-400)', () => {
  let db: ReturnType<typeof getTestDb>;
  let settingsService: SettingsService;
  let cleanupService: EventCleanupService;

  beforeEach(async () => {
    await setupTestDatabase();
    db = getTestDb();
    // Clear settings table
    await db.delete(settings);
    settingsService = new SettingsService(db as any);
    cleanupService = new EventCleanupService(db as any, settingsService as any);
  });

  afterEach(async () => {
    cleanupService.stop();
    await clearTestDatabase();
  });

  it('IT-401: deletes session events older than default retention (60 days)', async () => {
    const project = await createTestProject();
    const session = await createTestSession(project.id);

    // Insert old events (90 days ago) and recent events (5 days ago)
    await insertSessionEvent(db, session.id, daysAgo(90), 1);
    await insertSessionEvent(db, session.id, daysAgo(90), 2);
    await insertSessionEvent(db, session.id, daysAgo(5), 3);

    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(2);

    // Verify only the recent event remains
    const remaining = db.all<{ id: string }>(
      sql`SELECT id FROM session_events WHERE session_id = ${session.id}`
    );
    expect(remaining).toHaveLength(1);
  });

  it('IT-402: deletes event log entries older than default retention (90 days)', async () => {
    // Insert old entries (120 days ago) and recent entries (30 days ago)
    await insertEventLogEntry(db, daysAgo(120));
    await insertEventLogEntry(db, daysAgo(120));
    await insertEventLogEntry(db, daysAgo(30));

    const result = await cleanupService.runCleanup();

    expect(result.eventLogDeleted).toBe(2);

    // Verify only the recent entry remains
    const remaining = db.all<{ id: string }>(sql`SELECT id FROM event_log`);
    expect(remaining).toHaveLength(1);
  });

  it('IT-403: respects custom retention days from settings', async () => {
    // Configure custom retention: 7 days for session events, 14 for event log
    await settingsService.set('retention.sessionEventsDays', 7);
    await settingsService.set('retention.eventLogDays', 14);

    const project = await createTestProject();
    const session = await createTestSession(project.id);

    // 10 days old: older than 7-day session retention, but within 14-day event log retention
    await insertSessionEvent(db, session.id, daysAgo(10), 1);
    // 20 days old: older than both
    await insertEventLogEntry(db, daysAgo(20));
    // 5 days old: within both
    await insertSessionEvent(db, session.id, daysAgo(5), 2);
    await insertEventLogEntry(db, daysAgo(5));

    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(1);
    expect(result.eventLogDeleted).toBe(1);
  });

  it('IT-404: no deletions when all events are within retention period', async () => {
    const project = await createTestProject();
    const session = await createTestSession(project.id);

    await insertSessionEvent(db, session.id, daysAgo(10), 1);
    await insertSessionEvent(db, session.id, daysAgo(20), 2);
    await insertEventLogEntry(db, daysAgo(30));
    await insertEventLogEntry(db, daysAgo(50));

    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(0);
    expect(result.eventLogDeleted).toBe(0);
  });

  it('IT-405: handles empty tables gracefully', async () => {
    // No events inserted at all
    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(0);
    expect(result.eventLogDeleted).toBe(0);
    expect(result.backup).toBeDefined();
  });

  it('IT-406: uses default retention when settings return invalid values', async () => {
    // Store a non-numeric value for retention
    await settingsService.set('retention.sessionEventsDays', 'invalid');

    const project = await createTestProject();
    const session = await createTestSession(project.id);

    // 70 days old: older than default 60 days
    await insertSessionEvent(db, session.id, daysAgo(70), 1);
    // 50 days old: within default 60 days
    await insertSessionEvent(db, session.id, daysAgo(50), 2);

    const result = await cleanupService.runCleanup();

    // Should use default 60 days, so the 70-day-old event is deleted
    expect(result.sessionEventsDeleted).toBe(1);
  });

  it('IT-407: start/stop lifecycle and state tracking', async () => {
    expect(cleanupService.getState().isRunning).toBe(false);
    expect(cleanupService.getState().lastRunAt).toBeNull();
    expect(cleanupService.getState().lastBackupAt).toBeNull();

    cleanupService.start();
    expect(cleanupService.getState().isRunning).toBe(true);

    cleanupService.stop();
    expect(cleanupService.getState().isRunning).toBe(false);
  });

  it('IT-408: stop is idempotent — calling stop twice does not throw', () => {
    cleanupService.start();
    cleanupService.stop();

    // Second stop should be a no-op
    expect(() => cleanupService.stop()).not.toThrow();
    expect(cleanupService.getState().isRunning).toBe(false);
  });

  it('IT-409: start is idempotent — calling start twice does not double-start', () => {
    cleanupService.start();
    cleanupService.start(); // second call is a no-op per F12-04 BackgroundJob contract

    expect(cleanupService.getState().isRunning).toBe(true);

    cleanupService.stop();
    expect(cleanupService.getState().isRunning).toBe(false);
  });

  it('IT-410: runCleanup records lastRunAt in service state', async () => {
    expect(cleanupService.getState().lastRunAt).toBeNull();

    await cleanupService.runCleanup();

    const state = cleanupService.getState();
    expect(state.lastRunAt).not.toBeNull();
    // lastRunAt should be a valid ISO date string
    expect(new Date(state.lastRunAt!).getTime()).toBeGreaterThan(0);
  });

  it('IT-411: cleanup deletes across multiple sessions', async () => {
    const project = await createTestProject();
    const session1 = await createTestSession(project.id);
    const session2 = await createTestSession(project.id);

    // Insert old events for both sessions
    await insertSessionEvent(db, session1.id, daysAgo(90), 1);
    await insertSessionEvent(db, session1.id, daysAgo(90), 2);
    await insertSessionEvent(db, session2.id, daysAgo(90), 1);
    // Insert recent event
    await insertSessionEvent(db, session2.id, daysAgo(5), 2);

    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(3);

    // Only the recent event from session2 should remain
    const remaining = db.all<{ session_id: string }>(sql`SELECT session_id FROM session_events`);
    expect(remaining).toHaveLength(1);
  });

  it('IT-412: cleanup with stream-prefixed session IDs (plan:, sandbox:)', async () => {
    // session_events stores events for non-session streams too
    const planStreamId = `plan:${createId()}`;
    const sandboxStreamId = `sandbox:${createId()}`;

    await insertSessionEvent(db, planStreamId, daysAgo(90), 1);
    await insertSessionEvent(db, sandboxStreamId, daysAgo(90), 1);
    await insertSessionEvent(db, planStreamId, daysAgo(5), 2);

    const result = await cleanupService.runCleanup();

    expect(result.sessionEventsDeleted).toBe(2);

    const remaining = db.all<{ session_id: string }>(sql`SELECT session_id FROM session_events`);
    expect(remaining).toHaveLength(1);
  });

  it('IT-413: backup is skipped when disabled via settings', async () => {
    await settingsService.set('backup.enabled', false);

    const result = await cleanupService.runCleanup();

    expect(result.backup.performed).toBe(false);
    expect(result.backup.skipped).toBe(true);
    expect(result.backup.reason).toContain('disabled');
  });
});
