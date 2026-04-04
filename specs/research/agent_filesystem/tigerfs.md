# TigerFS

> FUSE-based filesystem that mounts PostgreSQL databases as local directories

- **Website:** https://tigerfs.io/
- **GitHub:** https://github.com/timescale/tigerfs (214 stars)
- **License:** MIT
- **Version:** v0.6.0 (March 27, 2026)
- **Built by:** Timescale (TimescaleDB)
- **Language:** Go

## Architecture

TigerFS presents PostgreSQL tables as a POSIX filesystem using two platform adapters:

| Platform | Mechanism | Dependencies |
|----------|-----------|-------------|
| Linux | Native FUSE (`go-fuse`) | `fuse3` package |
| macOS | In-process NFS v3 server (`go-nfs`) | None |

Both adapters delegate to a shared `fs/` backend for all filesystem logic.

### Key Packages

| Package | Purpose |
|---------|---------|
| `cmd/tigerfs/` | Entry point |
| `internal/tigerfs/fs/` | Shared filesystem logic (path parsing, stat cache, pipeline queries) |
| `internal/tigerfs/fuse/` | Linux FUSE adapter |
| `internal/tigerfs/nfs/` | macOS NFS adapter |
| `internal/tigerfs/db/` | PostgreSQL client (`pgx/v5`) |
| `internal/tigerfs/backend/` | Cloud backend resolution (Tiger Cloud, Ghost, postgres://) |
| `internal/tigerfs/fs/synth/` | Synthesised apps (markdown, text, tasks) |

## Two Operating Modes

### File-First Mode — Transactional shared workspace

- Directories are "apps" backed by Postgres tables
- Write markdown files with YAML frontmatter; frontmatter becomes columns, body becomes text
- Directory hierarchies, `mv` for renames/moves, `mkdir`/`rmdir`
- Automatic versioning via `.history/` directory (requires TimescaleDB for hypertable compression)
- Every write is an ACID transaction — multiple agents/humans can read/write concurrently

### Data-First Mode — Explore existing databases

- Tables appear as directories, rows as files (`.json`, `.csv`, `.tsv`, `.yaml`)
- Pipeline query paths: `.by/customer_id/123/.order/created_at/.last/10/.export/json` — pushed down as single SQL
- Index navigation via `.by/` directories
- Full CRUD: `echo` to update, `mkdir` to insert, `rm` to delete

## Agent Integration

TigerFS is explicitly designed as an agent filesystem interface:

1. **Claude Code skills**: Ships with built-in skills in `skills/tigerfs/` that teach agents how to discover, read, write, and search TigerFS-mounted data
2. **Auto-installs skills** when it detects a coding agent (Claude Code, Gemini CLI, Codex) at mount time (v0.6.0)
3. **Multi-agent task coordination**: `todo/`, `doing/`, `done/` directories where `mv` is an atomic DB state transition — two agents cannot claim the same task
4. **Session context persistence**: Agents save/resume work via markdown files

### Coordination Model

The core insight: PostgreSQL's ACID transactions replace all coordination code. No sync protocols, no pull/push/merge — agents read/write files, the database handles consistency.

## Performance

| Aspect | Detail |
|--------|--------|
| Mount startup | Near-instant (macOS: in-process NFS; Linux: FUSE mount) |
| Content caching | **Never cached** — every read hits DB (consistency over performance) |
| Metadata caching | Multi-tier stat cache with short TTLs (v0.5.0) |
| `ls -l` queries | Reduced from ~37 SQL queries to 1 (v0.4.0) |
| Large tables | Default 10,000 row limit with `.all/` override |
| Pipeline queries | Pushed down as single SQL (not N+1) |

## Cloud Backends

- `postgres://` — any PostgreSQL database
- `tiger:ID` — Timescale's Tiger Cloud (credential-free via CLI auth)
- `ghost:ID` — Ghost (ghost.build) databases
- Commands: `tigerfs create`, `tigerfs fork` (with point-in-time recovery), `tigerfs info`

## Limitations

1. **Requires PostgreSQL** — not a general-purpose filesystem
2. **History requires TimescaleDB** — versioning won't work on vanilla PostgreSQL
3. **No content caching** — every read hits the database (deliberate for consistency)
4. **FUSE restrictions** — won't work in Fargate, Cloud Run, K8s without privileged pods
5. **Early stage** — v0.6.0, 214 stars, created January 2026
6. **Tasks App** is documented but "Not Yet Implemented"
7. **Not a sandbox** — provides no isolation, security, or blast-radius containment

## AgentPane Relevance

TigerFS is **not** a solution for the primary problems (skill mounting, spin-up time). It is a **coordination layer** that could complement sandbox solutions. The interesting patterns:

- Filesystem-as-coordination eliminates custom sync logic
- ACID task claiming prevents race conditions
- Agents use standard tools (Read/Write/Glob/Grep) — no custom API
- Versioning provides audit trails

However, AgentPane already has task services and event streaming for coordination, so the marginal benefit is limited.
