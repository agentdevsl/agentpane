# Backup and Restore

This document covers the AgentPane database backup and restore drill. It is
the operational runbook referenced from the architecture review (theme 11
finding F11-21) and from the rollback runbook (F11-29). It assumes the
operator has cluster access for Kubernetes deployments and host shell access
for Docker / bare-metal deployments.

> **Status:** the `scripts/backup-db-pg.sh` and `scripts/backup-db.sh` scripts
> are checked into the repo; the Helm chart `charts/agentpane/templates/cronjob-backup.yaml`
> wires them to a `CronJob` (default disabled — opt-in via
> `backup.enabled: true`). For Docker Compose / bare-metal you are
> responsible for scheduling the script (cron, systemd timers, etc.).

## 1. Quick reference

| Mode       | Backup script               | Output filename                | Restore command                                    |
|------------|-----------------------------|--------------------------------|-----------------------------------------------------|
| PostgreSQL | `scripts/backup-db-pg.sh`   | `agentpane_pg_<ts>.dump`        | `pg_restore --clean --if-exists --dbname=$URL ...` |
| SQLite     | `scripts/backup-db.sh`      | `agentpane_<ts>.db`             | `cp <file> ./data/agentpane.db`                    |

Both scripts:

* run with `set -euo pipefail` so any error aborts the run;
* `umask 077` (PG) so files are owner-only readable;
* trap on `ERR` to remove partial artefacts (PG);
* keep the most recent `MAX_BACKUPS` (default `7`) artefacts and prune older ones;
* write to `./data/backups/` by default — pass an alternative directory as `$1`.

## 2. Helm CronJob (Kubernetes)

### 2.1 Enable the CronJob

```bash
helm upgrade agentpane charts/agentpane \
  --reuse-values \
  --set backup.enabled=true \
  --set backup.schedule="0 3 * * *" \
  --set backup.retentionDays=7 \
  --set backup.pvc.size=5Gi
```

What this renders:

* `cronjob-backup.yaml` — `kind: CronJob` named `<release>-agentpane-backup`,
  schedule `0 3 * * *` (daily 03:00 UTC), `concurrencyPolicy: Forbid`,
  `restartPolicy: OnFailure`, `activeDeadlineSeconds: 1800`.
* `pvc-backup.yaml` — `kind: PersistentVolumeClaim` named
  `<release>-agentpane-backup`, `5Gi`, `ReadWriteOnce`. Mounted at `/backups`
  inside the backup Pod. Suppress this if you bring your own PVC: set
  `backup.pvc.create: false`.
* The Job uses the **main app image** (`agentpane.image`) so `pg_dump` /
  `sqlite3` and the backup scripts are already present — no separate image
  build is required.

### 2.2 Verify the CronJob is healthy

```bash
# Confirm the CronJob is registered
kubectl get cronjob -l app.kubernetes.io/component=backup

# Wait for the next scheduled run, or trigger a one-shot backup now:
kubectl create job --from=cronjob/agentpane-backup agentpane-backup-manual-$(date +%s)
kubectl get jobs -l app.kubernetes.io/component=backup -w

# Inspect the backup PVC contents
kubectl run --rm -it backup-inspect \
  --image=busybox:1.36 \
  --overrides='{"spec":{"containers":[{"name":"backup-inspect","image":"busybox:1.36","command":["sh"],"stdin":true,"tty":true,"volumeMounts":[{"mountPath":"/backups","name":"backups"}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"agentpane-backup"}}]}}' \
  -- ls -lh /backups
```

You should see `agentpane_pg_YYYYMMDD_HHMMSS.dump` files (or
`agentpane_YYYYMMDD_HHMMSS.db` in SQLite mode) sized roughly proportional to
the live DB.

### 2.3 Pre-upgrade snapshot (optional but recommended)

The Helm `pre-upgrade` migration Job runs DDL atomically, but a multi-table
migration that fails halfway leaves the operator without a pre-migration
snapshot. To capture one before the migration hook fires, trigger a manual
backup:

```bash
kubectl create job --from=cronjob/agentpane-backup agentpane-backup-pre-upgrade
kubectl wait --for=condition=complete job/agentpane-backup-pre-upgrade --timeout=20m
kubectl logs job/agentpane-backup-pre-upgrade
helm upgrade agentpane charts/agentpane --reuse-values  # proceed with upgrade
```

