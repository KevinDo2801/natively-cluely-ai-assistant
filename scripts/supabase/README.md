# Supabase: schema + cloud sync

Reusable helpers so an agent (Claude Code, DSH, etc.) can connect to the
Natively Supabase project **without being asked for keys/URLs each time**,
plus the SQLite → Supabase sync tooling.

## Project

- **Name**: `Natively - dev + pro`
- **Ref**: `dudtzrgxamgjojrxhzrw`
- **Region**: `us-west-2`
- **Database**: PostgreSQL 17.6 (GA)
- **Status**: ACTIVE_HEALTHY

## Credentials — stored in `.env` (git-ignored, never committed)

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL, e.g. `https://dudtzrgxamgjojrxhzrw.supabase.co` |
| `SUPABASE_PROJECT_REF` | Project ref (needed for Management API SQL) |
| `SUPABASE_ANON_KEY` | anon/public key — read by the APP (Account tab + cloud sync) |
| `SUPABASE_SERVICE_KEY` | service_role key — sync CLI + agent tooling, FULL admin |
| `SUPABASE_SECRET_KEY` | `sb_secret_...` key (new API-keys system) — optional fallback |
| `SUPABASE_MCP_TOKEN` | Personal access token (`sbp_...`) for the Management API |
| `SUPABASE_SYNC_USER_EMAIL` | optional — pick the sync target when the project has >1 auth user |
| `NATIVELY_DB_PATH` | optional — override the local SQLite path for the sync CLI |

## Database schema

- Migrations in [`supabase/migrations/`](../../supabase/migrations/):
  - `0001_initial_schema.sql` — 20 tables mirroring the local SQLite schema,
    pgvector, RLS on every table, composite `(parent_id, user_id)` FKs,
    grants to the `authenticated` role.
  - `0002_two_way_sync.sql` — `updated_at` on every table +
    `sync_tombstones` (deletion markers) for two-way sync.
  - `0003_realtime.sql` — adds the 20 synced tables to the
    `supabase_realtime` publication so the app can subscribe to
    postgres_changes and pull changes immediately (RLS still filters the
    stream per user). Requires the postgres role (Management API / SQL
    editor); re-running is idempotent.
  - `0004_incremental_sync_indexes.sql` — `(user_id, updated_at)` on every
    synced table plus `(user_id, table_name, deleted_at)` on
    `sync_tombstones`. These are what make the incremental (v35) delta queries
    index range scans instead of sequential scans; without them the filtered
    read would be *worse* than the full read it replaced. Also drops 0002's
    now-redundant single-column `(user_id)` tombstone index.
  - `0005_sync_sequence.sql` — a server-assigned monotonic `sync_seq` on every
    synced table and on `sync_tombstones` (one sequence, stamped by a
    `before insert or update` trigger), plus the `(user_id, sync_seq)` indexes
    the delta uses. This is what makes the watermark immune to clock skew — see
    "Why incremental" below. Optional but recommended: the app probes for the
    column once per process and falls back to the timestamp watermark when it is
    absent, so the project keeps working either way.
- Apply/iterate with:
  `node scripts/supabase/apply-sql.cjs supabase/migrations/0005_sync_sequence.sql`
  (idempotent — safe to re-run).
- Multi-tenancy model: every row is stamped `user_id = auth.uid()`; RLS
  policies restrict each account to its own rows. The app reads/writes through
  PostgREST with the signed-in user's JWT (anon key), the sync CLI uses the
  service_role key.
- Embeddings are pgvector `vector` columns (unconstrained dims) with an
  `embedding_dims` companion column; current local data is 768-dim
  (gemini-embedding-2). No ANN index yet — pgvector can't index unconstrained
  columns, so a future step can pin a dimension and add an HNSW index.

## Cloud sync (cloud-first — Supabase is the source of truth)

