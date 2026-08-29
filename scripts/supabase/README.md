# Supabase connection scripts

Reusable helpers so an agent (Claude Code, DSH, etc.) can connect to the
Natively Supabase project **without being asked for keys/URLs each time**.

## Project

- **Name**: `Natively - dev + pro`
- **Ref**: `dudtzrgxamgjojrxhzrw`
- **Region**: `us-west-2`
- **Database**: PostgreSQL 17.6 (GA)
- **Status**: ACTIVE_HEALTHY

## Credentials — stored in `.env` (git-ignored, never committed)

The following are read from the environment. Add them to your root `.env`
(already in `.gitignore`) — an example is in `.env.example`:

| Variable | Purpose |
|----------|---------|
| `SUPABASE_URL` | Project URL, e.g. `https://dudtzrgxamgjojrxhzrw.supabase.co` |
| `SUPABASE_PROJECT_REF` | The project ref (needed for Management API SQL) |
| `SUPABASE_ANON_KEY` | anon/public key — read-only, safe to use broadly |
| `SUPABASE_SERVICE_KEY` | service_role key — FULL admin, never expose to clients |
| `SUPABASE_MCP_TOKEN` | Personal access token (`sbp_...`) for Management API queries |
| `SUPABASE_ACCESS_TOKEN` | Same token; consumed by the MCP server in `.mcp.json` |

## How an agent should use it

Ask the user for the **task** only; the connection info is available from
`.env`. Load the secrets into the environment before running:

```bash
# Load .env then call helpers
source <(grep -E '^SUPABASE_' .env | sed 's/^/export /')  # (POSIX shells)
# Windows PowerShell:
Get-Content .env | ForEach-Object { if ($_ -match '^SUPABASE_') { [Environment]::SetEnvironmentVariable(($_.Split('=')[0]), ($_.Split('=',2)[1])) } }
```

### `client.mjs`

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