If the upgrade fails, the most recent backup is the recovery target
(see §3 below).

## 3. Restore drill — step by step

The restore drill assumes you have a recent backup artefact and need to
restore it onto a target cluster (either to roll back a bad migration or to
recover from data loss). The drill is **destructive** — it overwrites the
current database — so always confirm the artefact integrity before running it
against a production cluster.

### 3.1 PostgreSQL restore (Kubernetes)

```bash
# 0. Establish a maintenance window. Stop the AgentPane Deployment.
kubectl scale deployment agentpane --replicas=0

# 1. Pick a backup artefact. Backups are sorted by timestamp; pick the last
#    known-good one before the incident.
BACKUP="/backups/agentpane_pg_20260429_030000.dump"

# 2. Verify the backup is readable by pg_restore. This catches truncation
#    and corruption before you touch the live DB.
kubectl run --rm -it backup-verify \
  --image=ghcr.io/agentdevsl/agentpane:1.0.0 \
  --restart=Never \
  --overrides='{"spec":{"containers":[{"name":"backup-verify","image":"ghcr.io/agentdevsl/agentpane:1.0.0","command":["pg_restore","--list","'"$BACKUP"'"],"volumeMounts":[{"mountPath":"/backups","name":"backups"}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"agentpane-backup"}}]}}'

# 3. Drop and recreate the database from a maintenance Pod. The backup Pod
#    image already has psql + pg_restore.
kubectl run --rm -it db-restore \
  --image=ghcr.io/agentdevsl/agentpane:1.0.0 \
  --restart=Never \
  --env="DATABASE_URL=$(kubectl get secret agentpane-postgresql -o jsonpath='{.data.password}' | base64 -d | xargs -I{} printf 'postgresql://agentpane:{}@agentpane-postgresql:5432/agentpane?sslmode=disable')" \
  --overrides='{"spec":{"containers":[{"name":"db-restore","image":"ghcr.io/agentdevsl/agentpane:1.0.0","command":["sh","-c","pg_restore --clean --if-exists --no-owner --no-privileges --dbname=\"$DATABASE_URL\" /backups/agentpane_pg_20260429_030000.dump"],"volumeMounts":[{"mountPath":"/backups","name":"backups"}]}],"volumes":[{"name":"backups","persistentVolumeClaim":{"claimName":"agentpane-backup"}}]}}'

# 4. Verify the restored DB. The `schema_migrations` table should reflect
#    the migrations the restored snapshot was taken against — NOT necessarily
#    the latest. Confirm before scaling back up.
kubectl run --rm -it db-verify \
  --image=ghcr.io/agentdevsl/agentpane:1.0.0 \
  --restart=Never \
  --env="DATABASE_URL=$(kubectl get secret agentpane-postgresql -o jsonpath='{.data.password}' | base64 -d | xargs -I{} printf 'postgresql://agentpane:{}@agentpane-postgresql:5432/agentpane?sslmode=disable')" \
  --command -- psql "$DATABASE_URL" -c "select count(*) as migrations from schema_migrations;"

# 5. If the restore brings the DB back to a state that pre-dates the current
#    chart's migrations, run `bun run migrate:run-only` ONCE to bring it up to
#    speed. The Helm pre-upgrade Job is the canonical way to do this in
#    production:
helm upgrade agentpane charts/agentpane --reuse-values --recreate-pods=false

# 6. Scale back up. App pods will run migrate-check-only as an init container
#    (F11-17) and refuse to start if the schema is still behind.
kubectl scale deployment agentpane --replicas=1
kubectl rollout status deployment/agentpane
kubectl logs deployment/agentpane | grep -i 'migrate\|schema'
```

### 3.2 PostgreSQL restore (Docker Compose / bare-metal)

```bash
# 1. Stop the app
docker compose down agentpane

# 2. Verify the backup
pg_restore --list ./data/backups/agentpane_pg_20260429_030000.dump | head

# 3. Restore (pg_restore --clean drops existing schema first)
DATABASE_URL='postgresql://agentpane:agentpane_dev@localhost:5432/agentpane' \
  pg_restore --clean --if-exists --no-owner --no-privileges \
  --dbname="$DATABASE_URL" \
  ./data/backups/agentpane_pg_20260429_030000.dump

# 4. Verify
psql "$DATABASE_URL" -c "select count(*) from schema_migrations;"

# 5. Apply any newer migrations and start
bun run migrate:run-only
docker compose up agentpane
```