- **In-app (automatic):** while signed in (Settings → Account), the main
  process treats Supabase as the source of truth and the local SQLite tables
  as a cache mirror (`electron/services/SupabaseSyncService.ts` + shared engine
  `electron/services/supabaseSyncEngine.js`):
  - **Write-through:** every local insert/update/delete on a synced table is
    detected by SQLite triggers (v34 — per-table `sync_dirty` counters) and
    pushed to the cloud within ~1s by the dirty-poll loop.
  - **Pull (v35/v36 — incremental):** every table keeps a `sync_watermarks` row
    (local migrations v34→v35 and v35→v36) holding the newest local and cloud
    marks it has already reconciled. A pass reads only the cloud rows and
    tombstones after the cloud watermark, hands the LWW planner only the keys
    that changed on either side plus any key the retry ledger re-offers, and
    writes only those — so a steady-state pass costs two small filtered reads per
    table and zero writes. A table with no watermark yet (first pass after the
    upgrade) and a table whose periodic floor is due are read whole, exactly as
    before. Two watermarks exist for the cloud side and the engine prefers the
    second one:
      - `cloud_seq` — the server-assigned sequence from migration
        `0005_sync_sequence.sql`. **Exact**: `sync_seq > lastSeq` cannot miss a
        row whatever any machine's clock says, needs no margin, and cannot be
        delayed by skew.
      - `cloud_ms` — the v35 timestamp watermark (`updated_at > lastMs`). The
        fallback when 0005 has not been applied, and for a table that has not yet
        produced a sequence. It is only as good as the clocks that feed it: a
        device whose clock runs behind by more than
        `SUPABASE_SYNC_CLOUD_OVERLAP_MS` stamps rows *below* the watermark, and
        those waited for the 12-hour full rescan. No margin fixes that in
        general, which is why 0005 exists.
    Env overrides:
    `SUPABASE_SYNC_PULL_MS`, `SUPABASE_SYNC_DIRTY_POLL_MS`,
    `SUPABASE_SYNC_MAX_MS` (whole-sync cap, default 60s),
    `SUPABASE_SYNC_REQUEST_TIMEOUT_MS` (per-request PostgREST bound, default
    30s), `SUPABASE_SYNC_FULL_RESCAN_MS` (unfiltered re-read floor, default
    12h), `SUPABASE_SYNC_GC_MS` (tombstone GC cadence, default 1h),
    `SUPABASE_SYNC_LOCAL_OVERLAP_MS` / `SUPABASE_SYNC_CLOUD_OVERLAP_MS`
    (watermark safety margins, defaults 5s / 5min — the cloud one is unused in
    sequence mode), `SUPABASE_SYNC_RETRY_BASE_MS` / `SUPABASE_SYNC_RETRY_MAX_MS`
    (retry backoff, defaults 30s → 30min). Every cloud request is
    bounded — Supabase's edge has been observed to black-hole individual
    requests while answering others, and an un-bounded read would freeze the
    sync loop forever. The whole-sync cap stops a flaky network from pinning
    the UI in "syncing" for minutes: past the deadline the remaining tables are
    skipped and the sync reports an error (retried next cycle). Auth-host calls
    are bounded at 15s separately (see below).
  - **Why incremental (the egress incident):** the pre-v35 engine read EVERY row
    of EVERY table on every pass. Measured against this repo's own dev
    database that was 2.35 MB of rows plus 3.44 MB of tombstones per 60s pass —
    ~5.8 MB/minute, ~8 GB/day while signed in, with a SINGLE user — which blew
    the Supabase free-plan egress quota (6.52 GB used against a 5 GB allowance).
    Egress scaled with database size, never with the number of users. The
    58,235-row `transcripts` tombstone ledger was the single biggest term: it
    only ever grew (live-meeting STT re-segmentation) and was re-downloaded in
    full every minute. After v35 a steady-state pass downloads no rows at all;
    run `node scripts/supabase/measure-egress.cjs` to re-measure the current
    database. Incremental reads are an OPTIMISATION, not the correctness
    argument: the periodic `SUPABASE_SYNC_FULL_RESCAN_MS` floor still reads each
    table whole, so a watermark that skips a row heals by itself — and with
    `0005_sync_sequence.sql` applied there is nothing to heal, because a
    sequence watermark cannot skip a row in the first place.
  - **Failed pushes (v36 — retry ledger):** a row whose push fails is recorded in
    `sync_retry` and re-offered as a candidate on an exponential backoff (30s →
    30min, capped), while the watermark advances normally. v35 instead held the
    watermark back to the failed row's stamp, so ONE unpushable row (a dangling
    FK, a value the cloud rejects) pinned it for ever and every subsequent pass
    degraded back into a wide scan — straight back into the egress problem. The
    row is still never silently dropped; it now costs a couple of requests per
    half hour instead of a table scan per second. The outstanding count is
    reported as `retrying` in the sync status and logged per pass.
  - **Realtime (fast cross-device path, default ON):** the app subscribes to
    Supabase postgres_changes (migration `0003_realtime.sql`) and reconciles a
    table within ~`SUPABASE_REALTIME_DEBOUNCE_MS` (2.5s) of another device
    changing it, instead of waiting for the 60s reconcile. The 60s reconcile
    stays as the safety net (Realtime does not replay events missed while the
    socket is disconnected), and on reconnect the app reconciles immediately.
    Set `SUPABASE_REALTIME_ENABLED=0` to fall back to polling only; a dead
    socket degrades gracefully (never fatal). Supabase broadcasts every
    committed change — including the ones this client just pushed, with no
    writer exclusion — so a table that received a successful push is ignored by
    the realtime path for `SUPABASE_REALTIME_SELF_ECHO_MS` (default 5s);
    otherwise each push echoed back as an event and triggered another pass over
    the same table. A change by another device inside that window is deferred to
    the next 60s reconcile, not lost.
  - **One-time cutover** on first sign-in after this architecture: a safety
    merge pushes everything local (including rows created while signed out),
    the local business tables are wiped with triggers suspended (the wipe
    records no tombstones, so it cannot delete the cloud copy), and the local
    cache is rebuilt from Supabase verbatim. A marker in `app_state`
    (`supabase_cloud_first_cutover_done`) makes it run once.
  - **No offline mode:** the app stays usable on the local mirror when the
    cloud is unreachable, but writes keep retrying (dirty flags survive
    restarts) and the cloud wins on the next convergence — local can never
    permanently fork the truth. The Account tab shows the last error.
    A table that fails its cloud read counts as a sync error (it is retried
    on the next cycle, and the one-time cutover refuses to wipe the local
    data unless every table was readable).
  - **Signed out:** the app keeps working on local data as before; the next
    sign-in merges it up through the regular LWW reconciliation.
  - **Auth-host resilience:** Supabase's `/auth/v1` host has been observed to
    hang indefinitely (requests that never settle while `/rest/v1` stays
    healthy). All auth calls are bounded to 15s, so a dead auth host degrades
    to a clean "signed out" state instead of freezing the app; session restore
    and sync resume automatically once the host recovers.
  - **supabase-js fetch quirk:** in Electron's Node runtime, supabase-js'
    internally resolved fetch can hang while the raw global fetch works.
    Every client in the app and the CLI is therefore created with
    `global: { fetch: (...a) => fetch(...a) }` to pin the working fetch.
