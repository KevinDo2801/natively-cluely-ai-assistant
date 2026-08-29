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

- Migration file: [`supabase/migrations/0001_initial_schema.sql`](../../supabase/migrations/0001_initial_schema.sql)
  (20 tables mirroring the local SQLite schema, pgvector, RLS on every table,
  composite `(parent_id, user_id)` FKs, grants to the `authenticated` role).
- Apply/iterate with:
  `node scripts/supabase/apply-sql.cjs supabase/migrations/0001_initial_schema.sql`
  (idempotent — safe to re-run).
- Multi-tenancy model: every row is stamped `user_id = auth.uid()`; RLS
  policies restrict each account to its own rows. The app writes through
  PostgREST with the signed-in user's JWT (anon key), the sync CLI uses the
  service_role key.
- Embeddings are pgvector `vector` columns (unconstrained dims) with an
  `embedding_dims` companion column; current local data is 768-dim
  (gemini-embedding-2). No ANN index yet — pgvector can't index unconstrained
  columns, so a future step can pin a dimension and add an HNSW index.

## Cloud sync (local SQLite → Supabase)

- **In-app (automatic):** while signed in (Settings → Account), the main
  process pushes the local database on sign-in and then every 5 minutes
  (`electron/services/SupabaseSyncService.ts` + shared engine
  `electron/services/supabaseSyncEngine.js`). The Account tab shows the sync
  status and a "Sync now" button.
- **CLI (one-shot):**
  `npm run supabase:sync` (add `-- --dry-run`, `-- --user-email you@example.com`,
  `-- --db-path <path>`, `-- --batch 500`). Runs under Electron's Node so the
  repo's better-sqlite3 (Electron ABI) loads; the target auth user is
  resolved from `auth.admin.listUsers()`.
- Semantics: upsert-by-PK (idempotent, parent tables first), push-only —
  local deletions are not propagated yet.

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
