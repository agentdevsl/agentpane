#!/usr/bin/env bash
# PostgreSQL backup script for AgentPane.
#
# Creates compressed backups using pg_dump with custom format.
#
# Usage:
#   ./scripts/backup-db-pg.sh                    # backs up to data/backups/
#   ./scripts/backup-db-pg.sh /path/to/backup    # custom backup directory
#   DATABASE_URL=postgres://... ./scripts/backup-db-pg.sh

set -euo pipefail

DATABASE_URL="${DATABASE_URL:?DATABASE_URL environment variable is required}"
BACKUP_DIR="${1:-./data/backups}"
MAX_BACKUPS="${MAX_BACKUPS:-7}"
TIMESTAMP="$(date +%Y%m%d_%H%M%S)"
BACKUP_FILE="${BACKUP_DIR}/agentpane_pg_${TIMESTAMP}.dump"

# Ensure backup directory exists
mkdir -p "$BACKUP_DIR"

# Create compressed backup using custom format
echo "Creating PostgreSQL backup..."
pg_dump "$DATABASE_URL" --format=custom --compress=6 --file="$BACKUP_FILE"

# Verify backup
SIZE=$(stat -f%z "$BACKUP_FILE" 2>/dev/null || stat --format=%s "$BACKUP_FILE" 2>/dev/null || echo "unknown")
echo "Backup complete: $BACKUP_FILE ($SIZE bytes)"

# Verify backup integrity
echo "Verifying backup integrity..."
pg_restore --list "$BACKUP_FILE" > /dev/null 2>&1
echo "Backup verification passed."

# Clean up old backups (keep last MAX_BACKUPS)
BACKUP_COUNT=$(find "$BACKUP_DIR" -name "agentpane_pg_*.dump" -type f | wc -l | tr -d ' ')
if [ "$BACKUP_COUNT" -gt "$MAX_BACKUPS" ]; then
  REMOVE_COUNT=$((BACKUP_COUNT - MAX_BACKUPS))
  echo "Cleaning up $REMOVE_COUNT old backup(s)..."
  find "$BACKUP_DIR" -name "agentpane_pg_*.dump" -type f | sort | head -n "$REMOVE_COUNT" | xargs -I {} rm -f "{}"
fi

echo "Done."