- **CLI (one-shot):**
  `npm run supabase:sync` — two-way reconciliation, incremental by default.
  Add `-- --dry-run` (plan only), `-- --full` (ignore every watermark and read
  each table whole, i.e. the pre-v35 behaviour — useful to audit what a complete
  pass would move), `-- --push-only` / `-- --pull-only`,
  `-- --cutover` (safety merge → wipe local → pull, same as the in-app
  cutover), `-- --user-email you@example.com`, `-- --db-path <path>`,
  `-- --batch 500`.
  Runs under Electron's Node so the repo's better-sqlite3 (Electron ABI)
  loads; the target auth user is resolved from `auth.admin.listUsers()`.
- **Diagnostics:**
  - `node scripts/supabase/verify-sync-setup.cjs [db-path]` — ONE command that
    answers "is the fix in place and working?" for both halves: whether 0004/0005/
    0006 applied to the project (and whether the sequence is really maintained),
    whether the local database is at v36 with live sequence watermarks and an
    empty retry ledger, and the REST request count. Exits non-zero on any failed
    check, so it can gate a release. Read-only.
  - `node scripts/supabase/measure-egress.cjs [db-path]` prints the exact
    per-table payload of a full reconcile for the current database and the
    before/after egress projection; `measure-tombstones.cjs` breaks the tombstone
    ledger down by table and shows the live-meeting write-through cost.
  - The authoritative egress **GB** figure is NOT exposed by the Management API
    (`/usage`, `/usage.api-egress`, `/usage.egress` all 404 — verified); read it
    in the dashboard under Organization → Usage → Egress. The API-measurable
    proxy is the REST request count, and it moves MUCH less than the egress does:
    v34 spent ~70 requests and 5.8 MB per pass, the new engine spends ~40
    requests and ~0 bytes, so the byte win is ~1000x while the request win is
    under 2x.
  - All three open the database read-only and resolve paths per platform
    (Windows `%APPDATA%`, macOS `~/Library/Application Support`).