### 3.3 SQLite restore (Docker Compose / bare-metal)

```bash
# 1. Stop the app
docker compose down agentpane

# 2. Pick the backup artefact and verify integrity
BACKUP=./data/backups/agentpane_20260429_030000.db
sqlite3 "$BACKUP" "PRAGMA integrity_check;"
# Expected output: ok

# 3. Capture a checksum so the restore is auditable
sha256sum "$BACKUP" > "$BACKUP.sha256"

# 4. Remove WAL/SHM sidecar files (otherwise they will be replayed on top
#    of the restored DB and corrupt it). The backup script already issued a
#    PRAGMA wal_checkpoint(TRUNCATE) before copying, so the artefact is a
#    point-in-time snapshot with no outstanding WAL.
rm -f ./data/agentpane.db-wal ./data/agentpane.db-shm

# 5. Atomic move: restore the DB file
cp "$BACKUP" ./data/agentpane.db.new
mv ./data/agentpane.db.new ./data/agentpane.db

# 6. Verify the restored DB
sqlite3 ./data/agentpane.db "PRAGMA integrity_check;"
sqlite3 ./data/agentpane.db "select count(*) from schema_migrations;"

# 7. Apply any newer migrations and start. The migration runner is
#    idempotent: migrations whose journal entry already exists are skipped.
bun run migrate:run-only
docker compose up agentpane
```

## 4. Rehearsal cadence

Backups that have never been restored aren't backups; they are write-only
files. The recommended cadence is:

| Cadence    | Activity                                                                                          |
|------------|---------------------------------------------------------------------------------------------------|
| Weekly     | Cron-driven smoke test — restore the most recent backup into a throwaway namespace and run `bun run migrate:check-only` against it. Pass = the migration ledger and schema match what the binary expects. |
| Monthly    | End-to-end drill — restore into a parallel cluster, point a non-production app instance at it, and exercise a representative workflow (create codespace, start agent, approve plan). |
| Per-incident | Whenever the migration Job fails or the rollback runbook (F11-29) is invoked. Capture timing data and update this doc if a step needs tightening. |

## 5. Troubleshooting

### "pg_restore: error: could not open input file"

The backup PVC was unmounted or the path is wrong. Confirm the file exists
inside the backup Pod (`kubectl exec` into a fresh Pod that mounts the same
PVC). If the PVC is empty, the CronJob hasn't run yet — trigger a manual run
(see §2.2).

### "ERROR: role agentpane does not exist"

The restore image's `pg_restore` is trying to assign ownership to a role
that doesn't exist on the target. Always use `--no-owner --no-privileges`
in the restore command (see §3.1 step 3).

### SQLite "database disk image is malformed"

Either the backup was truncated mid-write or the WAL/SHM files were not
removed before `cp`. Re-run `PRAGMA integrity_check` against the backup
artefact to determine which. If the backup is corrupt, fall back to the
prior artefact (the script keeps `MAX_BACKUPS` of them).

### Backup PVC fills up

Reduce `backup.retentionDays`, increase `backup.pvc.size`, or migrate to an
external object store (CSI snapshot pipeline, S3 sidecar). The script's
default of 7 daily backups at, e.g., 50MB each consumes well under 1GB; if
you see runaway growth, audit the DB for unbounded tables (see
`specs/arch_review_april/02-data-layer.md`).

## 6. Cross-references

* `scripts/backup-db-pg.sh` — Postgres backup script (canonical implementation).
* `scripts/backup-db.sh` — SQLite backup script (canonical implementation).
* `charts/agentpane/templates/cronjob-backup.yaml` — Helm CronJob wrapper.
* `charts/agentpane/templates/pvc-backup.yaml` — Helm PVC for backup artefacts.
* `specs/application/operations/deployment.md` §4.3 — high-level backup story.
* `specs/arch_review_april29/11-operations-deployment.md` F11-21 — review finding addressed by this doc.
* `specs/arch_review_april29/11-operations-deployment.md` F11-29 — rollback runbook that consumes the artefacts produced here.
