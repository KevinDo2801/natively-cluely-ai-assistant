/**
 * Reusable Supabase connection module for the Natively project.
 *
 * Read-only / safe helpers to connect to the Supabase project and run queries.
 * Uses environment variables so secrets are never committed to git.
 *
 * Expected environment variables (set in `.env` or the process environment):
 *   SUPABASE_URL            e.g. https://dudtzrgxamgjojrxhzrw.supabase.co
 *   SUPABASE_ANON_KEY       anon/public key (read-only, safe)
 *   SUPABASE_SERVICE_KEY    service_role key (full admin — NEVER use on client)
 *   SUPABASE_MCP_TOKEN      personal access token (sbp_...) for the Management API
 *   SUPABASE_MANAGEMENT_API default https://api.supabase.com/v1
 *
 * Usage (from scripts/supabase or via `node --experimental-strip-types`):
 *   import { createSupabaseClient, querySql, listTables } from './client.mjs'
 */

import { createClient as createSupabaseJsClient } from '@supabase/supabase-js';

function getRequired(name) {
  const value = process.env[name];
  if (!value) {
    throw new Error(
      `Missing environment variable "${name}". Add it to your .env file ` +
        `(this file is git-ignored) or export it before running this script.`,
    );
  }
  return value;
}

/**
 * Create a Supabase-js client. Prefer the anon key for read-only work;
 * pass { service: true } to use the service_role key for full access.
 */
export function createSupabaseClient({ service = false } = {}) {
  const url = getRequired('SUPABASE_URL');
  const key = service
    ? getRequired('SUPABASE_SERVICE_KEY')
    : getRequired('SUPABASE_ANON_KEY');
  return createSupabaseJsClient(url, key);
}

/**
 * Run an arbitrary SQL query against the project database using the
 * Supabase Management API (requires the MCP/PAT token).
 * Returns the parsed rows array.
 */
export async function querySql(sql, { projectRef = getProjectRef() } = {}) {
  const token = getRequired('SUPABASE_MCP_TOKEN');
  const base = process.env.SUPABASE_MANAGEMENT_API || 'https://api.supabase.com/v1';
  const res = await fetch(`${base}/projects/${projectRef}/database/query`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({ query: sql }),
  });
  if (!res.ok) {
    throw new Error(`Query failed (${res.status}): ${await res.text()}`);
  }
  return res.json();
}

/**
 * Derive the Supabase project ref from the URL, or read it from env.
 * Examples:
 *   SUPABASE_URL=https://dudtzrgxamgjojrxhzrw.supabase.co
 *   -> ref = "dudtzrgxamgjojrxhzrw"
 */
export function getProjectRef() {
  if (process.env.SUPABASE_PROJECT_REF) return process.env.SUPABASE_PROJECT_REF;
  const url = process.env.SUPABASE_URL || '';
  const m = url.match(/^https:\/\/([^.]+)\.supabase\.co/);
  if (!m) {
    throw new Error(
      'Cannot derive project ref. Set SUPABASE_PROJECT_REF explicitly.',
    );
  }
  return m[1];
}

/**
 * Convenience: list database tables in the public schema (and totals).
 */
export async function listTables() {
  return querySql(`
    select
      n.nspname as schema,
      c.relname as table,
      pg_catalog.obj_description(c.oid) as comment
    from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where c.relkind in ('r', 'p')
      and n.nspname not in (
        'information_schema', 'pg_catalog', 'pg_toast', 'auth', 'storage',
        'realtime', '_realtime', 'supabase_functions', 'vault', 'net',
        'graphql_public', 'pgbouncer', 'graphql', 'supabase_migrations',
        'extensions'
      )
    order by n.nspname, c.relname;
  `);
}
