-- F02-18 (arch29-W2-R): event_outbox timestamps as epoch ms (PG).
--
-- Mirrors SQLite migration v36 (event-outbox-epoch-ms). The previous shape
-- used `timestamptz` columns which made cross-dialect ordering with the
-- SQLite ISO-string columns brittle (lex-compared UTC strings only). Both
-- dialects now use a numeric epoch-ms representation: SQLite stores raw
-- integer epoch ms (mirroring `session_events.timestamp`), PG uses
-- `bigint` for the same reason (PG `integer` is 32-bit and overflows for
-- post-2038 timestamps).
--
-- Strategy: ALTER COLUMN TYPE with a USING clause that extracts seconds via
-- `EXTRACT(EPOCH FROM ...)` and multiplies by 1000. The defaults are dropped
-- before the type change because PG cannot coerce `now()` to `bigint`. After
-- the type change Drizzle's `$defaultFn(() => Date.now())` supplies the
-- application-side default for new inserts.

ALTER TABLE "event_outbox"
  ALTER COLUMN "next_attempt_at" DROP DEFAULT;
ALTER TABLE "event_outbox"
  ALTER COLUMN "next_attempt_at" SET DATA TYPE bigint
  USING (EXTRACT(EPOCH FROM "next_attempt_at") * 1000)::bigint;

ALTER TABLE "event_outbox"
  ALTER COLUMN "created_at" DROP DEFAULT;
ALTER TABLE "event_outbox"
  ALTER COLUMN "created_at" SET DATA TYPE bigint
  USING (EXTRACT(EPOCH FROM "created_at") * 1000)::bigint;

-- published_at is nullable; the USING clause must handle NULL transparently.
ALTER TABLE "event_outbox"
  ALTER COLUMN "published_at" SET DATA TYPE bigint
  USING (
    CASE
      WHEN "published_at" IS NULL THEN NULL
      ELSE (EXTRACT(EPOCH FROM "published_at") * 1000)::bigint
    END
  );