- **Semantics (v3):** every synced row carries `updated_at` on both sides
  (local triggers stamp millisecond-precision ISO-8601 on INSERT/UPDATE —
  `electron/db/migrations.ts` v32→v33). Deletions propagate through
  `sync_tombstones` on both sides (local DELETE triggers record markers
  automatically). Per row, the newest event wins; a deletion must be
  STRICTLY newer than the last edit to win; ties leave both sides untouched.
  Timestamps are preserved on pull, so a converged sync is a no-op.
  `sync_seq` (migration 0005) is deliberately NOT a second conflict key — it
  only drives the delta; `updated_at` alone decides who wins.
- **Caveats:** conflicts still resolve by client clock (last-write-wins) — a
  device with a clock far in the future wins until corrected. That is a separate
  concern from *propagation*, which 0005 makes clock-independent: without 0005 a
  skew wider than `SUPABASE_SYNC_CLOUD_OVERLAP_MS` can delay rows until the next
  full rescan (12h); with it, nothing is ever delayed by a clock. Clearing a
  table's `sync_watermarks` row (or running the CLI with `-- --full`) forces a
  complete reconcile. "Clear all data" in Settings now
  also clears the cloud copy (its deletions propagate — that is the intended
  two-way behavior). Tombstones are garbage-collected after 30 days (the TTL is
  separate from the GC *cadence*, which is hourly since v35 — v34 ran the GC for
  every table on every pass). Pulled embeddings land in the local BLOB columns;
  the sqlite-vec search tables refresh through the app's own re-index paths.
- **Local-only (never synced):** `app_state` (window position, cutover marker,
  UI/fx state), `embedding_queue`, `usage_outbox`, `profile_persona`,
  `profile_custom_notes`, the `vec_*` search tables, `mode_reference_chunks`,
  `mode_reference_index_state`, `aot_results`, `company_dossiers`,
  `context_nodes`, `knowledge_documents`, and the change-tracking state itself
  (`sync_tombstones`, `sync_dirty`, `sync_watermarks`, `sync_retry`). Audio
  recording files stay on the local disk — only transcripts/metadata live in the
  cloud.

## `client.mjs`

Exports:
- `createSupabaseClient({ service })` — a supabase-js client (anon by default).
- `querySql(sql, { projectRef })` — run arbitrary SQL via the Management API.
- `getProjectRef()` — derive ref from `SUPABASE_URL`.
- `listTables()` — list app tables.

> **Note:** `client.mjs` imports `@supabase/supabase-js`. If it is not yet a
> project dependency, install it first: `npm install @supabase/supabase-js`.
> (Prefer adding it as a devDependency so the helper keeps working.)

## MCP server

`.mcp.json` configures the official Supabase MCP server
(`@supabase/mcp-server-supabase`) via `npx`, reading the access token from the
`SUPABASE_ACCESS_TOKEN` env var — no secret is committed.
